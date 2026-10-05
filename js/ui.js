// Small UI helpers shared by the views.
import { esc } from './render.js';

export { esc };

export const verifiedBadge = (v) => (v
  ? '<span class="badge badge-ok" title="Checked against the cited official source">✓ verified</span>'
  : '<span class="badge badge-unverified" title="Not fully confirmed against an official source">? unverified</span>');

export const pinHref = (board, pin) => `#/boards/${encodeURIComponent(board.id)}?pin=${encodeURIComponent(pin.id)}`;

/** Label plus the GPIO/BCM number when the silkscreen label doesn't already show it. */
export function pinName(board, p) {
  if (p.gpio === null || board.codeStyle === 'arduino') return p.label;
  const prefix = board.codeStyle === 'bcm' ? 'BCM ' : 'GPIO';
  if (p.label === String(p.gpio)) return `${prefix}${p.gpio}`;
  const shown = new RegExp(`(^|\\D)${p.gpio}(\\D|$)`).test(p.label);
  return shown ? p.label : `${p.label} (${prefix}${p.gpio})`;
}

export function groupByFamily(boards) {
  const groups = new Map();
  for (const b of boards) {
    if (!groups.has(b.family)) groups.set(b.family, []);
    groups.get(b.family).push(b);
  }
  return groups;
}

export function boardOptions(boards, selectedId) {
  return [...groupByFamily(boards)].map(([fam, list]) => `<optgroup label="${esc(fam)}">${
    list.map((b) => `<option value="${esc(b.id)}"${b.id === selectedId ? ' selected' : ''}>${esc(b.name)}</option>`).join('')
  }</optgroup>`).join('');
}

/** Coloured function tag. `type` is a function type (ADC, I2C, …) or a pin kind class. */
export const ftag = (text, cls, title = '') => `<span class="ftag ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

export function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg, role: 'status' });
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${text.length > 30 ? 'to clipboard' : `“${text}”`}`);
  } catch {
    toast('Copy not available here');
  }
}
