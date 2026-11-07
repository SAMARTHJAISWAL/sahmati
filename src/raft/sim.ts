/**
 * Deterministic discrete-event simulation of a Raft cluster plus clients.
 *
 * Time is a number of simulated milliseconds that only moves when the
 * simulation processes an event or is told to advance. Every source of
 * randomness is one seeded Rng, and events at equal times fire in the order
 * they were scheduled, so (seed, config, actions) fully determines a run.
 */
import { RaftNode, type NodeEnv, type TimerKind } from './node';
import { EventQueue } from './queue';
import { Rng } from './rng';
import {
  clientEndpoint,
  endpointClient,
  isClientEndpoint,
  type ClientId,
  type ClientOp,
  type ClientReply,
  type Endpoint,
  type Message,
  type Mutations,
  type NodeId,
  type RaftOptions,
  type TraceEvent,
  type TraceKind,
} from './types';

export interface SimConfig {
  seed: number;
  /** Cluster size (3, 5 or 7 in the UI; any n ≥ 1 works). */
  n: number;
  electionTimeoutMin: number;
  electionTimeoutMax: number;
  heartbeatInterval: number;
  /** Mean one-way message latency, ms. */
  latency: number;
  /** Uniform jitter added to the latency: latency ± jitter. */
  jitter: number;
  /** Probability that any single message is lost. */
  dropRate: number;
  preVote: boolean;
  fastBackup: boolean;
  maxBatch: number;
  leaderNoop: boolean;
  clients: number;
  /** A client re-sends to another server if it hears nothing for this long. */
  clientTimeout: number;
  mutations: Mutations;
  /** Record a trace of every event (tests and the UI turn this on; the fuzzer leaves it off). */
  trace: boolean;
  /** Maximum number of trace events kept (oldest are discarded). 0 = unlimited. */
  traceLimit: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  n: 5,
  electionTimeoutMin: 150,
  electionTimeoutMax: 300,
  heartbeatInterval: 50,
  latency: 20,
  jitter: 8,
  dropRate: 0,
  preVote: false,
  fastBackup: false,
  maxBatch: 4,
  leaderNoop: true,
  clients: 1,
  clientTimeout: 250,
  mutations: {},
  trace: true,
  traceLimit: 0,
};

export type Action =
  | { type: 'crash'; node: NodeId }
  | { type: 'restart'; node: NodeId }
  | { type: 'timeout'; node: NodeId }
  | { type: 'partition'; groups: NodeId[][] }
  | { type: 'heal' }
  | { type: 'client'; client: ClientId; op: ClientOp; via: NodeId | null }
  | { type: 'drop'; rate: number }
  | { type: 'latency'; latency: number; jitter: number }
  | { type: 'preVote'; on: boolean }
  | { type: 'fastBackup'; on: boolean };

/** An action stamped with where in the run it happened: after `ev` events, at time `t`. */
export interface RecordedAction {
  ev: number;
  t: number;
  a: Action;
}

export type FlightFate = 'deliver' | 'drop' | 'partition';
export type FlightOutcome = 'delivered' | 'dropped' | 'partitioned' | 'lost';

export interface Flight {
  id: number;
  from: Endpoint;
  to: Endpoint;
  msg: Message;
  sentAt: number;
  /** When the message would arrive. */
  arriveAt: number;
  /** When the flight ends: arrival, or the moment it is lost. */
  endAt: number;
  fate: FlightFate;
  outcome?: FlightOutcome;
}

export interface HistoryOp {
  client: ClientId;
  seq: number;
  op: ClientOp;
  invoke: number;
  /** Time the client got a successful reply; null while pending (or forever, if never acknowledged). */
  response: number | null;
  /** For get: value returned. */
  value?: string | null;
  index?: number;
}

interface QueuedOp {
  op: ClientOp;
  via: NodeId | null;
}

export interface ClientState {
  id: ClientId;
  seq: number;
  queue: QueuedOp[];
  pending: { seq: number; op: ClientOp; target: NodeId; attempts: number; history: HistoryOp } | null;
  leaderGuess: NodeId | null;
  gen: number;
}

