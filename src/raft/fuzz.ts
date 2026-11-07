/**
 * Randomised fault-injection runs ("fuzz cases"). A case is generated from a
 * seed: a random cluster configuration plus a timed list of faults and client
 * operations. Running it checks the five safety properties after every event,
 * then heals everything and checks liveness and linearizability.
 */
import { SafetyChecker, type Violation } from './invariants';
import { checkLinearizable } from './linearizability';
import { Rng } from './rng';
import { Simulation, type Action, type SimConfig } from './sim';
import type { ClientOp, Mutations } from './types';

/**
 * Fuzz actions are concrete simulator actions plus two leader-targeted ones,
 * resolved against the live state when they fire ("crash whoever is leader
 * now"). Resolution is deterministic, so replay is unaffected.
 */
export type FuzzAction =
  | Action
  | { type: 'crashLeader' }
  | { type: 'isolateLeader'; withOne: boolean }
  /**
   * Leader churn: crash each of the next `count` leaders a random time (up to
   * `maxDelay` ms) after it is elected, optionally cutting it off first, and
   * bring it back a random time (up to `revive` ms) later. This is what produces the half-replicated logs of Figure 8
   * often enough to matter.
   */
  | { type: 'churn'; maxDelay: number; revive: number; count: number; isolate: boolean };

const FAULT_KINDS = [
  'crash',
  'bounce',
  'crashLeader',
  'churn',
  'restart',
  'partition',
  'isolateLeader',
  'heal',
  'timeout',
  'drop',
  'latency',
] as const;
type FaultKind = (typeof FAULT_KINDS)[number];

export interface TimedAction {
  t: number;
  a: FuzzAction;
}

export interface FuzzCase {
  seed: number;
  config: Partial<SimConfig>;
  actions: TimedAction[];
  /** Faults stop at this time; then the network heals and every server restarts. */
  horizon: number;
  /** Liveness bound: after the heal, the cluster must converge within this much simulated time. */
  livenessBound: number;
}

export type Failure =
  | { kind: 'safety'; violation: Violation }
  | { kind: 'liveness'; message: string }
  | { kind: 'linearizability'; message: string };

export interface FuzzResult {
  ok: boolean;
  failure?: Failure;
  events: number;
  messages: number;
  simTime: number;
  /** Simulated ms from the heal until the cluster converged. */
  convergeTime: number;
  clientOps: number;
  acked: number;
  linStates: number;
}

export interface GenerateOptions {
  mutations?: Mutations;
  horizon?: number;
  /** Range for the number of faults injected. */
  faults?: [number, number];
  /** Range for the number of client operations. */
  ops?: [number, number];
}

