@echo off
title Dual PDF - close this window to stop
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo First run: installing dependencies and building, please wait...
  call npm install --include=dev
  if errorlevel 1 goto fail
  call npm run build
  if errorlevel 1 goto fail
)

node "local\start.cjs"
if errorlevel 1 pause
exit /b 0

:fail
echo.
echo Build failed. Check the errors above.
pause
exit /b 1
