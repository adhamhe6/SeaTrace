import { useQueries } from '@tanstack/react-query';
import { api } from '@/api/client';
import { keys } from '@/api/queryKeys';
import { useVessels } from '@/api/hooks';
import type { VesselDetail } from '@/api/types';

/** Equipment codes selectable for the chosen vessel (or the union across all vessels). */
export function useEquipmentOptions(vessel: string): { codes: string[]; loading: boolean } {
  const vessels = useVessels();
  const targets = (vessels.data ?? []).filter((v) => !vessel || v.code === vessel);
  const results = useQueries({
    queries: targets.map((v) => ({
      queryKey: keys.vessel(v.code),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<VesselDetail>(`/vessels/${encodeURIComponent(v.code)}`, { signal }),
      staleTime: 60_000,
    })),
  });
  const codes = new Set<string>();
  for (const r of results) r.data?.equipment.forEach((e) => codes.add(e.code));
  return {
    codes: [...codes].sort(),
    loading: vessels.isPending || results.some((r) => r.isPending),
  };
}
