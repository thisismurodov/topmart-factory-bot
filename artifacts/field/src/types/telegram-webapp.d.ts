// Telegram Mini App (WebApp) global tipi — telegram-web-app.js skripti
// index.html'da yuklanadi va window.Telegram.WebApp obyektini beradi.
interface TelegramHapticFeedback {
  impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
  notificationOccurred(type: "error" | "success" | "warning"): void;
  selectionChanged(): void;
}

interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  disableVerticalSwipes?: () => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  HapticFeedback?: TelegramHapticFeedback;
  colorScheme?: "light" | "dark";
  viewportHeight?: number;
  platform?: string;
  version?: string;
}

interface Window {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
}
