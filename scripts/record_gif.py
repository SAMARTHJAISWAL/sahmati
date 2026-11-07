"""Record docs/demo.gif: the "Leader crash and re-election" scenario, frame by frame.

Usage: python scripts/record_gif.py [base_url]
Serve a build first, e.g. `npm run build && npx vite preview --port 4173`.
Needs Playwright (with Chromium) and Pillow.
"""
import io
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
OUT = Path(__file__).resolve().parent.parent / 'docs' / 'demo.gif'
ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
VIEW = (1440, 900)
WIDTH = 960          # output width in pixels
FRAME_MS = 60        # output frame length (about 16 fps)
SIM_BUSY = 2.5       # simulated ms per frame while messages are in flight (a 20 ms hop takes 8 frames)
SIM_QUIET = 12.0     # ... and while the cluster is only waiting on timers
HOLD_MS = 2800       # how long each caption stays up before Next
TAIL_MS = 3000       # hold on the last frame


def grab(page, clip) -> Image.Image:
    png = page.screenshot(type='png', clip=clip)
    img = Image.open(io.BytesIO(png)).convert('RGB')
    return img.resize((WIDTH, round(WIDTH * img.height / img.width)), Image.LANCZOS)


def main() -> None:
    frames: list[tuple[Image.Image, int]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')
        ctx = browser.new_context(viewport={'width': VIEW[0], 'height': VIEW[1]}, device_scale_factor=1, color_scheme='light')
        page = ctx.new_page()
        page.goto(BASE)
        page.wait_for_function('window.__sahmati && window.__sahmati.app.frames > 2')
        page.evaluate('document.fonts.ready')
        # Time is driven from here, one fixed slice per frame, so the GIF is smooth
        # however long a screenshot takes. Speed 0 freezes the page's own clock.
        page.evaluate("window.__sahmati.app.speed = 0; window.__sahmati.app.loadScenario('leader-crash')")
        bottom = page.evaluate("document.getElementById('logs-title').closest('section').getBoundingClientRect().top - 6")
        clip = {'x': 0, 'y': 0, 'width': VIEW[0], 'height': bottom}
        tick = """async (dt) => {
            window.__sahmati.app.advance(dt);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        }"""
        page.evaluate(tick, 0)
        while True:
            sc = page.evaluate('window.__sahmati.state().scenario')
            if sc is None:
                break
            if sc['running']:
                busy = page.evaluate('window.__sahmati.app.sim.inFlight.size > 0')
                page.evaluate(tick, SIM_BUSY if busy else SIM_QUIET)
                frames.append((grab(page, clip), FRAME_MS))
                continue
            page.evaluate(tick, 0)
            last = sc['index'] + 1 >= sc['steps']
            frames.append((grab(page, clip), TAIL_MS if last else HOLD_MS))
            if last:
                break
            page.evaluate('window.__sahmati.app.nextStep()')
        browser.close()

    imgs = [f for f, _ in frames]
    durations = [d for _, d in frames]
    # One shared palette, built from frames across the whole run, keeps colours true and steady.
    sample = imgs[:: max(1, len(imgs) // 12)]
    W, H = sample[0].size
    sheet = Image.new('RGB', (W, H * len(sample)))
    for i, im in enumerate(sample):
        sheet.paste(im, (0, i * H))
    palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    q = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in imgs]
    q[0].save(OUT, save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f'{OUT.relative_to(OUT.parent.parent)}: {len(q)} frames, {sum(durations) / 1000:.1f} s, {OUT.stat().st_size / 1024:.0f} KiB')


if __name__ == '__main__':
    main()
