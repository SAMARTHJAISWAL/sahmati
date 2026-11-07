import { RaftNode, type NodeEnv, type TimerKind } from '../src/raft/node';
import { Rng } from '../src/raft/rng';
import type { Command, Endpoint, Entry, Message, RaftOptions } from '../src/raft/types';

export interface Sent {
  to: Endpoint;
  msg: Message;
}

export interface Harness {
  node: RaftNode;
  sent: Sent[];
  timers: { kind: TimerKind; gen: number; delay: number }[];
  setNow(t: number): void;
  /** Messages sent since the last call, then forget them. */
  take(): Sent[];
}

export const OPTS: RaftOptions = {
  electionTimeoutMin: 150,
  electionTimeoutMax: 300,
  heartbeatInterval: 50,
  preVote: false,
  fastBackup: false,
  maxBatch: 64,
  leaderNoop: true,
  mutations: {},
};

let uid = 1000;

/** A single node wired to a fake environment that records what it sends. */
export function harness(id = 0, n = 5, opts: Partial<RaftOptions> = {}): Harness {
  let now = 0;
  const sent: Sent[] = [];
  const timers: Harness['timers'] = [];
  const env: NodeEnv = {
    now: () => now,
    rng: new Rng(42),
    send: (_from, to, msg) => sent.push({ to, msg }),
    setTimer: (_node, kind, gen, delay) => timers.push({ kind, gen, delay }),
    trace: () => {},
    newUid: () => ++uid,
  };
  const node = new RaftNode(id, n, { ...OPTS, ...opts, mutations: { ...(opts.mutations ?? {}) } }, env);
  node.start();
  return {
    node,
    sent,
    timers,
    setNow: (t) => {
      now = t;
    },
    take: () => sent.splice(0, sent.length),
  };
}

const NOOP: Command = { kind: 'noop' };

/** Build a log from a list of terms. */
export function logOf(...terms: number[]): Entry[] {
  return terms.map((term) => ({ term, uid: ++uid, cmd: NOOP }));
}

export function entry(term: number, cmd: Command = NOOP): Entry {
  return { term, uid: ++uid, cmd };
}

export function lastReply<T extends Message['type']>(h: Harness, type: T): Extract<Message, { type: T }> {
  for (let i = h.sent.length - 1; i >= 0; i--) {
    const m = h.sent[i]!.msg;
    if (m.type === type) return m as Extract<Message, { type: T }>;
  }
  throw new Error(`no ${type} sent`);
}
