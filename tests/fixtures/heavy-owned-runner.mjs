import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HeavyGate } from '../../tools/heavy-slot/scheduler.mjs';
import { runHeavySlot } from '../../tools/heavy-slot/run.mjs';

const [root, mode] = process.argv.slice(2);
let samples = 0;
let aborted = false;
const gate = new HeavyGate(path.join(root, 'gate'), {
  sample: async ({ signal } = {}) => {
    samples++;
    if (mode === 'hung' && samples > 1) {
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    }
    return { physicalAvailableBytes: 8 * 2 ** 30, commitAvailableBytes: 8 * 2 ** 30, sampledAt: Date.now(), processes: [] };
  }
});
process.on('message', (message) => { if (message.signal === 'SIGINT' || message.signal === 'SIGTERM') process.emit(message.signal); });
const target = mode === 'argv'
  ? [fileURLToPath(new URL('./heavy-argv.mjs', import.meta.url)), ...JSON.parse(readFileSync(path.join(root, 'argv.json'), 'utf8'))]
  : [fileURLToPath(new URL('./heavy-process-tree.mjs', import.meta.url)), root, 'wait'];
const code = await runHeavySlot(['run', 'owned-fixture', '--', process.execPath, ...target], { gate });
process.send?.({ code, aborted, holders: gate.state.holders().length });
process.disconnect?.();
process.exitCode = code;
