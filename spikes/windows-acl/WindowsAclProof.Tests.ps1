. "$PSScriptRoot/WindowsAclProof.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("xyva-acl-poc-" + [guid]::NewGuid())
try {
  New-PrivateDirectory $root
  $file = Join-Path $root 'secret.txt'
  $evidence = New-PrivateFile $file 'synthetic-secret'
  if ((Get-Content -LiteralPath $file -Raw) -ne 'synthetic-secret') { throw 'Authorized read failed' }
  foreach ($sid in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')) {
    $acl = Get-Acl -LiteralPath $file
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'Read', 'Allow')))
    Set-Acl -LiteralPath $file -AclObject $acl
    try { Assert-PrivateAcl $file (Get-CurrentSid); throw "Broad SID was accepted: $sid" } catch { if ($_.Exception.Message -eq "Broad SID was accepted: $sid") { throw } }
  }
  Write-Output 'WINDOWS_ACL_POC_PASS'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
