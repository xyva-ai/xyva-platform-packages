param(
  [Parameter(Mandatory = $true)] [string] $EvidencePath
)

. "$PSScriptRoot/WindowsAclProof.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-poc-" + [guid]::NewGuid())
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

function Test-UnprivilegedIdentity([string] $ProtectedFile, [string] $ProtectedRoot) {
  $name = "xyva-acl-" + [guid]::NewGuid().ToString('N').Substring(0, 11)
  $password = ConvertTo-SecureString (([guid]::NewGuid().ToString('N')) + '!xY') -AsPlainText -Force
  $user = $null
  try {
    $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires -ErrorAction Stop
    $credential = [pscredential]::new("$env:COMPUTERNAME\$name", $password)
    $target = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ProtectedFile))
    $readCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$target')); try { [IO.File]::ReadAllText(`$target); exit 41 } catch { exit 0 }"))
    $process = Start-Process -FilePath 'pwsh' -Credential $credential -ArgumentList "-NoProfile -NonInteractive -EncodedCommand $readCommand" -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Unprivileged read probe returned $($process.ExitCode)" }
    $junction = Join-Path $ProtectedRoot 'unprivileged-junction'
    $target = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($junction))
    $junctionCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$target')); try { New-Item -ItemType Junction -Path `$target -Target `$env:TEMP -ErrorAction Stop | Out-Null; exit 42 } catch { exit 0 }"))
    $process = Start-Process -FilePath 'pwsh' -Credential $credential -ArgumentList "-NoProfile -NonInteractive -EncodedCommand $junctionCommand" -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Unprivileged parent reparse probe returned $($process.ExitCode)" }
  } finally {
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
  Invoke-RequiredTest 'unprivileged-read-and-parent-write-denied' { Test-UnprivilegedIdentity $file $root }
} catch {
  $failure = $_
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
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
