import { useEffect, useState } from 'react';
import { telemetryBus } from '@/realtime/telemetryBus';
import type { ChartPoint } from '@/ui/chart/chartOption';

const MAX_POINTS = 5000;

/**
 * Collects live telemetry for one equipment item since `resetKey` last changed (a fresh history fetch
 * replaces the buffer). Points are appended exactly as received; nothing is interpolated.
 */
export function useLiveBuffer(
  vessel: string,
  equipment: string,
  resetKey: number,
  enabled: boolean,
): Record<string, ChartPoint[]> {
  const key = `${vessel}/${equipment}/${String(resetKey)}`;
  const [state, setState] = useState<{ key: string; data: Record<string, ChartPoint[]> }>({
    key,
    data: {},
  });

  useEffect(() => {
    if (!enabled) return;
    return telemetryBus.subscribe((items) => {
      const mine = items.filter((i) => i.vessel_code === vessel && i.equipment_code === equipment);
      if (mine.length === 0) return;
      setState((prev) => {
        const base = prev.key === key ? prev.data : {};
        const next = { ...base };
        for (const item of mine) {
          const ts = Date.parse(item.source_ts);
          if (!Number.isFinite(ts)) continue;
          const list = next[item.measurement] ?? [];
          const last = list[list.length - 1];
          if (last && last[0] >= ts) continue;
          const appended: ChartPoint[] = [...list, [ts, item.value, item.quality]];
          next[item.measurement] =
            appended.length > MAX_POINTS ? appended.slice(-MAX_POINTS) : appended;
        }
        return { key, data: next };
      });
    });
  }, [vessel, equipment, key, enabled]);

  return state.key === key ? state.data : {};
}
