/**
 * Randomised fault injection. Every seed generates a cluster configuration and
 * a timed list of crashes, restarts, partitions, heals, message loss, latency
 * spikes, leader churn and client operations. The five safety properties are
 * checked after every event; then the network heals, every server restarts,
 * and the run must converge (liveness) with a linearizable client history.
 *
 *   FUZZ_SEEDS=20000 npx vitest run tests/fuzz.test.ts   # more seeds
 *   FUZZ_SEED=1234 npx vitest run tests/fuzz.test.ts     # one seed
 *   FUZZ_START=50000 FUZZ_SEEDS=10000 ...                # a different range
 */
import { expect, it } from 'vitest';
import { describeFailure, generateCase, reproduction, runCase, shrink, type FuzzResult } from '../src/raft/fuzz';

const single = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null;
const count = single !== null ? 1 : Number(process.env.FUZZ_SEEDS ?? 2000);
const start = single ?? Number(process.env.FUZZ_START ?? 1);

it(`${count} random fault schedules keep all five safety properties, stay live and linearizable`, () => {
  const t0 = performance.now();
  let events = 0;
  let messages = 0;
  let ops = 0;
  let acked = 0;
  let maxEvents = 0;
  const converge: number[] = [];
  const failures: string[] = [];
  for (let seed = start; seed < start + count; seed++) {
    const c = generateCase(seed);
    const r: FuzzResult = runCase(c);
    events += r.events;
    messages += r.messages;
    ops += r.clientOps;
    acked += r.acked;
    maxEvents = Math.max(maxEvents, r.events);
    converge.push(r.convergeTime);
    if (!r.ok) {
      const why = describeFailure(r.failure!);
      const kind = r.failure!.kind === 'safety' ? r.failure!.violation.property : r.failure!.kind;
      const small = shrink(c, (x) => !x.ok && (x.failure!.kind === 'safety' ? x.failure!.violation.property : x.failure!.kind) === kind);
      failures.push(
        `seed ${seed}: ${why}\n  reproduce: FUZZ_SEED=${seed} npx vitest run tests/fuzz.test.ts\n` +
          `  minimal case (${small.actions.length} of ${c.actions.length} actions): runCase(${reproduction(small)})`,
      );
      if (failures.length >= 5) break;
    }
  }
  const ms = performance.now() - t0;
  converge.sort((a, b) => a - b);
  const pct = (p: number) => converge[Math.min(converge.length - 1, Math.floor(p * converge.length))]!.toFixed(0);
  console.log(
    `[fuzz] seeds ${start}..${start + count - 1}: ${count} runs in ${(ms / 1000).toFixed(1)} s (${(ms / count).toFixed(2)} ms/seed)\n` +
      `[fuzz] ${events} events (${Math.round(events / count)}/seed, max ${maxEvents}), ${messages} messages, ` +
      `${ops} client ops (${acked} acknowledged)\n` +
      `[fuzz] convergence after the heal: median ${pct(0.5)} ms, p99 ${pct(0.99)} ms, max ${converge.at(-1)!.toFixed(0)} ms (simulated)`,
  );
  if (failures.length) console.error(failures.join('\n\n'));
  expect(failures).toEqual([]);
});
