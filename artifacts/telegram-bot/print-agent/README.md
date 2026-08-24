# TopMart Print Agent

Windows kompyuterda vehicle handoff passportlarini aniq sozlangan 100×80
printerga yuboradigan fail-closed agent.

## Xavfsiz oqim

1. Ruxsatli Telegram chat `/vehicle_print HANDOFF_ID` yuboradi.
2. Agent handoff holatini API orqali tekshiradi.
3. Tayyor passportlar bo'lmasa, API ularni bir marta materialize qiladi.
4. Agent API'dagi persisted barcode va original vaqt snapshotidan PDF yaratadi.
5. Har fizik unit bitta 100×80 PDF sahifa bo'ladi.
6. PDF faqat `PRINTER_NAME` dagi printerga GDI orqali spool qilinadi. Agent
   Windows driverining faol media profilini ham tekshiradi; u 100×80 mm bo'lmasa
   bosma va lifecycle tasdig'i rad etiladi. Driverning printable area qismi ham
   kamida 98×78 mm bo'lishi shart (har tomondagi jami hardware margin uchun
   ko'pi bilan 2 mm allowance).
7. Barcha sahifalar Windows spooler tomonidan qabul qilingandan keyingina API
   `printed` lifecycle tasdiqlanadi.

Default printer fallback yo'q. Ruxsatli chatlar ro'yxati bo'sh bo'lsa agent
ishga tushmaydi.

## O'rnatish

`install.bat` ni bir marta administrator sifatida ishga tushiring. Windows
printer driverida qog'ozni **100×80 mm**, orientatsiyani label dizayniga mos va
masshtabni 100% qilib sozlang.

Quyidagi environment qiymatlarning barchasi majburiy:

```bat
setx TELEGRAM_BOT_TOKEN "..."
setx ALLOWED_CHAT_IDS "123456789,987654321"
setx PRINTER_NAME "ZDesigner ZD220-203dpi ZPL"
setx API_BASE_URL "https://example.com/api"
setx VEHICLE_DISTRIBUTION_BOT_KEY "..."
```

Qiymatlarni chatga yoki logga yozmang. `setx` dan keyin yangi terminal oching va
`run.bat` ni ishga tushiring.

## Buyruqlar

- `/vehicle_print 42` — faqat `prepared` handoffning birinchi bosmasi.
- `/vehicle_reprint 42` — operator tasdiqlagan takroriy bosma. Yangi print
  session ochadi, lekin o'sha persisted barcode identityni saqlaydi.
- `/vehicle_resume 7` — printer spool muvaffaqiyatli bo'lib, API tasdig'i vaqtincha
  ishlamagan jobni **qayta bosmasdan** tasdiqlaydi.
- `/vehicle_recover 7` — agent/Windows crashidan keyin `printing` yoki
  `ambiguous` qolgan jobning **barcha fizik sahifalari chiqqanini operator
  tekshirgach**, qayta bosmasdan lifecycle'ni tasdiqlaydi.
- `/vehicle_retry 7` — noaniq job sahifalari to'liq chiqmagan bo'lsa, eski jobni
  operator qarori bilan yopib, to'liq PDFni yangidan bosadi. Bu fizik
  at-least-once reprint bo'lishi mumkin.

Bir Telegram xabari qayta yetkazilsa deterministic operation key va lokal
`print_jobs.sqlite3` sababli qayta bosilmaydi. Spool natijasi noaniq bo'lsa agent
avtomatik reprint yoki lifecycle confirm qilmaydi. SQLite active-handoff unique
claim bir xil DBdan foydalanuvchi ikki agent processining parallel bosishini ham
bloklaydi.

Legacy `🏷️`/`Partiya` captionli rasmlar ham faqat `ALLOWED_CHAT_IDS` ichidagi
chatlardan va aynan `PRINTER_NAME` printeriga yuboriladi.

## Avtomatik ishga tushirish

1. `Win + R` → `shell:startup`
2. `run.bat` shortcutini ochilgan papkaga qo'ying.
