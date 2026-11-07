/** Shared types for the Raft core. Nothing in src/raft touches the DOM. */

export type NodeId = number;
export type ClientId = number;

export type Role = 'follower' | 'precandidate' | 'candidate' | 'leader';

/** State machine commands. `get` goes through the log too, which makes reads linearizable. */
export type Command =
  | { kind: 'noop' }
  | { kind: 'set'; key: string; value: string; client: ClientId; seq: number }
  | { kind: 'del'; key: string; client: ClientId; seq: number }
  | { kind: 'get'; key: string; client: ClientId; seq: number };

export type ClientCommand = Exclude<Command, { kind: 'noop' }>;
export type ClientOp =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'del'; key: string }
  | { kind: 'get'; key: string };

export interface Entry {
  readonly term: number;
  /** Globally unique id assigned when a leader creates the entry. Used by the checkers. */
  readonly uid: number;
  readonly cmd: Command;
}

export interface RequestVote {
  type: 'RequestVote';
  term: number;
  candidateId: NodeId;
  lastLogIndex: number;
  lastLogTerm: number;
  /** PreVote (thesis §9.6): a trial election that changes no state on the receiver. */
  preVote: boolean;
}

export interface RequestVoteReply {
  type: 'RequestVoteReply';
  term: number;
  voteGranted: boolean;
  preVote: boolean;
}

export interface AppendEntries {
  type: 'AppendEntries';
  term: number;
  leaderId: NodeId;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: Entry[];
  leaderCommit: number;
}

export interface AppendEntriesReply {
  type: 'AppendEntriesReply';
  term: number;
  success: boolean;
  /** Echo of the request's prevLogIndex, so stale replies can be recognised. */
  prevLogIndex: number;
  /** On success: index of the last entry known to match the leader. */
  matchIndex: number;
  /** Rejection hints (only filled when the fast-backup optimisation is on). */
  conflictIndex?: number;
  conflictTerm?: number;
}

export interface ClientRequest {
  type: 'ClientRequest';
  client: ClientId;
  seq: number;
  op: ClientOp;
}

export interface ClientReply {
  type: 'ClientReply';
  client: ClientId;
  seq: number;
  ok: boolean;
  /** Set on a redirect: who the server believes is leader (or null if it doesn't know). */
  leaderHint: NodeId | null;
  /** Result of a get (null = key absent). */
  value?: string | null;
  /** Log index at which the command was applied. */
  index?: number;
}

export type RaftMessage = RequestVote | RequestVoteReply | AppendEntries | AppendEntriesReply;
export type Message = RaftMessage | ClientRequest | ClientReply;

/** Endpoints: servers are 0..n-1; clients are encoded as -(clientId+1). */
export type Endpoint = number;
export const clientEndpoint = (c: ClientId): Endpoint => -(c + 1);
export const endpointClient = (e: Endpoint): ClientId => -e - 1;
export const isClientEndpoint = (e: Endpoint): boolean => e < 0;

/**
 * Bugs that can be injected for the mutation tests. Each one is a single,
 * realistic mistake; the fuzzer must catch every one of them.
 */
export interface Mutations {
  /** Commit any entry once replicated on a majority, ignoring its term (the Figure 8 bug). */
  commitOldTerms?: boolean;
  /** Grant votes without the "candidate's log is at least as up-to-date" check (§5.4.1). */
  skipUpToDateCheck?: boolean;
  /** Grant a vote to any candidate in the term, ignoring votedFor. */
  ignoreVotedFor?: boolean;
  /** Keep votedFor in volatile memory, so it is forgotten on a crash. */
  volatileVotedFor?: boolean;
  /** Accept AppendEntries without checking prevLogIndex/prevLogTerm. */
  skipConsistencyCheck?: boolean;
  /** On a conflicting entry, overwrite just that slot instead of deleting it and everything after it. */
  overwriteWithoutTruncate?: boolean;
  /** Follower sets commitIndex = leaderCommit, not min(leaderCommit, index of last new entry). */
  commitIndexNoMin?: boolean;
  /** Count vote replies without checking they are for the current term. */
  countStaleVotes?: boolean;
}

export interface RaftOptions {
  electionTimeoutMin: number;
  electionTimeoutMax: number;
  heartbeatInterval: number;
  preVote: boolean;
  /** AppendEntries rejection optimisation: conflictTerm / conflictIndex hints (§5.3, end). */
  fastBackup: boolean;
  /** Maximum entries per AppendEntries. */
  maxBatch: number;
  /** Append a no-op entry when elected (§8). */
  leaderNoop: boolean;
  mutations: Mutations;
}

export type TraceKind =
  | 'send'
  | 'deliver'
  | 'drop'
  | 'role'
  | 'term'
  | 'vote'
  | 'append'
  | 'truncate'
  | 'commit'
  | 'apply'
  | 'timeout'
  | 'crash'
  | 'restart'
  | 'partition'
  | 'client'
  | 'config';

export interface TraceEvent {
  seq: number;
  t: number;
  kind: TraceKind;
  node: NodeId | null;
  text: string;
}
