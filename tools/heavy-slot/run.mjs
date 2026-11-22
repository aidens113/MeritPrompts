import { homedir } from 'node:os';
import path from 'node:path';
import { HeavyGate } from './scheduler.mjs';
import { commandProfile } from './policy.mjs';
import { childCommand } from './child-command.mjs';
import { CONTAINMENT, launchOwnedProcess, requireContainment } from './owned-process.mjs';
import { monitorHolder } from './monitor.mjs';

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive and finite.`);
  return number;
}

async function runChild(gate, holder, argv) {
  let work;
  let started = false;
  let stopMonitoring = () => {};
  let requestedSignal;
  const interrupt = () => { requestedSignal = 'SIGINT'; work?.cancel('SIGINT'); };
  const terminate = () => { requestedSignal = 'SIGTERM'; work?.cancel('SIGTERM'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const command = childCommand(argv);
    // A supervisor waits for start() until its identity is durable; no workload can precede registration.
    await gate.update(holder, { launchState: 'preparing-contained', containment: CONTAINMENT });
    work = await launchOwnedProcess(command);
    if (!work.pid) return await work.done;
    await gate.update(holder, { childPid: work.pid, launchState: 'registered' });
    work.start();
    started = true;
    if (requestedSignal) work.cancel(requestedSignal);
    stopMonitoring = monitorHolder(gate, holder);
    return await work.done;
  } catch (error) {
    if (work) {
      if (started) work.cancel('SIGTERM');
      else work.abortBeforeStart();
      await work.done;
    }
    throw error;
  } finally {
    stopMonitoring();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    // The kernel job proves lifetime; optional telemetry and sampled PID trees cannot delay or authorize release.
    await gate.release(holder);
  }
}

/** Shared CLI; a compatibility launcher can pin one machine-wide stateDir. */
export async function runHeavySlot(argv = process.argv.slice(2), { stateDir = process.env.MERIT_HEAVY_DIR ?? path.join(homedir(), '.cache', 'merit-heavy-slot'), gate: suppliedGate, platform = process.platform } = {}) {
  if (process.env.HEAVY_SLOT_PRIORITY === '1') throw new Error('Priority bypass is not supported; jobs are admitted in FIFO order by reserved memory.');
  const [command, label, ...remaining] = argv;
  const gate = suppliedGate ?? new HeavyGate(path.join(stateDir, 'v2'));
  if (command === 'status') { console.log(JSON.stringify(await gate.status(), null, 2)); return 0; }
  if (!label) throw new Error('A job label is required.');
  const leaseIdAt = remaining.indexOf('--lease-id');
  const leaseId = leaseIdAt < 0 ? undefined : remaining[leaseIdAt + 1];
  if (command === 'release') { await gate.releaseLease(label, leaseId); return 0; }
  if (command === 'renew') { await gate.renew(label, positive(remaining[0] === '--lease-id' ? 60 : remaining[0] ?? 60, 'minutes'), leaseId); return 0; }
  if (command !== 'run' && command !== 'acquire') throw new Error('Use run, acquire, renew, release or status.');
  const separator = remaining.indexOf('--');
  const options = separator < 0 ? (command === 'acquire' ? remaining : []) : remaining.slice(0, separator);
  const executable = separator < 0 ? remaining : remaining.slice(separator + 1);
  let needBytes;
  let minutes = 60;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--need-gb') needBytes = positive(options[++i], 'need-gb') * 2 ** 30;
    else if (command === 'acquire' && i === 0) minutes = positive(options[i], 'minutes');
    else throw new Error(`Unknown gate option: ${options[i]}`);
  }
  if (command === 'run' && !executable.length) throw new Error('run requires a command after --.');
  requireContainment(platform);
  const profile = command === 'run' ? commandProfile(executable) : { key: 'lease', needBytes: 2.5 * 2 ** 30 };
  let lastWait = 0;
  const holder = await gate.take(label, profile, { needBytes, kind: command === 'run' ? 'run' : 'lease', minutes, onWait: (reason) => {
    if (Date.now() - lastWait >= 60_000) { console.error(`[heavy-slot] ${label} waiting: ${reason}`); lastWait = Date.now(); }
  } });
  console.error(`[heavy-slot] ${label} holds a slot (${(holder.needBytes / 2 ** 30).toFixed(2)} GiB reserved)`);
  if (command === 'acquire') console.log(JSON.stringify({ label, leaseId: holder.id, expiresAt: holder.expiresAt }));
  return command === 'run' ? await runChild(gate, holder, executable) : 0;
}
