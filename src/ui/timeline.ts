/** The event log under the stage: newest first, filterable by category. */
import type { Simulation } from '../raft/sim';
import type { TraceEvent, TraceKind } from '../raft/types';

export type Category = 'election' | 'replication' | 'client' | 'fault' | 'message';

const CATEGORY: Record<TraceKind, Category> = {
  role: 'election',
  term: 'election',
  vote: 'election',
  timeout: 'election',
  append: 'replication',
  truncate: 'replication',
  commit: 'replication',
  apply: 'replication',
  client: 'client',
  crash: 'fault',
  restart: 'fault',
  partition: 'fault',
  config: 'fault',
  drop: 'fault',
  send: 'message',
  deliver: 'message',
};

const LABELS: [Category, string][] = [
  ['election', 'Elections'],
  ['replication', 'Replication'],
  ['client', 'Client'],
  ['fault', 'Faults'],
  ['message', 'Messages'],
];

const MAX_ROWS = 250;

export class Timeline {
  private enabled = new Set<Category>(['election', 'replication', 'client', 'fault']);
  private lastSeq = 0;
  private count = 0;

  constructor(
    private readonly list: HTMLOListElement,
    chips: HTMLElement,
    private readonly getSim: () => Simulation,
  ) {
    for (const [cat, label] of LABELS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(this.enabled.has(cat)));
      b.addEventListener('click', () => {
        if (this.enabled.has(cat)) this.enabled.delete(cat);
        else this.enabled.add(cat);
        b.setAttribute('aria-pressed', String(this.enabled.has(cat)));
        this.rebuild();
      });
      chips.appendChild(b);
    }
  }

  reset(): void {
    this.lastSeq = 0;
    this.count = 0;
    this.list.replaceChildren();
  }

  private rebuild(): void {
    this.lastSeq = 0;
    this.count = 0;
    this.list.replaceChildren();
    this.render();
  }

  render(): void {
    const trace = this.getSim().trace;
    if (trace.length === 0) return;
    const last = trace[trace.length - 1]!;
    if (last.seq <= this.lastSeq) return;
    // Walk back to the first unseen event.
    let i = trace.length - 1;
    while (i > 0 && trace[i - 1]!.seq > this.lastSeq) i--;
    const frag = document.createDocumentFragment();
    const fresh: TraceEvent[] = [];
    for (let j = Math.max(i, trace.length - MAX_ROWS * 4); j < trace.length; j++) {
      const e = trace[j]!;
      if (this.enabled.has(CATEGORY[e.kind])) fresh.push(e);
    }
    this.lastSeq = last.seq;
    for (let j = fresh.length - 1; j >= Math.max(0, fresh.length - MAX_ROWS); j--) frag.appendChild(this.row(fresh[j]!));
    this.list.prepend(frag);
    this.count += Math.min(fresh.length, MAX_ROWS);
    while (this.count > MAX_ROWS && this.list.lastElementChild) {
      this.list.lastElementChild.remove();
      this.count--;
    }
  }

  private row(e: TraceEvent): HTMLLIElement {
    const li = document.createElement('li');
    const cat = CATEGORY[e.kind];
    li.className = `k-${cat}`;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${e.t.toFixed(1)} ms`;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = e.kind;
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = e.text;
    li.append(when, kind, what);
    return li;
  }
}
