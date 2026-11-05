param(
  [Parameter(Mandatory = $true)][string] $Root,
  [Parameter(Mandatory = $true)][string] $Moved,
  [Parameter(Mandatory = $true)][string] $Outside
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'XYVA_SWAP_ROOT_MISSING' }
if (Test-Path -LiteralPath $Moved) { throw 'XYVA_SWAP_DESTINATION_EXISTS' }
if (-not (Test-Path -LiteralPath $Outside -PathType Container)) { throw 'XYVA_SWAP_OUTSIDE_MISSING' }

Move-Item -LiteralPath $Root -Destination $Moved
if (-not (Test-Path -LiteralPath $Moved -PathType Container)) { throw 'XYVA_SWAP_MOVE_FAILED' }
New-Item -ItemType Junction -Path $Root -Target $Outside | Out-Null

$junction = Get-Item -LiteralPath $Root -Force
if (($junction.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'XYVA_SWAP_NOT_REPARSE_POINT' }
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'XYVA_SWAP_JUNCTION_MISSING' }
Write-Output 'XYVA_PARENT_SWAP_OK'
