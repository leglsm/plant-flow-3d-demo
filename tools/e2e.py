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

        # ---- T7: tabs, side panel, flows, selection ----
        pg2, _ = open_page(b, url, 1400, 860, errors)
        pg2.evaluate('window.__pf.setPlaying(false); window.__pf.setTime(37800)')
        pg2.keyboard.press('m'); pg2.wait_for_timeout(100)
        check(pg2.evaluate('document.querySelector("#side").classList.contains("closed")'), 'M hides the side panel')
        pg2.keyboard.press('m'); pg2.wait_for_timeout(100)
        pg2.uncheck('[data-flow=A]')
        check(not pg2.evaluate('window.__pf.view.scene.getMeshByName("pal-rm").isEnabled()') and pg2.evaluate('window.__pf.view.scene.getMeshByName("pal-fg").isEnabled()'), 'flow A off hides raw-material pallets only')
        pg2.check('[data-flow=A]')
        pg2.click('[data-res="FL-PA-3"]'); pg2.wait_for_timeout(300)
        check('Forklift PA-3' in pg2.inner_text('#sel'), 'selection panel shows the clicked resource (F-06)')
        nt = pg2.evaluate('(async () => { const { nextTaskAt } = await import("./src/metrics.js"); return nextTaskAt(window.__pf.R, "FL-PA-3", window.__pf.t); })()')
        pg2.click('#sel [data-act=goto]'); pg2.wait_for_timeout(150)
        check(abs(pg2.evaluate('window.__pf.t') - nt) < 1e-6, f'"next task" jumps the clock to {nt}')
        pg2.click('#units'); pg2.wait_for_timeout(300)
        check(' ft' in pg2.inner_text('#sel'), 'units switch to ft')
        pg2.click('#units')
        pg2.keyboard.press('Escape'); pg2.wait_for_timeout(100)
        check(pg2.evaluate('document.querySelector("#sel").hidden'), 'Esc closes the selection')
        pg2.screenshot(path=os.path.join(TMP, 't7-ops.png'))

        # ---- T8: lot trace rides the shared clock (D-34) ----
        pg2.click('[data-tab=trace]')
        for k in ['rawMaterial', 'largeBox', 'midBox']:
            ex = pg2.evaluate(f'window.__pf.R.examples.{k}')
            pg2.fill('#trace-q', ex); pg2.press('#trace-q', 'Enter'); pg2.wait_for_timeout(200)
            r = pg2.evaluate('''(() => {
              const P = window.__pf, tr = P.trace.active; P.setPlaying(false);
              let bad = 0, cam = 0, n = 0, ids = new Set();
              const times = []; for (const e of tr.timeline) times.push(e.t + 0.5);
              for (let i = 1; i < tr.timeline.length; i++) times.push((tr.timeline[i - 1].t + tr.timeline[i].t) / 2);
              for (const t of times.concat(times.slice().reverse())) {
                P.setTime(t);
                const info = P.view.traceInfo();
                const want = P.R.positionOf(info.cur.obj, P.t);
                if (!info.markerPos || Math.hypot(info.markerPos[0] - want[0], info.markerPos[1] - want[1]) > 1e-9) bad++;
                if (P.view.following && Math.hypot(info.cameraTarget[0] - info.markerPos[0], info.cameraTarget[1] - info.markerPos[1]) > 1e-9) cam++;
                n++;
              }
              for (const e of tr.timeline) ids.add(e.t + '|' + e.unit + '|' + e.step);
              return { bad, cam, n, events: tr.timeline.length, dup: tr.timeline.length - ids.size, following: P.view.following, steps: [...new Set(tr.timeline.map((e) => e.step))].length };
            })()''')
            check(r['bad'] == 0 and r['cam'] == 0 and r['following'] and r['dup'] == 0,
                  f"trace {k} ({ex}): marker = trace position, camera on target at {r['n']} scrubbed times, {r['events']} events, {r['steps']} steps, no duplicates")
        # replay follows the bar speed: 300x for ~1 s of real time
        pg2.select_option('#speed', '300')
        pg2.click('[data-act=play]'); pg2.wait_for_timeout(100)
        t0 = pg2.evaluate('window.__pf.t'); pg2.wait_for_timeout(1000); t1 = pg2.evaluate('window.__pf.t')
        info = pg2.evaluate('window.__pf.view.traceInfo()')
        moved = t1 - t0
        check(150 < moved < 450 and pg2.evaluate('window.__pf.playing'), f'replay runs at the bar speed (300x: {moved:.0f} s in ~1 s)')
        check(info['markerPos'] and abs(info['cameraTarget'][0] - info['markerPos'][0]) < 1e-9 and abs(info['cameraTarget'][1] - info['markerPos'][1]) < 1e-9, 'camera stays on the target while playing')
        pg2.select_option('#speed', '60')
        pg2.wait_for_timeout(300)
        s1 = pg2.evaluate('window.__pf.t'); pg2.wait_for_timeout(1000); s2 = pg2.evaluate('window.__pf.t')
        check(30 < s2 - s1 < 90, f'speed change applies to the running replay (60x: {s2 - s1:.0f} s in ~1 s)')
        # scrubbing the bottom slider moves marker and camera with it
        pg2.evaluate('window.__pf.setPlaying(false)')
        tl = pg2.evaluate('window.__pf.trace.active.timeline.map(e => e.t)')
        mid = int((tl[0] + tl[-1]) / 2)
        pg2.evaluate(f'(() => {{ const s = document.querySelector("#time"); s.value = "{mid}"; s.dispatchEvent(new Event("input")); }})()')
        pg2.wait_for_timeout(150)
        info = pg2.evaluate('window.__pf.view.traceInfo()')
        want = pg2.evaluate('window.__pf.R.positionOf(window.__pf.view.traceInfo().cur.obj, window.__pf.t)')
        check(abs(pg2.evaluate('window.__pf.t') - mid) < 1 and abs(info['markerPos'][0] - want[0]) < 1e-9 and abs(info['cameraTarget'][1] - want[1]) < 1e-9, 'time slider scrub moves marker + camera')
        # replay pauses at the end of the timeline
        pg2.evaluate(f'window.__pf.setTime({tl[-1]} - 2); window.__pf.setPlaying(true)')
        pg2.evaluate('window.__pf.trace.open(window.__pf.trace.active.query)')  # restart run bookkeeping
        pg2.evaluate(f'window.__pf.setTime({tl[-1]} + 1)')
        pg2.wait_for_timeout(1000)
        check(not pg2.evaluate('window.__pf.playing'), 'replay pauses after the last event')
        pg2.screenshot(path=os.path.join(DOCS, 't8-trace.png'))
        # dragging the view frees the camera
        pg2.click('[data-act=follow]'); pg2.wait_for_timeout(100)
        pg2.mouse.move(900, 400); pg2.mouse.down(); pg2.mouse.move(980, 430, steps=6); pg2.mouse.up()
        check(not pg2.evaluate('window.__pf.view.following'), 'dragging the view stops following')
        # unknown id
        pg2.fill('#trace-q', 'LBX-9999'); pg2.press('#trace-q', 'Enter'); pg2.wait_for_timeout(150)
        txt = pg2.inner_text('#pane-trace')
        chips = pg2.evaluate('document.querySelectorAll("#trace-out .chip").length')
        check('No match' in txt and 'Large box' in txt and chips == 3, 'unknown ID: "No match" + 3 IDs of the same kind')
        check(not pg2.evaluate('document.body.innerText.includes("null") || document.body.innerText.includes("undefined")'), 'no "null"/"undefined" on screen (T7/T8)')

        # ---- T9: analysis (S5, S6) ----
        pg2.click('[data-tab=analysis]'); pg2.wait_for_timeout(200)
        pg2.evaluate('window.__pf.setPlaying(false); window.__pf.setTime(30000)')
        pg2.click('[data-act=heat][data-mode=occupancy]'); pg2.wait_for_timeout(200)
        hv = '''(async (t) => {
          const { heatValues } = await import('./src/scenedata.js'); const { occupiedAt } = await import('./src/metrics.js');
          const P = window.__pf, info = P.view.heatInfo();
          const want = heatValues(P.view.slots, info.mode, { occ: occupiedAt(P.R, P.t), freq: P.M.freq });
          let diff = 0; want.bins.forEach((b, i) => { if (b !== info.legend.bins[i]) diff++; });
          return { diff, pal: P.view.scene.getMeshByName('pal-rm').isEnabled(), tiles: P.view.scene.getMeshByName('heat-tiles').isEnabled() };
        })()'''
        r1 = pg2.evaluate(hv)
        pg2.evaluate('window.__pf.setTime(70000)'); pg2.wait_for_timeout(150)
        r2 = pg2.evaluate(hv)
        check(r1['diff'] == 0 and r2['diff'] == 0 and r1['tiles'] and not r1['pal'], 'heat map (occupancy) = slot occupancy at t, follows a scrub; pallets hidden')
        pg2.click('[data-act=heat][data-mode=frequency]'); pg2.wait_for_timeout(150)
        r3 = pg2.evaluate(hv)
        check(r3['diff'] == 0, 'heat map (pick + put) = slot move counts')
        pg2.click('[data-act=heat][data-mode=off]'); pg2.wait_for_timeout(100)
        check(pg2.evaluate('window.__pf.view.scene.getMeshByName("pal-rm").isEnabled() && !window.__pf.view.scene.getMeshByName("heat-tiles").isEnabled()'), 'heat map off restores pallets')
        pg2.locator('.hours .hr[data-h="14"] .hit').click(force=True); pg2.wait_for_timeout(100)
        check(abs(pg2.evaluate('window.__pf.t') - 14 * 3600) < 1e-6, 'workload chart: click an hour jumps there')
        before = pg2.evaluate('JSON.stringify(window.__pf.M.core) + "|" + window.__pf.R.assumptions.volumeLevel + "|" + window.__pf.t')
        pg2.click('#scen-run')
        pg2.wait_for_function('window.__pf.analysis.scenarios && window.__pf.analysis.scenarios.done', timeout=60000)
        sc = pg2.evaluate('window.__pf.analysis.scenarios.rows.map(r => ({ level: r.level, u: r.core.packingUtilization, tp: r.core.dailyThroughput }))')
        after = pg2.evaluate('JSON.stringify(window.__pf.M.core) + "|" + window.__pf.R.assumptions.volumeLevel + "|" + window.__pf.t')
        core0 = pg2.evaluate('window.__pf.M.core')
        check(len(sc) == 5 and abs(sc[0]['u'] - core0['packingUtilization']) < 1e-12 and sc[0]['tp'] == core0['dailyThroughput'], f"volume scenarios: 5 levels, level 0 = the day on screen ({[round(x['u'] * 100, 1) for x in sc]})")
        check(any(x['u'] > 0.85 for x in sc) and 'crosses 85%' in pg2.inner_text('#scen-out'), 'volume scenarios show where packing crosses 85%')
        check(before == after, 'volume scenarios leave the day on screen unchanged')
        pg2.screenshot(path=os.path.join(DOCS, 't9-analysis.png'))
        pg2.close()

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
