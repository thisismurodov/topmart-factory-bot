import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { pool } from "@workspace/db";

// Field Assistant (Telegram Mini App) autentifikatsiyasi.
//
// Klient har bir so'rovda Telegram WebApp `initData` satrini `X-Telegram-Init-Data`
// header'ida yuboradi. Server uni HMAC-SHA256 bilan tekshiradi:
//   secret = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN)
//   hash   = HMAC_SHA256(key=secret, data=data_check_string)
// (data_check_string — hash'dan tashqari barcha maydonlar, kalit bo'yicha
// saralangan, "key=value" ko'rinishida "\n" bilan birlashtirilgan.)
//
// Token: DISTRIBUTION_BOT_TOKEN — distribution botning tokeni (factory botning
// TELEGRAM_BOT_TOKEN'i EMAS). Mini App distribution bot ichida ochilgani uchun
// initData aynan shu token bilan imzolanadi.
//
// auth_date 24 soatdan eski bo'lsa rad etiladi (replay himoyasi).
//
// Dev bypass (faqat lokal test uchun): NODE_ENV!=="production" HAMDA
// FIELD_DEV_BYPASS=1 bo'lgandagina `X-Field-Dev-Id: <telegram_id>` header
// qabul qilinadi. Token yo'qligi bypass'ni YOQMAYDI.

const MAX_AUTH_AGE_SEC = 24 * 60 * 60;

export type FieldAgent = {
  /** distribution.delivery_agents.id — delivery_routes shu id'ga bog'lanadi */
  id: number;
  /** Telegram user id — savdolar/olmagan_dokonlar/agent_locations.agent_id shu qiymat */
  telegramId: number;
  name: string;
  hudud: string | null;
};

export interface FieldRequest extends Request {
  fieldAgent?: FieldAgent;
}

type InitDataResult =
  | { ok: true; telegramId: number }
  | { ok: false; error: string };

export function validateTelegramInitData(
  initData: string,
  botToken: string,
): InitDataResult {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, error: "initData o'qib bo'lmadi" };
  }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    return { ok: false, error: "hash yo'q" };
  }
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash.toLowerCase(), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "imzo noto'g'ri" };
  }
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, error: "auth_date yo'q" };
  }
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > MAX_AUTH_AGE_SEC) {
    return { ok: false, error: "sessiya eskirgan — Mini App'ni qayta oching" };
  }
  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, error: "user maydoni yo'q" };
  let telegramId: number;
  try {
    const user = JSON.parse(userRaw) as { id?: unknown };
    if (typeof user.id !== "number" || !Number.isInteger(user.id) || user.id <= 0) {
      return { ok: false, error: "user.id noto'g'ri" };
    }
    telegramId = user.id;
  } catch {
    return { ok: false, error: "user JSON emas" };
  }
  return { ok: true, telegramId };
}

export async function fieldAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    let telegramId: number | null = null;

    const devBypassEnabled =
      process.env.NODE_ENV !== "production" && process.env.FIELD_DEV_BYPASS === "1";
    const devId = req.headers["x-field-dev-id"];
    if (devBypassEnabled && typeof devId === "string" && /^\d{1,15}$/.test(devId)) {
      telegramId = Number(devId);
    } else {
      const initData = req.headers["x-telegram-init-data"];
      if (typeof initData !== "string" || initData.length === 0) {
        res.status(401).json({ error: "Avtorizatsiya yo'q — Mini App orqali oching" });
        return;
      }
      if (initData.length > 8192) {
        res.status(401).json({ error: "initData juda uzun" });
        return;
      }
      const botToken = process.env.DISTRIBUTION_BOT_TOKEN;
      if (!botToken) {
        req.log.error("DISTRIBUTION_BOT_TOKEN o'rnatilmagan — field auth ishlamaydi");
        res.status(503).json({ error: "Server sozlanmagan (bot token yo'q)" });
        return;
      }
      const result = validateTelegramInitData(initData, botToken);
      if (!result.ok) {
        res.status(401).json({ error: `Avtorizatsiya xatosi: ${result.error}` });
        return;
      }
      telegramId = result.telegramId;
    }

    const { rows } = await pool.query<{
      id: number;
      name: string;
      telegram_id: string | number;
      hudud: string | null;
    }>(
      `SELECT id, name, telegram_id, hudud
         FROM distribution.delivery_agents
        WHERE telegram_id = $1 AND faol = 1
        LIMIT 1`,
      [telegramId],
    );
    if (rows.length > 0) {
      const row = rows[0];
      (req as FieldRequest).fieldAgent = {
        id: row.id,
        telegramId: Number(row.telegram_id),
        name: row.name,
        hudud: row.hudud,
      };
      next();
      return;
    }

    // Fallback: delivery_agents'da yo'q, lekin botda agent/supervisor/admin
    // sifatida ro'yxatdan o'tgan foydalanuvchilar ham Mini App'ga kira oladi.
    // Ularda delivery_routes bo'lmasligi mumkin — id=0 sentinel: marshrut
    // so'rovlari bo'sh qaytadi, savdo/tashrif yozuvlari telegramId bilan
    // yoziladi (bot bilan bir xil semantika).
    const userRows = await pool.query<{
      name: string;
      viloyat: string | null;
    }>(
      `SELECT name, viloyat
         FROM distribution.users
        WHERE telegram_id = $1 AND role IN ('agent','supervisor','admin')
        LIMIT 1`,
      [String(telegramId)],
    );
    if (userRows.rows.length === 0) {
      res.status(403).json({
        error: "Siz agent sifatida ro'yxatdan o'tmagansiz — botga /start yozing",
      });
      return;
    }
    (req as FieldRequest).fieldAgent = {
      id: 0,
      telegramId,
      name: userRows.rows[0].name,
      hudud: userRows.rows[0].viloyat || null,
    };
    next();
  } catch (err) {
    next(err);
  }
}
