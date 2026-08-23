import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type LocalTestPostgres = {
  url: string;
  stop: () => Promise<void>;
};

function postgresBinDir(): string {
  const candidates = readdirSync("/nix/store")
    .filter((name) => /-postgresql-16(?:\.|$)/.test(name))
    .map((name) => path.join("/nix/store", name, "bin"))
    .filter((dir) => existsSync(path.join(dir, "initdb")) && existsSync(path.join(dir, "pg_ctl")));
  if (candidates.length === 0) {
    throw new Error("PostgreSQL 16 tools are unavailable for isolated test databases");
  }
  return candidates.sort().at(-1)!;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForPostgres(url: string, logPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  throw new Error(`Isolated PostgreSQL did not start: ${String(lastError)}\n${log}`);
}

export async function provisionLocalTestPostgres(
  explicitUrl = process.env.VEHICLE_TEST_DATABASE_ADMIN_URL,
): Promise<LocalTestPostgres> {
  if (explicitUrl) {
    const host = new URL(explicitUrl).hostname;
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error("VEHICLE_TEST_DATABASE_ADMIN_URL must use a loopback host");
    }
    return { url: explicitUrl, stop: async () => {} };
  }

  const binDir = postgresBinDir();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "topmart-test-pg-"));
  const logPath = path.join(dataDir, "postgres.log");
  const port = await freePort();
  try {
    execFileSync(path.join(binDir, "initdb"), [
      "-D",
      dataDir,
      "-A",
      "trust",
      "--no-locale",
      "-E",
      "UTF8",
      "-U",
      "postgres",
    ], { stdio: "ignore" });
    try {
      execFileSync(path.join(binDir, "pg_ctl"), [
        "-D",
        dataDir,
        "-l",
        logPath,
        "-o",
        `-h 127.0.0.1 -k ${dataDir} -p ${port} -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
        "-w",
        "start",
      ], { stdio: "ignore" });
    } catch (error) {
      const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      throw new Error(`Unable to start isolated PostgreSQL: ${String(error)}\n${log}`);
    }
    const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    await waitForPostgres(url, logPath);
    let stopped = false;
    return {
      url,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        execFileSync(path.join(binDir, "pg_ctl"), [
          "-D",
          dataDir,
          "-m",
          "fast",
          "-w",
          "stop",
        ], { stdio: "ignore" });
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (existsSync(path.join(dataDir, "postmaster.pid"))) {
      execFileSync(path.join(binDir, "pg_ctl"), [
        "-D",
        dataDir,
        "-m",
        "immediate",
        "stop",
      ], { stdio: "ignore" });
    }
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}