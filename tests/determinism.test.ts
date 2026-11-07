import { describe, expect, it } from 'vitest';
import { generateCase } from '../src/raft/fuzz';
import { EventQueue } from '../src/raft/queue';
import { Rng } from '../src/raft/rng';
import { Simulation, replay } from '../src/raft/sim';
import { SCENARIOS, runStepHeadless } from '../src/scenarios';
import { captureRun, decodeRun, encodeRun, replayRun } from '../src/share';

/** Run a fuzz case's concrete actions with tracing on. */
function traced(seed: number): Simulation {
  const c = generateCase(seed);
  const sim = new Simulation({ ...c.config, trace: true });
  for (const { t, a } of c.actions) {
    sim.runUntil(t);
    if (a.type === 'churn') continue;
    if (a.type === 'crashLeader' || a.type === 'isolateLeader') {
      const l = sim.leader();
      if (l) sim.apply({ type: 'crash', node: l.id });
    } else sim.apply(a);
  }
  sim.runUntil(c.horizon);
  return sim;
}

describe('determinism', () => {
  it('the PRNG is a pure function of its seed', () => {
    const a = new Rng(123);
    const b = new Rng(123);
    const c = new Rng(124);
    const xs = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 50 }, () => c.next())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('the event queue orders by time, then by insertion order for ties', () => {
    const q = new EventQueue<string>();
    q.push(5, 'c');
    q.push(1, 'a');
    q.push(5, 'd');
    q.push(1, 'b');
    q.push(3, 'x');
    const out: string[] = [];
    while (q.size) out.push(q.pop()!.item);
    expect(out).toEqual(['a', 'b', 'x', 'c', 'd']);
  });

  it.each([1, 2, 3, 42, 1000])('seed %i with the same actions gives an identical trace', (seed) => {
    const a = traced(seed);
    const b = traced(seed);
    expect(a.trace.length).toBeGreaterThan(100);
    expect(b.trace).toEqual(a.trace);
    expect(b.fingerprint()).toBe(a.fingerprint());
  });

  it('different seeds give different runs', () => {
    expect(traced(5).fingerprint()).not.toBe(traced(6).fingerprint());
  });

  it('tracing does not change the run', () => {
    const c = generateCase(9);
    const on = new Simulation({ ...c.config, trace: true });
    const off = new Simulation({ ...c.config, trace: false });
    for (const s of [on, off]) s.runUntil(2000);
    expect(off.fingerprint()).toBe(on.fingerprint());
  });

  it('replaying recorded actions reproduces the run exactly', () => {
    const sim = traced(77);
    const again = replay(sim.initialConfig, sim.actions, { ev: sim.eventsProcessed, t: sim.now });
    expect(again.fingerprint()).toBe(sim.fingerprint());
  });
});

describe('share links', () => {
  it('round-trip through the URL hash to an identical state', () => {
    const sim = new Simulation({ seed: 31, n: 7, dropRate: 0.05, preVote: true, trace: false });
    sim.runUntil(400);
    sim.apply({ type: 'crash', node: sim.leader()?.id ?? 0 });
    sim.runUntil(420.25);
    sim.apply({ type: 'partition', groups: [[0, 1, 2], [3, 4, 5, 6]] });
    sim.apply({ type: 'client', client: 0, op: { kind: 'set', key: 'x', value: 'ü→✓' }, via: 4 });
    for (let i = 0; i < 37; i++) sim.step();
    sim.apply({ type: 'drop', rate: 0.2 });
    sim.runUntil(sim.now + 333.3333);
    sim.apply({ type: 'heal' });
    sim.runUntil(sim.now + 500);

    const hash = `#${encodeRun(captureRun(sim, 'partition'))}`;
    expect(hash).toMatch(/^#run=[A-Za-z0-9_-]+$/);
    const decoded = decodeRun(hash)!;
    expect(decoded.scenario).toBe('partition');
    expect(decoded.config).toMatchObject({ seed: 31, n: 7, dropRate: 0.05, preVote: true });
    const replayed = replayRun(decoded, { trace: false });
    expect(replayed.fingerprint()).toBe(sim.fingerprint());
  });

  it('a link made in the middle of a scenario replays to the same state', () => {
    for (const s of SCENARIOS) {
      const sim = new Simulation({ ...s.config, trace: false });
      const ctx = {};
      for (const step of s.steps.slice(0, Math.ceil(s.steps.length / 2))) runStepHeadless(sim, step, ctx);
      const back = replayRun(decodeRun(encodeRun(captureRun(sim)))!, { trace: false });
      expect(back.fingerprint(), s.id).toBe(sim.fingerprint());
    }
  });

  it('rejects malformed hashes', () => {
    expect(decodeRun('')).toBeNull();
    expect(decodeRun('#run=!!!')).toBeNull();
    expect(decodeRun('#run=e30')).toBeNull();
    expect(decodeRun('#other=1')).toBeNull();
  });
});
