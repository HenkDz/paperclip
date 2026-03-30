import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adaptersApi } from "@/api/adapters";
import { setDisabledAdapterTypes } from "@/adapters/disabled-store";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Fetch adapters and keep the disabled-adapter store hydrated.
 * Returns a reactive Set of disabled types for use as useMemo dependencies.
 *
 * Call this at the top of any component that renders adapter menus.
 * The Set reference changes when query data arrives, triggering recomputation.
 */
export function useDisabledAdaptersSync(): Set<string> {
  const { data: adapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    // Stale for 5 minutes — disabled state changes rarely
    staleTime: 5 * 60 * 1000,
  });

  // Sync to the global store for non-React code (metadata.ts helpers)
  useEffect(() => {
    if (!adapters) return;
    setDisabledAdapterTypes(
      adapters.filter((a) => a.disabled).map((a) => a.type),
    );
  }, [adapters]);

  // Return a Set derived directly from query data for React reactivity.
  // Reference changes on every new data arrival → triggers useMemo recomputation.
  return useMemo(
    () => new Set(adapters?.filter((a) => a.disabled).map((a) => a.type) ?? []),
    [adapters],
  );
}
