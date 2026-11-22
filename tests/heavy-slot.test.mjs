import test from 'node:test';
import assert from 'node:assert/strict';
import { admission, commandProfile, estimateNeed, HEAVY_POLL_MS } from '../tools/heavy-slot/policy.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HeavyGate } from '../tools/heavy-slot/scheduler.mjs';
import { withStateLock, atomicJson, processAlive } from '../tools/heavy-slot/state.mjs';
import { holderFootprint } from '../tools/heavy-slot/memory.mjs';
import { childCommand } from '../tools/heavy-slot/child-command.mjs';
import { spawnSync, spawn, fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runHeavySlot } from '../tools/heavy-slot/run.mjs';
import { memorySnapshot } from '../tools/heavy-slot/memory.mjs';
import { launchOwnedProcess, requireContainment, CONTAINMENT } from '../tools/heavy-slot/owned-process.mjs';

const GB = 2 ** 30;
const first = { id: 'first' };
const second = { id: 'second' };
function decide(overrides = {}) {
  const now = overrides.now ?? Date.now();
  const input = { ticket: first, queue: [first, second], holders: [], memory: { physicalAvailableBytes: 6 * GB, commitAvailableBytes: 6 * GB }, needBytes: 2 * GB, ...overrides, now };
  if (input.memory && !Object.hasOwn(input.memory, 'sampledAt')) input.memory = { ...input.memory, sampledAt: now };
  return admission(input);
}

test('an empty machine still serves only the oldest ticket', () => {
  assert.equal(decide().allowed, true);
  assert.equal(decide({ ticket: second }).allowed, false);
});
test('commit pressure refuses admission even with plenty of physical memory', () => {
  assert.equal(decide({ memory: { physicalAvailableBytes: 10 * GB, commitAvailableBytes: 2.9 * GB } }).allowed, false);
});
test('non-atomic footprint telemetry cannot credit unproved available capacity', () => {
  const holders = [{ needBytes: 4 * GB, workingBytes: GB, privateBytes: 2 * GB }];
  assert.equal(decide({ holders, memory: { physicalAvailableBytes: 5.9 * GB, commitAvailableBytes: 8 * GB } }).allowed, false);
  assert.equal(decide({ holders, memory: { physicalAvailableBytes: 7 * GB, commitAvailableBytes: 7 * GB } }).allowed, true);
  assert.equal(decide({ holders: [{ ...holders[0], workingBytes: 4 * GB, privateBytes: 4 * GB }] }).allowed, false);
});
test('malformed reservation metadata cannot turn headroom arithmetic into NaN', () => {
  assert.equal(decide({ holders: [{}] }).allowed, false);
  assert.equal(decide({ holders: [{ needBytes: -1 }] }).allowed, false);
});
test('missing telemetry cannot stand for available memory', () => {
  assert.equal(decide({ memory: { physicalAvailableBytes: 8 * GB } }).allowed, false);
});
test('two holders cannot be bypassed by a small job', () => {
  assert.equal(decide({ holders: [{ needBytes: GB }, { needBytes: GB }], needBytes: 1 }).allowed, false);
});
test('profiles and observed peaks determine reservations, not a fixed free-RAM threshold', () => {
  assert.equal(commandProfile(['git', 'push']).key, 'git');
  assert.equal(commandProfile(['pnpm', 'build']).key, 'build');
  assert.equal(estimateNeed({ key: 'tests', needBytes: GB }, { tests: { peakBytes: 2 * GB } }), 2.4 * GB);
  assert.throws(() => estimateNeed(commandProfile(['git']), {}, -1));
});

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'merit-heavy-test-'));
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sample = async () => ({ physicalAvailableBytes: 4 * GB, commitAvailableBytes: 8 * GB, sampledAt: (options.now ?? Date.now)(), processes: [] });
  return { root, gate: new HeavyGate(root, { sample, delay: async () => { throw new Error('test wait'); }, ...options }) };
}

