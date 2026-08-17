# R-D FINAL — IJRO OLDI PREVIEW (2026-08-17)

**Asos:** FINAL MASTER PROMPT (`attached_assets/Pasted--TOPMART-ERP-FINAL-MASTER-PROMPT-PHYSICAL-INVENTORY-RES_1786957768116.txt`) — egasining yakuniy tasnif va EXACT qarorlari.
**Skript:** `scripts/sql/r-d-8cont-execution-2026-08-17.sql` (529 qator, arxitektor tuzatishi bilan yakuniy)
**sha256 (yakuniy):** `dc4b5517040e8c57a7f0abba0505502289e088a1e1c056e1cb1ef17e22836028`
**Holat:** BARCHA §22 TEKSHIRUVLARI PASS — prod ijro FAQAT «R-D FINAL GO» dan keyin.

---

## 1. §22 REKONSILIATSIYA NAZORATI (1–8)

| № | Talab | Natija | Dalil |
|---|-------|--------|-------|
| 1 | Final context ↔ frozen R-B registri | ✅ PASS | 92 MAPPED + 2 EXACT pozitsiya registrda pin-mos; §7 dona/kg raqamlari registr bilan bayt-teng (C-16: 55 200/2 520/3 360 dona; C-17: 9 pozitsiya 65 280 dona) |
| 2 | Final execution preview | ✅ USHBU HUJJAT | — |
| 3 | 94 TM item + 2 EXACT | ✅ PASS | items=94 (`TM-\d{6}` format 94/94); EXACT: products.id=46 `ROSSIYATROS`, id=108 `SHROKI-3-5-OQ` — katalogda mavjud va aktiv |
| 4 | 97 fizik pozitsiya | ✅ PASS | 95 MAPPED + 2 EXCLUDED_EXACT_CANDIDATE = 97; jami 71 862,20 kg / 126 360 dona |
| 5 | Barcha tasniflar | ✅ PASS | 6 RAW (3 tasi C-15da yuklangan-raw ✓) + 3 PRE-FINISHED + qolgani FINISHED; nomlar items.display_name bilan bayt-teng (GATE0.12c) |
| 6 | C-15 allaqachon LOADED | ✅ PASS | id=9, wid=21, 3 satr / 13 020,00 kg / 3 BASELINE, product_type='raw'; skript C-15ga yozmaydi (GATE0.7b–d + 9.7) |
| 7 | C-16/C-17 legacy reset | ✅ TAYYOR | 13 satr jonli=pin=R-A arxiv bayt-mos tekshirildi; nollash auditli BASELINE bilan, DELETE yo'q |
| 8 | Yakuniy jami | ✅ TAYYOR | 71 862,20 kg / 126 360 dona — skript 9.6 MUSTAQIL qayta hisob: SUM(inventar) ↔ SUM(registr 97 pozitsiya) ↔ literal (§16 talabi: natija hard-code isbot emas) |
| 9 | Arxitektor tekshiruvi | ✅ PASS (1 topilma tuzatildi) | §7 |
| 10 | Mashq (rehearsal) | ✅ PASS (a2/qulf/b/c) | §7 |
| 11 | PASS/FAIL hisobot | ✅ chatda berildi | — |

---

## 2. YAKUNIY TASNIF (egasi §21 — o'zgartirilmaydi)

**RAW (6):** TM-000018 Passport Xom BCF (C-19) · TM-000061 Polipropilen CF 1500D Qora (C-04) · TM-000062 Polipropilen CF 1000D Yashil (C-04) · TM-000092/93/94 (C-15, allaqachon raw-LOADED — tegilmaydi)
**PRE-FINISHED (3):** TM-000005 FDY Igna Strupa (C-20) · TM-000016 Qop ip Yashil (C-19) · TM-000017 Qop ip Qizil (C-19)
**FINISHED (88):** qolgan 86 TM pozitsiya + 2 EXACT. TM-000022 ikkala lokatsiyada (C-19 168,60 kg + C-04 261,20 kg) — finished.

Yangi yuklama kesimi: raw 4 916,00 kg · pre-finished 7 544,90 kg · finished 46 381,30 kg (shu jumladan 2 EXACT 1 207,55 kg) = **58 842,20 kg** (92 TM 57 634,65 + 2 EXACT 1 207,55).

---

## 3. EXACT REKONSILIATSIYASI (egasi §5/§15 — dublikatsiz isbot)

