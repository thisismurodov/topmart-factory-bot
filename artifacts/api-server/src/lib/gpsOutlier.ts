// GPS outlier tekshiruvi — yangi/tahrirlangan do'kon koordinatasi viloyat
// dokonlari medianidan GPS_OUTLIER_KM dan uzoq bo'lsa, ehtimol xato kiritilgan
// (routePlanner splitOutliers shunday nuqtalarni rejadan chiqarib tashlaydi).
// Kiritish paytida ogohlantirish — do'kon marshrutdan jimgina tushib
// qolishining oldini oladi.
import { haversineKm } from "./routePlanner";

export const GPS_OUTLIER_KM = 60;

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * Koordinata viloyat medianidan GPS_OUTLIER_KM dan uzoq bo'lsa masofani (km)
 * qaytaradi, aks holda null. Viloyatda 3 tadan kam koordinatali do'kon bo'lsa
 * median ishonchsiz — tekshirilmaydi (splitOutliers bilan bir xil qoida).
 */
export async function gpsOutlierKm(
  db: Queryable,
  viloyat: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
  excludeId?: number,
): Promise<number | null> {
  if (lat == null || lng == null || !viloyat) return null;
  const params: unknown[] = [viloyat];
  let sql = `SELECT latitude, longitude FROM distribution.dokonlar
             WHERE viloyat = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL
               AND COALESCE(holat, 'faol') = 'faol'`;
  if (excludeId != null) {
    params.push(excludeId);
    sql += ` AND id <> $2`;
  }
  const q = await db.query(sql, params);
  if (q.rows.length < 3) return null;
  const lats = q.rows.map((r) => Number(r.latitude)).sort((a, b) => a - b);
  const lngs = q.rows.map((r) => Number(r.longitude)).sort((a, b) => a - b);
  const mLat = lats[Math.floor(lats.length / 2)];
  const mLng = lngs[Math.floor(lngs.length / 2)];
  const dist = haversineKm(mLat, mLng, lat, lng);
  return dist > GPS_OUTLIER_KM ? dist : null;
}
