import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// build.mjs is the production source-revision implementation under test.
// @ts-expect-error JavaScript build entry intentionally has no declaration file.
import { computeSourceSha256 } from "../build.mjs";

let fixtureDir: string | undefined;

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

async function write(relativePath: string, content: string) {
  if (!fixtureDir) throw new Error("Source revision fixture is not initialized");
  const absolutePath = path.join(fixtureDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

describe("source revision hashing", () => {
  it("ignores every *.tsbuildinfo file but detects committed source changes", async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "topmart-source-revision-"));
    await write("package.json", "{}\n");
    await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await write("pnpm-workspace.yaml", "packages: []\n");
    await write("lib/example.ts", "export const value = 1;\n");
    await write("artifacts/api-server/src/index.ts", "export {};\n");
    await write("artifacts/dashboard/src/main.tsx", "export {};\n");

    const stableHash = await computeSourceSha256(fixtureDir);
    await write("lib/tsconfig.tsbuildinfo", "machine-specific build state");
    await write("artifacts/api-server/cache/custom.tsbuildinfo", "other state");
    expect(await computeSourceSha256(fixtureDir)).toBe(stableHash);

    await write("lib/example.ts", "export const value = 2;\n");
    expect(await computeSourceSha256(fixtureDir)).not.toBe(stableHash);
  });
});