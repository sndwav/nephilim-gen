@echo off
setlocal
title Nephilim Generator - Update
cd /d "%~dp0"

rem ====================================================================
rem  Nephilim Generator - updater
rem  Double-click this file to pull the latest version from GitHub and
rem  refresh dependencies. Your data folder (presets, images, exports)
rem  is NOT touched - Git ignores it and it stays on your machine.
rem  When it finishes, launch with "Start Nephilim Generator.bat".
rem ====================================================================

rem --- Git must be installed ---
where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Git is not installed, so this copy can't update itself.
  echo   Install Git from https://git-scm.com  then run this again -
  echo   or just re-download the latest ZIP from the GitHub page.
  echo.
  pause
  exit /b 1
)

rem --- This folder must be a Git clone (ZIP downloads have no repository) ---
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo.
  echo   This folder isn't a Git clone ^(it was probably downloaded as a ZIP^),
  echo   so there's nothing to pull from. To update, re-download the latest ZIP
  echo   from the GitHub page - or set it up once with "git clone" so future
  echo   updates are a single click. See README.md.
  echo.
  pause
  exit /b 1
)

rem --- Node.js must be installed (needed to refresh dependencies) ---
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

rem --- Pull the latest version. --ff-only never force-merges, so a diverged
rem     or locally-edited copy stops safely instead of creating a mess. ---
echo.
echo   Checking for updates from GitHub...
echo.
git pull --ff-only
if errorlevel 1 (
  echo.
  echo   Could not update automatically. Common causes:
  echo     - No internet connection.
  echo     - You edited tracked files, or your copy has diverged from GitHub.
  echo   Your data folder is safe. See the messages above for details.
  echo.
  pause
  exit /b 1
)

rem --- Refresh dependencies in case package.json changed ---
echo.
echo   Refreshing dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo   npm install failed - see the messages above.
  echo.
  pause
  exit /b 1
)

echo.
echo   Update complete. You're now on:
git log -1 --oneline
echo.
echo   Start the app by double-clicking "Start Nephilim Generator.bat".
echo.
pause

endlocal
