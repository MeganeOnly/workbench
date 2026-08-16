@echo off
setlocal
rem ============================================================
rem  Anki smart launcher
rem  - Anki not running -> start via Start Menu shortcut
rem  - Anki running    -> activate its window to foreground
rem  Called by workbench Anki button (cmd /c call this file).
rem  IMPORTANT: keep this file pure ASCII. cmd.exe reads batch
rem  files in the system OEM codepage; non-ASCII bytes corrupt
rem  line parsing and can hang the command.
rem ============================================================

tasklist /FI "IMAGENAME eq anki.exe" 2>nul | findstr /I /C:"anki.exe" >nul
if %errorlevel%==0 goto activate

:launch
rem Anki not running: start via Start Menu shortcut
start "" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Anki.lnk"
goto done

:activate
rem Anki running: delegate to the shared smart launcher (restore + foreground)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch-app.ps1" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Anki.lnk"
goto done

:done
exit /b 0
