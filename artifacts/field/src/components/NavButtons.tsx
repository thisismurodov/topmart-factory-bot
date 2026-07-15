// Bepul navigatsiya deep-linklari — API kaliti talab qilinmaydi.
// Telegram Mini App ichida tashqi havolalar openLink orqali ochiladi.

type NavButtonsProps = {
  lat: number;
  lng: number;
  dark?: boolean;
};

const NAV_APPS = (lat: number, lng: number) => [
  { label: "Google", emoji: "📍", href: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` },
  { label: "Yandex", emoji: "🟡", href: `https://yandex.com/maps/?rtext=~${lat},${lng}&rtt=auto` },
  { label: "Waze", emoji: "🌍", href: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes` },
  { label: "Apple", emoji: "🍎", href: `https://maps.apple.com/?daddr=${lat},${lng}` },
];

function openNav(href: string) {
  const tg = window.Telegram?.WebApp;
  if (tg?.openLink) {
    tg.openLink(href);
  } else {
    window.open(href, "_blank", "noopener");
  }
}

export default function NavButtons({ lat, lng, dark = false }: NavButtonsProps) {
  const cls = dark
    ? "border-gray-700 bg-gray-900/80 text-gray-200 active:bg-gray-800"
    : "border-input bg-background text-foreground active:bg-muted";
  return (
    <div className="grid grid-cols-4 gap-2">
      {NAV_APPS(lat, lng).map((l) => (
        <button
          key={l.label}
          type="button"
          onClick={() => openNav(l.href)}
          className={`flex flex-col items-center justify-center gap-0.5 rounded-xl border h-14 ${cls}`}
        >
          <span className="text-lg leading-none">{l.emoji}</span>
          <span className="text-[10px] font-semibold">{l.label}</span>
        </button>
      ))}
    </div>
  );
}
