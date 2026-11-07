/**
 * Share links. A run is fully determined by its starting configuration, the
 * actions taken (each stamped with the event count and time it happened at)
 * and where it stopped, so that is all a link carries. Opening the link
 * replays the run and lands on the identical state.
 */
import { DEFAULT_CONFIG, replay, type RecordedAction, type SimConfig, type Simulation } from './raft/sim';

export interface SharedRun {
  config: Partial<SimConfig>;
  actions: RecordedAction[];
  end: { ev: number; t: number };
  /** Scenario the run came from (informational). */
  scenario?: string;
}

const KEYS: (keyof SimConfig)[] = [
  'seed',
  'n',
  'electionTimeoutMin',
  'electionTimeoutMax',
  'heartbeatInterval',
  'latency',
  'jitter',
  'dropRate',
  'preVote',
  'fastBackup',
  'maxBatch',
  'leaderNoop',
  'clients',
  'clientTimeout',
  'mutations',
];

export function captureRun(sim: Simulation, scenario?: string): SharedRun {
  const config: Partial<SimConfig> = {};
  for (const k of KEYS) {
    const v = sim.initialConfig[k];
    if (JSON.stringify(v) !== JSON.stringify(DEFAULT_CONFIG[k])) (config as Record<string, unknown>)[k] = v;
  }
  const run: SharedRun = { config, actions: sim.actions.map((a) => structuredClone(a)), end: { ev: sim.eventsProcessed, t: sim.now } };
  if (scenario) run.scenario = scenario;
  return run;
}

export function encodeRun(run: SharedRun): string {
  const payload = {
    v: 1,
    c: run.config,
    a: run.actions.map((r) => [r.ev, r.t, r.a]),
    e: [run.end.ev, run.end.t],
    ...(run.scenario ? { s: run.scenario } : {}),
  };
  return `run=${toBase64Url(JSON.stringify(payload))}`;
}

export function decodeRun(hash: string): SharedRun | null {
  const m = /(?:^#?|&)run=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const p = JSON.parse(fromBase64Url(m[1]!)) as {
      v: number;
      c: Partial<SimConfig>;
      a: [number, number, RecordedAction['a']][];
      e: [number, number];
      s?: string;
    };
    if (p.v !== 1 || !Array.isArray(p.a) || !Array.isArray(p.e)) return null;
    const config: Partial<SimConfig> = {};
    for (const k of KEYS) if (k in p.c) (config as Record<string, unknown>)[k] = (p.c as Record<string, unknown>)[k];
    if (config.n !== undefined && (config.n < 1 || config.n > 9)) return null;
    const run: SharedRun = {
      config,
      actions: p.a.map(([ev, t, a]) => ({ ev, t, a })),
      end: { ev: p.e[0], t: p.e[1] },
    };
    if (typeof p.s === 'string') run.scenario = p.s;
    return run;
  } catch {
    return null;
  }
}

export function replayRun(run: SharedRun, extra: Partial<SimConfig> = {}): Simulation {
  return replay({ ...run.config, ...extra }, run.actions, run.end);
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
