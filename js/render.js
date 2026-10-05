// Draws a board as an SVG string from its JSON `layout` (see data/SCHEMA.md).
// Each pin gets a row of colour-coded tags (name, warnings, main functions), like a printed pinout card.
// Highlighting and selection are added later by toggling classes on the pin groups.
import { pinSeverity } from './core.js';

const S = 20;               // px per layout unit (0.1 inch)
const TAG_H = 15;           // tag height in px
const TAG_CHAR = 6.15;      // approx. width of one 10px monospace character
const TAG_PAD = 4;          // horizontal padding inside a tag
const TAG_GAP = 2;          // space between tags
const GAP = S * 0.62;       // distance from pin centre to first tag
const DIR = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] };
const MAX_FN_TAGS = 3;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Layout-unit position of a pin's centre. */
export function pinXY(header, pos) {
  const [dx, dy] = DIR[header.dir];
  const step = (pos - 1) * (header.pitch || 1);
  return [header.x + dx * step, header.y + dy * step];
}

export function pinKind(p) {
  if (p.flags.includes('power')) return 'power';
  if (p.flags.includes('ground')) return 'ground';
  if (p.flags.includes('nc')) return 'nc';
  if (p.gpio !== null) return 'io';
  if (p.functions.some((f) => f.type === 'CTRL')) return 'ctrl';
  return 'other';
}

// Function types shown as tags, most useful first. GPIO/POWER/GND/OTHER are covered by the name tag.
const TAG_ORDER = ['ADC', 'DAC', 'TOUCH', 'I2C', 'SPI', 'UART', 'USB', 'CAN', 'I2S', 'PWM', 'MOTOR', 'CONFIG', 'CTRL',
  'INT', 'RTC', 'JTAG', 'SDIO', 'CLOCK', 'TIMER', 'ANALOG_CMP', 'LED'];
const ROLE = /^(MOSI|MISO|SCK|SCLK|CS|SS|COPI|CIPO|SDA|SCL|TX|RX)$/i;
const FLAG_TAGS = { flash: ['FLASH', 'danger'], reserved: ['RESERVED', 'danger'], strapping: ['STRAP', 'warn'], 'input-only': ['IN ONLY', 'warn'], psram: ['PSRAM', 'warn'] };

/** Short tag text for a function name: drops "(ALT0)" / "[Pi 4B only]" notes but keeps bus roles like MISO. */
export function shortName(name) {
  let base = name.replace(/\[[^\]]*\]/g, '').replace(/CHANNEL/g, 'CH');
  const roles = [...base.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim()).filter((r) => ROLE.test(r));
  base = base.replace(/\s*\([^)]*\)/g, '').trim() || name.trim();
  let text = roles.length ? `${base} ${roles[0]}` : base;
  if (text.length > 13) text = roles.length ? roles[0] : base;
  return text.length > 13 ? `${text.slice(0, 12)}…` : text;
}

/** Tags drawn next to a pin: [{ text, cls }]. mode: 'functions' | 'names'. */
export function pinTags(board, p, mode = 'functions') {
  const tags = [{ text: p.label, cls: `tag-name kind-${pinKind(p)}` }];
  for (const f of p.flags) if (FLAG_TAGS[f]) tags.push({ text: FLAG_TAGS[f][0], cls: `tag-flag flag-${FLAG_TAGS[f][1]}` });
  if (mode !== 'functions') return tags;

  if (p.gpio !== null) {
    const gpioFn = p.functions.find((f) => f.type === 'GPIO');
    if (board.codeStyle === 'arduino' && gpioFn) tags.push({ text: shortName(gpioFn.name), cls: 'tag-fn t-GPIO' });
    else if (board.codeStyle === 'gpio' && !new RegExp(`(^|\\D)${p.gpio}(\\D|$)`).test(p.label)) tags.push({ text: `GPIO${p.gpio}`, cls: 'tag-fn t-GPIO' });
  }
  const fns = p.functions
    // PCINTn exists on almost every AVR pin, so it is left to the pin panel.
    .filter((f) => TAG_ORDER.includes(f.type) && !(f.type === 'PWM' && board.routing?.PWM === 'any') && !/^PCINT/.test(f.name))
    .sort((a, b) => (TAG_ORDER.indexOf(a.type) - TAG_ORDER.indexOf(b.type)) || (a.name.includes('[') - b.name.includes('[')));
  const seen = new Set();
  const picked = [];
  for (const f of fns) {
    const text = shortName(f.name);
    if (seen.has(text) || text === p.label) continue;
    seen.add(text);
    picked.push({ text, cls: `tag-fn t-${f.type}${f.verified === false ? ' tag-unverified' : ''}` });
  }
  tags.push(...picked.slice(0, MAX_FN_TAGS));
  if (picked.length > MAX_FN_TAGS) tags.push({ text: `+${picked.length - MAX_FN_TAGS}`, cls: 'tag-more' });
  return tags;
}

