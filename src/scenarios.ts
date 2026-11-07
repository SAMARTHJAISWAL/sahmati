/**
 * Guided scenarios. Each is a starting configuration plus a list of steps.
 * A step optionally applies actions, then runs the simulation until its
 * condition holds, then pauses on a caption. The UI animates the "run until"
 * part; tests run the same steps headlessly (runScenarioHeadless).
 *
 * Everything is deterministic: the same scenario always produces the same run,
 * which is what lets the captions name specific servers and terms.
 */
import type { NodeId } from './raft/types';
import type { Action, SimConfig, Simulation } from './raft/sim';

export interface ScenarioContext {
  [name: string]: number;
}

export interface ScenarioStep {
  /** Actions applied when the step starts (after the user presses Next). */
  act?: (sim: Simulation, ctx: ScenarioContext) => Action[];
  /** Run until this holds. Omitted: pause immediately after acting. */
  until?: (sim: Simulation, ctx: ScenarioContext) => boolean;
  /** Give up waiting after this many simulated ms (default 4000). */
  within?: number;
  /** Called once the step's condition holds, to remember servers for later captions. */
  remember?: (sim: Simulation, ctx: ScenarioContext) => void;
  caption: (sim: Simulation, ctx: ScenarioContext) => string;
}

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  config: Partial<SimConfig>;
  steps: ScenarioStep[];
}

const S = (id: number | undefined): string => `S${(id ?? 0) + 1}`;
const leaderOf = (sim: Simulation): number => sim.leader()?.id ?? -1;
const live = (sim: Simulation) => sim.nodes.filter((n) => !n.crashed);
const allApplied = (sim: Simulation, index: number): boolean => live(sim).every((n) => n.lastApplied >= index);
const stableLeader = (sim: Simulation): boolean => {
  const l = sim.leader();
  return !!l && l.commitIndex >= 1 && l.commitIndex === l.lastLogIndex && allApplied(sim, l.commitIndex);
};
const others = (sim: Simulation, ...ids: number[]): NodeId[] => sim.nodes.map((n) => n.id).filter((i) => !ids.includes(i));
const inFlight = (sim: Simulation, pred: (type: string) => boolean): boolean => {
  for (const f of sim.inFlight.values()) if (pred(f.msg.type)) return true;
  return false;
};
const converged = (sim: Simulation): boolean => {
  const l = sim.leader();
  if (!l) return false;
  return sim.nodes.every(
    (n) =>
      !n.crashed &&
      n.currentTerm === l.currentTerm &&
      n.lastLogIndex === l.lastLogIndex &&
      n.commitIndex === l.commitIndex &&
      n.lastApplied === l.commitIndex &&
      n.log.every((e, i) => e.uid === l.log[i]!.uid),
  );
};

// ---------------------------------------------------------------------------

const election: Scenario = {
  id: 'election',
  title: 'A normal election',
  summary: 'Five followers, randomised timers, one winner.',
  config: { seed: 7, n: 5 },
  steps: [
    {
      caption: () =>
        'Five servers start as followers in term 0, with no leader. The ring around each one is its election timer, set to a random value between 150 and 300 ms. Whoever runs out first will stand for election.',
    },
    {
      until: (sim) => sim.nodes.some((n) => n.role === 'candidate'),
      remember: (sim, ctx) => {
        ctx.c = sim.nodes.find((n) => n.role === 'candidate')!.id;
      },
      caption: (_, ctx) =>
        `${S(ctx.c)} timed out first. It moved to term 1, voted for itself, and sent RequestVote (the amber diamonds) to the other four.`,
    },
    {
      until: (sim) => sim.leader() !== null,
      caption: (sim) =>
        `Each follower grants at most one vote per term, to the first candidate whose log is at least as up to date as its own. ${S(leaderOf(sim))} now holds a majority (3 of 5) and is the leader for term ${sim.leader()!.currentTerm}.`,
    },
    {
      until: (sim) => allApplied(sim, 1),
      caption: (sim) =>
        `A new leader appends a no-op entry and replicates it with AppendEntries (the blue squares). Once a majority stores it, the leader commits it; followers learn the commit index from later messages. ${S(leaderOf(sim))}'s heartbeats now reset everyone's timer.`,
    },
    {
      act: () => [],
      until: (sim) => sim.now > 900,
      caption: () =>
        'Steady state: empty AppendEntries every 50 ms act as heartbeats, so no follower times out while the leader is healthy. Try crashing the leader (click it) to see what happens next.',
    },
  ],
};