test('concurrent admissions cannot both spend the same available headroom', async (t) => {
  const { root, gate } = fixture(t);
  const other = new HeavyGate(root, { sample: gate.sample, delay: gate.delay });
  const results = await Promise.allSettled([gate.take('one', { key: 'tests', needBytes: 2 * GB }), other.take('two', { key: 'tests', needBytes: 2 * GB })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await gate.status()).holders.length, 1);
  assert.equal((await gate.status()).queue.length, 0);
});

test('lease duration begins after admission, renew preserves identity, run release is refused', async (t) => {
  let now = 1000;
  const { gate } = fixture(t, { now: () => now });
  const held = await gate.take('lease', { key: 'lease', needBytes: GB }, { kind: 'lease', minutes: 2 });
  now += 30_000;
  const renewed = await gate.renew('lease', 3, held.id);
  assert.equal(renewed.id, held.id);
  assert.equal(renewed.expiresAt, now + 180_000);
  await gate.releaseLease('lease', held.id);
  await gate.take('run', { key: 'tests', needBytes: GB });
  await assert.rejects(gate.releaseLease('run'), /releases its own/);
});
test('stale lease tokens cannot renew or release a replacement with the same label', async (t) => {
  const { gate } = fixture(t);
  const old = await gate.take('lease', { key: 'lease', needBytes: GB }, { kind: 'lease' });
  await gate.releaseLease('lease', old.id);
  const current = await gate.take('lease', { key: 'lease', needBytes: GB }, { kind: 'lease' });
  await assert.rejects(gate.renew('lease', 2, old.id), /lease id/);
  await assert.rejects(gate.releaseLease('lease', old.id), /lease id/);
  assert.equal((await gate.status()).holders[0].id, current.id);
});

test('duplicate labels cannot replace or release another run', async (t) => {
  const { gate } = fixture(t);
  const held = await gate.take('same', { key: 'tests', needBytes: GB });
  await assert.rejects(gate.take('same', { key: 'tests', needBytes: GB }), /already holds/);
  await gate.release({ ...held, id: 'not-the-owner' });
  assert.equal((await gate.status()).holders.length, 1);
});

test('a dead launcher keeps its reservation while a known child survives', async (t) => {
  const live = new Set([process.pid, 81234]);
  const { gate } = fixture(t, { alive: (pid) => live.has(pid) });
  const held = await gate.take('child', { key: 'tests', needBytes: GB });
  await gate.update(held, { pid: 81233, childPid: 81234 });
  assert.equal((await gate.status()).holders.length, 1);
  live.delete(81234);
  assert.equal((await gate.status()).holders.length, 0);
});
test('an unregistered launch is retained after launcher death rather than guessed finished', async (t) => {
  const live = new Set([process.pid]);
  const { gate } = fixture(t, { alive: (pid) => live.has(pid) });
  const held = await gate.take('ambiguous', { key: 'tests', needBytes: GB });
  await gate.update(held, { pid: 81233, launchState: 'starting' });
  assert.equal((await gate.status()).holders.length, 1);
});

test('telemetry failures leave no admitted holder and do not bypass the queue', async (t) => {
  const { gate } = fixture(t, { sample: async () => { throw new Error('no telemetry'); } });
  await assert.rejects(gate.take('missing', { key: 'tests', needBytes: GB }), /test wait/);
  assert.equal((await gate.status()).holders.length, 0);
  assert.equal((await gate.status()).memory, null);
});

test('fully written dead lock ownership can be reclaimed without deleting live ownership', async (t) => {
  const { root } = fixture(t);
  atomicJson(path.join(root, 'admission.lock'), { pid: 81233, nonce: 'dead-owner' });
  let count = 0;
  await Promise.all([1, 2].map(() => withStateLock(root, async () => {
    const old = count;
    await new Promise((resolve) => setTimeout(resolve, 10));
    count = old + 1;
  }, { alive: (pid) => pid === process.pid })));
  assert.equal(count, 2);
});

