import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Distribution bot python unit testlarini api-tests to'plamiga ulaydigan wrapper.
// Bot uchun alohida CI yo'q — mavjud konvensiya (distribution-analytics,
// distribution-fresh-db) bo'yicha vitest execFileSync orqali python'ni yuritadi.
//
// tests/ ichidagi testlar DB'siz va tarmoqsiz (pure mock) — throwaway DB shart
// emas, shuning uchun bu wrapper tez (~sekundlar) ishlaydi.
// ─────────────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

describe("distribution-bot python unittests", () => {
  it(
    "unittest discover (tests/) muvaffaqiyatli o'tadi",
    () => {
      try {
        execFileSync(
          "python3",
          ["-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"],
          {
            cwd: distBotDir,
            env: {
              ...process.env,
              TELEGRAM_BOT_TOKEN:
                process.env.TELEGRAM_BOT_TOKEN || "123456:TEST_TOKEN_BOT_UNIT",
            },
            stdio: "pipe",
            encoding: "utf-8",
            timeout: 120_000,
          },
        );
      } catch (e: any) {
        throw new Error(
          `distribution-bot unittest discover yiqildi:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
        );
      }
    },
    180_000,
  );
});
