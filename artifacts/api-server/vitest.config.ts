import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // DB integration tests open real connections; keep them serial and give
    // them a generous timeout so a slow first connect doesn't flake.
    fileParallelism: false,
    // Integration tests hit a shared remote Postgres; multi-step F4 flows
    // (prepare N units + confirm + transitions) can take well over 30s there.
    testTimeout: 90000,
    hookTimeout: 60000,
    // Local (Neon) baza suite o'rtasidagi Railway-only bo'limda uxlab
    // qolmasligi uchun keepalive ping (flaky connect xatolarining oldini oladi).
    globalSetup: ["./test/global-setup.ts"],
  },
});
