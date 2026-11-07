/**
 * Unit tests for the rules in Figure 2 of the Raft paper, one handler at a
 * time, against a single node with a recording fake environment.
 */
import { describe, expect, it } from 'vitest';
import type { AppendEntries, AppendEntriesReply, RequestVote } from '../src/raft/types';
import { clientEndpoint } from '../src/raft/types';
import { entry, harness, lastReply, logOf } from './helpers';

const rv = (over: Partial<RequestVote> = {}): RequestVote => ({
  type: 'RequestVote',
  term: 1,
  candidateId: 1,
  lastLogIndex: 0,
  lastLogTerm: 0,
  preVote: false,
  ...over,
});

const ae = (over: Partial<AppendEntries> = {}): AppendEntries => ({
  type: 'AppendEntries',
  term: 1,
  leaderId: 1,
  prevLogIndex: 0,
  prevLogTerm: 0,
  entries: [],
  leaderCommit: 0,
  ...over,
});

const ok = (over: Partial<AppendEntriesReply> = {}): AppendEntriesReply => ({
  type: 'AppendEntriesReply',
  term: 1,
  success: true,
  prevLogIndex: 0,
  matchIndex: 0,
  ...over,
});

/** A node elected leader of a 3-server cluster (node 0), with an optional pre-existing log. */
function leaderOf3(opts: Parameters<typeof harness>[2] = {}, setup?: (h: ReturnType<typeof harness>) => void) {
  const h = harness(0, 3, opts);
  setup?.(h);
  h.node.timeoutNow();
  const term = h.node.currentTerm;
  h.node.receive(1, { type: 'RequestVoteReply', term, voteGranted: true, preVote: false });
  expect(h.node.role).toBe('leader');
  h.take();
  return h;
}

describe('RequestVote receiver', () => {
  it('grants a vote to the first candidate in a term and records votedFor', () => {
    const h = harness();
    h.node.receive(1, rv({ term: 1, candidateId: 1 }));
    expect(lastReply(h, 'RequestVoteReply')).toMatchObject({ term: 1, voteGranted: true });
    expect(h.node.votedFor).toBe(1);
    expect(h.node.currentTerm).toBe(1);
  });

  it('resets the election timer when it grants a vote', () => {
    const h = harness();
    const before = h.timers.length;
    h.setNow(40);
    h.node.receive(1, rv());
    expect(h.timers.length).toBe(before + 1);
    expect(h.node.electionStart).toBe(40);
  });

  it('rejects a candidate whose term is older than its own (rule 1)', () => {
    const h = harness();
    h.node.currentTerm = 5;
    h.node.receive(1, rv({ term: 4 }));
    expect(lastReply(h, 'RequestVoteReply')).toMatchObject({ term: 5, voteGranted: false });
    expect(h.node.votedFor).toBeNull();
  });

  it('votes at most once per term', () => {
    const h = harness();
    h.node.receive(1, rv({ term: 2, candidateId: 1 }));
    h.node.receive(2, rv({ term: 2, candidateId: 2 }));
    expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(false);
    expect(h.node.votedFor).toBe(1);
    // ...but repeating the vote for the same candidate is fine (retransmission).
    h.node.receive(1, rv({ term: 2, candidateId: 1 }));
    expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(true);
  });

  it('a higher term clears votedFor, so the server can vote again in the new term', () => {
    const h = harness();
    h.node.receive(1, rv({ term: 2, candidateId: 1 }));
    h.node.receive(2, rv({ term: 3, candidateId: 2 }));
    expect(lastReply(h, 'RequestVoteReply')).toMatchObject({ term: 3, voteGranted: true });
    expect(h.node.votedFor).toBe(2);
  });

  describe('up-to-date check (§5.4.1)', () => {
    const withLog = () => {
      const h = harness();
      h.node.log = logOf(1, 1, 2);
      h.node.currentTerm = 2;
      return h;
    };
    it('rejects a candidate whose last log term is older, even if its log is longer', () => {
      const h = withLog();
      h.node.receive(1, rv({ term: 3, lastLogIndex: 10, lastLogTerm: 1 }));
      expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(false);
      // It still adopted the newer term, and has not voted in it.
      expect(h.node.currentTerm).toBe(3);
      expect(h.node.votedFor).toBeNull();
    });
    it('rejects a candidate with the same last term but a shorter log', () => {
      const h = withLog();
      h.node.receive(1, rv({ term: 3, lastLogIndex: 2, lastLogTerm: 2 }));
      expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(false);
    });
    it('grants a candidate with the same last term and an equal log', () => {
      const h = withLog();
      h.node.receive(1, rv({ term: 3, lastLogIndex: 3, lastLogTerm: 2 }));
      expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(true);
    });
    it('grants a candidate with a newer last term even if its log is shorter', () => {
      const h = withLog();
      h.node.receive(1, rv({ term: 4, lastLogIndex: 1, lastLogTerm: 3 }));
      expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(true);
    });
    it('the skipUpToDateCheck mutation grants it anyway', () => {
      const h = harness(0, 5, { mutations: { skipUpToDateCheck: true } });
      h.node.log = logOf(1, 1, 2);
      h.node.currentTerm = 2;
      h.node.receive(1, rv({ term: 3, lastLogIndex: 1, lastLogTerm: 1 }));
      expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(true);
    });
  });
});

