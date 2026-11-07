"""Capture the README screenshots and public/og.png from a running build,
using Playwright's Chromium.

    npm run build && npx vite preview --port 4173 &
    python scripts/capture.py http://localhost:4173/

Every shot is a deterministic state: a scenario driven to a given step, or a
free-play run advanced by script, so re-running this gives the same pictures.
Requires `pip install playwright && playwright install chromium`.
"""

import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']

# Free play: elect a leader, commit a few writes, then stop with AppendEntries in flight.
MID_REPLICATION = """
const app = window.__sahmati.app; const sim = app.sim;
if (app.playing) app.togglePlay();
sim.runUntilCondition(s => { const l = s.leader(); return l && s.nodes.every(n => n.lastApplied >= 1); }, 5000);
const L = sim.leader().id;
const ops = [['x', '1'], ['y', '7'], ['x', '2'], ['z', '4']];
ops.forEach(([k, v], i) => {
  sim.apply({ type: 'client', client: 0, op: { kind: 'set', key: k, value: v }, via: i === 0 ? (L + 1) % sim.nodes.length : null });
  sim.runUntilCondition(s => s.history.at(-1).response !== null, 2000);
  sim.runUntil(sim.now + 30);
});
sim.apply({ type: 'client', client: 0, op: { kind: 'set', key: 'y', value: '8' }, via: L });
sim.runUntilCondition(s => [...s.inFlight.values()].filter(f => f.msg.type === 'AppendEntries' && f.msg.entries.length > 0).length >= 4, 500);
sim.runUntil(sim.now + 12);
"""


def open_page(browser, w: int, h: int, scale: float = 1, scheme: str = 'light') -> Page:
    ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=scale, color_scheme=scheme)
    page = ctx.new_page()
    page.goto(BASE)
    page.wait_for_function('window.__sahmati && window.__sahmati.app.frames > 2')
    return page


def drive(page: Page, scenario: str, upto: int) -> None:
    """Load a scenario and press Next until step `upto` (0-based) has been reached."""
    page.evaluate(f"window.__sahmati.app.speed = 6; window.__sahmati.app.loadScenario('{scenario}')")
    while True:
        sc = page.evaluate('window.__sahmati.state().scenario')
        if not sc['running']:
            if sc['index'] >= upto:
                break
            page.evaluate('window.__sahmati.app.nextStep()')
        time.sleep(0.05)


def settle(page: Page) -> None:
    page.evaluate('window.scrollTo(0, 0)')
    time.sleep(0.8)


def main() -> None:
    (ROOT / 'docs').mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')

        page = open_page(browser, 1440, 900)
        page.evaluate(MID_REPLICATION)
        settle(page)
        page.screenshot(path=ROOT / 'docs/hero.png')
        page.context.close()

        page = open_page(browser, 1440, 900)
        drive(page, 'partition', 3)
        settle(page)
        page.screenshot(path=ROOT / 'docs/partition.png')
        page.context.close()

        # The log table before and after the heal: stale entries outlined, then overwritten.
        for step, name in [(4, 'conflict-before'), (6, 'conflict-after')]:
            page = open_page(browser, 1440, 1100)
            drive(page, 'partition', step)
            settle(page)
            page.locator('.logs').screenshot(path=ROOT / f'docs/{name}.png')
            page.context.close()

        page = open_page(browser, 1440, 900, scheme='dark')
        drive(page, 'figure-8-bug', 6)
        settle(page)
        page.screenshot(path=ROOT / 'docs/figure8-bug.png')
        page.context.close()

        page = open_page(browser, 390, 844, scale=2)
        page.evaluate(MID_REPLICATION)
        settle(page)
        page.screenshot(path=ROOT / 'docs/mobile.png')
        page.context.close()

        # Social card: the partition scenario mid-way, with the stage allowed to fill the frame.
        page = open_page(browser, 1200, 630)
        page.add_style_tag(content='#stage { max-height: 470px !important; } .legend { display: none; }')
        drive(page, 'partition', 3)
        settle(page)
        page.screenshot(path=ROOT / 'public/og.png')
        page.context.close()

        browser.close()
    for f in ['docs/hero.png', 'docs/partition.png', 'docs/conflict-before.png', 'docs/conflict-after.png', 'docs/figure8-bug.png', 'docs/mobile.png', 'public/og.png']:
        print(f, (ROOT / f).stat().st_size // 1024, 'KiB')


if __name__ == '__main__':
    main()
