import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Distribution bot python unit testlarini api-tests to'plamiga ulaydigan wrapper.
// Bot uchun alohida CI yo'q — mavjud konvensiya (distribution-analytics,
// distribution-fresh-db) bo'yicha vitest execFileSync orqali python'ni yuritadi.
//
// Pure bot tests share one process. The DB-backed F7 integration runs in a
// separate process so its child DATABASE_URL is applied before connection.py
// is imported; unittest discovery would otherwise reuse the pure tests' cached
// connection module.
// ─────────────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

describe("distribution-bot python unittests", () => {
  const runPython = (modules: string[]) =>
    execFileSync("python3", ["-m", "unittest", ...modules, "-v"], {
      cwd: distBotDir,
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN:
          process.env.TELEGRAM_BOT_TOKEN || "123456:TEST_TOKEN_BOT_UNIT",
      },
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 120_000,
    });

  it(
    "pure va F7 integration testlari isolated processlarda o'tadi",
    () => {
      try {
        runPython([
          "tests.test_ai_tavsiyalar",
          "tests.test_vehicle_pilot_bot_f7",
        ]);
        runPython(["tests.test_vehicle_pilot_sale_f7"]);
      } catch (e: any) {
        throw new Error(
          `distribution-bot unittest yiqildi:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
        );
      }
    },
    180_000,
  );
});