test('corrupt persisted ownership is diagnosed rather than silently deleted', async (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, 'admission.lock'), '{broken');
  await assert.rejects(withStateLock(root, () => {}), SyntaxError);
});

test('footprints include child descendants and retain their observed peak', () => {
  const holder = { pid: 1, childPid: 2, needBytes: GB, peakBytes: 100 };
  const snapshot = { processes: [{ pid: 1, parentPid: 0, workingBytes: 20, privateBytes: 30 }, { pid: 2, parentPid: 1, workingBytes: 30, privateBytes: 40 }, { pid: 3, parentPid: 2, workingBytes: 40, privateBytes: 50 }] };
  const observed = holderFootprint(holder, snapshot);
  assert.equal(observed.workingBytes, 90);
  assert.equal(observed.privateBytes, 120);
  assert.equal(observed.peakBytes, 120);
  assert.deepEqual(observed.descendantPids, [1, 2, 3]);
});

test('native child arguments and failure exit status survive the actual platform launcher', () => {
  const script = fileURLToPath(new URL('./fixtures/heavy-argv.mjs', import.meta.url));
  const values = ['space here', '"quoted"', "apostrophe's", '$()', '`literal`', 'a&b', '%PATH%', '!literal!'];
  const command = childCommand([process.execPath, script, ...values]);
  const result = spawnSync(command.file, command.args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
  const failing = childCommand([process.execPath, script, '--exit-seven']);
  assert.equal(spawnSync(failing.file, failing.args, { encoding: 'utf8', windowsHide: true }).status, 7);
});

test('arbitrary batch commands refuse shell forwarding instead of losing arguments', () => {
  for (const file of ['helper.cmd', 'helper.bat']) {
    for (const args of [[], [''], ['space here'], ['a&b']]) {
      assert.throws(() => childCommand([file, ...args], 'win32'), /explicit native executable entry/);
    }
  }
});

test('Windows package-manager shim resolves to its real Node entry without a shell', { skip: process.platform !== 'win32' }, () => {
  const command = childCommand(['pnpm', '--version']);
  assert.match(command.file, /node\.exe$/i);
  assert.match(command.args[0], /pnpm\.(?:cjs|js)$/i);
  const result = spawnSync(command.file, command.args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

for (const manager of ['npm', 'npx']) {
  test(`Windows ${manager} shim resolves its CLI rather than the prefix helper`, { skip: process.platform !== 'win32' }, () => {
    const command = childCommand([manager, '--version']);
    assert.equal(path.basename(command.args[0]), `${manager}-cli.js`);
    const result = spawnSync(command.file, command.args, { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  });
}

test('real child failure returns its exit status and releases only its reservation', { skip: process.platform !== 'win32' }, async (t) => {
  const { gate } = fixture(t, { delay: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))) });
  const script = fileURLToPath(new URL('./fixtures/heavy-argv.mjs', import.meta.url));
  assert.equal(await runHeavySlot(['run', 'child-failure', '--', process.execPath, script, '--exit-seven'], { gate }), 7);
  assert.equal((await gate.status()).holders.length, 0);
});

test('synchronous spawn rejection releases its reservation in the same process', async (t) => {
  const { gate } = fixture(t);
  await assert.rejects(runHeavySlot(['run', 'invalid-child', '--', ''], { gate }));
  assert.equal((await gate.status()).holders.length, 0);
});

test('Windows telemetry supplies physical and commit headroom without command lines', { skip: process.platform !== 'win32' }, async (t) => {
  const dispatchedAt = Date.now();
  const snapshot = await memorySnapshot();
  const completedAt = Date.now();
  assert.equal(Number.isFinite(snapshot.physicalAvailableBytes), true);
  assert.equal(Number.isFinite(snapshot.commitAvailableBytes), true);
  assert.equal(snapshot.processes.some((entry) => entry.pid === process.pid), true);
  assert.equal(snapshot.processes.some((entry) => 'commandLine' in entry), false);
  assert.equal(snapshot.sampledAt >= dispatchedAt && snapshot.sampledAt <= completedAt, true);
  t.diagnostic(`probe dispatch ${completedAt - dispatchedAt}ms; headroom age ${completedAt - snapshot.sampledAt}ms`);
});

function worker(root, label, mode = 'normal') {
  const script = fileURLToPath(new URL('./fixtures/heavy-worker.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, root, label, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let errors = '';
    child.stderr.on('data', (data) => { errors += data; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors || `worker exit ${code}`)));
  });
}

test('real processes reclaim a crashed lock and admit in ticket order without overlap', { timeout: 15000 }, async (t) => {
  const { root, gate } = fixture(t);
  await worker(root, 'crashed', 'crash-lock');
  await Promise.all(['a', 'b', 'c'].map((label) => worker(root, label)));
  const events = readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.kind), ['start', 'end', 'start', 'end', 'start', 'end']);
  const order = events.filter((event) => event.kind === 'start').map((event) => event.sequence);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal((await gate.status()).holders.length, 0);
});

