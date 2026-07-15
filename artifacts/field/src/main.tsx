import { createRoot } from "react-dom/client";
import App from "./App";
import "leaflet/dist/leaflet.css";
import "./index.css";
import { startSyncEngine } from "./lib/syncEngine";

// Sync engine render'dan oldin ishga tushadi — ilova ochilishi bilan
// offline navbat migratsiyasi + birinchi sinxronizatsiya boshlanadi.
startSyncEngine();

createRoot(document.getElementById("root")!).render(<App />);
