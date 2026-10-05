// PinMap UI: hash router + views (Home, Board, Search). The Pin Planner lives in planner.js.
import { loadBoards, loadParts } from './data.js';
import { renderBoardSvg } from './render.js';
import { CAPS, FLAG_INFO, capMode, pinSeverity, isIoPin, search } from './core.js';
import { esc, verifiedBadge, pinHref, pinName, groupByFamily, boardOptions, ftag, copyText } from './ui.js';
import { renderPlanner } from './planner.js';
import * as store from './storage.js';

const view = document.getElementById('view');
const state = { boards: [], byId: new Map(), failed: [], parts: {}, cleanup: null };

// ------------------------------------------------------------------ boot

init();

async function init() {
  setupChrome();
  try {
    const [{ boards, failed }, parts] = await Promise.all([loadBoards(), loadParts()]);
    state.boards = boards;
    state.failed = failed;
    state.byId = new Map(boards.map((b) => [b.id, b]));
    state.parts = parts;
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error">Could not load data: ${esc(err.message)}. If you opened index.html straight from disk, run a local web server instead (see README).</div>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [name = '', arg = ''] = path.split('/');
  return { name, arg: decodeURIComponent(arg), params: new URLSearchParams(qs || '') };
}

const setHash = (hash) => history.replaceState(null, '', hash);

function route() {
  const r = parseHash();
  // Tear down handlers owned by the previous view.
  state.cleanup?.();
  state.cleanup = null;
  view.onclick = null;
  view.onchange = null;
  document.querySelectorAll('.tabs a').forEach((a) => {
    const on = a.dataset.tab === r.name || (a.dataset.tab === 'boards' && r.name === 'boards');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (r.name === 'search') renderSearch(r.params.get('q') || '');
  else if (r.name === 'planner') renderPlanner(view, state, r.params.get('board'));
  else if (r.name === 'boards' && r.arg) renderBoard(r.arg, r.params.get('pin'));
  else renderHome();
  if (!r.params.get('pin')) window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ theme + top search

function setupChrome() {
  document.getElementById('theme-btn').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.save('theme', next);
  });
  const form = document.getElementById('top-search');
  const input = document.getElementById('top-q');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/search?q=${encodeURIComponent(input.value)}`;
    input.value = '';
    input.blur();
  });
  // "/" focuses search from anywhere (unless typing in a field).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    const target = document.getElementById('q') || (getComputedStyle(form).display !== 'none' ? input : null);
    if (target) target.focus(); else location.hash = '#/search';
  });
}

// ------------------------------------------------------------------ Home / board gallery

function renderHome() {
  document.title = 'PinMap · Interactive pinout reference';
  const pins = state.boards.reduce((n, b) => n + b.pins.length, 0);
  const verified = state.boards.filter((b) => b.verified).length;
  view.innerHTML = `
    <section class="hero">
      <h1>Find the right pin, fast.</h1>
      <p>Interactive pinouts for ESP32, Arduino, Raspberry Pi and motor driver boards, built from official datasheets. Click any pin to see every function and warning, or plan your project's wiring.</p>
      <form class="hero-search" id="hero-search" role="search">
        <input class="input" type="search" id="hero-q" placeholder="e.g. which pins can do I2C on ESP32-S3?" aria-label="Search pins" autocomplete="off">
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div class="stats">
        <span><b>${state.boards.length}</b> boards &amp; modules</span>
        <span><b>${pins.toLocaleString()}</b> pins</span>
        <span><b>${verified}</b> fully verified against datasheets</span>
      </div>
    </section>
    ${state.failed.length ? `<div class="alert alert-warn small">Could not load: ${state.failed.map((f) => esc(f.id)).join(', ')}</div>` : ''}
    ${[...groupByFamily(state.boards)].map(([fam, list]) => `
      <section class="family">
        <h2>${esc(fam)} <span>${list.length}</span></h2>
        <div class="grid-cards">${list.map(boardCard).join('')}</div>
      </section>`).join('')}`;
  view.querySelector('#hero-search').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/search?q=${encodeURIComponent(view.querySelector('#hero-q').value)}`;
  });
}

