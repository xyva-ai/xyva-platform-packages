param(
  [string] $EvidencePath,
  [switch] $ChildProbe,
  [string] $ExpectedSid,
  [string] $ControlFile,
  [string] $ControlDirectory,
  [string] $ProtectedFile,
  [string] $ProtectedDirectory,
  [string] $ChildEvidencePath,
  [int] $ParentPid,
  [switch] $RaceSwap,
  [string] $SwapParent,
  [string] $SwapMoved,
  [string] $SwapOutside,
  [string] $RaceEvidencePath
)

. "$PSScriptRoot/WindowsAclProof.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-poc-" + [guid]::NewGuid())
$accessRoot = $null
$failure = $null
$results = [System.Collections.Generic.List[object]]::new()
$script:RaceEvidence = $null
$script:DirectoryRaceEvidence = $null
$script:SecondProcessEvidence = $null

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

function Test-NativeMalformedDaclFixture([ValidateSet('null', 'empty')] [string] $Kind) {
  $fixture = Join-Path $root ("native-" + $Kind + "-dacl-" + [guid]::NewGuid().ToString('N') + '.tmp')
  $handle = [IntPtr]::Zero
  $state = $null
  $rejected = $false
  try {
    # This content is intentionally non-sensitive and the fixture never leaves the private temporary root.
    [IO.File]::WriteAllText($fixture, 'fixture')
    $handle = [XyvaAclNative]::OpenForDaclMutation($fixture, $false)
    if ($Kind -eq 'null') { [XyvaAclNative]::SetNullDacl($handle) } else { [XyvaAclNative]::SetEmptyDacl($handle) }
    $state = [XyvaAclNative]::HandleDaclState($handle)
    if (-not $state.DaclPresent) { throw "Native $Kind DACL fixture did not retain DACL-present" }
    if (($Kind -eq 'null' -and -not $state.DaclNull) -or ($Kind -eq 'empty' -and $state.DaclNull)) { throw "Native $Kind DACL fixture did not retain the requested DACL pointer state" }
    if ($state.AceCount -ne 0) { throw "Native $Kind DACL fixture has unexpected ACE count: $($state.AceCount)" }
    if (($state.Control -band 0x1000) -eq 0) { throw "Native $Kind DACL fixture is not protected from inheritance" }
    $evidence = Get-AclEvidenceFromHandle $handle
    if ($evidence.DaclPresent -ne $state.DaclPresent -or $evidence.DaclNull -ne $state.DaclNull -or $evidence.Entries.Count -ne $state.AceCount) { throw 'Handle ACL evidence disagrees with native descriptor state' }
    try { Assert-PrivateAclEvidence $evidence (Get-CurrentSid) $false | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "XYVA validation accepted a native $Kind DACL" }
  } finally {
    if ($handle -ne [IntPtr]::Zero) {
      try { [XyvaAclNative]::SetDaclFromSddl($handle, (New-PrivateSddl (Get-CurrentSid) $false)) }
      finally { [void][XyvaAclNative]::CloseHandle($handle) }
    }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $fixture) { throw "Native $Kind DACL fixture cleanup failed" }
  }
  Add-Result "native-$Kind-dacl-file" 'PASS' ("object=file; daclPresent={0}; daclNull={1}; aceCount={2}; control=0x{3:X4}; xyvaRejected={4}; cleanup=true" -f $state.DaclPresent, $state.DaclNull, $state.AceCount, $state.Control, $rejected)
}

