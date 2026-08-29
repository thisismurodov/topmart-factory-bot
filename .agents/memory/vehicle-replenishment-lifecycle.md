---
name: Vehicle replenishment lifecycle
description: Locking and stock-mutation boundaries for exact-pilot replenishment.
---

Replenishment targets and requests never mutate vehicle inventory. A low-stock request is fully approved into one existing F3 prepared handoff, and only that handoff's final `stock_transferred` transaction may fulfill the request and increase vehicle stock.

**Why:** Partial approval can leave stock below minimum without an open request, and a separate replenishment writer would bypass label identity and F6 stale detection. Locking a request before its warehouse parent can deadlock with F7 auto-request creation.

**How to apply:** Use whole labeled units, lock source and vehicle warehouse parents in deterministic order before request/handoff/inventory rows, require full requested quantity, and keep one pending/approved request per vehicle and canonical product. F7 auto-request creation relies on the open-request partial unique conflict and does not add a late advisory lock.
## Me'yor tarixi kunlik granulyar (F8)
vehicle_stock_targets sana-versiyalangan (faol qator effective_to IS NULL). Xuddi shu kunga ikkinchi PUT ataylab 409 "overlaps current history" — in-place update operation-key replay imzosini buzar edi. Toraytirish keyingi kundan amal qiladi; testda "kecha qo'yilgan me'yor" kerak bo'lsa effective_from'ni SQL bilan CURRENT_DATE-1 ga backdate qilinadi (F11 replay testi shunday). Cap o'qish sana-filtrlangan (effective_from<=CURRENT_DATE AND (effective_to IS NULL OR >=CURRENT_DATE)) — ertaga boshlanadigan me'yor bugungi yuklashga ta'sir qilmaydi.
