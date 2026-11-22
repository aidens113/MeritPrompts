import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeavyGate } from '../../tools/heavy-slot/scheduler.mjs';
import { withStateLock } from '../../tools/heavy-slot/state.mjs';

const [root, label, mode] = process.argv.slice(2);
const gate = new HeavyGate(root, {
  sample: async () => ({ physicalAvailableBytes: 4 * 2 ** 30, commitAvailableBytes: 4 * 2 ** 30, sampledAt: Date.now(), processes: [] }),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)))
});
if (mode === 'crash-lock') await withStateLock(root, () => process.exit(0));
const holder = await gate.take(label, { key: 'tests', needBytes: 2 * 2 ** 30 });
if (mode === 'orphan' || mode === 'unregistered') {
  await gate.update(holder, { launchState: 'starting' });
  const ready = path.join(root, 'test-child-ready');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./heavy-sleeper.mjs', import.meta.url)), ready], { stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
  writeFileSync(path.join(root, 'test-child-pid'), String(child.pid));
  for (let wait = 0; wait < 200 && !existsSync(ready); wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!existsSync(ready)) throw new Error('Owned fixture child did not start.');
  if (mode === 'orphan') await gate.update(holder, { childPid: child.pid, launchState: 'registered' });
  process.exit(0);
}
appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ kind: 'start', label, sequence: holder.sequence }) + '\n');
await new Promise((resolve) => setTimeout(resolve, 60));
appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ kind: 'end', label }) + '\n');
await gate.release(holder);