type SimEvent =
  | { type: 'deliver'; flight: Flight }
  | { type: 'timer'; node: NodeId; kind: TimerKind; gen: number }
  | { type: 'client'; client: ClientId; gen: number; redirectTo: NodeId | null };

export type Observer = (sim: Simulation) => void;

/** Rebuild a run from its starting config and recorded actions, then run to `end`. */
export function replay(config: Partial<SimConfig>, actions: readonly RecordedAction[], end?: { ev: number; t: number }): Simulation {
  const sim = new Simulation(config);
  for (const ra of actions) {
    while (sim.eventsProcessed < ra.ev && sim.step());
    if (ra.t > sim.now) sim.now = ra.t;
    sim.apply(ra.a);
  }
  if (end) {
    while (sim.eventsProcessed < end.ev && sim.step());
    if (end.t > sim.now) sim.now = end.t;
  }
  return sim;
}

export class Simulation {
  readonly config: SimConfig;
  /** The configuration the run started with (actions may change `config` later). */
  readonly initialConfig: SimConfig;
  readonly opts: RaftOptions;
  readonly rng: Rng;
  readonly nodes: RaftNode[];
  readonly clients: ClientState[];
  readonly history: HistoryOp[] = [];
  readonly actions: RecordedAction[] = [];
  trace: TraceEvent[] = [];
  /** Messages currently travelling. */
  readonly inFlight = new Map<number, Flight>();
  /** Recently finished flights (kept briefly for the UI's arrival/drop marks). */
  recent: Flight[] = [];
  /** groupOf[node] = partition group index; null = fully connected. */
  groupOf: number[] | null = null;

  now = 0;
  eventsProcessed = 0;
  messagesSent = 0;
  private queue = new EventQueue<SimEvent>();
  private uid = 0;
  private flightId = 0;
  private traceSeq = 0;
  private observers: Observer[] = [];
  onTrace: ((e: TraceEvent) => void) | null = null;

