# TopMart Print Agent

Windows kompyuterda ishlaydigan avtomatik etiketka chop etish dasturi.

## Qanday ishlaydi

```
Partiya yaratildi
     ↓
Bot PNG etiketka chiqaradi (Railway)
     ↓
Print Agent Telegram'dan qabul qiladi (Windows PC)
     ↓
Printer avtomatik bosadi 🖨️
```

## O'rnatish

### 1. Chat ID olish

Telegram'da botga `/start` yozing.
Bot chat ID raqamini ko'rsatadi.

### 2. config.py ni sozlash

```python
TELEGRAM_BOT_TOKEN = "1234567890:AAFxxxxx"   # bot tokeni
ALLOWED_CHAT_IDS   = [123456789]              # ruxsat berilgan chat ID lar
PRINTER_NAME       = "EPSON TM-T88V"         # bo'sh qolsa default printer
```

### 3. O'rnatish va ishga tushirish

```
install.bat  # bir marta ishlatiladi
run.bat      # har safar ishga tushirish uchun
```

## Avtomatik ishga tushirish (Windows startup)

1. `Win + R` → `shell:startup`
2. `run.bat` faylining shortcut ini oching papkaga tashlang

## Tavsiya etilgan printerlar

- Epson TM seriyasi (termal)
- Zebra ZD seriyasi
- Istalgan WiFi printer (AirPrint)
