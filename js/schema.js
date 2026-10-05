// Board data schema checks. Shared by the browser app and the Node tests.
// The human-readable spec is in data/SCHEMA.md. Keep the two in sync.

export const FUNCTION_TYPES = [
  'GPIO', 'ADC', 'DAC', 'PWM', 'I2C', 'SPI', 'UART', 'TOUCH', 'RTC', 'USB', 'CAN',
  'I2S', 'JTAG', 'INT', 'TIMER', 'SDIO', 'ANALOG_CMP', 'LED', 'POWER', 'GND',
  'CTRL', 'CLOCK', 'MOTOR', 'CONFIG', 'OTHER',
];

export const FLAGS = [
  'strapping', 'input-only', 'flash', 'psram', 'reserved', 'boot-glitch',
  '5v-tolerant', 'not-5v-tolerant', 'adc2-wifi', 'usb', 'console-uart',
  'onboard-led', 'no-pullup', 'power', 'ground', 'nc',
];

const CATEGORIES = ['board', 'shield', 'module'];
const CODE_STYLES = ['arduino', 'gpio', 'bcm'];
const DIRS = ['down', 'up', 'right', 'left'];
const SIDES = ['left', 'right', 'top', 'bottom'];
const LEVELS = ['info', 'warn', 'danger'];
const ROUTING_KEYS = ['I2C', 'SPI', 'UART', 'PWM'];

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Returns a list of error strings; empty means valid. */
export function validateBoard(b, fileId) {
  const e = [];
  const req = (cond, msg) => { if (!cond) e.push(msg); };

  req(b && typeof b === 'object', 'board must be an object');
  if (!b || typeof b !== 'object') return e;

  req(isStr(b.id), 'id missing');
  if (fileId) req(b.id === fileId, `id "${b.id}" does not match file name "${fileId}"`);
  req(isStr(b.name), 'name missing');
  req(CATEGORIES.includes(b.category), `category must be one of ${CATEGORIES}`);
  req(isStr(b.family), 'family missing');
  req(isStr(b.mcu), 'mcu missing');
  req(Array.isArray(b.aliases), 'aliases must be an array');
  req(isNum(b.logicVoltage), 'logicVoltage must be a number');
  req(Array.isArray(b.wireless), 'wireless must be an array');
  req(CODE_STYLES.includes(b.codeStyle), `codeStyle must be one of ${CODE_STYLES}`);
  req(isStr(b.datasheet), 'datasheet url missing');
  req(typeof b.verified === 'boolean', 'verified must be boolean');
  req(isStr(b.summary), 'summary missing');

  if (b.routing && typeof b.routing === 'object') {
    for (const k of ROUTING_KEYS) {
      req(['any', 'fixed'].includes(b.routing[k]), `routing.${k} must be "any" or "fixed"`);
    }
  } else e.push('routing missing');

  if (Array.isArray(b.sources) && b.sources.length) {
    b.sources.forEach((s, i) => {
      req(isStr(s.title), `sources[${i}].title missing`);
      req(isStr(s.url) && /^https?:\/\//.test(s.url), `sources[${i}].url must be http(s)`);
    });
  } else e.push('sources must list at least one document');

  if (b.category === 'shield') req(isStr(b.connectsTo), 'shield needs connectsTo');

  // Layout
  const headerIds = new Set();
  const L = b.layout;
  if (L && typeof L === 'object') {
    req(isNum(L.width) && L.width > 0, 'layout.width must be > 0');
    req(isNum(L.height) && L.height > 0, 'layout.height must be > 0');
    req(Array.isArray(L.headers) && L.headers.length > 0, 'layout.headers must be non-empty');
    (L.headers || []).forEach((h, i) => {
      req(isStr(h.id), `headers[${i}].id missing`);
      req(!headerIds.has(h.id), `duplicate header id ${h.id}`);
      headerIds.add(h.id);
      req(isNum(h.x) && isNum(h.y), `header ${h.id}: x/y must be numbers`);
      req(DIRS.includes(h.dir), `header ${h.id}: dir must be one of ${DIRS}`);
      req(Number.isInteger(h.count) && h.count > 0, `header ${h.id}: count must be a positive integer`);
      req(SIDES.includes(h.labelSide), `header ${h.id}: labelSide must be one of ${SIDES}`);
    });
    req(L.features === undefined || Array.isArray(L.features), 'layout.features must be an array');
    req(L.color === undefined || /^#[0-9a-f]{6}$/i.test(L.color), 'layout.color must be a #rrggbb colour');
  } else e.push('layout missing');

  if (Array.isArray(b.warnings)) {
    b.warnings.forEach((w, i) => {
      req(LEVELS.includes(w.level), `warnings[${i}].level must be one of ${LEVELS}`);
      req(isStr(w.text), `warnings[${i}].text missing`);
    });
  } else e.push('warnings must be an array');

  // Pins
  if (!Array.isArray(b.pins) || !b.pins.length) {
    e.push('pins must be a non-empty array');
    return e;
  }
  const ids = new Set();
  const slots = new Set();
  const headerCount = Object.fromEntries((L?.headers || []).map((h) => [h.id, h.count]));
  for (const p of b.pins) {
    const tag = `pin ${p.id ?? '?'}`;
    req(isStr(p.id), `${tag}: id missing`);
    req(!ids.has(p.id), `${tag}: duplicate id`);
    ids.add(p.id);
    req(headerIds.has(p.header), `${tag}: unknown header "${p.header}"`);
    req(Number.isInteger(p.pos) && p.pos >= 1 && p.pos <= (headerCount[p.header] ?? 0),
      `${tag}: pos ${p.pos} out of range for header ${p.header}`);
    const slot = `${p.header}:${p.pos}`;
    req(!slots.has(slot), `${tag}: two pins at ${slot}`);
    slots.add(slot);
    req(typeof p.label === 'string', `${tag}: label missing`);
    req(p.gpio === null || isNum(p.gpio), `${tag}: gpio must be number or null`);
    req(p.code === null || typeof p.code === 'string', `${tag}: code must be string or null`);
    req(typeof p.verified === 'boolean', `${tag}: verified must be boolean`);
    req(Array.isArray(p.functions), `${tag}: functions must be an array`);
    (p.functions || []).forEach((f) => {
      req(FUNCTION_TYPES.includes(f.type), `${tag}: bad function type "${f.type}"`);
      req(isStr(f.name), `${tag}: function name missing`);
    });
    req(Array.isArray(p.flags), `${tag}: flags must be an array`);
    (p.flags || []).forEach((f) => req(FLAGS.includes(f), `${tag}: bad flag "${f}"`));
    req(p.notes === undefined || typeof p.notes === 'string', `${tag}: notes must be a string`);
  }
  for (const w of b.warnings || []) {
    for (const pid of w.pins || []) req(ids.has(pid), `warning references unknown pin "${pid}"`);
  }
  return e;
}
