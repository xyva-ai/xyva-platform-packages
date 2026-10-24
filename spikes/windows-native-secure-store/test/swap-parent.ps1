[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Root,
  [Parameter(Mandatory = $true)] [string] $Moved,
  [Parameter(Mandatory = $true)] [string] $Outside
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'Root must exist before swap.' }
if (Test-Path -LiteralPath $Moved) { throw 'Moved path must not exist before swap.' }
if (-not (Test-Path -LiteralPath $Outside -PathType Container)) { throw 'Outside path must be an existing directory.' }
Move-Item -LiteralPath $Root -Destination $Moved -ErrorAction Stop
New-Item -ItemType Junction -Path $Root -Target $Outside -ErrorAction Stop | Out-Null