const leaderCrash: Scenario = {
  id: 'leader-crash',
  title: 'Leader crash and re-election',
  summary: 'The leader dies; the cluster notices, elects a new one, and repairs the old one when it returns.',
  config: { seed: 21, n: 5 },
  steps: [
    {
      until: stableLeader,
      remember: (sim, ctx) => {
        ctx.old = leaderOf(sim);
      },
      caption: (sim, ctx) => `${S(ctx.old)} is the leader for term ${sim.leader()!.currentTerm} and its no-op is committed everywhere.`,
    },
    {
      act: (_, ctx) => [{ type: 'crash', node: ctx.old! }],
      caption: (_, ctx) =>
        `${S(ctx.old)} has crashed. It keeps its persistent state (current term, vote, log) but loses everything else. The followers don't know yet: they only notice that heartbeats have stopped.`,
    },
    {
      until: (sim) => sim.nodes.some((n) => n.role === 'candidate'),
      caption: (sim) => {
        const c = sim.nodes.find((n) => n.role === 'candidate')!;
        return `${S(c.id)}'s timer ran out. It starts an election for term ${c.currentTerm}.`;
      },
    },
    {
      until: (sim) => !!sim.leader() && sim.leader()!.commitIndex === sim.leader()!.lastLogIndex,
      remember: (sim, ctx) => {
        ctx.new = leaderOf(sim);
      },
      caption: (sim, ctx) =>
        `${S(ctx.new)} won term ${sim.leader()!.currentTerm} with votes from a majority of the four live servers (three is enough out of five) and committed its own no-op.`,
    },
    {
      act: (_, ctx) => [{ type: 'client', client: 0, op: { kind: 'set', key: 'x', value: '1' }, via: ctx.new! }],
      until: (sim) => sim.history.length > 0 && sim.history[0]!.response !== null,
      caption: (_, ctx) => `The cluster still works with one server down: a write of x=1 through ${S(ctx.new)} commits on four servers.`,
    },
    {
      act: (_, ctx) => [{ type: 'restart', node: ctx.old! }],
      until: (sim) => converged(sim),
      caption: (_, ctx) =>
        `${S(ctx.old)} restarts as a follower. The leader's AppendEntries find where its log diverges, fill in the missing entries, and tell it the commit index, so it rebuilds its key-value state by replaying the log.`,
    },
  ],
};

