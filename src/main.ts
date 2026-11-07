import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-sans-devanagari/devanagari-600.css';
import '@fontsource-variable/fraunces/opsz.css';
import './style.css';
import { App } from './ui/app';

const app = new App();

// A small handle for the end-to-end tests and for curious visitors.
declare global {
  interface Window {
    __sahmati: unknown;
  }
}
window.__sahmati = {
  app,
  fingerprint: () => app.sim.fingerprint(),
  state: () => {
    const sim = app.sim;
    return {
      now: sim.now,
      events: sim.eventsProcessed,
      leader: sim.leader()?.id ?? null,
      groups: sim.groupOf,
      violation: app.checker.violation,
      scenario: app.scenario ? { id: app.scenario.def.id, index: app.scenario.index, steps: app.scenario.def.steps.length, running: app.scenario.running } : null,
      history: sim.history,
      nodes: sim.nodes.map((n) => ({
        id: n.id,
        role: n.role,
        term: n.currentTerm,
        crashed: n.crashed,
        log: n.log.map((e) => [e.term, e.uid]),
        commit: n.commitIndex,
        applied: n.lastApplied,
        kv: n.kv.snapshot(),
      })),
    };
  },
};
