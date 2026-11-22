import { setTimeout as pause } from 'node:timers/promises';
import { HEAVY_POLL_MS } from './policy.mjs';

/** Optional observation never owns workload completion. Abort also reaps the real external probe. */
export function monitorHolder(gate, holder) {
  const controller = new AbortController();
  const { signal } = controller;
  void (async () => {
    while (!signal.aborted) {
      try {
        const snapshot = await gate.sample({ signal });
        if (signal.aborted) return;
        await gate.update(holder, {}, snapshot);
      } catch { if (signal.aborted) return; /* The full peak reservation remains held. */ }
      try { await pause(HEAVY_POLL_MS, undefined, { signal }); } catch { return; }
    }
  })();
  return () => controller.abort();
}