function Invoke-NativeMalformedDaclFixture([ValidateSet('null', 'empty')] [string] $Kind) {
  try { Test-NativeMalformedDaclFixture $Kind } catch { Add-Result "native-$Kind-dacl-file" 'FAIL' $_.Exception.Message; throw }
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

function Get-Win32ErrorCode([Exception] $Exception) {
  $current = $Exception
  while ($null -ne $current) {
    if ($current -is [ComponentModel.Win32Exception]) { return $current.NativeErrorCode }
    $current = $current.InnerException
  }
  return $null
}

function Assert-NativeCollision([scriptblock] $Operation) {
  try { & $Operation } catch {
    if (@(80, 183) -contains (Get-Win32ErrorCode $_.Exception)) { return }
    throw
  }
  throw 'Existing target was overwritten or accepted'
}

function Assert-InjectedFailure([scriptblock] $Operation, [string] $ExpectedMessage) {
  try { & $Operation } catch {
    if ($_.Exception.Message -eq $ExpectedMessage) { return }
    throw
  }
  throw 'Injected failure did not occur'
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
  $phase = 'process-started'
  $phases = [System.Collections.Generic.List[string]]::new()
  $phases.Add($phase)
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($PID -eq $ParentPid -or $identity.User.Value -ne $ExpectedSid -or [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Child process identity verification failed' }
    $phase = 'identity-verified'; $phases.Add($phase); if (([IO.File]::ReadAllText($ControlFile)) -ne 'control-readable') { throw 'Child positive read failed' }
    $phase = 'positive-read'; $phases.Add($phase)
    $probe = Join-Path $ControlDirectory 'child-process-write.txt'; [IO.File]::WriteAllText($probe, 'child-write'); [IO.File]::Delete($probe)
    $phase = 'positive-write'; $phases.Add($phase); Assert-KernelAccessDenied { [IO.File]::ReadAllText($ProtectedFile) | Out-Null } 'Child private read unexpectedly succeeded'
    Assert-KernelAccessDenied { [IO.File]::AppendAllText($ProtectedFile, 'x') } 'Child private write unexpectedly succeeded'
    Assert-KernelAccessDenied { [IO.File]::WriteAllText((Join-Path $ProtectedDirectory 'child-process-create.txt'), 'x') } 'Child private directory create unexpectedly succeeded'
    $phase = 'private-access-denied'; $phases.Add($phase); $phase = 'controlled-exit'; $phases.Add($phase); [pscustomobject]@{ Phase = $phase; Phases = @($phases); Pid = $PID; ParentPid = $ParentPid; Sid = $identity.User.Value; ExitCode = 0 } | ConvertTo-Json | Set-Content -LiteralPath $ChildEvidencePath -Encoding utf8NoBOM; exit 0
  } catch { [pscustomobject]@{ Phase = $phase; Phases = @($phases); Pid = $PID; ParentPid = $ParentPid; ErrorType = $_.Exception.GetType().Name; ExitCode = 71 } | ConvertTo-Json | Set-Content -LiteralPath $ChildEvidencePath -Encoding utf8NoBOM; exit 71 }
}
if ($RaceSwap) {
  $phase = 'race-process-started'
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Race attacker unexpectedly has administrator rights' }
    Move-Item -LiteralPath $SwapParent -Destination $SwapMoved -ErrorAction Stop
    New-Item -ItemType Junction -Path $SwapParent -Target $SwapOutside -ErrorAction Stop | Out-Null
    [pscustomobject]@{ ExitCode = 0; Pid = $PID; Sid = $identity.User.Value; Administrator = $false; Swapped = $true } | ConvertTo-Json | Set-Content -LiteralPath $RaceEvidencePath -Encoding utf8NoBOM
    exit 0
  } catch {
    [pscustomobject]@{ ExitCode = 73; Pid = $PID; Sid = $identity.User.Value; Administrator = $null; Swapped = $false; ErrorType = $_.Exception.GetType().Name; Error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $RaceEvidencePath -Encoding utf8NoBOM
    exit 73
  }
}
if ([string]::IsNullOrEmpty($EvidencePath)) { throw 'EvidencePath is required for the parent test harness' }

function Test-UnprivilegedIdentity([string] $ControlFile, [string] $ControlDirectory, [string] $ProtectedFile, [string] $ProtectedRoot, [string] $RaceProbeParent) {
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
      Assert-KernelAccessDenied { Move-Item -LiteralPath $RaceProbeParent -Destination ($RaceProbeParent + '-moved') -ErrorAction Stop } 'Unprivileged identity unexpectedly renamed race parent'
      Add-Result 'unprivileged-race-parent-swap-denied' 'PASS' 'kernel denied prerequisite parent rename'
    })
    if ((Get-CurrentSid) -ne $originalSid) { throw 'Original process identity was not restored' }
    Add-Result 'original-identity-restored' 'PASS' 'effective SID restored after impersonation'
    $scriptPath = $PSCommandPath
    $childEvidence = Join-Path $ControlDirectory 'child-evidence.json'
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $arguments = "$(Quote-ChildArgument $pwsh) -NoProfile -NonInteractive -File $(Quote-ChildArgument $scriptPath) -ChildProbe -ExpectedSid $(Quote-ChildArgument $user.SID.Value) -ControlFile $(Quote-ChildArgument $ControlFile) -ControlDirectory $(Quote-ChildArgument $ControlDirectory) -ProtectedFile $(Quote-ChildArgument $ProtectedFile) -ProtectedDirectory $(Quote-ChildArgument $ProtectedRoot) -ChildEvidencePath $(Quote-ChildArgument $childEvidence) -ParentPid $PID"
    $exitCode = [XyvaAclNative]::RunProcessWithLogon($name, $env:COMPUTERNAME, ([pscredential]::new($name, $password)).GetNetworkCredential().Password, $pwsh, $arguments, $env:SystemRoot)
    if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $childEvidence)) { throw "Second-process ACL probe failed: exit=$exitCode evidence=$([bool](Test-Path -LiteralPath $childEvidence))" }
    $child = Get-Content -LiteralPath $childEvidence -Raw | ConvertFrom-Json
    if ($child.ExitCode -ne 0 -or $child.Pid -eq $PID -or $child.ParentPid -ne $PID -or $child.Sid -ne $user.SID.Value -or @($child.Phases) -notcontains 'controlled-exit') { throw 'Second-process evidence validation failed' }
    $script:SecondProcessEvidence = [pscustomobject]@{
      Pid = $child.Pid
      ParentPid = $child.ParentPid
      Sid = $child.Sid
      ExpectedSid = $user.SID.Value
      ExitCode = $child.ExitCode
      Phases = @($child.Phases)
      Cleanup = $true
    }
    Add-Result 'unprivileged-separate-process-access-controls' 'PASS' "child pid=$($child.Pid); parent pid=$($child.ParentPid); sid=$($child.Sid); phases=$(@($child.Phases) -join ',')"
  } finally {
    if ($null -ne $token) { $token.Dispose() }
    if ($null -ne $user) { Remove-LocalUser -Name $name -ErrorAction SilentlyContinue }
  }
}

