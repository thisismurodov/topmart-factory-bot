import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const router = readFileSync(
  path.join(here, "../src/routes/vehicle-distribution/print-agent-health-router.ts"),
  "utf8",
);
const agent = readFileSync(
  path.join(here, "../../telegram-bot/print-agent/agent.py"),
  "utf8",
);
const printer = readFileSync(
  path.join(here, "../../telegram-bot/print-agent/printer.py"),
  "utf8",
);

describe("print-agent health safety boundary", () => {
  it("heartbeat router never advances label or handoff lifecycle", () => {
    expect(router).not.toMatch(/production_labels|confirmLabels|prepareLabels|print_count/);
    expect(router).not.toMatch(/UPDATE\s+(?:vehicle\.)?vehicle_handoffs/i);
  });

  it("health probe only reads device capabilities and never starts a print job", () => {
    const probe = printer.slice(
      printer.indexOf("def probe_printer_health"),
      printer.indexOf("def _spool_images"),
    );
    expect(probe).toContain("GetDeviceCaps");
    expect(probe).not.toContain("StartDoc");
    expect(probe).not.toContain("StartPage");
  });

  it("periodic callback only probes and posts heartbeat", () => {
    const report = agent.slice(
      agent.indexOf("async def report_health"),
      agent.indexOf("def main"),
    );
    expect(report).toContain("probe_printer_health");
    expect(report).toContain("send_heartbeat");
    expect(report).not.toContain("print_handoff");
    expect(report).not.toContain("print_image");
  });
});