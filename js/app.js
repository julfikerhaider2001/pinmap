// PinMap UI: hash router + three views (Boards, Search, Pin Planner).
import { loadBoards, loadParts } from './data.js';
import { renderBoardSvg, esc } from './render.js';
import {
  CAPS, FLAG_INFO, capMode, pinSeverity, isIoPin, search, checkProject, exportHeader, pinFitsKind,
} from './core.js';
import * as store from './storage.js';

const view = document.getElementById('view');
const state = { boards: [], byId: new Map(), failed: [], parts: {}, route: null };

// ------------------------------------------------------------------ boot

init();

async function init() {
  setupTheme();
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
  const [name = 'boards', arg = ''] = path.split('/');
  return { name, arg: decodeURIComponent(arg), params: new URLSearchParams(qs || '') };
}

function setHash(hash, replace = true) {
  if (replace) history.replaceState(null, '', hash); else location.hash = hash;
}

function route() {
  const r = parseHash();
  state.route = r;
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === r.name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (r.name === 'search') renderSearch(r.params.get('q') || '');
  else if (r.name === 'planner') renderPlanner();
  else renderBoards(r.arg, r.params.get('pin'));
}

// ------------------------------------------------------------------ theme

function setupTheme() {
  document.getElementById('theme-btn').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.save('theme', next);
  });
}

function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg, role: 'status' });
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

// ------------------------------------------------------------------ shared bits

const verifiedBadge = (v) => (v ? '<span class="badge badge-ok" title="Checked against the cited official source">verified</span>'
  : '<span class="badge badge-unverified" title="Not fully confirmed against an official source">unverified</span>');

const pinHref = (board, pin) => `#/boards/${encodeURIComponent(board.id)}?pin=${encodeURIComponent(pin.id)}`;

/** Label plus the GPIO/BCM number when the silkscreen label doesn't already show it. */
function pinName(board, p) {
  if (p.gpio === null || board.codeStyle === 'arduino') return p.label;
  const prefix = board.codeStyle === 'bcm' ? 'BCM ' : 'GPIO';
  if (p.label === String(p.gpio)) return `${prefix}${p.gpio}`;
  const shown = new RegExp(`(^|\\D)${p.gpio}(\\D|$)`).test(p.label);
  return shown ? p.label : `${p.label} (${prefix}${p.gpio})`;
}

function groupByFamily(boards) {
  const groups = new Map();
  for (const b of boards) {
    if (!groups.has(b.family)) groups.set(b.family, []);
    groups.get(b.family).push(b);
  }
  return groups;
}

function boardOptions(selectedId) {
  return [...groupByFamily(state.boards)].map(([fam, list]) => `<optgroup label="${esc(fam)}">${
    list.map((b) => `<option value="${esc(b.id)}"${b.id === selectedId ? ' selected' : ''}>${esc(b.name)}</option>`).join('')
  }</optgroup>`).join('');
}

// ------------------------------------------------------------------ Boards view

