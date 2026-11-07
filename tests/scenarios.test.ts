import { describe, expect, it } from 'vitest';
import { SafetyChecker } from '../src/raft/invariants';
import { Simulation } from '../src/raft/sim';
import { SCENARIOS, runStepHeadless } from '../src/scenarios';

function play(id: string) {
  const s = SCENARIOS.find((x) => x.id === id)!;
  const sim = new Simulation({ ...s.config, trace: true });
  const checker = new SafetyChecker();
  sim.addObserver((x) => checker.check(x));
  const ctx = {};
  const outcomes = s.steps.map((step) => ({ ...runStepHeadless(sim, step, ctx), commit: sim.nodes.map((n) => n.commitIndex) }));
  return { sim, checker, outcomes };
}

describe('guided scenarios', () => {
  it('there are at least seven', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(7);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  for (const s of SCENARIOS) {
    it(`"${s.title}" reaches every step${s.config.mutations ? '' : ' with all safety properties intact'}`, () => {
      const { checker, outcomes } = play(s.id);
      outcomes.forEach((o, i) => {
        expect(o.reached, `step ${i + 1}: ${o.caption}`).toBe(true);
        expect(o.caption.length).toBeGreaterThan(20);
        expect(o.caption).not.toMatch(/undefined|NaN|S0\b/);
      });
      if (!s.config.mutations) expect(checker.violation).toBeNull();
    });
  }

  it('is deterministic: running a scenario twice gives the same trace', () => {
    for (const s of SCENARIOS) expect(play(s.id).sim.trace, s.id).toEqual(play(s.id).sim.trace);
  });

  it('Figure 8: the old-term entry on a majority is not committed, and is later overwritten safely', () => {
    const { sim, outcomes } = play('figure-8');
    // Step 6: index 2 (term 1) is on a majority, but nobody has committed it.
    expect(Math.max(...outcomes[5]!.commit)).toBeLessThan(2);
    // In the end every log agrees and index 2 holds S5's term-2 entry.
    expect(sim.nodes.every((n) => n.log[1]!.term === 2)).toBe(true);
  });

  it('Figure 8 with the bug: the checker catches the lost committed entry', () => {
    const { checker, outcomes } = play('figure-8-bug');
    expect(outcomes[5]!.commit[0]).toBe(2);
    expect(checker.violation?.property).toBe('Leader Completeness');
  });

  it('PreVote stops the isolated server from inflating its term', () => {
    const { sim, outcomes } = play('prevote');
    expect(outcomes[4]!.caption).toMatch(/still in term/);
    expect(sim.config.preVote).toBe(true);
  });
});
