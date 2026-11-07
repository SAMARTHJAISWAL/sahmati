/**
 * The application controller: owns the simulation, drives it from
 * requestAnimationFrame, wires the controls, and runs guided scenarios.
 */
import { SafetyChecker } from '../raft/invariants';
import { Simulation, describeOp, type Action, type SimConfig } from '../raft/sim';
import type { ClientOp, NodeId } from '../raft/types';
import { SCENARIOS, finishStep, startStep, type Scenario, type ScenarioContext } from '../scenarios';
import { captureRun, decodeRun, encodeRun, replayRun } from '../share';
import { LogTable } from './logtable';
import { Stage } from './stage';
import { Timeline } from './timeline';

/** Simulated milliseconds per real millisecond at 1× speed: a 20 ms message takes 0.2 s to cross. */
const BASE_RATE = 0.1;
const UI_TRACE: Partial<SimConfig> = { trace: true, traceLimit: 4000 };

interface ScenarioRun {
  def: Scenario;
  index: number;
  ctx: ScenarioContext;
  running: boolean;
  deadline: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};

export class App {
  sim!: Simulation;
  checker!: SafetyChecker;
  playing = true;
  speed = 1;
  scenario: ScenarioRun | null = null;
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private stage: Stage;
  private logTable: LogTable;
  private timeline: Timeline;
  private raf = 0;
  private lastFrame = 0;
  private menuFor: NodeId | null = null;
  private toastTimer = 0;
  private cmdCounter = 1;
  frames = 0;

