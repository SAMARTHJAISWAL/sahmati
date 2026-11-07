/**
 * One Raft server, written against Figure 2 of Ongaro & Ousterhout (2014).
 *
 * The node is a pure state machine driven by three inputs: a delivered
 * message, a fired timer, and a few operator actions (crash, restart, "time
 * out now"). It talks to the world only through NodeEnv, which the
 * simulation provides; it never reads a clock or a random source of its own.
 */
import { KvStore, describeCommand } from './kv';
import type { Rng } from './rng';
import {
  clientEndpoint,
  type AppendEntries,
  type AppendEntriesReply,
  type ClientRequest,
  type Endpoint,
  type Entry,
  type Message,
  type NodeId,
  type RaftOptions,
  type RequestVote,
  type RequestVoteReply,
  type Role,
  type TraceKind,
} from './types';

export type TimerKind = 'election' | 'heartbeat';

export interface NodeEnv {
  now(): number;
  readonly rng: Rng;
  send(from: NodeId, to: Endpoint, msg: Message): void;
  setTimer(node: NodeId, kind: TimerKind, gen: number, delay: number): void;
  trace(kind: TraceKind, node: NodeId | null, text: string): void;
  newUid(): number;
}

export class RaftNode {
  // ---- Persistent state on all servers (survives a crash) -----------------
  currentTerm = 0;
  votedFor: NodeId | null = null;
  /** log[i - 1] is the entry at index i; Raft indices start at 1. */
  log: Entry[] = [];

  // ---- Volatile state on all servers --------------------------------------
  commitIndex = 0;
  lastApplied = 0;
  role: Role = 'follower';
  leaderId: NodeId | null = null;
  kv = new KvStore();

  // ---- Volatile state on leaders (reinitialised after election) -----------
  nextIndex: number[];
  matchIndex: number[];

  // ---- Bookkeeping ---------------------------------------------------------
  crashed = false;
  /** Votes (or pre-votes) received in the current election round. */
  votes = new Set<NodeId>();
  electionStart = 0;
  electionDeadline = Infinity;
  private electionGen = 0;
  private heartbeatGen = 0;
  /** Last time a valid AppendEntries from the current leader arrived. */
  lastLeaderContact = -Infinity;
  /** Bumped on every change to `log` (the checkers use it to skip unchanged logs). */
  logVersion = 0;
  /** Bumped on every restart (the checkers reset their per-node apply cursor). */
  incarnation = 0;

  constructor(
    readonly id: NodeId,
    readonly clusterSize: number,
    private readonly opts: RaftOptions,
    private readonly env: NodeEnv,
  ) {
    this.nextIndex = new Array<number>(clusterSize).fill(1);
    this.matchIndex = new Array<number>(clusterSize).fill(0);
  }

  get lastLogIndex(): number {
    return this.log.length;
  }

  termAt(index: number): number {
    if (index <= 0) return 0;
    return this.log[index - 1]?.term ?? -1;
  }

  get lastLogTerm(): number {
    return this.termAt(this.log.length);
  }

  private get mut() {
    return this.opts.mutations;
  }

  private majority(count: number): boolean {
    return count * 2 > this.clusterSize;
  }

  private peers(): NodeId[] {
    const out: NodeId[] = [];
    for (let i = 0; i < this.clusterSize; i++) if (i !== this.id) out.push(i);
    return out;
  }

  private trace(kind: TraceKind, text: string): void {
    this.env.trace(kind, this.id, text);
  }

  // ---- Lifecycle -----------------------------------------------------------

  start(): void {
    this.resetElectionTimer();
  }

  crash(): void {
    if (this.crashed) return;
    this.crashed = true;
    this.electionGen++;
    this.heartbeatGen++;
    this.role = 'follower';
    this.leaderId = null;
    this.votes.clear();
    this.electionDeadline = Infinity;
    if (this.mut.volatileVotedFor) this.votedFor = null;
    this.trace('crash', `S${this.id + 1} crashed (keeps term ${this.currentTerm}, vote, and ${this.log.length} log entries)`);
  }

