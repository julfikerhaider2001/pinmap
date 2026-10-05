// Pin Planner view: assign project parts to pins, see conflicts, export a C header.
import { renderBoardSvg } from './render.js';
import { checkProject, exportHeader, isIoPin, pinFitsKind, pinSeverity } from './core.js';
import { esc, pinName, boardOptions, toast, copyText } from './ui.js';
import * as store from './storage.js';

const uid = () => Math.random().toString(36).slice(2, 10);

const CNC_EXAMPLE = [
  ...['X', 'Y', 'Z', 'A'].map((a) => ({ template: 'stepper-driver', name: `${a} axis` })),
  ...['X', 'Y', 'Z', 'A'].map((a) => ({ template: 'as5600', name: `Encoder ${a}` })),
  ...['X', 'Y', 'Z'].map((a) => ({ template: 'limit-switch', name: `Limit ${a}` })),
  { template: 'probe', name: 'Probe' },
];

const KIND_HINT = { out: 'output', in: 'input', adc: 'analog in', pwm: 'PWM out', 'i2c-sda': 'I2C', 'i2c-scl': 'I2C', 'spi-mosi': 'SPI', 'spi-miso': 'SPI', 'spi-sck': 'SPI', 'uart-tx': 'UART', 'uart-rx': 'UART' };

function loadProjects() {
  const list = store.load('projects', []);
  return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object' && Array.isArray(p.parts)) : [];
}

/** Cleans an imported project so bad input can't break the UI. */
function sanitizeProject(p, templates) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.parts)) throw new Error('Not a PinMap project');
  return {
    id: uid(),
    name: String(p.name || 'Imported project').slice(0, 100),
    boardId: String(p.boardId || ''),
    updated: Date.now(),
    parts: p.parts.filter((x) => x && templates[x.template]).map((x) => ({
      uid: uid(),
      template: x.template,
      name: String(x.name || templates[x.template].name).slice(0, 60),
      level: Number(x.level) || null,
      i2cAddress: x.i2cAddress ? String(x.i2cAddress).slice(0, 8) : undefined,
      pins: Object.fromEntries(Object.entries(x.pins || {}).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')),
    })),
  };
}

