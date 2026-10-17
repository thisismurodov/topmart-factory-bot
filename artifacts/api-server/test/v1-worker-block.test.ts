import { afterAll, beforeAll, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
const db = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), connect: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: db }));
import workers from "../src/routes/workers";
let server: Server;
let url: string;
beforeAll(async () => {
  db.connect.mockResolvedValue(db);
  const app = express();
  app.use(express.json(), workers);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
it("blocks employee and Telegram role together without deleting history", async () => {
  db.query.mockReset().mockResolvedValue({ rowCount: 1, rows: [{ name: "Test" }] });
  const response = await fetch(url + "/workers/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test" }),
  });
  expect(response.status).toBe(200);
  const sql = db.query.mock.calls.map((c) => c[0]).join("\n");
  expect(sql).toContain("UPDATE workers SET role = 'blocked'");
  expect(sql).toContain("UPDATE user_roles SET role = 'blocked'");
  expect(sql).toContain("COMMIT");
  expect(sql).not.toMatch(/DELETE FROM/);
});
it("rolls back when Telegram revocation fails", async () => {
  db.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.startsWith("UPDATE user_roles")) throw Error("test failure");
    return { rowCount: 1, rows: [] };
  });
  const response = await fetch(url + "/workers/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test" }),
  });
  expect(response.status).toBe(500);
  expect(db.query.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
  expect(db.query.mock.calls.map((c) => c[0])).not.toContain("COMMIT");
});