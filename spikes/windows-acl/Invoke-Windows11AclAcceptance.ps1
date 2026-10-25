param(
  [string] $EvidencePath = (Join-Path (Get-Location) 'evidence/windows11-acl-evidence.json'),
  [string] $ExpectedCommit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) { throw 'Windows 11 acceptance requires a native Windows host.' }

$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
$computer = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
$caption = [string]$os.Caption
$osArchitecture = [string]$os.OSArchitecture
$processArchitecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
if ([string]::IsNullOrEmpty($processArchitecture)) { $processArchitecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
if ($caption -notmatch '^Microsoft Windows 11') { throw "Refusing device acceptance on unsupported OS: $caption" }
if ($osArchitecture -notmatch '64-bit' -or $processArchitecture -notmatch '^AMD64$') { throw "Refusing non-native Windows 11 x64 process: OS=$osArchitecture process=$processArchitecture" }

$systemDrive = [IO.Path]::GetPathRoot($env:SystemRoot).TrimEnd('\').TrimEnd(':')
$volume = Get-Volume -DriveLetter $systemDrive -ErrorAction Stop
if ([string]$volume.FileSystem -ne 'NTFS') { throw "Refusing acceptance on non-NTFS volume: $($volume.FileSystem)" }

$commit = (git rev-parse HEAD).Trim()
if (-not [string]::IsNullOrEmpty($ExpectedCommit) -and $commit -ne $ExpectedCommit) { throw "Commit SHA mismatch: expected $ExpectedCommit actual $commit" }
$deviceType = if ($computer.Model -match 'Virtual|VMware|VirtualBox|KVM|Hyper-V') { 'vm' } else { 'physical-or-unknown' }
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidencePath))) -Force | Out-Null

& pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'WindowsAclProof.Tests.ps1') -EvidencePath $EvidencePath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$evidence = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
if ($evidence.Commit -ne $commit) { throw "Evidence commit SHA mismatch: expected $commit actual $($evidence.Commit)" }
if ($evidence.Platform.Caption -notmatch '^Microsoft Windows 11' -or $evidence.Platform.OSArchitecture -notmatch '64-bit' -or $evidence.Platform.ProcessArchitecture -ne 'AMD64') { throw 'Evidence does not prove native Windows 11 x64.' }
$evidence | Add-Member -Force -NotePropertyName DeviceAcceptance -NotePropertyValue ([pscustomobject]@{ Caption = $caption; Build = [string]$os.BuildNumber; OSArchitecture = $osArchitecture; ProcessArchitecture = $processArchitecture; FileSystem = [string]$volume.FileSystem; DeviceType = $deviceType; Commit = $commit })
$evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8NoBOM
Write-Output "WINDOWS11_X64_ACCEPTANCE_PASS commit=$commit deviceType=$deviceType build=$($os.BuildNumber)"
