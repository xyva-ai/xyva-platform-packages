param(
  [Parameter(Mandatory = $true)][string] $NodeExe,
  [Parameter(Mandatory = $true)][string] $ChildScript,
  [Parameter(Mandatory = $true)][string] $Addon,
  [Parameter(Mandatory = $true)][string] $Root,
  [Parameter(Mandatory = $true)][string] $ControlDirectory,
  [Parameter(Mandatory = $true)][string] $PrivateFile,
  [Parameter(Mandatory = $true)][string] $PrivateDirectory,
  [Parameter(Mandatory = $true)][string] $EvidencePath
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class XyvaSecondUserProcess {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute; public int dwFlags; public short wShowWindow,wReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessWithLogonW(string user, string domain, string password, uint logonFlags, string application, StringBuilder commandLine, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr handle, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
  public static int StartAndWait(string user, string domain, string password, string application, string commandLine, string workingDirectory, out int pid) {
    STARTUPINFO startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(STARTUPINFO)); PROCESS_INFORMATION process;
    StringBuilder mutable = new StringBuilder(commandLine);
    if (!CreateProcessWithLogonW(user, domain, password, 1, application, mutable, 0x08000000, IntPtr.Zero, workingDirectory, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    pid = process.dwProcessId;
    try {
      if (WaitForSingleObject(process.hProcess, 30000) != 0) { TerminateProcess(process.hProcess, 124); throw new TimeoutException("XYVA_SECOND_USER_TIMEOUT"); }
      uint exitCode; if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error()); return unchecked((int)exitCode);
    } finally { if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread); if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess); }
  }
}
'@

function Quote-Argument([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains('"')) { throw 'XYVA_SECOND_USER_UNSAFE_ARGUMENT' }
  return '"' + $Value + '"'
}

function Set-ControlAcl([string] $Path, [bool] $Writable) {
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($owner)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  $rights = if ($Writable) { [Security.AccessControl.FileSystemRights]::Modify } else { [Security.AccessControl.FileSystemRights]::ReadAndExecute }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'), $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

$name = 'xyva-native-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$password = ConvertTo-SecureString (([guid]::NewGuid().ToString('N')) + '!xY') -AsPlainText -Force
$user = $null
try {
  Set-ControlAcl $Root $false
  Set-ControlAcl $ControlDirectory $true
  $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires -ErrorAction Stop
  $plainPassword = ([pscredential]::new($name, $password)).GetNetworkCredential().Password
  $arguments = @(
    (Quote-Argument $NodeExe), (Quote-Argument $ChildScript),
    '--addon', (Quote-Argument $Addon),
    '--expected-sid', (Quote-Argument $user.SID.Value),
    '--control-directory', (Quote-Argument $ControlDirectory),
    '--private-file', (Quote-Argument $PrivateFile),
    '--private-directory', (Quote-Argument $PrivateDirectory),
    '--evidence', (Quote-Argument $EvidencePath)
  ) -join ' '
  $pid = 0
  $exitCode = [XyvaSecondUserProcess]::StartAndWait($name, $env:COMPUTERNAME, $plainPassword, $NodeExe, $arguments, (Split-Path -Parent $NodeExe), [ref] $pid)
  if (-not (Test-Path -LiteralPath $EvidencePath)) { throw 'XYVA_SECOND_USER_EVIDENCE_MISSING' }
  $evidence = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
  if ($exitCode -ne 0 -or $evidence.status -ne 'PASS' -or $evidence.pid -ne $pid -or $evidence.sid -ne $user.SID.Value -or $evidence.administrator) { throw 'XYVA_SECOND_USER_CHILD_VALIDATION_FAILED' }
  [pscustomobject]@{ status = 'PASS'; childPid = $pid; childSid = $user.SID.Value; administrator = [bool]$evidence.administrator; phases = @($evidence.phases) } | ConvertTo-Json -Compress | Set-Content -LiteralPath $EvidencePath -Encoding utf8NoBOM
} finally {
  if ($null -ne $user) { Remove-LocalUser -Name $name -ErrorAction SilentlyContinue }
}