function boardCard(b) {
  const io = b.pins.filter(isIoPin).length;
  return `<a class="board-card" href="#/boards/${esc(b.id)}">
    <div class="thumb">${renderBoardSvg(b, { mode: 'none', title: false })}</div>
    <div class="body">
      <div class="name">${esc(b.name)}</div>
      <div class="meta">
        <span class="badge">${esc(b.mcu)}</span>
        <span class="badge">${b.logicVoltage} V</span>
        ${io ? `<span class="badge">${io} I/O</span>` : `<span class="badge">${b.pins.length} pins</span>`}
        ${b.verified ? '<span class="badge badge-ok">✓ verified</span>' : '<span class="badge badge-unverified">? unverified</span>'}
      </div>
    </div>
  </a>`;
}

// ------------------------------------------------------------------ Board view

const FLAG_SHORT = {
  'not-5v-tolerant': '3.3 V max', '5v-tolerant': '5 V tolerant', 'onboard-led': 'On-board LED', 'no-pullup': 'No internal pull-up',
  power: 'Power', ground: 'Ground', nc: 'Not connected',
};
const CODE_STYLE = { arduino: 'Arduino pin numbers', gpio: 'GPIO numbers', bcm: 'BCM GPIO numbers' };

/** Pins in physical order: header order from the layout, then position. */
function orderedPins(board) {
  const hIndex = Object.fromEntries(board.layout.headers.map((h, i) => [h.id, i]));
  return [...board.pins].sort((a, b) => hIndex[a.header] - hIndex[b.header] || a.pos - b.pos);
}

function defaultLabelMode() {
  const saved = store.load('labelMode', null);
  if (saved === 'functions' || saved === 'names') return saved;
  return matchMedia('(max-width: 820px)').matches ? 'names' : 'functions';
}

