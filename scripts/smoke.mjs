// Headless browser smoke test (production build + mock Ollama). Screenshots -> shots/.
// Usage: npm run build && npm run smoke   (CHROME_PATH overrides the browser binary)
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startMockOllama } from './mock-ollama.mjs';

const SHOTS = new URL('../shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const chromePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function startServer(port, env) {
  const proc = spawn(process.execPath, ['server.ts'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', LLM_FALLBACK_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return { proc, logs: () => out };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`server failed to start: ${out}`);
}

async function waitDone(page, timeout = 20000) {
  await page.waitForFunction(
    () => !!document.querySelector('form button[type=submit]') && !!document.querySelector('[data-testid=source]'),
    null,
    { timeout },
  );
}

async function sampleFps(page, ms) {
  return page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const ts = [];
        const t0 = performance.now();
        const f = (t) => {
          ts.push(t);
          if (t - t0 < dur) requestAnimationFrame(f);
          else {
            const d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
            resolve(Math.round(1000 / d[Math.floor(d.length / 2)]));
          }
        };
        requestAnimationFrame(f);
      }),
    ms,
  );
}

function watch(page, origin, label) {
  const bad = [];
  const errors = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) bad.push(u);
  });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(f)) errors.push(`requestfailed ${r.url()} ${f}`);
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { bad, errors, label };
}

const mock = await startMockOllama(0);
const PORT = Number(process.env.SMOKE_PORT || 3901);
const srv = await startServer(PORT, { LLM_BASE_URL: `http://127.0.0.1:${mock.port}`, LLM_MODEL: 'gemma3:12b' });
const origin = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});

