/**
 * Task #95 — Fix outlier GPS shops excluded from routes
 *
 * Background:
 *   During the 2026-08-07 route redistribution (Navruzbek 77 shops / Navruzbek Test 180,
 *   30 per day), the route planner's 60 km outlier filter dropped 4 active shops because
 *   their coordinates were far from the regional median (40.89°N, 71.41°E).
 *
 *   Resolution (confirmed with manager):
 *     - #13 Abusaxiy     (41.2584, 69.1570) — shop no longer exists → deactivate
 *     - #52 Al, hilol    (40.4210, 70.6784) — shop no longer exists → deactivate
 *     - #29 Elyorjon do'koni tappisaroy (40.6511, 70.7475) — real shop, correct coords → add to route
 *     - #51 Sherota      (40.5477, 70.8015) — real shop, correct coords → add to route
 *
 *   Shops #29 and #51 are assigned to Navruzbek (delivery_agent_id = 3).
 *   They are inserted into day 1 (kun=1), which had the fewest stops (25) after the split.
 *
 * Idempotency:
 *   All statements use ON CONFLICT DO NOTHING or WHERE-guarded UPDATEs so the script
 *   can be re-run safely against the production database without side effects.
 *
 * Run:
 *   RAILWAY_DATABASE_URL=<url> pnpm --filter @workspace/api-server tsx src/scripts/fix-outlier-shops-task95.ts
 */

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Deactivate shops that no longer exist
    const deactivate = await client.query(
      `UPDATE distribution.dokonlar
          SET holat = 'nofahol'
        WHERE id IN (13, 52)
          AND holat != 'nofahol'
        RETURNING id, nomi, holat`
    );
    console.log("Deactivated shops:", deactivate.rows);

    // 2. Add existing shops to Navruzbek (delivery_agent_id=3) day-1 route
    //    tartib 26 and 27 follow the existing max of 25 for day 1.
    //    ON CONFLICT DO NOTHING makes this idempotent.
    const insert = await client.query(
      `INSERT INTO distribution.delivery_routes
           (delivery_agent_id, kun, dokon_id, tartib, created_at, added_by_dlv)
         VALUES
           (3, 1, 29, 26, NOW()::text, 1),
           (3, 1, 51, 27, NOW()::text, 1)
         ON CONFLICT (delivery_agent_id, kun, dokon_id) DO NOTHING
         RETURNING delivery_agent_id, kun, dokon_id, tartib`
    );
    console.log("Inserted route rows:", insert.rows);

    await client.query("COMMIT");

    // Verification
    const verify = await client.query(
      `SELECT d.id, d.nomi, d.holat, dr.delivery_agent_id, dr.kun
         FROM distribution.dokonlar d
         LEFT JOIN distribution.delivery_routes dr ON dr.dokon_id = d.id AND dr.delivery_agent_id = 3
        WHERE d.id IN (13, 29, 51, 52)
        ORDER BY d.id`
    );
    console.log("\nFinal state:");
    console.table(verify.rows);

    // Confirm no shop is missing from all routes
    const missing = await client.query(
      `SELECT d.id, d.nomi FROM distribution.dokonlar d
        WHERE d.id IN (29, 51)
          AND NOT EXISTS (
            SELECT 1 FROM distribution.delivery_routes dr WHERE dr.dokon_id = d.id
          )`
    );
    if (missing.rows.length > 0) {
      throw new Error(
        `Shops still missing from routes: ${JSON.stringify(missing.rows)}`
      );
    }
    console.log("\n✓ Shops #29 and #51 are confirmed in delivery_routes.");
    console.log("✓ Shops #13 and #52 are deactivated (nofahol).");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ROLLBACK — error:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
