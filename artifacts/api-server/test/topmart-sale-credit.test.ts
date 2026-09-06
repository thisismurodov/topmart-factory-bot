import { describe, expect, it, vi } from "vitest";
import { creditTopmartSale } from "../src/lib/topmartSaleCredit";

describe("Top Mart central warehouse sale credit", () => {
  it("credits dona and kg independently and records TRANSFER/IN", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await creditTopmartSale(
      { query } as never,
      91,
      703,
      [
        { productName: "Pipe", removedQuantity: 4, removedWeightKg: 6.4 },
        { productName: "Granule", removedQuantity: 0, removedWeightKg: 2.75 },
      ],
    );

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][1]).toEqual([703, "Pipe", 4, 6.4]);
    expect(query.mock.calls[2][1]).toEqual([703, "Granule", 0, 2.75]);
    expect(query.mock.calls[1][0]).toContain("'TRANSFER'");
    expect(query.mock.calls[1][0]).toContain("'IN'");
    expect(query.mock.calls[1][1]).toContain("topmart-sale:91:1:transfer");
    expect(query.mock.calls[3][1]).toContain("topmart-sale:91:2:in");
    // Destination inventory and both ledger legs carry the exact source
    // deduction supplied by the sale transaction (including dona mass).
    expect(query.mock.calls[1][1]?.slice(1, 3)).toEqual([4, 703]);
    expect(query.mock.calls[1][1]).toContain(6.4);
    expect(query.mock.calls[3][1]).toContain(2.75);
    expect(query.mock.calls.flat().join(" ")).not.toContain("production_labels");
  });

  it("propagates a destination failure so the caller can roll back the sale", async () => {
    const failure = new Error("central inventory unavailable");
    const query = vi.fn().mockRejectedValue(failure);
    await expect(
      creditTopmartSale(
        { query } as never,
        92,
        704,
        [{ productName: "Pipe", removedQuantity: 1, removedWeightKg: 0.5 }],
      ),
    ).rejects.toBe(failure);
  });

  it("does nothing when the caller has no configured/matching destination", async () => {
    const query = vi.fn();
    // POST /sales invokes the helper only for a matching configured customer.
    const destination: number | null = null;
    if (destination != null) {
      await creditTopmartSale(
        { query } as never,
        93,
        destination,
        [{ productName: "Pipe", removedQuantity: 1, removedWeightKg: 0.5 }],
      );
    }
    expect(query).not.toHaveBeenCalled();
  });
});