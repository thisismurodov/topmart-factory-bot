# R-C YAKUNIY PREVIEW — EGASI TASDIG'I UCHUN (2026-08-17)

*Holat: **R-C GO KUTILMOQDA — bazaga HECH NARSA yozilmadi** (bu turda ham faqat SELECT: `admin_users`, `user_roles`, `items`/`stock_movements` katalog tekshiruvlari) · **`created_by` TASDIQLANDI: `thisismurodov` (egasi tanlovi, 2026-08-17) — preview YAKUNIY, ochiq katak qolmadi** · Asos: egasining «R-C PREPARATION — DECISIONS» xabari (2026-08-17) · Manba jadval: `docs/r-c-dry-run-2026-08-17.md` §3 (SKU/nom/birlik/sanoq/joy O'ZGARMAGAN) · Muzlatilgan sanoq hujjatlari: `physical-count-reconciliation-2026-08-15.md`, `physical-count-c16-c17-2026-08-15.md`, `physical-count-c15-2026-08-16.md`*

---

## 1. Egasi qarorlari (2026-08-17) va ularning aks etishi

| № | Qaror | Bu hujjatda |
|---|---|---|
| 1 | 2 EXACT (Rossiya Tros 531 kg, Shroki 3.5 Oq 676.55 kg) avto-mapping QILINMASIN — alohida kandidat | §5 — R-C ko'lamidan CHIQARILDI; mapping ham, TM-000095/096 ham yo'q |
| 2 | `created_by` uchun mavjud admin/user variantlari ko'rsatilsin, taxmin yo'q | §3 — jonli bazadan to'liq ro'yxat; **egasi tanladi: `thisismurodov` (2026-08-17)** |
| 3 | Final classification R-C'da qotirilmasin; faqat nom/SKU/birlik/sanoq/joy saqlansin | §4 — barcha 94 item NEYTRAL INSERT (bayroqlar yozilmaydi), sanoq+joy `note`da |
| 4 | 97 pozitsiya → item_id bog'lash R-B registridan OLDIN bajarilmasin | §2 — R-C ko'lamidan chiqarildi, R-B'dan keyinga |
| 5 | R-D boshlanmasin, hech qanday eski qoldiq nollanmasin | §2 — R-D muzlatilgan; 13 legacy qator va 43 inventar satriga tegilmaydi |
| 6 | BASELINE/weight_kg/reference/reason — faqat dry-run/DDL taklif, prod yozuv YO'Q | §6 — DDL taklif sifatida; kod diffi ham GO'gacha qo'llanmaydi (sabab ichida) |
| 7 | Yakuniy preview: 94 item + 2 EXACT + SKU + created_by + birlik + joy + sanoq + jamlar | Shu hujjat to'liq |

## 2. R-C GO qisqartirilgan ko'lami

**Bajaradi (bitta tranzaksiya, oldin/keyin tekshiruv):**
1. §6 DDL (BASELINE + 3 ustun) — jonli baza + bot `init_db` + API `initDb`/Drizzle lockstep;
2. **94 NEYTRAL INSERT** (§4): faqat `sku, display_name, unit, source_kind='physical_count', note, created_by`. Bayroqlar YOZILMAYDI → DB defaultlari: `is_raw…is_sellable = FALSE` (barchasi), `inventory_tracked = TRUE` (DB default; klassifikatsiya emas — operatsion bayroq; xohlasangiz FALSE bilan boshlaymiz), `active = TRUE`, `source_id = NULL`, `created_at = now()`. Birinchi item `id=2` oladi (P2.1 smoke-testi 1 ni sarflagan).

**Bajarmaydi:**
- ❌ 2 EXACT bo'yicha hech narsa (№1 ochiq — kandidat maqomida, §5);
- ❌ pozitsiya → item_id bog'lash (faqat R-B registri GO bo'lgach);
- ❌ R-D: nollash YO'Q, inventarga yuklash YO'Q, 13 legacy qatorga tegilmaydi;
- ❌ alias, narx, BOM, klassifikatsiya bayroqlari — hammasi dashboard-era (egasi belgilaydi).