/** Renders the planner into `view`. `wantBoard` (optional) opens the planner for that board. */
export function renderPlanner(view, state, wantBoard) {
  document.title = 'Pin Planner · PinMap';
  const newProject = (boardId) => ({ id: uid(), name: 'My project', boardId: boardId || state.boards[0]?.id, parts: [], updated: Date.now() });
  let projects = loadProjects();
  let current = projects.find((p) => p.id === store.load('currentProject', null)) || projects[0];
  if (!current) { current = newProject(wantBoard); projects = [current]; }
  if (wantBoard && state.byId.has(wantBoard) && current.boardId !== wantBoard) {
    if (current.parts.length) { current = newProject(wantBoard); current.name = `${state.byId.get(wantBoard).name} project`; projects.push(current); } else current.boardId = wantBoard;
  }

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

    // Per-signal status (pin-level issues such as conflicts mark every signal on that pin).
    const sigLevel = new Map();
    const rank = { error: 3, warn: 2, info: 1 };
    const bump = (k, level) => { if (!sigLevel.has(k) || rank[level] > rank[sigLevel.get(k)]) sigLevel.set(k, level); };
    for (const i of issues) {
      if (i.partUid && i.signal) { bump(`${i.partUid}|${i.signal}`, i.level); continue; }
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
      const good = [], care = [], bad = [];
      for (const p of ioPins) {
        const fit = pinFitsKind(board, p, sig.kind);
        const sev = pinSeverity(p);
        const others = (usedBy.get(p.id) || []).filter((u) => !(u.uid === part.uid && u.sig === sig.key));
        const used = others.length ? ` — used by ${others.map((u) => u.text).join(', ')}` : '';
        const opt = (mark) => `<option value="${esc(p.id)}"${p.id === chosen ? ' selected' : ''}>${mark}${esc(pinName(board, p))}${used}</option>`;
        if (!fit.ok || sev === 'danger') bad.push(opt('✗ ')); else if (sev === 'warn' || others.length) care.push(opt('⚠ ')); else good.push(opt(''));
      }
      return `<select class="input" data-part="${part.uid}" data-sig="${esc(sig.key)}" aria-label="${esc(`${part.name} ${sig.label}`)}">
        <option value="">— not assigned —</option>
        ${good.length ? `<optgroup label="Good fit">${good.join('')}</optgroup>` : ''}
        ${care.length ? `<optgroup label="Possible, with warnings">${care.join('')}</optgroup>` : ''}
        ${bad.length ? `<optgroup label="Not suitable">${bad.join('')}</optgroup>` : ''}
      </select>`;
    };

    const statusIcon = (lvl, assigned) => (!assigned ? '<span class="sig-status"></span>'
      : lvl === 'error' ? '<span class="sig-status error" title="Error">✗</span>'
        : lvl === 'warn' ? '<span class="sig-status warn" title="Warning">!</span>'
          : '<span class="sig-status ok" title="OK">✓</span>');

    const partsHtml = current.parts.map((part) => {
      const tpl = state.parts[part.template];
      return `<div class="card part" data-uid="${part.uid}">
        <div class="part-head">
          <input class="input" type="text" value="${esc(part.name)}" data-field="name" aria-label="Part name">
          <span class="badge">${esc(tpl.name)}</span>
          <select class="input" data-field="level" aria-label="Signal level" title="Signal voltage of this part">
            ${[3.3, 5].map((v) => `<option value="${v}"${(Number(part.level) || board.logicVoltage) === v ? ' selected' : ''}>${v} V signals</option>`).join('')}
          </select>
          ${tpl.i2cAddress || tpl.editableAddress ? `<input class="input mono" style="width:78px" type="text" data-field="i2cAddress" value="${esc(part.i2cAddress || tpl.i2cAddress || '')}" placeholder="0x.." aria-label="I2C address" title="I2C address">` : ''}
          <button class="btn btn-sm btn-ghost btn-danger" type="button" data-act="remove" aria-label="Remove ${esc(part.name)}">Remove</button>
        </div>
        ${tpl.signals.map((sig) => `<div class="sig-row">
          <label>${esc(sig.label)}<small>${KIND_HINT[sig.kind] || sig.kind}${sig.optional ? ' · optional' : ''}${sig.shareable ? ' · shareable' : ''}</small></label>
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
      <div class="card-head" style="margin-bottom:6px">
        <div><h1 style="margin:0">Pin Planner</h1><p class="muted" style="margin:2px 0 0">Assign your project's parts to pins. PinMap flags conflicts and bad pins, then writes the <code>#define</code>s for you.</p></div>
      </div>
      <div class="toolbar">
        <select class="input" id="proj-select" aria-label="Project">${projects.map((p) => `<option value="${p.id}"${p.id === current.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <button class="btn" type="button" data-act="new">+ New</button>
        <button class="btn" type="button" data-act="import">Import JSON</button>
        <button class="btn" type="button" data-act="export-json">Export JSON</button>
        <button class="btn btn-ghost btn-danger" type="button" data-act="delete">Delete</button>
      </div>
      <div class="planner-layout">
        <section>
          <div class="card" style="margin-bottom:14px">
            <div class="row">
              <label class="field" style="flex:1;min-width:180px">Project name <input class="input" type="text" id="proj-name" value="${esc(current.name)}"></label>
              <label class="field" style="flex:1;min-width:220px">Board <select class="input" id="proj-board">${boardOptions(state.boards, board.id)}</select></label>
            </div>
            ${board.verified ? '' : '<div class="alert alert-warn small">This board\'s data is not fully verified. Check the pins against your hardware.</div>'}
            <div class="row" style="margin-top:14px">
              <select class="input" id="add-tpl" aria-label="Part type" style="flex:1;min-width:200px">${Object.values(state.parts).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
              <button class="btn btn-primary" type="button" data-act="add">Add part</button>
              <button class="btn" type="button" data-act="example" title="4 steppers + 4 AS5600 + 3 limit switches + probe">Add CNC example</button>
            </div>
          </div>
          ${partsHtml || '<div class="card empty" style="text-align:center">No parts yet. Add a part above, or start with the <b>CNC example</b> (4 steppers, 4 AS5600 encoders, 3 limit switches and a probe).</div>'}
        </section>
        <aside class="planner-side">
          <div class="card">
            <div class="card-head" style="margin-bottom:8px"><h2>Checks</h2>
              <div class="issue-summary" style="margin:0">
                <span class="badge badge-danger">${counts.error} errors</span>
                <span class="badge badge-warn">${counts.warn} warnings</span>
              </div>
            </div>
            <div class="issues">${sorted.length ? sorted.map((i) => `<div class="alert alert-${i.level === 'error' ? 'error' : i.level}">${esc(i.text)}</div>`).join('') : '<p class="muted">No issues.</p>'}</div>
          </div>
          <div class="card mini-board">
            <div class="card-head" style="margin-bottom:8px"><h2>${esc(board.name)}</h2><a class="btn btn-sm" href="#/boards/${esc(board.id)}">Pinout ↗</a></div>
            <div class="svg-wrap" id="mini">${renderBoardSvg(board, { mode: 'names', title: false })}</div>
          </div>
          <div class="card">
            <div class="card-head" style="margin-bottom:8px"><h2>C header</h2>
              <div class="row"><button class="btn btn-sm" type="button" data-act="copy-h">Copy</button><button class="btn btn-sm btn-primary" type="button" data-act="download-h">Download .h</button></div>
            </div>
            <textarea class="input" rows="12" readonly id="header-out" aria-label="Generated C header" spellcheck="false">${esc(header)}</textarea>
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

  view.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
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
        const imported = list.map((p) => sanitizeProject(p, state.parts));
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
      copyText(view.querySelector('#header-out').value);
      return;
    }
    persist();
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