  restart(): void {
    if (!this.crashed) return;
    this.crashed = false;
    this.incarnation++;
    // Volatile state is lost; persistent state (term, vote, log) survives.
    this.role = 'follower';
    this.leaderId = null;
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.kv = new KvStore();
    this.votes.clear();
    this.lastLeaderContact = -Infinity;
    this.nextIndex.fill(1);
    this.matchIndex.fill(0);
    this.trace('restart', `S${this.id + 1} restarted as follower in term ${this.currentTerm}`);
    this.resetElectionTimer();
  }

  /** Operator action: fire the election timer immediately. */
  timeoutNow(): void {
    if (this.crashed || this.role === 'leader') return;
    this.onElectionTimeout(true);
  }

  // ---- Timers --------------------------------------------------------------

  private resetElectionTimer(): void {
    const { electionTimeoutMin: lo, electionTimeoutMax: hi } = this.opts;
    const timeout = this.env.rng.range(lo, hi);
    const now = this.env.now();
    this.electionStart = now;
    this.electionDeadline = now + timeout;
    this.env.setTimer(this.id, 'election', ++this.electionGen, timeout);
  }

  private stopElectionTimer(): void {
    this.electionGen++;
    this.electionDeadline = Infinity;
  }

  onTimer(kind: TimerKind, gen: number): void {
    if (this.crashed) return;
    if (kind === 'election') {
      if (gen !== this.electionGen || this.role === 'leader') return;
      this.onElectionTimeout(false);
    } else {
      if (gen !== this.heartbeatGen || this.role !== 'leader') return;
      this.broadcastAppend();
      this.env.setTimer(this.id, 'heartbeat', this.heartbeatGen, this.opts.heartbeatInterval);
    }
  }

  private onElectionTimeout(forced: boolean): void {
    this.trace('timeout', `S${this.id + 1} ${forced ? 'was told to time out' : 'election timeout'}`);
    if (this.opts.preVote) this.startPreVote();
    else this.startElection();
  }

  // ---- Elections -----------------------------------------------------------

  private startPreVote(): void {
    this.setRole('precandidate');
    this.leaderId = null;
    this.votes = new Set([this.id]);
    this.resetElectionTimer();
    this.trace('vote', `S${this.id + 1} starts a pre-vote for term ${this.currentTerm + 1} (own term stays ${this.currentTerm})`);
    for (const p of this.peers()) {
      this.env.send(this.id, p, {
        type: 'RequestVote',
        term: this.currentTerm + 1,
        candidateId: this.id,
        lastLogIndex: this.lastLogIndex,
        lastLogTerm: this.lastLogTerm,
        preVote: true,
      });
    }
  }

  private startElection(): void {
    this.setTerm(this.currentTerm + 1);
    this.setRole('candidate');
    this.votedFor = this.id;
    this.leaderId = null;
    this.votes = new Set([this.id]);
    this.resetElectionTimer();
    this.trace('vote', `S${this.id + 1} becomes candidate for term ${this.currentTerm} and votes for itself`);
    for (const p of this.peers()) {
      this.env.send(this.id, p, {
        type: 'RequestVote',
        term: this.currentTerm,
        candidateId: this.id,
        lastLogIndex: this.lastLogIndex,
        lastLogTerm: this.lastLogTerm,
        preVote: false,
      });
    }
  }

  private becomeLeader(): void {
    this.setRole('leader');
    this.leaderId = this.id;
    this.stopElectionTimer();
    for (let i = 0; i < this.clusterSize; i++) {
      this.nextIndex[i] = this.lastLogIndex + 1;
      this.matchIndex[i] = 0;
    }
    if (this.opts.leaderNoop) this.appendLocal({ kind: 'noop' });
    this.broadcastAppend();
    this.env.setTimer(this.id, 'heartbeat', ++this.heartbeatGen, this.opts.heartbeatInterval);
  }

  /** §5.4.1: is a log ending in (lastTerm, lastIndex) at least as up-to-date as ours? */
  private isUpToDate(lastTerm: number, lastIndex: number): boolean {
    const myTerm = this.lastLogTerm;
    return lastTerm > myTerm || (lastTerm === myTerm && lastIndex >= this.lastLogIndex);
  }

  /** "If RPC request or response contains term T > currentTerm: set currentTerm = T, convert to follower." */
  private stepDown(term: number): void {
    const wasLeader = this.role === 'leader';
    if (term > this.currentTerm) {
      this.setTerm(term);
      this.votedFor = null;
    }
    if (this.role !== 'follower') {
      this.setRole('follower');
      if (wasLeader) {
        this.heartbeatGen++;
        this.leaderId = null;
        this.resetElectionTimer();
      }
    }
  }

