@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. See README.md.
  pause
  exit /b 1
)
where cargo >nul 2>nul
if errorlevel 1 (
  echo Rust MSVC and C++ Build Tools are required. See README.md.
  pause
  exit /b 1
)
call npm ci
if errorlevel 1 (
  pause
  exit /b 1
)
call npm run tauri dev
pause
