# Run in Windows PowerShell after extracting the project.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 npm。请先安装 Node.js LTS： https://nodejs.org/' -ForegroundColor Red
    exit 1
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 Rust/Cargo。请先安装 Rust，并配置 Windows MSVC 工具链。' -ForegroundColor Yellow
    Write-Host '仅预览浏览器界面可执行：npm install; npm run dev'
    exit 1
}
Write-Host '安装 JavaScript 依赖...'
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host '启动 Tomato Reader 桌面开发版...'
npm run tauri dev
exit $LASTEXITCODE