  constructor(config: Partial<SimConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config, mutations: { ...(config.mutations ?? {}) } };
    this.initialConfig = structuredClone(this.config);
    const c = this.config;
    this.opts = {
      electionTimeoutMin: c.electionTimeoutMin,
      electionTimeoutMax: c.electionTimeoutMax,
      heartbeatInterval: c.heartbeatInterval,
      preVote: c.preVote,
      fastBackup: c.fastBackup,
      maxBatch: c.maxBatch,
      leaderNoop: c.leaderNoop,
      mutations: c.mutations,
    };
    this.rng = new Rng(c.seed);
    const env: NodeEnv = {
      now: () => this.now,
      rng: this.rng,
      send: (from, to, msg) => this.send(from, to, msg),
      setTimer: (node, kind, gen, delay) => {
        this.queue.push(this.now + delay, { type: 'timer', node, kind, gen });
      },
      trace: (kind, node, text) => this.emit(kind, node, text),
      newUid: () => ++this.uid,
    };
    this.nodes = [];
    for (let i = 0; i < c.n; i++) this.nodes.push(new RaftNode(i, c.n, this.opts, env));
    this.clients = [];
    for (let i = 0; i < c.clients; i++) {
      this.clients.push({ id: i, seq: 0, queue: [], pending: null, leaderGuess: null, gen: 0 });
    }
    for (const node of this.nodes) node.start();
  }

  addObserver(o: Observer): void {
    this.observers.push(o);
  }

  // ---- Running -------------------------------------------------------------

  nextEventTime(): number | null {
    return this.queue.peek()?.time ?? null;
  }

  /** Process exactly one event. Returns false if the queue is empty. */
  step(): boolean {
    const ev = this.queue.pop();
    if (!ev) return false;
    this.now = Math.max(this.now, ev.time);
    this.eventsProcessed++;
    this.dispatch(ev.item);
    this.pruneRecent();
    for (const o of this.observers) o(this);
    return true;
  }

  /** Process every event with time ≤ t, then set the clock to t. */
  runUntil(t: number): void {
    for (;;) {
      const next = this.queue.peek();
      if (!next || next.time > t) break;
      this.step();
    }
    if (t > this.now) this.now = t;
    this.pruneRecent();
  }

  /** Run until `pred` holds (checked after every event) or `limit` ms of simulated time pass. */
  runUntilCondition(pred: (sim: Simulation) => boolean, limit: number): boolean {
    const end = this.now + limit;
    if (pred(this)) return true;
    for (;;) {
      const next = this.queue.peek();
      if (!next || next.time > end) break;
      this.step();
      if (pred(this)) return true;
    }
    this.now = Math.max(this.now, end);
    return pred(this);
  }

  private dispatch(e: SimEvent): void {
    switch (e.type) {
      case 'timer':
        this.nodes[e.node]!.onTimer(e.kind, e.gen);
        return;
      case 'deliver':
        this.finishFlight(e.flight);
        return;
      case 'client':
        this.onClientTimer(e.client, e.gen, e.redirectTo);
        return;
    }
  }

  // ---- Network -------------------------------------------------------------

  private send(from: Endpoint, to: Endpoint, msg: Message): void {
    const c = this.config;
    const latency = Math.max(1, c.latency + this.rng.range(-c.jitter, c.jitter));
    const roll = this.rng.next();
    const lossPoint = this.rng.range(0.35, 0.65);
    let fate: FlightFate = 'deliver';
    let endAt = this.now + latency;
    if (this.blocked(from, to)) {
      fate = 'partition';
      endAt = this.now + latency * 0.4;
    } else if (roll < c.dropRate) {
      fate = 'drop';
      endAt = this.now + latency * lossPoint;
    }
    const flight: Flight = { id: ++this.flightId, from, to, msg, sentAt: this.now, arriveAt: this.now + latency, endAt, fate };
    this.messagesSent++;
    this.inFlight.set(flight.id, flight);
    this.queue.push(endAt, { type: 'deliver', flight });
    if (c.trace) this.emit('send', isClientEndpoint(from) ? null : from, `${label(from)} → ${label(to)} ${describeMessage(msg)}`);
  }

  /** Partitions only separate servers; clients can reach every server. */
  private blocked(a: Endpoint, b: Endpoint): boolean {
    if (!this.groupOf || isClientEndpoint(a) || isClientEndpoint(b)) return false;
    return this.groupOf[a] !== this.groupOf[b];
  }

  private finishFlight(f: Flight): void {
    this.inFlight.delete(f.id);
    if (f.fate === 'drop') {
      f.outcome = 'dropped';
    } else if (f.fate === 'partition' || this.blocked(f.from, f.to)) {
      f.outcome = 'partitioned';
      f.endAt = this.now;
    } else if (!isClientEndpoint(f.to) && this.nodes[f.to]!.crashed) {
      f.outcome = 'lost';
    } else {
      f.outcome = 'delivered';
    }
    this.recent.push(f);
    if (f.outcome !== 'delivered') {
      if (this.config.trace) {
        const why = f.outcome === 'dropped' ? 'dropped by the network' : f.outcome === 'partitioned' ? 'blocked by the partition' : `lost (${label(f.to)} is down)`;
        this.emit('drop', isClientEndpoint(f.to) ? null : f.to, `${label(f.from)} → ${label(f.to)} ${describeMessage(f.msg)} ${why}`);
      }
      return;
    }
    if (this.config.trace) this.emit('deliver', isClientEndpoint(f.to) ? null : f.to, `${label(f.to)} ← ${label(f.from)} ${describeMessage(f.msg)}`);
    if (isClientEndpoint(f.to)) this.onClientMessage(endpointClient(f.to), f.from, f.msg as ClientReply);
    else this.nodes[f.to]!.receive(f.from, f.msg);
  }

  private pruneRecent(): void {
    const horizon = this.now - Math.max(40, this.config.latency * 2);
    if (this.recent.length > 0 && this.recent[0]!.endAt < horizon) {
      this.recent = this.recent.filter((f) => f.endAt >= horizon);
    }
  }

  // ---- Clients -------------------------------------------------------------

  private onClientMessage(id: ClientId, from: Endpoint, m: ClientReply): void {
    const c = this.clients[id]!;
    const p = c.pending;
    if (!p || m.seq !== p.seq) return;
    if (m.ok) {
      p.history.response = this.now;
      if (m.value !== undefined) p.history.value = m.value;
      if (m.index !== undefined) p.history.index = m.index;
      c.leaderGuess = from;
      c.pending = null;
      c.gen++;
      this.emit('client', null, `C${id + 1}: ${describeOp(p.op)} acknowledged by S${from + 1}${m.value !== undefined ? ` (value ${m.value ?? 'nil'})` : ''}`);
      this.startNextOp(c);
      return;
    }
    // Redirect. Follow the hint if there is a new one; otherwise wait a little and try someone else.
    c.gen++;
    if (m.leaderHint !== null && m.leaderHint !== p.target) {
      c.leaderGuess = m.leaderHint;
      this.emit('client', null, `C${id + 1}: S${from + 1} is not the leader; redirected to S${m.leaderHint + 1}`);
      this.attempt(c, m.leaderHint);
    } else {
      this.emit('client', null, `C${id + 1}: S${from + 1} does not know a leader; retrying shortly`);
      c.leaderGuess = null;
      this.queue.push(this.now + this.config.heartbeatInterval * 2, { type: 'client', client: id, gen: c.gen, redirectTo: null });
    }
  }

  private onClientTimer(id: ClientId, gen: number, redirectTo: NodeId | null): void {
    const c = this.clients[id]!;
    if (!c.pending || gen !== c.gen) return;
    let target = redirectTo;
    if (target === null) {
      const others = this.nodes.map((n) => n.id).filter((i) => i !== c.pending!.target);
      target = others.length > 0 ? this.rng.pick(others) : c.pending.target;
    }
    this.attempt(c, target);
  }

  private attempt(c: ClientState, target: NodeId): void {
    const p = c.pending!;
    p.target = target;
    p.attempts++;
    c.gen++;
    this.send(clientEndpoint(c.id), target, { type: 'ClientRequest', client: c.id, seq: p.seq, op: p.op });
    this.queue.push(this.now + this.config.clientTimeout, { type: 'client', client: c.id, gen: c.gen, redirectTo: null });
  }

  private startNextOp(c: ClientState): void {
    if (c.pending) return;
    const q = c.queue.shift();
    if (!q) return;
    const seq = ++c.seq;
    const h: HistoryOp = { client: c.id, seq, op: q.op, invoke: this.now, response: null };
    this.history.push(h);
    c.pending = { seq, op: q.op, target: 0, attempts: 0, history: h };
    const target = q.via ?? c.leaderGuess ?? this.rng.int(0, this.nodes.length - 1);
    this.emit('client', null, `C${c.id + 1}: sends ${describeOp(q.op)} to S${target + 1}`);
    this.attempt(c, target);
  }

  // ---- Actions (everything a user can do) ----------------------------------

  apply(a: Action): void {
    this.actions.push({ ev: this.eventsProcessed, t: this.now, a: structuredClone(a) });
    switch (a.type) {
      case 'crash':
        this.nodes[a.node]?.crash();
        break;
      case 'restart':
        this.nodes[a.node]?.restart();
        break;
      case 'timeout':
        this.nodes[a.node]?.timeoutNow();
        break;
      case 'partition':
        this.groupOf = normaliseGroups(a.groups, this.nodes.length);
        this.emit('partition', null, `Network partitioned: ${a.groups.map((g) => `{${g.map((x) => `S${x + 1}`).join(', ')}}`).join(' | ')}`);
        break;
      case 'heal':
        this.groupOf = null;
        this.emit('partition', null, 'Network healed: every server can reach every other');
        break;
      case 'client': {
        const c = this.clients[a.client];
        if (!c) break;
        c.queue.push({ op: a.op, via: a.via });
        this.startNextOp(c);
        break;
      }
      case 'drop':
        this.config.dropRate = a.rate;
        this.emit('config', null, `Message drop rate set to ${Math.round(a.rate * 100)}%`);
        break;
      case 'latency':
        this.config.latency = a.latency;
        this.config.jitter = a.jitter;
        this.emit('config', null, `Latency set to ${a.latency} ± ${a.jitter} ms`);
        break;
      case 'preVote':
        this.config.preVote = a.on;
        this.opts.preVote = a.on;
        this.emit('config', null, `PreVote ${a.on ? 'enabled' : 'disabled'}`);
        break;
      case 'fastBackup':
        this.config.fastBackup = a.on;
        this.opts.fastBackup = a.on;
        this.emit('config', null, `Fast log backtracking ${a.on ? 'enabled' : 'disabled'}`);
        break;
    }
    for (const o of this.observers) o(this);
  }

  // ---- Queries -------------------------------------------------------------

  /** The leader with the highest term among live servers, if any. */
  leader(): RaftNode | null {
    let best: RaftNode | null = null;
    for (const n of this.nodes) {
      if (!n.crashed && n.role === 'leader' && (!best || n.currentTerm > best.currentTerm)) best = n;
    }
    return best;
  }

  /** A canonical, comparable snapshot of all state (used to check replays and determinism). */
  fingerprint(): string {
    return JSON.stringify({
      now: this.now,
      ev: this.eventsProcessed,
      nodes: this.nodes.map((n) => ({
        term: n.currentTerm,
        votedFor: n.votedFor,
        role: n.role,
        crashed: n.crashed,
        commit: n.commitIndex,
        applied: n.lastApplied,
        log: n.log.map((e) => [e.term, e.uid]),
        kv: n.kv.snapshot(),
        deadline: n.electionDeadline,
      })),
      inFlight: [...this.inFlight.keys()],
      history: this.history,
      groups: this.groupOf,
    });
  }

  private emit(kind: TraceKind, node: NodeId | null, text: string): void {
    if (!this.config.trace) return;
    const e: TraceEvent = { seq: ++this.traceSeq, t: this.now, kind, node, text };
    this.trace.push(e);
    const lim = this.config.traceLimit;
    if (lim > 0 && this.trace.length > lim + 500) this.trace = this.trace.slice(-lim);
    this.onTrace?.(e);
  }
}

