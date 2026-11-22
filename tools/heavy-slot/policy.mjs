const GIB = 2 ** 30;
export const HEAVY_POLL_MS = 5000;

/** Estimates are reservations, never a process memory limit or permission to kill a job. */
export function commandProfile(argv) {
  const words = argv.map(String);
  if (/^(?:git|git\.exe)$/i.test(words[0] ?? '')) return { key: 'git', needBytes: GIB / 2 };
  if (words.some((word) => /structure-audit|working-docs-audit/.test(word))) return { key: 'audit', needBytes: GIB };
  if (words.some((word) => /^(?:build|dev)$/.test(word))) return { key: 'build', needBytes: 2.5 * GIB };
  if (words.some((word) => /^(?:check|typecheck)$/.test(word))) return { key: 'types', needBytes: 2 * GIB };
  if (words.some((word) => /vitest|^--test$|^test$/.test(word))) return { key: 'tests', needBytes: 1.5 * GIB };
  return { key: 'unknown', needBytes: 2.5 * GIB };
}

export function estimateNeed(profile, history, declaredBytes) {
  if (declaredBytes !== undefined && (!Number.isFinite(declaredBytes) || declaredBytes <= 0)) throw new Error('need-gb must be a positive finite number');
  const observed = history?.[profile.key]?.peakBytes ?? 0;
  return Math.max(declaredBytes ?? profile.needBytes, observed * 1.2);
}

/** The oldest live ticket is the only candidate, even when two slots are empty. */
export function admission({ ticket, queue, holders, memory, needBytes, reserveBytes = GIB, maxSlots = 2, now = Date.now() }) {
  if (queue[0]?.id !== ticket.id) return { allowed: false, reason: 'waiting for an earlier ticket' };
  if (holders.length >= maxSlots) return { allowed: false, reason: 'all heavy slots are occupied' };
  if (![needBytes, reserveBytes, memory?.physicalAvailableBytes, memory?.commitAvailableBytes, memory?.sampledAt, now].every((value) => Number.isFinite(value) && value >= 0)) {
    return { allowed: false, reason: 'memory telemetry is unavailable' };
  }
  if (memory.sampledAt > now || now - memory.sampledAt > HEAVY_POLL_MS) return { allowed: false, reason: 'memory telemetry is stale or has a future timestamp' };
  if (holders.some((holder) => !Number.isFinite(holder.needBytes) || holder.needBytes <= 0)) return { allowed: false, reason: 'a holder has invalid reservation metadata' };
  // OS headroom and process footprints are not one atomic measurement. Subtracting
  // a later footprint could credit memory that the earlier headroom never included.
  // Keep the full reservations; observed usage learns peaks but never grants capacity.
  const physicalPending = holders.reduce((total, holder) => total + holder.needBytes, 0);
  const commitPending = physicalPending;
  if (memory.physicalAvailableBytes < reserveBytes + physicalPending + needBytes) return { allowed: false, reason: 'insufficient physical headroom for the reserved peak' };
  if (memory.commitAvailableBytes < reserveBytes + commitPending + needBytes) return { allowed: false, reason: 'insufficient system commit headroom for the reserved peak' };
  return { allowed: true, reason: 'peak reservation fits physical and commit headroom' };
}
