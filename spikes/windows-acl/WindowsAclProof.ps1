Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TrustedSystemSids = @('S-1-5-18', 'S-1-5-32-544') # LocalSystem and BUILTIN\Administrators: trusted OS recovery identities.
$BroadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') # Everyone, Authenticated Users, BUILTIN\Users.

function Get-CurrentSid { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

if (-not ('XyvaAclNative' -as [type])) {
  Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

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
}
'@
}

function New-PrivateSddl([string] $OwnerSid, [bool] $Directory) {
  $inheritance = if ($Directory) { 'OICI' } else { '' }
  $aces = foreach ($sid in @($OwnerSid) + $TrustedSystemSids) { "(A;$inheritance;FA;;;$sid)" }
  return "O:${OwnerSid}D:PA$($aces -join '')"
}

function Get-AclEvidence([string] $Path) {
  $acl = Get-Acl -LiteralPath $Path
  $owner = [string]$acl.Owner
  try {
    $ownerSid = [Security.Principal.SecurityIdentifier]::new($owner).Value
  } catch {
    $ownerSid = ([Security.Principal.NTAccount]::new($owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  }
  [pscustomobject]@{
    Owner = $ownerSid
    Protected = $acl.AreAccessRulesProtected
    Entries = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [pscustomobject]@{ Sid = $_.IdentityReference.Value; Type = $_.AccessControlType.ToString(); Rights = [int]$_.FileSystemRights; Inherited = $_.IsInherited }
    })
  }
}

function Assert-PrivateAcl([string] $Path, [string] $OwnerSid) {
  $evidence = Get-AclEvidence $Path
  if ($evidence.Owner -ne $OwnerSid -or -not $evidence.Protected) { throw 'Owner or inheritance protection verification failed' }
  foreach ($ace in $evidence.Entries) {
    if ($ace.Type -ne 'Allow' -or $ace.Inherited -or $BroadSids -contains $ace.Sid -or ($ace.Sid -ne $OwnerSid -and $TrustedSystemSids -notcontains $ace.Sid)) { throw "Unexpected ACE: $($ace.Sid)" }
  }
  return $evidence
}

function New-PrivateDirectory([string] $Path) {
  $owner = Get-CurrentSid
  if ([IO.Path]::GetFullPath($Path) -ne $Path -or (Test-Path -LiteralPath $Path)) { throw 'Unsafe target path' }
  $attributes = [XyvaAclNative]::SecurityAttributes((New-PrivateSddl $owner $true))
  try { [XyvaAclNative]::CreatePrivateDirectory($Path, [ref]$attributes) } finally { [void][XyvaAclNative]::LocalFree($attributes.lpSecurityDescriptor) }
  Assert-PrivateAcl $Path $owner | Out-Null
}

function New-PrivateFile([string] $Path, [string] $Content) {
  $owner = Get-CurrentSid
  $parent = [IO.Path]::GetDirectoryName($Path)
  if ([IO.Path]::GetFullPath($Path) -ne $Path -or (Test-Path -LiteralPath $Path) -or -not (Test-Path -LiteralPath $parent) -or ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe target path' }
  $attributes = [XyvaAclNative]::SecurityAttributes((New-PrivateSddl $owner $false))
  $handle = [IntPtr]::Zero
  $stream = $null
  try {
    $handle = [XyvaAclNative]::CreatePrivateFile($Path, [ref]$attributes)
    $safeHandle = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new($handle, $true)
    $stream = [IO.FileStream]::new($safeHandle, [IO.FileAccess]::Write)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Content); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    elseif ($null -ne $handle -and $handle -ne [IntPtr]::Zero) { [void][XyvaAclNative]::CloseHandle($handle) }
    [void][XyvaAclNative]::LocalFree($attributes.lpSecurityDescriptor)
  }
  Assert-PrivateAcl $Path $owner
}
