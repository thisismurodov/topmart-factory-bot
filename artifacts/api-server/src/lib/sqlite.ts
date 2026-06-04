import { DatabaseSync } from "node:sqlite";
import path from "path";

// Path to bot's SQLite DB.
// When running from dist/index.mjs, __dirname = artifacts/api-server/dist/
// Two levels up → artifacts/ → then into telegram-bot/data/
const SQLITE_PATH =
  process.env.SQLITE_DB_PATH ??
  path.resolve(__dirname, "../../telegram-bot/data/topmart.db");

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(SQLITE_PATH);
  }
  return _db;
}

// Map bot rate_type → API rateType
export function toApiRateType(rt: string): string {
  if (rt === "kg") return "per_kg";
  if (rt === "dona") return "per_piece";
  return rt;
}

// Map API rateType → bot rate_type
export function toBotRateType(rt: string): string {
  if (rt === "per_kg") return "kg";
  if (rt === "per_piece") return "dona";
  return rt;
}
