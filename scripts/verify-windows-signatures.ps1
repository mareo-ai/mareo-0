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

# The code-signing certificate in use (SHA-1 thumbprint). A renewal issues a new
# one, so this fails loudly rather than letting an unexpected signer through.
$expectedThumbprint = '24F773B0CEC1D43AD42752B2050E0105A901F7DD'

foreach ($target in $targets) {
  if (-not (Test-Path $target)) { throw "$target is missing" }
  $signature = Get-AuthenticodeSignature $target
  if ($signature.Status -ne 'Valid') { throw "$target is not validly signed ($($signature.Status))" }
  if ($signature.SignerCertificate.Thumbprint -ne $expectedThumbprint) {
    throw "$target is signed by $($signature.SignerCertificate.Thumbprint), not the expected certificate; if the certificate was renewed, update `$expectedThumbprint"
  }
  Write-Host "$target -> $($signature.Status) | $($signature.SignerCertificate.Subject) | $($signature.SignerCertificate.Thumbprint)"
}

# Everything else ships with whatever signature its vendor provided — Electron
# leaves several of its DLLs unsigned, and DSH brings native modules of its own.
# Printing the state keeps that visible: a file that turns NotSigned when it used
# to be Valid is a regression worth noticing.
Get-ChildItem $appDirectory -Recurse -Include *.exe, *.dll, *.node |
  ForEach-Object {
    $vendor = Get-AuthenticodeSignature $_.FullName
    $detail = if ($vendor.SignerCertificate) { $vendor.SignerCertificate.Subject } else { $vendor.StatusMessage }
    Write-Host ("{0,-42} {1,-12} {2}" -f $_.Name, $vendor.Status, $detail)
  }