| Tekshiruv | Rossiya Tros | Shroki 3.5 Oq |
|---|---|---|
| Mavjud katalog mahsuloti | products.id=46, sku=`ROSSIYATROS`, aktiv | products.id=108, sku=`SHROKI-3-5-OQ`, aktiv |
| Joriy inventar balansi (barcha omborlar) | **0 satr** | **0 satr** |
| R-A arxivda | **0 satr** | **0 satr** |
| Harakatlar tarixida | **0 satr** | **0 satr** |
| Double-count xavfi | **YO'Q** | **YO'Q** |
| Qaror | Fizik 531,00 kg → C-18, mavjud nomga biriktiriladi, yangi SKU YO'Q, item_id=NULL | Fizik 676,55 kg → C-02, xuddi shunday |

**Muhim farqlash:** Namangan Markaziy Omborda «Shroki 3.5» (products.id=71, sku=`shrk35`) −125 satri bor — bu **BOSHQA mahsulot** (3.5 sm lenta «Oq» varianti emas), 2026-06-25 savdo dekrementi izi. R-D unga TEGMAYDI (GATE0.14c faqat aynan 'Rossiya Tros'/'Shroki 3.5 Oq' nomlarini tekshiradi). Savdo tarixidagi «Rossiya Tros» (136 kg, 1 marta) o'z holicha qoladi — tarix daxlsiz.

Registr pozitsiyalari (pos=40, pos=61) muzlatilgan holicha `EXCLUDED_EXACT_CANDIDATE` bo'lib qoladi (R-B himoyasi §13; trigger ham o'zgartirishga yo'l qo'ymaydi) — yuklash harakatining `reference` maydoni pozitsiyaga va katalog id'ga ishora qiladi.

---

## 4. KUTILGAN YAKUNIY HOLAT

| Ko'rsatkich | Oldin | Keyin |
|---|---|---|
| inventory satrlari | 46 | **140** (+92 TM, +2 EXACT) |
| stock_movements | 623 | **730** (+94 yuklash, +13 nollash) |
| BASELINE harakatlar | 3 | **110** |
| physical_baselines LOADED | 1 (C-15) | **9/9** |
| 9 joy jami | 13 020,00 kg | **71 862,20 kg / 126 360 dona** |
| sales / sale_items | 45 / 143 | 45 / 143 (daxlsiz) |
| legacy arxiv / items / registr | 43 / 94 / 97 | 43 / 94 / 97 (daxlsiz) |

Konteyner-kesim (satrlar / kg / dona): C-20 10/10 136,45/0 · C-19 13/8 713,30/0 · C-18 **29/9 839,45**/0 (28 TM + Rossiya Tros) · C-02 **10/6 053,00**/0 (9 TM + Shroki 3.5 Oq) · C-04 7/6 363,30/0 · C-06 13/7 435,50/0 · C-16 6/7 045,20/61 080 (3 yangi + 3 legacy@0) · C-17 19/3 256,00/65 280 (9 yangi + 10 legacy@0) · C-15 3/13 020,00/0 (daxlsiz).

---

## 5. OGOHLANTIRISHLAR (ijroga to'siq emas, keyingi bosqich uchun)

1. **`pre-finished` UI ko'rinishi:** DB'da product_type uchun CHECK yo'q — qiymat bemalol saqlanadi. Lekin ba'zi mavjud panellar tenglik filtri ishlatadi (ombor «tayyor konteyner» paneli `product_type='finished'`, xom-ashyo paneli `='raw'` + `purpose='raw'`); dashboard badge esa raw bo'lmaganini «Tayyor» deb ko'rsatadi. Ya'ni pre-finished va konteynerdagi raw satrlar ayrim ro'yxatlarda ko'rinmasligi/«Tayyor» ko'rinishi mumkin. §17–18 bo'yicha bu KEYINGI dashboard bosqichi ishi — R-D faqat ma'lumot yuklaydi.
2. **Savdo yo'li nom-asosli** (product_type filtrisiz) — pre-finished mahsulotni sotish inventarni to'g'ri kamaytiradi (egasi talabi: Qop ip Yashil/Qizil sotilishi mumkin).
3. **Pinlar preview-payt holatiga bog'langan** (inventory=46, movements=623, sales=45/143). FINAL GO'gacha zavodda amaliyot (savdo/kirim) bo'lsa — GATE-0 ataylab STOP qiladi; qayta-pin siklidan o'tamiz. Bu xato emas, himoya.
4. **Qulf qamrovi (arxitektor topilmasi asosida kengaytirildi):** sales, sale_items, raw_materials ham tranzaksiya boshida SHARE ROW EXCLUSIVE qulflanadi — ijro davomida (bir necha soniya) parallel savdo yozuvi kutib turadi; evaziga «daxlsizlar o'zgarmadi» da'vosi commit paytida haqiqiy bo'ladi.

