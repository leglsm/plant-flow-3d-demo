#!/usr/bin/env python3
"""Browser checks (Playwright, Python). T6 scope: 3D scene; S1–S8 are added with T7–T11.

Serves the repo on a local port, opens index.html in headless Chromium (SwiftShader WebGL),
and checks:
  - scene ready, time to ready (F-01 target 3 s on a desktop; headless software GL is slower,
    so the hard limit here is 10 s and the measured value is printed)
  - every resource mesh = evalTrack(track, t) at many times, forward and backward scrub (R2)
  - pallets drawn = occupied slots; WIP boxes appear during the day (F-07)
  - camera modes orbit / walk / top switch without errors
  - console errors 0, no "null" on screen, no horizontal scroll at 390 px
Screenshots -> docs/ (committed) and docs/_tmp/ (ignored).
Google Fonts are replaced by local @fontsource files (FONT_CSS) so the run is offline.
"""
import base64, functools, http.server, os, socketserver, sys, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, 'docs'); TMP = os.path.join(DOCS, '_tmp')


def font_css():
    out = []
    for fam, pkg, weights in [('IBM Plex Sans', 'ibm-plex-sans', [400, 500, 600]), ('IBM Plex Mono', 'ibm-plex-mono', [400, 500])]:
        for w in weights:
            p = os.path.join(ROOT, 'node_modules', '@fontsource', pkg, 'files', f'{pkg}-latin-{w}-normal.woff2')
            with open(p, 'rb') as f:
                b64 = base64.b64encode(f.read()).decode()
            out.append(f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;src:url(data:font/woff2;base64,{b64}) format('woff2');}}")
    return '\n'.join(out)


FONT_CSS = font_css()


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    h = functools.partial(Quiet, directory=ROOT)
    srv = socketserver.TCPServer(('127.0.0.1', 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}/index.html'


fails = []


def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        fails.append(msg)


def open_page(b, url, w, h, errors):
    pg = b.new_page(viewport={'width': w, 'height': h})
    pg.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=FONT_CSS))
    pg.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=204, body=''))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append(str(e)))
    t = time.time()
    pg.goto(url)
    pg.wait_for_function('window.__pf && window.__pf.readyAt', timeout=60000)
    return pg, time.time() - t


