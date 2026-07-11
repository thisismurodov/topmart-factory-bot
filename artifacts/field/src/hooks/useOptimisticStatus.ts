import { useQueryClient } from "@tanstack/react-query";
import { RouteTodayResponse, routeTodayQueryKey } from "@/lib/fieldApi";

export function useOptimisticStatus() {
  const queryClient = useQueryClient();

  return (dokonId: number, status: "sold" | "nosale") => {
    queryClient.setQueryData<RouteTodayResponse>(routeTodayQueryKey(), (old) => {
      if (!old) return old;
      
      const newShops = old.shops.map(s => {
        if (s.dokonId === dokonId) {
          return { ...s, status };
        }
        return s;
      });

      const wasPending = old.shops.find(s => s.dokonId === dokonId)?.status === "pending";
      
      return {
        ...old,
        shops: newShops,
        stats: {
          ...old.stats,
          sold: old.stats.sold + (status === "sold" && wasPending ? 1 : 0),
          nosale: old.stats.nosale + (status === "nosale" && wasPending ? 1 : 0),
          done: old.stats.done + (wasPending ? 1 : 0),
          pending: old.stats.pending - (wasPending ? 1 : 0),
        }
      };
    });
  };
}