function Invoke-RaceSwapProcess([string] $RaceRoot, [string] $Parent, [string] $Moved, [string] $Outside) {
  $name = "xyva-race-" + [guid]::NewGuid().ToString('N').Substring(0, 10)
  $password = ConvertTo-SecureString (([guid]::NewGuid().ToString('N')) + '!xY') -AsPlainText -Force
  $user = $null
  try {
    $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires -ErrorAction Stop
    Set-ControlAreaAcl $RaceRoot $true $true
    Set-ControlAreaAcl $Parent $true $true
    Set-ControlAreaAcl $Outside $true $true
    $raceEvidencePath = Join-Path $RaceRoot 'race-attacker-evidence.json'
    $scriptPath = $PSCommandPath
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $arguments = "$(Quote-ChildArgument $pwsh) -NoProfile -NonInteractive -File $(Quote-ChildArgument $scriptPath) -RaceSwap -SwapParent $(Quote-ChildArgument $Parent) -SwapMoved $(Quote-ChildArgument $Moved) -SwapOutside $(Quote-ChildArgument $Outside) -RaceEvidencePath $(Quote-ChildArgument $raceEvidencePath)"
    $exitCode = [XyvaAclNative]::RunProcessWithLogon($name, $env:COMPUTERNAME, ([pscredential]::new($name, $password)).GetNetworkCredential().Password, $pwsh, $arguments, $env:SystemRoot)
    if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $raceEvidencePath)) {
      $childFailure = if (Test-Path -LiteralPath $raceEvidencePath) { (Get-Content -LiteralPath $raceEvidencePath -Raw).Trim() } else { 'evidence-missing' }
      throw "Race attacker process failed: exit=$exitCode evidence=$childFailure"
    }
    $evidence = Get-Content -LiteralPath $raceEvidencePath -Raw | ConvertFrom-Json
    if ($evidence.ExitCode -ne 0 -or $evidence.Pid -eq $PID -or $evidence.Sid -eq (Get-CurrentSid) -or $evidence.Administrator -or -not $evidence.Swapped) { throw 'Race attacker evidence validation failed' }
    return $evidence
  } finally {
    if ($null -ne $user) { Remove-LocalUser -Name $name -ErrorAction SilentlyContinue }
  }
}