/** Every node ends up in exactly one group; unlisted nodes form one extra group. */
export function normaliseGroups(groups: NodeId[][], n: number): number[] {
  const groupOf = new Array<number>(n).fill(-1);
  groups.forEach((g, gi) => {
    for (const x of g) if (x >= 0 && x < n && groupOf[x] === -1) groupOf[x] = gi;
  });
  const extra = groups.length;
  for (let i = 0; i < n; i++) if (groupOf[i] === -1) groupOf[i] = extra;
  return groupOf;
}

export function label(e: Endpoint): string {
  return isClientEndpoint(e) ? `C${endpointClient(e) + 1}` : `S${e + 1}`;
}

export function describeOp(op: ClientOp): string {
  switch (op.kind) {
    case 'set':
      return `set ${op.key}=${op.value}`;
    case 'del':
      return `del ${op.key}`;
    case 'get':
      return `get ${op.key}`;
  }
}

export function describeMessage(m: Message): string {
  switch (m.type) {
    case 'RequestVote':
      return `${m.preVote ? 'PreVote' : 'RequestVote'}(term ${m.term}, last ${m.lastLogIndex}@t${m.lastLogTerm})`;
    case 'RequestVoteReply':
      return `${m.preVote ? 'PreVote' : 'Vote'} ${m.voteGranted ? 'granted' : 'denied'} (term ${m.term})`;
    case 'AppendEntries':
      return m.entries.length === 0
        ? `heartbeat(term ${m.term}, commit ${m.leaderCommit})`
        : `AppendEntries(term ${m.term}, prev ${m.prevLogIndex}@t${m.prevLogTerm}, ${m.entries.length} entr${m.entries.length === 1 ? 'y' : 'ies'}, commit ${m.leaderCommit})`;
    case 'AppendEntriesReply':
      return m.success ? `Append ok (match ${m.matchIndex}, term ${m.term})` : `Append rejected (term ${m.term})`;
    case 'ClientRequest':
      return `request #${m.seq} ${describeOp(m.op)}`;
    case 'ClientReply':
      return m.ok ? `reply #${m.seq} ok` : `redirect #${m.seq} → ${m.leaderHint === null ? 'unknown' : `S${m.leaderHint + 1}`}`;
  }
}
