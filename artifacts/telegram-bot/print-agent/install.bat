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
echo Majburiy Windows environment sozlamalari:
echo   TELEGRAM_BOT_TOKEN
echo   ALLOWED_CHAT_IDS            ^(masalan: 123456789,987654321^)
echo   PRINTER_NAME                ^(Windows'dagi aynan printer nomi^)
echo   API_BASE_URL                ^(oxirida /api^)
echo   VEHICLE_DISTRIBUTION_BOT_KEY
echo   PRINT_AGENT_ID              ^(masalan: ombor-label-1^)
echo.
echo Ularni setx orqali o'rnating. Birortasi bo'sh bo'lsa agent ishga tushmaydi.
echo.
echo Ishga tushirish uchun: run.bat
pause
