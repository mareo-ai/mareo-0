# Installs the sslTrus remote signing CLI on a Windows runner.
#
# Fails fast when the signing credentials are missing: a release build without a
# signature is what we are trying to stop shipping.
$ErrorActionPreference = 'Stop'

foreach ($name in 'ACCESS_KEY', 'ACCESS_SECRET', 'SSLTRUS_CERT_CODE') {
  if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue).Value) {
    throw "$name is not configured; code signing is required for a release build"
  }
}

$index = Invoke-RestMethod 'https://pccs.ssltrus.cn/oss-code-sign-client/latest.json'
$entry = $index | Where-Object { $_.url -like '*cli/signtool-windows-amd64-*.zip' } | Select-Object -First 1
if (-not $entry) { throw 'the release index lists no Windows signing CLI' }

$zip = Join-Path $env:RUNNER_TEMP 'ssltrus-cli.zip'
Invoke-WebRequest $entry.url -OutFile $zip
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash
if ($actual -ne $entry.sha256.ToUpper()) { throw "signing CLI checksum mismatch: $actual" }

$directory = Join-Path $env:RUNNER_TEMP 'ssltrus-cli'
Expand-Archive $zip -DestinationPath $directory -Force
$exe = (Get-ChildItem $directory -Filter 'signtool*.exe' -Recurse | Select-Object -First 1).FullName
if (-not $exe) { throw 'the signing CLI executable is missing after extraction' }

# The hook reads these; the CLI shares the name of Microsoft's signtool, so the
# path is explicit rather than resolved through PATH.
Add-Content $env:GITHUB_ENV "SSLTRUS_SIGNTOOL=$exe"
Add-Content $env:GITHUB_ENV "ACCESS_KEY=$env:ACCESS_KEY"
Add-Content $env:GITHUB_ENV "ACCESS_SECRET=$env:ACCESS_SECRET"
Add-Content $env:GITHUB_ENV "SSLTRUS_CERT_CODE=$env:SSLTRUS_CERT_CODE"

Write-Host "signing CLI $($entry.version) installed at $exe"
& $exe quota --json
