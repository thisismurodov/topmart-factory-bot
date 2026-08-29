---
name: Dashboard iPad/touch ergonomics
description: How the dashboard is made finger-friendly for iPad without changing the desktop (mouse) UI.
---

# Touch tweaks are gated on `@media (any-pointer: coarse)`, not `pointer: coarse`

iPad ergonomics (16px input font to kill iOS focus-zoom, ~44px tap targets, roomier
table rows) live in a single media block in `src/index.css`.

**Use `any-pointer: coarse`, never `pointer: coarse`.** `pointer:` only checks the
*primary* pointer, so an iPad with a Magic Keyboard/trackpad reports `fine` and the
touch rules silently stop applying. `any-pointer: coarse` is true whenever a coarse
(touch) pointer *exists at all* — always true on iPad, and false on a mouse-only
MacBook (so the desktop UI is untouched).

**Why:** users run the same dashboard on MacBook (mouse) and a desk iPad (touch);
the gate must turn touch ergonomics ON for iPad in both modes and OFF for MacBook.
**How to apply:** keep new touch-only CSS inside this `any-pointer: coarse` block;
the 16px font rule is required because the shared Input uses `md:text-sm` (14px),
which otherwise triggers Safari auto-zoom on focus.

## Uzun ro'yxatli tanlagichlar (2026-08-29)
Radix Select (shadcn) uzun ro'yxatni iPad'da barmoq bilan surib BO'LMAYDI — scroll up/down tugmalari hover/pressga mo'ljallangan, touch-drag ishlamaydi (ma'lum radix muammosi). Yechim: Popover (modal) + cmdk Command combobox: CommandList'ga max-h + overflow-y-auto + overscroll-contain + touch-pan-y; CommandInput'ga text-base (16px — iOS fokus zoomining oldini oladi); Dialog ICHIDA Popover'ga modal atributi shart (aks holda fokus tuzog'i qidiruv inputini bloklaydi). Qidiruv filtri o'zbek apostrof variantlarini (ʼ ' ' ` ´) normalize qilishi kerak, aks holda "o'q" qidiruvi curly-apostrofli nomni topmaydi.
**Why:** me'yor dialogidagi mahsulot Select'i iPad'da surilmay foydalanuvchini blokladi.
**How to apply:** dashboardda 20+ elementli HAR QANDAY tanlagich uchun default = qidiruvli combobox, Radix Select emas.