const partition: Scenario = {
  id: 'partition',
  title: 'Network partition',
  summary: 'A minority leader cannot commit; the majority moves on; healing overwrites the stale entries.',
  config: { seed: 3, n: 5 },
  steps: [
    {
      until: stableLeader,
      remember: (sim, ctx) => {
        ctx.old = leaderOf(sim);
        ctx.buddy = (ctx.old + 1) % sim.nodes.length;
      },
      caption: (sim, ctx) => `${S(ctx.old)} leads term ${sim.leader()!.currentTerm}. We are about to cut the network in two.`,
    },
    {
      act: (sim, ctx) => [{ type: 'partition', groups: [[ctx.old!, ctx.buddy!], others(sim, ctx.old!, ctx.buddy!)] }],
      caption: (sim, ctx) =>
        `Partitioned: ${S(ctx.old)} (still leader) and ${S(ctx.buddy)} on one side, ${others(sim, ctx.old!, ctx.buddy!).map(S).join(', ')} on the other. Messages that cross the gap are lost.`,
    },
    {
      act: (_, ctx) => [{ type: 'client', client: 0, op: { kind: 'set', key: 'x', value: 'old' }, via: ctx.old! }],
      until: (sim, ctx) => sim.nodes[ctx.buddy!]!.lastLogIndex > sim.nodes[ctx.old!]!.commitIndex,
      remember: (sim, ctx) => {
        ctx.idx = sim.nodes[ctx.old!]!.lastLogIndex;
      },
      caption: (_, ctx) =>
        `A client writes x=old through ${S(ctx.old)}. It appends the entry at index ${ctx.idx} and replicates it to ${S(ctx.buddy)}, but two copies out of five is not a majority, so it can never commit. Note the hatched (uncommitted) cells.`,
    },
    {
      until: (sim, ctx) => sim.nodes.some((n) => n.role === 'leader' && n.id !== ctx.old),
      remember: (sim, ctx) => {
        ctx.new = sim.nodes.find((n) => n.role === 'leader' && n.id !== ctx.old)!.id;
      },
      within: 3000,
      caption: (sim, ctx) =>
        `On the majority side the followers stop hearing heartbeats and elect ${S(ctx.new)} for term ${sim.nodes[ctx.new!]!.currentTerm}. There are two leaders now, in different terms. Only the one that can reach a majority can commit anything.`,
    },
    {
      until: (sim) => sim.history[0]?.response !== null && sim.history.length > 0,
      within: 4000,
      caption: (_, ctx) =>
        `The client gave up waiting on ${S(ctx.old)}, tried another server, was redirected to ${S(ctx.new)}, and its write committed there. ${S(ctx.old)} still has its own uncommitted copy at index ${ctx.idx}.`,
    },
    {
      act: () => [{ type: 'heal' }],
      until: (sim, ctx) => sim.nodes[ctx.old!]!.role === 'follower',
      caption: (sim, ctx) =>
        `The network heals. ${S(ctx.old)} hears from a leader with a higher term (${sim.nodes[ctx.new!]!.currentTerm}) and steps down at once.`,
    },
    {
      until: converged,
      caption: (_, ctx) =>
        `${S(ctx.old)} and ${S(ctx.buddy)} had entries the new leader's log does not have at those indices. AppendEntries' consistency check finds the conflict; they delete those entries and take the leader's. Nothing committed was lost: the overwritten entries were never committed.`,
    },
  ],
};