try {
  $rootCreation = $null
  Invoke-RequiredTest 'private-directory-create' { $script:rootCreation = New-PrivateDirectory $root }
  Invoke-RequiredTest 'directory-handle-bound-acl' { Assert-PrivateAclEvidence $rootCreation.Evidence (Get-CurrentSid) $true | Out-Null }
  $file = Join-Path $root 'secret.txt'
  $creation = $null
  Invoke-RequiredTest 'handle-bound-acl-before-and-after-write' { $script:creation = New-PrivateFile $file 'synthetic-secret' }
  Invoke-RequiredTest 'authorized-owner-read' { if ((Get-Content -LiteralPath $file -Raw) -ne 'synthetic-secret') { throw 'Authorized read failed' } }
  Invoke-RequiredTest 'complete-dacl-and-owner-model' { Assert-PrivateAclEvidence $creation.BeforeWrite (Get-CurrentSid) $false | Out-Null; Assert-PrivateAclEvidence $creation.AfterWrite (Get-CurrentSid) $false | Out-Null }
  Invoke-RequiredTest 'existing-target-native-create-rejected' {
    Assert-NativeCollision { New-PrivateFile $file 'must-not-overwrite' | Out-Null }
  }
  Invoke-RequiredTest 'existing-directory-native-create-rejected' {
    Assert-NativeCollision { New-PrivateDirectory $root | Out-Null }
  }
  Invoke-RequiredTest 'file-hook-failure-cleans-parent-handles' {
    $target = Join-Path $root 'file-hook-failure.txt'
    try {
      $script:BeforePrivateCreateHook = { throw 'injected file hook failure' }
      Assert-InjectedFailure { New-PrivateFile $target 'synthetic-secret' | Out-Null } 'injected file hook failure'
      if (Test-Path -LiteralPath $target) { throw 'File hook failure created a target' }
    } finally { $script:BeforePrivateCreateHook = $null }
    New-PrivateFile $target 'synthetic-secret' | Out-Null
  }
  Invoke-RequiredTest 'directory-descriptor-failure-cleans-parent-handles' {
    $target = Join-Path $root 'directory-descriptor-failure'
    try {
      $script:BeforeSecurityDescriptorHook = { throw 'injected descriptor failure' }
      Assert-InjectedFailure { New-PrivateDirectory $target | Out-Null } 'injected descriptor failure'
      if (Test-Path -LiteralPath $target) { throw 'Descriptor failure created a directory' }
    } finally { $script:BeforeSecurityDescriptorHook = $null }
    New-PrivateDirectory $target | Out-Null
  }
  Invoke-RequiredTest 'directory-hook-failure-cleans-parent-handles' {
    $target = Join-Path $root 'directory-hook-failure'
    try {
      $script:BeforePrivateDirectoryCreateHook = { throw 'injected directory hook failure' }
      Assert-InjectedFailure { New-PrivateDirectory $target | Out-Null } 'injected directory hook failure'
      if (Test-Path -LiteralPath $target) { throw 'Directory hook failure created a target' }
    } finally { $script:BeforePrivateDirectoryCreateHook = $null }
    New-PrivateDirectory $target | Out-Null
  }
  Invoke-RequiredTest 'directory-handle-cleanup-allows-rename-and-remove' {
    $source = Join-Path $root 'cleanup-directory'; $moved = Join-Path $root 'cleanup-directory-moved'
    New-PrivateDirectory $source | Out-Null
    Move-Item -LiteralPath $source -Destination $moved -ErrorAction Stop
    Remove-Item -LiteralPath $moved -Recurse -Force -ErrorAction Stop
    if ((Test-Path -LiteralPath $source) -or (Test-Path -LiteralPath $moved)) { throw 'Directory handle prevented cleanup' }
  }
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
  Invoke-NativeMalformedDaclFixture 'null'
  Invoke-NativeMalformedDaclFixture 'empty'
  Add-Result 'native-missing-dacl-file' 'NOT_EXECUTED' 'object=file; NTFS-associated object descriptors retain SE_DACL_PRESENT, so a missing-DACL state cannot be independently established on this fixture without simulating evidence'
  Invoke-RequiredTest 'parent-chain-reparse-rejection' {
    $outside = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-outside-" + [guid]::NewGuid())
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    $junction = Join-Path $root 'reparse-parent'
    New-Item -ItemType Junction -Path $junction -Target $outside -ErrorAction Stop | Out-Null
    try { New-PrivateFile (Join-Path $junction 'must-not-exist.txt') 'synthetic-secret' | Out-Null; throw 'Reparse parent was accepted' } catch { if ($_.Exception.Message -eq 'Reparse parent was accepted') { throw } }
    Remove-Item -LiteralPath $junction -Force
    Remove-Item -LiteralPath $outside -Recurse -Force
  }
  Invoke-RequiredTest 'directory-parent-chain-reparse-rejection' {
    $outside = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-directory-outside-" + [guid]::NewGuid())
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    $junction = Join-Path $root 'directory-reparse-parent'
    New-Item -ItemType Junction -Path $junction -Target $outside -ErrorAction Stop | Out-Null
    try { New-PrivateDirectory (Join-Path $junction 'must-not-exist') | Out-Null; throw 'Directory reparse parent was accepted' } catch { if ($_.Exception.Message -eq 'Directory reparse parent was accepted') { throw } }
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
    $script:raceProbeParent = Join-Path $accessRoot 'race-probe-parent'
    New-PrivateFile $controlFile 'control-readable' | Out-Null
    New-PrivateDirectory $controlDirectory
    New-PrivateFile $impersonationPrivateFile 'synthetic-secret' | Out-Null
    New-PrivateDirectory $impersonationPrivateDirectory
    New-PrivateDirectory $raceProbeParent
    Set-ControlAreaAcl $controlFile $false
    Set-ControlAreaAcl $controlDirectory $true $true
    Set-ControlAreaAcl $accessRoot $true
  }
  Invoke-RequiredTest 'unprivileged-effective-access-controls' { Test-UnprivilegedIdentity $controlFile $controlDirectory $impersonationPrivateFile $impersonationPrivateDirectory $raceProbeParent }
  Invoke-RequiredTest 'deterministic-parent-swap-race-rejection' {
    $raceRoot = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-race-" + [guid]::NewGuid())
    $outside = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-race-outside-" + [guid]::NewGuid())
    $parent = Join-Path $raceRoot 'parent'; $moved = Join-Path $raceRoot 'parent-moved'; $target = Join-Path $parent 'must-not-escape.txt'
    $raceState = [ordered]@{ HookReached = $false; RootHandle = $null; ParentHandle = $null; BarrierReached = $false; SwapPerformedBySid = $null; Result = $null; ResultingParentHandle = $null; ExternalUnchanged = $false; Cleanup = $false; HookErrorType = $null; HookErrorMessage = $null; NativeErrorCode = $null }
    try {
      New-PrivateDirectory $raceRoot; New-PrivateDirectory $parent; [IO.Directory]::CreateDirectory($outside) | Out-Null
      $sentinel = Join-Path $outside 'sentinel.txt'; [IO.File]::WriteAllText($sentinel, 'outside-sentinel')
      $swapParent = $parent; $swapMoved = $moved; $swapOutside = $outside
      $script:BeforePrivateCreateHook = ({
        param($resolution)
        $raceState.RootHandle = $resolution.RootIdentity; $raceState.ParentHandle = $resolution.ParentIdentity; $raceState.BarrierReached = $true; $raceState.SwapPerformedBySid = Get-CurrentSid
        try {
          $attacker = Invoke-RaceSwapProcess $raceRoot $swapParent $swapMoved $swapOutside
          $raceState.SwapPerformedBySid = $attacker.Sid
          $raceState.HookReached = $true
        } catch {
          $raceState.HookErrorType = $_.Exception.GetType().Name
          $raceState.HookErrorMessage = $_.Exception.Message
          throw
        }
      }).GetNewClosure()
      try {
        $raceCreation = New-PrivateFile $target 'synthetic-secret'
        $raceState.Result = 'created-via-held-parent-handle'
        $raceState.ResultingParentHandle = $raceCreation.ParentIdentity
      } catch {
        $errorCode = Get-Win32ErrorCode $_.Exception
        $raceState.Result = 'rejected:' + $_.Exception.GetType().Name
        $raceState.NativeErrorCode = $errorCode
      }
      if (-not $raceState.HookReached) { throw 'Race hook was not reached' }
      if (([IO.File]::ReadAllText($sentinel)) -ne 'outside-sentinel') { throw 'Race test sentinel was modified' }
      if (Test-Path -LiteralPath (Join-Path $outside 'must-not-escape.txt')) { throw 'Parent swap redirected native file creation outside validated path' }
      if ($raceState.Result -eq 'created-via-held-parent-handle' -and -not (Test-Path -LiteralPath (Join-Path $moved 'must-not-escape.txt'))) { throw 'Handle-bound create did not remain in the original parent object' }
      $raceState.ExternalUnchanged = $true
    } finally {
      $script:BeforePrivateCreateHook = $null
      if (Test-Path -LiteralPath $parent) { Remove-Item -LiteralPath $parent -Force }
      if (Test-Path -LiteralPath $raceRoot) { Remove-Item -LiteralPath $raceRoot -Recurse -Force }
      if (Test-Path -LiteralPath $outside) { Remove-Item -LiteralPath $outside -Recurse -Force }
      $raceState.Cleanup = -not (Test-Path -LiteralPath $raceRoot) -and -not (Test-Path -LiteralPath $outside)
      $script:RaceEvidence = [pscustomobject]$raceState
    }
  }
  Invoke-RequiredTest 'deterministic-directory-parent-swap-race-rejection' {
    $raceRoot = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-directory-race-" + [guid]::NewGuid())
    $outside = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-directory-race-outside-" + [guid]::NewGuid())
    $parent = Join-Path $raceRoot 'parent'; $moved = Join-Path $raceRoot 'parent-moved'; $target = Join-Path $parent 'must-not-escape'
    $raceState = [ordered]@{ HookReached = $false; RootHandle = $null; ParentHandle = $null; BarrierReached = $false; SwapPerformedBySid = $null; Result = $null; ResultingDirectoryHandle = $null; ExternalUnchanged = $false; Cleanup = $false; HookErrorType = $null; HookErrorMessage = $null; NativeErrorCode = $null }
    try {
      New-PrivateDirectory $raceRoot | Out-Null; New-PrivateDirectory $parent | Out-Null; [IO.Directory]::CreateDirectory($outside) | Out-Null
      $sentinel = Join-Path $outside 'sentinel.txt'; [IO.File]::WriteAllText($sentinel, 'outside-sentinel')
      $swapParent = $parent; $swapMoved = $moved; $swapOutside = $outside
      $script:BeforePrivateDirectoryCreateHook = ({
        param($resolution)
        $raceState.RootHandle = $resolution.RootIdentity; $raceState.ParentHandle = $resolution.ParentIdentity; $raceState.BarrierReached = $true; $raceState.SwapPerformedBySid = Get-CurrentSid
        try {
          $attacker = Invoke-RaceSwapProcess $raceRoot $swapParent $swapMoved $swapOutside
          $raceState.SwapPerformedBySid = $attacker.Sid
          $raceState.HookReached = $true
        } catch { $raceState.HookErrorType = $_.Exception.GetType().Name; $raceState.HookErrorMessage = $_.Exception.Message; throw }
      }).GetNewClosure()
      try {
        $creation = New-PrivateDirectory $target
        $raceState.Result = 'created-via-held-parent-handle'
        $raceState.ResultingDirectoryHandle = $creation.Identity
        Assert-PrivateAclEvidence $creation.Evidence (Get-CurrentSid) $true | Out-Null
      } catch {
        $raceState.Result = 'rejected:' + $_.Exception.GetType().Name
        $raceState.NativeErrorCode = Get-Win32ErrorCode $_.Exception
      }
      if (-not $raceState.HookReached) { throw 'Directory race hook was not reached' }
      if (([IO.File]::ReadAllText($sentinel)) -ne 'outside-sentinel') { throw 'Directory race test sentinel was modified' }
      if (Test-Path -LiteralPath (Join-Path $outside 'must-not-escape')) { throw 'Parent swap redirected native directory creation outside validated path' }
      if ($raceState.Result -eq 'created-via-held-parent-handle' -and -not (Test-Path -LiteralPath (Join-Path $moved 'must-not-escape'))) { throw 'Handle-bound directory create did not remain in the original parent object' }
      $raceState.ExternalUnchanged = $true
    } finally {
      $script:BeforePrivateDirectoryCreateHook = $null
      if (Test-Path -LiteralPath $parent) { Remove-Item -LiteralPath $parent -Force }
      if (Test-Path -LiteralPath $raceRoot) { Remove-Item -LiteralPath $raceRoot -Recurse -Force }
      if (Test-Path -LiteralPath $outside) { Remove-Item -LiteralPath $outside -Recurse -Force }
      $raceState.Cleanup = -not (Test-Path -LiteralPath $raceRoot) -and -not (Test-Path -LiteralPath $outside)
      $script:DirectoryRaceEvidence = [pscustomobject]$raceState
    }
  }
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
    SecondProcessEvidence = $script:SecondProcessEvidence
    RaceEvidence = $script:RaceEvidence
    DirectoryRaceEvidence = $script:DirectoryRaceEvidence
  }
  $evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $EvidencePath -Encoding utf8NoBOM
}
if ($null -ne $failure) { throw $failure }
if ($results.Status -contains 'FAIL' -or $results.Count -eq 0) { throw 'Incomplete security evidence' }
Write-Output 'WINDOWS_ACL_POC_PASS'