  private setTerm(term: number): void {
    if (term === this.currentTerm) return;
    this.currentTerm = term;
    this.trace('term', `S${this.id + 1} is now in term ${term}`);
  }

  private setRole(role: Role): void {
    if (role === this.role) return;
    this.role = role;
    this.trace('role', `S${this.id + 1} → ${role} (term ${this.currentTerm})`);
  }

  // ---- Message dispatch ----------------------------------------------------

  receive(from: Endpoint, msg: Message): void {
    if (this.crashed) return;
    switch (msg.type) {
      case 'RequestVote':
        return this.onRequestVote(from, msg);
      case 'RequestVoteReply':
        return this.onRequestVoteReply(from, msg);
      case 'AppendEntries':
        return this.onAppendEntries(from, msg);
      case 'AppendEntriesReply':
        return this.onAppendEntriesReply(from, msg);
      case 'ClientRequest':
        return this.onClientRequest(from, msg);
      case 'ClientReply':
        return;
    }
  }

  private onRequestVote(from: Endpoint, m: RequestVote): void {
    const upToDate = this.mut.skipUpToDateCheck || this.isUpToDate(m.lastLogTerm, m.lastLogIndex);
    if (m.preVote) {
      // A pre-vote changes nothing here: no term update, no votedFor, no timer reset.
      const heardFromLeader =
        this.role === 'leader' ||
        (this.leaderId !== null && this.env.now() - this.lastLeaderContact < this.opts.electionTimeoutMin);
      const termOk =
        m.term > this.currentTerm ||
        (m.term === this.currentTerm && (this.votedFor === null || this.votedFor === m.candidateId));
      const grant = termOk && upToDate && !heardFromLeader;
      this.env.send(this.id, from, {
        type: 'RequestVoteReply',
        term: grant ? m.term : this.currentTerm,
        voteGranted: grant,
        preVote: true,
      });
      return;
    }
    if (m.term > this.currentTerm) this.stepDown(m.term);
    let grant = false;
    if (
      m.term === this.currentTerm &&
      (this.votedFor === null || this.votedFor === m.candidateId || this.mut.ignoreVotedFor) &&
      upToDate
    ) {
      grant = true;
      this.votedFor = m.candidateId;
      this.resetElectionTimer();
      this.trace('vote', `S${this.id + 1} votes for S${m.candidateId + 1} in term ${this.currentTerm}`);
    }
    this.env.send(this.id, from, {
      type: 'RequestVoteReply',
      term: this.currentTerm,
      voteGranted: grant,
      preVote: false,
    });
  }

  private onRequestVoteReply(from: Endpoint, m: RequestVoteReply): void {
    if (m.preVote) {
      if (!m.voteGranted) {
        if (m.term > this.currentTerm) this.stepDown(m.term);
        return;
      }
      if (this.role !== 'precandidate' || m.term !== this.currentTerm + 1) return;
      this.votes.add(from);
      if (this.majority(this.votes.size)) {
        this.trace('vote', `S${this.id + 1} won the pre-vote (${this.votes.size}/${this.clusterSize}); starting a real election`);
        this.startElection();
      }
      return;
    }
    if (m.term > this.currentTerm) {
      this.stepDown(m.term);
      return;
    }
    if (this.role !== 'candidate' || !m.voteGranted) return;
    if (m.term !== this.currentTerm && !this.mut.countStaleVotes) return;
    this.votes.add(from);
    if (this.majority(this.votes.size)) {
      this.trace('vote', `S${this.id + 1} won the election for term ${this.currentTerm} with ${this.votes.size}/${this.clusterSize} votes`);
      this.becomeLeader();
    }
  }

