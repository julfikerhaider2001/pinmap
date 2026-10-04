// Draws a board as an SVG string from its JSON `layout` (see data/SCHEMA.md).
// Highlighting and selection are added later by toggling classes on the pin groups.
import { pinSeverity } from './core.js';

const S = 20;               // px per layout unit (0.1 inch)
const CHAR_W = 6.7;         // approx. width of one 11px monospace character
const DIR = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Layout-unit position of a pin's centre. */
export function pinXY(header, pos) {
  const [dx, dy] = DIR[header.dir];
  const step = (pos - 1) * (header.pitch || 1);
  return [header.x + dx * step, header.y + dy * step];
}

function pinKind(p) {
  if (p.flags.includes('power')) return 'power';
  if (p.flags.includes('ground')) return 'ground';
  if (p.flags.includes('nc')) return 'nc';
  if (p.gpio !== null) return 'io';
  return 'other';
}

export function renderBoardSvg(board, { title = true } = {}) {
  const L = board.layout;
  const headers = Object.fromEntries(L.headers.map((h) => [h.id, h]));

  // Margins: leave room for the longest label on each side that has labels.
  const pad = { left: 14, right: 14, top: 14, bottom: 14 };
  for (const p of board.pins) {
    const h = headers[p.header];
    const need = String(p.label).length * CHAR_W + 22;
    const [ux, uy] = pinXY(h, p.pos);
    const side = h.labelSide;
    // Distance the label sticks out beyond the board edge on that side.
    const overhang = side === 'left' ? need - ux * S
      : side === 'right' ? need - (L.width - ux) * S
        : side === 'top' ? need - uy * S
          : need - (L.height - uy) * S;
    pad[side] = Math.max(pad[side], Math.ceil(overhang) + 6);
  }
  const W = L.width * S + pad.left + pad.right;
  const H = L.height * S + pad.top + pad.bottom;
  const X = (u) => +(u * S + pad.left).toFixed(1);
  const Y = (u) => +(u * S + pad.top).toFixed(1);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" class="board-svg" viewBox="0 0 ${W} ${H}" style="max-width:${Math.round(W * 1.7)}px" role="group" aria-label="${esc(board.name)} pinout">`);
  if (title) out.push(`<title>${esc(board.name)}</title>`);
  out.push(`<rect class="pcb pcb-${esc(board.category)}" x="${X(0)}" y="${Y(0)}" width="${L.width * S}" height="${L.height * S}" rx="${S * 0.6}"/>`);

  for (const f of L.features || []) {
    if (f.type === 'label') {
      out.push(`<text class="feat-label" x="${X(f.x)}" y="${Y(f.y)}" text-anchor="middle">${esc(f.label)}</text>`);
      continue;
    }
    const w = (f.w || 2) * S, h = (f.h || 2) * S;
    out.push(`<g class="feat feat-${esc(f.type)}"><rect x="${X(f.x)}" y="${Y(f.y)}" width="${w}" height="${h}" rx="${f.type === 'button' || f.type === 'led' ? 3 : 2}"/>`);
    if (f.label) {
      const size = Math.max(7, Math.min(11, (w / Math.max(4, f.label.length)) * 1.5));
      out.push(`<text x="${X(f.x) + w / 2}" y="${Y(f.y) + h / 2}" text-anchor="middle" dominant-baseline="central" font-size="${size.toFixed(1)}">${esc(f.label)}</text>`);
    }
    out.push('</g>');
  }

  // Header strips
  for (const h of L.headers) {
    const [x1, y1] = pinXY(h, 1);
    const [x2, y2] = pinXY(h, h.count);
    const half = 0.45;
    const x = Math.min(x1, x2) - half, y = Math.min(y1, y2) - half;
    out.push(`<rect class="header-strip" x="${X(x)}" y="${Y(y)}" width="${(Math.abs(x2 - x1) + 2 * half) * S}" height="${(Math.abs(y2 - y1) + 2 * half) * S}" rx="2"/>`);
  }

  // Pins
  const r = S * 0.3;
  for (const p of board.pins) {
    const h = headers[p.header];
    const [ux, uy] = pinXY(h, p.pos);
    const cx = X(ux), cy = Y(uy);
    const sev = pinSeverity(p);
    const cls = ['pin', `kind-${pinKind(p)}`, sev ? `sev-${sev}` : '', p.verified ? '' : 'unverified'].filter(Boolean).join(' ');
    const gap = S * 0.6;
    let tx = cx, ty = cy, anchor = 'start', rot = '';
    if (h.labelSide === 'left') { tx = cx - gap; anchor = 'end'; }
    else if (h.labelSide === 'right') { tx = cx + gap; }
    else if (h.labelSide === 'top') { ty = cy - gap; rot = ` transform="rotate(-90 ${tx} ${ty})"`; }
    else { ty = cy + gap; anchor = 'end'; rot = ` transform="rotate(-90 ${tx} ${ty})"`; }

    // Invisible hit box covering pin + label so taps are easy on phones.
    const len = String(p.label).length * CHAR_W + gap + r;
    let hb;
    if (h.labelSide === 'left') hb = [cx - len, cy - S / 2, len + r, S];
    else if (h.labelSide === 'right') hb = [cx - r, cy - S / 2, len + r, S];
    else if (h.labelSide === 'top') hb = [cx - S / 2, cy - len, S, len + r];
    else hb = [cx - S / 2, cy - r, S, len + r];

    const aria = `${p.label}${sev ? `, ${sev === 'danger' ? 'do not use' : 'warning'}` : ''}`;
    out.push(`<g class="${cls}" data-pin="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(aria)}">`);
    out.push(`<rect class="hit" x="${hb[0].toFixed(1)}" y="${hb[1].toFixed(1)}" width="${hb[2].toFixed(1)}" height="${hb[3].toFixed(1)}"/>`);
    out.push(p.pos === 1
      ? `<rect class="pad" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" rx="1.5"/>`
      : `<circle class="pad" cx="${cx}" cy="${cy}" r="${r}"/>`);
    if (sev) out.push(`<circle class="mark" cx="${cx + r * 0.85}" cy="${cy - r * 0.85}" r="${S * 0.15}"/>`);
    out.push(`<text class="pin-label" x="${tx}" y="${ty}" text-anchor="${anchor}" dominant-baseline="central"${rot}>${esc(p.label)}</text>`);
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('');
}
