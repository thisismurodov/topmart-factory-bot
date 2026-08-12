import { pool } from "@workspace/db";

// ── Manfiy WIP balans ogohlantirishi (Telegram) ────────────────────────────────
// Bo'lim WIP balansi (RECEIVE − PRODUCE) minusga tushsa, admin rolidagi
// foydalanuvchilarga Telegram xabar yuboriladi. Spam bo'lmasligi uchun
// wip_negative_alerts jadvali orqali har bir bo'lim uchun kuniga ko'pi bilan
// BIR marta yuboriladi (ON CONFLICT DO NOTHING — dedupe qatori atomik).
//
// Yuborish payroll notifyWorkers bilan bir xil best-effort uslubda: Telegram
// ishlamay qolsa asosiy operatsiya (produce / flow) hech qachon yiqilmaydi.

// Floating-point shovqinini (masalan -1e-12) minus deb hisoblamaslik uchun.
export const NEGATIVE_WIP_EPS = 1e-6;

// Testlarda soxta Telegram serveriga yo'naltirish uchun override qilinadi.
function telegramApiBase(): string {
  return process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
}

async function adminChatIds(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT chat_id FROM user_roles WHERE role = 'admin'`,
  );
  const ids = rows.map((r) => String(r.chat_id));
  // Hech bir admin ro'yxatdan o'tmagan bo'lsa — bot scheduler ishlatadigan
  // ADMIN_CHAT_ID env'iga tushamiz (xabar butunlay yo'qolib qolmasin).
  if (ids.length === 0 && process.env.ADMIN_CHAT_ID) {
    ids.push(String(process.env.ADMIN_CHAT_ID));
  }
  return [...new Set(ids)];
}

/**
 * Bo'lim balansi manfiy bo'lsa adminlarga Telegram xabar yuboradi.
 * Kuniga bo'lim boshiga ko'pi bilan bir marta (wip_negative_alerts dedupe).
 * Best-effort: hech qachon throw qilmaydi.
 * @returns true — xabar yuborishga urinildi (dedupe qatori yangi kiritildi)
 */
export async function notifyNegativeWip(
  lineId: number,
  lineName: string,
  wipKg: number,
): Promise<boolean> {
  try {
    if (!(wipKg < -NEGATIVE_WIP_EPS)) return false;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return false;

    // Dedupe: shu bo'lim uchun bugun allaqachon yuborilgan bo'lsa — chiqamiz.
    const ins = await pool.query(
      `INSERT INTO wip_negative_alerts (line_id, alert_date, wip_kg)
       VALUES ($1, (NOW() AT TIME ZONE 'Asia/Tashkent')::date, $2)
       ON CONFLICT (line_id, alert_date) DO NOTHING
       RETURNING line_id`,
      [lineId, wipKg],
    );
    if (ins.rows.length === 0) return false;

    const chatIds = await adminChatIds();
    if (chatIds.length === 0) return false;

    const shortfall = Math.abs(wipKg);
    const text =
      `🚨 Bo'lim balansi minusga tushdi!\n` +
      `🏭 Bo'lim: ${lineName}\n` +
      `📉 Balans: −${shortfall.toFixed(2)} kg (kamomad)\n` +
      `Ish jarayoni sahifasida bo'lim harakatlarini tekshiring.`;

    for (const chatId of chatIds) {
      try {
        await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      } catch {
        // best-effort — Telegram xatosi asosiy operatsiyani to'xtatmaydi
      }
    }
    return true;
  } catch {
    return false;
  }
}
