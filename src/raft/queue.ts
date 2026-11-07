/**
 * A binary min-heap keyed by (time, seq). `seq` is a global insertion counter,
 * so two events scheduled for the same instant always fire in the order they
 * were scheduled: ties never depend on heap internals.
 */
export interface Scheduled<T> {
  time: number;
  seq: number;
  item: T;
}

export class EventQueue<T> {
  private heap: Scheduled<T>[] = [];
  private counter = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, item: T): Scheduled<T> {
    const node: Scheduled<T> = { time, seq: this.counter++, item };
    const h = this.heap;
    h.push(node);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
    return node;
  }

  peek(): Scheduled<T> | undefined {
    return this.heap[0];
  }

  pop(): Scheduled<T> | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && less(h[l]!, h[m]!)) m = l;
        if (r < h.length && less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

function less<T>(a: Scheduled<T>, b: Scheduled<T>): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}
