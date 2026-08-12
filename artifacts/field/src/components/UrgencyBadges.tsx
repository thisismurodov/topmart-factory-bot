// Ustuvorlik (biznes signallari) badge'lari — RouteMap va ShopSheet'da
// bir xil ko'rinish. Reja saqlanganda planner'dan kelgan bizScore/bizReasons.
// Past ustuvorlik — indikator yo'q (vizual shovqin bo'lmasin).

const URGENT_SCORE_MIN = 40;

export interface UrgencySignals {
  bizScore: number | null;
  bizReasons: string[] | null;
}

export function isUrgentShop(shop: UrgencySignals): boolean {
  return (
    (shop.bizScore ?? 0) >= URGENT_SCORE_MIN &&
    Array.isArray(shop.bizReasons) &&
    shop.bizReasons.length > 0
  );
}

/** Sabab matnini kichik badge ko'rinishida — nasiya uchun 💳, VIP uchun ⭐. */
function reasonBadgeText(reason: string): string {
  if (reason.toLowerCase().startsWith("nasiya")) return `💳 ${reason}`;
  if (reason === "VIP") return "⭐ VIP";
  return reason; // masalan "35 kun bormagan"
}

export default function UrgencyBadges({
  shop,
  className = "",
}: {
  shop: UrgencySignals;
  className?: string;
}) {
  if (!isUrgentShop(shop)) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {shop.bizReasons!.map((r) => (
        <span
          key={r}
          className="inline-flex items-center rounded-full bg-red-50 text-red-700 border border-red-200 px-2 py-0.5 text-xs font-semibold"
        >
          {reasonBadgeText(r)}
        </span>
      ))}
    </div>
  );
}