function figure8(bug: boolean): Scenario {
  return {
    id: bug ? 'figure-8-bug' : 'figure-8',
    title: bug ? 'Figure 8, with the bug' : 'Figure 8: committing old-term entries',
    summary: bug
      ? 'The same moves, with a leader that commits old-term entries by counting replicas. The safety checker catches it.'
      : 'Why a leader may only count replicas for entries from its own term (§5.4.2).',
    config: { seed: 8, n: 5, maxBatch: 1, clientTimeout: 1e9, ...(bug ? { mutations: { commitOldTerms: true } } : {}) },
    steps: [
      {
        caption: () =>
          bug
            ? 'This replays the Figure 8 scenario, but every server runs a buggy rule: a leader commits any entry once it is on a majority, whatever its term. The safety checker in the corner watches the five properties after every event.'
            : 'This replays Figure 8 of the Raft paper: a sequence of crashes in which an entry that is stored on a majority can still be overwritten. AppendEntries carry one entry at a time here, so each step is visible.',
      },
      {
        act: () => [{ type: 'timeout', node: 0 }],
        until: (sim) => leaderOf(sim) === 0 && allApplied(sim, 1),
        caption: () => '(a) S1 is elected for term 1, and its no-op at index 1 is committed everywhere.',
      },
      {
        act: () => [
          { type: 'partition', groups: [[0, 1], [2, 3, 4]] },
          { type: 'client', client: 0, op: { kind: 'set', key: 'x', value: '1' }, via: 0 },
        ],
        until: (sim) => sim.nodes[1]!.lastLogIndex >= 2,
        caption: () =>
          'With S1 and S2 cut off from the rest, a client writes x=1 to S1. The entry at index 2 (term 1) reaches only S2: it is not committed.',
      },
      {
        act: () => [{ type: 'crash', node: 0 }, { type: 'timeout', node: 4 }],
        until: (sim) => leaderOf(sim) === 4,
        caption: (sim) =>
          `(b) S1 crashes. S5 times out and wins term ${sim.nodes[4]!.currentTerm} with votes from S3 and S4. As a new leader it appends a no-op at index 2: a different entry from S1's x=1, in a newer term.`,
      },
      {
        act: () => [
          { type: 'partition', groups: [[4], [0, 1, 2, 3]] },
          { type: 'crash', node: 4 },
          { type: 'restart', node: 0 },
          { type: 'timeout', node: 0 },
          { type: 'timeout', node: 0 },
        ],
        until: (sim) => leaderOf(sim) === 0,
        within: 3000,
        caption: (sim) =>
          `(c) S5 is cut off and crashes before its entry leaves it. S1 restarts and is elected for term ${sim.nodes[0]!.currentTerm} by S2, S3 and S4. It appends its own no-op at index 3 and starts bringing the others up to date, beginning with the old x=1 entry at index 2.`,
      },
      {
        until: (sim) => {
          const l = sim.nodes[0]!;
          return l.role === 'leader' && 1 + [1, 2, 3, 4].filter((i) => l.matchIndex[i]! >= 2).length >= 3;
        },
        caption: (sim) => {
          const l = sim.nodes[0]!;
          return bug
            ? `Index 2 (term 1) is now stored on a majority: S1, S2 and ${[2, 3].filter((i) => l.matchIndex[i]! >= 2).map(S).join(', ')}. The buggy leader counts those replicas and commits it: S1's commit index is ${l.commitIndex}, it has applied x=1, and it has told the client the write succeeded.`
            : `Index 2 (term 1) is now stored on a majority: S1, S2 and ${[2, 3].filter((i) => l.matchIndex[i]! >= 2).map(S).join(', ')}. But it is from an old term, so S1 does not count those replicas: its commit index stays at ${l.commitIndex}. Index 2 will commit only once S1's own no-op (index 3, term ${l.currentTerm}) is on a majority too.`;
        },
      },
      {
        act: () => [
          { type: 'partition', groups: [[0], [1, 2, 3, 4]] },
          { type: 'crash', node: 0 },
          { type: 'restart', node: 4 },
          { type: 'timeout', node: 4 },
          { type: 'timeout', node: 4 },
        ],
        until: (sim) => leaderOf(sim) === 4,
        within: 3000,
        caption: (sim) =>
          `(d) S1 crashes before its no-op reaches a majority. S5 comes back and wins term ${sim.nodes[4]!.currentTerm} with votes from S3 and S4: its last entry is from term 2, newer than the term-1 entry at the end of their logs.${bug ? ' S5 does not have the x=1 entry that S1 committed. The safety checker flags it: Leader Completeness is broken.' : ''}`,
      },
      {
        until: (sim) => [1, 2, 3].every((i) => sim.nodes[i]!.log[1]?.uid === sim.nodes[4]!.log[1]?.uid) && sim.nodes[4]!.commitIndex >= 3,
        caption: () =>
          bug
            ? 'S5 overwrites index 2 on every other server with its own entry and commits it. S1 had already applied x=1 at index 2, so two servers have now applied different commands at the same index, and a write the client was told had succeeded is gone.'
            : 'S5 overwrites index 2 everywhere with its own term-2 entry. That is safe because index 2 was never committed. Had S1 committed it by counting replicas in step (c), a committed entry would now be gone. That is Figure 8, and why a leader only counts replicas for entries from its own term.',
      },
      {
        act: (sim) => [{ type: 'heal' }, ...sim.nodes.filter((n) => n.crashed).map((n) => ({ type: 'restart' as const, node: n.id }))],
        until: converged,
        caption: () =>
          bug
            ? 'After the heal every log agrees again, but the damage is done: a client was told x=1 was committed, and it is gone. Run the safe version of this scenario to compare.'
            : 'After the heal every log agrees. Nothing that was committed was ever lost.',
      },
    ],
  };
}