function renderBoards(boardId, pinId) {
  const fallback = store.load('lastBoard', null);
  const board = state.byId.get(boardId) || state.byId.get(fallback) || state.boards[0];
  if (!board) { view.innerHTML = '<p class="empty">No board data found.</p>'; return; }
  if (board.id !== boardId) setHash(`#/boards/${board.id}`);
  store.save('lastBoard', board.id);
  document.title = `${board.name} pinout · PinMap`;

  const caps = CAPS.map((cap) => {
    const modes = board.pins.map((p) => capMode(board, p, cap));
    const native = modes.filter((m) => m === 'native').length;
    const matrix = modes.filter((m) => m === 'matrix').length;
    return { cap, native, matrix };
  }).filter((c) => c.native || c.matrix);
  const warnCount = board.pins.filter((p) => pinSeverity(p)).length;
  const unvCount = board.pins.filter((p) => !p.verified).length;

  const picker = [...groupByFamily(state.boards)].map(([fam, list]) => `<h3>${esc(fam)}</h3>${
    list.map((b) => `<a href="#/boards/${esc(b.id)}"${b.id === board.id ? ' aria-current="true"' : ''}><span>${esc(b.name)}</span>${b.verified ? '' : '<span class="badge badge-unverified" title="unverified">?</span>'}</a>`).join('')
  }`).join('');

  const failedNote = state.failed.length
    ? `<div class="alert alert-warn small">Could not load: ${state.failed.map((f) => esc(f.id)).join(', ')}</div>` : '';

  view.innerHTML = `
  <div class="boards-layout">
    <aside class="card picker" aria-label="Boards">
      <input class="input" type="search" id="picker-filter" placeholder="Filter boards…" aria-label="Filter boards">
      <nav id="picker-list">${picker}</nav>
      ${failedNote}
    </aside>
    <section>
      <select class="input picker-select" id="picker-select" aria-label="Choose board">${boardOptions(board.id)}</select>
      <div class="board-head">
        <div>
          <h1>${esc(board.name)}</h1>
          <div class="badges">
            <span class="badge">${esc(board.category)}</span>
            <span class="badge">${esc(board.mcu)}</span>
            <span class="badge">${esc(board.logicVoltage)} V logic</span>
            ${(board.wireless || []).map((w) => `<span class="badge">${esc(w)}</span>`).join('')}
            ${verifiedBadge(board.verified)}
            ${board.connectsTo && state.byId.has(board.connectsTo) ? `<a class="badge badge-info" href="#/boards/${esc(board.connectsTo)}">fits ${esc(state.byId.get(board.connectsTo).name)}</a>` : ''}
          </div>
          <p class="muted" style="margin:0">${esc(board.summary)}</p>
        </div>
        <div>
          <a class="btn btn-primary" href="${esc(board.datasheet)}" target="_blank" rel="noopener">Official datasheet ↗</a>
          <details class="sources" style="margin-top:6px">
            <summary>Sources (${board.sources.length})</summary>
            <ul>${board.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${s.rev ? ` <span class="muted">(${esc(s.rev)})</span>` : ''}${s.note ? `<br><span class="muted small">${esc(s.note)}</span>` : ''}</li>`).join('')}</ul>
          </details>
        </div>
      </div>

      <div class="filters" role="group" aria-label="Highlight pins by function">
        ${caps.map((c) => `<button class="chip" type="button" data-filter="${c.cap}" aria-pressed="false">${c.cap} <span class="count">${c.matrix ? 'any' : c.native}</span></button>`).join('')}
        <button class="chip" type="button" data-filter="warn" aria-pressed="false" ${warnCount ? '' : 'disabled'}>⚠ Warnings <span class="count">${warnCount}</span></button>
        <button class="chip" type="button" data-filter="unverified" aria-pressed="false" ${unvCount ? '' : 'disabled'}>Unverified <span class="count">${unvCount}</span></button>
      </div>

      <div class="stage">
        <div class="card svg-wrap" id="svg-wrap">${renderBoardSvg(board)}</div>
        <aside class="card pin-panel" id="pin-panel" aria-live="polite"></aside>
      </div>
      <div class="legend" id="legend">
        <span><i style="background:var(--pad)"></i>I/O</span>
        <span><i style="background:var(--pad-power)"></i>Power</span>
        <span><i style="background:var(--pad-ground)"></i>GND</span>
        <span><i style="background:var(--pad-other)"></i>Other</span>
        <span><i style="background:var(--warn)"></i>Warning</span>
        <span><i style="background:var(--danger)"></i>Do not use</span>
        <span><i style="border:2px dashed var(--warn)"></i>Unverified</span>
        <span id="legend-matrix" hidden><i style="background:var(--hl)"></i>Listed in datasheet <i style="background:var(--hl-soft);border:2px solid var(--hl)"></i>Possible via GPIO matrix</span>
      </div>

      ${board.warnings.length ? `<div class="section card"><h2>Warnings</h2>${board.warnings.map((w) => `<div class="alert alert-${w.level}">${esc(w.text)}${w.pins?.length ? ` <span class="muted small">Pins: ${w.pins.map((pid) => {
        const p = board.pins.find((x) => x.id === pid);
        return p ? `<a href="${pinHref(board, p)}">${esc(p.label)}</a>` : '';
      }).join(', ')}</span>` : ''}</div>`).join('')}</div>` : ''}

      <div class="section card">
        <h2>All pins</h2>
        <div class="table-wrap">
          <table class="pins">
            <thead><tr><th>Pin</th><th class="hide-sm">Header</th><th>${board.codeStyle === 'bcm' ? 'BCM' : 'GPIO'}</th><th>Code</th><th>Functions</th><th>Notes</th></tr></thead>
            <tbody>${board.pins.map((p) => `<tr data-pin="${esc(p.id)}">
              <td class="mono"><b>${esc(p.label)}</b> ${p.verified ? '' : '<span class="badge badge-unverified">?</span>'}</td>
              <td class="hide-sm muted">${esc(p.header)}·${p.pos}</td>
              <td class="mono">${p.gpio ?? '–'}</td>
              <td class="mono">${esc(p.code ?? '–')}</td>
              <td>${p.functions.filter((f) => f.type !== 'GPIO').map((f) => `<span class="fn${f.verified === false ? ' unverified' : ''}">${esc(f.name)}</span>`).join('')}</td>
              <td>${p.flags.filter((f) => FLAG_INFO[f]?.level !== 'info').map((f) => `<span class="badge badge-${FLAG_INFO[f].level}">${esc(f)}</span>`).join(' ')}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </section>
  </div>`;

  const svg = view.querySelector('.board-svg');
  const panel = view.querySelector('#pin-panel');
  let filter = null;

  const select = (id, scroll = false) => {
    const pin = board.pins.find((p) => p.id === id);
    view.querySelectorAll('.pin.selected, tr.selected').forEach((el) => el.classList.remove('selected'));
    if (!pin) { panel.innerHTML = pinPanelEmpty(board); return; }
    view.querySelectorAll(`[data-pin="${CSS.escape(pin.id)}"]`).forEach((el) => el.classList.add('selected'));
    panel.innerHTML = pinPanel(board, pin);
    setHash(`#/boards/${board.id}?pin=${encodeURIComponent(pin.id)}`);
    if (scroll && matchMedia('(max-width: 1100px)').matches) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const applyFilter = () => {
    view.querySelectorAll('.chip[data-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === filter)));
    svg.classList.toggle('filtering', !!filter);
    let showMatrix = false;
    for (const p of board.pins) {
      let mode = null;
      if (filter === 'warn') mode = pinSeverity(p) ? 'native' : null;
      else if (filter === 'unverified') mode = p.verified ? null : 'native';
      else if (filter) mode = capMode(board, p, filter);
      if (mode === 'matrix') showMatrix = true;
      const g = svg.querySelector(`.pin[data-pin="${CSS.escape(p.id)}"]`);
      g.classList.toggle('hl', mode === 'native');
      g.classList.toggle('hl-matrix', mode === 'matrix');
      view.querySelector(`tr[data-pin="${CSS.escape(p.id)}"]`).classList.toggle('dim', !!filter && !mode);
    }
    view.querySelector('#legend-matrix').hidden = !showMatrix;
  };

  view.querySelector('.filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-filter]');
    if (!chip) return;
    filter = filter === chip.dataset.filter ? null : chip.dataset.filter;
    applyFilter();
  });
  const onPick = (e) => {
    const el = e.target.closest('[data-pin]');
    if (el) select(el.dataset.pin, true);
  };
  svg.addEventListener('click', onPick);
  svg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(e); } });
  view.querySelector('table.pins tbody').addEventListener('click', onPick);
  view.querySelector('#picker-select').addEventListener('change', (e) => setHash(`#/boards/${e.target.value}`, false));
  view.querySelector('#picker-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    view.querySelectorAll('#picker-list a').forEach((a) => { a.hidden = q && !a.textContent.toLowerCase().includes(q); });
  });

  select(pinId);
}