## 3. `created_by` — TASDIQLANGAN: `thisismurodov` (egasi qarori, 2026-08-17)

**Fakt (jonli katalog):** `items.created_by` — `TEXT NOT NULL`, **FK YO'Q** — istalgan matn identifikator qabul qilinadi; DB darajasida userga bog'lanish talab etilmaydi.

**Dashboard adminlari (`public.admin_users`) — 1 ta:**

| id | username | rol | yaratilgan |
|---|---|---|---|
| 1 | `thisismurodov` | admin | 2026-06-04 |

**ERP bot foydalanuvchilari (`public.user_roles`) — 24 ta:** `Superadmin` (admin, chat_id 1261052681) · 10 packer (Dilnozaxon, Diyorbek, Gulhumor, Ibrohimjon, IMONAXON, Madina M, Manager, Shahriyor, Shakhzod, исломхон) · 13 worker (Hilolaxon, Husniddin, Madina, Matluba, Muhammad Yusuf Nasvaliyev, Munira, Muxtasarxon, Namunaxon, Orzigul Ro'zmatova, Sarvarbek, Shalola, Zuhraxon, Zulxumor).

**Bazadagi mavjud `created_by` konvensiyalari (`stock_movements`):** ishchi ismlari (Risolat 142, Aziza 141, Gullola 134, Shohida 127, Husnida 16, Muxtasarxon 2) · `system` 37 · `admin` 20 · `thisismurodov` 1.

**Ko'rsatilgan variantlar:** (a) `thisismurodov` — yagona dashboard admin; (b) `system`; (c) `admin`; (d) `Superadmin`; (e) boshqa istalgan matn. **EGASI QARORI (2026-08-17, «CREATED_BY CONFIRMED»): barcha 94 INSERT `created_by = 'thisismurodov'` bilan ketadi — INSERT shabloni yakunlandi (§4).** Eslatma: №6 savolning `counted_by`/R-D qismi alohida ochiq — bu tanlov faqat R-C itemlari uchun.

## 4. 94 item — yakuniy INSERT preview

**`note` (provenans) formati** — №3 qaror bo'yicha sanoq fakti item satrining o'zida saqlanadi:
- kg: `Sanoq 2026-08-15 · C-20 · 80 kg`
- dona: `Sanoq 2026-08-15 · C-16 · 55 200 dona (6 348.00 kg)`
- 2-joyli TM-000022: `Sanoq 2026-08-15 · C-19 168.6 kg + C-04 261.2 kg = 429.8 kg`
- C-15 (sanoq 2026-08-16): `Sanoq 2026-08-16 · C-15 · 3 720.00 kg`

**INSERT shabloni (YAKUNIY — `created_by = 'thisismurodov'`, egasi tasdiqlagan):**

```sql
INSERT INTO items (sku, display_name, unit, source_kind, note, created_by) VALUES
  ('TM-000001', 'Neylon 210D / 45', 'kg', 'physical_count',
   'Sanoq 2026-08-15 · C-20 · 80 kg', 'thisismurodov'),
  -- ... jami 94 qator, quyidagi jadval bo'yicha
;
-- Bayroqlar atayin YOZILMAYDI (№3 qaror) → DB defaultlari ishlaydi.
```

**To'liq jadval** (SKU tartibi `docs/inventory-reset-dry-run-report.md` §4 bilan aynan; «Tavsiya» ustuni OLIB TASHLANDI — №3 qaror, klassifikatsiya dashboardda):

| SKU | Nom (aynan) | Birlik | Real sanoq | Joy |
|---|---|---|---|---|
| TM-000001 | Neylon 210D / 45 | kg | 80 | C-20 |
| TM-000002 | Neylon 210D / 60 | kg | 1 474 | C-20 |
| TM-000003 | Neylon 210D / 90 | kg | 330 | C-20 |
| TM-000004 | Toshkent Oq 14 mm — Bir qavat | kg | 942.05 | C-20 |
| TM-000005 | FDY Igna Strupa | kg | 4 572.25 | C-20 |
| TM-000006 | Toshkent Qora 14 mm Ichki Sariq | kg | 636.25 | C-20 |
| TM-000007 | 16 mm Alpinist | kg | 520 | C-20 |
| TM-000008 | 14 mm Alpinist | kg | 930 | C-20 |
| TM-000009 | Toshkent Qora 14 mm Ichi Oq PP TWS | kg | 309.6 | C-20 |
| TM-000010 | Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr | kg | 342.3 | C-20 |
| TM-000011 | Polyamide 144 oq TWS | kg | 552.9 | C-19 |
| TM-000012 | Polyamide Ko‘k 187 TWS | kg | 94.05 | C-19 |
| TM-000013 | Polyamide Qizil 187 TWS | kg | 73.65 | C-19 |
| TM-000014 | Polyamide Sariq 187 TWS | kg | 44.6 | C-19 |
| TM-000015 | Polyamide Oq 187 TWS | kg | 132.15 | C-19 |
| TM-000016 | Qop ip Yashil | kg | 2 244.1 | C-19 |
| TM-000017 | Qop ip Qizil | kg | 728.55 | C-19 |
| TM-000018 | Passport Xom BCF | kg | 646 | C-19 |
| TM-000019 | Yashil PP TWS Strupa 24 talik | kg | 643.4 | C-19 |
| TM-000020 | Passport Strupa 16 talik | kg | 527.65 | C-19 |
| TM-000021 | Passport Strupa 24 talik | kg | 273.75 | C-19 |
| TM-000022 | Yashil PP TWS Strupa 16 talik | kg | **429.8** = 168.6 (C-19) + 261.2 (C-04) | C-19 + C-04 |
| TM-000023 | Sariq Polyester Strupa 16 talik | kg | 2 583.9 | C-19 |
| TM-000024 | Toshkent Arqon 16 mm Ko‘k | kg | 221.6 | C-18 |
| TM-000025 | Toshkent Arqon 16 mm Qora | kg | 332.95 | C-18 |
| TM-000026 | Ustki Gilam Ichki Sariq Polyamide | kg | 317.25 | C-18 |
| TM-000027 | Toshkent Arqon 10 mm Yashil | kg | 171.9 | C-18 |
| TM-000028 | Toshkent Arqon 14 mm Qizil | kg | 451.7 | C-18 |
| TM-000029 | Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq | kg | 866.25 | C-18 |
| TM-000030 | Toshkent Arqon 12 mm Qizil | kg | 61.65 | C-18 |
| TM-000031 | Toshkent Arqon 14 mm Qora | kg | 150 | C-18 |
| TM-000032 | Toshkent Arqon 10 mm Ko‘k | kg | 150.25 | C-18 |
| TM-000033 | FDY Fil Arqon | kg | 497.55 | C-18 |
| TM-000034 | Toshkent Arqon 16 mm Oq — 50 metr | kg | 63.2 | C-18 |
| TM-000035 | Toshkent Arqon 14 mm Oq — 100 metr | kg | 40.05 | C-18 |
| TM-000036 | Toshkent Arqon 16 mm Oq | kg | 61.9 | C-18 |
| TM-000037 | Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq | kg | 717.35 | C-18 |
| TM-000038 | Toshkent Arqon 12 mm Sariq | kg | 389.95 | C-18 |
| TM-000039 | FDY Tros Aralash | kg | 386.75 | C-18 |
| TM-000040 | Usti gilam ichki Sariq Polyamide Arqon | kg | 370.5 | C-18 |
| TM-000041 | Ustki Oq TWS ichki Polyamide Oq Arqon | kg | 1 264.1 | C-18 |
| TM-000042 | Ustki PP xom ichki Polyamide Oq Arqon | kg | 105 | C-18 |
| TM-000043 | Ustki 187 TWS Oq ichki Zubr 16 mm Arqon | kg | 926.4 | C-18 |
| TM-000044 | Ustki 187 TWS Oq ichki Strupa 14 mm Arqon | kg | 520 | C-18 |
| TM-000045 | Kanob Aralash 20 metr | kg | 113.55 | C-18 |
| TM-000046 | Alpinist 12 mm | kg | 450.6 | C-18 |
| TM-000047 | Alpinist 10 mm | kg | 106.2 | C-18 |
| TM-000048 | Alpinist 14 mm | kg | 165.55 | C-18 |
| TM-000049 | Alpinist 16 mm | kg | 199.3 | C-18 |
| TM-000050 | Alpinist 20 mm | kg | 174.5 | C-18 |
| TM-000051 | Alpinist 25 mm | kg | 32.45 | C-18 |
| TM-000052 | Shroki 3.5 sm lenta | kg | 468.35 | C-02 |
| TM-000053 | Rangli 2.5 sm ikki qavat lenta | kg | 863.45 | C-02 |
| TM-000054 | Reels Lenta | kg | 1 352.85 | C-02 |
| TM-000055 | Tulpor Lenta Aralash | kg | 556.4 | C-02 |
| TM-000056 | Tulpor Lenta Yashil | kg | 1 019.35 | C-02 |
| TM-000057 | Tulpor Lenta Oq | kg | 439.2 | C-02 |
| TM-000058 | Tulpor Lenta Ko‘k | kg | 192.05 | C-02 |
| TM-000059 | Tulpor lenta qizil | kg | 287 | C-02 |
| TM-000060 | Tahoe Lenta | kg | 197.8 | C-02 |
| TM-000061 | Polipropilen CF 1500D Qora | kg | 3 250 | C-04 |
| TM-000062 | Polipropilen CF 1000D Yashil | kg | 1 020 | C-04 |
| TM-000063 | Strupa Salafan | kg | 375.8 | C-04 |
| TM-000064 | XB Strupa | kg | 349.9 | C-04 |
| TM-000065 | PP Oq TWS Strupa 12 talik | kg | 875.55 | C-04 |
| TM-000066 | Eshma Xitoy Strupa PP Oq TWS | kg | 230.85 | C-04 |
| TM-000067 | Shlanka Polyamide Yumshoq | kg | 86.3 | C-06 |
| TM-000068 | Shlanka Tortqi PP Oq TWS — 50 metr | kg | 236.25 | C-06 |
| TM-000069 | Shlanka Tortqi PP Yashil TWS — 50 metr | kg | 66.35 | C-06 |
| TM-000070 | Shlanka Polipropilen CF Qora | kg | 618.8 | C-06 |
| TM-000071 | Shlanka Polipropilen CF Yashil | kg | 710.45 | C-06 |
| TM-000072 | Shlanka Polipropilen CF Ko‘k | kg | 506.25 | C-06 |
| TM-000073 | Shlanka Polipropilen CF Qizil | kg | 581.4 | C-06 |
| TM-000074 | Shlanka Polipropilen CF Oq | kg | 874.95 | C-06 |
| TM-000075 | Shlanka Polyester FDY Qora | kg | 433.2 | C-06 |
| TM-000076 | Shlanka Polyester FDY Yashil | kg | 830.4 | C-06 |
| TM-000077 | Shlanka Polyester FDY Ko‘k | kg | 778.15 | C-06 |
| TM-000078 | Shlanka Polyester FDY Qizil | kg | 730.95 | C-06 |
| TM-000079 | Shlanka Polyester FDY Oq | kg | 982.05 | C-06 |
| TM-000080 | Qop ip 100 talik | dona | 55 200 (6 348.00 kg) | C-16 |
| TM-000081 | Qop ip 120 talik | dona | 2 520 (226.80 kg) | C-16 |
| TM-000082 | Qop ip 80 talik | dona | 3 360 (470.40 kg) | C-16 |
| TM-000083 | Qop ip 50 gramm Qora | dona | 12 000 (600.00 kg) | C-17 |
| TM-000084 | Qop ip 50 gramm Sariq | dona | 12 800 (640.00 kg) | C-17 |
| TM-000085 | Qop ip 50 gramm Oq | dona | 7 600 (380.00 kg) | C-17 |
| TM-000086 | Qop ip 30 gramm Qora | dona | 4 800 (144.00 kg) | C-17 |
| TM-000087 | Qop ip 30 gramm Sariq | dona | 10 400 (312.00 kg) | C-17 |
| TM-000088 | Qop ip 30 gramm Oq | dona | 8 400 (252.00 kg) | C-17 |
| TM-000089 | Qop ip 100 gramm Qora | dona | 2 080 (208.00 kg) | C-17 |
| TM-000090 | Qop ip 100 gramm Sariq | dona | 2 880 (288.00 kg) | C-17 |
| TM-000091 | Qop ip 100 gramm Oq | dona | 4 320 (432.00 kg) | C-17 |
| TM-000092 | Polipropilen CF 1000D Qizil | kg | 3 720.00 | C-15 |
| TM-000093 | Polipropilen CF 1000D Ko'k | kg | 3 840.00 | C-15 |
| TM-000094 | Polipropilen CF 1000D Sariq | kg | 5 460.00 | C-15 |

## 5. 2 hal qilinmagan EXACT kandidat (R-C KO'LAMIDAN TASHQARIDA)

Egasi qarori (№1): avto-mapping YO'Q — alohida kandidat maqomida qoladi. **R-C GO'da ularga TEGILMAYDI** (mavjud itemga ulanmaydi, TM-000095/096 ham ochilmaydi). 94 itemning raqamlanishiga ta'siri yo'q.

| Fizik nom (aynan) | kg | Joy | Katalogdagi aynan mos SKU | Holat |
|---|---|---|---|---|
| Rossiya Tros | 531 | C-18 | `ROSSIYATROS` | KANDIDAT — qaror keyinroq |
| Shroki 3.5 Oq | 676.55 | C-02 | `SHROKI-3-5-OQ` | KANDIDAT — qaror keyinroq |

## 6. DDL taklifi (№6 qaror: FAQAT TAKLIF — BAJARILMAGAN)

Jonli tekshiruv (2026-08-17): `stock_movements` joriy CHECK = `IN/OUT/TRANSFER`; `weight_kg`/`reference`/`reason` ustunlari YO'Q — DDL toza qo'llanadi.

```sql
-- R-C GO tarkibida bajariladi (hozir yozilmaydi):
BEGIN;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type = ANY (ARRAY['IN'::text,'OUT'::text,'TRANSFER'::text,'BASELINE'::text]));
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS weight_kg numeric;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reason    text;
COMMIT;
```

**Lockstep sharti (dual-init qoidasi):** shu o'zgarish 3 joyda bir vaqtda bo'lishi shart — jonli baza + bot `init_db` (python) + API `initDb`/Drizzle sxemasi. **Kod diffi ham GO'gacha ATAYIN qo'llanmaydi:** dev workflowlar Railway PROD bazasiga ulangan — init kodiga ustun qo'shib qo'ysak, keyingi restartda avtomatik ALTER ishlaydi, bu esa ruxsatsiz prod yozuv bo'lardi. Shu sabab kod o'zgarishi ham «R-C GO» tarkibida, DDL bilan bir paytda kiradi.

## 7. Kutilayotgan jamlar

| Ko'rsatkich | Qiymat |
|---|---|
| Yangi item soni | **94** (82 kg-item + 12 dona-item) |
| Kutilayotgan jami kg (bevosita kg-itemlar) | **60 353.45 kg** |
| Kutilayotgan jami dona | **126 360 dona** (hisobiy 10 301.20 kg) |
| Yangi itemlar fizik massasi | **70 654.65 kg** |
| 2 EXACT kandidat (TASHQARIDA) | 1 207.55 kg — jamlarga KIRMAYDI |
| Nazorat (94 + 2 EXACT) | 71 862.20 kg ✓ (9 joy sanog'i bilan aynan) |

Joy kesimida: C-20 10 ta/10 136.45 kg · C-19 13/8 713.30 · C-18 28/9 308.45 · C-02 9/5 376.45 · C-04 6+dup/6 363.30 · C-06 13/7 435.50 · C-16 3/61 080 dona · C-17 9/65 280 dona · C-15 3/13 020.00 kg.

## 8. GO'dan keyingi tekshiruv rejasi (bitta tranzaksiya ichida oldin/keyin)

1. `COUNT(*) FROM items` = 94; MIN(sku)='TM-000001', MAX(sku)='TM-000094'; birinchi `id`=2;
2. birlik kesimi: kg=82, dona=12;
3. neytrallik: `is_raw OR is_intermediate OR is_finished OR is_purchasable OR is_producible OR is_sellable` bo'lgan satrlar = **0**; `inventory_tracked=TRUE` va `active=TRUE` = 94; `source_id IS NULL` = 94;
4. `item_aliases` = 0 (o'zgarmagan);
5. `note` tasodifiy 5 satrda format tekshiruvi (jumladan TM-000022 2-joyli va C-15 sanasi);
6. boshqa jadval invariantlari o'zgarmagan: sales 45 · sale_items 143 · stock_movements 620 (yangi 3 ustun hammasi NULL) · inventory 43 · products 117;
7. mismatch → ROLLBACK + hisobot;
8. qo'shimcha: `created_by='thisismurodov'` bo'lgan satrlar = 94.

## 9. «R-C GO» CHECKLIST — GO aytilganda aynan shu tartibda bajariladi

**Oldindan bajarilgan shartlar (2026-08-17 holatiga ✓):**
- [x] P2.1 LIVE — `items`/`item_aliases` bo'sh, SKU-immutable + no-delete triggerlar ishlaydi;
- [x] R-A arxiv tekshirilgan — `legacy.*` 12/12 PASS + gitignored insurance dump;
- [x] 94-qator yakuniy jadval muhrlangan (§4); 2 EXACT tashqarida (§5); raqamlash C-20→C-19→C-18→C-02→C-04→C-06→C-16→C-17→C-15;
- [x] `created_by = 'thisismurodov'` tasdiqlangan (egasi, 2026-08-17);
- [x] §6 DDL jonli katalog bilan solishtirilgan (joriy CHECK = IN/OUT/TRANSFER; 3 ustun hali yo'q — toza qo'llanadi).

**Qolgan yagona shart:**
- [ ] Egasidan aniq **«R-C GO»** xabari.

**GO kelganda (ketma-ketlik qat'iy):**
1. Kod lockstep diffi tayyorlanadi (bot `init_db` + API `initDb`/Drizzle: BASELINE + `weight_kg`/`reference`/`reason`) — **hali qo'llanmaydi, workflow restart yo'q**;
2. Railway prod'da **BITTA tranzaksiya**: invariant snapshot (§8.6 «oldin») → §6 DDL → 94 INSERT (§4, `created_by='thisismurodov'`) → §8 tekshiruvlari 1–8 «keyin» — birorta mismatch → **ROLLBACK** + hisobot, COMMIT yo'q;
3. Faqat COMMIT muvaffaqiyatli bo'lgach kod diffi qo'llanadi va workflowlar restart qilinadi (DDL allaqachon bazada — init kodlarining avto-ALTERi idempotent no-op bo'ladi);
4. Bajarilish hisoboti yoziladi: `docs/r-c-execution-report-<sana>.md` (oldin/keyin raqamlar, §8 natijalari, tranzaksiya vaqti).

**GO tarkibiga KIRMAYDI (yana bir bor):** 2 EXACT kandidat (№1 alohida qaror) · pozitsiya→item_id bog'lash (R-B registri GO'idan keyin) · R-D nollash/yuklash (muzlatilgan) · alias/narx/BOM/klassifikatsiya bayroqlari (dashboard-era, egasi belgilaydi) · sales/legacy/sanoq qiymatlariga har qanday tegish.

---

**Biznes ta'siri:** ★★★★☆ · **Texnik xavf:** ☆☆☆☆☆ (0 yozuv — faqat SELECT + hujjat) · **Foydalanuvchi qiymati:** ★★★★★ (GO tugmasi oldidagi to'liq, taxminsiz manzara) · **Kelajak bog'liqligi:** ★★★★★ (R-C GO aynan shu hujjatdan bajariladi)

*Biz taxmin qilmaymiz. Biz bilamiz.*
