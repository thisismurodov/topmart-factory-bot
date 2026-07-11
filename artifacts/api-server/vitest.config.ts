import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // DB integration tests open real connections; keep them serial and give
    // them a generous timeout so a slow first connect doesn't flake.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Local (Neon) baza suite o'rtasidagi Railway-only bo'limda uxlab
    // qolmasligi uchun keepalive ping (flaky connect xatolarining oldini oladi).
    globalSetup: ["./test/global-setup.ts"],
  },
});
