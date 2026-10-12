# Proves the two artifacts users receive actually carry our signature.
#
# @electron/packager swallows signing failures (it debugs and packs anyway), so
# this step is what turns a failed signature into a failed build.
$ErrorActionPreference = 'Stop'

$appDirectory = 'out/Mareo-win32-x64'
$targets = @(
  "$appDirectory/Mareo.exe",
  'out/make/squirrel.windows/x64/MareoSetup.exe'
)

foreach ($target in $targets) {
  if (-not (Test-Path $target)) { throw "$target is missing" }
  $signature = Get-AuthenticodeSignature $target
  if ($signature.Status -ne 'Valid') { throw "$target is not validly signed ($($signature.Status))" }
  Write-Host "$target -> $($signature.Status) | $($signature.SignerCertificate.Subject) | $($signature.SignerCertificate.Thumbprint)"
}

# Everything else ships with the signature its vendor provided. Printing it keeps
# that assumption visible: if a file ever shows up NotSigned, it belongs in the
# sign list instead.
Get-ChildItem $appDirectory -Recurse -Include *.exe, *.dll, *.node |
  ForEach-Object {
    $vendor = Get-AuthenticodeSignature $_.FullName
    Write-Host ("{0,-42} {1,-12} {2}" -f $_.Name, $vendor.Status, $vendor.SignerCertificate.Subject)
  }