describe('elections', () => {
  it('election timeouts are drawn from [min, max)', () => {
    const h = harness();
    for (let i = 0; i < 200; i++) h.node.receive(1, ae({ term: 1 }));
    const delays = h.timers.filter((t) => t.kind === 'election').map((t) => t.delay);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(150);
    expect(Math.max(...delays)).toBeLessThan(300);
    expect(new Set(delays.map((d) => Math.round(d))).size).toBeGreaterThan(50);
  });

  it('on timeout a follower becomes candidate: new term, votes for itself, asks everyone', () => {
    const h = harness(2, 5);
    h.node.log = logOf(1, 1);
    h.node.currentTerm = 1;
    h.node.timeoutNow();
    expect(h.node.role).toBe('candidate');
    expect(h.node.currentTerm).toBe(2);
    expect(h.node.votedFor).toBe(2);
    const reqs = h.sent.filter((s) => s.msg.type === 'RequestVote');
    expect(reqs.map((s) => s.to).sort()).toEqual([0, 1, 3, 4]);
    expect(reqs[0]!.msg).toMatchObject({ term: 2, candidateId: 2, lastLogIndex: 2, lastLogTerm: 1, preVote: false });
  });

  it('becomes leader with a majority, appends a no-op, and sends AppendEntries at once', () => {
    const h = harness(0, 5);
    h.node.timeoutNow();
    h.node.receive(1, { type: 'RequestVoteReply', term: 1, voteGranted: true, preVote: false });
    expect(h.node.role).toBe('candidate');
    h.node.receive(2, { type: 'RequestVoteReply', term: 1, voteGranted: false, preVote: false });
    expect(h.node.role).toBe('candidate');
    h.node.receive(3, { type: 'RequestVoteReply', term: 1, voteGranted: true, preVote: false });
    expect(h.node.role).toBe('leader');
    expect(h.node.log).toHaveLength(1);
    expect(h.node.log[0]!.cmd.kind).toBe('noop');
    expect(h.sent.filter((s) => s.msg.type === 'AppendEntries')).toHaveLength(4);
    expect(h.timers.at(-1)!.kind).toBe('heartbeat');
  });

  it('ignores votes from an old term', () => {
    const h = harness(0, 3);
    h.node.timeoutNow();
    h.node.timeoutNow();
    h.node.receive(1, { type: 'RequestVoteReply', term: 1, voteGranted: true, preVote: false });
    expect(h.node.role).toBe('candidate');
  });

  it('a candidate that hears from a leader of its term becomes a follower', () => {
    const h = harness(0, 5);
    h.node.timeoutNow();
    h.node.receive(3, ae({ term: 1, leaderId: 3 }));
    expect(h.node.role).toBe('follower');
    expect(h.node.leaderId).toBe(3);
  });

  it('any server steps down when it sees a higher term in a reply', () => {
    const h = leaderOf3();
    h.node.receive(1, ok({ term: 7, success: false }));
    expect(h.node.role).toBe('follower');
    expect(h.node.currentTerm).toBe(7);
    expect(h.node.votedFor).toBeNull();
  });

  it('a leader ignores election timer events', () => {
    const h = leaderOf3();
    const t = h.timers.filter((x) => x.kind === 'election').at(-1)!;
    h.node.onTimer('election', t.gen);
    expect(h.node.role).toBe('leader');
  });
});

