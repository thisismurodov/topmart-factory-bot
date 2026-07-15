// Yandex Maps navigatsiya — radarlar, kameralar va tezlik chegaralarini ko'rsatadi.
// Telegram Mini App ichida tashqi havola openLink orqali ochiladi.

type NavButtonsProps = {
  lat: number;
  lng: number;
  dark?: boolean;
};

function yandexHref(lat: number, lng: number) {
  return `https://yandex.com/maps/?rtext=~${lat},${lng}&rtt=auto`;
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
  const cls = dark
    ? "border-yellow-600/60 bg-gray-900/80 text-yellow-300 active:bg-gray-800"
    : "border-yellow-400 bg-yellow-50 text-yellow-900 active:bg-yellow-100";
  return (
    <button
      type="button"
      onClick={() => openNav(yandexHref(lat, lng))}
      className={`flex w-full items-center justify-center gap-2 rounded-xl border h-14 font-semibold ${cls}`}
    >
      <span className="text-xl leading-none">🟡</span>
      <span className="text-sm">Yandex Maps bilan borish</span>
    </button>
  );
}