  constructor() {
    this.stage = new Stage($('stage') as unknown as SVGSVGElement, {
      onNodeActivate: (id) => this.openMenu(id),
      onNodeDrop: (id, at) => this.onNodeDrop(id, at),
      onDragStart: () => {
        this.closeMenu();
        $('drag-hint').hidden = false;
      },
    });
    this.logTable = new LogTable($('logtable'));
    this.timeline = new Timeline($<HTMLOListElement>('events'), $('tl-filters'), () => this.sim);
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.reducedMotion = e.matches;
    });
    const fit = () => {
      if (this.stage.setNarrow($('stage-panel').clientWidth < 640) && this.sim) this.stage.reset(this.sim.nodes.length);
    };
    fit();
    new ResizeObserver(fit).observe($('stage-panel'));
    this.buildScenarioList();
    this.wireControls();
    this.wireKeyboard();

    const shared = decodeRun(location.hash);
    if (shared) {
      this.install(replayRun(shared, UI_TRACE));
      this.playing = false;
      this.toast(`Replayed a shared run: ${shared.actions.length} action${shared.actions.length === 1 ? '' : 's'}, stopped at t = ${shared.end.t.toFixed(1)} ms. Press Play to continue.`);
      this.setNarration('Shared run', `This is a replay of a shared run (seed ${this.sim.config.seed}). Every server, message and log is exactly where it was when the link was made. Press Play to carry on from here.`);
    } else {
      this.install(new Simulation({ ...UI_TRACE, seed: 1, n: 5 }));
    }
    this.syncPlayButton();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stopLoop();
      else this.startLoop();
    });
    this.startLoop();
  }

  // ---- Simulation lifecycle -------------------------------------------------

  private install(sim: Simulation): void {
    this.sim = sim;
    this.checker = new SafetyChecker();
    for (let i = 0; i < 1; i++) this.checker.check(sim);
    sim.addObserver((s) => this.checker.check(s));
    this.stage.reset(sim.nodes.length);
    this.stage.selected = null;
    this.logTable.reset();
    this.timeline.reset();
    this.closeMenu();
    this.syncControls();
    this.renderAll(0);
  }

  reset(config: Partial<SimConfig> = {}): void {
    this.exitScenario(false);
    const c = this.sim.initialConfig;
    this.install(new Simulation({ ...UI_TRACE, seed: c.seed, n: c.n, ...config }));
    this.setNarration('Free play', 'A fresh cluster. Watch the first election, then click a server to crash it, make it time out, or send a write through it. Drag a server away to partition the network.');
    history.replaceState(null, '', location.pathname + location.search);
    this.playing = true;
    this.syncPlayButton();
  }

  private startLoop(): void {
    if (this.raf) return;
    this.lastFrame = performance.now();
    const frame = (ts: number) => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(100, Math.max(0, ts - this.lastFrame));
      this.lastFrame = ts;
      if (this.playing && !this.stage.isDragging()) this.advance(dt * BASE_RATE * this.speed);
      this.renderAll(dt);
      this.frames++;
    };
    this.raf = requestAnimationFrame(frame);
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Move simulated time forward; in a scenario, stop exactly when the current step's condition holds. */
  advance(simDt: number): void {
    const sim = this.sim;
    const target = sim.now + simDt;
    const scn = this.scenario;
    if (!scn || !scn.running) {
      sim.runUntil(target);
      return;
    }
    const step = scn.def.steps[scn.index]!;
    const limit = Math.min(target, scn.deadline);
    for (;;) {
      const next = sim.nextEventTime();
      if (next === null || next > limit) break;
      sim.step();
      if (step.until!(sim, scn.ctx)) {
        this.stepReached(true);
        return;
      }
    }
    if (target >= scn.deadline) {
      sim.now = Math.max(sim.now, scn.deadline);
      this.stepReached(step.until!(sim, scn.ctx));
      return;
    }
    if (target > sim.now) sim.now = target;
  }

  stepOnce(): void {
    this.playing = false;
    this.syncPlayButton();
    const scn = this.scenario;
    if (scn?.running) {
      const step = scn.def.steps[scn.index]!;
      const next = this.sim.nextEventTime();
      if (next !== null && next <= scn.deadline) {
        this.sim.step();
        if (step.until!(this.sim, scn.ctx)) this.stepReached(true);
      }
      return;
    }
    this.sim.step();
  }

  // ---- Scenarios ------------------------------------------------------------

  private buildScenarioList(): void {
    const list = $('scenario-list');
    for (const s of SCENARIOS) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.scenario = s.id;
      if (s.config.mutations) b.classList.add('bug');
      b.innerHTML = `<span class="scn-title"></span><span class="scn-sum"></span>`;
      b.querySelector('.scn-title')!.textContent = s.title;
      b.querySelector('.scn-sum')!.textContent = s.summary;
      b.addEventListener('click', () => this.loadScenario(s.id));
      li.appendChild(b);
      list.appendChild(li);
    }
  }

  loadScenario(id: string): void {
    const def = SCENARIOS.find((s) => s.id === id);
    if (!def) return;
    this.install(new Simulation({ ...UI_TRACE, ...def.config }));
    history.replaceState(null, '', location.pathname + location.search);
    this.scenario = { def, index: 0, ctx: {}, running: false, deadline: 0 };
    for (const b of document.querySelectorAll<HTMLButtonElement>('#scenario-list button')) {
      b.setAttribute('aria-current', String(b.dataset.scenario === id));
    }
    $('narr-actions').hidden = false;
    $('narration-title').textContent = def.title;
    // Until the first step finishes, say what the scenario is about rather than leaving the old text up.
    $('caption').textContent = def.summary;
    this.beginStep();
    if (matchMedia('(max-width: 900px)').matches) $('stage-panel').scrollIntoView({ block: 'start', behavior: this.reducedMotion ? 'auto' : 'smooth' });
  }

  private beginStep(): void {
    const scn = this.scenario!;
    const step = scn.def.steps[scn.index]!;
    startStep(this.sim, step, scn.ctx);
    scn.deadline = this.sim.now + (step.within ?? 4000);
    if (!step.until || step.until(this.sim, scn.ctx)) {
      this.stepReached(true);
      return;
    }
    scn.running = true;
    this.playing = true;
    this.syncPlayButton();
    this.updateNarration('…');
  }

  private stepReached(reached: boolean): void {
    const scn = this.scenario!;
    const step = scn.def.steps[scn.index]!;
    scn.running = false;
    this.playing = false;
    this.syncPlayButton();
    const out = finishStep(this.sim, step, scn.ctx, reached);
    this.updateNarration(out.caption);
  }

  nextStep(): void {
    const scn = this.scenario;
    if (!scn || scn.running) return;
    if (scn.index + 1 >= scn.def.steps.length) {
      this.exitScenario(true);
      return;
    }
    scn.index++;
    this.beginStep();
  }

  private updateNarration(caption: string): void {
    const scn = this.scenario;
    if (!scn) return;
    const last = scn.index + 1 >= scn.def.steps.length;
    $('narr-step').textContent = `step ${scn.index + 1} of ${scn.def.steps.length}`;
    const next = $<HTMLButtonElement>('btn-next');
    next.disabled = scn.running;
    next.textContent = scn.running ? 'Running…' : last ? 'Finish' : 'Next';
    if (!scn.running) $('caption').textContent = caption;
  }

  private exitScenario(keepState: boolean): void {
    if (!this.scenario) return;
    const title = this.scenario.def.title;
    this.scenario = null;
    $('narr-actions').hidden = true;
    $('narr-step').textContent = '';
    for (const b of document.querySelectorAll<HTMLButtonElement>('#scenario-list button')) b.setAttribute('aria-current', 'false');
    if (keepState) this.setNarration('Free play', `That was “${title}”. The simulation is yours now: press Play to keep it running, or try something on it.`);
  }

  private setNarration(title: string, caption: string): void {
    $('narration-title').textContent = title;
    $('caption').textContent = caption;
  }

  // ---- Controls ---------------------------------------------------------------

  private wireControls(): void {
    $('btn-play').addEventListener('click', () => this.togglePlay());
    $('btn-step').addEventListener('click', () => this.stepOnce());
    const speed = $<HTMLInputElement>('speed');
    const onSpeed = () => {
      this.speed = 10 ** Number(speed.value);
      $('speed-out').textContent = `${this.speed < 1 ? this.speed.toFixed(this.speed < 0.995 ? 2 : 1) : this.speed.toFixed(this.speed < 9.95 ? 1 : 0)}×`.replace('.0×', '×');
    };
    speed.addEventListener('input', onSpeed);
    onSpeed();

    $('btn-next').addEventListener('click', () => this.nextStep());
    $('btn-restart-scn').addEventListener('click', () => this.scenario && this.loadScenario(this.scenario.def.id));
    $('btn-exit-scn').addEventListener('click', () => this.exitScenario(true));

    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-split]')) {
      b.addEventListener('click', () => this.split(b.dataset.split!));
    }
    const drop = $<HTMLInputElement>('drop');
    drop.addEventListener('input', () => ($('drop-out').textContent = `${drop.value}%`));
    drop.addEventListener('change', () => this.act({ type: 'drop', rate: Number(drop.value) / 100 }));
    const lat = $<HTMLInputElement>('latency');
    lat.addEventListener('input', () => ($('lat-out').textContent = `${lat.value} ms`));
    lat.addEventListener('change', () => {
      const v = Number(lat.value);
      this.act({ type: 'latency', latency: v, jitter: Math.round(v * 0.4) });
    });
    $<HTMLInputElement>('prevote').addEventListener('change', (e) => this.act({ type: 'preVote', on: (e.target as HTMLInputElement).checked }));
    $<HTMLInputElement>('fastbackup').addEventListener('change', (e) => this.act({ type: 'fastBackup', on: (e.target as HTMLInputElement).checked }));

    $('client-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const via = $<HTMLSelectElement>('client-via').value;
      this.sendClient(via === 'auto' ? null : Number(via));
    });

    for (const b of document.querySelectorAll<HTMLButtonElement>('#size-seg button')) {
      b.addEventListener('click', () => this.reset({ n: Number(b.dataset.n) }));
    }
    $('seed-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const seed = Math.max(0, Math.floor(Number($<HTMLInputElement>('seed').value) || 0)) >>> 0;
      this.reset({ seed });
    });
    $('btn-random').addEventListener('click', () => {
      const seed = Math.floor(Math.random() * 1_000_000);
      $<HTMLInputElement>('seed').value = String(seed);
      this.reset({ seed });
    });

    $('btn-share').addEventListener('click', () => this.share());
    $('btn-help').addEventListener('click', () => $<HTMLDialogElement>('help-dialog').showModal());
    $('safety').addEventListener('click', () => {
      const v = this.checker.violation;
      this.toast(
        v
          ? `${v.property} violated at t = ${v.t.toFixed(1)} ms: ${v.message}.`
          : 'Checked after every event: Election Safety, Leader Append-Only, Log Matching, Leader Completeness and State Machine Safety.',
        6000,
      );
    });
    window.addEventListener('hashchange', () => {
      const run = decodeRun(location.hash);
      if (!run) return;
      this.exitScenario(false);
      this.install(replayRun(run, UI_TRACE));
      this.playing = false;
      this.syncPlayButton();
      this.toast('Replayed the shared run.');
    });
    document.addEventListener('pointerdown', (e) => {
      const menu = $('node-menu');
      if (!menu.hidden && !menu.contains(e.target as Node) && !(e.target as Element).closest?.('.node')) this.closeMenu();
    });
    window.addEventListener('pointerup', () => ($('drag-hint').hidden = true));
  }

  private syncControls(): void {
    const c = this.sim.config;
    $<HTMLInputElement>('seed').value = String(c.seed);
    for (const b of document.querySelectorAll<HTMLButtonElement>('#size-seg button')) {
      b.setAttribute('aria-checked', String(Number(b.dataset.n) === c.n));
    }
    $<HTMLInputElement>('drop').value = String(Math.round(c.dropRate * 100));
    $('drop-out').textContent = `${Math.round(c.dropRate * 100)}%`;
    $<HTMLInputElement>('latency').value = String(c.latency);
    $('lat-out').textContent = `${c.latency} ms`;
    $<HTMLInputElement>('prevote').checked = c.preVote;
    $<HTMLInputElement>('fastbackup').checked = c.fastBackup;
    const via = $<HTMLSelectElement>('client-via');
    via.replaceChildren();
    const auto = new Option('Any', 'auto');
    via.add(auto);
    for (let i = 0; i < c.n; i++) via.add(new Option(`S${i + 1}`, String(i)));
  }

  togglePlay(): void {
    this.playing = !this.playing;
    this.syncPlayButton();
  }

  private syncPlayButton(): void {
    const b = $('btn-play');
    b.textContent = this.playing ? 'Pause' : 'Play';
    b.setAttribute('aria-pressed', String(this.playing));
  }

  act(a: Action): void {
    this.sim.apply(a);
  }

  private parseCommand(text: string): ClientOp | null {
    const t = text.trim();
    let m = /^(?:set\s+)?([A-Za-z_][\w-]{0,11})\s*(?:=|\s)\s*([^\s=]{1,12})$/.exec(t);
    if (m && !/^(del|get)$/i.test(m[1]!)) return { kind: 'set', key: m[1]!, value: m[2]! };
    m = /^del(?:ete)?\s+([A-Za-z_][\w-]{0,11})$/i.exec(t);
    if (m) return { kind: 'del', key: m[1]! };
    m = /^get\s+([A-Za-z_][\w-]{0,11})$/i.exec(t);
    if (m) return { kind: 'get', key: m[1]! };
    return null;
  }

  sendClient(via: NodeId | null): void {
    const input = $<HTMLInputElement>('client-cmd');
    const op = this.parseCommand(input.value);
    if (!op) {
      this.toast('Try a command like x=5, del x or get x.');
      input.focus();
      return;
    }
    this.act({ type: 'client', client: 0, op, via });
    this.toast(`C1 sends ${describeOp(op)}${via === null ? '' : ` to S${via + 1}`}.`, 2200);
    if (op.kind === 'set') {
      const num = Number(op.value);
      this.cmdCounter = Number.isFinite(num) ? num + 1 : this.cmdCounter + 1;
      input.value = `${op.key}=${this.cmdCounter}`;
    }
  }

  private split(kind: string): void {
    const n = this.sim.nodes.length;
    const ids = [...Array(n).keys()];
    const leader = this.sim.leader();
    if (kind === 'heal') {
      this.act({ type: 'heal' });
      return;
    }
    const anchor = leader?.id ?? 0;
    const order = ids.map((_, k) => (anchor + k) % n);
    if (kind === 'isolate') {
      if (!leader) return this.toast('There is no leader right now; isolating S1 instead.'), this.isolate(0);
      this.isolate(leader.id);
    } else if (kind === 'minority') {
      const size = Math.max(1, Math.floor((n - 1) / 2));
      const minority = order.slice(0, size);
      this.act({ type: 'partition', groups: [minority, ids.filter((i) => !minority.includes(i))] });
    } else if (kind === 'nomajority') {
      const size = Math.max(1, Math.floor((n - 1) / 2));
      const groups: number[][] = [];
      for (let i = 0; i < n; i += size) groups.push(order.slice(i, i + size));
      this.act({ type: 'partition', groups });
    }
  }

  isolate(id: NodeId): void {
    const n = this.sim.nodes.length;
    const g = this.sim.groupOf;
    const others = [...Array(n).keys()].filter((i) => i !== id && (!g || g[i] !== g[id] || true));
    this.act({ type: 'partition', groups: [[id], others] });
  }

  private onNodeDrop(id: NodeId, at: { x: number; y: number }): void {
    $('drag-hint').hidden = true;
    const groupOf = this.sim.groupOf;
    const t = this.stage.dropTarget(id, at, groupOf);
    if (!t) return;
    const n = this.sim.nodes.length;
    const current = groupOf ?? new Array<number>(n).fill(0);
    const next = [...current];
    if ('join' in t) {
      if (!groupOf) return;
      next[id] = current[t.join]!;
    } else {
      next[id] = Math.max(...current) + 1;
    }
    const groups = new Map<number, number[]>();
    next.forEach((g, i) => groups.set(g, [...(groups.get(g) ?? []), i]));
    if (groups.size <= 1) this.act({ type: 'heal' });
    else this.act({ type: 'partition', groups: [...groups.values()] });
  }

  // ---- Node menu ----------------------------------------------------------------

  openMenu(id: NodeId): void {
    this.stage.selected = id;
    this.menuFor = id;
    const node = this.sim.nodes[id]!;
    const menu = $('node-menu');
    menu.replaceChildren();
    const head = document.createElement('div');
    head.className = 'menu-head';
    head.innerHTML = `<strong>S${id + 1}</strong> · ${node.crashed ? 'down' : node.role} · term ${node.currentTerm}<br>log ${node.lastLogIndex}, commit ${node.commitIndex}, voted ${node.votedFor === null ? '—' : `S${node.votedFor + 1}`}`;
    menu.appendChild(head);
    const item = (label: string, key: string, fn: () => void, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span></span><kbd>${key}</kbd>`;
      b.firstElementChild!.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', () => {
        fn();
        this.closeMenu();
      });
      menu.appendChild(b);
    };
    item(node.crashed ? 'Restart' : 'Crash', 'c', () => this.toggleCrash(id));
    item('Time out now', 't', () => this.act({ type: 'timeout', node: id }), node.crashed || node.role === 'leader');
    item(`Send “${$<HTMLInputElement>('client-cmd').value.trim() || 'x=1'}” via S${id + 1}`, 'w', () => this.sendClient(id));
    item('Isolate from the others', 'i', () => this.isolate(id));
    if (this.sim.groupOf) item('Heal the network', 'h', () => this.act({ type: 'heal' }));
    menu.hidden = false;
    const wrap = menu.parentElement!;
    const p = this.stage.anchorOf(id, wrap);
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.min(Math.max(8, p.x + 46), wrap.clientWidth - w - 8);
    const top = Math.min(Math.max(8, p.y - h / 2), wrap.clientHeight - h - 8);
    menu.style.left = `${p.x + 46 + w > wrap.clientWidth ? Math.max(8, p.x - 46 - w) : left}px`;
    menu.style.top = `${top}px`;
    (menu.querySelector('button:not([disabled])') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  closeMenu(): void {
    const menu = document.getElementById('node-menu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      const id = this.menuFor;
      this.menuFor = null;
      if (id !== null) (document.querySelector(`.node[data-node="${id}"]`) as SVGGElement | null)?.focus({ preventScroll: true });
    }
  }

  toggleCrash(id: NodeId): void {
    const node = this.sim.nodes[id];
    if (!node) return;
    this.act(node.crashed ? { type: 'restart', node: id } : { type: 'crash', node: id });
  }

  // ---- Keyboard -------------------------------------------------------------------

  private wireKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      const typing = t.closest('input, select, textarea') !== null;
      if ($<HTMLDialogElement>('help-dialog').open) return;
      if (e.key === 'Escape') {
        if (!$('node-menu').hidden) this.closeMenu();
        else this.stage.selected = null;
        return;
      }
      if (typing) return;
      const onControl = t.closest('button, a, [role="button"], [role="menuitem"]') !== null;
      const sel = this.stage.selected;
      switch (e.key) {
        case ' ':
          if (onControl) return;
          e.preventDefault();
          this.togglePlay();
          return;
        case '.':
          e.preventDefault();
          this.stepOnce();
          return;
        case 'c':
          if (sel !== null) this.toggleCrash(sel);
          return;
        case 't':
          if (sel !== null) this.act({ type: 'timeout', node: sel });
          return;
        case 'w':
          if (sel !== null) this.sendClient(sel);
          return;
        case 'i':
          if (sel !== null) this.isolate(sel);
          return;
        case 'h':
          this.act({ type: 'heal' });
          return;
        case 'n':
          this.nextStep();
          return;
        case 'r':
          this.reset();
          return;
        case '?':
          $<HTMLDialogElement>('help-dialog').showModal();
          return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const id = Number(e.key) - 1;
        if (id < this.sim.nodes.length) {
          this.stage.selected = id;
          (document.querySelector(`.node[data-node="${id}"]`) as SVGGElement | null)?.focus({ preventScroll: true });
        }
      }
    });
  }

  // ---- Share ------------------------------------------------------------------------

  share(): void {
    const run = captureRun(this.sim, this.scenario?.def.id);
    const hash = encodeRun(run);
    const url = `${location.origin}${location.pathname}#${hash}`;
    history.replaceState(null, '', `#${hash}`);
    const done = () => this.toast('Link copied. Opening it replays this exact run.', 3000);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => this.toast('The link is in the address bar: copy it from there.', 3500));
    else this.toast('The link is in the address bar: copy it from there.', 3500);
  }

  toast(text: string, ms = 2600): void {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), ms);
  }

  // ---- Rendering ----------------------------------------------------------------------

  private renderAll(dt: number): void {
    const sim = this.sim;
    this.stage.render(sim, { dtMs: dt, reducedMotion: this.reducedMotion });
    this.logTable.render(sim);
    this.timeline.render();
    $('clock').textContent = `t = ${sim.now.toFixed(1)} ms`;
    const leader = sim.leader();
    const maxTerm = Math.max(...sim.nodes.map((n) => n.currentTerm));
    const summary = leader
      ? `term ${leader.currentTerm} · leader S${leader.id + 1} · committed ${leader.commitIndex}`
      : `term ${maxTerm} · no leader`;
    const s = $('summary');
    if (s.textContent !== summary) s.textContent = summary;
    const badge = $('safety');
    const v = this.checker.violation;
    const text = v ? `${v.property} violated` : '5 / 5 safety properties hold';
    if (badge.textContent !== text) {
      badge.textContent = text;
      badge.className = `safety ${v ? 'bad' : 'ok'}`;
    }
    if (this.menuFor !== null && !$('node-menu').hidden && this.stage.isDragging()) this.closeMenu();
  }
}
