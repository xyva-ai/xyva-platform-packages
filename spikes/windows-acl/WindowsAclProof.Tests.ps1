param(
  [string] $EvidencePath,
  [switch] $ChildProbe,
  [string] $ExpectedSid,
  [string] $ControlFile,
  [string] $ControlDirectory,
  [string] $ProtectedFile,
  [string] $ProtectedDirectory
)

. "$PSScriptRoot/WindowsAclProof.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-poc-" + [guid]::NewGuid())
$accessRoot = $null
$failure = $null
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string] $Name, [string] $Status, [string] $Detail) {
  $results.Add([pscustomobject]@{ Requirement = $Name; Status = $Status; Detail = $Detail })
}

function Invoke-RequiredTest([string] $Name, [scriptblock] $Action) {
  try { & $Action; Add-Result $Name 'PASS' 'completed' } catch { Add-Result $Name 'FAIL' $_.Exception.Message; throw }
}

function Assert-UnsafeAllowRejected([string] $Sid, [string] $Name) {
  $candidate = Join-Path $root $Name
  New-PrivateFile $candidate 'synthetic-secret' | Out-Null
  $acl = Get-Acl -LiteralPath $candidate
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new($Sid),
    [Security.AccessControl.FileSystemRights]::Read,
    [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $candidate -AclObject $acl
  try { Assert-PrivateAclEvidence (Get-AclEvidenceFromPath $candidate) (Get-CurrentSid) $false | Out-Null } catch { return }
  throw "Unsafe Allow ACE was accepted: $Sid"
}

function Assert-EvidenceRejected($Evidence) {
  try { Assert-PrivateAclEvidence $Evidence (Get-CurrentSid) $false | Out-Null } catch { return }
  throw 'Malformed ACL evidence was accepted'
}

function Set-ControlAreaAcl([string] $Path, [bool] $Directory, [bool] $AllowUnprivilegedWrite = $false) {
  $owner = [Security.Principal.SecurityIdentifier]::new((Get-CurrentSid))
  $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetOwner($owner)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = if ($Directory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($sid in @($owner.Value) + $TrustedSystemSids) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  $unprivilegedRights = if ($AllowUnprivilegedWrite) { [Security.AccessControl.FileSystemRights]::Modify } else { [Security.AccessControl.FileSystemRights]::ReadAndExecute }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), $unprivilegedRights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Test-AccessDeniedException([Exception] $Exception) {
  $current = $Exception
  while ($null -ne $current) {
    if ($current -is [System.UnauthorizedAccessException] -or $current.HResult -eq [int]0x80070005) { return $true }
    $current = $current.InnerException
  }
  return $false
}

function Assert-KernelAccessDenied([scriptblock] $Operation, [string] $UnexpectedSuccess) {
  try {
    & $Operation
    throw $UnexpectedSuccess
  } catch {
    if (Test-AccessDeniedException $_.Exception) { return }
    if ($_.Exception.Message -eq $UnexpectedSuccess) { throw }
    throw
  }
}

function Quote-ChildArgument([string] $Value) {
  if ($Value -match '"') { throw 'Unsafe child-process argument' }
  return '"' + $Value + '"'
}

if ($ChildProbe) {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent($true)
    if ($identity.User.Value -ne $ExpectedSid -or [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Child token verification failed' }
    if (([IO.File]::ReadAllText($ControlFile)) -ne 'control-readable') { throw 'Child positive read failed' }
    $probe = Join-Path $ControlDirectory 'child-process-write.txt'; [IO.File]::WriteAllText($probe, 'child-write'); [IO.File]::Delete($probe)
    Assert-KernelAccessDenied { [IO.File]::ReadAllText($ProtectedFile) | Out-Null } 'Child private read unexpectedly succeeded'
    Assert-KernelAccessDenied { [IO.File]::AppendAllText($ProtectedFile, 'x') } 'Child private write unexpectedly succeeded'
    Assert-KernelAccessDenied { [IO.File]::WriteAllText((Join-Path $ProtectedDirectory 'child-process-create.txt'), 'x') } 'Child private directory create unexpectedly succeeded'
    exit 0
  } catch { Write-Error 'Second-process ACL probe failed'; exit 71 }
}
if ([string]::IsNullOrEmpty($EvidencePath)) { throw 'EvidencePath is required for the parent test harness' }

function Test-UnprivilegedIdentity([string] $ControlFile, [string] $ControlDirectory, [string] $ProtectedFile, [string] $ProtectedRoot) {
  $name = "xyva-acl-" + [guid]::NewGuid().ToString('N').Substring(0, 11)
  $password = ConvertTo-SecureString (([guid]::NewGuid().ToString('N')) + '!xY') -AsPlainText -Force
  $user = $null
  $token = $null
  $originalSid = Get-CurrentSid
  try {
    $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires -ErrorAction Stop
    $token = [XyvaAclNative]::LogonInteractive($name, $env:COMPUTERNAME, ([pscredential]::new($name, $password)).GetNetworkCredential().Password)
    [Security.Principal.WindowsIdentity]::RunImpersonated($token, [Action] {
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent($true)
      if ($identity.User.Value -ne $user.SID.Value -or $identity.User.Value -eq $originalSid) { throw 'Impersonation SID verification failed' }
      Add-Result 'impersonation-active-with-test-sid' 'PASS' 'effective SID matches disposable test user'
      if ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Impersonated token has administrator rights' }
      Add-Result 'impersonated-token-not-administrator' 'PASS' 'administrator role absent'
      if (([IO.File]::ReadAllText($ControlFile)) -ne 'control-readable') { throw 'Positive control read failed' }
      Add-Result 'unprivileged-positive-control-read' 'PASS' 'control file readable'
      $controlWrite = Join-Path $ControlDirectory 'unprivileged-write.txt'
      [IO.File]::WriteAllText($controlWrite, 'control-writeable')
      if (([IO.File]::ReadAllText($controlWrite)) -ne 'control-writeable') { throw 'Positive control write verification failed' }
      [IO.File]::Delete($controlWrite)
      Add-Result 'unprivileged-positive-control-create' 'PASS' 'control directory writable'
      Assert-KernelAccessDenied { [IO.File]::ReadAllText($ProtectedFile) | Out-Null } 'Private file read unexpectedly succeeded'
      Add-Result 'unprivileged-private-file-read-denied' 'PASS' 'kernel denied read'
      Assert-KernelAccessDenied { [IO.File]::AppendAllText($ProtectedFile, 'x') } 'Private file write unexpectedly succeeded'
      Add-Result 'unprivileged-private-file-write-denied' 'PASS' 'kernel denied write'
      Assert-KernelAccessDenied { [IO.File]::WriteAllText((Join-Path $ProtectedRoot 'unprivileged-create.txt'), 'x') } 'Private directory create unexpectedly succeeded'
      Add-Result 'unprivileged-private-directory-create-denied' 'PASS' 'kernel denied create'
    })
    if ((Get-CurrentSid) -ne $originalSid) { throw 'Original process identity was not restored' }
    Add-Result 'original-identity-restored' 'PASS' 'effective SID restored after impersonation'
    $scriptPath = $PSCommandPath
    $arguments = "-NoProfile -NonInteractive -File $(Quote-ChildArgument $scriptPath) -ChildProbe -ExpectedSid $(Quote-ChildArgument $user.SID.Value) -ControlFile $(Quote-ChildArgument $ControlFile) -ControlDirectory $(Quote-ChildArgument $ControlDirectory) -ProtectedFile $(Quote-ChildArgument $ProtectedFile) -ProtectedDirectory $(Quote-ChildArgument $ProtectedRoot)"
    $exitCode = [XyvaAclNative]::RunProcessWithLogon($name, $env:COMPUTERNAME, ([pscredential]::new($name, $password)).GetNetworkCredential().Password, (Join-Path $PSHOME 'pwsh.exe'), $arguments, $env:SystemRoot)
    if ($exitCode -ne 0) { throw "Second-process ACL probe returned $exitCode" }
    Add-Result 'unprivileged-separate-process-access-controls' 'PASS' 'CreateProcessWithLogonW child passed kernel access checks'
  } finally {
    if ($null -ne $token) { $token.Dispose() }
    if ($null -ne $user) { Remove-LocalUser -Name $name -ErrorAction SilentlyContinue }
  }
}

try {
  Invoke-RequiredTest 'private-directory-create' { New-PrivateDirectory $root }
  $file = Join-Path $root 'secret.txt'
  $creation = $null
  Invoke-RequiredTest 'handle-bound-acl-before-and-after-write' { $script:creation = New-PrivateFile $file 'synthetic-secret' }
  Invoke-RequiredTest 'authorized-owner-read' { if ((Get-Content -LiteralPath $file -Raw) -ne 'synthetic-secret') { throw 'Authorized read failed' } }
  Invoke-RequiredTest 'complete-dacl-and-owner-model' { Assert-PrivateAclEvidence $creation.BeforeWrite (Get-CurrentSid) $false | Out-Null; Assert-PrivateAclEvidence $creation.AfterWrite (Get-CurrentSid) $false | Out-Null }
  Invoke-RequiredTest 'fail-closed-null-missing-empty-and-manipulated-acl' {
    $base = $creation.AfterWrite
    $variants = @(
      [pscustomobject]@{ Owner = $base.Owner; DaclPresent = $false; Protected = $base.Protected; DaclNull = $true; Entries = $base.Entries },
      [pscustomobject]@{ Owner = $base.Owner; DaclPresent = $true; Protected = $base.Protected; DaclNull = $false; Entries = @() },
      [pscustomobject]@{ Owner = 'S-1-5-32-546'; DaclPresent = $base.DaclPresent; Protected = $base.Protected; DaclNull = $base.DaclNull; Entries = $base.Entries },
      [pscustomobject]@{ Owner = $base.Owner; DaclPresent = $base.DaclPresent; Protected = $false; DaclNull = $base.DaclNull; Entries = $base.Entries },
      [pscustomobject]@{ Owner = $base.Owner; DaclPresent = $base.DaclPresent; Protected = $base.Protected; DaclNull = $base.DaclNull; Entries = @($base.Entries | Select-Object -Skip 1) },
      [pscustomobject]@{ Owner = $base.Owner; DaclPresent = $base.DaclPresent; Protected = $base.Protected; DaclNull = $base.DaclNull; Entries = @([pscustomobject]@{ AceKind = 'Unknown'; Type = 'Unknown'; Sid = $null; Rights = $null; Inherited = $false; Flags = 0 }) }
    )
    foreach ($variant in $variants) { Assert-EvidenceRejected $variant }
  }
  Invoke-RequiredTest 'parent-chain-reparse-rejection' {
    $outside = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-outside-" + [guid]::NewGuid())
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    $junction = Join-Path $root 'reparse-parent'
    New-Item -ItemType Junction -Path $junction -Target $outside -ErrorAction Stop | Out-Null
    try { New-PrivateFile (Join-Path $junction 'must-not-exist.txt') 'synthetic-secret' | Out-Null; throw 'Reparse parent was accepted' } catch { if ($_.Exception.Message -eq 'Reparse parent was accepted') { throw } }
    Remove-Item -LiteralPath $junction -Force
    Remove-Item -LiteralPath $outside -Recurse -Force
  }
  foreach ($sid in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546')) {
    Invoke-RequiredTest "unsafe-allow-rejected-$sid" { Assert-UnsafeAllowRejected $sid ("unsafe-" + $sid.Replace('-', '_') + '.txt') }
  }
  $accessRoot = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-access-" + [guid]::NewGuid())
  Invoke-RequiredTest 'comparable-parent-access-control-setup' {
    New-PrivateDirectory $accessRoot
    $script:controlFile = Join-Path $accessRoot 'control.txt'
    $script:controlDirectory = Join-Path $accessRoot 'control-directory'
    $script:impersonationPrivateFile = Join-Path $accessRoot 'private.txt'
    $script:impersonationPrivateDirectory = Join-Path $accessRoot 'private-directory'
    New-PrivateFile $controlFile 'control-readable' | Out-Null
    New-PrivateDirectory $controlDirectory
    New-PrivateFile $impersonationPrivateFile 'synthetic-secret' | Out-Null
    New-PrivateDirectory $impersonationPrivateDirectory
    Set-ControlAreaAcl $controlFile $false
    Set-ControlAreaAcl $controlDirectory $true $true
    Set-ControlAreaAcl $accessRoot $true
  }
  Invoke-RequiredTest 'unprivileged-effective-access-controls' { Test-UnprivilegedIdentity $controlFile $controlDirectory $impersonationPrivateFile $impersonationPrivateDirectory }
} catch {
  $failure = $_
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
  if ($null -ne $accessRoot -and (Test-Path -LiteralPath $accessRoot)) { Remove-Item -LiteralPath $accessRoot -Recurse -Force }
  $evidence = [pscustomobject]@{
    Schema = 'xyva.windows-acl-poc.v2'
    Commit = (git rev-parse HEAD).Trim()
    OS = [Environment]::OSVersion.VersionString
    PowerShell = $PSVersionTable.PSVersion.ToString()
    RunnerOS = $env:RUNNER_OS
    Results = @($results)
  }
  $evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $EvidencePath -Encoding utf8NoBOM
}
if ($null -ne $failure) { throw $failure }
if ($results.Status -contains 'FAIL' -or $results.Count -eq 0) { throw 'Incomplete security evidence' }
Write-Output 'WINDOWS_ACL_POC_PASS'