---

## 6. IJRO REJASI (FINAL GO'dan keyin, §19)

1. ~~Arxitektor tekshiruvi~~ → §7
2. ~~Mashq: throwaway DB (yangi dumpdan)~~ → §7 — (a) buzilgan-satr testi → NOLLASH-MISMATCH STOP + 0 yozuv; (b) to'liq o'tish → PASS; (c) takror ijro → LATCH blok
3. Yangi prod backup: `backups/pre-r-d-8cont-2026-08-17.dump` + tekshiruv (shart 13)
4. Prod ijro (bitta tranzaksiya, `\set ON_ERROR_STOP on`)
5. Mustaqil read-only post-verify (alohida sessiya, `default_transaction_read_only=on`)
6. Yakuniy hisobot: `docs/r-d-final-execution-report-2026-08-17.md`

## 7. ARXITEKTOR + MASHQ NATIJALARI (2026-08-17)

**Arxitektor (mustaqil ko'rib chiqish):** 1 kritik topilma — sales/sale_items/raw_materials qulf ro'yxatida yo'q edi (REPEATABLE READ ostida parallel yozuv 9.9 da'vosini yolg'on qilishi mumkin edi). **Tuzatildi** (qulf ro'yxati kengaytirildi, yakuniy sha256 yuqorida). Qolgan barcha savollar tasdiqlandi: EXACT UNIQUE-xavfsizligi (GATE0.14c global 0-satr + inventory qulfi), 9.12b FULL JOIN to'g'ri, 9.4 legacy weight_kg=0 yig'indini buzmaydi, rd_class COALESCE to'g'ri (sku PK), nollash loopi poygasiz, arifmetika to'liq mos (107/730/110/140, 71 862,20 / 126 360). Preview'dagi kesim arifmetikasi xatosi ham tuzatildi (58 842,20 kg).

**Mashq (throwaway DB, yangi dumpdan, C-15 LOADED holatda):**
- **(a2) Buzilgan-satr testi:** inventar id=104 ataylab buzildi (100→101) → `GATE0.10: 13 legacy pin mos emas` → exit=3, **0 yozuv** (46/623/3, 8 MAPPED, 1 LOADED saqlandi) ✅
- **Qulf-blok isboti:** skript qulflari ostida parallel sales yozuvi `lock timeout` bilan kutib qoldi — daxlsizlik da'vosi commit paytida haqiqiy ✅
- **(b) To'liq o'tish:** COMMIT; inv=140, mov=730, BASELINE=110, 9/9 LOADED; jami **71 862,20 kg = registr 71 862,20 kg** (mustaqil qayta hisob) / **126 360 dona**; EXACT 2 satr joyida; 13 legacy satr qty=0; tasnif 3 raw / 3 pre-finished / 88 finished; sales 45/143, arxiv 43, items 94 — daxlsiz ✅
- **(c) Takror-GO bloki:** ikkinchi/uchinchi ijro `GATE0.2c` bilan bloklandi, holat o'zgarmadi ✅

**Qo'shimcha topilma (himoyani kuchaytiradi):** `legacy.inventory_baseline_pre` APPEND-ONLY trigger bilan qo'riqlanadi (`legacy.no_touch_fn`) — arxivni UPDATE qilib bo'lmaydi; demak jonli≠arxiv nomuvofiqligi faqat inventar buzilishidan kelib chiqishi mumkin, GATE0.10 buni ushlaydi.

---

**STOP shartlari (§20)** skriptda GATE0.1–0.14, LATCH, NOLLASH-MISMATCH va 9.1–9.13 sifatida kodlangan: SKU/nom/miqdor/og'irlik nomuvofiqligi, dublikat, EXACT isbotsizligi, arxiv/registr/C-15/sales o'zgarishi, kutilmagan satr/harakat, tasnif nomuvofiqligi, jami nomuvofiqlik, konkurensiya — har biri EXCEPTION → to'liq ROLLBACK.

**Biz taxmin qilmaymiz. Biz bilamiz.**