const splitVote: Scenario = {
  id: 'split-vote',
  title: 'Split vote',
  summary: 'Four candidates at once: nobody wins, and randomised timeouts break the tie.',
  config: { seed: 11, n: 5 },
  steps: [
    {
      caption: () =>
        'Elections can fail. To force one, we make four of the five servers time out at the same instant.',
    },
    {
      act: () => [0, 1, 2, 3].map((node) => ({ type: 'timeout' as const, node })),
      until: (sim) => sim.now > 1 && !inFlight(sim, (t) => t === 'RequestVote' || t === 'RequestVoteReply'),
      caption: (sim) => {
        const best = Math.max(...sim.nodes.map((n) => (n.role === 'candidate' ? n.votes.size : 0)));
        return `S1 to S4 each voted for themselves in term 1, so only S5's vote was left to win. The best any candidate did was ${best} of 5; a majority needs 3. Term 1 ends without a leader.`;
      },
    },
    {
      until: (sim) => sim.leader() !== null,
      caption: (sim) =>
        `Each candidate waits out a fresh random timeout. ${S(leaderOf(sim))}'s expired first, so it started term ${sim.leader()!.currentTerm} before the others and collected a majority. Randomised timeouts make repeated split votes unlikely.`,
    },
  ],
};

const disruptive: Scenario = {
  id: 'prevote',
  title: 'A disruptive server, without and with PreVote',
  summary: 'An isolated server inflates its term and forces a needless election; PreVote stops it.',
  config: { seed: 5, n: 5, preVote: false },
  steps: [
    {
      until: stableLeader,
      remember: (sim, ctx) => {
        ctx.l = leaderOf(sim);
        ctx.f = (ctx.l + 2) % sim.nodes.length;
        ctx.t0 = sim.leader()!.currentTerm;
      },
      caption: (sim, ctx) => `${S(ctx.l)} leads term ${sim.leader()!.currentTerm}. PreVote is off.`,
    },
    {
      act: (sim, ctx) => [{ type: 'partition', groups: [[ctx.f!], others(sim, ctx.f!)] }],
      until: (sim, ctx) => sim.nodes[ctx.f!]!.currentTerm >= ctx.t0! + 3,
      within: 3000,
      caption: (sim, ctx) =>
        `${S(ctx.f)} is cut off. It hears no heartbeats, so it times out again and again, each time starting an election in a higher term. It is now in term ${sim.nodes[ctx.f!]!.currentTerm}, while the healthy cluster is still in term ${ctx.t0}.`,
    },
    {
      act: () => [{ type: 'heal' }],
      until: (sim, ctx) => sim.nodes[ctx.l!]!.role !== 'leader' || sim.nodes[ctx.l!]!.currentTerm > ctx.t0!,
      caption: (_, ctx) =>
        `The network heals. ${S(ctx.f)}'s messages carry its higher term, and the rule "if you see a higher term, step down" makes ${S(ctx.l)} give up leadership. The cluster was healthy, but it must now hold an election.`,
    },
    {
      until: (sim) => stableLeader(sim) && sim.leader()!.currentTerm > 0,
      remember: (sim, ctx) => {
        ctx.l = leaderOf(sim);
        ctx.t1 = sim.leader()!.currentTerm;
      },
      caption: (sim, ctx) =>
        `${S(ctx.l)} wins term ${ctx.t1}. ${S(ctx.f)} could not win (its log is behind), but it disrupted the cluster and pushed the term from ${ctx.t0} to ${sim.leader()!.currentTerm}. Now let's turn PreVote on and repeat.`,
    },
    {
      act: (sim, ctx) => {
        ctx.cut = sim.now;
        return [{ type: 'preVote', on: true }, { type: 'partition', groups: [[ctx.f!], others(sim, ctx.f!)] }];
      },
      until: (sim, ctx) => sim.now > ctx.cut! + 1200,
      caption: (sim, ctx) =>
        `With PreVote (Ongaro's thesis, §9.6), a server that times out first asks "would you vote for me in term ${sim.nodes[ctx.f!]!.currentTerm + 1}?" and only increments its term if a majority says yes. ${S(ctx.f)} has been isolated for over a second and is still in term ${sim.nodes[ctx.f!]!.currentTerm}.`,
    },
    {
      act: () => [{ type: 'heal' }],
      until: (sim, ctx) => sim.nodes[ctx.f!]!.leaderId === ctx.l && sim.nodes[ctx.f!]!.role === 'follower',
      caption: (sim, ctx) =>
        `Healing is now a non-event: the others refuse ${S(ctx.f)}'s pre-votes because they have heard from a leader recently, and ${S(ctx.f)} rejoins as a follower when the next heartbeat arrives. ${S(ctx.l)} is still leader in term ${sim.nodes[ctx.l!]!.currentTerm}.`,
    },
  ],
};

