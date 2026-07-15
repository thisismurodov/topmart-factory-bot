// Navigatsiya tugmalari: Yandex (asosiy — radarlar, kameralar, tezlik chegaralari),
// qo'shimcha Google / Waze / Apple. Telegram Mini App ichida tashqi havola
// openLink orqali ochiladi.

type NavButtonsProps = {
  lat: number;
  lng: number;
  dark?: boolean;
};

function yandexHref(lat: number, lng: number) {
  return `https://yandex.com/maps/?rtext=~${lat},${lng}&rtt=auto`;
}
function googleHref(lat: number, lng: number) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}
function wazeHref(lat: number, lng: number) {
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}
function appleHref(lat: number, lng: number) {
  return `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`;
}

function openNav(href: string) {
  const tg = window.Telegram?.WebApp;
  if (tg?.openLink) {
    tg.openLink(href);
  } else {
    window.open(href, "_blank", "noopener");
  }
}

export default function NavButtons({ lat, lng, dark = false }: NavButtonsProps) {
  const primaryCls = dark
    ? "border-yellow-600/60 bg-gray-900/80 text-yellow-300 active:bg-gray-800"
    : "border-yellow-400 bg-yellow-50 text-yellow-900 active:bg-yellow-100";
  const secondaryCls = dark
    ? "border-gray-700 bg-gray-900/80 text-gray-200 active:bg-gray-800"
    : "border-gray-200 bg-white text-gray-700 active:bg-gray-100";

  const secondary: { label: string; icon: string; href: string }[] = [
    { label: "Google", icon: "🗺", href: googleHref(lat, lng) },
    { label: "Waze", icon: "🚗", href: wazeHref(lat, lng) },
    { label: "Apple", icon: "🍎", href: appleHref(lat, lng) },
  ];

  return (
    <div className="space-y-2">
      {/* Yandex — asosiy: radar va kameralarni ko'rsatadi */}
      <button
        type="button"
        onClick={() => openNav(yandexHref(lat, lng))}
        className={`flex w-full items-center justify-center gap-2 rounded-xl border h-14 font-semibold ${primaryCls}`}
      >
        <span className="text-xl leading-none">🟡</span>
        <span className="text-sm">Yandex Maps bilan borish</span>
      </button>

      <div className="grid grid-cols-3 gap-2">
        {secondary.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => openNav(s.href)}
            className={`flex items-center justify-center gap-1.5 rounded-xl border h-11 text-xs font-medium ${secondaryCls}`}
          >
            <span className="text-base leading-none">{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
