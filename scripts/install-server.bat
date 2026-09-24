@echo off
rem ============================================================================
rem  hitOpt server installer -- LAUNCHER ONLY, deliberately ASCII-ONLY.
rem
rem  Why ASCII-only (2026-09-25; the user reported the window was full of
rem  gibberish plus "is not recognized as an internal or external command"):
rem  a .bat that contains non-ASCII text AND a "chcp 65001" line gets mis-read by
rem  cmd. Changing the console code page makes cmd re-seek the script by CHARACTER
rem  count, which no longer matches the BYTE offset, so it resumes reading in the
rem  middle of a line and tries to execute the fragment -- e.g. "gins" (the tail
rem  of "plugins") was run as a command. It LOOKED like a total failure while the
rem  install had actually succeeded: the worst possible outcome.
rem
rem  So: this file only switches the code page, locates node, and calls
rem  install-server.mjs next to it. All logic and all Chinese output live there;
rem  node writes UTF-8, which is exactly what "chcp 65001" tells the console to
rem  expect. Pure ASCII cannot be mis-decoded under any console code page.
rem ============================================================================

chcp 65001 >nul
setlocal
title hitOpt server installer
set "RC=0"

where node >nul 2>nul
if not errorlevel 1 goto :run

rem -- node not on PATH ------------------------------------------------------
set "RC=1"
echo.
echo   Node.js was not found in PATH.
echo.
echo   SillyTavern is itself a Node app, so node is normally available.
echo   Open a terminal in this folder and run:
echo.
echo       node install-server.mjs "PATH_TO_YOUR_SILLYTAVERN"
echo.
echo   Or copy the two files by hand:
echo       server\index.mjs    -^> ^<tavern^>\plugins\hitopt-git\index.mjs
echo       server\wiretap.mjs  -^> ^<tavern^>\plugins\hitopt-git\wiretap.mjs
echo.
goto :end

:run
node "%~dp0install-server.mjs" %*
set "RC=%ERRORLEVEL%"

:end
echo.
pause
endlocal & exit /b %RC%
