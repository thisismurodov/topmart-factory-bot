"""Audited package totals override legacy per-piece weights for sales only."""
from decimal import Decimal, ROUND_HALF_UP


def allocated_claim_weight(unit_weight, pieces, remaining, allocated, corrected_total=None):
    unit_weight, pieces, remaining, allocated = map(
        lambda x: Decimal(str(x)), (unit_weight, pieces, remaining, allocated))
    if not all(x.is_finite() for x in (unit_weight, pieces, remaining, allocated)):
        raise ValueError("Etiketka vazni yoki dona soni noto'g'ri.")
    if (unit_weight <= 0 or pieces <= 0 or remaining <= 0 or remaining > pieces
            or allocated <= 0 or allocated > remaining
            or any(x != x.to_integral_value() for x in (pieces, remaining, allocated))):
        raise ValueError("Etiketka vazni yoki dona soni noto'g'ri.")
    if corrected_total is None:
        return unit_weight * allocated
    total = Decimal(str(corrected_total))
    if not total.is_finite() or total <= 0:
        raise ValueError("Tasdiqlangan etiketka vazni noto'g'ri.")
    # Difference of cumulative balances: any sequence of partial sales sums
    # to the exact package total, even for 8 kg / 120 pieces.
    grid = Decimal("0.0001")
    before = (total * remaining / pieces).quantize(grid, rounding=ROUND_HALF_UP)
    after = (total * (remaining - allocated) / pieces).quantize(grid, rounding=ROUND_HALF_UP)
    return before - after
