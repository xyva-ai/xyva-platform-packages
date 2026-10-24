param(
  [Parameter(Mandatory = $true)][ValidateSet('read', 'write', 'create')][string] $Action,
  [Parameter(Mandatory = $true)][string] $Path
)

$ErrorActionPreference = 'Stop'
try {
  switch ($Action) {
    'read' { [IO.File]::ReadAllBytes($Path) | Out-Null }
    'write' { [IO.File]::AppendAllText($Path, 'x') }
    'create' { [IO.File]::WriteAllText($Path, 'x') }
  }
  throw 'XYVA_KERNEL_DENIAL_UNEXPECTED_SUCCESS'
} catch {
  if ($_.Exception.HResult -eq -2147024891) { exit 0 }
  throw ("XYVA_KERNEL_DENIAL_UNEXPECTED_HRESULT=0x{0:X8}" -f ([uint32]$_.Exception.HResult))
}
