/**
 * The cluster view: servers on a ring (or in partition zones), the client,
 * and every message in flight. Pure rendering from simulation state; input
 * is reported back through callbacks.
 */
import type { Flight, Simulation } from '../raft/sim';
import { isClientEndpoint, type Endpoint, type Message, type NodeId } from '../raft/types';

const NS = 'http://www.w3.org/2000/svg';
const H = 560;
const CY = 238;
const CLIENT_Y = 506;
const NODE_R = 32;

interface Point {
  x: number;
  y: number;
}

export interface StageCallbacks {
  onNodeActivate(id: NodeId): void;
  onNodeDrop(id: NodeId, at: Point): void;
  onDragStart(): void;
}

interface NodeEls {
  g: SVGGElement;
  timer: SVGCircleElement;
  track: SVGCircleElement;
  circle: SVGCircleElement;
  diamond: SVGPathElement;
  hexagon: SVGPathElement;
  name: SVGTextElement;
  term: SVGTextElement;
  tag: SVGTextElement;
  cross: SVGGElement;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function polygon(sides: number, r: number, rotation: number): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * 2 * Math.PI) / sides;
    pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

export class Stage {
  private readonly zones: SVGGElement;
  private readonly edges: SVGGElement;
  private readonly msgs: SVGGElement;
  private readonly nodesLayer: SVGGElement;
  private readonly clientLayer: SVGGElement;
  private nodes: NodeEls[] = [];
  private pos: Point[] = [];
  private target: Point[] = [];
  private msgEls = new Map<number, SVGGElement>();
  private clientSub: SVGTextElement | null = null;
  private layoutKey = '';
  private drag: { id: NodeId; pointer: number; start: Point; moved: boolean } | null = null;
  selected: NodeId | null = null;
  /** Width of the drawing in SVG units: 800 on wide screens, 480 on phones (portrait). */
  private w = 800;
  private get cx(): number {
    return this.w / 2;
  }

