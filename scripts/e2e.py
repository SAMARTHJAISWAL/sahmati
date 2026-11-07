"""End-to-end checks of a built sahmati, driven through the real UI with
Playwright's Chromium.

    npm run build:pages
    mkdir -p /tmp/site && rm -rf /tmp/site/sahmati && cp -r dist /tmp/site/sahmati
    (cd /tmp/site && python -m http.server 8765) &
    python scripts/e2e.py http://localhost:8765/sahmati/

Checks: no console errors; a leader within a few seconds of load; crashing the
leader leads to re-election; a minority partition cannot commit and healing
converges every log; a client write commits and shows in every server's
key-value state; every scenario steps through to the end; a share link replays
to an identical state; the header title and Source link go to the repository;
keyboard shortcuts; a 390x844 phone viewport has no horizontal overflow and
works by tap; prefers-reduced-motion stops message animation.

Requires `pip install playwright && playwright install chromium`.
"""

import json
import sys
import time

from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8765/sahmati/'
REPO = 'https://github.com/SAMARTHJAISWAL/sahmati'
ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  (' + detail + ')' if detail else ''}", flush=True)


def state(page: Page) -> dict:
    return page.evaluate('window.__sahmati.state()')


def wait_for(page: Page, js: str, timeout: float, poll: float = 0.05):
    """Poll a JS expression until it is truthy; return (value, seconds waited) or (None, timeout)."""
    start = time.time()
    while time.time() - start < timeout:
        v = page.evaluate(js)
        if v:
            return v, time.time() - start
        time.sleep(poll)
    return None, timeout


def set_speed(page: Page, multiplier: float) -> None:
    import math

    page.evaluate(
        """(v) => { const s = document.getElementById('speed'); s.value = String(v);
                    s.dispatchEvent(new Event('input', { bubbles: true })); }""",
        math.log10(multiplier),
    )


def click_node(page: Page, node: int) -> None:
    page.locator(f'.node[data-node="{node}"]').click()


def menu_item(page: Page, text: str):
    return page.locator('#node-menu button', has_text=text).first


def new_page(browser, errors: list[str], **ctx):
    context = browser.new_context(**ctx)
    # Never leave the machine: the repository link is answered locally.
    context.route('https://github.com/**', lambda r: r.fulfill(status=200, content_type='text/html', body='<title>repo</title>ok'))
    page = context.new_page()
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    return page


