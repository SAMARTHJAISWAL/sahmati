/**
 * Does the fuzzer have teeth? Each test injects one realistic bug and runs the
 * same fuzzer until it reports a failure. The first failing seed and the
 * property that caught it are printed; the README table comes from this output.
 */
import { describe, expect, it } from 'vitest';
import { describeFailure, generateCase, runCase } from '../src/raft/fuzz';
import type { Mutations } from '../src/raft/types';

const LIMIT = Number(process.env.MUTATION_SEEDS ?? 20000);

const CASES: { bug: keyof Mutations; what: string; expected: string[] }[] = [
  { bug: 'commitOldTerms', what: 'leader commits old-term entries by counting replicas (Figure 8)', expected: ['Leader Completeness', 'State Machine Safety'] },
  { bug: 'skipUpToDateCheck', what: 'votes granted without the up-to-date log check', expected: ['Leader Completeness', 'State Machine Safety'] },
  { bug: 'ignoreVotedFor', what: 'more than one vote per term', expected: ['Election Safety'] },
  { bug: 'volatileVotedFor', what: 'votedFor not persisted across a crash', expected: ['Election Safety'] },
  { bug: 'countStaleVotes', what: 'vote replies from an earlier term are counted', expected: ['Election Safety'] },
  { bug: 'skipConsistencyCheck', what: 'AppendEntries skips the prevLogIndex/prevLogTerm check', expected: ['Log Matching', 'State Machine Safety', 'Leader Completeness'] },
  { bug: 'overwriteWithoutTruncate', what: 'a conflicting entry is overwritten without deleting what follows', expected: ['Log Matching', 'State Machine Safety'] },
];

describe('mutation testing: the fuzzer catches injected bugs', () => {
  for (const { bug, what, expected } of CASES) {
    it(`${bug}: ${what}`, () => {
      const t0 = performance.now();
      for (let seed = 1; seed <= LIMIT; seed++) {
        const r = runCase(generateCase(seed, { mutations: { [bug]: true } }));
        if (r.ok) continue;
        const property = r.failure!.kind === 'safety' ? r.failure!.violation.property : r.failure!.kind;
        console.log(`[mutation] ${bug}: caught at seed ${seed} by ${property} in ${(performance.now() - t0).toFixed(0)} ms — ${describeFailure(r.failure!)}`);
        expect(expected).toContain(property);
        return;
      }
      throw new Error(`${bug} survived ${LIMIT} seeds`);
    });
  }

  it('the correct implementation passes the same seeds those bugs fail on', () => {
    for (const seed of [1, 3, 5, 12, 330, 660]) expect(runCase(generateCase(seed)).ok, `seed ${seed}`).toBe(true);
  });
});