function pinPanelEmpty(board) {
  return `<h2 style="font-family:var(--sans)">Pin details</h2>
    <p class="muted">Click or tap a pin on the board (or a row in the table) to see all its functions and warnings.</p>
    <p class="muted small">${board.pins.length} pins · ${board.pins.filter((p) => !p.verified).length} unverified</p>`;
}

function pinPanel(board, p) {
  const byType = new Map();
  for (const f of p.functions) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(f);
  }
  const flags = [...p.flags].sort((a, b) => {
    const rank = { danger: 0, warn: 1, info: 2 };
    return rank[FLAG_INFO[a]?.level] - rank[FLAG_INFO[b]?.level];
  });
  const boardWarnings = board.warnings.filter((w) => w.pins?.includes(p.id));
  return `
    <h2>${esc(p.label)} ${verifiedBadge(p.verified)}</h2>
    <dl>
      ${p.gpio !== null ? `<dt>${board.codeStyle === 'bcm' ? 'BCM GPIO' : board.codeStyle === 'arduino' ? 'Arduino pin' : 'GPIO'}</dt><dd>${p.gpio}</dd>` : ''}
      ${p.code !== null ? `<dt>In code</dt><dd>${esc(p.code)}</dd>` : ''}
      <dt>Position</dt><dd>${esc(p.header)} · pin ${p.pos}</dd>
    </dl>
    ${flags.map((f) => `<div class="alert alert-${FLAG_INFO[f]?.level || 'info'}"><b>${esc(f)}</b>: ${esc(FLAG_INFO[f]?.text || '')}</div>`).join('')}
    ${p.notes ? `<p class="small">${esc(p.notes)}</p>` : ''}
    ${boardWarnings.map((w) => `<div class="alert alert-${w.level} small">${esc(w.text)}</div>`).join('')}
    <h3 style="margin-top:12px">Functions</h3>
    ${byType.size ? [...byType].map(([type, list]) => `<div class="fn-group">${list.map((f) => `<span class="fn${f.verified === false ? ' unverified' : ''}" title="${f.verified === false ? 'unverified' : ''}"><b>${esc(type)}</b>${esc(f.name)}</span>`).join('')}</div>`).join('') : '<p class="muted">None listed.</p>'}
    ${['I2C', 'SPI', 'UART', 'PWM'].filter((c) => capMode(board, p, c) === 'matrix').length
    ? `<p class="small muted">Also routable through the GPIO matrix: ${['I2C', 'SPI', 'UART', 'PWM'].filter((c) => capMode(board, p, c) === 'matrix').join(', ')}.</p>` : ''}`;
}