export function generateCase(seed: number, options: GenerateOptions = {}): FuzzCase {
  const rng = new Rng(seed ^ 0x5eed_f00d);
  const n = rng.pick([3, 5, 5, 7]);
  const clients = rng.int(1, 3);
  const latency = rng.int(4, 40);
  const config: Partial<SimConfig> = {
    seed,
    n,
    clients,
    latency,
    jitter: rng.int(0, Math.floor(latency / 2)),
    dropRate: rng.pick([0, 0, 0.02, 0.1, 0.25]),
    preVote: rng.chance(0.5),
    fastBackup: rng.chance(0.5),
    maxBatch: rng.pick([1, 1, 2, 4, 64]),
    leaderNoop: rng.chance(0.8),
    mutations: options.mutations ?? {},
    trace: false,
  };
  const horizon = options.horizon ?? 3000;
  const actions: TimedAction[] = [];
  const [fLo, fHi] = options.faults ?? [4, 30];
  const faults = rng.int(fLo, fHi);
  // Swarm testing (Groce et al., ISSTA 2012): each case enables a random subset of fault
  // kinds, with random weights. Leaving kinds out lets the others pile up, which reaches
  // deep states (long chains of leader changes, say) far more often than an even mix.
  const kinds = FAULT_KINDS.filter(() => rng.chance(0.55));
  if (kinds.length === 0) kinds.push(rng.pick(FAULT_KINDS));
  const weights = kinds.map(() => rng.range(0.2, 1));
  const total = weights.reduce((x, y) => x + y, 0);
  const pickKind = (): FaultKind => {
    let r = rng.next() * total;
    for (let i = 0; i < kinds.length; i++) if ((r -= weights[i]!) < 0) return kinds[i]!;
    return kinds[kinds.length - 1]!;
  };
  for (let i = 0; i < faults; i++) {
    const t = rng.range(0, horizon);
    let a: FuzzAction;
    switch (pickKind()) {
      case 'crash':
        a = { type: 'crash', node: rng.int(0, n - 1) };
        break;
      case 'bounce': {
        // Crash a server and restart it soon after (it may forget a vote cast just before).
        const node = rng.int(0, n - 1);
        actions.push({ t: Math.min(horizon, t + rng.range(1, 3 * latency)), a: { type: 'restart', node } });
        a = { type: 'crash', node };
        break;
      }
      case 'crashLeader':
        a = { type: 'crashLeader' };
        break;
      case 'churn':
        a = { type: 'churn', maxDelay: rng.range(latency, 8 * latency), revive: rng.range(4 * latency, 600), count: rng.int(1, 8), isolate: rng.chance(0.5) };
        break;
      case 'restart':
        a = { type: 'restart', node: rng.int(0, n - 1) };
        break;
      case 'partition':
        a = { type: 'partition', groups: randomGroups(rng, n) };
        break;
      case 'isolateLeader':
        a = { type: 'isolateLeader', withOne: rng.chance(0.5) };
        break;
      case 'heal':
        a = { type: 'heal' };
        break;
      case 'timeout':
        a = { type: 'timeout', node: rng.int(0, n - 1) };
        break;
      case 'drop':
        a = { type: 'drop', rate: rng.pick([0, 0.05, 0.2, 0.4]) };
        break;
      case 'latency': {
        // Latency spikes: messages slower than an election timeout, so replies arrive a term late.
        const spike = rng.chance(0.6);
        const l = spike ? rng.int(60, 220) : rng.int(4, 40);
        a = { type: 'latency', latency: l, jitter: rng.int(0, Math.floor(spike ? l : l / 2)) };
        break;
      }
    }
    actions.push({ t, a });
  }
  const [oLo, oHi] = options.ops ?? [4, 24];
  const ops = rng.int(oLo, oHi);
  let counter = 0;
  for (let i = 0; i < ops; i++) {
    const t = rng.range(0, horizon);
    const key = rng.pick(['x', 'y']);
    const roll = rng.next();
    const op: ClientOp =
      roll < 0.6 ? { kind: 'set', key, value: `v${++counter}` } : roll < 0.9 ? { kind: 'get', key } : { kind: 'del', key };
    const via = rng.chance(0.5) ? rng.int(0, n - 1) : null;
    actions.push({ t, a: { type: 'client', client: rng.int(0, clients - 1), op, via } });
  }
  actions.sort((x, y) => x.t - y.t);
  return { seed, config, actions, horizon, livenessBound: 4000 };
}

function resolve(sim: Simulation, a: Exclude<FuzzAction, { type: 'churn' }>): Action | null {
  if (a.type === 'crashLeader') {
    const l = sim.leader();
    return l ? { type: 'crash', node: l.id } : null;
  }
  if (a.type === 'isolateLeader') {
    const l = sim.leader();
    if (!l) return null;
    const minority = [l.id];
    if (a.withOne && sim.nodes.length > 3) minority.push((l.id + 1) % sim.nodes.length);
    return { type: 'partition', groups: [minority, sim.nodes.map((x) => x.id).filter((x) => !minority.includes(x))] };
  }
  return a;
}

function randomGroups(rng: Rng, n: number): number[][] {
  const ids = rng.shuffle([...Array(n).keys()]);
  const k = rng.chance(0.75) ? 2 : 3;
  const groups: number[][] = Array.from({ length: k }, () => []);
  ids.forEach((id, i) => groups[i < k ? i : rng.int(0, k - 1)]!.push(id));
  return groups;
}