try {
  // ---------- Desktop ----------
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await dctx.newPage();
  const dw = watch(page, origin, 'desktop');
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__particleStats && window.__particleStats.fps > 0, null, { timeout: 15000 });
  await page.waitForFunction(() => /Local LLM/.test(document.querySelector('[data-testid=llm-status]')?.textContent ?? ''), null, { timeout: 8000 });
  check('desktop: status pill shows local LLM + model', true, await page.textContent('[data-testid=llm-status]'));
  await page.screenshot({ path: `${SHOTS}desktop-initial.png` });

  await page.waitForTimeout(5000); // let auto-quality settle
  const idleFps = await sampleFps(page, 5000);
  const stats1 = await page.evaluate(() => window.__particleStats);
  check('desktop: idle frame rate sampled', idleFps > 0, `median ${idleFps} fps, ${stats1.count} particles (auto quality)`);

  // prompt -> LLM -> params
  await page.fill('#prompt', 'galaxy spiral in neon pink');
  await page.press('#prompt', 'Enter');
  await page.waitForSelector('text=Cancel', { timeout: 3000 }).catch(() => {});
  const sawStreaming = await page
    .waitForFunction(() => /galaxy|neon|spiral/i.test(document.querySelector('[data-testid=reply]')?.textContent ?? '') && !!document.querySelector('button:has(+ *), button') , null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForSelector('[data-testid=source]', { timeout: 15000 });
  const src = await page.textContent('[data-testid=source]');
  const replyText = await page.textContent('[data-testid=reply]');
  check('desktop: keyboard submit -> streamed reply from local LLM', /local llm/i.test(src) && /galaxy/i.test(replyText) && sawStreaming, replyText.trim());
  const shape = await page.$eval('select', (s) => s.value);
  check('desktop: LLM params applied (shape select = galaxy)', shape === 'galaxy', shape);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${SHOTS}desktop-galaxy.png` });

  // mouse interactions
  await page.mouse.move(720, 450);
  await page.mouse.down();
  for (let i = 0; i < 25; i++) await page.mouse.move(720 + Math.cos(i / 3) * 200, 450 + Math.sin(i / 3) * 150, { steps: 2 });
  const dragFps = await sampleFps(page, 1500);
  await page.mouse.up();
  await page.mouse.wheel(0, -400);
  await page.click('role=radio[name="Repel"]');
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(800, 500, { steps: 10 });
  await page.screenshot({ path: `${SHOTS}desktop-interaction.png` });
  await page.mouse.up();
  check('desktop: drag/wheel/mode switch without errors', dw.errors.length === 0, `fps during drag ${dragFps}`);

  // cancel
  await page.fill('#prompt', 'beating heart');
  await page.press('#prompt', 'Enter');
  await page.waitForSelector('button:text("Cancel")', { timeout: 3000 });
  await page.click('button:text("Cancel")');
  await page.waitForTimeout(200);
  check('desktop: cancel mid-stream', /Cancelled/.test(await page.textContent('[data-testid=reply]')));

  // empty prompt
  await page.fill('#prompt', '   ');
  await page.press('#prompt', 'Enter');
  check('desktop: empty prompt handled', /Type something/.test(await page.textContent('[data-testid=reply]')));

  // 4k prompt
  await page.fill('#prompt', 'heart '.repeat(700).slice(0, 4000));
  await page.press('#prompt', 'Enter');
  await waitDone(page);
  const notice4k = (await page.textContent('[data-testid=notice]').catch(() => '')) ?? '';
  check('desktop: 4000-char prompt handled', /shortened/.test(notice4k), notice4k);

  // fast repeated sends
  for (let i = 0; i < 6; i++) {
    await page.fill('#prompt', i % 2 ? 'heart' : 'galaxy');
    await page.press('#prompt', 'Enter');
    await page.waitForTimeout(60);
  }
  await waitDone(page);
  check('desktop: rapid repeated sends settle cleanly', /galaxy|heart/i.test(await page.textContent('[data-testid=reply]')));

  // XSS attempt typed by a user is shown as text only
  const xssBefore = await page.evaluate(() => document.querySelectorAll('img,script').length);
  await page.fill('#prompt', '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
  await page.press('#prompt', 'Enter');
  await waitDone(page);
  const xss = await page.evaluate(() => window.__xss);
  check('desktop: no HTML injection', xss === undefined && (await page.evaluate(() => document.querySelectorAll('img,script').length)) === xssBefore);

  const overflowD = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check('desktop: no horizontal overflow', !overflowD);
  check('desktop: all requests same-origin (no Google/cloud hosts)', dw.bad.length === 0, dw.bad.slice(0, 3).join(', '));
  check('desktop: no console errors / failed requests', dw.errors.length === 0, dw.errors.slice(0, 3).join(' | '));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(400);
  check('desktop: resize keeps rendering', (await page.evaluate(() => window.__particleStats.fps)) > 0);
  await dctx.close();

  // ---------- Mobile ----------
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const m = await mctx.newPage();
  const mw = watch(m, origin, 'mobile');
  await m.goto(origin, { waitUntil: 'networkidle' });
  await m.waitForFunction(() => window.__particleStats && window.__particleStats.fps > 0, null, { timeout: 15000 });
  const mStats = await m.evaluate(() => window.__particleStats);
  check('mobile: adaptive particle budget', mStats.targetCount <= 60000, `${mStats.count}/${mStats.targetCount}`);
  await m.waitForTimeout(800);
  await m.screenshot({ path: `${SHOTS}mobile-initial.png` });
  const cdp = await mctx.newCDPSession(m);
  // perf under 4x CPU throttle (informational; headless uses software GL)
  await m.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false });
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await m.waitForTimeout(4000);
  const thrFps = await sampleFps(m, 5000);
  await m.fill('#prompt', 'beating red heart');
  await m.tap('button[type=submit]');
  await waitDone(m);
  const longTasks = await m.evaluate(() => window.__longTasks);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const thrStats = await m.evaluate(() => window.__particleStats);
  check('mobile: 4x CPU throttle fps (info)', thrFps > 0, `median ${thrFps} fps at ${thrStats.count} particles; long tasks while streaming: ${JSON.stringify(longTasks)}`);
  check('mobile: no long task > 200 ms while streaming (4x throttle)', longTasks.every((d) => d <= 200), `max ${Math.max(0, ...longTasks)} ms`);
  await m.tap('text=Heart');
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch('touchStart', [[195, 420]]);
  for (let i = 0; i < 12; i++) await touch('touchMove', [[195 + i * 8, 420 - i * 6]]);
  await touch('touchEnd', []);
  await touch('touchStart', [[150, 420], [240, 420]]);
  for (let i = 0; i < 8; i++) await touch('touchMove', [[150 - i * 6, 420], [240 + i * 6, 420]]);
  await touch('touchEnd', []);
  await m.waitForTimeout(1500);
  await m.screenshot({ path: `${SHOTS}mobile-heart.png` });
  await m.fill('#prompt', 'galaxy spiral in neon pink');
  await m.tap('button[type=submit]');
  await m.waitForSelector('[data-testid=source]', { timeout: 15000 });
  await m.waitForTimeout(1200);
  await m.screenshot({ path: `${SHOTS}mobile-galaxy.png` });
  await m.tap('button[aria-controls=controls-panel]');
  await m.waitForTimeout(300);
  await m.screenshot({ path: `${SHOTS}mobile-controls.png` });
  const overflowM = await m.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth);
  check('mobile: no horizontal overflow', !overflowM);
  const blocked = await m.evaluate(() => {
    const els = [...document.querySelectorAll('button, input, select')].filter((e) => e.getBoundingClientRect().width > 0);
    const visible = (e) => {
      // skip controls scrolled out of their own scroll container (e.g. preset chip row)
      const r = e.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      for (let p = e.parentElement; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(st.overflowX + st.overflowY) && p !== document.body && p.id !== 'root' && p.parentElement !== document.getElementById('root')) {
          const pr = p.getBoundingClientRect();
          if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) return false;
        }
      }
      return cx >= 0 && cx < innerWidth && cy >= 0 && cy < innerHeight;
    };
    return els.filter(visible).filter((e) => {
      const r = e.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit && hit.tagName === 'CANVAS';
    }).map((e) => e.textContent || e.id || e.tagName);
  });
  check('mobile: controls not covered by canvas', blocked.length === 0, `${blocked.length} covered ${blocked.join(',')}`);
  const unlabeled = await m.evaluate(() =>
    [...document.querySelectorAll('input, select')].filter((e) => !(e.labels && e.labels.length) && !e.getAttribute('aria-label')).length,
  );
  check('a11y: all inputs labelled', unlabeled === 0, `${unlabeled} unlabeled`);
  await m.setViewportSize({ width: 844, height: 390 });
  await m.waitForTimeout(400);
  await m.screenshot({ path: `${SHOTS}mobile-landscape.png` });
  check('mobile: rotate keeps rendering, no overflow', !(await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  check('mobile: all requests same-origin', mw.bad.length === 0, mw.bad.slice(0, 3).join(', '));
  check('mobile: no console errors / failed requests', mw.errors.length === 0, mw.errors.slice(0, 3).join(' | '));
  await mctx.close();

  // ---------- Reduced motion ----------
  const rctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const r = await rctx.newPage();
  await r.goto(origin, { waitUntil: 'networkidle' });
  const rm = await r.isChecked('text=Reduced motion >> xpath=.. >> input');
  check('a11y: prefers-reduced-motion respected', rm);
  await rctx.close();

  // ---------- LLM unreachable ----------
  srv.proc.kill();
  const down = await startServer(PORT, { LLM_BASE_URL: 'http://127.0.0.1:9' });
  const octx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const o = await octx.newPage();
  const ow = watch(o, origin, 'offline');
  await o.goto(origin, { waitUntil: 'networkidle' });
  await o.fill('#prompt', 'golden tornado');
  await o.press('#prompt', 'Enter');
  await o.waitForSelector('[data-testid=source]', { timeout: 15000 });
  const notice = await o.textContent('[data-testid=notice]');
  const pageText = await o.textContent('body');
  check('offline: clear notice, offline parser used', /unreachable/.test(notice) && /offline/i.test(await o.textContent('[data-testid=source]')), notice);
  check('offline: no URL/stack leaked to the page', !/127\.0\.0\.1:9|11434|ECONN|at \S+\.ts/.test(pageText));
  await o.waitForTimeout(1200);
  await o.screenshot({ path: `${SHOTS}desktop-offline.png` });
  check('offline: all requests same-origin', ow.bad.length === 0);
  await octx.close();
  down.proc.kill();

  const chatCalls = mock.log.filter((l) => l.url === '/api/chat');
  check('mock Ollama: only /api/tags and /api/chat were called', mock.log.every((l) => l.url === '/api/tags' || l.url === '/api/chat'));
  check('mock Ollama: no keep_alive sent, model gemma3:12b', chatCalls.length > 0 && chatCalls.every((c) => !('keep_alive' in c.body) && c.body.model === 'gemma3:12b' && c.body.think === false), `${chatCalls.length} chat calls, think:false on all`);
} catch (err) {
  check('smoke run completed', false, String(err?.stack || err));
} finally {
  await browser.close();
  srv.proc.kill();
  mock.server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