def main() -> None:
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')
        page = new_page(browser, errors, viewport={'width': 1440, 'height': 900})
        page.goto(BASE)
        page.wait_for_function('window.__sahmati && window.__sahmati.app.frames > 2')

        # 1. A leader is elected within a few seconds of load, at the default 1x speed.
        leader, waited = wait_for(page, 'window.__sahmati.state().leader !== null', 8)
        check('leader elected at 1x speed within a few seconds of load', leader is not None and waited < 6, f'{waited:.2f} s')
        check('fonts and styles loaded', page.evaluate("getComputedStyle(document.querySelector('.brand-latin')).fontFamily.includes('Fraunces')"))

        # 2. Crash the leader through the UI; a different server takes over.
        set_speed(page, 4)
        old = state(page)['leader']
        click_node(page, old)
        check('clicking a server opens its menu', page.locator('#node-menu').is_visible())
        menu_item(page, 'Crash').click()
        down, _ = wait_for(page, f'document.querySelector(\'.node[data-node="{old}"]\').classList.contains("down")', 2)
        check('the crashed server is drawn as down', bool(down))
        new, waited = wait_for(page, f'(() => {{ const s = window.__sahmati.state(); return s.leader !== null && s.leader !== {old} ? s.leader : null; }})()', 10)
        check('crashing the leader leads to a re-election', new is not None, f'S{old + 1} crashed, S{(new or 0) + 1} elected after {waited:.2f} s')
        click_node(page, old)
        menu_item(page, 'Restart').click()
        wait_for(page, '(() => { const s = window.__sahmati.state(); return s.leader !== null && s.nodes.every(n => !n.crashed && n.commit === s.nodes[s.leader].commit); })()', 10)

        # 3. Minority partition: the old leader's write cannot commit; the majority elects; healing converges.
        leader = state(page)['leader']
        page.click('[data-split="minority"]')
        groups = state(page)['groups']
        check('"Leader in minority" splits the network', groups is not None and len(set(groups)) == 2)
        page.fill('#client-cmd', 'part=1')
        page.select_option('#client-via', str(leader))
        page.click('#client-form button[type=submit]')
        appended, _ = wait_for(page, f'window.__sahmati.state().nodes[{leader}].log.length > window.__sahmati.state().nodes[{leader}].commit', 5)
        side = [i for i, g in enumerate(groups) if g == groups[leader]]
        idx = state(page)['nodes'][leader]['log'].__len__()
        time.sleep(1.5)
        s = state(page)
        minority_commits = [s['nodes'][i]['commit'] for i in side]
        majority_leader = [n for n in s['nodes'] if n['role'] == 'leader' and n['id'] not in side]
        check('the minority leader appends the write but cannot commit it', bool(appended) and all(c < idx for c in minority_commits), f'minority {["S%d" % (i + 1) for i in side]} commit {minority_commits}, entry at {idx}')
        check('the majority side elects its own leader', len(majority_leader) == 1, f'S{majority_leader[0]["id"] + 1} in term {majority_leader[0]["term"]}' if majority_leader else '')
        page.click('[data-split="heal"]')
        converged, waited = wait_for(
            page,
            """(() => { const s = window.__sahmati.state(); if (s.leader === null) return false;
                 const L = s.nodes[s.leader]; const h = s.history.at(-1);
                 return h && h.response !== null && s.nodes.every(n => !n.crashed && JSON.stringify(n.log) === JSON.stringify(L.log)
                   && n.commit === L.log.length && n.applied === n.commit); })()""",
            15,
        )
        check('healing converges every log', bool(converged), f'{waited:.2f} s')
        s = state(page)
        check('the client write commits and shows in every server\'s KV state', all(n['kv'].get('part') == '1' for n in s['nodes']), json.dumps([n['kv'] for n in s['nodes']]))
        check('the safety badge still reads 5/5', page.inner_text('#safety').startswith('5 / 5'))

        # 4. Keyboard shortcuts.
        page.locator('#stage-panel').focus()
        playing = page.evaluate('window.__sahmati.app.playing')
        page.keyboard.press('Space')
        check('Space toggles play/pause', page.evaluate('window.__sahmati.app.playing') != playing)
        page.evaluate('window.__sahmati.app.playing = false')
        before = state(page)['events']
        page.keyboard.press('.')
        check('"." steps exactly one event', state(page)['events'] == before + 1)
        page.keyboard.press('3')
        page.keyboard.press('c')
        check('"3" then "c" crashes S3', state(page)['nodes'][2]['crashed'])
        page.keyboard.press('c')
        check('"c" again restarts it', not state(page)['nodes'][2]['crashed'])

        # 5. Share link round trip.
        page.evaluate('window.__sahmati.app.playing = false')
        for _ in range(3):
            page.keyboard.press('.')
        fp = page.evaluate('window.__sahmati.fingerprint()')
        page.click('#btn-share')
        url = page.url
        check('Share puts the run in the URL hash', '#run=' in url, f'{len(url)} chars')
        other = new_page(browser, errors, viewport={'width': 1200, 'height': 800})
        other.goto(url)
        other.wait_for_function('window.__sahmati && window.__sahmati.app.frames > 1')
        check('the share link replays to an identical state', other.evaluate('window.__sahmati.fingerprint()') == fp)
        check('a replayed run opens paused', other.evaluate('window.__sahmati.app.playing') is False)
        other.context.close()

        # 6. Every scenario loads and steps through to the end.
        set_speed(page, 10)
        for b in page.locator('#scenario-list button').all():
            sid = b.get_attribute('data-scenario')
            b.click()
            steps = 0
            stuck = False
            while True:
                _, _w = wait_for(page, '!window.__sahmati.state().scenario || !window.__sahmati.state().scenario.running', 20)
                sc = state(page)['scenario']
                if sc is None:
                    break
                if sc['running']:
                    stuck = True
                    break
                steps += 1
                page.click('#btn-next')
            v = state(page)['violation']
            expect_violation = sid == 'figure-8-bug'
            ok = not stuck and steps >= 3 and ((v is not None) == expect_violation)
            check(f'scenario "{sid}" steps through to the end', ok, f'{steps} steps' + (f', checker: {v["property"]}' if v else ''))
            if expect_violation:
                check('the injected Figure 8 bug turns the safety badge red', 'bad' in (page.get_attribute('#safety', 'class') or ''), page.inner_text('#safety'))

        # 7. Header title and Source link go to the repository.
        check('header title links to the repo', page.get_attribute('a.brand', 'href') == REPO)
        check('Source link points to the repo', page.get_attribute('#link-source', 'href') == REPO)
        page.click('a.brand')
        page.wait_for_url(f'{REPO}*', timeout=5000)
        check('clicking the title navigates to the repo', page.url.startswith(REPO), page.url)
        page.go_back()
        page.wait_for_function('window.__sahmati')
        page.click('#link-source')
        page.wait_for_url(f'{REPO}*', timeout=5000)
        check('clicking Source navigates to the repo', page.url.startswith(REPO))
        page.context.close()

        # 8. Phone viewport: no horizontal overflow, works by tap.
        m = new_page(browser, errors, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=3)
        m.goto(BASE)
        m.wait_for_function('window.__sahmati && window.__sahmati.app.frames > 2')
        overflow = m.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        check('390x844: no horizontal overflow', overflow <= 0, f'{overflow}px')
        small = m.evaluate(
            """[...document.querySelectorAll('button, .btn, select, input[type=text], input[type=number], input[type=checkbox]')]
                 .filter(e => e.offsetParent !== null && !e.closest('dialog'))
                 .map(e => [e.id || e.className || e.textContent.trim(), (e.closest('label') || e).getBoundingClientRect().height])
                 .filter(([, h]) => h < 40).map(([n, h]) => `${n} ${h.toFixed(0)}px`)"""
        )
        check('390x844: every control is at least 40px tall', not small, ', '.join(small))
        m.tap('#btn-play')
        check('390x844: tapping Play/Pause toggles', m.evaluate('window.__sahmati.app.playing') is False)
        m.tap('#btn-play')
        node_box = m.locator('.node[data-node="1"] .body').first.bounding_box()
        check('390x844: servers are big enough to tap', node_box is not None and node_box['width'] >= 40, f"{node_box['width']:.0f}px" if node_box else '')
        m.locator('.node[data-node="1"]').tap()
        check('390x844: tapping a server opens its menu', m.locator('#node-menu').is_visible())
        menu_item(m, 'Crash').tap()
        check('390x844: tapping Crash crashes it', state(m)['nodes'][1]['crashed'])
        m.tap('#scenario-list button >> nth=1')
        check('390x844: a scenario starts by tap', state(m)['scenario'] is not None)
        m.context.close()

        # 9. Reduced motion: messages sit still at the middle of their edge instead of travelling.
        r = new_page(browser, errors, viewport={'width': 1200, 'height': 800}, reduced_motion='reduce')
        r.goto(BASE)
        r.wait_for_function('window.__sahmati && window.__sahmati.app.frames > 2')
        check('reduced motion is detected', r.evaluate('window.__sahmati.app.reducedMotion'))
        wait_for(r, 'window.__sahmati.state().leader !== null', 10)
        set_speed(r, 0.2)
        wait_for(r, "document.querySelectorAll('.msg').length > 0", 5)
        a = r.evaluate("[...document.querySelectorAll('.msg')].map(e => e.getAttribute('transform'))")
        time.sleep(0.4)
        b = r.evaluate("[...document.querySelectorAll('.msg')].map(e => e.getAttribute('transform'))")
        same = set(a) & set(b)
        check('reduced motion: in-flight messages do not move', len(same) > 0 and r.evaluate('window.__sahmati.app.reducedMotion'), f'{len(same)} of {len(a)} unchanged')
        check(
            'reduced motion: CSS animations are off',
            r.evaluate("getComputedStyle(document.querySelector('.btn')).transitionDuration") in ('0s', '0s, 0s, 0s, 0s'),
        )
        r.context.close()

        # 10. Pausing when the tab is hidden.
        h = new_page(browser, errors, viewport={'width': 1200, 'height': 800})
        h.goto(BASE)
        h.wait_for_function('window.__sahmati && window.__sahmati.app.frames > 2')
        h.evaluate("Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'))")
        t0 = h.evaluate('window.__sahmati.state().now')
        time.sleep(0.5)
        t1 = h.evaluate('window.__sahmati.state().now')
        check('the simulation pauses while the tab is hidden', t0 == t1)
        h.context.close()

        browser.close()

    check('no console errors', not errors, '; '.join(errors[:5]))
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