// ------------------------------------------------------------------ Search view

const EXAMPLES = ['I2C on ESP32-S3', 'touch esp32', 'ADC uno', 'input only esp32', 'strapping', 'SPI mega', 'UART pico', 'PWM nano', 'gpio34', 'DAC'];

function renderSearch(q) {
  document.title = 'Search · PinMap';
  view.innerHTML = `
    <h1>Search pins</h1>
    <p class="muted">Ask in plain words, e.g. “which pins can do I2C on ESP32-S3?”. It looks for functions (I2C, SPI, UART, ADC, PWM, touch, DAC, CAN, I2S…), flags (strapping, input only, flash) and pin names (gpio34, D2, A0) across all boards.</p>
    <form class="search-box" id="search-form" role="search">
      <input class="input" type="search" id="q" value="${esc(q)}" placeholder="which pins can do I2C on ESP32-S3?" aria-label="Search" autocomplete="off">
      <button class="btn btn-primary" type="submit">Search</button>
    </form>
    <div class="examples">${EXAMPLES.map((x) => `<button class="chip" type="button" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <div id="results" aria-live="polite"></div>`;
  const input = view.querySelector('#q');
  const run = () => {
    setHash(`#/search?q=${encodeURIComponent(input.value)}`);
    view.querySelector('#results').innerHTML = searchResults(input.value);
  };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 200); });
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
  if (!asked.length && !parsed.boardTokens.length) return `${html}<p class="empty">Try a function like I2C, SPI, ADC, touch or a pin name like gpio4.</p>`;
  if (!results.length) return `${html}<p class="empty">No matching pins.</p>`;

  const pinLinks = (board, pins, cls = '') => pins.map((p) => {
    const sev = pinSeverity(p);
    return `<a class="pin-link ${cls || sev || ''}" href="${pinHref(board, p)}" title="${esc(p.flags.join(', '))}">${esc(pinName(board, p))}${p.verified ? '' : ' ?'}</a>`;
  }).join('');

  html += `<p class="muted small">${results.length} board${results.length === 1 ? '' : 's'}${asked.length ? ` · looking for ${asked.map(esc).join(' + ')}` : ''}</p>`;
  for (const { board, groups } of results) {
    html += `<div class="card result"><h2><a href="#/boards/${esc(board.id)}">${esc(board.name)}</a> <span class="badge">${esc(board.mcu)}</span> ${verifiedBadge(board.verified)}</h2>`;
    for (const g of groups) {
      if (g.mode === 'board') { html += `<p class="muted small">${esc(board.summary)}</p>`; continue; }
      html += '<div class="group">';
      if (g.mode === 'none') html += `<b>${esc(g.cap)}</b>: <span class="muted">no pins with this function in the data.</span>`;
      else if (g.mode === 'any') {
        html += `<b>${esc(g.cap)}</b>: <span class="muted">can be routed to any output-capable GPIO through the GPIO matrix.</span>`;
        const native = [...g.pins, ...g.avoid].filter((p) => capMode(board, p, g.cap) === 'native');
        if (native.length) html += `<div class="small">Datasheet-listed / default pins: ${pinLinks(board, native)}</div>`;
        html += `<div class="small">Usable pins: ${pinLinks(board, g.pins)}</div>`;
      } else if (g.mode === 'flag') {
        html += `<b>${esc(g.cap)}</b> <span class="muted small">${esc(FLAG_INFO[g.cap]?.text || '')}</span><div>${g.pins.length ? pinLinks(board, g.pins) : '<span class="muted">none</span>'}</div>`;
      } else if (g.mode === 'pin') {
        html += `<b>Pin ${esc(g.cap)}</b><div>${g.pins.length ? pinLinks(board, g.pins) : '<span class="muted">not found on this board</span>'}</div>`;
      } else {
        html += `<b>${esc(g.cap)}</b><div>${pinLinks(board, g.pins)}</div>`;
      }
      if (g.avoid.length) html += `<div class="small" style="margin-top:4px"><span class="muted">Also possible but with warnings:</span> ${pinLinks(board, g.avoid)}</div>`;
      html += '</div>';
    }
    html += '</div>';
  }
  return html;
}