for (const mode of ['orphan', 'unregistered']) {
  test(`actual launcher death keeps its ${mode} child's reservation`, { timeout: 10000 }, async (t) => {
    const { root, gate } = fixture(t);
    await worker(root, mode, mode);
    const childPid = Number(readFileSync(path.join(root, 'test-child-pid'), 'utf8'));
    assert.equal(processAlive(childPid), true);
    assert.equal((await gate.status()).holders.length, 1);
    while (processAlive(childPid)) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await gate.status()).holders.length, mode === 'orphan' ? 0 : 1);
  });
}

test('unsupported process containment fails closed explicitly', () => {
  assert.throws(() => requireContainment('linux'), /no proven process-tree owner/);
  assert.throws(() => requireContainment('darwin'), /no proven process-tree owner/);
});

async function eventually(check) {
  while (!await check()) await new Promise((resolve) => setTimeout(resolve, 15));
}

test('kernel job waits for a detached grandchild after its short-lived parent exits', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const { root } = fixture(t);
  const script = fileURLToPath(new URL('./fixtures/heavy-process-tree.mjs', import.meta.url));
  const owned = await launchOwnedProcess(childCommand([process.execPath, script, root, 'orphan']));
  t.after(async () => { owned.cancel('SIGTERM'); await owned.done; });
  owned.start();
  await eventually(() => {
    try { return Number(readFileSync(path.join(root, 'parent.pid'), 'utf8')); } catch { return false; }
  });
  const parent = Number(readFileSync(path.join(root, 'parent.pid'), 'utf8'));
  const leaf = Number(readFileSync(path.join(root, 'leaf.pid'), 'utf8'));
  await eventually(() => !processAlive(parent));
  assert.equal(processAlive(leaf), true);
  let finished = false;
  owned.done.then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  writeFileSync(path.join(root, 'finish-leaf'), 'finish');
  assert.equal(await owned.done, 0);
  assert.equal(processAlive(leaf), false);
});

function ownedRunner(t, root, mode = 'wait') {
  const runner = fork(fileURLToPath(new URL('./fixtures/heavy-owned-runner.mjs', import.meta.url)), [root, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  const messages = [];
  runner.stdout.on('data', (data) => { stdout += data; });
  runner.stderr.on('data', (data) => { stderr += data; });
  runner.on('message', (message) => messages.push(message));
  const closed = new Promise((resolve, reject) => {
    runner.once('error', reject);
    runner.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, messages }));
  });
  t.after(async () => { runner.kill('SIGTERM'); await closed; });
  return { runner, closed };
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`owned tree cancellation preserves ${signal} intent despite hung telemetry`, { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
    const { root } = fixture(t);
    const { runner, closed } = ownedRunner(t, root, 'hung');
    await eventually(() => {
      try { return Number(readFileSync(path.join(root, 'parent.pid'), 'utf8')); } catch { return false; }
    });
    const parent = Number(readFileSync(path.join(root, 'parent.pid'), 'utf8'));
    const leaf = Number(readFileSync(path.join(root, 'leaf.pid'), 'utf8'));
    runner.send({ signal });
    const result = await closed;
    assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.stderr);
    assert.deepEqual(result.messages.at(-1), { code: result.code, aborted: true, holders: 0 });
    assert.equal(processAlive(parent), false);
    assert.equal(processAlive(leaf), false);
  });
}

