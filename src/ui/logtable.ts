/**
 * Every server's log as a row of cells coloured by term, with the commit
 * index drawn as a bar, entries that differ from the leader's log outlined,
 * and each server's applied key-value state on the right.
 */
import type { Simulation } from '../raft/sim';
import type { Command, Entry } from '../raft/types';
import { termColor, termInk } from './palette';

const MAX_CELLS = 160;
const CELL = 44;
const GAP = 3;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function short(cmd: Command): string {
  switch (cmd.kind) {
    case 'noop':
      return '·';
    case 'set':
      return `${cmd.key}=${cmd.value}`;
    case 'del':
      return `del ${cmd.key}`;
    case 'get':
      return `get ${cmd.key}`;
  }
}

function long(cmd: Command): string {
  switch (cmd.kind) {
    case 'noop':
      return 'no-op (appended by a new leader)';
    case 'set':
      return `set ${cmd.key} = ${cmd.value} (client C${cmd.client + 1}, request #${cmd.seq})`;
    case 'del':
      return `delete ${cmd.key} (client C${cmd.client + 1}, request #${cmd.seq})`;
    case 'get':
      return `read ${cmd.key} (client C${cmd.client + 1}, request #${cmd.seq})`;
  }
}

export class LogTable {
  private labels: HTMLDivElement;
  private scroll: HTMLDivElement;
  private kv: HTMLDivElement;
  private signature = '';
  private seenUids = new Set<number>();
  private stickToEnd = true;

  constructor(root: HTMLElement) {
    root.replaceChildren();
    this.labels = document.createElement('div');
    this.labels.className = 'lt-col';
    this.scroll = document.createElement('div');
    this.scroll.className = 'lt-col lt-scroll';
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute('aria-label', 'Log entries, scrollable');
    this.kv = document.createElement('div');
    this.kv.className = 'lt-col';
    root.append(this.labels, this.scroll, this.kv);
    this.scroll.addEventListener('scroll', () => {
      const s = this.scroll;
      this.stickToEnd = s.scrollLeft + s.clientWidth >= s.scrollWidth - 8;
    });
  }

  reset(): void {
    this.signature = '';
    this.seenUids.clear();
    this.stickToEnd = true;
  }

  render(sim: Simulation): void {
    const leader = sim.leader();
    const sig = JSON.stringify([
      leader?.id ?? -1,
      sim.nodes.map((n) => [n.logVersion, n.log.length, n.commitIndex, n.lastApplied, n.role, n.crashed, n.currentTerm, n.incarnation]),
    ]);
    if (sig === this.signature) return;
    this.signature = sig;

    const maxLen = Math.max(0, ...sim.nodes.map((n) => n.log.length));
    const from = Math.max(1, maxLen - MAX_CELLS + 1);
    const ref: Entry[] | null = leader ? leader.log : null;

    // Left: server labels.
    let lh = '<div class="lt-row head"></div>';
    for (const n of sim.nodes) {
      const role = n.crashed ? 'down' : n.role;
      lh += `<div class="lt-row lt-label ${role}"><span class="dot" aria-hidden="true"></span>S${n.id + 1}<span class="meta">t${n.currentTerm}</span></div>`;
    }
    this.labels.innerHTML = lh;

    // Middle: index header and cells.
    let head = '<div class="lt-row head"><div class="cells">';
    for (let i = from; i <= maxLen; i++) head += `<span class="idx">${i}</span>`;
    head += '</div></div>';
    let rows = '';
    const fresh: number[] = [];
    for (const n of sim.nodes) {
      let cells = '';
      if (n.log.length === 0) cells = '<span class="empty-log">empty</span>';
      for (let i = Math.max(from, 1); i <= n.log.length; i++) {
        const e = n.log[i - 1]!;
        const committed = i <= n.commitIndex;
        const r = ref?.[i - 1];
        const conflict = ref !== null && n !== leader && (r === undefined ? i > ref.length : r.uid !== e.uid);
        const isNew = !this.seenUids.has(e.uid);
        if (isNew) fresh.push(e.uid);
        const cls = `cell ${committed ? 'committed' : 'uncommitted'}${conflict ? ' conflict' : ''}${isNew && this.seenUids.size > 0 ? ' fresh' : ''}`;
        const title = `S${n.id + 1} index ${i}, term ${e.term}: ${long(e.cmd)}. ${committed ? 'Committed' : 'Not committed'}${i <= n.lastApplied ? ', applied' : ''}${conflict ? '. Differs from the leader’s entry at this index' : ''}.`;
        cells += `<span class="${cls}" style="--cell:${termColor(e.term)};--cell-ink:${termInk(e.term)}" title="${esc(title)}"><span class="t">${e.term}</span><span class="c">${esc(short(e.cmd))}</span></span>`;
      }
      const ci = n.commitIndex;
      const line = ci >= from && n.log.length > 0 ? `<span class="commit-line" style="left:${(ci - from + 1) * (CELL + GAP) - GAP / 2}px" title="commit index ${ci}"></span>` : '';
      rows += `<div class="lt-row"><div class="cells" aria-label="S${n.id + 1}: ${n.log.length} entries, commit index ${ci}">${cells}${line}</div></div>`;
    }
    for (const u of fresh) this.seenUids.add(u);
    const prevLeft = this.scroll.scrollLeft;
    this.scroll.innerHTML = head + rows;
    this.scroll.scrollLeft = this.stickToEnd ? this.scroll.scrollWidth : prevLeft;

    // Right: applied key-value state.
    let kv = '<div class="lt-row head kvh">applied state</div>';
    for (const n of sim.nodes) {
      const snap = n.kv.snapshot();
      const keys = Object.keys(snap);
      const body = n.crashed
        ? '<span class="none">down</span>'
        : keys.length === 0
          ? '<span class="none">{ }</span>'
          : keys.map((k) => `<span class="pair">${esc(k)}=${esc(snap[k]!)}</span>`).join('');
      kv += `<div class="lt-row kv" title="S${n.id + 1} applied ${n.lastApplied} entries">${body}</div>`;
    }
    this.kv.innerHTML = kv;
  }
}
