@echo off
setlocal
title Nephilim Generator
cd /d "%~dp0"

rem ====================================================================
rem  Nephilim Generator - launcher
rem  Double-click this file to start the app and open your browser.
rem  Server address: http://localhost:5173  (matches PORT in server.js)
rem  To stop: click this window and press Ctrl+C, or just close it.
rem ====================================================================

rem --- Node.js must be installed ---
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

rem --- First run only: install dependencies ---
if not exist "node_modules\" (
  echo Installing dependencies ^(first run only^) - this may take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed - see the messages above.
    pause
    exit /b 1
  )
)

rem --- Friendly heads-up if the API key is missing (non-fatal) ---
if not exist ".env" (
  echo.
  echo   Note: no .env file found. Image generation needs a Gemini API key -
  echo   copy .env.example to .env and paste your key. See README.md.
  echo.
)

rem --- Open the default browser once the server port is accepting connections ---
start "" /b powershell -NoProfile -Command "$p=5173; for($i=0;$i -lt 60;$i++){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',$p); $c.Close(); Start-Process ('http://localhost:'+$p); break } catch { Start-Sleep -Milliseconds 500 } }"

echo.
echo   Starting Nephilim Generator... your browser will open when it's ready.
echo   Keep this window open while you use the app. Press Ctrl+C here to stop.
echo.

npm start

endlocal
