@echo off
chcp 65001 >nul
title Workbench Launcher
cd /d F:\AllWorkSpace\workbench

REM ===== kill leftover process holding port 3180 (if any) =====
for /f "tokens=5" %%a in ('%SystemRoot%\System32\netstat.exe -ano ^| %SystemRoot%\System32\findstr.exe ":3180" ^| %SystemRoot%\System32\findstr.exe "LISTENING"') do (
    %SystemRoot%\System32\taskkill.exe /f /pid %%a >nul 2>&1
)

echo Starting Workbench in the background ...
echo.

REM ===== launch node server in a hidden window (VBScript) =====
set "VBS=%TEMP%\workbench-start-hidden.vbs"
>  "%VBS%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%VBS%" echo WshShell.Run "cmd /c ""C:\Users\11544\AppData\Local\hermes\node\node.exe"" server.js > workbench.log 2>&1", 0, False
%SystemRoot%\System32\wscript.exe "%VBS%"

REM ===== wait until port 3180 is listening (up to ~40 seconds) =====
set /a tries=0
:wait
set /a tries+=1
%SystemRoot%\System32\ping.exe -n 2 127.0.0.1 >nul
%SystemRoot%\System32\netstat.exe -ano | %SystemRoot%\System32\findstr.exe ":3180" | %SystemRoot%\System32\findstr.exe "LISTENING" >nul && goto up
if %tries% LSS 20 goto wait
echo.
echo WARNING: port 3180 did not come up within 40 seconds.
echo Check the log: F:\AllWorkSpace\workbench\workbench.log
goto done

:up
echo.
echo Workbench is ready: http://127.0.0.1:3180
start "" http://127.0.0.1:3180

:done
echo.
echo The workbench is running in the background.
echo You can close this window now.
echo.
pause
