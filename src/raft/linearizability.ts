/**
 * A Wing & Gong style linearizability checker for the key-value store, with
 * memoisation of (linearized set, register value) as in Lowe's refinement.
 *
 * Linearizability is a local property (Herlihy & Wing 1990): a history is
 * linearizable iff its restriction to each key is. So each key is checked as
 * an independent register with set / del / get.
 *
 * Operations that never got a reply are treated as possibly-taken-effect: a
 * pending write may be placed anywhere after its invocation or left out
 * entirely; a pending read constrains nothing and is ignored.
 */
import type { HistoryOp } from './sim';

export interface LinResult {
  ok: boolean;
  key?: string;
  ops?: number;
  /** Search states explored (for reporting). */
  states: number;
  /**
   * The search hit its state budget without finding a linearization. Correct
   * histories are found quickly by the depth-first search, so this is reported
   * as a failure; it has never happened on a correct run.
   */
  exhausted?: boolean;
}

interface Op {
  invoke: number;
  response: number;
  kind: 'set' | 'del' | 'get';
  value: string | null;
  pending: boolean;
}

export function checkLinearizable(history: readonly HistoryOp[], maxStates = 100_000): LinResult {
  const byKey = new Map<string, Op[]>();
  for (const h of history) {
    const pending = h.response === null;
    if (pending && h.op.kind === 'get') continue;
    const op: Op = {
      invoke: h.invoke,
      response: h.response ?? Infinity,
      kind: h.op.kind,
      value: h.op.kind === 'set' ? h.op.value : h.op.kind === 'get' ? (h.value ?? null) : null,
      pending,
    };
    const list = byKey.get(h.op.key) ?? [];
    list.push(op);
    byKey.set(h.op.key, list);
  }
  let states = 0;
  for (const [key, ops] of [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const r = checkRegister(ops, maxStates);
    states += r.states;
    if (!r.ok) return { ok: false, key, ops: ops.length, states, ...(r.exhausted ? { exhausted: true } : {}) };
  }
  return { ok: true, states };
}

class BudgetExceeded extends Error {}

function checkRegister(ops: Op[], maxStates: number): { ok: boolean; states: number; exhausted?: boolean } {
  ops.sort((a, b) => a.invoke - b.invoke);
  const n = ops.length;
  const required = ops.filter((o) => !o.pending).length;
  const memo = new Set<string>();
  let states = 0;
  const done = new Uint8Array(n);

  const dfs = (value: string | null, doneRequired: number): boolean => {
    if (doneRequired === required) return true;
    const key = `${done.join('')}|${value ?? '\u0000'}`;
    if (memo.has(key)) return false;
    memo.add(key);
    if (++states > maxStates) throw new BudgetExceeded();
    // An op may be linearized next only if no other remaining op finished before it started.
    let minResponse = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && ops[i]!.response < minResponse) minResponse = ops[i]!.response;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      const o = ops[i]!;
      if (o.invoke > minResponse) break;
      let next = value;
      if (o.kind === 'set') next = o.value;
      else if (o.kind === 'del') next = null;
      else if (o.value !== value) continue;
      done[i] = 1;
      const ok = dfs(next, doneRequired + (o.pending ? 0 : 1));
      done[i] = 0;
      if (ok) return true;
    }
    return false;
  };

  try {
    return { ok: dfs(null, 0), states };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { ok: false, states, exhausted: true };
    throw e;
  }
}
