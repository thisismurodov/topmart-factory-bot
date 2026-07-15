import { defineConfig } from "vitest/config";
import path from "path";

// Offline-first modullar (idb, eventQueue, syncEngine) uchun unit testlar.
// fake-indexeddb bilan haqiqiy IndexedDB xatti-harakati simulyatsiya qilinadi.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
  },
});