describe('AppendEntries receiver', () => {
  it('rejects a request from an older term (rule 1), without resetting its timer', () => {
    const h = harness();
    h.node.currentTerm = 3;
    const timers = h.timers.length;
    h.node.receive(1, ae({ term: 2 }));
    expect(lastReply(h, 'AppendEntriesReply')).toMatchObject({ term: 3, success: false });
    expect(h.timers.length).toBe(timers);
  });

  it('resets the election timer and records the leader on a valid request', () => {
    const h = harness();
    const timers = h.timers.length;
    h.setNow(77);
    h.node.receive(4, ae({ term: 1, leaderId: 4 }));
    expect(h.timers.length).toBe(timers + 1);
    expect(h.node.leaderId).toBe(4);
    expect(h.node.lastLeaderContact).toBe(77);
  });

  it('rejects when its log is too short to contain prevLogIndex (rule 2)', () => {
    const h = harness();
    h.node.log = logOf(1);
    h.node.receive(1, ae({ term: 1, prevLogIndex: 3, prevLogTerm: 1, entries: [entry(1)] }));
    expect(lastReply(h, 'AppendEntriesReply').success).toBe(false);
    expect(h.node.log).toHaveLength(1);
  });

  it('rejects when the entry at prevLogIndex has a different term (rule 2)', () => {
    const h = harness();
    h.node.log = logOf(1, 1);
    h.node.currentTerm = 2;
    h.node.receive(1, ae({ term: 2, prevLogIndex: 2, prevLogTerm: 2, entries: [entry(2)] }));
    expect(lastReply(h, 'AppendEntriesReply').success).toBe(false);
    expect(h.node.log).toHaveLength(2);
  });

  it('deletes a conflicting entry and everything after it, then appends (rules 3 and 4)', () => {
    const h = harness();
    const old = logOf(1, 1, 2, 2, 2);
    h.node.log = [...old];
    h.node.currentTerm = 3;
    const fresh = [entry(3), entry(3)];
    h.node.receive(1, ae({ term: 3, prevLogIndex: 2, prevLogTerm: 1, entries: fresh }));
    expect(lastReply(h, 'AppendEntriesReply')).toMatchObject({ success: true, matchIndex: 4 });
    expect(h.node.log.map((e) => e.uid)).toEqual([old[0]!.uid, old[1]!.uid, fresh[0]!.uid, fresh[1]!.uid]);
  });

  it('keeps entries after the new ones when nothing conflicts (a stale or duplicate request)', () => {
    const h = harness();
    const log = logOf(1, 1, 1, 1);
    h.node.log = [...log];
    h.node.currentTerm = 1;
    h.node.receive(1, ae({ term: 1, prevLogIndex: 1, prevLogTerm: 1, entries: [log[1]!] }));
    expect(h.node.log.map((e) => e.uid)).toEqual(log.map((e) => e.uid));
    expect(lastReply(h, 'AppendEntriesReply').matchIndex).toBe(2);
  });

  it('sets commitIndex = min(leaderCommit, index of last new entry) (rule 5)', () => {
    const h = harness();
    const log = logOf(1, 1, 1, 1, 1);
    h.node.log = [...log];
    h.node.currentTerm = 1;
    // A heartbeat that only vouches for index 2 must not commit the follower's entries 3..5.
    h.node.receive(1, ae({ term: 1, prevLogIndex: 2, prevLogTerm: 1, leaderCommit: 5 }));
    expect(h.node.commitIndex).toBe(2);
    expect(h.node.lastApplied).toBe(2);
    h.node.receive(1, ae({ term: 1, prevLogIndex: 4, prevLogTerm: 1, leaderCommit: 3 }));
    expect(h.node.commitIndex).toBe(3);
    // commitIndex never moves backwards.
    h.node.receive(1, ae({ term: 1, prevLogIndex: 1, prevLogTerm: 1, leaderCommit: 5 }));
    expect(h.node.commitIndex).toBe(3);
  });

  it('the commitIndexNoMin mutation commits entries the leader never vouched for', () => {
    const h = harness(0, 5, { mutations: { commitIndexNoMin: true } });
    h.node.log = logOf(1, 1, 1, 1, 1);
    h.node.currentTerm = 1;
    h.node.receive(1, ae({ term: 1, prevLogIndex: 2, prevLogTerm: 1, leaderCommit: 5 }));
    expect(h.node.commitIndex).toBe(5);
  });

  describe('fast backtracking hints', () => {
    it('reports conflictIndex = log length + 1 when the log is too short', () => {
      const h = harness(0, 5, { fastBackup: true });
      h.node.log = logOf(1, 1);
      h.node.receive(1, ae({ term: 1, prevLogIndex: 6, prevLogTerm: 1 }));
      const r = lastReply(h, 'AppendEntriesReply');
      expect(r.conflictIndex).toBe(3);
      expect(r.conflictTerm).toBeUndefined();
    });
    it('reports the conflicting term and the first index holding it', () => {
      const h = harness(0, 5, { fastBackup: true });
      h.node.log = logOf(1, 2, 2, 2);
      h.node.currentTerm = 3;
      h.node.receive(1, ae({ term: 3, prevLogIndex: 4, prevLogTerm: 3 }));
      expect(lastReply(h, 'AppendEntriesReply')).toMatchObject({ conflictTerm: 2, conflictIndex: 2 });
    });
    it('the leader skips a whole term per round trip', () => {
      const h = leaderOf3({ fastBackup: true, leaderNoop: false }, (x) => {
        x.node.log = logOf(1, 1, 1, 3, 3);
        x.node.currentTerm = 3;
      });
      // Leader is now in term 4, nextIndex[1] = 6.
      expect(h.node.nextIndex[1]).toBe(6);
      h.node.receive(1, ok({ term: 4, success: false, prevLogIndex: 5, conflictTerm: 2, conflictIndex: 2 }));
      // The leader has no term-2 entries, so it jumps straight to the follower's first term-2 index.
      expect(h.node.nextIndex[1]).toBe(2);
      h.node.receive(2, ok({ term: 4, success: false, prevLogIndex: 5, conflictTerm: 1, conflictIndex: 1 }));
      // The leader does have term-1 entries: resume just after its last one.
      expect(h.node.nextIndex[2]).toBe(4);
    });
    it('without hints the leader backs up one entry per rejection', () => {
      const h = leaderOf3({ leaderNoop: false }, (x) => {
        x.node.log = logOf(1, 1, 1);
        x.node.currentTerm = 1;
      });
      h.node.receive(1, ok({ term: 2, success: false, prevLogIndex: 3 }));
      expect(h.node.nextIndex[1]).toBe(3);
      // A duplicate rejection of the same probe is stale and must not back up twice.
      h.node.receive(1, ok({ term: 2, success: false, prevLogIndex: 3 }));
      expect(h.node.nextIndex[1]).toBe(3);
      h.node.receive(1, ok({ term: 2, success: false, prevLogIndex: 2 }));
      expect(h.node.nextIndex[1]).toBe(2);
    });
  });
});

