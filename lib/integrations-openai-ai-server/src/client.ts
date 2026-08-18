import OpenAI from "openai";

// AI_INTEGRATIONS_OPENAI_* o'zgaruvchilari Replit'ning ICHKI proksi manziliga
// (http://127.0.0.1:...) ishora qiladi va faqat Replit muhitida (workspace va
// Replit deployment) mavjud. Tashqi serverlarda (masalan, Railway) bu proksi
// yo'q — shuning uchun klient import paytida EMAS, faqat birinchi AI
// chaqiruvida yaratiladi (lazy). Env yo'q bo'lsa: server bemalol ishga
// tushaveradi, AI chaqiruvi esa aniq xato bilan to'xtaydi (jim fallback yo'q).
let _client: OpenAI | null = null;

function ensureClient(): OpenAI {
  if (_client) return _client;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error(
      "AI o'chirilgan: AI_INTEGRATIONS_OPENAI_BASE_URL / AI_INTEGRATIONS_OPENAI_API_KEY " +
        "o'rnatilmagan. Bu o'zgaruvchilar faqat Replit muhitida mavjud (ichki proksi); " +
        "tashqi serverlarda (Railway) AI funksiyalari ishlamaydi.",
    );
  }
  _client = new OpenAI({ apiKey, baseURL });
  return _client;
}

// Proxy — mavjud `openai.chat.completions.create(...)` chaqiruv joylarini
// o'zgartirmaslik uchun: birinchi property murojaatida haqiqiy klient yaratiladi.
export const openai: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop) {
    const client = ensureClient();
    const value = Reflect.get(client, prop, client) as unknown;
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(client)
      : value;
  },
});
