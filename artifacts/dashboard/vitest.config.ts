// Alohida vitest konfiguratsiyasi — vite.config.ts (Replit pluginlari bilan)
// test muhitida yuklanmaydi. Faqat sof birlik testlar uchun.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