describe('leader commit rule (§5.4.2)', () => {
  const setup = (mutations = {}) =>
    leaderOf3({ leaderNoop: false, mutations }, (x) => {
      x.node.log = logOf(1, 2);
      x.node.currentTerm = 2;
    });

  it('does not commit an old-term entry just because a majority stores it', () => {
    const h = setup();
    expect(h.node.currentTerm).toBe(3);
    h.node.receive(1, ok({ term: 3, success: true, prevLogIndex: 2, matchIndex: 2 }));
    expect(h.node.matchIndex[1]).toBe(2);
    expect(h.node.commitIndex).toBe(0);
  });

  it('commits it indirectly once an entry from the current term reaches a majority', () => {
    const h = setup();
    h.node.receive(clientEndpoint(0), { type: 'ClientRequest', client: 0, seq: 1, op: { kind: 'set', key: 'x', value: '1' } });
    expect(h.node.log.at(-1)!.term).toBe(3);
    h.node.receive(1, ok({ term: 3, success: true, prevLogIndex: 2, matchIndex: 3 }));
    expect(h.node.commitIndex).toBe(3);
    expect(h.node.lastApplied).toBe(3);
    expect(h.node.kv.snapshot()).toEqual({ x: '1' });
    // The leader answers the client once the command is applied.
    expect(lastReply(h, 'ClientReply')).toMatchObject({ ok: true, client: 0, seq: 1, index: 3 });
  });

  it('the commitOldTerms mutation (the Figure 8 bug) commits it immediately', () => {
    const h = setup({ commitOldTerms: true });
    h.node.receive(1, ok({ term: 3, success: true, prevLogIndex: 2, matchIndex: 2 }));
    expect(h.node.commitIndex).toBe(2);
  });

  it('ignores a stale success reply that reports a lower matchIndex', () => {
    const h = setup();
    h.node.receive(1, ok({ term: 3, success: true, prevLogIndex: 2, matchIndex: 2 }));
    h.node.receive(1, ok({ term: 3, success: true, prevLogIndex: 0, matchIndex: 1 }));
    expect(h.node.matchIndex[1]).toBe(2);
  });
});

