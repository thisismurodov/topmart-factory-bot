// ── Ikki agentga hududiy bo'lib marshrut tuzish (bir martalik CLI) ─────────────
// Ishlatish:
//   pnpm --filter @workspace/api-server exec tsx src/scripts/route-split-cli.ts \
//     --primary 5 --primary-max 180 --secondary 3 [--target 30] [--save]
//
// Mantiq:
//   1. Barcha bo'sh koordinatali faol do'konlar olinadi (GPS outlierlar chiqariladi)
//   2. splitTerritories bilan ikki GEOGRAFIK ZICH zonaga bo'linadi:
//      primary agent → maksimum --primary-max ta do'kon, qolgani secondary agentga
//   3. Har zona uchun planRoutes (kunlik ~target ta) + validatePlan
//   4. --save bo'lsa: har ikki agent marshruti tranzaksiyada DELETE+INSERT qilinadi
import { pool } from "@workspace/db";
import {
  DEFAULT_START_POINT,
  planRoutes,
  splitOutliers,
  splitTerritories,
  validatePlan,
  type PlanShop,
  type PlanResult,
} from "../lib/routePlanner";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// Ikkala agent rejasi BITTA tranzaksiyada saqlanadi — yarim holat qolmaydi
async function saveBothPlans(items: { agentId: number; plan: PlanResult }[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const nowIso = new Date()
      .toLocaleString("sv-SE", { timeZone: "Asia/Tashkent" })
      .replace(" ", "T");
    for (const { agentId } of items) {
      await client.query(`DELETE FROM distribution.delivery_routes WHERE delivery_agent_id = $1`, [agentId]);
    }
    for (const { agentId, plan } of items) {
      for (const r of plan.routes) {
        for (const st of r.stops) {
          await client.query(
            `INSERT INTO distribution.delivery_routes (delivery_agent_id, kun, dokon_id, tartib, created_at, added_by_dlv)
             VALUES ($1, $2, $3, $4, $5, 0)`,
            [agentId, r.kun, st.id, st.tartib, nowIso]
          );
        }
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function printPlan(label: string, plan: PlanResult): void {
  console.log(`\n── ${label} ──`);
  for (const r of plan.routes) {
    const s = r.stats;
    console.log(
      `kun=${r.kun}: ${s.shopCount} do'kon, ${s.totalKm} km, ${s.totalMinutes} daq, kesishish=${s.crossCount}, score=${s.score}`
    );
  }
  console.log(`Jami: ${plan.totalShops} do'kon, ${plan.totalKm} km, o'rtacha score=${plan.avgScore}`);
}

async function main(): Promise<void> {
  const primaryId = Number(argValue("--primary"));
  const secondaryId = Number(argValue("--secondary"));
  const primaryMax = Number(argValue("--primary-max") ?? 180);
  const targetSize = Number(argValue("--target") ?? 30);
  const save = process.argv.includes("--save");

  if (!Number.isInteger(primaryId) || !Number.isInteger(secondaryId) || primaryId === secondaryId) {
    console.error("--primary <id> va --secondary <id> majburiy (har xil bo'lsin)");
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(primaryMax) || primaryMax <= 0 || !Number.isInteger(targetSize) || targetSize <= 0) {
    console.error("--primary-max va --target musbat butun son bo'lishi kerak");
    process.exitCode = 1;
    return;
  }

  const agentsQ = await pool.query(
    `SELECT id, name, faol FROM distribution.delivery_agents WHERE id = ANY($1::int[])`,
    [[primaryId, secondaryId]]
  );
  const byId = new Map(agentsQ.rows.map((r) => [Number(r.id), r]));
  for (const id of [primaryId, secondaryId]) {
    const a = byId.get(id);
    if (!a) { console.error(`Agent id=${id} topilmadi`); process.exitCode = 1; return; }
    if (Number(a.faol) !== 1) { console.error(`Agent ${a.name} (id=${id}) nofaol`); process.exitCode = 1; return; }
  }

  const shopsQ = await pool.query(
    `SELECT id, nomi, hudud, latitude, longitude
       FROM distribution.dokonlar
      WHERE (holat IS NULL OR holat <> 'nofaol')
      ORDER BY id`
  );
  const withCoord: PlanShop[] = shopsQ.rows
    .filter((r) => r.latitude != null && r.longitude != null)
    .map((r) => ({ id: Number(r.id), nomi: r.nomi, hudud: r.hudud, lat: Number(r.latitude), lng: Number(r.longitude) }));
  const noCoord = shopsQ.rows.length - withCoord.length;

  const { inliers, outliers } = splitOutliers(withCoord);
  console.log(`Faol do'konlar: ${shopsQ.rows.length} (koordinatasiz: ${noCoord}, shubhali GPS: ${outliers.length})`);
  for (const b of outliers) console.log(`  Shubhali GPS, rejaga kirmadi: #${b.id} ${b.nomi ?? "?"} (${b.lat}, ${b.lng})`);

  const primaryCount = Math.min(primaryMax, inliers.length);
  const secondaryCount = inliers.length - primaryCount;
  const zones = secondaryCount > 0
    ? splitTerritories(inliers, [primaryCount, secondaryCount])
    : [inliers, []];

  const primaryPlan = planRoutes(zones[0], { targetSize, startPoint: DEFAULT_START_POINT });
  const secondaryPlan = planRoutes(zones[1], { targetSize, startPoint: DEFAULT_START_POINT });

  const pv = validatePlan(primaryPlan, zones[0]);
  const sv = validatePlan(secondaryPlan, zones[1]);

  printPlan(`${byId.get(primaryId)!.name} (id=${primaryId})`, primaryPlan);
  console.log(`Validatsiya: ok=${pv.ok}`);
  pv.issues.forEach((i) => console.log(`  XATO: ${i}`));
  pv.warnings.forEach((w) => console.log(`  Ogohlantirish: ${w}`));

  printPlan(`${byId.get(secondaryId)!.name} (id=${secondaryId})`, secondaryPlan);
  console.log(`Validatsiya: ok=${sv.ok}`);
  sv.issues.forEach((i) => console.log(`  XATO: ${i}`));
  sv.warnings.forEach((w) => console.log(`  Ogohlantirish: ${w}`));

  if (!save) {
    console.log("\n(--save berilmadi — hech narsa saqlanmadi)");
    return;
  }
  if (!pv.ok || !sv.ok) {
    console.error("\nReja sifat tekshiruvidan o'tmadi — saqlanmadi.");
    process.exitCode = 1;
    return;
  }
  if (zones[1].length === 0 && !process.argv.includes("--allow-empty-secondary")) {
    console.error(
      "\nSecondary agent zonasi bo'sh — saqlash uning butun marshrutini o'chirib yuborardi. " +
        "Ataylab shu kerak bo'lsa --allow-empty-secondary bayrog'ini qo'shing."
    );
    process.exitCode = 1;
    return;
  }
  // Boshqa FAOL agentlar egallagan do'konlar rejaga kirmasin (eksklyuzivlik)
  const lockedQ = await pool.query(
    `SELECT DISTINCT r.dokon_id
       FROM distribution.delivery_routes r
       JOIN distribution.delivery_agents a ON a.id = r.delivery_agent_id
      WHERE a.faol = 1 AND r.delivery_agent_id NOT IN ($1, $2)`,
    [primaryId, secondaryId]
  );
  const locked = new Set<number>(lockedQ.rows.map((r) => Number(r.dokon_id)));
  const overlap = [...primaryPlan.routes, ...secondaryPlan.routes]
    .flatMap((r) => r.stops)
    .filter((st) => locked.has(st.id));
  if (overlap.length > 0) {
    console.error(`\n${overlap.length} ta do'kon boshqa faol agent marshrutida — saqlanmadi.`);
    process.exitCode = 1;
    return;
  }
  await saveBothPlans([
    { agentId: primaryId, plan: primaryPlan },
    { agentId: secondaryId, plan: secondaryPlan },
  ]);
  console.log("\nSaqlandi: ikkala agent marshruti yangilandi (bitta tranzaksiyada).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