test('a hung optional telemetry probe cannot block normal job completion', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  let samples = 0;
  let aborted = false;
  const { gate } = fixture(t, { sample: async ({ signal } = {}) => {
    if (++samples === 1) return { physicalAvailableBytes: 8 * GB, commitAvailableBytes: 8 * GB, sampledAt: Date.now(), processes: [] };
    signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  } });
  const script = fileURLToPath(new URL('./fixtures/heavy-argv.mjs', import.meta.url));
  assert.equal(await runHeavySlot(['run', 'hung-monitor', '--', process.execPath, script, '--exit-seven'], { gate }), 7);
  assert.equal(aborted, true);
  assert.equal(gate.state.holders().length, 0);
});

test('supervisor crash closes the job and kills detached descendants without PID-based cleanup', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const { root } = fixture(t);
  const script = fileURLToPath(new URL('./fixtures/heavy-process-tree.mjs', import.meta.url));
  const owned = await launchOwnedProcess(childCommand([process.execPath, script, root, 'wait']));
  t.after(async () => { owned.cancel('SIGTERM'); await owned.done; });
  owned.start();
  await eventually(() => {
    try { return Number(readFileSync(path.join(root, 'parent.pid'), 'utf8')); } catch { return false; }
  });
  const parent = Number(readFileSync(path.join(root, 'parent.pid'), 'utf8'));
  const leaf = Number(readFileSync(path.join(root, 'leaf.pid'), 'utf8'));
  owned.supervisor.kill('SIGKILL');
  assert.notEqual(await owned.done, 0);
  await eventually(() => !processAlive(parent) && !processAlive(leaf));
});

test('launcher death cancels its kernel-owned tree and permits safe reservation reaping', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const { root } = fixture(t);
  const { runner, closed } = ownedRunner(t, root);
  await eventually(() => {
    try { return Number(readFileSync(path.join(root, 'parent.pid'), 'utf8')); } catch { return false; }
  });
  const parent = Number(readFileSync(path.join(root, 'parent.pid'), 'utf8'));
  const leaf = Number(readFileSync(path.join(root, 'leaf.pid'), 'utf8'));
  const gate = new HeavyGate(path.join(root, 'gate'), { sample: async () => ({ physicalAvailableBytes: 8 * GB, commitAvailableBytes: 8 * GB, sampledAt: Date.now(), processes: [] }) });
  assert.equal(gate.state.holders()[0].containment, CONTAINMENT);
  runner.kill('SIGKILL');
  await closed;
  await eventually(() => !processAlive(parent) && !processAlive(leaf));
  await eventually(async () => (await gate.status()).holders.length === 0);
});

test('kernel launch preserves empty, quoted, Unicode and shell-character arguments', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const { root } = fixture(t);
  const values = ['', 'space here', '"quoted"', 'trailing\\', 'space trailing\\', 'café', '$()', '`literal`', 'a&b', '%PATH%', '!literal!'];
  writeFileSync(path.join(root, 'argv.json'), JSON.stringify(values));
  const { closed } = ownedRunner(t, root, 'argv');
  const result = await closed;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test('admission accepts immediate evidence and refuses invalid, future or stale timestamps', () => {
  const memory = { physicalAvailableBytes: 8 * GB, commitAvailableBytes: 8 * GB, sampledAt: 1000 };
  assert.equal(decide({ now: 1000, memory }).allowed, true);
  for (const sampledAt of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '1000', -1, 1001, 1000 - HEAVY_POLL_MS - 1]) {
    assert.equal(decide({ now: 1000, memory: { ...memory, sampledAt } }).allowed, false);
  }
  assert.equal(decide({ now: 1000 + HEAVY_POLL_MS + 1, memory }).allowed, false);
});

