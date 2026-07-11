import { useEffect, useState } from "react";
import { getQueue } from "@/lib/sync";

export function useSyncQueueCount() {
  const [count, setCount] = useState(() => getQueue().length);

  useEffect(() => {
    const handleUpdate = () => {
      setCount(getQueue().length);
    };
    
    window.addEventListener("sync-queue-updated", handleUpdate);
    return () => window.removeEventListener("sync-queue-updated", handleUpdate);
  }, []);

  return count;
}
