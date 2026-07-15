import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { metaGet, metaSet } from "@/lib/idb";

// T011 — Halokatdan tiklanish: oxirgi ekran manzili meta store'da saqlanadi.
// Ilova qayta ochilganda (Telegram yopilib qolsa, telefon o'chsa) agent
// aynan qolgan joyidan davom etadi. Marshrut/progress react-query persist
// keshidan, navbat esa IDB events store'dan tiklanadi.

const LAST_PATH_KEY = "lastPath";

// Faqat shu sahifalarni tiklaymiz — forma sahifalari bo'sh holatda ochilib
// chalg'itmasligi uchun asosiy ekranlarga qaytaramiz.
const RESTORABLE = [/^\/map$/, /^\/drive$/, /^\/visit\/\d+$/, /^\/stats$/, /^\/summary$/, /^\/sync$/];

export function CrashRecovery() {
  const [location, setLocation] = useLocation();
  const restoredRef = useRef(false);

  // Boot'da bir marta: agar boshlang'ich ekranda bo'lsak va saqlangan
  // manzil bo'lsa — o'sha yerga qaytamiz.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (location !== "/") return;
    void metaGet<string>(LAST_PATH_KEY).then((saved) => {
      if (saved && saved !== "/" && RESTORABLE.some((re) => re.test(saved))) {
        setLocation(saved, { replace: true });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Har navigatsiyada oxirgi manzilni yozib boramiz
  useEffect(() => {
    void metaSet(LAST_PATH_KEY, location);
  }, [location]);

  return null;
}
