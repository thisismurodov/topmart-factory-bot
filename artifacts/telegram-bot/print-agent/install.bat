@echo off
echo ========================================
echo  TopMart Print Agent - O'rnatish
echo ========================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [XATO] Python topilmadi!
    echo Python.org dan yuklab o'rnating: https://python.org
    pause
    exit /b 1
)

echo [1/3] Paketlar o'rnatilmoqda...
pip install -r requirements.txt

echo.
echo [2/3] pywin32 sozlanmoqda...
python -m pywin32_postinstall -install 2>nul

echo.
echo [3/3] Tayyor!
echo.
echo Endi config.py faylini oching va:
echo   TELEGRAM_BOT_TOKEN = "tokeningiz"
echo   ALLOWED_CHAT_IDS   = [chat_id_raqam]
echo   PRINTER_NAME       = "printer nomi"
echo ni kiriting.
echo.
echo Ishga tushirish uchun: run.bat
pause