  private onAppendEntries(from: Endpoint, m: AppendEntries): void {
    const reject = (extra: Partial<AppendEntriesReply> = {}): void => {
      this.env.send(this.id, from, {
        type: 'AppendEntriesReply',
        term: this.currentTerm,
        success: false,
        prevLogIndex: m.prevLogIndex,
        matchIndex: 0,
        ...extra,
      });
    };
    // 1. Reply false if term < currentTerm.
    if (m.term < this.currentTerm) return reject();
    if (m.term > this.currentTerm) this.stepDown(m.term);
    // A candidate (or a pre-candidate) that hears from a leader of its term defers to it.
    if (this.role !== 'follower') this.stepDown(m.term);
    if (this.role === 'follower' && this.leaderId !== m.leaderId) this.leaderId = m.leaderId;
    this.lastLeaderContact = this.env.now();
    this.resetElectionTimer();

    // 2. Reply false if log doesn't contain an entry at prevLogIndex whose term matches prevLogTerm.
    if (!this.mut.skipConsistencyCheck) {
      if (m.prevLogIndex > this.lastLogIndex || this.termAt(m.prevLogIndex) !== m.prevLogTerm) {
        if (!this.opts.fastBackup) return reject();
        if (m.prevLogIndex > this.lastLogIndex) return reject({ conflictIndex: this.lastLogIndex + 1 });
        const conflictTerm = this.termAt(m.prevLogIndex);
        let conflictIndex = m.prevLogIndex;
        while (conflictIndex > 1 && this.termAt(conflictIndex - 1) === conflictTerm) conflictIndex--;
        return reject({ conflictIndex, conflictTerm });
      }
    }

    // 3 & 4. Delete conflicting entries and everything after them; append new ones.
    let index = Math.min(m.prevLogIndex, this.lastLogIndex);
    for (const entry of m.entries) {
      index++;
      if (index <= this.lastLogIndex) {
        if (this.termAt(index) === entry.term) continue;
        if (this.mut.overwriteWithoutTruncate) {
          this.log[index - 1] = entry;
          this.logVersion++;
          continue;
        }
        const removed = this.log.length - (index - 1);
        this.trace(
          'truncate',
          `S${this.id + 1} found a conflict at index ${index} (term ${this.termAt(index)} ≠ ${entry.term}); deleted ${removed} entr${removed === 1 ? 'y' : 'ies'} from ${index}`,
        );
        this.log.length = index - 1;
        if (this.commitIndex > this.log.length) {
          // Only possible with injected bugs; keep the data structures in range.
          this.commitIndex = this.log.length;
          this.lastApplied = Math.min(this.lastApplied, this.commitIndex);
        }
      }
      this.log.push(entry);
      this.logVersion++;
    }
    const lastNew = index;
    if (m.entries.length > 0) {
      this.trace('append', `S${this.id + 1} accepted ${m.entries.length} entr${m.entries.length === 1 ? 'y' : 'ies'} up to index ${lastNew}`);
    }

    // 5. If leaderCommit > commitIndex, set commitIndex = min(leaderCommit, index of last new entry).
    if (m.leaderCommit > this.commitIndex) {
      const target = this.mut.commitIndexNoMin
        ? Math.min(m.leaderCommit, this.lastLogIndex)
        : Math.min(m.leaderCommit, lastNew);
      if (target > this.commitIndex) {
        this.commitIndex = target;
        this.trace('commit', `S${this.id + 1} learns commitIndex ${target}`);
      }
    }
    this.applyCommitted();

    this.env.send(this.id, from, {
      type: 'AppendEntriesReply',
      term: this.currentTerm,
      success: true,
      prevLogIndex: m.prevLogIndex,
      matchIndex: lastNew,
    });
  }

  private onAppendEntriesReply(from: Endpoint, m: AppendEntriesReply): void {
    if (m.term > this.currentTerm) {
      this.stepDown(m.term);
      return;
    }
    if (this.role !== 'leader' || m.term !== this.currentTerm) return;
    const f = from;
    if (m.success) {
      if (m.matchIndex > this.matchIndex[f]!) this.matchIndex[f] = m.matchIndex;
      this.nextIndex[f] = Math.max(this.nextIndex[f]!, this.matchIndex[f]! + 1);
      this.advanceCommitIndex();
      if (this.nextIndex[f]! <= this.lastLogIndex) this.sendAppend(f);
      return;
    }
    // Ignore stale rejections: only the reply to the current probe moves nextIndex.
    if (m.prevLogIndex < this.matchIndex[f]! || m.prevLogIndex !== this.nextIndex[f]! - 1) return;
    let next = this.nextIndex[f]! - 1;
    if (this.opts.fastBackup && m.conflictIndex !== undefined) {
      next = m.conflictIndex;
      if (m.conflictTerm !== undefined) {
        for (let i = this.lastLogIndex; i >= 1; i--) {
          if (this.termAt(i) === m.conflictTerm) {
            next = i + 1;
            break;
          }
          if (this.termAt(i) < m.conflictTerm) break;
        }
      }
    }
    next = Math.min(next, this.nextIndex[f]! - 1);
    this.nextIndex[f] = Math.max(1, this.matchIndex[f]! + 1, next);
    this.sendAppend(f);
  }