test('a delayed probe cannot turn old headroom into current admission evidence', async (t) => {
  let now = 10000;
  const { gate } = fixture(t, { now: () => now, sample: async () => {
    const sampledAt = now;
    now += HEAVY_POLL_MS + 1;
    return { physicalAvailableBytes: 8 * GB, commitAvailableBytes: 8 * GB, sampledAt, processes: [] };
  } });
  await assert.rejects(gate.take('delayed-probe', { key: 'tests', needBytes: GB }), /test wait/);
  assert.equal(gate.state.holders().length, 0);
  assert.equal(gate.state.tickets().length, 0);
});

test('telemetry freshness is checked after a delayed admission lock is acquired', async (t) => {
  let now = 10000;
  let blocker;
  const { gate } = fixture(t, { now: () => now });
  gate.sample = async () => {
    const snapshot = { physicalAvailableBytes: 8 * GB, commitAvailableBytes: 8 * GB, sampledAt: now, processes: [] };
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    blocker = gate.state.lock(async () => { entered(); await released; });
    await enteredPromise;
    setImmediate(() => { now += HEAVY_POLL_MS + 1; release(); });
    return snapshot;
  };
  await assert.rejects(gate.take('delayed-lock', { key: 'tests', needBytes: GB }), /test wait/);
  await blocker;
  assert.equal(gate.state.holders().length, 0);
  assert.equal(gate.state.tickets().length, 0);
});

test('Node preserves the OS probe timestamp instead of stamping delayed completion', { skip: process.platform !== 'win32' }, async () => {
  for (const sampledAt of [1234, undefined, null, '1234']) {
    const snapshot = await memorySnapshot({ executeWindows: async () => ({ stdout: JSON.stringify({ physicalAvailableBytes: 8 * GB, commitAvailableBytes: 8 * GB, sampledAt, processes: [] }) }) });
    assert.equal(snapshot.sampledAt, sampledAt);
  }
});

test('OS headroom timestamp follows inventory and precedes the delayed headroom query', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const queryFixture = `function Get-CimInstance { param([string]$ClassName)
    if ($ClassName -eq 'Win32_Process') {
      [Threading.Thread]::Sleep(120);
      $global:fixtureInventoryFinished=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
      [pscustomobject]@{ProcessId=$PID;ParentProcessId=0;WorkingSetSize=0;PrivatePageCount=0}
    } else {
      $queryStarted=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
      [Threading.Thread]::Sleep(120);
      [pscustomobject]@{AvailableBytes=$global:fixtureInventoryFinished;CommitLimit=$queryStarted;CommittedBytes=0}
    }
  }; `;
  const snapshot = await memorySnapshot({ executeWindows: (file, args, options) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    return promisify(execFile)(file, [...args.slice(0, -1), Buffer.from(queryFixture + script, 'utf16le').toString('base64')], options);
  } });
  assert.equal(snapshot.physicalAvailableBytes <= snapshot.sampledAt, true, 'inventory must finish before the timestamp');
  assert.equal(snapshot.sampledAt <= snapshot.commitAvailableBytes, true, 'timestamp must precede the headroom query');
  assert.equal(Date.now() - snapshot.sampledAt >= 100, true, 'the delayed headroom query must age the evidence');
});

test('unsupported platforms cannot acquire leases or launch work', async () => {
  let called = false;
  const gate = { take() { called = true; throw new Error('Admission must not be attempted.'); } };
  await assert.rejects(runHeavySlot(['acquire', 'unsupported'], { gate, platform: 'linux' }), /no proven process-tree owner/);
  await assert.rejects(runHeavySlot(['run', 'unsupported', '--', process.execPath], { gate, platform: 'darwin' }), /no proven process-tree owner/);
  assert.equal(called, false);
});