def main():
    os.makedirs(TMP, exist_ok=True)
    srv, url = serve()
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        pg, ready = open_page(b, url, 1400, 860, errors)
        print(f'ready in {ready:.2f}s (headless, software GL); day simulation {pg.evaluate("window.__pf.simMs"):.0f} ms')
        check(ready < 10, 'scene ready < 10 s (headless)')
        check(pg.evaluate('document.querySelector("#err").hidden'), 'no error box')
        pg.wait_for_timeout(600)
        check(pg.evaluate('window.__pf.t') > 0, 'replay starts on its own (F-01)')
        pg.screenshot(path=os.path.join(DOCS, 't6-overview.png'))

        r = pg.evaluate('''(async () => {
          const { evalTrack } = await import('./src/track.js');
          const { occupiedAt } = await import('./src/metrics.js');
          const P = window.__pf; P.setPlaying(false);
          const ts = []; for (let t = 0; t < 86400; t += 613) ts.push(t);
          const back = ts.slice().reverse().filter((_, i) => i % 2 === 0);
          let maxErr = 0, n = 0;
          for (const t of [...ts, ...back]) {
            P.setTime(t);
            for (const id of Object.keys(P.R.tracks)) {
              if (P.R.resources[id].type === 'machine') continue;
              const a = P.view.actorPos(id), s = evalTrack(P.R.tracks[id], t);
              maxErr = Math.max(maxErr, Math.hypot(a[0] - s.p[0], a[1] - s.p[1])); n++;
            }
          }
          let pal = 0; for (const t of [80000, 1000, 43000, 20000]) { P.setTime(t); if (P.view.palletCount() !== occupiedAt(P.R, t).size) pal++; }
          let wip = 0; for (let t = 0; t < 86400; t += 900) { P.setTime(t); wip = Math.max(wip, P.view.wipCount()); }
          return { maxErr, n, pal, wip, actors: Object.keys(P.R.tracks).length };
        })()''')
        print(r)
        check(r['maxErr'] < 1e-9, f"mesh position = track position ({r['n']} checks, scrub forward + backward)")
        check(r['pal'] == 0, 'pallets drawn = occupied slots')
        check(r['wip'] > 0, 'work-in-progress boxes appear on tables (F-07)')

        pg.evaluate('window.__pf.setTime(37800)')
        pg.evaluate('''(() => { const o = window.__pf.view.scene.getCameraByName('orbit'); o.target.set(155, 0, 72); o.radius = 38; o.beta = 0.95; o.alpha = -Math.PI / 2 - 0.6; })()''')
        pg.wait_for_timeout(500)
        pg.screenshot(path=os.path.join(DOCS, 't6-packing.png'))
        for cam in ['walk', 'top', 'orbit']:
            pg.click(f'[data-cam={cam}]')
            pg.wait_for_timeout(400)
            check(pg.evaluate('window.__pf.view.cameraMode') == cam, f'camera {cam}')
            if cam != 'orbit':
                pg.screenshot(path=os.path.join(TMP, f't6-{cam}.png'))
        # orbit input mapping (TRD 1.5): left drag pans, right drag rotates
        cam = '(() => { const o = window.__pf.view.scene.getCameraByName("orbit"); return [o.target.x, o.target.z, o.alpha]; })()'
        a = pg.evaluate(cam)
        pg.mouse.move(700, 400); pg.mouse.down(); pg.mouse.move(780, 440, steps=6); pg.mouse.up(); pg.wait_for_timeout(600)
        b1 = pg.evaluate(cam)
        check(abs(b1[2] - a[2]) < 1e-6 and abs(b1[0] - a[0]) + abs(b1[1] - a[1]) > 1, 'orbit: left drag pans (no rotation)')
        pg.mouse.move(700, 400); pg.mouse.down(button='right'); pg.mouse.move(780, 400, steps=6); pg.mouse.up(button='right'); pg.wait_for_timeout(300)
        c1 = pg.evaluate(cam)
        check(abs(c1[2] - b1[2]) > 0.05, 'orbit: right drag rotates')
        # walk: wheel steps forward; top: wheel zooms
        pg.click('[data-cam=walk]'); pg.wait_for_timeout(200)
        pos = '(() => { const c = window.__pf.view.scene.activeCamera; return [c.position.x, c.position.y, c.position.z, c.orthoRight || 0]; })()'
        w0 = pg.evaluate(pos); pg.mouse.move(700, 600); pg.mouse.wheel(0, -100); pg.wait_for_timeout(150); w1 = pg.evaluate(pos)
        check(abs(((w1[0] - w0[0]) ** 2 + (w1[2] - w0[2]) ** 2) ** 0.5 - 2) < 0.05 and abs(w1[1] - 1.7) < 1e-6, 'walk: wheel = 2 m step at eye height 1.7 m')
        pg.click('[data-cam=top]'); pg.wait_for_timeout(200)
        t0 = pg.evaluate(pos); pg.mouse.move(700, 400); pg.mouse.wheel(0, -100); pg.wait_for_timeout(150); t1 = pg.evaluate(pos)
        check(t1[3] < t0[3], 'top: wheel zooms in')
        pg.click('[data-cam=orbit]'); pg.wait_for_timeout(200)
        # pick: click a resource from its projected screen position is brittle; pick the canvas centre
        pg.mouse.click(700, 420)
        pg.wait_for_timeout(200)
        check(not pg.evaluate('document.body.innerText.includes("null")'), 'no "null" on screen')
        pg.close()

        pg, _ = open_page(b, url, 390, 800, errors)
        pg.wait_for_timeout(500)
        sw = pg.evaluate('document.documentElement.scrollWidth')
        check(sw <= 390, f'390 px: no horizontal scroll (scrollWidth {sw})')
        pg.screenshot(path=os.path.join(TMP, 't6-390.png'))
        pg.close()
        b.close()
    srv.shutdown()
    check(not errors, f'console errors 0 ({len(errors)})')
    for e in errors[:10]:
        print('  ', e)
    print('\nE2E', 'FAILED' if fails else 'OK', f'({len(fails)} failed)')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