  // ---- Replication ---------------------------------------------------------

  private appendLocal(cmd: Entry['cmd']): Entry {
    const entry: Entry = { term: this.currentTerm, uid: this.env.newUid(), cmd };
    this.log.push(entry);
    this.logVersion++;
    this.trace('append', `S${this.id + 1} (leader) appends ${describeCommand(cmd)} at index ${this.lastLogIndex}, term ${this.currentTerm}`);
    return entry;
  }

  private sendAppend(to: NodeId): void {
    const prevLogIndex = this.nextIndex[to]! - 1;
    this.env.send(this.id, to, {
      type: 'AppendEntries',
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex,
      prevLogTerm: this.termAt(prevLogIndex),
      entries: this.log.slice(prevLogIndex, prevLogIndex + this.opts.maxBatch),
      leaderCommit: this.commitIndex,
    });
  }

  private broadcastAppend(): void {
    for (const p of this.peers()) this.sendAppend(p);
  }

  /**
   * "If there exists an N such that N > commitIndex, a majority of
   * matchIndex[i] ≥ N, and log[N].term == currentTerm: set commitIndex = N."
   * The term condition is §5.4.2; dropping it is the Figure 8 bug.
   */
  private advanceCommitIndex(): void {
    for (let n = this.lastLogIndex; n > this.commitIndex; n--) {
      const term = this.termAt(n);
      if (term !== this.currentTerm && !this.mut.commitOldTerms) {
        if (term < this.currentTerm) break;
        continue;
      }
      let count = 1;
      for (const p of this.peers()) if (this.matchIndex[p]! >= n) count++;
      if (this.majority(count)) {
        this.commitIndex = n;
        this.trace('commit', `S${this.id + 1} (leader) commits up to index ${n} (replicated on ${count}/${this.clusterSize})`);
        break;
      }
    }
    this.applyCommitted();
  }

  private applyCommitted(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied - 1]!;
      const result = this.kv.apply(entry.cmd);
      this.trace('apply', `S${this.id + 1} applies #${this.lastApplied} ${describeCommand(entry.cmd)}${result.value !== undefined ? ` → ${result.value ?? 'nil'}` : ''}`);
      if (this.role === 'leader' && entry.cmd.kind !== 'noop') {
        const reply: Message = {
          type: 'ClientReply',
          client: entry.cmd.client,
          seq: entry.cmd.seq,
          ok: true,
          leaderHint: this.id,
          index: this.lastApplied,
        };
        if (result.value !== undefined) reply.value = result.value;
        this.env.send(this.id, clientEndpoint(entry.cmd.client), reply);
      }
    }
  }

  // ---- Clients -------------------------------------------------------------

  private onClientRequest(from: Endpoint, m: ClientRequest): void {
    if (this.role !== 'leader') {
      this.env.send(this.id, from, {
        type: 'ClientReply',
        client: m.client,
        seq: m.seq,
        ok: false,
        leaderHint: this.leaderId,
      });
      return;
    }
    const cached = this.kv.cached(m.client, m.seq);
    if (cached) {
      const reply: Message = { type: 'ClientReply', client: m.client, seq: m.seq, ok: true, leaderHint: this.id };
      if (cached.value !== undefined) reply.value = cached.value;
      this.env.send(this.id, from, reply);
      return;
    }
    // A retry of a command that is already in our log (but not yet applied) needs no second copy.
    for (let i = this.lastLogIndex; i > this.lastApplied; i--) {
      const c = this.log[i - 1]!.cmd;
      if (c.kind !== 'noop' && c.client === m.client && c.seq === m.seq) {
        if (this.termAt(i) === this.currentTerm) return;
        break;
      }
    }
    this.appendLocal({ ...m.op, client: m.client, seq: m.seq });
    this.broadcastAppend();
  }
}
