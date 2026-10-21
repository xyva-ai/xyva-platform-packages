. "$PSScriptRoot/WindowsAclProof.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-poc-" + [guid]::NewGuid())

function Assert-UnsafeAllowRejected([string] $Sid, [string] $Name) {
  $candidate = Join-Path $root $Name
  New-PrivateFile $candidate 'synthetic-secret' | Out-Null
  $acl = Get-Acl -LiteralPath $candidate
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'Read', 'Allow')))
  Set-Acl -LiteralPath $candidate -AclObject $acl
  try {
    Assert-PrivateAcl $candidate (Get-CurrentSid) | Out-Null
  } catch {
    return
  }
  throw "Unsafe Allow ACE was accepted: $Sid"
}

try {
  New-PrivateDirectory $root
  $file = Join-Path $root 'secret.txt'
  $evidence = New-PrivateFile $file 'synthetic-secret'
  if ((Get-Content -LiteralPath $file -Raw) -ne 'synthetic-secret') { throw 'Authorized read failed' }
  $unsafeSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546')
  for ($index = 0; $index -lt $unsafeSids.Count; $index++) {
    Assert-UnsafeAllowRejected $unsafeSids[$index] ("unsafe-$index.txt")
  }
  Write-Output 'WINDOWS_ACL_POC_PASS'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
