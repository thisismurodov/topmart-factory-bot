import { pool, db, adminUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { logger } from "./lib/logger";

// API server cold-start DB bootstrap. Runs on every boot and is fully
// idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) so it is
// safe against a brand-new empty DB as well as the existing production DB.
//
// IMPORTANT: this function is the single source of truth for what the API
// guarantees to exist at runtime. The fresh-db-boot test imports and runs it
// against a throwaway database, so keep all schema bootstrapping here (do not
// inline schema DDL back into index.ts).
export async function initDb(): Promise<void> {
  // admin_users jadvali (Drizzle schema bor, lekin Railway DB'da bo'lmasligi mumkin)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // admin_sessions — Drizzle sxemasida yo'q, raw SQL bilan yaratiladi
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // products.weight (og'irlik) — runtime DB (Railway) ustuniga idempotent qo'shamiz.
  // drizzle.config bo'sh Replit DB'ga ishlaydi, shuning uchun bu ALTER kerak.
  await pool.query(`
    ALTER TABLE IF EXISTS products
      ADD COLUMN IF NOT EXISTS weight NUMERIC(12,3) NOT NULL DEFAULT 1
  `);

  // products.pieces_per_box — qutidagi dona soni (etiketika: 1 quti = N dona)
  await pool.query(`
    ALTER TABLE IF EXISTS products
      ADD COLUMN IF NOT EXISTS pieces_per_box INTEGER NOT NULL DEFAULT 1
  `);

  // products.roll_length_m — o'ramdagi metr (etiketkadagi METRI qatori profildan olinadi)
  await pool.query(`
    ALTER TABLE IF EXISTS products
      ADD COLUMN IF NOT EXISTS roll_length_m NUMERIC(12,2) NOT NULL DEFAULT 0
  `);

  // products.in_sales / in_production — Bitta mahsulot bazasi modullari (Task 104):
  // bitta master yozuv savdo va ishlab chiqarish bo'limlarida qaysi rejimda
  // ishlatilishini belgilaydi.
  await pool.query(`
    ALTER TABLE IF EXISTS products
      ADD COLUMN IF NOT EXISTS in_sales BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS in_production BOOLEAN NOT NULL DEFAULT TRUE
  `);

  // products.cost_price — qo'lda tan narx (savdo mahsulotlari uchun): >0 bo'lsa
  // BOM/mehnat/elektr o'rniga TO'LIQ tan narx sifatida ishlatiladi.
  await pool.query(`
    ALTER TABLE IF EXISTS products
      ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2) NOT NULL DEFAULT 0
  `);

  // Backfill: savdo katalogiga (distribution.mahsulotlar) SKU orqali bog'langan
  // mahsulotlar avtomatik "savdoda ishlatiladi" deb belgilanadi. Idempotent va
  // o'z-o'zini tuzatadi: in_sales o'chirilsa sync mahsulotni faol=0 qiladi,
  // shuning uchun bu backfill uni qayta yoqmaydi.
  await pool.query(`
    DO $$ BEGIN
      IF to_regclass('distribution.mahsulotlar') IS NOT NULL THEN
        UPDATE products p SET in_sales = TRUE
         WHERE p.in_sales = FALSE AND p.sku <> ''
           AND EXISTS (SELECT 1 FROM distribution.mahsulotlar m
                        WHERE m.faol = 1 AND m.sku = p.sku);
      END IF;
    END $$
  `);

  // products.sku — yagona katalog identifikatori: bo'sh bo'lmagan SKU'lar unikal
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_unique
      ON products (sku) WHERE sku <> ''
  `);

  // raw_materials.currency — xom ashyo valyutasi (UZS yoki USD)
  await pool.query(`
    ALTER TABLE IF EXISTS raw_materials
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UZS'
  `);

  // product_price_tiers — hajm bo'yicha tier narxlash
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_price_tiers (
      id           SERIAL PRIMARY KEY,
      product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      min_quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
      max_quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (max_quantity >= min_quantity),
      price        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
      currency     TEXT NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD')),
      created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ppt_product ON product_price_tiers(product_id)
  `);

  // packer_product_assignments — packer ishchilari uchun mahsulot biriktirishlar
  // (bot init_db ham yaratadi, lekin API cold-start da mavjudligini kafolatlaymiz)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS packer_product_assignments (
      id           SERIAL PRIMARY KEY,
      packer_name  TEXT NOT NULL,
      product_name TEXT NOT NULL,
      UNIQUE (packer_name, product_name)
    )
  `);

  // line_role_config — har bir liniya uchun alohida rol konfiguratsiyasi
  // (qaysi rollar, qanday stavka, necha kishi max)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS line_role_config (
      id          SERIAL PRIMARY KEY,
      line_id     INTEGER NOT NULL REFERENCES production_lines(id) ON DELETE CASCADE,
      role_key    TEXT NOT NULL,
      label       TEXT NOT NULL DEFAULT '',
      rate        NUMERIC(12,2) NOT NULL DEFAULT 0,
      max_workers INTEGER NOT NULL DEFAULT 5,
      UNIQUE (line_id, role_key)
    )
  `);
  await pool.query(`
    ALTER TABLE line_role_config
      ADD COLUMN IF NOT EXISTS pay_mode TEXT NOT NULL DEFAULT 'pooled'
  `);
  // Producer config roles → 'individual' (own_kg × rate, not pooled).
  // Idempotent backfill: a config role is a producer role if its members also
  // hold the standard 'producer' role on the same line. Mirrors bot init_db so
  // payroll is correct regardless of which service runs migrations first.
  await pool.query(`
    UPDATE line_role_config lrc SET pay_mode = 'individual'
    WHERE lrc.pay_mode <> 'individual'
      AND EXISTS (
        SELECT 1 FROM production_line_workers w
        WHERE w.line_id = lrc.line_id AND w.role = lrc.role_key
          AND EXISTS (
            SELECT 1 FROM production_line_workers w2
            WHERE w2.line_id = w.line_id
              AND w2.worker_name = w.worker_name
              AND w2.role = 'producer'
          )
      )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_line_role_config_line
      ON line_role_config(line_id)
  `);

  // batches.archived — yumshoq o'chirish (soft delete)
  await pool.query(`
    ALTER TABLE IF EXISTS batches
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE
  `);

  // audit_logs — kim, qachon, nima o'zgartirdi
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          SERIAL PRIMARY KEY,
      table_name  TEXT NOT NULL,
      action      TEXT NOT NULL,
      record_id   TEXT,
      changed_by  TEXT NOT NULL DEFAULT 'api',
      old_data    JSONB,
      new_data    JSONB,
      created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_table ON audit_logs(table_name)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_analysis_runs (
      id          SERIAL PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'daily',
      summary     JSONB,
      analysis    TEXT NOT NULL,
      created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON ai_analysis_runs(kind, created_at DESC)
  `);

  // sale_items — sotuvning qatorlari (har bir sotuvdagi mahsulotlar). Bot
  // create_sale shu jadvalga yozadi va sales/reports route'lari undan o'qiydi,
  // lekin u hech qaysi sxemada YARATILMAGAN edi — bo'sh DB'da pastdagi CHECK
  // ALTER "relation sale_items does not exist" bilan yiqilardi. Ombor jadvallari
  // kabi idempotent yaratamiz (API cold-start o'zini-o'zi ta'minlaydi).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id           SERIAL PRIMARY KEY,
      sale_id      INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      sale_type    TEXT NOT NULL DEFAULT 'dona',
      quantity     NUMERIC(12,3) NOT NULL DEFAULT 0,
      unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency     TEXT NOT NULL DEFAULT 'UZS',
      line_total   NUMERIC(14,2) NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)
  `);

  // ── Sotuv (sales) sxemasi — bo'sh DB'da yetishmagan ustun/jadvallar ──────
  // Bot init_db sales jadvalini eski shaklda yaratadi (currency/payment_type/
  // paid_amount/debt_amount yo'q, product NOT NULL). API POST /sales esa aynan
  // shu ustunlarga yozadi va product'siz INSERT qiladi — toza DB'da 500 bo'lardi.
  await pool.query(`ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'uzs'`);
  await pool.query(`ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS payment_type TEXT NOT NULL DEFAULT 'naqd'`);
  await pool.query(`ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS debt_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE IF EXISTS sales ALTER COLUMN product DROP NOT NULL`);

  // customers.deleted_at — yumshoq o'chirish (routes deleted_at IS NULL filtrlaydi)
  await pool.query(`ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE`);

  // sale_payments — qarzga to'lovlar tarixi (bot add_sale_payment + API /sales/:id/payments)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sale_payments (
      id         SERIAL PRIMARY KEY,
      sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      amount     NUMERIC(12,2) NOT NULL,
      currency   TEXT NOT NULL DEFAULT 'USD',
      note       TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id)`);

  // sale_events — sotuv voqealar jurnali (logEvent best-effort yozadi, reports o'qiydi)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sale_events (
      id          SERIAL PRIMARY KEY,
      sale_id     INTEGER,
      event_type  TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      amount      NUMERIC(12,2),
      currency    TEXT,
      user_id     INTEGER,
      created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sale_events_sale ON sale_events(sale_id)`);

  // sales_products — sotuv katalogi (sales-products route'lari CRUD qiladi)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_products (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      unit          TEXT NOT NULL DEFAULT 'dona',
      price         NUMERIC(12,2) NOT NULL DEFAULT 0,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      sale_type     TEXT NOT NULL DEFAULT 'dona',
      default_price NUMERIC(12,4) NOT NULL DEFAULT 0,
      currency      TEXT NOT NULL DEFAULT 'UZS',
      created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  // sales_product_tiers — sotuv katalogi tier narxlari
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_product_tiers (
      id         SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES sales_products(id) ON DELETE CASCADE,
      min_qty    NUMERIC NOT NULL DEFAULT 0,
      price      NUMERIC NOT NULL,
      currency   TEXT NOT NULL DEFAULT 'usd',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_spt_product ON sales_product_tiers(product_id)`);

  // DB darajasida CHECK constraint'lar (idempotent)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE sale_items ADD CONSTRAINT chk_sale_items_qty CHECK (quantity > 0);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE sales ADD CONSTRAINT chk_sales_total CHECK (total_amount >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);

  // ── Ombor (zaxira) jadvallari ────────────────────────────────────────────
  // Bu jadvallar avval faqat ishlab chiqarish DB'sida mavjud edi va hech qaysi
  // sxemada ta'riflanmagan edi. Yangi/bo'sh DB'da (yoki bot hali ishlamagan
  // cold-start da) Ombor sahifasi ishlashi uchun ularni idempotent yaratamiz.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      capacity_kg   NUMERIC DEFAULT 20000,
      purpose       TEXT NOT NULL DEFAULT 'finished',
      created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      product      TEXT NOT NULL,
      quantity     NUMERIC NOT NULL DEFAULT 0,
      weight_kg    NUMERIC NOT NULL DEFAULT 0,
      product_type TEXT NOT NULL DEFAULT 'finished',
      updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE (warehouse_id, product)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id                SERIAL PRIMARY KEY,
      product           TEXT NOT NULL,
      quantity          NUMERIC NOT NULL DEFAULT 0,
      movement_type     TEXT NOT NULL CHECK (movement_type IN ('IN', 'OUT', 'TRANSFER', 'BASELINE')),
      from_warehouse_id INTEGER REFERENCES warehouses(id),
      to_warehouse_id   INTEGER REFERENCES warehouses(id),
      note              TEXT NOT NULL DEFAULT '',
      created_by        TEXT NOT NULL DEFAULT '',
      product_type      TEXT NOT NULL DEFAULT 'finished',
      created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      weight_kg         NUMERIC,
      reference         TEXT,
      reason            TEXT
    )
  `);

  // Production schema o'zgarishi oddiy restartda tasodifan qo'llanmaydi.
  // Faqat foydalanuvchi aniq DDL modelini tasdiqlagan migration jarayoni yoki
  // throwaway schema testlari bu gate'ni ataylab yoqadi.
  if (process.env.PRODUCTION_LABELS_SCHEMA_APPROVED === "1") {
    // Har bir fizik ishlab chiqarish etiketkasi uchun o'zgarmas passport.
    // batch/warehouse FK SET NULL: manba qatori o'chirilsa ham barcode tarixi qoladi.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS production_labels (
        id               SERIAL PRIMARY KEY,
        barcode_value    TEXT NOT NULL,
        batch_id         INTEGER REFERENCES batches(id) ON DELETE SET NULL,
        batch_code       TEXT NOT NULL,
        label_type       TEXT NOT NULL DEFAULT 'unit',
        label_number     INTEGER NOT NULL,
        total_labels     INTEGER NOT NULL,
        pieces_in_label  INTEGER NOT NULL DEFAULT 1,
        pieces_per_box   INTEGER NOT NULL DEFAULT 1,
        quantity_total   INTEGER NOT NULL,
        weight_kg        NUMERIC(12,3) NOT NULL DEFAULT 0,
        length_m         NUMERIC(12,2),
        product_name     TEXT NOT NULL,
        product_sku      TEXT NOT NULL DEFAULT '',
        worker_name      TEXT NOT NULL,
        produced_at      TIMESTAMP WITH TIME ZONE NOT NULL,
        warehouse_id     INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
        warehouse_name   TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'created',
        print_count      INTEGER NOT NULL DEFAULT 0,
        last_printed_at  TIMESTAMP WITH TIME ZONE,
        created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        CONSTRAINT production_labels_barcode_check
          CHECK (barcode_value ~ '^TM[A-Z2-7]{16}$'),
        CONSTRAINT production_labels_number_check
          CHECK (label_number > 0 AND total_labels >= label_number),
        CONSTRAINT production_labels_pieces_check
          CHECK (pieces_in_label > 0),
        CONSTRAINT production_labels_box_capacity_check
          CHECK (pieces_per_box > 0),
        CONSTRAINT production_labels_quantity_check
          CHECK (quantity_total > 0),
        CONSTRAINT production_labels_weight_check
          CHECK (weight_kg >= 0),
        CONSTRAINT production_labels_length_check
          CHECK (length_m IS NULL OR length_m >= 0),
        CONSTRAINT production_labels_type_check
          CHECK (label_type IN ('unit','box')),
        CONSTRAINT production_labels_status_check
          CHECK (status IN ('created','printed','void')),
        CONSTRAINT production_labels_print_count_check
          CHECK (print_count >= 0)
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_production_labels_barcode
        ON production_labels(barcode_value)
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_production_labels_batch_number
        ON production_labels(batch_id, label_number)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_production_labels_batch_code
        ON production_labels(batch_code)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_production_labels_product
        ON production_labels(product_name)
    `);
    // F4: vehicle-handoff passports carry batch_id NULL + batch_code 'VH-<handoffId>'.
    // The (batch_id, label_number) unique index does not constrain NULL batch_id
    // rows, so this partial unique index enforces one label_number per VH batch.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_production_labels_vh_batch_number
        ON production_labels(batch_code, label_number)
        WHERE batch_id IS NULL AND batch_code LIKE 'VH-%'
    `);
    await pool.query(`
      CREATE OR REPLACE FUNCTION enforce_production_label_immutable()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF ROW(
          NEW.id, NEW.barcode_value, NEW.batch_code, NEW.label_type,
          NEW.label_number, NEW.total_labels, NEW.pieces_in_label,
          NEW.pieces_per_box, NEW.quantity_total, NEW.weight_kg, NEW.length_m,
          NEW.product_name, NEW.product_sku, NEW.worker_name, NEW.produced_at,
          NEW.warehouse_name, NEW.created_at
        ) IS DISTINCT FROM ROW(
          OLD.id, OLD.barcode_value, OLD.batch_code, OLD.label_type,
          OLD.label_number, OLD.total_labels, OLD.pieces_in_label,
          OLD.pieces_per_box, OLD.quantity_total, OLD.weight_kg, OLD.length_m,
          OLD.product_name, OLD.product_sku, OLD.worker_name, OLD.produced_at,
          OLD.warehouse_name, OLD.created_at
        ) OR (
          NEW.batch_id IS DISTINCT FROM OLD.batch_id
          AND NOT (OLD.batch_id IS NOT NULL AND NEW.batch_id IS NULL)
        ) OR (
          NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
          AND NOT (OLD.warehouse_id IS NOT NULL AND NEW.warehouse_id IS NULL)
        ) THEN
          RAISE EXCEPTION 'production label identity and snapshots are immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      DROP TRIGGER IF EXISTS production_labels_immutable_trigger
        ON production_labels
    `);
    await pool.query(`
      CREATE TRIGGER production_labels_immutable_trigger
      BEFORE UPDATE ON production_labels
      FOR EACH ROW EXECUTE FUNCTION enforce_production_label_immutable()
    `);
  }

  // ── Ish jarayoni (Material Flow / WIP) ───────────────────────────────────
  // Ombor/inventory ustunlari odatda bot init_db tomonidan qo'shiladi, lekin
  // API cold-start da (bot hali ishlamagan bo'lsa) ham mavjudligini kafolatlaymiz
  // — aks holda /ombor/* so'rovlari "column does not exist" bilan yiqiladi.
  await pool.query(`ALTER TABLE IF EXISTS inventory  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE IF EXISTS inventory  ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'finished'`);
  await pool.query(`ALTER TABLE IF EXISTS warehouses ADD COLUMN IF NOT EXISTS location_type TEXT NOT NULL DEFAULT 'general'`);
  await pool.query(`ALTER TABLE IF EXISTS warehouses ADD COLUMN IF NOT EXISTS capacity_kg NUMERIC DEFAULT 20000`);
  await pool.query(`ALTER TABLE IF EXISTS warehouses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE IF EXISTS stock_movements ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'finished'`);
  // R-C (2026-08-17): inventar-reset baseline ustunlari (nullable, default'siz).
  // Jonli bazaga R-C tranzaksiyasi qo'shgan; bu yerda faqat konvergensiya.
  await pool.query(`ALTER TABLE IF EXISTS stock_movements ADD COLUMN IF NOT EXISTS weight_kg NUMERIC`);
  await pool.query(`ALTER TABLE IF EXISTS stock_movements ADD COLUMN IF NOT EXISTS reference TEXT`);
  await pool.query(`ALTER TABLE IF EXISTS stock_movements ADD COLUMN IF NOT EXISTS reason TEXT`);
  // Drift-tuzatish (2026-08-15, egasi buyrug'i): movement_type CHECK jonli
  // bazada azaldan bor, lekin initializer'lar uni yaratmasdi — yangi (fresh)
  // baza himoyasiz qolardi. Yangi baza inline CHECK oladi (yuqoridagi CREATE),
  // eski CHECK'siz baza shu yerda konvergensiya qiladi. Jonli bazada constraint
  // allaqachon bor → blok hech narsa qilmaydi (faqat katalog o'qiydi).
  // Agar bazada IN/OUT/TRANSFER'dan boshqa qiymatli satr bo'lsa, ADD CONSTRAINT
  // ATAYLAB baland ovozda yiqiladi — buzuq satr jim yashirilmasligi kerak.
  await pool.query(`
    DO $$ BEGIN
      IF to_regclass('public.stock_movements') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.stock_movements'::regclass
           AND conname  = 'stock_movements_movement_type_check'
      ) THEN
        BEGIN
          -- R-C (2026-08-17): BASELINE qo'shildi (inventar-reset boshlang'ich qoldiqlari)
          ALTER TABLE stock_movements
            ADD CONSTRAINT stock_movements_movement_type_check
            CHECK (movement_type IN ('IN', 'OUT', 'TRANSFER', 'BASELINE'));
        EXCEPTION WHEN duplicate_object THEN
          -- Parallel boot poygasi (bot + API bir vaqtda): ikkalasi ham "yo'q"
          -- deb ko'rishi mumkin — yutqazgan tomon jim davom etadi.
          -- check_violation ATAYIN tutilmaydi: buzuq satr baland ovozda yiqiladi.
          NULL;
        END;
      END IF;
    END $$;
  `);
  // Konteynerni xom ashyo ("raw") yoki tayyor mahsulot ("finished") ombori
  // sifatida belgilash uchun. Standart: 'finished' (mavjud xatti-harakat).
  await pool.query(`
    ALTER TABLE IF EXISTS warehouses
      ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'finished'
  `);
  // WIP ledger — bo'lim (production_line) zahirasi shu jadval orqali kuzatiladi:
  //   RECEIVE  (+kg) — xom ashyo konteynerdan bo'limga berildi
  //   PRODUCE  (-kg) — bo'lim tayyor mahsulot chiqardi (bot partiya yaratganda)
  // Bo'lim WIP = SUM(RECEIVE) − SUM(PRODUCE). line_id — production_lines.id
  // (batches.production_line_id kabi oddiy int, FK emas — liniya o'chsa snapshot qoladi).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wip_movements (
      id                SERIAL PRIMARY KEY,
      line_id           INTEGER NOT NULL,
      movement_type     TEXT NOT NULL,
      raw_material      TEXT,
      product           TEXT,
      weight_kg         NUMERIC(12,3) NOT NULL DEFAULT 0,
      from_warehouse_id INTEGER,
      batch_id          INTEGER,
      note              TEXT NOT NULL DEFAULT '',
      created_by        TEXT NOT NULL DEFAULT 'admin',
      created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wip_line_created ON wip_movements (line_id, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wip_type ON wip_movements (movement_type)
  `);
  // Manfiy WIP Telegram ogohlantirishlari dedupe jadvali: har bir bo'lim uchun
  // kuniga ko'pi bilan bitta xabar (PRIMARY KEY (line_id, alert_date) atomik
  // himoya). Faqat API yozadi (lib/wipAlerts.ts) — bot bu jadvalga tegmaydi.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wip_negative_alerts (
      line_id    INTEGER NOT NULL,
      alert_date DATE NOT NULL,
      wip_kg     NUMERIC(12,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (line_id, alert_date)
    )
  `);

  // ── Bir martalik backfill: eski partiyalarning xom ashyo sarfi ────────────
  // Harakat logi qo'shilishidan OLDIN yaratilgan partiyalar xom ashyoni
  // jimgina kamaytirgan (stock_movements yozuvi yo'q edi). Har bir eski
  // partiya qatori × BOM (product_materials.quantity_required) aniq sarfni
  // beradi — shu yerda OUT/raw yozuvlarini created_at = partiya vaqti bilan
  // qayta tiklaymiz. Idempotent QATOR darajasida: bitta batch_code ostida bir
  // nechta mahsulot qatori (batch session) bo'lishi mumkin, shuning uchun
  // tekshiruv aynan shu qator+material uchun yoziladigan yozuv (to'liq note +
  // material nomi) bo'yicha — kod darajasida emas. Aks holda sessionning bitta
  // mahsuloti loglangan bo'lsa, qolganlari abadiy o'tkazib yuborilardi.
  // batches/product_materials/raw_materials jadvallari
  // botniki — mavjud bo'lmasa (yangi bo'sh DB) backfill shunchaki o'tkaziladi.
  const backfillTables = await pool.query(`
    SELECT to_regclass('public.batches')           AS b,
           to_regclass('public.product_materials') AS pm,
           to_regclass('public.raw_materials')     AS rm
  `);
  if (backfillTables.rows[0].b && backfillTables.rows[0].pm && backfillTables.rows[0].rm) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Parallel boot bo'lsa ham ikki nusxa kirmasin (advisory lock, txn oxirida bo'shaydi)
      await client.query("SELECT pg_advisory_xact_lock(748321057)");
      const ins = await client.query(`
        INSERT INTO stock_movements
          (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
           note, created_by, product_type, created_at)
        SELECT rm.name,
               pm.quantity_required * b.quantity,
               'OUT', NULL, NULL,
               'Ishlab chiqarish: ' || b.batch_code || ' (' || b.product || ' × ' || b.quantity || ')',
               b.worker,
               'raw',
               b.created_at
        FROM batches b
        JOIN product_materials pm ON pm.product_name = b.product
        JOIN raw_materials rm     ON rm.id = pm.raw_material_id
        WHERE (pm.quantity_required * b.quantity) > 0
          AND NOT EXISTS (
            SELECT 1 FROM stock_movements sm
            WHERE sm.movement_type = 'OUT'
              AND sm.product_type  = 'raw'
              AND sm.product       = rm.name
              -- Note format MUST mirror bot create_batch_session exactly:
              -- "Ishlab chiqarish: {batch_code} ({product} × {quantity})"
              AND sm.note = 'Ishlab chiqarish: ' || b.batch_code || ' (' || b.product || ' × ' || b.quantity || ')'
          )
        ORDER BY b.created_at, b.id
      `);
      await client.query("COMMIT");
      if (ins.rowCount) {
        logger.info(`Backfilled ${ins.rowCount} legacy raw-consumption stock_movements rows`);
      }
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Distribution: do'kon pin ko'chirish audit jurnali ────────────────────
  // PATCH /distribution/shops/:id shu jadvalga yozadi. Kanonik DDL uch joyda
  // (bot connection.py, init-distribution.ts, Drizzle mirror) — bu nusxa API
  // cold-start da (distribution init hali ishlamagan bo'lsa) mavjudligini
  // kafolatlaydi. Idempotent va drift-check bilan bir xil ta'rif.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS distribution`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distribution.dokon_location_log (
      id SERIAL PRIMARY KEY,
      dokon_id BIGINT NOT NULL,
      old_latitude DOUBLE PRECISION,
      old_longitude DOUBLE PRECISION,
      new_latitude DOUBLE PRECISION,
      new_longitude DOUBLE PRECISION,
      changed_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dokon_location_log_dokon
      ON distribution.dokon_location_log (dokon_id, created_at)
  `);

  // ── Distribution: AI tavsiya keshining DB nusxasi ────────────────────────
  // /distribution/suggestions dagi LLM reytingi restartdan keyin ham qayta
  // ishlatilishi uchun. Kanonik DDL bot connection.py + init-distribution.ts +
  // Drizzle mirror bilan bir xil (drift-check nazorati ostida).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distribution.ai_suggest_cache (
      cache_key TEXT PRIMARY KEY,
      items TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // Admin userni seed qilish (mavjud bo'lmasa)
  const existing = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, "thisismurodov"));
  if (existing.length === 0) {
    const passwordHash = await bcrypt.hash("topmart2026", 10);
    await db.insert(adminUsersTable).values({
      username: "thisismurodov",
      passwordHash,
      role: "admin",
    });
    logger.info("Admin user created: thisismurodov");
  }
}