const redirect: Scenario = {
  id: 'redirect',
  title: 'A client write through a follower',
  summary: 'Redirect, append, replicate, commit, apply, reply.',
  config: { seed: 13, n: 5 },
  steps: [
    {
      until: stableLeader,
      remember: (sim, ctx) => {
        ctx.l = leaderOf(sim);
        ctx.f = (ctx.l + 1) % sim.nodes.length;
      },
      caption: (_, ctx) => `${S(ctx.l)} is the leader. The client (C1, below the ring) doesn't know that, and sends its write to ${S(ctx.f)}.`,
    },
    {
      act: (_, ctx) => [{ type: 'client', client: 0, op: { kind: 'set', key: 'color', value: 'blue' }, via: ctx.f! }],
      until: (sim) => inFlight(sim, (t) => t === 'ClientReply'),
      caption: (_, ctx) =>
        `Only the leader handles client requests. ${S(ctx.f)} replies with a redirect that names the leader it knows, ${S(ctx.l)}.`,
    },
    {
      until: (sim, ctx) => sim.nodes[ctx.l!]!.log.some((e) => e.cmd.kind === 'set'),
      remember: (sim, ctx) => {
        ctx.idx = sim.nodes[ctx.l!]!.lastLogIndex;
      },
      caption: (_, ctx) =>
        `The client retries at ${S(ctx.l)}, which appends "set color=blue" to its log at index ${ctx.idx}, uncommitted for now, and sends it to every follower in AppendEntries.`,
    },
    {
      until: (sim, ctx) => sim.nodes[ctx.l!]!.commitIndex >= ctx.idx!,
      caption: (_, ctx) =>
        `Once a majority (the leader plus two followers) has stored index ${ctx.idx}, the leader commits it, applies it to its key-value store and replies to the client.`,
    },
    {
      until: (sim, ctx) => allApplied(sim, ctx.idx!) && sim.history[0]?.response !== null,
      caption: () =>
        'Followers learn the new commit index from the next AppendEntries and apply the write too. Every server\'s key-value store (right of the log table) now has color=blue.',
    },
  ],
};

export const SCENARIOS: readonly Scenario[] = [
  election,
  leaderCrash,
  partition,
  figure8(false),
  splitVote,
  disruptive,
  redirect,
  figure8(true),
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export interface StepOutcome {
  caption: string;
  reached: boolean;
}

/**
 * Run one step to completion without animation. The UI uses the same three
 * phases (act, run until, caption) but spreads the middle one over frames.
 */
export function startStep(sim: Simulation, step: ScenarioStep, ctx: ScenarioContext): void {
  for (const a of step.act?.(sim, ctx) ?? []) sim.apply(a);
}

export function finishStep(sim: Simulation, step: ScenarioStep, ctx: ScenarioContext, reached: boolean): StepOutcome {
  if (reached) step.remember?.(sim, ctx);
  return { caption: step.caption(sim, ctx), reached };
}

export function runStepHeadless(sim: Simulation, step: ScenarioStep, ctx: ScenarioContext): StepOutcome {
  startStep(sim, step, ctx);
  const reached = step.until ? sim.runUntilCondition((s) => step.until!(s, ctx), step.within ?? 4000) : true;
  return finishStep(sim, step, ctx, reached);
}