// ------------------------------------------------------------------ Pin Planner

const uid = () => Math.random().toString(36).slice(2, 10);

function loadProjects() {
  const list = store.load('projects', []);
  return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object' && Array.isArray(p.parts)) : [];
}

function newProject(boardId) {
  return { id: uid(), name: 'My project', boardId: boardId || store.load('lastBoard', null) || state.boards[0]?.id, parts: [], updated: Date.now() };
}

/** Cleans an imported project so bad input can't break the UI. */
function sanitizeProject(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.parts)) throw new Error('Not a PinMap project');
  return {
    id: uid(),
    name: String(p.name || 'Imported project').slice(0, 100),
    boardId: String(p.boardId || ''),
    updated: Date.now(),
    parts: p.parts.filter((x) => x && state.parts[x.template]).map((x) => ({
      uid: uid(),
      template: x.template,
      name: String(x.name || state.parts[x.template].name).slice(0, 60),
      level: Number(x.level) || null,
      i2cAddress: x.i2cAddress ? String(x.i2cAddress).slice(0, 8) : undefined,
      pins: Object.fromEntries(Object.entries(x.pins || {}).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')),
    })),
  };
}

const CNC_EXAMPLE = [
  ...['X', 'Y', 'Z', 'A'].map((a) => ({ template: 'stepper-driver', name: `${a} axis` })),
  ...['X', 'Y', 'Z', 'A'].map((a) => ({ template: 'as5600', name: `Encoder ${a}` })),
  ...['X', 'Y', 'Z'].map((a) => ({ template: 'limit-switch', name: `Limit ${a}` })),
  { template: 'probe', name: 'Probe' },
];