const tagWidth = (t) => t.text.length * TAG_CHAR + TAG_PAD * 2;
const tagsLength = (tags) => tags.reduce((s, t) => s + tagWidth(t) + TAG_GAP, 0);

let uidCounter = 0;

/**
 * opts.mode: 'functions' (default) | 'names' | 'none' (thumbnail: no labels, not interactive)
 * opts.title: include <title>
 */
export function renderBoardSvg(board, { mode = 'functions', title = true } = {}) {
  const L = board.layout;
  const headers = Object.fromEntries(L.headers.map((h) => [h.id, h]));
  const uid = `b${++uidCounter}`;
  const labelled = mode !== 'none';

  // Tags per pin, and margins so the longest tag row on each side fits.
  const tagsByPin = new Map();
  const pad = { left: 10, right: 10, top: 10, bottom: 10 };
  for (const p of board.pins) {
    if (!labelled) break;
    const h = headers[p.header];
    const tags = pinTags(board, p, mode);
    tagsByPin.set(p.id, tags);
    const need = GAP + tagsLength(tags) + 4;
    const [ux, uy] = pinXY(h, p.pos);
    const side = h.labelSide;
    const room = side === 'left' ? ux * S : side === 'right' ? (L.width - ux) * S : side === 'top' ? uy * S : (L.height - uy) * S;
    pad[side] = Math.max(pad[side], Math.ceil(need - room) + 8);
  }
  const W = Math.ceil(L.width * S + pad.left + pad.right);
  const H = Math.ceil(L.height * S + pad.top + pad.bottom);
  const X = (u) => +(u * S + pad.left).toFixed(1);
  const Y = (u) => +(u * S + pad.top).toFixed(1);
  const color = L.color || { board: '#1f5f5b', shield: '#1e4f7a', module: '#5b3b8a' }[board.category] || '#1f5f5b';

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" class="board-svg mode-${mode}" viewBox="0 0 ${W} ${H}" data-w="${W}" data-h="${H}" role="${labelled ? 'group' : 'img'}" aria-label="${esc(board.name)} pinout">`);
  if (title) out.push(`<title>${esc(board.name)}</title>`);
  out.push(`<defs>
    <linearGradient id="${uid}-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbe7a1"/><stop offset=".5" stop-color="#d4a63a"/><stop offset="1" stop-color="#9c7419"/></linearGradient>
    <linearGradient id="${uid}-metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef1f4"/><stop offset=".45" stop-color="#b9c0c8"/><stop offset="1" stop-color="#8b939c"/></linearGradient>
    <linearGradient id="${uid}-pcb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></linearGradient>
  </defs>`);

  // PCB with a soft sheen and a thin silkscreen border.
  const bw = L.width * S, bh = L.height * S;
  out.push(`<rect class="pcb" x="${X(0)}" y="${Y(0)}" width="${bw}" height="${bh}" rx="${S * 0.5}" fill="${esc(color)}"/>`);
  out.push(`<rect x="${X(0)}" y="${Y(0)}" width="${bw}" height="${bh}" rx="${S * 0.5}" fill="url(#${uid}-pcb)"/>`);
  if (bw > 60 && bh > 60) out.push(`<rect class="silk-border" x="${X(0) + 4}" y="${Y(0) + 4}" width="${bw - 8}" height="${bh - 8}" rx="${S * 0.35}"/>`);

  for (const f of L.features || []) out.push(drawFeature(f, X, Y, uid));

  // Header plastic
  for (const h of L.headers) {
    const [x1, y1] = pinXY(h, 1);
    const [x2, y2] = pinXY(h, h.count);
    const half = 0.47;
    const x = Math.min(x1, x2) - half, y = Math.min(y1, y2) - half;
    out.push(`<rect class="header-strip" x="${X(x)}" y="${Y(y)}" width="${((Math.abs(x2 - x1) + 2 * half) * S).toFixed(1)}" height="${((Math.abs(y2 - y1) + 2 * half) * S).toFixed(1)}" rx="2"/>`);
  }

  // Pins: drawn in a local frame where tags run along +x ("right") or -x ("left"),
  // then rotated -90° for headers labelled on the top or bottom edge.
  const r = S * 0.29;
  for (const p of board.pins) {
    const h = headers[p.header];
    const [ux, uy] = pinXY(h, p.pos);
    const cx = X(ux), cy = Y(uy);
    const sev = pinSeverity(p);
    const side = h.labelSide;
    const dirSign = side === 'right' || side === 'top' ? 1 : -1;
    const rot = side === 'top' || side === 'bottom' ? ` transform="rotate(-90 ${cx} ${cy})"` : '';
    const cls = ['pin', `kind-${pinKind(p)}`, sev ? `sev-${sev}` : '', p.verified ? '' : 'unverified'].filter(Boolean).join(' ');

    if (!labelled) {
      out.push(`<g class="${cls}">${p.pos === 1 ? `<rect class="pad" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" rx="1.5" fill="url(#${uid}-gold)"/>` : `<circle class="pad" cx="${cx}" cy="${cy}" r="${r}" fill="url(#${uid}-gold)"/>`}</g>`);
      continue;
    }

    const tags = tagsByPin.get(p.id);
    const len = GAP + tagsLength(tags);
    const tip = [p.label, ...p.functions.filter((f) => f.type !== 'GPIO').slice(0, 6).map((f) => f.name)].join(' · ');
    out.push(`<g class="${cls}" data-pin="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(`${p.label}${sev ? `, ${sev === 'danger' ? 'do not use' : 'warning'}` : ''}`)}">`);
    out.push(`<title>${esc(tip)}</title><g${rot}>`);
    const hx = dirSign > 0 ? cx - r - 2 : cx - len - 2;
    out.push(`<rect class="hit" x="${hx.toFixed(1)}" y="${cy - S / 2}" width="${(len + r + 4).toFixed(1)}" height="${S}"/>`);
    // leader line from pad to first tag
    out.push(`<line class="leader" x1="${cx + dirSign * r}" y1="${cy}" x2="${(cx + dirSign * GAP).toFixed(1)}" y2="${cy}"/>`);
    let cur = cx + dirSign * GAP;
    for (const t of tags) {
      const w = tagWidth(t);
      const tx = dirSign > 0 ? cur : cur - w;
      out.push(`<g class="tag ${t.cls}"><rect x="${tx.toFixed(1)}" y="${cy - TAG_H / 2}" width="${w.toFixed(1)}" height="${TAG_H}" rx="3"/><text x="${(tx + w / 2).toFixed(1)}" y="${cy + 0.5}" text-anchor="middle" dominant-baseline="central">${esc(t.text)}</text></g>`);
      cur += dirSign * (w + TAG_GAP);
    }
    out.push(p.pos === 1
      ? `<rect class="pad" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" rx="1.5" fill="url(#${uid}-gold)"/>`
      : `<circle class="pad" cx="${cx}" cy="${cy}" r="${r}" fill="url(#${uid}-gold)"/>`);
    out.push(`<circle class="hole" cx="${cx}" cy="${cy}" r="${(r * 0.42).toFixed(1)}"/>`);
    if (!p.verified) out.push(`<circle class="unv-ring" cx="${cx}" cy="${cy}" r="${(r + 3).toFixed(1)}"/>`);
    if (sev) out.push(`<circle class="mark" cx="${(cx + r * 0.9).toFixed(1)}" cy="${(cy - r * 0.9).toFixed(1)}" r="${(S * 0.16).toFixed(1)}"/>`);
    out.push('</g></g>');
  }
  out.push('</svg>');
  return out.join('');
}

const MODULE_RX = /WROOM|WROVER|MINI-1|module|ESP-12|ESP-01/i;

function drawFeature(f, X, Y, uid) {
  if (f.type === 'label') {
    return `<text class="silk" x="${X(f.x)}" y="${Y(f.y)}" text-anchor="middle" dominant-baseline="central">${esc(f.label)}</text>`;
  }
  const x = X(f.x), y = Y(f.y), w = (f.w || 2) * S, h = (f.h || 2) * S;
  const label = f.label ? esc(f.label) : '';
  const fs = (max) => Math.max(6.5, Math.min(max, (w / Math.max(4, (f.label || '').length)) * 1.55)).toFixed(1);
  const o = [`<g class="feat feat-${esc(f.type)}">`];

  if (f.type === 'chip' && MODULE_RX.test(f.label || '')) {
    // RF module: small PCB with antenna trace at the top and a metal shield can.
    const ant = Math.min(h * 0.24, S * 3.2);
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" class="module-pcb"/>`);
    const zz = [];
    const steps = Math.max(3, Math.floor(w / 9));
    for (let i = 0; i <= steps; i++) {
      const px = x + 5 + (i * (w - 10)) / steps;
      zz.push(`${i ? 'L' : 'M'}${px.toFixed(1)} ${(y + (i % 2 ? ant - 5 : 5)).toFixed(1)}`);
    }
    o.push(`<path class="antenna" d="${zz.join(' ')}"/>`);
    o.push(`<rect x="${x + 3}" y="${y + ant}" width="${w - 6}" height="${h - ant - 3}" rx="2" fill="url(#${uid}-metal)" class="shield"/>`);
    o.push(`<text class="shield-text" x="${x + w / 2}" y="${y + ant + (h - ant) / 2}" text-anchor="middle" dominant-baseline="central" font-size="${fs(10)}">${label}</text>`);
  } else if (f.type === 'chip') {
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" class="ic"/>`);
    if (w >= 30 && h >= 30) {
      const n = Math.floor(w / 7), m = Math.floor(h / 7);
      for (let i = 1; i < n; i++) o.push(`<rect class="ic-leg" x="${(x + (i * w) / n - 1.2).toFixed(1)}" y="${y - 3}" width="2.4" height="3"/><rect class="ic-leg" x="${(x + (i * w) / n - 1.2).toFixed(1)}" y="${y + h}" width="2.4" height="3"/>`);
      for (let i = 1; i < m; i++) o.push(`<rect class="ic-leg" x="${x - 3}" y="${(y + (i * h) / m - 1.2).toFixed(1)}" width="3" height="2.4"/><rect class="ic-leg" x="${x + w}" y="${(y + (i * h) / m - 1.2).toFixed(1)}" width="3" height="2.4"/>`);
      o.push(`<circle class="ic-dot" cx="${x + 6}" cy="${y + 6}" r="2"/>`);
    }
    o.push(`<text class="ic-text" x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="central" font-size="${fs(11)}">${label}</text>`);
  } else if (f.type === 'usb') {
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="url(#${uid}-metal)" class="metal"/>`);
    o.push(`<rect x="${x + w * 0.18}" y="${y + h * 0.3}" width="${w * 0.64}" height="${h * 0.4}" rx="2" class="usb-slot"/>`);
    if (label) o.push(`<text class="silk small" x="${x + w / 2}" y="${y - 5}" text-anchor="middle">${label}</text>`);
  } else if (f.type === 'jack') {
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" class="jack"/>`);
    o.push(`<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) * 0.22}" class="jack-hole"/>`);
    if (label) o.push(`<text class="silk small" x="${x + w / 2}" y="${y - 5}" text-anchor="middle">${label}</text>`);
  } else if (f.type === 'button') {
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" class="btn-base"/>`);
    o.push(`<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) * 0.3}" class="btn-cap"/>`);
    if (label) o.push(`<text class="silk small" x="${x + w / 2}" y="${y + h + 9}" text-anchor="middle">${label}</text>`);
  } else if (f.type === 'led') {
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" class="led"/>`);
    if (label) o.push(`<text class="silk small" x="${x + w + 3}" y="${y + h / 2}" dominant-baseline="central">${label}</text>`);
  } else if (f.type === 'terminal') {
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" class="terminal"/>`);
    const vertical = h >= w;
    const n = Math.max(1, Math.round((vertical ? h : w) / (S * 2)));
    for (let i = 0; i < n; i++) {
      const sx = vertical ? x + w / 2 : x + ((i + 0.5) * w) / n;
      const sy = vertical ? y + ((i + 0.5) * h) / n : y + h / 2;
      const rr = Math.min(S * 0.55, (vertical ? w : h) * 0.3);
      o.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${rr.toFixed(1)}" fill="url(#${uid}-metal)" class="screw"/><line class="screw-slot" x1="${(sx - rr * 0.6).toFixed(1)}" y1="${sy.toFixed(1)}" x2="${(sx + rr * 0.6).toFixed(1)}" y2="${sy.toFixed(1)}"/>`);
    }
    if (label) o.push(`<text class="silk small" x="${x + w / 2}" y="${y - 5}" text-anchor="middle">${label}</text>`);
  } else {
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" class="ic"/>`);
    if (label) o.push(`<text class="ic-text" x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="central" font-size="${fs(10)}">${label}</text>`);
  }
  o.push('</g>');
  return o.join('');
}