export function runCase(c: FuzzCase): FuzzResult {
  const sim = new Simulation(c.config);
  const checker = new SafetyChecker();
  sim.addObserver((s) => checker.check(s));
  const result = (failure?: Failure, convergeTime = 0, linStates = 0): FuzzResult => {
    const r: FuzzResult = {
      ok: !failure,
      events: sim.eventsProcessed,
      messages: sim.messagesSent,
      simTime: sim.now,
      convergeTime,
      clientOps: sim.history.length,
      acked: sim.history.filter((h) => h.response !== null).length,
      linStates,
    };
    if (failure) r.failure = failure;
    return r;
  };
  const safety = (): Failure | undefined =>
    checker.violation ? { kind: 'safety', violation: checker.violation } : undefined;

  // The churn nemesis: crash new leaders shortly after election, revive them later.
  let churn: { maxDelay: number; revive: number; left: number; isolate: boolean } | null = null;
  const nemesisRng = new Rng(c.seed ^ 0x6e3e_5155);
  const doom = new Map<number, number>();
  const revivals: { node: number; at: number }[] = [];
  const nemesis = (): void => {
    if (!churn || churn.left <= 0) return;
    const l = sim.leader();
    if (!l) return;
    const key = l.currentTerm * 64 + l.id;
    let at = doom.get(key);
    if (at === undefined) {
      // Skewed towards short delays: a leader cut off before its first AppendEntries lands keeps its entries to itself.
      at = sim.now + churn.maxDelay * nemesisRng.next() ** 2;
      doom.set(key, at);
    }
    if (sim.now >= at) {
      // Cutting it off first also loses whatever it has in flight, so its newest entries stay on it alone.
      if (churn.isolate) sim.apply({ type: 'partition', groups: [[l.id], sim.nodes.map((x) => x.id).filter((x) => x !== l.id)] });
      sim.apply({ type: 'crash', node: l.id });
      revivals.push({ node: l.id, at: sim.now + nemesisRng.range(0, churn.revive) });
      churn.left--;
    }
  };
  const stepTo = (t: number): void => {
    for (;;) {
      if (checker.violation) return;
      revivals.sort((x, y) => x.at - y.at);
      const due = revivals[0]?.at ?? Infinity;
      const next = sim.nextEventTime() ?? Infinity;
      if (Math.min(due, next) > t) break;
      if (due <= next) {
        sim.runUntil(due);
        const r = revivals.shift()!;
        if (sim.groupOf && sim.groupOf.filter((g) => g === sim.groupOf![r.node]).length === 1) sim.apply({ type: 'heal' });
        if (sim.nodes[r.node]!.crashed) sim.apply({ type: 'restart', node: r.node });
      } else {
        sim.step();
        nemesis();
      }
    }
    sim.runUntil(t);
  };

  for (const { t, a } of c.actions) {
    stepTo(t);
    if (checker.violation) return result(safety());
    if (a.type === 'churn') churn = { maxDelay: a.maxDelay, revive: a.revive, left: a.count, isolate: a.isolate };
    else {
      const concrete = resolve(sim, a);
      if (concrete) sim.apply(concrete);
    }
    if (checker.violation) return result(safety());
  }
  stepTo(c.horizon);
  if (checker.violation) return result(safety());

  // Liveness: heal the network, stop dropping messages, restart everyone.
  sim.apply({ type: 'heal' });
  sim.apply({ type: 'drop', rate: 0 });
  sim.apply({ type: 'latency', latency: sim.initialConfig.latency, jitter: sim.initialConfig.jitter });
  for (const node of sim.nodes) if (node.crashed) sim.apply({ type: 'restart', node: node.id });
  const healedAt = sim.now;
  // Clients drain their backlog one operation at a time, so the bound grows with it.
  const backlog = sim.clients.reduce((k, cl) => k + cl.queue.length + (cl.pending ? 1 : 0), 0);
  const bound = c.livenessBound + 400 * backlog;
  const deadline = healedAt + bound;
  let converged = false;
  while (!converged && !checker.violation && sim.now < deadline) {
    // Without the election no-op, a new leader cannot commit earlier-term entries until it
    // commits something of its own (§5.4.2), so an idle client issues a read to move it along.
    if (!sim.config.leaderNoop && sim.clients.every((cl) => !cl.pending && cl.queue.length === 0)) {
      const l = sim.leader();
      if (l && l.commitIndex < l.lastLogIndex) sim.apply({ type: 'client', client: 0, op: { kind: 'get', key: 'x' }, via: null });
    }
    converged = sim.runUntilCondition(isConverged, Math.min(250, deadline - sim.now));
  }
  if (checker.violation) return result(safety());
  if (!converged) {
    return result({ kind: 'liveness', message: `cluster did not converge within ${bound} ms of the heal: ${describeState(sim)}` });
  }
  const convergeTime = sim.now - healedAt;

  // Acknowledged writes are never lost: each one sits at its reported index in the final log.
  const leader = sim.leader()!;
  for (const h of sim.history) {
    if (h.response === null || h.index === undefined) continue;
    const e = leader.log[h.index - 1];
    if (!e || e.cmd.kind === 'noop' || e.cmd.client !== h.client || e.cmd.seq !== h.seq) {
      return result({ kind: 'linearizability', message: `acknowledged op C${h.client + 1}#${h.seq} is not at index ${h.index} of the final log` }, convergeTime);
    }
  }
  // Linearizability of the client history, plus a final read of every key from the converged state.
  const finalReads = ['x', 'y'].map((key) => ({
    client: -1,
    seq: 0,
    op: { kind: 'get' as const, key },
    invoke: sim.now,
    response: sim.now,
    value: leader.kv.data.get(key) ?? null,
  }));
  const lin = checkLinearizable([...sim.history, ...finalReads]);
  if (!lin.ok) {
    return result({ kind: 'linearizability', message: `history on key ${lin.key} (${lin.ops} ops) is not linearizable${lin.exhausted ? ' (search budget exhausted)' : ''}` }, convergeTime, lin.states);
  }
  return result(undefined, convergeTime, lin.states);
}

