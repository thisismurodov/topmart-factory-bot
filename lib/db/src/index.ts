import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "RAILWAY_DATABASE_URL or DATABASE_URL must be set.",
  );
}

export const pool = new Pool({ connectionString, ssl: process.env.RAILWAY_DATABASE_URL ? { rejectUnauthorized: false } : false });
export const db = drizzle(pool, { schema });

export * from "./schema";
