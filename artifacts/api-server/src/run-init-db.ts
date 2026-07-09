import { pool } from "@workspace/db";
import { initDb } from "./init-db";

// Standalone runner: schema-drift skripti buni tashlanadigan (throwaway)
// bazaga qarshi ishga tushiradi — runtime DDL Drizzle sxemasi bilan solishtiriladi.
initDb()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
