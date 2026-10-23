[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Link,
  [Parameter(Mandatory = $true)] [string] $Target
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Link) { throw 'Junction link path must not already exist.' }
if (-not (Test-Path -LiteralPath $Target -PathType Container)) { throw 'Junction target must be an existing directory.' }
New-Item -ItemType Junction -Path $Link -Target $Target -ErrorAction Stop | Out-Null
