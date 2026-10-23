Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TrustedSystemSids = @('S-1-5-18', 'S-1-5-32-544') # LocalSystem and BUILTIN\Administrators: trusted OS recovery identities.
$BroadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') # Everyone, Authenticated Users, BUILTIN\Users.

function Get-CurrentSid { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

if (-not ('XyvaAclNative' -as [type])) {
  Add-Type @'
using System;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Text;

public static class XyvaAclNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public bool bInheritHandle;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
    string sddl, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateDirectory(string path, ref SECURITY_ATTRIBUTES attributes);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFile(string path, uint access, uint share, ref SECURITY_ATTRIBUTES attributes,
    uint disposition, uint flagsAndAttributes, IntPtr templateFile);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(IntPtr handle, uint objectType, uint securityInfo,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool LogonUser(string username, string domain, string password, int logonType, int provider, out SafeAccessTokenHandle token);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute; public int dwFlags; public short wShowWindow,wReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessWithLogonW(string user, string domain, string password, uint logonFlags, string application, StringBuilder commandLine, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

  public static SECURITY_ATTRIBUTES SecurityAttributes(string sddl) {
    IntPtr descriptor; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out size))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = descriptor, bInheritHandle = false };
  }
  public static void CreatePrivateDirectory(string path, ref SECURITY_ATTRIBUTES attributes) {
    if (!CreateDirectory(path, ref attributes)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static IntPtr CreatePrivateFile(string path, ref SECURITY_ATTRIBUTES attributes) {
    IntPtr handle = CreateFile(path, 0x40000000, 0, ref attributes, 1, 0x80, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
  public static IntPtr OpenForSecurityQuery(string path, bool directory) {
    SECURITY_ATTRIBUTES unused = new SECURITY_ATTRIBUTES();
    uint flags = directory ? 0x02000000U : 0x80U;
    IntPtr handle = CreateFile(path, 0x00020000, 0x00000003, ref unused, 3, flags, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
  public static byte[] HandleSecurityDescriptor(IntPtr handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint result = GetSecurityInfo(handle, 1, 0x00000001 | 0x00000004,
      out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new Win32Exception((int)result);
    try {
      uint length = GetSecurityDescriptorLength(descriptor);
      if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] bytes = new byte[length];
      Marshal.Copy(descriptor, bytes, 0, (int)length);
      return bytes;
    } finally { LocalFree(descriptor); }
  }
  public static SafeAccessTokenHandle LogonInteractive(string username, string domain, string password) {
    SafeAccessTokenHandle token;
    if (!LogonUser(username, domain, password, 2, 0, out token))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return token;
  }
  public static int RunProcessWithLogon(string username, string domain, string password, string application, string commandLine, string currentDirectory) {
    STARTUPINFO startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(STARTUPINFO)); PROCESS_INFORMATION process;
    StringBuilder mutableCommandLine = new StringBuilder(commandLine);
    if (!CreateProcessWithLogonW(username, domain, password, 1, application, mutableCommandLine, 0x08000000, IntPtr.Zero, currentDirectory, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { if (WaitForSingleObject(process.hProcess, 30000) != 0) throw new TimeoutException("Second-process probe timed out"); uint exitCode; if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error()); return unchecked((int)exitCode); }
    finally { if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread); if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess); }
  }
}
'@
}

function New-PrivateSddl([string] $OwnerSid, [bool] $Directory) {
  $inheritance = if ($Directory) { 'OICI' } else { '' }
  $aces = foreach ($sid in @($OwnerSid) + $TrustedSystemSids) { "(A;$inheritance;FA;;;$sid)" }
  return "O:${OwnerSid}D:P$($aces -join '')"
}

function Get-AclEvidenceFromHandle([IntPtr] $Handle) {
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new([XyvaAclNative]::HandleSecurityDescriptor($Handle), 0)
  [pscustomobject]@{
    Owner = if ($null -eq $raw.Owner) { $null } else { $raw.Owner.Value }
    DaclPresent = [bool]($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)
    Protected = [bool]($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
    DaclNull = $null -eq $raw.DiscretionaryAcl
    Entries = @($raw.DiscretionaryAcl | ForEach-Object {
      [pscustomobject]@{
        AceKind = $_.GetType().FullName
        Type = if ($_ -is [Security.AccessControl.CommonAce]) { $_.AceQualifier.ToString() } else { 'Unknown' }
        Sid = if ($_ -is [Security.AccessControl.KnownAce]) { $_.SecurityIdentifier.Value } else { $null }
        Rights = if ($_ -is [Security.AccessControl.KnownAce]) { $_.AccessMask } else { $null }
        Inherited = [bool]($_.AceFlags -band [Security.AccessControl.AceFlags]::Inherited)
        Flags = [int]$_.AceFlags
      }
    })
  }
}

function Get-AclEvidenceFromPath([string] $Path, [bool] $Directory = $false) {
  $handle = [XyvaAclNative]::OpenForSecurityQuery($Path, $Directory)
  try { return Get-AclEvidenceFromHandle $handle } finally { [void][XyvaAclNative]::CloseHandle($handle) }
}

function Assert-PrivateAclEvidence($Evidence, [string] $OwnerSid, [bool] $Directory) {
  $expectedFlags = if ($Directory) { [int]([Security.AccessControl.AceFlags]::ContainerInherit -bor [Security.AccessControl.AceFlags]::ObjectInherit) } else { 0 }
  $expectedSids = @($OwnerSid) + $TrustedSystemSids
  $fullControl = [int][Security.AccessControl.FileSystemRights]::FullControl
  if ($Evidence.Owner -ne $OwnerSid -or -not $Evidence.DaclPresent -or $Evidence.DaclNull -or -not $Evidence.Protected -or $Evidence.Entries.Count -ne $expectedSids.Count) { throw 'Owner, DACL presence, DACL protection, or ACE count verification failed' }
  $seen = @{}
  foreach ($ace in $Evidence.Entries) {
    if ($ace.AceKind -ne 'System.Security.AccessControl.CommonAce' -or $ace.Type -ne 'AccessAllowed' -or $null -eq $ace.Sid -or $ace.Inherited -or $ace.Flags -ne $expectedFlags -or $ace.Rights -ne $fullControl -or $BroadSids -contains $ace.Sid -or $expectedSids -notcontains $ace.Sid) { throw "Unexpected ACE: $($ace.Sid)" }
    if ($seen.ContainsKey($ace.Sid)) { throw "Duplicate ACE: $($ace.Sid)" }
    $seen[$ace.Sid] = $true
  }
  foreach ($sid in $expectedSids) { if (-not $seen.ContainsKey($sid)) { throw "Required ACE missing: $sid" } }
  return $Evidence
}

function Assert-SafeParentChain([string] $Path) {
  $cursor = [IO.Path]::GetDirectoryName($Path)
  while (-not [string]::IsNullOrEmpty($cursor)) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unsafe reparse point in parent chain: $cursor" }
    $next = [IO.Path]::GetDirectoryName($cursor)
    if ($next -eq $cursor) { break }
    $cursor = $next
  }
}

function New-PrivateDirectory([string] $Path) {
  $owner = Get-CurrentSid
  if ([IO.Path]::GetFullPath($Path) -ne $Path -or (Test-Path -LiteralPath $Path)) { throw 'Unsafe target path' }
  Assert-SafeParentChain $Path
  $attributes = [XyvaAclNative]::SecurityAttributes((New-PrivateSddl $owner $true))
  try { [XyvaAclNative]::CreatePrivateDirectory($Path, [ref]$attributes) } finally { [void][XyvaAclNative]::LocalFree($attributes.lpSecurityDescriptor) }
  Assert-PrivateAclEvidence (Get-AclEvidenceFromPath $Path $true) $owner $true | Out-Null
}

function New-PrivateFile([string] $Path, [string] $Content) {
  $owner = Get-CurrentSid
  $parent = [IO.Path]::GetDirectoryName($Path)
  if ([IO.Path]::GetFullPath($Path) -ne $Path -or (Test-Path -LiteralPath $Path) -or -not (Test-Path -LiteralPath $parent)) { throw 'Unsafe target path' }
  Assert-SafeParentChain $Path
  $attributes = [XyvaAclNative]::SecurityAttributes((New-PrivateSddl $owner $false))
  $handle = [IntPtr]::Zero
  $stream = $null
  try {
    $handle = [XyvaAclNative]::CreatePrivateFile($Path, [ref]$attributes)
    $safeHandle = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new($handle, $true)
    $stream = [IO.FileStream]::new($safeHandle, [IO.FileAccess]::Write)
    $beforeWrite = Assert-PrivateAclEvidence (Get-AclEvidenceFromHandle $stream.SafeFileHandle.DangerousGetHandle()) $owner $false
    $bytes = [Text.Encoding]::UTF8.GetBytes($Content); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    $afterWrite = Assert-PrivateAclEvidence (Get-AclEvidenceFromHandle $stream.SafeFileHandle.DangerousGetHandle()) $owner $false
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    elseif ($null -ne $handle -and $handle -ne [IntPtr]::Zero) { [void][XyvaAclNative]::CloseHandle($handle) }
    [void][XyvaAclNative]::LocalFree($attributes.lpSecurityDescriptor)
  }
  return [pscustomobject]@{ BeforeWrite = $beforeWrite; AfterWrite = $afterWrite }
}
