import { useSyncExternalStore } from "react";
import {
  getSyncStatusSnapshot,
  subscribeSyncStatus,
  type SyncStatusSnapshot,
} from "@/lib/syncEngine";

/** T007 — global ulanish/sinxronizatsiya holati (header, banner, Sync Center). */
export function useSyncStatus(): SyncStatusSnapshot {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatusSnapshot);
}
