import { describe, expect, it } from 'vitest';
import { checkLinearizable } from '../src/raft/linearizability';
import type { HistoryOp } from '../src/raft/sim';
import type { ClientOp } from '../src/raft/types';

let seq = 0;
function op(client: number, o: ClientOp, invoke: number, response: number | null, value?: string | null): HistoryOp {
  const h: HistoryOp = { client, seq: ++seq, op: o, invoke, response };
  if (value !== undefined) h.value = value;
  return h;
}
const set = (key: string, value: string): ClientOp => ({ kind: 'set', key, value });
const get = (key: string): ClientOp => ({ kind: 'get', key });
const del = (key: string): ClientOp => ({ kind: 'del', key });

describe('linearizability checker', () => {
  it('accepts a sequential history', () => {
    expect(checkLinearizable([op(0, set('x', '1'), 0, 1), op(0, get('x'), 2, 3, '1'), op(0, del('x'), 4, 5), op(0, get('x'), 6, 7, null)]).ok).toBe(true);
  });

  it('rejects a stale read after a completed write', () => {
    expect(checkLinearizable([op(0, set('x', '1'), 0, 1), op(1, get('x'), 2, 3, null)]).ok).toBe(false);
  });

  it('accepts either value for a read concurrent with a write', () => {
    for (const v of ['1', null]) {
      expect(checkLinearizable([op(0, set('x', '1'), 0, 10), op(1, get('x'), 2, 3, v)]).ok).toBe(true);
    }
  });

  it('rejects a read that goes back in time (new value, then old value)', () => {
    const h = [op(0, set('x', '1'), 0, 10), op(1, get('x'), 1, 2, '1'), op(1, get('x'), 3, 4, null)];
    expect(checkLinearizable(h).ok).toBe(false);
  });

  it('lets an unacknowledged write take effect, or not', () => {
    const pending = op(0, set('x', 'p'), 0, null);
    expect(checkLinearizable([pending, op(1, get('x'), 5, 6, 'p')]).ok).toBe(true);
    expect(checkLinearizable([pending, op(1, get('x'), 5, 6, null)]).ok).toBe(true);
    // ...but once it has been observed it cannot un-happen.
    expect(checkLinearizable([pending, op(1, get('x'), 5, 6, 'p'), op(1, get('x'), 7, 8, null)]).ok).toBe(false);
  });

  it('rejects a lost acknowledged write', () => {
    const h = [op(0, set('x', '1'), 0, 1), op(0, set('x', '2'), 2, 3), op(1, get('x'), 4, 5, '1')];
    expect(checkLinearizable(h).ok).toBe(false);
  });

  it('checks keys independently', () => {
    const h = [op(0, set('x', '1'), 0, 1), op(1, set('y', '2'), 0, 1), op(2, get('x'), 2, 3, '1'), op(2, get('y'), 4, 5, '2')];
    expect(checkLinearizable(h).ok).toBe(true);
    expect(checkLinearizable([...h, op(2, get('y'), 6, 7, '1')])).toMatchObject({ ok: false, key: 'y' });
  });

  it('handles overlapping writes from several clients', () => {
    const h = [
      op(0, set('x', 'a'), 0, 10),
      op(1, set('x', 'b'), 1, 9),
      op(2, set('x', 'c'), 2, 8),
      op(3, get('x'), 11, 12, 'b'),
      op(3, get('x'), 13, 14, 'b'),
    ];
    expect(checkLinearizable(h).ok).toBe(true);
    expect(checkLinearizable([...h, op(3, get('x'), 15, 16, 'c')]).ok).toBe(false);
  });
});
