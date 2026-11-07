/**
 * Continuous checks of the five safety properties from Figure 3 of the Raft
 * paper. `check` is meant to run after every simulation event; it is
 * incremental, so it only looks at logs and indices that changed.
 */
import type { NodeId } from './types';
import type { Simulation } from './sim';

export type Property =
  | 'Election Safety'
  | 'Leader Append-Only'
  | 'Log Matching'
  | 'Leader Completeness'
  | 'State Machine Safety';

export const PROPERTIES: readonly Property[] = [
  'Election Safety',
  'Leader Append-Only',
  'Log Matching',
  'Leader Completeness',
  'State Machine Safety',
];

export interface Violation {
  property: Property;
  message: string;
  t: number;
  ev: number;
}

interface Seen {
  uid: number;
  parent: number;
}

export class SafetyChecker {
  violation: Violation | null = null;
  checks = 0;

  /** term → the one server that was leader in it. */
  private readonly leaderOfTerm = new Map<number, NodeId>();
  /** Per server: the log (as uids) when last seen as leader, plus the term and log version. */
  private leaderSnap: ({ term: number; version: number; uids: number[] } | null)[] = [];
  /** Per server: the term in which it was last seen as leader (to detect a fresh election). */
  private leaderTermSeen: number[] = [];
  /** (index, term) → the entry uid and its predecessor's uid, over every log ever observed. */
  private readonly seen = new Map<number, Seen>();
  private logVersionSeen: number[] = [];
  private incarnationSeen: number[] = [];
  /** committed[i] = entry committed at index i (+1), and the committing server's term. */
  private readonly committed: ({ uid: number; term: number } | undefined)[] = [];
  private commitCursor: number[] = [];
  /** applied[i] = uid of the entry any server applied at index i. */
  private readonly applied: (number | undefined)[] = [];
  private applyCursor: number[] = [];

  check(sim: Simulation): Violation | null {
    if (this.violation) return this.violation;
    this.checks++;
    const v = this.run(sim);
    if (v) this.violation = { ...v, t: sim.now, ev: sim.eventsProcessed };
    return this.violation;
  }

  private run(sim: Simulation): Omit<Violation, 't' | 'ev'> | null {
    const nodes = sim.nodes;
    for (const n of nodes) {
      const id = n.id;
      if (this.incarnationSeen[id] !== n.incarnation) {
        this.incarnationSeen[id] = n.incarnation;
        this.commitCursor[id] = 0;
        this.applyCursor[id] = 0;
        this.leaderSnap[id] = null;
      }

      // Election Safety: at most one leader can be elected in a given term.
      if (n.role === 'leader' && !n.crashed) {
        const prev = this.leaderOfTerm.get(n.currentTerm);
        if (prev !== undefined && prev !== id) {
          return {
            property: 'Election Safety',
            message: `S${prev + 1} and S${id + 1} were both leader in term ${n.currentTerm}`,
          };
        }
        this.leaderOfTerm.set(n.currentTerm, id);
      }

      // Log Matching: an (index, term) pair always names the same entry with the same predecessor.
      if (this.logVersionSeen[id] !== n.logVersion) {
        this.logVersionSeen[id] = n.logVersion;
        const log = n.log;
        for (let i = 0; i < log.length; i++) {
          const e = log[i]!;
          const parent = i > 0 ? log[i - 1]!.uid : 0;
          const key = (i + 1) * 1_000_003 + e.term;
          const s = this.seen.get(key);
          if (!s) this.seen.set(key, { uid: e.uid, parent });
          else if (s.uid !== e.uid || s.parent !== parent) {
            return {
              property: 'Log Matching',
              message: `S${id + 1} has a different entry or history at index ${i + 1}, term ${e.term} than another log`,
            };
          }
        }
      }

      // Leader Append-Only: a leader never overwrites or deletes entries in its log.
      if (n.role === 'leader' && !n.crashed) {
        const snap = this.leaderSnap[id];
        if (snap && snap.term === n.currentTerm && snap.version !== n.logVersion) {
          for (let i = 0; i < snap.uids.length; i++) {
            if (n.log[i]?.uid !== snap.uids[i]) {
              return {
                property: 'Leader Append-Only',
                message: `leader S${id + 1} (term ${n.currentTerm}) changed or removed its own entry at index ${i + 1}`,
              };
            }
          }
        }
        if (!snap || snap.term !== n.currentTerm || snap.version !== n.logVersion) {
          this.leaderSnap[id] = { term: n.currentTerm, version: n.logVersion, uids: n.log.map((e) => e.uid) };
        }
      } else {
        this.leaderSnap[id] = null;
      }

      // Record newly committed entries. Two servers committing different entries at one index
      // means two different entries will be applied there: a State Machine Safety failure.
      let cc = Math.min(this.commitCursor[id] ?? 0, n.commitIndex);
      while (cc < n.commitIndex) {
        cc++;
        const uid = n.log[cc - 1]?.uid ?? -1;
        const prev = this.committed[cc];
        if (!prev) this.committed[cc] = { uid, term: n.currentTerm };
        else if (prev.uid !== uid) {
          return {
            property: 'State Machine Safety',
            message: `S${id + 1} committed a different entry at index ${cc} than was committed earlier`,
          };
        }
      }
      this.commitCursor[id] = cc;

      // Leader Completeness: a new leader's log holds every entry committed in earlier terms.
      if (n.role === 'leader' && !n.crashed && this.leaderTermSeen[id] !== n.currentTerm) {
        this.leaderTermSeen[id] = n.currentTerm;
        for (let i = 1; i < this.committed.length; i++) {
          const c = this.committed[i];
          if (!c || c.term >= n.currentTerm) continue;
          if (n.log[i - 1]?.uid !== c.uid) {
            return {
              property: 'Leader Completeness',
              message: `S${id + 1} became leader of term ${n.currentTerm} without the entry committed at index ${i} in term ${c.term}`,
            };
          }
        }
      }

      // State Machine Safety: no two servers apply different entries at the same index.
      let ac = Math.min(this.applyCursor[id] ?? 0, n.lastApplied);
      while (ac < n.lastApplied) {
        ac++;
        const uid = n.log[ac - 1]?.uid ?? -1;
        const prev = this.applied[ac];
        if (prev === undefined) this.applied[ac] = uid;
        else if (prev !== uid) {
          return {
            property: 'State Machine Safety',
            message: `S${id + 1} applied a different entry at index ${ac} than another server did`,
          };
        }
      }
      this.applyCursor[id] = ac;
    }
    return null;
  }
}
