import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, "../src");
const read = (relative: string): string =>
  readFileSync(path.join(srcDir, relative), "utf8");
function sourceFiles(dir = srcDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts")
      ? [path.relative(srcDir, full).split(path.sep).join("/")]
      : [];
  });
}

const inventoryMutation = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?inventory\b/i;

function mutatingPostPaths(source: string): string[] {
  const starts = [...source.matchAll(/router\.post\("([^"]+)"/g)];
  const paths: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i].index ?? 0;
    const end = starts[i + 1]?.index ?? source.length;
    if (inventoryMutation.test(source.slice(start, end))) paths.push(starts[i][1]);
  }
  return paths;
}

describe("static vehicle guard for every public.inventory writer", () => {
  it("keeps the complete generic/domain writer inventory explicit", () => {
    const ombor = read("routes/ombor.ts");
    expect(mutatingPostPaths(ombor).sort()).toEqual([
      "/ombor/adjust",
      "/ombor/finished-in",
      "/ombor/flow/produce",
      "/ombor/flow/raw-in",
      "/ombor/flow/receive",
      "/ombor/transfer",
    ]);

    const inventory = read("routes/inventory-v2.ts");
    expect(mutatingPostPaths(inventory)).toEqual(["/inventory/movement"]);
    const sales = read("routes/sales.ts");
    expect(mutatingPostPaths(sales)).toEqual(["/sales"]);
  });

  it("requires the reusable parent-row guard on every arbitrary-ID writer", () => {
    const ombor = read("routes/ombor.ts");
    for (const [route, call] of [
      ["/ombor/transfer", "guardGenericInventoryWarehouses(client, [fromId, toId])"],
      ["/ombor/finished-in", "guardGenericInventoryWarehouses(client, [warehouseId])"],
      ["/ombor/adjust", "guardGenericInventoryWarehouses(client, [warehouseId])"],
    ]) {
      const start = ombor.indexOf(`router.post("${route}"`);
      const end = ombor.indexOf("router.", start + 1);
      expect(ombor.slice(start, end)).toContain(call);
    }
    expect(read("routes/inventory-v2.ts")).toContain(
      "guardGenericInventoryWarehouses(client, referencedWarehouseIds)",
    );
  });

  it("keeps sales candidates, fallbacks and updates nonvehicle-only", () => {
    const sales = read("routes/sales.ts");
    expect(sales.match(/COALESCE\(w\.location_type,'general'\) != 'vehicle'/g)?.length)
      .toBeGreaterThanOrEqual(4);
    expect(sales.match(/COALESCE\(location_type,'general'\) != 'vehicle'/g)?.length)
      .toBeGreaterThanOrEqual(2);
    expect(sales.match(/LIMIT 1 FOR UPDATE/g)?.length).toBe(2);
    expect(sales.match(/guardGenericInventoryWarehouses/g)?.length)
      .toBeGreaterThanOrEqual(3);
  });

  it("keeps raw-in, receive and produce restricted to container/ayvon purpose", () => {
    const ombor = read("routes/ombor.ts");
    const expectations = new Map([
      ["/ombor/flow/raw-in", "purpose='raw'"],
      ["/ombor/flow/receive", "purpose='raw'"],
      ["/ombor/flow/produce", "purpose='finished'"],
    ]);
    for (const [route, purpose] of expectations) {
      const start = ombor.indexOf(`router.post("${route}"`);
      const end = ombor.indexOf("router.", start + 1);
      const handler = ombor.slice(start, end);
      expect(handler).toContain("location_type IN ('container','ayvon')");
      expect(handler).toContain(purpose);
    }
  });

  it("allows no undiscovered inventory-mutating source file", () => {
    const known = [
      "routes/ombor.ts",
      "routes/inventory-v2.ts",
      "routes/sales.ts",
      "lib/topmartSaleCredit.ts",
      "routes/vehicle-distribution/handoff-service.ts",
      "routes/vehicle-distribution/return-service.ts",
    ];
    const discovered = sourceFiles()
      .filter((file) => inventoryMutation.test(read(file)))
      .sort();
    expect(discovered).toEqual(known.sort());

    const handoff = read("routes/vehicle-distribution/handoff-service.ts");
    expect(handoff).toContain("lockVehicleWarehouseStockMutation");
    const topmartSaleCredit = read("lib/topmartSaleCredit.ts");
    expect(topmartSaleCredit).toContain("INSERT INTO inventory");
    expect(topmartSaleCredit).toContain("ON CONFLICT (warehouse_id, product)");
    const vehicleReturn = read("routes/vehicle-distribution/return-service.ts");
    expect(vehicleReturn).toContain("async function lockParents");
    expect(vehicleReturn).toContain("await lockParents(client,");
  });
});