function renderPlanner() {
  document.title = 'Pin Planner · PinMap';
  let projects = loadProjects();
  let current = projects.find((p) => p.id === store.load('currentProject', null)) || projects[0];
  if (!current) { current = newProject(); projects = [current]; }

  const persist = () => {
    current.updated = Date.now();
    const i = projects.findIndex((p) => p.id === current.id);
    if (i === -1) projects.push(current); else projects[i] = current;
    store.save('projects', projects);
    store.save('currentProject', current.id);
  };

  const draw = () => {
    const board = state.byId.get(current.boardId) || state.boards[0];
    current.boardId = board.id;
    const issues = checkProject(board, current, state.parts);
    const counts = { error: 0, warn: 0, info: 0 };
    issues.forEach((i) => counts[i.level]++);

    // Per-signal status and per-pin usage for dropdown hints.
    const sigLevel = new Map();
    const rank = { error: 3, warn: 2, info: 1 };
    const bump = (k, level) => { if (!sigLevel.has(k) || rank[level] > rank[sigLevel.get(k)]) sigLevel.set(k, level); };
    for (const i of issues) {
      if (i.partUid && i.signal) { bump(`${i.partUid}|${i.signal}`, i.level); continue; }
      // Pin-level issues (conflicts, I2C clashes) mark every signal assigned to that pin.
      if (!i.pinId) continue;
      for (const part of current.parts) {
        for (const [sig, pinId] of Object.entries(part.pins || {})) if (pinId === i.pinId) bump(`${part.uid}|${sig}`, i.level);
      }
    }
    const usedBy = new Map(); // pinId -> [{ uid, sig, text }]
    for (const part of current.parts) {
      for (const [sig, pinId] of Object.entries(part.pins || {})) {
        if (!pinId) continue;
        if (!usedBy.has(pinId)) usedBy.set(pinId, []);
        usedBy.get(pinId).push({ uid: part.uid, sig, text: `${part.name} ${sig.toUpperCase()}` });
      }
    }
    const ioPins = board.pins.filter(isIoPin);

    const pinSelect = (part, sig) => {
      const chosen = part.pins?.[sig.key] || '';
      const opts = ioPins.map((p) => {
        const fit = pinFitsKind(board, p, sig.kind);
        const sev = pinSeverity(p);
        const mark = !fit.ok || sev === 'danger' ? '✗ ' : sev === 'warn' ? '⚠ ' : '';
        const others = (usedBy.get(p.id) || []).filter((u) => !(u.uid === part.uid && u.sig === sig.key));
        const used = others.length ? ` · used: ${others.map((u) => u.text).join(', ')}` : '';
        return `<option value="${esc(p.id)}"${p.id === chosen ? ' selected' : ''}>${mark}${esc(pinName(board, p))}${used}</option>`;
      }).join('');
      return `<select class="input" data-part="${part.uid}" data-sig="${esc(sig.key)}" aria-label="${esc(`${part.name} ${sig.label}`)}"><option value="">— not assigned —</option>${opts}</select>`;
    };

    const kindHint = { out: 'output', in: 'input', adc: 'analog in', pwm: 'PWM', 'i2c-sda': 'I2C', 'i2c-scl': 'I2C', 'spi-mosi': 'SPI', 'spi-miso': 'SPI', 'spi-sck': 'SPI', 'uart-tx': 'UART', 'uart-rx': 'UART' };
    const statusIcon = (lvl, assigned) => (!assigned ? '<span class="sig-status"></span>'
      : lvl === 'error' ? '<span class="sig-status error" title="error">✗</span>'
        : lvl === 'warn' ? '<span class="sig-status warn" title="warning">⚠</span>'
          : '<span class="sig-status ok" title="ok">✓</span>');

    const partsHtml = current.parts.map((part) => {
      const tpl = state.parts[part.template];
      return `<div class="card part" data-uid="${part.uid}">
        <div class="part-head">
          <input class="input" type="text" value="${esc(part.name)}" data-field="name" aria-label="Part name">
          <span class="badge">${esc(tpl.name)}</span>
          <label class="small muted">Signal level
            <select class="input" data-field="level">
              ${[3.3, 5].map((v) => `<option value="${v}"${(Number(part.level) || board.logicVoltage) === v ? ' selected' : ''}>${v} V</option>`).join('')}
            </select>
          </label>
          ${tpl.i2cAddress || tpl.editableAddress ? `<label class="small muted">I2C addr <input class="input mono" style="width:70px" type="text" data-field="i2cAddress" value="${esc(part.i2cAddress || tpl.i2cAddress || '')}" placeholder="0x.."></label>` : ''}
          <button class="btn btn-sm btn-danger" type="button" data-act="remove" aria-label="Remove ${esc(part.name)}">Remove</button>
        </div>
        ${tpl.signals.map((sig) => `<div class="sig-row">
          <label>${esc(sig.label)}<small>${kindHint[sig.kind] || sig.kind}${sig.optional ? ' · optional' : ''}${sig.shareable ? ' · shareable' : ''}</small></label>
          ${pinSelect(part, sig)}
          ${statusIcon(sigLevel.get(`${part.uid}|${sig.key}`), !!part.pins?.[sig.key])}
        </div>`).join('')}
      </div>`;
    }).join('');

    const header = exportHeader(board, current, state.parts, issues);
    const order = { error: 0, warn: 1, info: 2 };
    // Collapse "not assigned yet" notes into one line so real problems stay visible.
    const unassigned = issues.filter((i) => i.level === 'info' && i.text.endsWith('not assigned yet'));
    const sorted = issues.filter((i) => !unassigned.includes(i)).sort((a, b) => order[a.level] - order[b.level]);
    if (unassigned.length) sorted.push({ level: 'info', text: `${unassigned.length} required signal${unassigned.length > 1 ? 's' : ''} not assigned yet.` });

    view.innerHTML = `
      <h1>Pin Planner</h1>
      <div class="toolbar">
        <select class="input" id="proj-select" aria-label="Project">${projects.map((p) => `<option value="${p.id}"${p.id === current.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <button class="btn" type="button" data-act="new">New</button>
        <button class="btn" type="button" data-act="import">Import JSON</button>
        <button class="btn" type="button" data-act="export-json">Export JSON</button>
        <button class="btn btn-danger" type="button" data-act="delete">Delete</button>
      </div>
      <div class="planner-layout">
        <section>
          <div class="card" style="margin-bottom:12px">
            <div class="row">
              <label>Project <input class="input" type="text" id="proj-name" value="${esc(current.name)}"></label>
              <label>Board <select class="input" id="proj-board">${boardOptions(board.id)}</select></label>
            </div>
            ${board.verified ? '' : '<div class="alert alert-warn small">This board\'s data is not fully verified. Check the pins against your hardware.</div>'}
            <div class="row" style="margin-top:12px">
              <select class="input" id="add-tpl" aria-label="Part type">${Object.values(state.parts).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
              <button class="btn btn-primary" type="button" data-act="add">Add part</button>
              <button class="btn" type="button" data-act="example" title="4 steppers + 4 AS5600 + 3 limit switches + probe">Add CNC example</button>
            </div>
          </div>
          ${partsHtml || '<p class="empty">No parts yet. Add a part above, or start with the CNC example (4 steppers, 4 AS5600 encoders, limit switches and a probe).</p>'}
        </section>
        <aside class="planner-side">
          <div class="card">
            <h2>Checks</h2>
            <div class="issue-summary">
              <span class="badge badge-danger">${counts.error} errors</span>
              <span class="badge badge-warn">${counts.warn} warnings</span>
              <span class="badge badge-info">${counts.info} notes</span>
            </div>
            <div class="issues">${sorted.length ? sorted.map((i) => `<div class="alert alert-${i.level === 'error' ? 'error' : i.level}">${esc(i.text)}</div>`).join('') : '<p class="muted">No issues.</p>'}</div>
          </div>
          <div class="card mini-board">
            <h2>${esc(board.name)}</h2>
            <div class="svg-wrap" id="mini">${renderBoardSvg(board, { title: false })}</div>
          </div>
          <div class="card">
            <h2>C header</h2>
            <textarea class="input" rows="12" readonly id="header-out" aria-label="Generated C header">${esc(header)}</textarea>
            <div class="row" style="margin-top:8px">
              <button class="btn btn-primary" type="button" data-act="download-h">Download .h</button>
              <button class="btn" type="button" data-act="copy-h">Copy</button>
            </div>
          </div>
        </aside>
      </div>`;

    // Colour assigned pins on the mini board.
    const bad = new Set(issues.filter((i) => i.level === 'error' && i.pinId).map((i) => i.pinId));
    for (const pinId of usedBy.keys()) {
      const g = view.querySelector(`#mini .pin[data-pin="${CSS.escape(pinId)}"]`);
      if (g) g.classList.add(bad.has(pinId) ? 'assigned-bad' : 'assigned');
    }
  };

  // One delegated listener set per render of the planner view.
  view.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const board = state.byId.get(current.boardId);
    if (act === 'add') {
      const tpl = state.parts[view.querySelector('#add-tpl').value];
      const n = current.parts.filter((p) => p.template === tpl.id).length + 1;
      current.parts.push({ uid: uid(), template: tpl.id, name: `${tpl.prefix} ${n}`.replace(/_/g, ' '), level: null, pins: {} });
    } else if (act === 'example') {
      CNC_EXAMPLE.forEach((x) => current.parts.push({ uid: uid(), ...x, level: null, pins: {} }));
    } else if (act === 'remove') {
      const id = e.target.closest('[data-uid]').dataset.uid;
      current.parts = current.parts.filter((p) => p.uid !== id);
    } else if (act === 'new') {
      current = newProject(current.boardId);
      projects.push(current);
    } else if (act === 'delete') {
      if (!confirm(`Delete project "${current.name}"?`)) return;
      projects = projects.filter((p) => p.id !== current.id);
      current = projects[0] || newProject();
      store.save('projects', projects);
    } else if (act === 'export-json') {
      store.download(`${current.name.replace(/[^\w-]+/g, '_') || 'project'}.pinmap.json`,
        JSON.stringify({ format: 'pinmap-project', version: 1, project: current }, null, 2));
      return;
    } else if (act === 'import') {
      try {
        const data = await store.pickJson();
        const list = data.format === 'pinmap-projects' ? data.projects : [data.project || data];
        const imported = list.map(sanitizeProject);
        projects.push(...imported);
        current = imported[0];
        if (!state.byId.has(current.boardId)) toast('Imported project uses an unknown board. Switched to the first board.');
        else toast(`Imported ${imported.length} project${imported.length > 1 ? 's' : ''}`);
      } catch (err) {
        toast(`Import failed: ${err.message}`);
        return;
      }
    } else if (act === 'download-h') {
      store.download(`${current.name.replace(/[^\w-]+/g, '_') || 'pins'}_pins.h`, view.querySelector('#header-out').value, 'text/x-c');
      return;
    } else if (act === 'copy-h') {
      try { await navigator.clipboard.writeText(view.querySelector('#header-out').value); toast('Copied'); } catch { view.querySelector('#header-out').select(); toast('Press Ctrl+C to copy'); }
      return;
    }
    if (board) persist();
    draw();
  };

  view.onchange = (e) => {
    const t = e.target;
    if (t.id === 'proj-select') { current = projects.find((p) => p.id === t.value) || current; store.save('currentProject', current.id); draw(); return; }
    if (t.id === 'proj-board') {
      if (current.parts.some((p) => Object.values(p.pins || {}).some(Boolean)) && !confirm('Switching boards clears all pin assignments. Continue?')) { t.value = current.boardId; return; }
      current.boardId = t.value;
      current.parts.forEach((p) => { p.pins = {}; });
    } else if (t.id === 'proj-name') {
      current.name = t.value.slice(0, 100) || 'Untitled';
    } else if (t.dataset.sig) {
      const part = current.parts.find((p) => p.uid === t.dataset.part);
      part.pins = { ...part.pins, [t.dataset.sig]: t.value || undefined };
      if (!t.value) delete part.pins[t.dataset.sig];
    } else if (t.dataset.field) {
      const part = current.parts.find((p) => p.uid === t.closest('[data-uid]').dataset.uid);
      if (t.dataset.field === 'name') part.name = t.value.slice(0, 60) || 'Part';
      if (t.dataset.field === 'level') part.level = Number(t.value);
      if (t.dataset.field === 'i2cAddress') part.i2cAddress = /^0x[0-9a-f]{1,2}$/i.test(t.value.trim()) ? t.value.trim().toLowerCase() : undefined;
    } else return;
    persist();
    draw();
  };

  persist();
  draw();
}

// Remove the planner's delegated handlers when leaving it.
window.addEventListener('hashchange', () => {
  if (parseHash().name !== 'planner') { view.onclick = null; view.onchange = null; }
});