describe('crash and restart', () => {
  it('keeps persistent state and loses volatile state', () => {
    const h = harness();
    h.node.receive(1, rv({ term: 4, candidateId: 1 }));
    h.node.receive(1, ae({ term: 4, entries: [entry(4, { kind: 'set', key: 'k', value: 'v', client: 0, seq: 1 })], leaderCommit: 1 }));
    expect(h.node.kv.snapshot()).toEqual({ k: 'v' });
    const log = [...h.node.log];
    h.node.crash();
    h.node.restart();
    expect(h.node.currentTerm).toBe(4);
    expect(h.node.votedFor).toBe(1);
    expect(h.node.log).toEqual(log);
    expect(h.node.commitIndex).toBe(0);
    expect(h.node.lastApplied).toBe(0);
    expect(h.node.kv.snapshot()).toEqual({});
    expect(h.node.role).toBe('follower');
  });

  it('a crashed server ignores messages and timers', () => {
    const h = harness();
    h.node.crash();
    h.node.receive(1, rv({ term: 9 }));
    expect(h.node.currentTerm).toBe(0);
    h.node.timeoutNow();
    expect(h.node.role).toBe('follower');
  });

  it('the volatileVotedFor mutation forgets the vote across a crash', () => {
    const h = harness(0, 5, { mutations: { volatileVotedFor: true } });
    h.node.receive(1, rv({ term: 2, candidateId: 1 }));
    h.node.crash();
    h.node.restart();
    h.node.receive(2, rv({ term: 2, candidateId: 2 }));
    expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(true);
  });
});

describe('PreVote (thesis §9.6)', () => {
  it('a pre-candidate does not change its term', () => {
    const h = harness(0, 5, { preVote: true });
    h.node.currentTerm = 3;
    h.node.timeoutNow();
    expect(h.node.role).toBe('precandidate');
    expect(h.node.currentTerm).toBe(3);
    const req = h.sent.find((s) => s.msg.type === 'RequestVote')!.msg as RequestVote;
    expect(req).toMatchObject({ preVote: true, term: 4 });
  });

  it('a pre-vote request changes nothing on the receiver', () => {
    const h = harness();
    h.node.currentTerm = 2;
    h.node.receive(1, rv({ term: 3, preVote: true }));
    expect(lastReply(h, 'RequestVoteReply')).toMatchObject({ voteGranted: true, preVote: true, term: 3 });
    expect(h.node.currentTerm).toBe(2);
    expect(h.node.votedFor).toBeNull();
  });

  it('refuses a pre-vote while it has heard from a leader recently', () => {
    const h = harness();
    h.setNow(100);
    h.node.receive(4, ae({ term: 2, leaderId: 4 }));
    h.setNow(200);
    h.node.receive(1, rv({ term: 3, preVote: true }));
    expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(false);
    h.setNow(260);
    h.node.receive(1, rv({ term: 3, preVote: true }));
    expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(true);
  });

  it('refuses a pre-vote from a candidate whose log is behind', () => {
    const h = harness();
    h.node.log = logOf(1, 2);
    h.node.currentTerm = 2;
    h.node.receive(1, rv({ term: 3, preVote: true, lastLogIndex: 1, lastLogTerm: 1 }));
    expect(lastReply(h, 'RequestVoteReply').voteGranted).toBe(false);
  });

  it('only a majority of pre-votes starts a real election', () => {
    const h = harness(0, 5, { preVote: true });
    h.node.timeoutNow();
    h.node.receive(1, { type: 'RequestVoteReply', term: 1, voteGranted: true, preVote: true });
    expect(h.node.role).toBe('precandidate');
    expect(h.node.currentTerm).toBe(0);
    h.node.receive(2, { type: 'RequestVoteReply', term: 1, voteGranted: true, preVote: true });
    expect(h.node.role).toBe('candidate');
    expect(h.node.currentTerm).toBe(1);
  });
});

describe('clients', () => {
  it('a follower redirects to the leader it knows', () => {
    const h = harness();
    h.node.receive(3, ae({ term: 1, leaderId: 3 }));
    h.node.receive(clientEndpoint(0), { type: 'ClientRequest', client: 0, seq: 1, op: { kind: 'get', key: 'x' } });
    expect(lastReply(h, 'ClientReply')).toMatchObject({ ok: false, leaderHint: 3 });
  });

  it('a leader does not append a retry that is already in its log for this term', () => {
    const h = leaderOf3();
    const req = { type: 'ClientRequest' as const, client: 0, seq: 1, op: { kind: 'set' as const, key: 'x', value: '1' } };
    h.node.receive(clientEndpoint(0), req);
    h.node.receive(clientEndpoint(0), req);
    expect(h.node.log.filter((e) => e.cmd.kind === 'set')).toHaveLength(1);
  });
});
