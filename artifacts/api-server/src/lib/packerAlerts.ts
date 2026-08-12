import { pool } from "@workspace/db";

// ── Packer bo'sh mahsulot ro'yxati ogohlantirishi (Telegram) ────────────────
// Mahsulot nofaol qilinganda (active=false) shu mahsulot biriktirilgan
// packer'larning FAOL biriktirilgan mahsuloti umuman qolmasa, ular ishlab
// chiqarish kiritishdan jimgina to'silib qoladi ("Mahsulotlar biriktirilmagan").
// Bu funksiya shunday packer'larni topib, admin rolidagi foydalanuvchilarga
// Telegram xabar yuboradi — biriktirmalarni yangilash uchun.
//
// Best-effort: Telegram yoki DB xatosi asosiy PATCH'ni hech qachon yiqitmaydi.

function telegramApiBase(): string {
  return process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
}

async function adminChatIds(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT chat_id FROM user_roles WHERE role = 'admin'`,
  );
  const ids = rows.map((r) => String(r.chat_id));
  if (ids.length === 0 && process.env.ADMIN_CHAT_ID) {
    ids.push(String(process.env.ADMIN_CHAT_ID));
  }
  return [...new Set(ids)];
}

/**
 * Mahsulot nofaol qilingandan KEYIN chaqiriladi (UPDATE allaqachon commit
 * bo'lgan holatda o'qiydi). Shu mahsulot biriktirilgan va endi bitta ham
 * faol biriktirilgan mahsuloti qolmagan packer'lar ro'yxatini qaytaradi.
 */
export async function packersLeftWithoutProducts(
  productName: string,
): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT pa.packer_name
       FROM packer_product_assignments pa
      WHERE pa.product_name = $1
        AND NOT EXISTS (
          SELECT 1
            FROM packer_product_assignments pa2
            JOIN products p ON p.name = pa2.product_name
           WHERE pa2.packer_name = pa.packer_name
             AND p.active = TRUE
        )
      ORDER BY pa.packer_name`,
    [productName],
  );
  return rows.map((r) => String(r.packer_name));
}

/**
 * Mahsulot deaktivatsiyasi packer(lar)ni bo'sh ro'yxat bilan qoldirgan bo'lsa
 * adminlarga Telegram xabar yuboradi. Best-effort: hech qachon throw qilmaydi.
 * @returns xabar yuborilgan packer nomlari (bo'sh — hech kim ta'sirlanmagan)
 */
export async function notifyPackersLeftWithoutProducts(
  productName: string,
): Promise<string[]> {
  try {
    const packers = await packersLeftWithoutProducts(productName);
    if (packers.length === 0) return [];

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return packers;

    const chatIds = await adminChatIds();
    if (chatIds.length === 0) return packers;

    const text =
      `⚠️ Mahsulot nofaol qilindi: ${productName}\n` +
      `Quyidagi packer(lar)da endi bitta ham faol biriktirilgan mahsulot qolmadi ` +
      `va ishlab chiqarish kirita olmaydi:\n` +
      packers.map((p) => `• ${p}`).join("\n") +
      `\nIltimos, packer mahsulot biriktirmalarini yangilang.`;

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
    return packers;
  } catch {
    return [];
  }
}
