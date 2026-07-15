import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { getCachedTile, saveTile, TILE_URL_TEMPLATE } from "@/lib/tileCache";

// T006 — IndexedDB keshli Leaflet plitka qatlami.
// createTile ni almashtiramiz: avval kesh (tez, offline), keyin tarmoq.
// Tarmoqdan kelgan plitka keshga yoziladi. Service Worker ISHLATILMAYDI.

const CachedTileLayer = L.TileLayer.extend({
  createTile(this: L.TileLayer, coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const img = document.createElement("img");
    img.alt = "";
    img.setAttribute("role", "presentation");

    const key = `${coords.z}/${coords.x}/${coords.y}`;
    const url: string = this.getTileUrl(coords);

    let objectUrl: string | null = null;
    let finished = false;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      done(err, img);
    };

    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      finish();
    };

    void (async () => {
      // 1) Kesh
      const cached = await getCachedTile(key);
      if (cached) {
        objectUrl = URL.createObjectURL(cached);
        img.onerror = () => finish(new Error("cached tile corrupt"));
        img.src = objectUrl;
        return;
      }
      // 2) Tarmoq (fetch — blob keshga tushishi uchun)
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(String(resp.status));
        const blob = await resp.blob();
        void saveTile(key, blob);
        objectUrl = URL.createObjectURL(blob);
        img.onerror = () => finish(new Error("tile decode failed"));
        img.src = objectUrl;
      } catch (e) {
        finish(e instanceof Error ? e : new Error("tile unavailable"));
      }
    })();

    return img;
  },
});

export function OfflineTileLayer() {
  const map = useMap();

  useEffect(() => {
    const layer = new (CachedTileLayer as unknown as new (
      url: string,
      options?: L.TileLayerOptions,
    ) => L.TileLayer)(TILE_URL_TEMPLATE, {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      crossOrigin: true,
    });
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map]);

  return null;
}
