import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, renameSync, linkSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  try { renameSync(temporary, file); } finally { removeFile(temporary); }
}

export function removeFile(file) {
  try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Reapers themselves form immutable claims. If a reaper dies, its successor claims
// that reaper's nonce; two cleaners can never both unlink a newly replaced lock.
function claimReaping(root, nonce, temporary, alive) {
  for (;;) {
    const claim = path.join(root, `reap-${nonce}.json`);
    try { linkSync(temporary, claim); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = readJson(claim);
      if (!prior || alive(prior.pid)) return false;
      nonce = prior.nonce;
    }
  }
}

// Retire the shared name before deleting its file. Windows keeps a deleted file
// pending while another reader holds it; opening that name then fails EPERM,
// rather than ENOENT. An atomic rename lets contenders see the next owner or no
// owner, while any readers of the prior inode finish under its private name.
function retireLock(lock, nonce) {
  const retired = `${lock}.retired-${nonce}`;
  renameSync(lock, retired);
  removeFile(retired);
}

/** Link a fully written owner record: another process never sees an empty lock. */
export async function withStateLock(root, action, { alive = processAlive, wait = () => new Promise((resolve) => setTimeout(resolve, 25)) } = {}) {
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, 'admission.lock');
  const owner = { pid: process.pid, nonce: randomUUID() };
  const temporary = path.join(root, `lock-${owner.pid}-${owner.nonce}.tmp`);
  writeFileSync(temporary, JSON.stringify(owner));
  let acquired = false;
  try {
    for (;;) {
      try { linkSync(temporary, lock); acquired = true; break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = readJson(lock);
        if (previous && !alive(previous.pid) && claimReaping(root, previous.nonce, temporary, alive)) {
          // Recheck identity so a released/replaced lock is never removed by a stale observation.
          if (readJson(lock)?.nonce === previous.nonce) retireLock(lock, previous.nonce);
        } else await wait();
      }
    }
    return await action();
  } finally {
    // A contender never owned the lock and has nothing to inspect or release.
    // A live owner cannot be reaped, so ownership lasts until this rename.
    try { if (acquired) retireLock(lock, owner.nonce); }
    finally { removeFile(temporary); }
  }
}

export class GateState {
  constructor(root) {
    this.root = root;
    this.queueDir = path.join(root, 'tickets');
    this.holderDir = path.join(root, 'holders');
    mkdirSync(this.queueDir, { recursive: true });
    mkdirSync(this.holderDir, { recursive: true });
  }
  lock(action) { return withStateLock(this.root, action); }
  holderPath(label) { return path.join(this.holderDir, `${createHash('sha256').update(label).digest('hex')}.json`); }
  ticketPath(id) { return path.join(this.queueDir, `${id}.json`); }
  list(directory) { return readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => readJson(path.join(directory, name))); }
  tickets() { return this.list(this.queueDir).sort((a, b) => a.sequence - b.sequence); }
  holders() { return this.list(this.holderDir); }
  history() { return readJson(path.join(this.root, 'history.json'), {}); }
  enqueue(label, needBytes, profile, pid = process.pid) {
    const metaPath = path.join(this.root, 'sequence.json');
    const sequence = readJson(metaPath, 0) + 1;
    atomicJson(metaPath, sequence);
    const ticket = { id: randomUUID(), sequence, label, needBytes, profile, pid, queuedAt: Date.now() };
    atomicJson(this.ticketPath(ticket.id), ticket);
    return ticket;
  }
  saveHolder(holder) { atomicJson(this.holderPath(holder.label), holder); }
  dropTicket(ticket) { removeFile(this.ticketPath(ticket.id)); }
  dropHolder(holder) {
    if (readJson(this.holderPath(holder.label))?.id === holder.id) removeFile(this.holderPath(holder.label));
  }
  learn(holder) {
    const history = this.history();
    const prior = history[holder.profile] ?? {};
    history[holder.profile] = { peakBytes: Math.max(prior.peakBytes ?? 0, holder.peakBytes ?? 0), observations: (prior.observations ?? 0) + 1 };
    atomicJson(path.join(this.root, 'history.json'), history);
  }
}
