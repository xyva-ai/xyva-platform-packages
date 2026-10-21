Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TrustedSystemSids = @('S-1-5-18', 'S-1-5-32-544') # LocalSystem and BUILTIN\Administrators: trusted OS recovery identities.
$BroadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') # Everyone, Authenticated Users, BUILTIN\Users.

function Get-CurrentSid { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

function New-AllowRule([string] $Sid, [bool] $Inherit) {
  $identity = [Security.Principal.SecurityIdentifier]::new($Sid)
  if ($Inherit) {
    return [Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
  }
  return [Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow)
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
  [IO.Directory]::CreateDirectory($Path) | Out-Null
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner([Security.Principal.SecurityIdentifier]$owner)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($owner) + $TrustedSystemSids) { $acl.AddAccessRule((New-AllowRule $sid $true)) }
  Set-Acl -LiteralPath $Path -AclObject $acl
  Assert-PrivateAcl $Path $owner | Out-Null
}

function New-PrivateFile([string] $Path, [string] $Content) {
  $owner = Get-CurrentSid
  $parent = [IO.Path]::GetDirectoryName($Path)
  if ([IO.Path]::GetFullPath($Path) -ne $Path -or (Test-Path -LiteralPath $Path) -or -not (Test-Path -LiteralPath $parent) -or ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe target path' }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner([Security.Principal.SecurityIdentifier]$owner)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($owner) + $TrustedSystemSids) { $acl.AddAccessRule((New-AllowRule $sid $false)) }
    $stream.SetAccessControl($acl)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Content); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
  } finally { $stream.Dispose() }
  Assert-PrivateAcl $Path $owner
}