function renderBoard(boardId, pinId) {
  const board = state.byId.get(boardId);
  if (!board) { setHash('#/boards'); renderHome(); return; }
  document.title = `${board.name} pinout · PinMap`;
  const pins = orderedPins(board);
  const ioPins = pins.filter(isIoPin);

  const caps = CAPS.map((cap) => {
    const modes = board.pins.map((p) => capMode(board, p, cap));
    return { cap, native: modes.filter((m) => m === 'native').length, matrix: modes.filter((m) => m === 'matrix').length };
  }).filter((c) => c.native || c.matrix);
  const warnCount = board.pins.filter((p) => pinSeverity(p)).length;
  const unvCount = board.pins.filter((p) => !p.verified).length;

  const safe = ioPins.filter((p) => !pinSeverity(p));
  const care = ioPins.filter((p) => pinSeverity(p) === 'warn');
  const avoid = board.pins.filter((p) => pinSeverity(p) === 'danger');
  const link = (p) => `<a class="pin-link ${pinSeverity(p) || ''}" href="${pinHref(board, p)}" data-goto="${esc(p.id)}">${esc(pinName(board, p))}</a>`;

  const picker = [...groupByFamily(state.boards)].map(([fam, list]) => `<h3>${esc(fam)}</h3>${
    list.map((b) => `<a href="#/boards/${esc(b.id)}"${b.id === board.id ? ' aria-current="true"' : ''}><span>${esc(b.name)}</span>${b.verified ? '' : '<span class="badge badge-unverified" title="unverified">?</span>'}</a>`).join('')
  }`).join('');

  view.innerHTML = `
  <div class="boards-layout">
    <aside class="card picker" aria-label="Boards">
      <input class="input" type="search" id="picker-filter" placeholder="Filter boards…" aria-label="Filter boards">
      <nav id="picker-list">${picker}</nav>
    </aside>
    <section>
      <select class="input picker-select" id="picker-select" aria-label="Choose board">${boardOptions(state.boards, board.id)}</select>
      <div class="crumbs"><a href="#/boards">Boards</a> / ${esc(board.family)} / ${esc(board.name)}</div>
      <div class="board-head">
        <div>
          <h1>${esc(board.name)}</h1>
          <div class="badges">
            <span class="badge">${esc(board.category)}</span>
            ${verifiedBadge(board.verified)}
            ${board.connectsTo && state.byId.has(board.connectsTo) ? `<a class="badge badge-info" href="#/boards/${esc(board.connectsTo)}">Fits ${esc(state.byId.get(board.connectsTo).name)} ↗</a>` : ''}
          </div>
          <p>${esc(board.summary)}</p>
        </div>
        <div>
          <div class="head-actions">
            <a class="btn btn-primary" href="${esc(board.datasheet)}" target="_blank" rel="noopener">Official datasheet ↗</a>
            ${ioPins.length ? `<a class="btn" href="#/planner?board=${esc(board.id)}">Plan pins</a>` : ''}
          </div>
          <details class="sources">
            <summary>${board.sources.length} source document${board.sources.length > 1 ? 's' : ''}</summary>
            <ul>${board.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${s.rev ? ` <span class="muted">(${esc(s.rev)})</span>` : ''}${s.note ? `<br><span class="muted small">${esc(s.note)}</span>` : ''}</li>`).join('')}</ul>
          </details>
        </div>
      </div>

      <div class="specs">
        <div class="spec"><span>Chip</span><b>${esc(board.mcu)}</b></div>
        <div class="spec"><span>Logic level</span><b>${board.logicVoltage} V</b></div>
        <div class="spec"><span>Wireless</span><b>${board.wireless.length ? board.wireless.map((w) => esc(w.toUpperCase() === 'WIFI' ? 'Wi-Fi' : w.toUpperCase())).join(' · ') : '—'}</b></div>
        <div class="spec"><span>Pins</span><b>${ioPins.length ? `${ioPins.length} I/O · ` : ''}${board.pins.length} total</b></div>
        <div class="spec"><span>In code</span><b>${esc(ioPins.length ? CODE_STYLE[board.codeStyle] : 'No MCU pins')}</b></div>
        <div class="spec"><span>Data</span><b>${unvCount ? `<span style="color:var(--warn)">${unvCount} unverified</span>` : '<span style="color:var(--ok)">All verified</span>'}</b></div>
      </div>

      <div class="stage">
        <div class="card viewer">
          <div class="viewer-bar">
            <div class="filters" role="group" aria-label="Highlight pins by function">
              ${caps.map((c) => `<button class="chip t-${c.cap}" type="button" data-filter="${c.cap}" aria-pressed="false" title="${c.matrix ? `Datasheet lists ${c.native}; any output GPIO via the GPIO matrix` : `${c.native} pins`}"><span class="dot"></span>${c.cap}<span class="count">${c.matrix ? 'any' : c.native}</span></button>`).join('')}
              ${warnCount ? `<button class="chip chip-warn" type="button" data-filter="warn" aria-pressed="false"><span class="dot"></span>Warnings<span class="count">${warnCount}</span></button>` : ''}
              ${unvCount ? `<button class="chip chip-unv" type="button" data-filter="unverified" aria-pressed="false"><span class="dot"></span>Unverified<span class="count">${unvCount}</span></button>` : ''}
            </div>
            <div class="view-tools">
              <div class="seg" role="group" aria-label="Labels">
                <button type="button" data-mode="functions">Functions</button>
                <button type="button" data-mode="names">Names</button>
              </div>
              <div class="seg" role="group" aria-label="Zoom">
                <button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
                <button type="button" data-zoom="fit" title="Fit to width">Fit</button>
                <button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
              </div>
            </div>
          </div>
          <div class="svg-wrap fit" id="svg-wrap"></div>
          <div class="viewer-foot" id="legend">
            <span><i style="background:#dc2626"></i>Power</span>
            <span><i style="background:#111827"></i>Ground</span>
            <span><i style="background:#f59e0b"></i>Warning</span>
            <span><i style="background:#dc2626;border-radius:50%"></i>Do not use</span>
            <span><i style="border:1.5px dashed var(--warn);border-radius:50%"></i>Unverified</span>
            <span id="legend-matrix" hidden><i style="border:2px dashed var(--hl);border-radius:50%"></i>Possible via GPIO matrix</span>
            <span class="muted" style="margin-left:auto">Tip: use ← → to step through pins</span>
          </div>
        </div>
        <aside class="card pin-panel" id="pin-panel" aria-live="polite"></aside>
      </div>

      ${ioPins.length ? `
      <div class="section card">
        <div class="card-head"><h2>Pin guide</h2><span class="muted small">Quick answer to “which pins can I use?”</span></div>
        <div class="guide">
          <div class="guide-col guide-safe"><h3>Safe to use <span>${safe.length}</span></h3><p>No boot, flash or input-only limits.</p>${safe.map(link).join('') || '<span class="muted small">none</span>'}</div>
          <div class="guide-col guide-care"><h3>Use with care <span>${care.length}</span></h3><p>Strapping, input-only, USB/serial or ADC2 limits. Read the pin notes.</p>${care.map(link).join('') || '<span class="muted small">none</span>'}</div>
          <div class="guide-col guide-avoid"><h3>Do not use <span>${avoid.length}</span></h3><p>Wired to flash or reserved on the board.</p>${avoid.map(link).join('') || '<span class="muted small">none</span>'}</div>
        </div>
      </div>` : ''}

      ${board.warnings.length ? `<div class="section card"><h2>Board notes &amp; warnings</h2>${board.warnings
    .sort((a, b) => ['danger', 'warn', 'info'].indexOf(a.level) - ['danger', 'warn', 'info'].indexOf(b.level))
    .map((w) => `<div class="alert alert-${w.level}">${esc(w.text)}${w.pins?.length ? ` <span class="small">Pins: ${w.pins.map((pid) => {
      const p = board.pins.find((x) => x.id === pid);
      return p ? `<a href="${pinHref(board, p)}" data-goto="${esc(p.id)}">${esc(p.label)}</a>` : '';
    }).join(', ')}</span>` : ''}</div>`).join('')}</div>` : ''}

      <div class="section card">
        <div class="card-head">
          <h2>All pins</h2>
          <div class="table-tools"><input class="input" type="search" id="table-filter" placeholder="Filter, e.g. ADC or 34" aria-label="Filter pins"></div>
        </div>
        <div class="table-wrap">
          <table class="pins">
            <thead><tr><th>Pin</th><th class="hide-sm">Where</th><th>${board.codeStyle === 'bcm' ? 'BCM' : board.codeStyle === 'arduino' ? 'Pin #' : 'GPIO'}</th><th>Code</th><th>Functions</th><th>Warnings</th></tr></thead>
            <tbody>${pins.map((p) => `<tr data-pin="${esc(p.id)}">
              <td class="pin-cell">${ftag(p.label, `kind-${pinKindOf(p)}`)} ${p.verified ? '' : '<span class="badge badge-unverified" title="unverified">?</span>'}</td>
              <td class="hide-sm muted">${esc(p.header)} · ${p.pos}</td>
              <td class="mono">${p.gpio ?? '–'}</td>
              <td class="mono">${esc(p.code ?? '–')}</td>
              <td>${p.functions.filter((f) => f.type !== 'GPIO').map((f) => ftag(f.name, `t-${f.type}${f.verified === false ? ' unverified' : ''}`)).join('')}</td>
              <td>${p.flags.filter((f) => FLAG_INFO[f]?.level !== 'info').map((f) => `<span class="badge badge-${FLAG_INFO[f].level}">${esc(f)}</span>`).join(' ')}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </section>
  </div>`;

  const wrap = view.querySelector('#svg-wrap');
  const panel = view.querySelector('#pin-panel');
  let filter = null;
  let mode = defaultLabelMode();
  let zoom = 'fit';
  let selected = null;

  const drawSvg = () => {
    wrap.innerHTML = renderBoardSvg(board, { mode });
    view.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    applyZoom();
    applyFilter();
    if (selected) wrap.querySelector(`.pin[data-pin="${CSS.escape(selected)}"]`)?.classList.add('selected');
  };

  // "Fit" scales the drawing to the viewer width, but never below a readable size (the viewer scrolls instead).
  const applyZoom = () => {
    const svg = wrap.querySelector('svg');
    const w = Number(svg.dataset.w);
    let z = zoom;
    if (zoom === 'fit') {
      const avail = wrap.clientWidth - 24;
      z = Math.max(mode === 'functions' ? 0.85 : 0.65, Math.min(1.3, avail / w));
    }
    svg.style.width = `${Math.round(w * z)}px`;
    wrap.style.justifyContent = w * z > wrap.clientWidth ? 'flex-start' : 'center';
  };

  const applyFilter = () => {
    const svg = wrap.querySelector('svg');
    view.querySelectorAll('.chip[data-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === filter)));
    svg.classList.toggle('filtering', !!filter);
    let showMatrix = false;
    for (const p of board.pins) {
      let m = null;
      if (filter === 'warn') m = pinSeverity(p) ? 'native' : null;
      else if (filter === 'unverified') m = p.verified ? null : 'native';
      else if (filter) m = capMode(board, p, filter);
      if (m === 'matrix') showMatrix = true;
      const g = svg.querySelector(`.pin[data-pin="${CSS.escape(p.id)}"]`);
      g.classList.toggle('hl', m === 'native');
      g.classList.toggle('hl-matrix', m === 'matrix');
      view.querySelector(`tr[data-pin="${CSS.escape(p.id)}"]`).classList.toggle('dim', !!filter && !m);
    }
    view.querySelector('#legend-matrix').hidden = !showMatrix;
  };

  const select = (id, { scroll = false } = {}) => {
    const pin = board.pins.find((p) => p.id === id);
    view.querySelectorAll('.pin.selected, tr.selected').forEach((el) => el.classList.remove('selected'));
    selected = pin ? pin.id : null;
    if (!pin) { panel.innerHTML = pinPanelEmpty(board); return; }
    view.querySelectorAll(`[data-pin="${CSS.escape(pin.id)}"]`).forEach((el) => el.classList.add('selected'));
    panel.innerHTML = pinPanel(board, pin, pins);
    setHash(`#/boards/${board.id}?pin=${encodeURIComponent(pin.id)}`);
    if (scroll && matchMedia('(max-width: 1240px)').matches) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const step = (d) => {
    const i = pins.findIndex((p) => p.id === selected);
    const next = pins[(i + d + pins.length) % pins.length] || pins[0];
    select(next.id);
    wrap.querySelector(`.pin[data-pin="${CSS.escape(next.id)}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  view.querySelector('.filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-filter]');
    if (!chip) return;
    filter = filter === chip.dataset.filter ? null : chip.dataset.filter;
    applyFilter();
  });
  view.querySelector('.view-tools').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) { mode = b.dataset.mode; store.save('labelMode', mode); drawSvg(); }
    if (b.dataset.zoom) {
      const svg = wrap.querySelector('svg');
      const cur = svg.getBoundingClientRect().width / Number(svg.dataset.w);
      zoom = b.dataset.zoom === 'fit' ? 'fit' : Math.min(3, Math.max(0.4, cur * (b.dataset.zoom === 'in' ? 1.25 : 0.8)));
      applyZoom();
    }
  });
  const onPick = (e) => {
    const el = e.target.closest('[data-pin]');
    if (el) select(el.dataset.pin, { scroll: true });
  };
  wrap.addEventListener('click', onPick);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(e); } });
  view.querySelector('table.pins tbody').addEventListener('click', onPick);
  // In-page pin links (guide, warnings) select without a full re-render.
  view.addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    select(a.dataset.goto);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  panel.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) step(Number(nav.dataset.nav));
    const cp = e.target.closest('[data-copy]');
    if (cp) copyText(cp.dataset.copy);
  });
  view.querySelector('#picker-select').addEventListener('change', (e) => { location.hash = `#/boards/${e.target.value}`; });
  view.querySelector('#picker-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    view.querySelectorAll('#picker-list a').forEach((a) => { a.hidden = q && !a.textContent.toLowerCase().includes(q); });
  });
  view.querySelector('#table-filter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    view.querySelectorAll('table.pins tbody tr').forEach((tr) => { tr.hidden = q && !tr.textContent.toLowerCase().includes(q); });
  });
  const onKey = (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); step(e.key === 'ArrowRight' ? 1 : -1); }
    if (e.key === 'Escape') select(null);
  };
  const onResize = () => { if (zoom === 'fit') applyZoom(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  state.cleanup = () => { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };

  drawSvg();
  select(pinId);
  view.querySelector('#picker-list [aria-current]')?.scrollIntoView({ block: 'nearest' });
}

function pinKindOf(p) {
  if (p.flags.includes('power')) return 'power';
  if (p.flags.includes('ground')) return 'ground';
  if (p.flags.includes('nc')) return 'nc';
  if (p.gpio !== null) return 'io';
  if (p.functions.some((f) => f.type === 'CTRL')) return 'ctrl';
  return 'other';
}

function pinPanelEmpty(board) {
  return `<div class="panel-hint">
    <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/><rect x="7" y="7" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
    <h2 style="font-size:1rem">Select a pin</h2>
    <p class="small">Click or tap any pin on the board, or a row in the table, to see all its functions, warnings and how to use it in code.</p>
    <p class="small muted">${board.pins.length} pins · use <kbd>←</kbd> <kbd>→</kbd> to step through them</p>
  </div>`;
}

function pinPanel(board, p, pins) {
  const kind = pinKindOf(p);
  const byType = new Map();
  for (const f of p.functions) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(f);
  }
  const rank = { danger: 0, warn: 1, info: 2 };
  const serious = p.flags.filter((f) => FLAG_INFO[f] && FLAG_INFO[f].level !== 'info').sort((a, b) => rank[FLAG_INFO[a].level] - rank[FLAG_INFO[b].level]);
  const minor = p.flags.filter((f) => FLAG_INFO[f]?.level === 'info' && !['boot-glitch', 'power', 'ground'].includes(f));
  const boardWarnings = board.warnings.filter((w) => w.pins?.includes(p.id));
  const idx = pins.findIndex((x) => x.id === p.id) + 1;
  const numLabel = board.codeStyle === 'bcm' ? 'BCM GPIO' : board.codeStyle === 'arduino' ? 'Arduino pin' : 'GPIO';
  const routable = ['I2C', 'SPI', 'UART', 'PWM'].filter((c) => capMode(board, p, c) === 'matrix');
  const kindText = { io: 'Input / output', power: 'Power', ground: 'Ground', ctrl: 'Control', nc: 'Not connected', other: 'Signal' }[kind];

  return `
    <div class="pin-title">
      <span class="big kind-${kind}">${esc(p.label)}</span>
      <div class="pin-nav">
        <button class="btn btn-sm" type="button" data-nav="-1" aria-label="Previous pin">‹</button>
        <button class="btn btn-sm" type="button" data-nav="1" aria-label="Next pin">›</button>
      </div>
    </div>
    <div class="row" style="gap:6px">
      <span class="badge">${kindText}</span>${verifiedBadge(p.verified)}<span class="muted small">pin ${idx} of ${pins.length}</span>
    </div>
    <dl class="facts">
      ${p.gpio !== null ? `<dt>${numLabel}</dt><dd>${p.gpio}</dd>` : ''}
      ${p.code !== null ? `<dt>In code</dt><dd>${esc(p.code)} <button class="copy" type="button" data-copy="${esc(p.code)}">copy</button></dd>` : ''}
      <dt>Location</dt><dd>${esc(p.header)} · position ${p.pos}</dd>
    </dl>
    ${serious.map((f) => `<div class="alert alert-${FLAG_INFO[f].level}"><b>${esc(f)}</b> · ${esc(FLAG_INFO[f].text)}</div>`).join('')}
    ${p.flags.includes('boot-glitch') ? `<div class="alert alert-info"><b>boot-glitch</b> · ${esc(FLAG_INFO['boot-glitch'].text)}</div>` : ''}
    ${minor.length ? `<div class="row" style="gap:6px;margin:6px 0">${minor.map((f) => `<span class="badge" title="${esc(FLAG_INFO[f].text)}">${esc(FLAG_SHORT[f] || f)}</span>`).join('')}</div>` : ''}
    ${p.notes ? `<p class="small" style="margin:10px 0">${esc(p.notes)}</p>` : ''}
    ${boardWarnings.map((w) => `<div class="alert alert-${w.level} small">${esc(w.text)}</div>`).join('')}
    <h3 style="margin-top:14px">Functions</h3>
    ${byType.size ? [...byType].map(([type, list]) => `<div class="fn-group"><span>${esc(type)}</span><div>${list.map((f) => ftag(f.name, `t-${type}${f.verified === false ? ' unverified' : ''}`, f.verified === false ? 'unverified' : '')).join('')}</div></div>`).join('') : '<p class="muted">None listed.</p>'}
    ${routable.length ? `<p class="small muted" style="margin-top:8px">Also routable here through the GPIO matrix: <b>${routable.join(', ')}</b>.</p>` : ''}`;
}

// ------------------------------------------------------------------ Search view

const EXAMPLES = ['I2C on ESP32-S3', 'touch esp32', 'ADC uno', 'input only esp32', 'strapping', 'SPI mega', 'UART pico', 'PWM nano', 'gpio34', 'DAC'];

function renderSearch(q) {
  document.title = 'Search · PinMap';
  view.innerHTML = `
    <div class="search-head">
      <h1>Search pins</h1>
      <p class="muted" style="margin:0">Ask in plain words, e.g. “which pins can do I2C on ESP32-S3?”. You can search for functions (I2C, SPI, UART, ADC, PWM, touch, DAC, CAN, I2S…), warnings (strapping, input only, flash) and pin names (gpio34, D2, A0), across every board.</p>
      <form class="search-box" id="search-form" role="search">
        <input class="input" type="search" id="q" value="${esc(q)}" placeholder="which pins can do I2C on ESP32-S3?" aria-label="Search" autocomplete="off">
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div class="examples">${EXAMPLES.map((x) => `<button class="chip" type="button" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    </div>
    <div id="results" aria-live="polite"></div>`;
  const input = view.querySelector('#q');
  const run = () => {
    setHash(`#/search?q=${encodeURIComponent(input.value)}`);
    view.querySelector('#results').innerHTML = searchResults(input.value);
  };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 180); });
  view.querySelector('#search-form').addEventListener('submit', (e) => { e.preventDefault(); run(); });
  view.querySelector('.examples').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (b) { input.value = b.dataset.q; run(); }
  });
  if (q) run(); else input.focus();
}

