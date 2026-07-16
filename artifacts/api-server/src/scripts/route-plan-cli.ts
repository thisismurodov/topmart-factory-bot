// ── Marshrut rejalashtirish CLI ────────────────────────────────────────────────
// Ishlatish (api-server papkasidan yoki --filter bilan):
//   pnpm --filter @workspace/api-server exec tsx src/scripts/route-plan-cli.ts \
//     --agent 3 [--viloyat "Namangan"] [--save] [--replace]
//
// Endpoint bilan BIR XIL mantiq (routePlanService.runRoutePlan) — eksklyuziv
// egalik qoidasi bilan: boshqa faol agentlarning do'konlari rejaga kirmaydi.
// Oxirida to'liq taqsimot hisoboti chiqaradi (T008 uslubida).
import { pool } from "@workspace/db";
import { runRoutePlan } from "../lib/routePlanService";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const agentId = Number(argValue("--agent"));
  const viloyat = argValue("--viloyat");
  const save = process.argv.includes("--save");
  const replace = process.argv.includes("--replace");

  if (!Number.isInteger(agentId) || agentId <= 0) {
    console.error("--agent <id> majburiy");
    process.exitCode = 1;
    return;
  }

  const run = await runRoutePlan({ agentId, viloyat, save, replace });
  if (!run.ok) {
    console.error(`XATO (${run.status}): ${run.error}`);
    if (run.extra) console.error(JSON.stringify(run.extra, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(`Agent: ${run.agentName} (id=${run.agentId})  viloyat=${run.viloyat ?? "(GPS bo'yicha)"}  saved=${run.saved}`);
  console.log(`Qulflangan (boshqa faol agentda): ${run.lockedElsewhere} ta do'kon — rejaga kiritilmadi`);
  if (run.skippedNoCoord.length > 0) console.log(`Koordinatasiz: ${run.skippedNoCoord.length} ta`);
  if (run.badCoord.length > 0) {
    console.log(`Shubhali GPS (60+ km chetda), rejaga kirmadi: ${run.badCoord.length} ta:`);
    for (const b of run.badCoord) console.log(`  - #${b.id} ${b.nomi ?? "?"} (${b.lat}, ${b.lng})`);
  }
  console.log("");
  for (const r of run.plan.routes) {
    const s = r.stats;
    console.log(
      `kun=${r.kun}: ${s.shopCount} do'kon, ${s.totalKm} km, ${s.totalMinutes} daq (yo'l ${s.driveMinutes} + tashrif ${s.visitMinutes}), ` +
        `kesishish=${s.crossCount}, score=${s.score}, ${s.startShop} → ${s.endShop}`
    );
  }
  console.log("");
  console.log(`Jami: ${run.plan.totalShops} do'kon, ${run.plan.totalKm} km, o'rtacha score=${run.plan.avgScore}`);
  console.log(`Validatsiya: ok=${run.validation.ok}`);
  for (const i of run.validation.issues) console.log(`  XATO: ${i}`);
  for (const w of run.validation.warnings) console.log(`  Ogohlantirish: ${w}`);

  // ── Yakuniy taqsimot hisoboti (barcha faol agentlar bo'yicha) ─────────────────
  const report = await pool.query(`
    WITH faol_dokonlar AS (
      SELECT id FROM distribution.dokonlar WHERE holat IS NULL OR holat <> 'nofaol'
    ),
    egalik AS (
      SELECT r.dokon_id, a.id AS agent_id, a.name
        FROM distribution.delivery_routes r
        JOIN distribution.delivery_agents a ON a.id = r.delivery_agent_id AND a.faol = 1
       GROUP BY r.dokon_id, a.id, a.name
    )
    SELECT
      (SELECT count(*) FROM faol_dokonlar) AS total_shops,
      (SELECT count(DISTINCT dokon_id) FROM egalik) AS assigned,
      (SELECT count(*) FROM faol_dokonlar f WHERE NOT EXISTS (SELECT 1 FROM egalik e WHERE e.dokon_id = f.id)) AS unassigned,
      (SELECT count(*) FROM (SELECT dokon_id FROM egalik GROUP BY dokon_id HAVING count(*) > 1) t) AS duplicates
  `);
  const perAgent = await pool.query(`
    SELECT a.id, a.name, count(DISTINCT r.dokon_id) AS shops, count(DISTINCT r.kun) AS days
      FROM distribution.delivery_agents a
      JOIN distribution.delivery_routes r ON r.delivery_agent_id = a.id
     WHERE a.faol = 1
     GROUP BY a.id, a.name ORDER BY a.id
  `);
  const rep = report.rows[0];
  console.log("");
  console.log("── Yakuniy taqsimot ──");
  console.log(`Jami faol do'konlar: ${rep.total_shops}`);
  for (const a of perAgent.rows) console.log(`  ${a.name} (id=${a.id}): ${a.shops} do'kon / ${a.days} kun`);
  console.log(`Biriktirilgan (jami): ${rep.assigned}`);
  console.log(`Biriktirilmagan: ${rep.unassigned}`);
  console.log(`Dublikat (bir do'kon 2+ faol agentda): ${rep.duplicates}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
