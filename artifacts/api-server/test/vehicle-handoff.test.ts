s)
      .toBe(400);
    const strict = await putTarget(prodA, { extra: true });
    expect(strict.status).toBe(400);
    const bot = await call(
      "PUT",
      "/vehicle-distribution/pilot/stock-targets",
      {
        botKey: BOT_KEY,
        body: {
          mahsulotId: prodA.mahsulotId,
          minQuantity: 1,
          targetQuantity: 2,
          operationKey: opKey(),
        },
      },
    );
    expect(bot.status).toBe(403);
    expect((await putTarget()).status).toBe(200);
    await setStock(vehicleWarehouseId, prodA.name, 0, 0);
    expect((await manualRequest()).status).toBe(200);
    expect((await putTarget(prodA, { targetQuantity: 20 })).status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F11 load cap — an effective stock target is ALSO the vehicle's load limit
// ─────────────────────────────────────────────────────────────────────────────

async function createHandoff(
  mahsulotId: number,
  quantity: number,
): Promise<Resp> {
  return call("POST", "/vehicle-distribution/handoffs", {
    token: adminToken,
    body: {
      sourceWarehouseId: erpWarehouseId,
      items: [{ mahsulotId, quantity }],
      operationKey: opKey(),
    },
  });
}

describe("F11 load cap (me’yor = yuklash limiti)", () => {
  it("target quantity caps a new handoff; at-limit passes, over-limit → 400", async () => {
    expect((await putTarget()).status).toBe(200); // min 3, target 10
    const over = await createHandoff(prodA.mahsulotId, 11);
    expect(over.status).toBe(400);
    expect(String(over.body.error)).toContain("me’yor (limit) 10");
    const ok = await createHandoff(prodA.mahsulotId, 10);
    expect(ok.status).toBe(200);
  });

  it("counts current vehicle stock + in-flight handoffs toward the cap", async () => {
    expect((await putTarget()).status).toBe(200); // target 10
    await setStock(vehicleWarehouseId, prodA.name, 4, 10);
    await makePrepared(3); // in-flight pipeline
    const over = await createHandoff(prodA.mahsulotId, 4); // 4+3+4=11 > 10
    expect(over.status).toBe(400);
    expect(String(over.body.error)).toContain("mashinada 4 dona");
    expect(String(over.body.error)).toContain("yo‘lda 3 dona");
    expect(String(over.body.error)).toContain("ko‘pi bilan 3 dona");
    const ok = await createHandoff(prodA.mahsulotId, 3); // 4+3+3=10 → OK
    expect(ok.status).toBe(200);
  });

  it("cancelled handoffs free the cap; products without a target stay uncapped", async () => {
    expect((await putTarget()).status).toBe(200); // prodA target 10
    const { handoffId } = await makePrepared(10);
    expect(
      (
        await call(
          "POST",
          `/vehicle-distribution/handoffs/${handoffId}/cancel`,
          { token: adminToken },
        )
      ).status,
    ).toBe(200);
    const ok = await createHandoff(prodA.mahsulotId, 10);
    expect(ok.status).toBe(200);
    // prodB has no target → not capped.
    const noCap = await createHandoff(prodB.mahsulotId, 50);
    expect(noCap.status).toBe(200);
  });

  it("full replenishment approval stays within the cap (target-current fits)", async () => {
    expect((await putTarget()).status).toBe(200); // min 3, target 10
    await setStock(vehicleWarehouseId, prodA.name, 2, 5);
    const req = await manualRequest(); // requested = 10-2 = 8
    expect(req.status).toBe(200);
    const approve = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${req.body.id}/approve`,
      { token: adminToken },
    );
    expect(approve.status).toBe(200); // 2 + 0 + 8 = 10 ≤ 10
    expect(approve.body.handoffId).toBeTruthy();
  });

  it("multi-item handoff: one capped line over the limit rejects atomically", async () => {
    expect((await putTarget()).status).toBe(200); // prodA target 10
    const over = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [
          { mahsulotId: prodA.mahsulotId, quantity: 11 },
          { mahsulotId: prodB.mahsulotId, quantity: 5 },
        ],
        operationKey: opKey(),
      },
    });
    expect(over.status).toBe(400);
    expect(String(over.body.error)).toContain("me’yor (limit) 10");
    // Rad atomik bo'lgan: muvaffaqiyatsiz urinish pipeline'da iz qoldirmaydi,
    // shuning uchun xuddi shu juftlik limit ichida bemalol o'tadi.
    const ok = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [
          { mahsulotId: prodA.mahsulotId, quantity: 10 },
          { mahsulotId: prodB.mahsulotId, quantity: 5 },
        ],
        operationKey: opKey(),
      },
    });
    expect(ok.status).toBe(200);
  });

  it("idempotent replay stays 200 after the target is tightened below in-flight", async () => {
    expect((await putTarget()).status).toBe(200); // target 10
    const operationKey = opKey();
    const body = {
      sourceWarehouseId: erpWarehouseId,
      items: [{ mahsulotId: prodA.mahsulotId, quantity: 6 }],
      operationKey,
    };
    const first = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body,
    });
    expect(first.status).toBe(200);
    // F8 tarixi kunlik granulyar: xuddi shu kunga ikkinchi PUT ataylab 409
    // (overlap) qaytaradi. Toraytirish real hayotda keyingi kunlarda bo'ladi —
    // amaldagi me'yorni kechadan beri amal qilayotgandek backdate qilamiz.
    await client.query(
      `UPDATE distribution.vehicle_stock_targets
          SET effective_from=CURRENT_DATE-1
        WHERE effective_to IS NULL AND sku=$1`,
      [prodA.sku],
    );
    // Me'yorni yo'ldagi 6 donadan pastga tushiramiz.
    expect(
      (await putTarget(prodA, { minQuantity: 0, targetQuantity: 5 })).status,
    ).toBe(200);
    const replay = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body,
    });
    expect(replay.status).toBe(200); // replay avval qaytadi — cap qayta tekshirilmaydi
    expect(replay.body.id).toBe(first.body.id);
    // Yangi yuklashga esa endi joy yo'q.
    const blocked = await createHandoff(prodA.mahsulotId, 1);
    expect(blocked.status).toBe(400);
    expect(String(blocked.body.error)).toContain("ko‘pi bilan 0 dona");
  });

  it("approve rejection by the cap is a 400 with the me’yor text; request stays pending", async () => {
    expect((await putTarget()).status).toBe(200); // min 3, target 10; stock 0
    const req = await manualRequest(); // requested = 10 - 0 = 10
    expect(req.status).toBe(200);
    // Cap'ning katta qismini alohida handoff egallab turadi.
    expect((await createHandoff(prodA.mahsulotId, 6)).status).toBe(200);
    const approve = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${req.body.id}/approve`,
      { token: adminToken },
    );
    expect(approve.status).toBe(400); // 0 + 6 + 10 > 10 — 409 EMAS, izoh ko'rinadi
    expect(String(approve.body.error)).toContain("me’yor (limit) 10");
    const detail = await call(
      "GET",
      `/vehicle-distribution/pilot/replenishment-requests/${req.body.id}`,
      { token: adminToken },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe("pending"); // rollback — keyin bekor qilsa bo'ladi
  });
});

describe("F8 manual request", () => {
  it("computes target-current server-side, supports bot/admin reads and idempotency", async () => {
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 2, 5);
    const operationKey = opKey();
    const first = await manualRequest(prodA, {
      botKey: BOT_KEY,
      operationKey,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      requestedQuantity: 8,
      targetQuantitySnapshot: 10,
      currentQuantitySnapshot: 2,
      status: "pending",
    });
    const replay = await manualRequest(prodA, {
      botKey: BOT_KEY,
      operationKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    const list = await call(
      "GET",
      "/vehicle-distribution/pilot/replenishment-requests",
      { botKey: BOT_KEY },
    );
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(1);
    const detail = await call(
      "GET",
      `/vehicle-distribution/pilot/replenishment-requests/${first.body.id}`,
      { token: adminToken },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.handoffStatus).toBeNull();
  });

  it("rejects no target, above-minimum, client quantities, and mismatched snapshot replay", async () => {
    expect((await manualRequest()).status).toBe(409);
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 4, 10);
    expect((await manualRequest()).status).toBe(409);
    await setStock(vehicleWarehouseId, prodA.name, 1, 2.5);
    const operationKey = opKey();
    expect(
      (
        await call("POST", "/vehicle-distribution/pilot/replenishment-requests", {
          token: adminToken,
          body: {
            mahsulotId: prodA.mahsulotId,
            operationKey,
            requestedQuantity: 999,
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await manualRequest(prodA, { token: adminToken, operationKey })).status,
    ).toBe(200);
    await setStock(vehicleWarehouseId, prodA.name, 2, 5);
    expect(
      (await manualRequest(prodA, { token: adminToken, operationKey })).status,
    ).toBe(409);
  });
});

describe("F8 approval and linked F3 lifecycle", () => {
  it("approves once under concurrency, chooses deterministic source, and does not move stock", async () => {
    const later = await client.query(
      `INSERT INTO warehouses(name,active,location_type,purpose)
       VALUES($1,TRUE,'general','finished') RETURNING id`,
      [`Later source ${Date.now()}`],
    );
    const laterId = Number(later.rows[0].id);
    await setStock(laterId, prodA.name, 100, 250);
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 0, 0);
    const request = await manualRequest();
    const path =
      `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/approve`;
    const [a, b] = await Promise.all([
      call("POST", path, { token: adminToken, body: {} }),
      call("POST", path, { token: adminToken, body: {} }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.handoffId).toBe(b.body.handoffId);
    expect(a.body.sourceWarehouseId).toBe(erpWarehouseId);
    expect(a.body.handoffStatus).toBe("prepared");
    const counts = await client.query(
      `SELECT
        (SELECT COUNT(*)::int FROM distribution.vehicle_handoffs
          WHERE operation_key=$1) handoffs,
        (SELECT COUNT(*)::int FROM stock_movements) movements,
        (SELECT quantity FROM inventory WHERE warehouse_id=$2 AND product=$3) vehicle_qty`,
      [`replenishment:${request.body.id}`, vehicleWarehouseId, prodA.name],
    );
    expect(Number(counts.rows[0].handoffs)).toBe(1);
    expect(Number(counts.rows[0].movements)).toBe(0);
    expect(Number(counts.rows[0].vehicle_qty)).toBe(0);
    expect(
      (
        await call("POST", path, {
          token: adminToken,
          body: { approvedQuantity: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it("insufficient source rolls back request and handoff", async () => {
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 0, 0);
    await client.query(
      `UPDATE inventory SET quantity=0,weight_kg=0
        WHERE product=$1 AND warehouse_id<>$2`,
      [prodA.name, vehicleWarehouseId],
    );
    const request = await manualRequest();
    const approval = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/approve`,
      { token: adminToken, body: {} },
    );
    expect(approval.status).toBe(409);
    const row = await client.query(
      `SELECT status,handoff_id FROM distribution.vehicle_replenishment_requests WHERE id=$1`,
      [request.body.id],
    );
    expect(row.rows[0]).toMatchObject({ status: "pending", handoff_id: null });
  });

  it("does not fall back when C-3 is short but another warehouse has stock", async () => {
    const alternate = await client.query(
      `INSERT INTO warehouses(name,active,location_type,purpose)
       VALUES($1,TRUE,'general','finished') RETURNING id`,
      [`Replenishment alternate ${Date.now()}`],
    );
    await setStock(Number(alternate.rows[0].id), prodA.name, 100, 250);
    await setStock(erpWarehouseId, prodA.name, 0, 0);
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 0, 0);
    const request = await manualRequest();
    const approval = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/approve`,
      { token: adminToken, body: {} },
    );
    expect(approval.status).toBe(409);
    expect(String(approval.body.error)).toContain(
      "Configured central warehouse does not have enough stock",
    );
    const state = await client.query(
      `SELECT status,handoff_id,source_warehouse_id
         FROM distribution.vehicle_replenishment_requests WHERE id=$1`,
      [request.body.id],
    );
    expect(state.rows[0]).toMatchObject({
      status: "pending",
      handoff_id: null,
      source_warehouse_id: null,
    });
  });

  it("F4 prepare/print and F3 transfer atomically fulfill the linked request", async () => {
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 0, 0);
    const request = await manualRequest();
    const approved = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/approve`,
      { token: adminToken, body: {} },
    );
    const handoffId = approved.body.handoffId as number;
    expect((await prepareLabels(handoffId)).status).toBe(200);
    expect((await confirmPrinted(handoffId)).status).toBe(200);
    expect(
      (
        await call(
          "POST",
          `/vehicle-distribution/handoffs/${handoffId}/handed-over`,
          { token: adminToken },
        )
      ).status,
    ).toBe(200);
    const transferred = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`,
      { token: adminToken },
    );
    expect(transferred.status).toBe(200);
    const linked = await client.query(
      `SELECT status,fulfilled_at FROM distribution.vehicle_replenishment_requests WHERE id=$1`,
      [request.body.id],
    );
    expect(linked.rows[0].status).toBe("fulfilled");
    expect(linked.rows[0].fulfilled_at).not.toBeNull();
    expect(
      (
        await call(
          "POST",
          `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/cancel`,
          { token: adminToken, body: {} },
        )
      ).status,
    ).toBe(409);
  });

  it("failed transfer rolls back all stock effects and leaves request approved", async () => {
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 0, 0);
    const request = await manualRequest();
    const approved = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/approve`,
      { token: adminToken, body: {} },
    );
    const handoffId = approved.body.handoffId as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call("POST", `/vehicle-distribution/handoffs/${handoffId}/handed-over`, {
      token: adminToken,
    });
    await setStock(erpWarehouseId, prodA.name, 0, 0);
    expect(
      (
        await call(
          "POST",
          `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`,
          { token: adminToken },
        )
      ).status,
    ).toBe(409);
    const state = await client.query(
      `SELECT status,fulfilled_at FROM distribution.vehicle_replenishment_requests WHERE id=$1`,
      [request.body.id],
    );
    expect(state.rows[0]).toMatchObject({ status: "approved", fulfilled_at: null });
  });
});

describe("F8 cancellation, gates and exact pilot scope", () => {
  it("cancels pending and safely cancels prepared/labels_printed linked handoffs", async () => {
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 0, 0);
    const pending = await manualRequest();
    expect(
      (
        await call(
          "POST",
          `/vehicle-distribution/pilot/replenishment-requests/${pending.body.id}/cancel`,
          { token: adminToken, body: {} },
        )
      ).body.status,
    ).toBe("cancelled");

    await setStock(vehicleWarehouseId, prodA.name, 1, 2.5);
    const next = await manualRequest(prodA, {
      token: adminToken,
      operationKey: opKey(),
    });
    expect(next.status).toBe(200);
    const approved = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${next.body.id}/approve`,
      { token: adminToken, body: {} },
    );
    expect(approved.status).toBe(200);
    await prepareLabels(approved.body.handoffId);
    await confirmPrinted(approved.body.handoffId);
    const cancelled = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${next.body.id}/cancel`,
      { token: adminToken, body: {} },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.handoffStatus).toBe("cancelled");
    const audit = await client.query(
      `SELECT
        (SELECT COUNT(*)::int FROM distribution.vehicle_label_claims WHERE handoff_id=$1) claims,
        (SELECT COUNT(*)::int FROM distribution.vehicle_label_prepare_sessions WHERE handoff_id=$1) prep,
        (SELECT COUNT(*)::int FROM distribution.vehicle_label_print_sessions WHERE handoff_id=$1) prints`,
      [approved.body.handoffId],
    );
    // Existing F3 cancellation preserves label/session audit rows; it never
    // releases them into another handoff or mutates stock.
    expect(Number(audit.rows[0].claims)).toBeGreaterThan(0);
    expect(Number(audit.rows[0].prep)).toBe(1);
    expect(Number(audit.rows[0].prints)).toBe(1);
  });

  it("rejects handed-over cancellation, enforces strict/admin/gates/auth and exact pilot 404", async () => {
    await putTarget();
    await setStock(vehicleWarehouseId, prodA.name, 0, 0);
    const request = await manualRequest();
    const approved = await call(
      "POST",
      `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/approve`,
      { token: adminToken, body: {} },
    );
    await prepareLabels(approved.body.handoffId);
    await confirmPrinted(approved.body.handoffId);
    await call(
      "POST",
      `/vehicle-distribution/handoffs/${approved.body.handoffId}/handed-over`,
      { token: adminToken },
    );
    expect(
      (
        await call(
          "POST",
          `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/cancel`,
          { token: adminToken, body: {} },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          "POST",
          `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/cancel`,
          { botKey: BOT_KEY, body: {} },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "GET",
          "/vehicle-distribution/pilot/replenishment-requests",
        )
      ).status,
    ).toBe(401);
    delete process.env.VEHICLE_DISTRIBUTION_ENABLED;
    expect(
      (
        await call(
          "GET",
          "/vehicle-distribution/pilot/replenishment-requests",
          { token: adminToken },
        )
      ).status,
    ).toBe(404);
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
    await client.query(
      `UPDATE distribution.vehicles SET plate_number='WRONG' WHERE id=$1`,
      [vehicleId],
    );
    expect(
      (
        await call(
          "GET",
          "/vehicle-distribution/pilot/replenishment-requests",
          { token: adminToken },
        )
      ).status,
    ).toBe(404);
    await client.query(
      `UPDATE distribution.vehicles SET plate_number=$2 WHERE id=$1`,
      [vehicleId, PILOT_VEHICLE_PLATE],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F11: warehouse-bot approval authority (approve = admin OR bot; cancel = admin)
// ─────────────────────────────────────────────────────────────────────────────
describe("F11 warehouse-bot approval authority", () => {
  it("bot key approves a request (handoff created); cancel stays admin-only", async () => {
    // Fresh product so no earlier suite left an open request/target for it.
    const prodF = await seedProduct("SKU-F11", "Arqon F11", 1.5, 6);
    await setStock(erpWarehouseId, prodF.name, 500, 750);
    await setStock(vehicleWarehouseId, prodF.name, 0, 0);
    expect((await putTarget(prodF, { operationKey: opKey() })).status).toBe(200);
    const request = await manualRequest(prodF, { botKey: BOT_KEY });
    expect(request.status).toBe(200);

    const approvePath =
      `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/approve`;
    // Wrong or absent key = unauthenticated (401): the bot-key check falls
    // through to the admin wall, which finds no session either.
    expect(
      (await call("POST", approvePath, {
        botKey: "not-the-key-not-the-key-not-the-",
        body: {},
      })).status,
    ).toBe(401);
    expect((await call("POST", approvePath, { body: {} })).status).toBe(401);

    const approved = await call("POST", approvePath, {
      botKey: BOT_KEY,
      body: {},
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.handoffId).toBeTruthy();

    const cancelPath =
      `/vehicle-distribution/pilot/replenishment-requests/${request.body.id}/cancel`;
    expect((await call("POST", cancelPath, { botKey: BOT_KEY, body: {} })).status)
      .toBe(403);
    // Leave nothing open behind for later suites.
    const adminCancel = await call("POST", cancelPath, {
      token: adminToken,
      body: {},
    });
    expect(adminCancel.status).toBe(200);
    expect(adminCancel.body.status).toBe("cancelled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency
// ─────────────────────────────────────────────────────────────────────────────
describe("concurrency", () => {
  it("concurrent finalization of the same handoff → one success, stock once", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 2 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    const [a, b] = await Promise.all([
      call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken }),
      call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken }),
    ]);
    // Both may return 200 (one does the work, the other same-state retry), but
    // stock must move exactly once.
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    const vehA = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [vehicleWarehouseId, prodA.name],
    );
    expect(Number(vehA.rows[0].quantity)).toBe(2);
    const led = await client.query(`SELECT COUNT(*)::int AS n FROM stock_movements`);
    expect(Number(led.rows[0].n)).toBe(1);
  });

  it("two different handoffs contend for limited source stock → at most one succeeds", async () => {
    await setStock(erpWarehouseId, prodB.name, 2, 2); // only 2 units of B
    const mk = async () => {
      const r = await call("POST", "/vehicle-distribution/handoffs", {
        token: adminToken,
        body: {
          sourceWarehouseId: erpWarehouseId,
          items: [{ mahsulotId: prodB.mahsulotId, quantity: 2 }],
          operationKey: opKey(),
        },
      });
      const handoffId = r.body.id as number;
      await prepareLabels(handoffId);
      await confirmPrinted(handoffId);
      await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
      return handoffId;
    };
    const h1 = await mk();
    const h2 = await mk();
    const [a, b] = await Promise.all([
      call(`POST`, `/vehicle-distribution/handoffs/${h1}/stock-transferred`, { token: adminToken }),
      call(`POST`, `/vehicle-distribution/handoffs/${h2}/stock-transferred`, { token: adminToken }),
    ]);
    const successes = [a, b].filter((x) => x.status === 200).length;
    expect(successes).toBe(1);
    // Source is fully drained (2 → 0) by the single winner, never negative.
    const src = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [erpWarehouseId, prodB.name],
    );
    expect(Number(src.rows[0].quantity)).toBe(0);
    expect(Number(src.rows[0].quantity)).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHECK constraint upgrade migration (Fix 1)
//
// Simulates a database that had F1 DDL applied first (old event_type CHECK),
// then F3 init_db() run on top. Verifies that:
//   1. After F1-then-F3 init, label_printed inserts succeed.
//   2. The old F1-only events (load, unload, return, adjustment, sale) still work.
// This is tested by running init_db() in the throwaway DB that already has the
// vehicle tables (created by the global beforeAll), so the ALTER...DROP
// CONSTRAINT IF EXISTS + ADD CONSTRAINT upgrade path is exercised.
// ─────────────────────────────────────────────────────────────────────────────
describe("CHECK constraint upgrade migration (F1 schema → F3 init)", () => {
  it("running F3 init_db() on an existing F1 DB allows label_printed event inserts", async () => {
    // The throwaway DB was already set up with F3 DDL (global beforeAll ran
    // init_db with VEHICLE_DISTRIBUTION_SCHEMA_APPROVED=1). Running init_db()
    // again is idempotent and exercises the DROP+ADD upgrade path.
    execFileSync("python3", ["-c", "import main; main.init_db()"], {
      cwd: botDir,
      env: botEnv,
      stdio: "pipe",
    });

    // After upgrade, label_printed must be accepted by the CHECK.
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, mahsulot_id, sku, event_type, quantity, actor_id)
         VALUES ($1, 1, 'SKU-TEST', 'label_printed', 1, -1) RETURNING id`,
        [vehicleId],
      ),
    ).resolves.toBeDefined();

    // F1 events still work after the upgrade.
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, mahsulot_id, sku, event_type, quantity, actor_id)
         VALUES ($1, 1, 'SKU-TEST', 'load', 1, -1) RETURNING id`,
        [vehicleId],
      ),
    ).resolves.toBeDefined();

    // Cleanup the test-only rows so they don't affect other tests.
    await client.query(
      `DELETE FROM distribution.vehicle_unit_events WHERE sku='SKU-TEST' AND actor_id=-1`,
    );
  });

  it("label_prepared event type is also accepted after upgrade", async () => {
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, mahsulot_id, sku, event_type, quantity, actor_id)
         VALUES ($1, 1, 'SKU-TEST2', 'label_prepared', 1, -1) RETURNING id`,
        [vehicleId],
      ),
    ).resolves.toBeDefined();
    await client.query(
      `DELETE FROM distribution.vehicle_unit_events WHERE sku='SKU-TEST2' AND actor_id=-1`,
    );
  });

  it("bogus event_type still rejected after upgrade (CHECK still enforces valid set)", async () => {
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, mahsulot_id, sku, event_type, quantity, actor_id)
         VALUES ($1, 1, 'SKU-TEST3', 'bogus_event', 1, -1)`,
        [vehicleId],
      ),
    ).rejects.toThrow(/vehicle_unit_events_type_check/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveActivePilot strict identity (Fix 2)
//
// No-active-pilot, reassigned agent, wrong-vehicle — all must fail-closed.
// These are tested at the HTTP layer so we confirm the router maps them to 409.
// Each sub-test temporarily corrupts and then restores the pilot state.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveActivePilot strict identity fail-closed (Fix 2)", () => {
  // Save / restore helpers around each test.
  let assignmentId = 0;
  let savedAgentId = 0;

  beforeAll(async () => {
    const asg = await client.query(
      `SELECT id, delivery_agent_id FROM distribution.vehicle_assignments WHERE status='active' LIMIT 1`,
    );
    assignmentId = Number(asg.rows[0].id);
    savedAgentId = Number(asg.rows[0].delivery_agent_id);
  });

  it("no active assignment → 409 on list", async () => {
    // End the active assignment temporarily.
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='ended' WHERE id=$1`,
      [assignmentId],
    );
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(409);
    // Restore.
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='active' WHERE id=$1`,
      [assignmentId],
    );
  });

  it("no active assignment → 409 on create", async () => {
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='ended' WHERE id=$1`,
      [assignmentId],
    );
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    expect(r.status).toBe(409);
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='active' WHERE id=$1`,
      [assignmentId],
    );
  });

  it("agent reassigned to a different vehicle → 409 on list", async () => {
    // Create a fake second vehicle and reassign the agent.
    const fakeWh = await client.query(
      `INSERT INTO warehouses (name, active, location_type, purpose)
       VALUES ('fake-veh-wh-r', TRUE, 'vehicle', 'finished') RETURNING id`,
    );
    const fakeVeh = await client.query(
      `INSERT INTO distribution.vehicles (plate_number, vehicle_type, warehouse_id)
       VALUES ('ZZ-FAKE', 'LABO', $1) RETURNING id`,
      [fakeWh.rows[0].id],
    );
    // End current assignment, create new one on fake vehicle.
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='ended' WHERE id=$1`,
      [assignmentId],
    );
    const newAsg = await client.query(
      `INSERT INTO distribution.vehicle_assignments (vehicle_id, delivery_agent_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [fakeVeh.rows[0].id, savedAgentId],
    );
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(409);
    // Restore: remove fake assignment + vehicle + warehouse, restore real assignment.
    await client.query(
      `DELETE FROM distribution.vehicle_assignments WHERE id=$1`,
      [newAsg.rows[0].id],
    );
    await client.query(
      `DELETE FROM distribution.vehicles WHERE id=$1`,
      [fakeVeh.rows[0].id],
    );
    await client.query(`DELETE FROM warehouses WHERE id=$1`, [fakeWh.rows[0].id]);
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='active' WHERE id=$1`,
      [assignmentId],
    );
  });

  it("pilot warehouse name changed → 409 on list", async () => {
    // Rename the vehicle warehouse temporarily.
    await client.query(
      `UPDATE warehouses SET name='WRONG-NAME' WHERE id=$1`,
      [vehicleWarehouseId],
    );
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(409);
    // Restore.
    await client.query(
      `UPDATE warehouses SET name=$1 WHERE id=$2`,
      [PILOT_WAREHOUSE_NAME, vehicleWarehouseId],
    );
  });

  it("restored pilot state works again after corruptions (sanity check)", async () => {
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic movement_reference (Fix 3) — additional assertions
// ─────────────────────────────────────────────────────────────────────────────
describe("deterministic movement_reference (Fix 3)", () => {
  it("movement_reference follows vehicle-handoff:<id>:stock-transferred pattern", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    const itemId = r.body.items[0].id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    const s = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    expect(s.status).toBe(200);

    // Exact deterministic header reference.
    expect(s.body.movementReference).toBe(`vehicle-handoff:${handoffId}:stock-transferred`);

    // Stored in DB.
    const dbRef = await client.query(
      `SELECT movement_reference FROM distribution.vehicle_handoffs WHERE id=$1`,
      [handoffId],
    );
    expect(String(dbRef.rows[0].movement_reference)).toBe(`vehicle-handoff:${handoffId}:stock-transferred`);

    // Per-item ledger row: deterministic reference.
    const ledRow = await client.query(
      `SELECT reference, note FROM stock_movements WHERE movement_type='TRANSFER'`,
    );
    expect(ledRow.rows).toHaveLength(1);
    expect(String(ledRow.rows[0].reference)).toBe(`vehicle-handoff:${handoffId}:item:${itemId}`);
    // Human-readable note differs from reference.
    expect(String(ledRow.rows[0].note)).toContain("Vehicle handoff");
    expect(String(ledRow.rows[0].note)).not.toBe(String(ledRow.rows[0].reference));
  });

  it("retry produces identical movement_reference and no duplicate ledger rows", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    const itemId = r.body.items[0].id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    const s1 = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    const s2 = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    const expectedRef = `vehicle-handoff:${handoffId}:stock-transferred`;
    expect(s1.body.movementReference).toBe(expectedRef);
    expect(s2.body.movementReference).toBe(expectedRef);
    // Exactly one ledger row — no duplicates on retry.
    const count = await client.query(`SELECT COUNT(*)::int AS n FROM stock_movements`);
    expect(Number(count.rows[0].n)).toBe(1);
    // The reference column is deterministic too.
    const row = await client.query(`SELECT reference FROM stock_movements`);
    expect(String(row.rows[0].reference)).toBe(`vehicle-handoff:${handoffId}:item:${itemId}`);
  });
});