/** One leader that everyone follows, identical committed logs, all state applied, no client waiting. */
export function isConverged(sim: Simulation): boolean {
  const leader = sim.leader();
  if (!leader) return false;
  for (const c of sim.clients) if (c.pending || c.queue.length > 0) return false;
  if (leader.commitIndex !== leader.lastLogIndex) return false;
  for (const n of sim.nodes) {
    if (n.crashed) return false;
    if (n !== leader && (n.role !== 'follower' || n.leaderId !== leader.id)) return false;
    if (n.currentTerm !== leader.currentTerm) return false;
    if (n.commitIndex !== leader.commitIndex || n.lastApplied !== n.commitIndex) return false;
    if (n.lastLogIndex < leader.commitIndex) return false;
    for (let i = 0; i < leader.commitIndex; i++) if (n.log[i]!.uid !== leader.log[i]!.uid) return false;
    if (n.lastLogIndex !== leader.lastLogIndex) return false;
  }
  return true;
}

function describeState(sim: Simulation): string {
  return sim.nodes
    .map((n) => `S${n.id + 1}[${n.role} t${n.currentTerm} log${n.lastLogIndex} commit${n.commitIndex}${n.crashed ? ' crashed' : ''}]`)
    .join(' ');
}

/**
 * Greedy shrinking: repeatedly try dropping each action (and then halving the
 * horizon) while the case still fails the same way. Deterministic replay makes
 * this sound: a smaller case that fails is a genuine, smaller reproduction.
 */
export function shrink(c: FuzzCase, sameFailure: (r: FuzzResult) => boolean, budget = 400): FuzzCase {
  let best = c;
  let tries = 0;
  let progress = true;
  while (progress && tries < budget) {
    progress = false;
    for (let i = best.actions.length - 1; i >= 0 && tries < budget; i--) {
      const candidate = { ...best, actions: best.actions.filter((_, j) => j !== i) };
      tries++;
      if (sameFailure(runCase(candidate))) {
        best = candidate;
        progress = true;
      }
    }
  }
  return best;
}

export function describeFailure(f: Failure): string {
  if (f.kind === 'safety') return `${f.violation.property} violated at t=${f.violation.t.toFixed(1)}ms (event ${f.violation.ev}): ${f.violation.message}`;
  return `${f.kind}: ${f.message}`;
}

/** A printable reproduction of a case: paste it into tests/repro.test.ts or `runCase(JSON.parse(...))`. */
export function reproduction(c: FuzzCase): string {
  return JSON.stringify({ seed: c.seed, config: c.config, horizon: c.horizon, livenessBound: c.livenessBound, actions: c.actions }, null, 0);
}
