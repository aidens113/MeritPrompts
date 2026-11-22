import { GateState, processAlive } from './state.mjs';
import { admission, estimateNeed, HEAVY_POLL_MS } from './policy.mjs';
import { holderFootprint, memorySnapshot } from './memory.mjs';
import { CONTAINMENT } from './owned-process.mjs';

export class HeavyGate {
  constructor(root, { sample = memorySnapshot, alive = processAlive, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
    this.state = new GateState(root);
    this.sample = sample;
    this.alive = alive;
    this.delay = delay;
    this.now = now;
  }
  prune(snapshot) {
    for (const ticket of this.state.tickets()) if (!this.alive(ticket.pid)) this.state.dropTicket(ticket);
    for (const held of this.state.holders()) {
      const observed = snapshot ? holderFootprint(held, snapshot) : held;
      const expired = held.kind === 'lease' && held.expiresAt <= this.now();
      if (held.containment !== undefined && held.containment !== CONTAINMENT) throw new Error('Unknown process containment metadata; reservation was retained.');
      // A contained supervisor cannot exit leaving executable descendants: its sole job handle is kill-on-close.
      const running = [held.pid, held.childPid, ...(held.containment === CONTAINMENT ? [] : observed.descendantPids ?? [])].filter(Number.isInteger).some((pid) => this.alive(pid));
      // A crash between spawn and durable PID registration is ambiguous. Retain it
      // for explicit reconciliation; a dead launcher is not proof its child is gone.
      const uncertainLaunch = held.kind === 'run' && held.launchState === 'starting';
      if (expired || (held.kind === 'run' && !running && !uncertainLaunch)) {
        this.state.learn(observed);
        this.state.dropHolder(held);
      } else if (snapshot) this.state.saveHolder(observed);
    }
  }
  async take(label, profile, { needBytes, kind = 'run', minutes = 60, onWait = () => {} } = {}) {
    const ticket = await this.state.lock(() => {
      this.prune();
      if ([...this.state.tickets(), ...this.state.holders()].some((item) => item.label === label)) throw new Error(`A job named ${label} already holds or waits for a slot.`);
      return this.state.enqueue(label, estimateNeed(profile, this.state.history(), needBytes), profile.key);
    });
    try {
      for (;;) {
        let snapshot;
        let telemetryError;
        try { snapshot = await this.sample(); } catch { telemetryError = 'memory telemetry is unavailable'; }
        const result = await this.state.lock(() => {
          this.prune(snapshot);
          const holders = this.state.holders();
          const decision = admission({ ticket, queue: this.state.tickets(), holders, memory: snapshot, needBytes: ticket.needBytes, now: this.now() });
          if (!decision.allowed) return { waiting: telemetryError ?? decision.reason };
          const holder = { ...ticket, kind, startedAt: this.now(), ...(kind === 'lease' ? { pid: undefined, expiresAt: this.now() + minutes * 60_000 } : { launchState: 'reserved' }) };
          this.state.saveHolder(holder);
          this.state.dropTicket(ticket);
          return { holder };
        });
        if (result.holder) return result.holder;
        onWait(result.waiting);
        await this.delay(HEAVY_POLL_MS);
      }
    } finally {
      await this.state.lock(() => this.state.dropTicket(ticket));
    }
  }
  async update(holder, patch = {}, snapshot) {
    return this.state.lock(() => {
      const current = this.state.holders().find((item) => item.id === holder.id);
      if (!current) throw new Error('This reservation is no longer held.');
      const next = { ...current, ...patch };
      const observed = snapshot ? holderFootprint(next, snapshot) : next;
      this.state.saveHolder(observed);
      return observed;
    });
  }
  async release(holder) {
    return this.state.lock(() => {
      const current = this.state.holders().find((item) => item.id === holder.id);
      if (!current) return;
      this.state.learn(current);
      this.state.dropHolder(current);
    });
  }
  async status() {
    let snapshot;
    try { snapshot = await this.sample(); } catch { /* Missing telemetry is reported, never treated as free memory. */ }
    return this.state.lock(() => {
      this.prune(snapshot);
      return { memory: snapshot ? { physicalAvailableBytes: snapshot.physicalAvailableBytes, commitAvailableBytes: snapshot.commitAvailableBytes, sampledAt: snapshot.sampledAt } : null, holders: this.state.holders(), queue: this.state.tickets() };
    });
  }
  async renew(label, minutes, leaseId) {
    return this.state.lock(() => {
      this.prune();
      const held = this.state.holders().find((item) => item.label === label);
      if (!held || held.kind !== 'lease') throw new Error('Renew requires an existing unexpired lease.');
      if (!leaseId || held.id !== leaseId) throw new Error('The lease id does not match this reservation.');
      const next = { ...held, expiresAt: this.now() + minutes * 60_000 };
      this.state.saveHolder(next);
      return next;
    });
  }
  async releaseLease(label, leaseId) {
    return this.state.lock(() => {
      const held = this.state.holders().find((item) => item.label === label);
      if (!held) return;
      if (held.kind !== 'lease') throw new Error('A running command releases its own reservation; release cannot remove it.');
      if (!leaseId || held.id !== leaseId) throw new Error('The lease id does not match this reservation.');
      this.state.learn(held);
      this.state.dropHolder(held);
    });
  }
}
