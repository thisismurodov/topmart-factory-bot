import type { PoolClient } from "pg";

export class GenericInventoryWarehouseError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "GenericInventoryWarehouseError";
  }
}

/**
 * Lock every warehouse parent before a generic inventory writer reads or
 * mutates stock. Parent-row locking covers both existing inventory rows and a
 * concurrent insert of a brand-new SKU, and shares the vehicle reconciliation
 * writer's locking protocol.
 */
export async function guardGenericInventoryWarehouses(
  client: PoolClient,
  warehouseIds: readonly unknown[],
): Promise<number[]> {
  const ids = [...new Set(warehouseIds.map(Number))].sort((a, b) => a - b);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new GenericInventoryWarehouseError("Warehouse not found", 404);
  }
  if (ids.length === 0) return ids;

  const { rows } = await client.query(
     `SELECT id, location_type
        FROM warehouses
      WHERE id = ANY($1::int[])
      ORDER BY id
      FOR UPDATE`,
    [ids],
  );
  const found = new Set(rows.map((row) => Number(row.id)));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new GenericInventoryWarehouseError(
      `Warehouse not found: ${missing.join(", ")}`,
      404,
    );
  }
  if (rows.some((row) => String(row.location_type) === "vehicle")) {
    throw new GenericInventoryWarehouseError(
      "Vehicle warehouses cannot be mutated through generic inventory APIs",
      400,
    );
  }
  return ids;
}

export function genericInventoryWarehouseErrorStatus(
  error: unknown,
): 400 | 404 | null {
  return error instanceof GenericInventoryWarehouseError ? error.status : null;
}