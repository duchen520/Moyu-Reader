# Run in an x64 VS developer shell: Windows 10/11, Node.js 22+, Python 3.12+, Rust MSVC, WebView2.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
foreach ($required in @('npm', 'cargo', 'python', 'cl')) {
    if (-not (Get-Command $required -ErrorAction SilentlyContinue)) {
        Write-Host "Missing $required. See README.md for prerequisites." -ForegroundColor Red
        exit 1
    }
}
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
python scripts/prepare-kokoro-engine.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run test:unit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'Installer: src-tauri\target\release\bundle\nsis\' -ForegroundColor Green
