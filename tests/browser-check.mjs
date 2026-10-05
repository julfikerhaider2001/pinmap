// Loads every page in headless Edge/Chrome, reports console errors and exceptions, and saves screenshots.
// Usage: node tests/browser-check.mjs [outDir]    (set BROWSER=path\to\chrome.exe to override)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || join(tmpdir(), 'pinmap-shots');
mkdirSync(outDir, { recursive: true });
const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) { console.error('No Chrome/Edge found; set BROWSER'); process.exit(2); }

const PORT = 8765, DBG = 9333;
const server = await start(PORT);
const browser = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${DBG}`, '--no-first-run', '--disable-gpu',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'pinmap-prof-'))}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
if (!wsUrl) { console.error('Could not connect to browser'); browser.kill(); server.close(); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
    problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'warning') {
    problems.push(`console.warn: ${msg.params.args.map((a) => JSON.stringify(a.value ?? a.description)).join(' ')}`);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

const boards = JSON.parse(readFileSync(join(root, 'data/boards/index.json'), 'utf8')).boards;
const pages = [
  { name: 'home', hash: '#/' },
  ...boards.map((id) => ({ name: `board-${id}`, hash: `#/boards/${id}` })),
  { name: 'search', hash: '#/search?q=which%20pins%20can%20do%20I2C%20on%20ESP32-S3%3F' },
  {
    name: 'planner', hash: '#/planner', setup: 'localStorage.clear()',
    // Add the CNC example, then put X STEP and Y STEP on the same pin: the planner must report a conflict.
    after: `document.querySelector('[data-act=example]').click();
      const pick = (i, v) => { const s = document.querySelectorAll('select[data-sig]')[i]; s.value = v; s.dispatchEvent(new Event('change', {bubbles: true})); };
      const v = document.querySelectorAll('select[data-sig]')[0].options[5].value;
      pick(0, v); pick(3, v);
      if (!/Conflict on/.test(document.querySelector('.issues').textContent)) console.error('planner did not report conflict');
      if (!/#define X_AXIS_STEP_PIN/.test(document.querySelector('#header-out').value)) console.error('header export missing define');`,
  },
];
const viewports = process.env.MOBILE ? [{ w: 390, h: 844, m: true, tag: 'mobile' }] : [{ w: 1400, h: 1000, m: false, tag: 'desktop' }];

let first = true;
for (const vp of viewports) {
  await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.m });
  for (const theme of process.env.DARK ? ['dark'] : ['light']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const pg of pages) {
      const before = problems.length;
      if (first) { await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` }); await sleep(800); first = false; }
      if (pg.setup) await evaluate(pg.setup);
      await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html${pg.hash}` });
      await sleep(900);
      await evaluate(`location.hash = ${JSON.stringify(pg.hash)}; new Promise(r => setTimeout(r, 300))`);
      if (pg.after) { await evaluate(pg.after); await sleep(300); }
      // Click the first pin to exercise the details panel.
      if (pg.name.startsWith('board-')) await evaluate("document.querySelector('.pin')?.dispatchEvent(new MouseEvent('click', {bubbles:true}))");
      const info = await evaluate("JSON.stringify({h1: document.querySelector('h1')?.textContent, pins: document.querySelectorAll('.board-svg .pin').length, err: document.querySelector('.alert-error:not(.issues .alert-error)')?.textContent || null, overflow: document.documentElement.scrollWidth > innerWidth})");
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(outDir, `${vp.tag}-${theme}-${pg.name}.png`), Buffer.from(shot.result.data, 'base64'));
      const fresh = problems.slice(before);
      console.log(`${fresh.length ? 'FAIL' : 'ok  '} ${vp.tag}/${theme} ${pg.name} ${info}`);
      fresh.forEach((p) => console.log(`     ${p}`));
    }
  }
}
ws.close();
browser.kill();
server.close();
console.log(`screenshots: ${outDir}`);
process.exitCode = problems.length ? 1 : 0;