  /** Switch between the wide and the narrow (phone) drawing. Returns true if it changed. */
  setNarrow(narrow: boolean): boolean {
    const w = narrow ? 480 : 800;
    if (w === this.w) return false;
    this.w = w;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${H}`);
    this.svg.classList.toggle('narrow', narrow);
    return true;
  }

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly cb: StageCallbacks,
  ) {
    this.zones = el('g', { class: 'zones' }, svg);
    this.edges = el('g', { class: 'edges' }, svg);
    this.clientLayer = el('g', { class: 'client' }, svg);
    this.msgs = el('g', { class: 'msgs', 'aria-hidden': 'true' }, svg);
    this.nodesLayer = el('g', { class: 'nodes' }, svg);
    svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    svg.addEventListener('pointercancel', () => this.cancelDrag());
  }

  /** (Re)build the scene for a cluster of n servers. */
  reset(n: number): void {
    this.nodesLayer.replaceChildren();
    this.msgs.replaceChildren();
    this.clientLayer.replaceChildren();
    this.msgEls.clear();
    this.nodes = [];
    this.layoutKey = '';
    const ring = this.ringLayout(n);
    this.pos = ring.map((p) => ({ ...p }));
    this.target = ring.map((p) => ({ ...p }));
    for (let i = 0; i < n; i++) this.nodes.push(this.makeNode(i));
    const cg = el('g', { transform: `translate(${this.cx},${CLIENT_Y})` }, this.clientLayer);
    el('rect', { class: 'client-body', x: -34, y: -18, width: 68, height: 36, rx: 18 }, cg);
    const lab = el('text', { class: 'client-label', y: 0 }, cg);
    lab.textContent = 'C1';
    this.clientSub = el('text', { class: 'client-sub', y: 34 }, cg);
    this.clientSub.textContent = 'client';
  }

  private makeNode(id: NodeId): NodeEls {
    const g = el('g', { class: 'node follower', tabindex: 0, role: 'button', 'data-node': id }, this.nodesLayer);
    el('circle', { class: 'halo', r: 54 }, g);
    const track = el('circle', { class: 'timer-track', r: 43 }, g);
    const timer = el('circle', { class: 'timer', r: 43, pathLength: 100, transform: 'rotate(-90)' }, g);
    const circle = el('circle', { class: 'body', r: NODE_R }, g);
    const diamond = el('path', { class: 'body', d: polygon(4, NODE_R + 5, -Math.PI / 2) }, g);
    const hexagon = el('path', { class: 'body', d: polygon(6, NODE_R + 3, -Math.PI / 2) }, g);
    const name = el('text', { class: 'name', y: -5 }, g);
    name.textContent = `S${id + 1}`;
    const term = el('text', { class: 'term', y: 16 }, g);
    const tag = el('text', { class: 'role-tag', y: 64 }, g);
    const cross = el('g', { class: 'crash-x' }, g);
    el('path', { d: 'M-12,-12 L12,12 M12,-12 L-12,12', transform: 'translate(0,-34) scale(0.45)' }, cross);

    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.svg.setPointerCapture?.(e.pointerId);
      this.drag = { id, pointer: e.pointerId, start: this.toSvg(e), moved: false };
    });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.cb.onNodeActivate(id);
      }
    });
    return { g, timer, track, circle, diamond, hexagon, name, term, tag, cross };
  }

  private toSvg(e: PointerEvent): Point {
    const m = this.svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    const p = this.toSvg(e);
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) > 8) {
      d.moved = true;
      this.nodes[d.id]!.g.classList.add('dragging');
      this.cb.onDragStart();
    }
    if (d.moved) {
      const q = { x: Math.min(this.w - 40, Math.max(40, p.x)), y: Math.min(H - 40, Math.max(40, p.y)) };
      this.pos[d.id] = q;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null;
    this.nodes[d.id]?.g.classList.remove('dragging');
    if (d.moved) this.cb.onNodeDrop(d.id, this.toSvg(e));
    else this.cb.onNodeActivate(d.id);
  }

  private cancelDrag(): void {
    if (this.drag) this.nodes[this.drag.id]?.g.classList.remove('dragging');
    this.drag = null;
  }

  isDragging(): boolean {
    return !!this.drag?.moved;
  }

  /** Where a server currently is, in screen pixels relative to the given element. */
  anchorOf(id: NodeId, relativeTo: Element): Point {
    const m = this.svg.getScreenCTM();
    const r = relativeTo.getBoundingClientRect();
    const p = this.pos[id] ?? { x: this.cx, y: CY };
    if (!m) return { x: 0, y: 0 };
    const s = new DOMPoint(p.x, p.y).matrixTransform(m);
    return { x: s.x - r.left, y: s.y - r.top };
  }

  /** The displayed positions (the drag logic needs them). */
  positions(): readonly Point[] {
    return this.pos;
  }

  private ringLayout(n: number): Point[] {
    const R = n <= 3 ? 150 : n <= 5 ? 172 : 186;
    return Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return { x: this.cx + R * Math.cos(a), y: CY + R * Math.sin(a) };
    });
  }

  private partitionLayout(groupOf: number[]): { points: Point[]; walls: number[]; zones: { x: number; w: number }[] } {
    const groups = new Map<number, number[]>();
    groupOf.forEach((g, i) => {
      const list = groups.get(g) ?? [];
      list.push(i);
      groups.set(g, list);
    });
    const ordered = [...groups.values()].sort((a, b) => a[0]! - b[0]!);
    const k = ordered.length;
    const points: Point[] = new Array(groupOf.length);
    const zoneW = this.w / k;
    const walls: number[] = [];
    const zones: { x: number; w: number }[] = [];
    ordered.forEach((members, gi) => {
      const zx = gi * zoneW;
      zones.push({ x: zx, w: zoneW });
      if (gi > 0) walls.push(zx);
      const cx = zx + zoneW / 2;
      const r = members.length === 1 ? 0 : Math.min(zoneW * 0.3, members.length <= 2 ? 78 : 112);
      members.forEach((id, j) => {
        const a = (members.length === 2 ? 0 : -Math.PI / 2) + (j * 2 * Math.PI) / members.length;
        points[id] = members.length === 2 ? { x: cx, y: CY - 92 + j * 184 } : { x: cx + r * Math.cos(a), y: CY + r * Math.sin(a) };
      });
    });
    return { points, walls, zones };
  }

  private updateLayout(sim: Simulation): void {
    const key = sim.groupOf ? sim.groupOf.join(',') : 'ring';
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.zones.replaceChildren();
    this.edges.replaceChildren();
    const n = sim.nodes.length;
    if (!sim.groupOf || new Set(sim.groupOf).size <= 1) {
      this.target = this.ringLayout(n);
      el('circle', { class: 'guide', cx: this.cx, cy: CY, r: n <= 3 ? 150 : n <= 5 ? 172 : 186 }, this.zones);
      return;
    }
    const { points, walls, zones } = this.partitionLayout(sim.groupOf);
    this.target = points;
    for (const z of zones) el('rect', { class: 'zone', x: z.x + 10, y: 14, width: z.w - 20, height: 446, rx: 22 }, this.zones);
    for (const x of walls) {
      el('line', { class: 'wall', x1: x, y1: 26, x2: x, y2: 452 }, this.zones);
      const t = el('text', { class: 'wall-label', x: x, y: 18, 'text-anchor': 'middle' }, this.zones);
      t.textContent = 'partition';
    }
  }

  render(sim: Simulation, opts: { dtMs: number; reducedMotion: boolean }): void {
    this.updateLayout(sim);
    const k = opts.reducedMotion ? 1 : 1 - Math.exp(-opts.dtMs / 110);
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.drag?.moved && this.drag.id === i) continue;
      const p = this.pos[i]!;
      const t = this.target[i]!;
      p.x += (t.x - p.x) * k;
      p.y += (t.y - p.y) * k;
      if (Math.abs(t.x - p.x) < 0.05) p.x = t.x;
      if (Math.abs(t.y - p.y) < 0.05) p.y = t.y;
    }
    this.renderNodes(sim, opts.reducedMotion);
    this.renderMessages(sim, opts.reducedMotion);
    this.renderClient(sim);
  }

  private renderNodes(sim: Simulation, reduced: boolean): void {
    const n = sim.nodes.length;
    sim.nodes.forEach((node, i) => {
      const e = this.nodes[i]!;
      const p = this.pos[i]!;
      e.g.setAttribute('transform', `translate(${p.x.toFixed(2)},${p.y.toFixed(2)})`);
      const role = node.crashed ? 'down' : node.role;
      const cls = `node ${role}${this.selected === i ? ' selected' : ''}${this.drag?.moved && this.drag.id === i ? ' dragging' : ''}`;
      if (e.g.getAttribute('class') !== cls) e.g.setAttribute('class', cls);
      const shape = node.crashed || node.role === 'follower' ? 'circle' : node.role === 'leader' ? 'hexagon' : 'diamond';
      e.circle.style.display = shape === 'circle' ? '' : 'none';
      e.diamond.style.display = shape === 'diamond' ? '' : 'none';
      e.hexagon.style.display = shape === 'hexagon' ? '' : 'none';
      e.cross.style.display = node.crashed ? '' : 'none';
      e.term.textContent = `term ${node.currentTerm}`;
      let tag: string;
      if (node.crashed) tag = 'down';
      else if (node.role === 'leader') tag = 'leader';
      else if (node.role === 'candidate') tag = `candidate ${node.votes.size}/${n}`;
      else if (node.role === 'precandidate') tag = `pre-vote ${node.votes.size}/${n}`;
      else tag = node.votedFor !== null && node.leaderId === null ? `follower · voted S${node.votedFor + 1}` : 'follower';
      if (e.tag.textContent !== tag) e.tag.textContent = tag;
      // Election timer: the fraction of the timeout still to run.
      let frac = 0;
      if (!node.crashed && node.role !== 'leader' && Number.isFinite(node.electionDeadline)) {
        const span = node.electionDeadline - node.electionStart;
        frac = span > 0 ? Math.min(1, Math.max(0, (node.electionDeadline - sim.now) / span)) : 0;
        if (reduced) frac = Math.ceil(frac * 10) / 10;
      }
      e.timer.setAttribute('stroke-dasharray', `${(frac * 100).toFixed(2)} 100`);
      e.timer.style.display = node.role === 'leader' || node.crashed ? 'none' : '';
      const label = `S${i + 1}, ${node.crashed ? 'crashed' : node.role}, term ${node.currentTerm}, log length ${node.lastLogIndex}, commit index ${node.commitIndex}`;
      if (e.g.getAttribute('aria-label') !== label) e.g.setAttribute('aria-label', label);
    });
  }

  private endpointPos(e: Endpoint): Point {
    return isClientEndpoint(e) ? { x: this.cx, y: CLIENT_Y - 18 } : this.pos[e]!;
  }

  private renderMessages(sim: Simulation, reduced: boolean): void {
    const seen = new Set<number>();
    const now = sim.now;
    const fade = Math.max(30, sim.config.latency * 1.5);
    const draw = (f: Flight, finished: boolean) => {
      let opacity = 1;
      let p: number;
      const span = Math.max(1e-6, f.arriveAt - f.sentAt);
      if (finished) {
        if (f.outcome === 'delivered') return;
        const age = now - f.endAt;
        if (age > fade) return;
        opacity = 1 - age / fade;
        p = (f.endAt - f.sentAt) / span;
      } else {
        p = Math.min((now - f.sentAt) / span, (f.endAt - f.sentAt) / span);
      }
      if (reduced) p = finished ? Math.min(p, 0.5) : 0.5;
      p = Math.max(0, Math.min(1, p));
      const a = this.endpointPos(f.from);
      const b = this.endpointPos(f.to);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // Trim the path to the node rims and shift each direction into its own lane.
      const rimA = isClientEndpoint(f.from) ? 6 : NODE_R + 8;
      const rimB = isClientEndpoint(f.to) ? 6 : NODE_R + 8;
      const ux = dx / len;
      const uy = dy / len;
      const lane = 5.5;
      const sx = a.x + ux * rimA - uy * lane;
      const sy = a.y + uy * rimA + ux * lane;
      const travel = Math.max(0, len - rimA - rimB);
      const x = sx + ux * travel * p;
      const y = sy + uy * travel * p;
      let g = this.msgEls.get(f.id);
      if (!g) {
        g = this.makeMessage(f.msg, Math.atan2(dy, dx));
        this.msgs.appendChild(g);
        this.msgEls.set(f.id, g);
      }
      seen.add(f.id);
      const lost = finished && f.outcome !== 'delivered';
      g.classList.toggle('is-lost', lost);
      const shape = g.firstElementChild as SVGGElement;
      const cross = g.lastElementChild as SVGGElement;
      shape.style.display = lost ? 'none' : '';
      cross.style.display = lost ? '' : 'none';
      const glyph = g.querySelector('.m-glyph') as SVGTextElement | null;
      if (glyph) glyph.style.display = lost ? 'none' : '';
      const trail = g.querySelector('.msg-trail') as SVGLineElement | null;
      if (trail) {
        const back = Math.min(travel * p, 26);
        trail.setAttribute('x1', String(-back));
        trail.style.display = lost || back < 2 ? 'none' : '';
      }
      g.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)})`);
      shape.setAttribute('transform', `rotate(${((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(1)})`);
      g.style.opacity = opacity < 1 ? opacity.toFixed(3) : '';
    };
    for (const f of sim.inFlight.values()) draw(f, false);
    for (const f of sim.recent) draw(f, true);
    for (const [id, g] of this.msgEls) {
      if (!seen.has(id)) {
        g.remove();
        this.msgEls.delete(id);
      }
    }
  }

  private makeMessage(m: Message, _angle: number): SVGGElement {
    const g = el('g', { class: 'msg' });
    const shape = el('g', {}, g);
    let cls: string;
    switch (m.type) {
      case 'RequestVote':
        cls = 'm-vote';
        el('line', { class: 'msg-trail', x1: -24, y1: 0, x2: -10, y2: 0, stroke: 'var(--vote)' }, shape);
        el('path', { class: `${cls}${m.preVote ? ' hollow dashed' : ''}`, d: 'M10,0 L0,8.5 L-10,0 L0,-8.5Z' }, shape);
        break;
      case 'RequestVoteReply':
        cls = 'm-vote';
        el('line', { class: 'msg-trail', x1: -24, y1: 0, x2: -7, y2: 0, stroke: 'var(--vote)' }, shape);
        el('circle', { class: `${cls}${m.voteGranted ? '' : ' hollow'}${m.preVote ? ' dashed' : ''}`, r: 6.5 }, shape);
        break;
      case 'AppendEntries': {
        cls = 'm-append';
        const hb = m.entries.length === 0;
        el('line', { class: 'msg-trail', x1: -24, y1: 0, x2: -8, y2: 0, stroke: 'var(--append)' }, shape);
        if (hb) el('rect', { class: `${cls} hollow`, x: -7.5, y: -5.5, width: 15, height: 11, rx: 3 }, shape);
        else {
          el('rect', { class: cls, x: -10.5, y: -7.5, width: 21, height: 15, rx: 3.5 }, shape);
          const t = el('text', { class: 'm-glyph' }, g);
          t.textContent = String(m.entries.length);
        }
        break;
      }
      case 'AppendEntriesReply':
        cls = 'm-append';
        el('line', { class: 'msg-trail', x1: -24, y1: 0, x2: -7, y2: 0, stroke: 'var(--append)' }, shape);
        el('circle', { class: `${cls}${m.success ? '' : ' hollow'}`, r: 6.5 }, shape);
        break;
      case 'ClientRequest':
        cls = 'm-client';
        el('line', { class: 'msg-trail', x1: -24, y1: 0, x2: -10, y2: 0, stroke: 'var(--client)' }, shape);
        el('rect', { class: cls, x: -10.5, y: -7, width: 21, height: 14, rx: 7 }, shape);
        break;
      case 'ClientReply':
        cls = 'm-client';
        el('line', { class: 'msg-trail', x1: -24, y1: 0, x2: -7, y2: 0, stroke: 'var(--client)' }, shape);
        el('circle', { class: `${cls}${m.ok ? '' : ' hollow'}`, r: 6.5 }, shape);
        break;
    }
    const cross = el('g', {}, g);
    el('path', { class: 'm-x', d: 'M-6,-6 L6,6 M6,-6 L-6,6' }, cross);
    cross.style.display = 'none';
    return g;
  }

  private renderClient(sim: Simulation): void {
    const c = sim.clients[0];
    if (!c || !this.clientSub) return;
    const text = c.pending ? `waiting on #${c.pending.seq}` : c.queue.length ? `${c.queue.length} queued` : 'client';
    if (this.clientSub.textContent !== text) this.clientSub.textContent = text;
  }

  /** Which partition group a drop point belongs to: a server's group if close to one, else a new group. */
  dropTarget(id: NodeId, at: Point, groupOf: number[] | null): { join: NodeId } | { alone: true } | null {
    let best: NodeId | null = null;
    let bestD = Infinity;
    this.target.forEach((p, i) => {
      if (i === id) return;
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best !== null && bestD < 120) {
      const same = groupOf ? groupOf[best] === groupOf[id] : true;
      return same && groupOf ? null : { join: best };
    }
    const home = this.target[id]!;
    if (Math.hypot(home.x - at.x, home.y - at.y) > 90) return { alone: true };
    return null;
  }
}