function searchResults(q) {
  if (!q.trim()) return '';
  const { parsed, unknown, results } = search(state.boards, q);
  const asked = [...parsed.caps, ...parsed.flags, ...parsed.pinTokens];
  let html = '';
  if (unknown.length) html += `<div class="alert alert-info small">No board matches “${unknown.map(esc).join('”, “')}”.</div>`;
  if (!asked.length && !parsed.boardTokens.length) return `${html}<p class="empty">Try a function like I2C, SPI, ADC or touch, or a pin name like gpio4.</p>`;
  if (!results.length) return `${html}<p class="empty">No matching pins.</p>`;

  const pinLinks = (board, pins) => pins.map((p) => {
    const sev = pinSeverity(p);
    return `<a class="pin-link ${sev || ''}" href="${pinHref(board, p)}" title="${esc(p.flags.join(', '))}">${esc(pinName(board, p))}${p.verified ? '' : ' ?'}</a>`;
  }).join('');
  const capTag = (cap) => (CAPS.includes(cap) ? ftag(cap, `t-${cap}`) : `<b>${esc(cap)}</b>`);

  html += `<p class="muted small">${results.length} board${results.length === 1 ? '' : 's'}${asked.length ? ` · looking for ${asked.map(esc).join(' + ')}` : ''}</p>`;
  for (const { board, groups } of results) {
    html += `<div class="card result"><h2><a href="#/boards/${esc(board.id)}">${esc(board.name)}</a> <span class="badge">${esc(board.mcu)}</span> ${verifiedBadge(board.verified)}</h2>`;
    for (const g of groups) {
      if (g.mode === 'board') { html += `<p class="muted small" style="margin:0">${esc(board.summary)}</p>`; continue; }
      html += '<div class="group">';
      if (g.mode === 'none') html += `<div class="group-title">${capTag(g.cap)} <span class="muted">No pins with this function in the data.</span></div>`;
      else if (g.mode === 'any') {
        html += `<div class="group-title">${capTag(g.cap)} <span class="muted">Can be routed to any output-capable GPIO through the GPIO matrix.</span></div>`;
        const native = [...g.pins, ...g.avoid].filter((p) => capMode(board, p, g.cap) === 'native');
        if (native.length) html += `<div class="small"><span class="muted">Listed in the datasheet:</span> ${pinLinks(board, native)}</div>`;
        html += `<div class="small"><span class="muted">Good choices:</span> ${pinLinks(board, g.pins)}</div>`;
      } else if (g.mode === 'flag') {
        html += `<div class="group-title"><b>${esc(g.cap)}</b> <span class="muted small">${esc(FLAG_INFO[g.cap]?.text || '')}</span></div><div>${g.pins.length ? pinLinks(board, g.pins) : '<span class="muted">none</span>'}</div>`;
      } else if (g.mode === 'pin') {
        html += `<div class="group-title"><b>Pin ${esc(g.cap)}</b></div><div>${g.pins.length ? pinLinks(board, g.pins) : '<span class="muted">not found on this board</span>'}</div>`;
      } else {
        html += `<div class="group-title">${capTag(g.cap)}</div><div>${pinLinks(board, g.pins)}</div>`;
      }
      if (g.avoid.length) html += `<div class="small" style="margin-top:6px"><span class="muted">Possible, but check the warnings:</span> ${pinLinks(board, g.avoid)}</div>`;
      html += '</div>';
    }
    html += '</div>';
  }
  return html;
}
