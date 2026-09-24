@echo off
set "SHIM_DIR=%APPDATA%\open-whispr\models\npu-whisper"
set "LOG_FILE=%APPDATA%\open-whispr\logs\npu-shim.log"

timeout /t 5 /nobreak >nul

netstat -an | findstr ":8765 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 exit /b 0

echo [%date% %time%] Starting OpenWhispr NPU Whisper Shim... >> "%LOG_FILE%"
start "" /B python "%SHIM_DIR%\npu-whisper-shim.py" >> "%LOG_FILE%" 2>&1
exit /b 0
