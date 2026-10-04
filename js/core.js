// Pure logic: capabilities, search, Pin Planner checks and C header export.
// No DOM access, so tests/logic.test.mjs can run it in Node.

/** Plain-English meaning of each pin flag, plus severity for the UI and planner. */
export const FLAG_INFO = {
  'flash':           { level: 'danger', text: 'Connected to the SPI flash. Do not use.' },
  'reserved':        { level: 'danger', text: 'Used on the board for something else. Do not use.' },
  'psram':           { level: 'warn',   text: 'Connected to PSRAM on some module variants. Do not use if your module has PSRAM.' },
  'strapping':       { level: 'warn',   text: 'Strapping pin, read at reset to select the boot mode. External pull-ups, pull-downs or loads can stop the board from booting.' },
  'input-only':      { level: 'warn',   text: 'Input only. Cannot drive an output.' },
  'boot-glitch':     { level: 'info',   text: 'Toggles or outputs a signal during boot. Avoid for outputs that must stay quiet (e.g. motor enable).' },
  'adc2-wifi':       { level: 'warn',   text: 'ADC2 channel: not available for analogRead while Wi-Fi is active.' },
  'usb':             { level: 'warn',   text: 'Used by USB. Using it as GPIO breaks USB.' },
  'console-uart':    { level: 'warn',   text: 'Default serial console / programming UART. Shared with USB-serial upload.' },
  'not-5v-tolerant': { level: 'info',   text: '3.3 V maximum. Not 5 V tolerant.' },
  '5v-tolerant':     { level: 'info',   text: '5 V tolerant according to the datasheet.' },
  'onboard-led':     { level: 'info',   text: 'An on-board LED is connected.' },
  'no-pullup':       { level: 'info',   text: 'No internal pull-up/pull-down. Add an external resistor if needed.' },
  'power':           { level: 'info',   text: 'Power pin.' },
  'ground':          { level: 'info',   text: 'Ground.' },
  'nc':              { level: 'info',   text: 'Not connected.' },
};

/** Capabilities offered as filter buttons and recognised by search. */
export const CAPS = ['ADC', 'I2C', 'SPI', 'UART', 'PWM', 'TOUCH', 'DAC', 'CAN', 'I2S', 'INT', 'USB', 'RTC'];
const ROUTABLE = ['I2C', 'SPI', 'UART', 'PWM'];

export const isPowerPin = (p) => p.flags.includes('power') || p.flags.includes('ground') || p.flags.includes('nc');

/** A pin usable as general I/O in code. */
export const isIoPin = (p) => !isPowerPin(p) && p.gpio !== null && p.code !== null && p.functions.some((f) => f.type === 'GPIO');

/** A pin that can drive an output and is not off limits. */
export const canOutput = (p) => isIoPin(p) && !p.flags.includes('input-only') &&
  !p.flags.includes('flash') && !p.flags.includes('reserved');

/**
 * How a pin supports a capability:
 *   'native' — the datasheet lists this function on this pin,
 *   'matrix' — the board can route the peripheral to any output-capable GPIO,
 *   null     — not supported.
 */
export function capMode(board, pin, cap) {
  if (pin.functions.some((f) => f.type === cap)) return 'native';
  if (ROUTABLE.includes(cap) && board.routing?.[cap] === 'any' && canOutput(pin)) return 'matrix';
  return null;
}

/** Highest severity among a pin's flags: 'danger' | 'warn' | 'info' | null. */
export function pinSeverity(pin) {
  let worst = null;
  for (const f of pin.flags) {
    const lvl = FLAG_INFO[f]?.level;
    if (lvl === 'danger') return 'danger';
    if (lvl === 'warn') worst = 'warn';
  }
  return worst;
}

// ---------------------------------------------------------------- search

const CAP_WORDS = {
  i2c: 'I2C', iic: 'I2C', twi: 'I2C', wire: 'I2C',
  spi: 'SPI',
  uart: 'UART', serial: 'UART', usart: 'UART', rx: 'UART', tx: 'UART',
  adc: 'ADC', analog: 'ADC', analogue: 'ADC', analogread: 'ADC',
  pwm: 'PWM', ledc: 'PWM', analogwrite: 'PWM',
  touch: 'TOUCH', capacitive: 'TOUCH',
  dac: 'DAC',
  twai: 'CAN',
  i2s: 'I2S', pcm: 'I2S',
  usb: 'USB',
  rtc: 'RTC',
  interrupt: 'INT', interrupts: 'INT', int: 'INT',
};
const FLAG_WORDS = {
  strapping: 'strapping', strap: 'strapping', bootstrap: 'strapping',
  inputonly: 'input-only', flash: 'flash', psram: 'psram', reserved: 'reserved',
  '5v': '5v-tolerant', '5vtolerant': '5v-tolerant',
};
const STOP = new Set(['which', 'what', 'pins', 'pin', 'can', 'do', 'does', 'on', 'the', 'a', 'an', 'for', 'is', 'are',
  'with', 'support', 'supports', 'have', 'has', 'show', 'me', 'list', 'all', 'of', 'in', 'to', 'use', 'i', 'bus', 'tolerant', 'only', 'input']);

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Words that identify a board: id, name, mcu, aliases (normalised). */
function boardKeys(b) {
  return [b.id, b.name, b.mcu, ...(b.aliases || [])].map(norm).filter(Boolean);
}

/**
 * Turns a free-text query into { caps, flags, pinTokens, boardTokens }.
 * "which pins can do I2C on ESP32-S3?" -> caps [I2C], boardTokens [esp32s3]
 */
export function parseQuery(q) {
  const raw = String(q).replace(/[?!,;]/g, ' ').split(/\s+/).filter(Boolean);
  const out = { caps: [], flags: [], pinTokens: [], boardTokens: [] };
  for (let i = 0; i < raw.length; i++) {
    const word = raw[i];
    const t = norm(word);
    if (!t) continue;
    const next = norm(raw[i + 1] || '');
    // "CAN" is ambiguous with the English word: count it only as "CAN bus" or written in capitals.
    if (t === 'can' && (word === 'CAN' || next === 'bus')) { out.caps.push('CAN'); continue; }
    if (t === 'input' && next === 'only') { out.flags.push('input-only'); i++; continue; }
    if (CAP_WORDS[t]) { out.caps.push(CAP_WORDS[t]); continue; }
    if (FLAG_WORDS[t]) { out.flags.push(FLAG_WORDS[t]); continue; }
    if (STOP.has(t)) continue;
    if (/^(gpio|gp|io|d|a|pin)\d+$/.test(t)) { out.pinTokens.push(t); continue; }
    out.boardTokens.push(t);
  }
  out.caps = [...new Set(out.caps)];
  out.flags = [...new Set(out.flags)];
  return out;
}

/** Boards whose identifying words match every board token (all boards if there are none). */
export function matchBoards(boards, tokens) {
  if (!tokens.length) return { boards, unknown: [] };
  const unknown = [];
  let result = boards;
  for (const t of tokens) {
    const exact = result.filter((b) => boardKeys(b).includes(t));
    const partial = result.filter((b) => boardKeys(b).some((k) => k.includes(t)));
    const hit = exact.length ? exact : partial;
    if (hit.length) result = hit; else unknown.push(t);
  }
  return { boards: unknown.length === tokens.length ? [] : result, unknown };
}

function pinMatchesToken(pin, t) {
  const m = t.match(/^(gpio|gp|io|d|a|pin)(\d+)$/);
  if (!m) return false;
  const [, kind, n] = m;
  const label = norm(pin.label);
  if (kind === 'a') return label === t || norm(pin.code ?? '') === t;
  if (kind === 'd') return label === t || (pin.code === n);
  if (kind === 'pin') return pin.functions.some((f) => norm(f.name) === `physicalpin${n}`) || label === t;
  return pin.gpio === Number(n) || label === t;
}

/**
 * Runs a search. Returns { parsed, unknown, results: [{ board, groups }] } where each group is
 * { cap, mode: 'native'|'any'|'flag'|'pin', pins, avoid } — `avoid` lists matching pins with danger/warn flags.
 */
export function search(boards, query) {
  const parsed = parseQuery(query);
  const { boards: hitBoards, unknown } = matchBoards(boards, parsed.boardTokens);
  const results = [];
  for (const board of hitBoards) {
    const groups = [];
    for (const cap of parsed.caps) {
      const all = board.pins.filter((p) => capMode(board, p, cap));
      if (!all.length) { groups.push({ cap, mode: 'none', pins: [], avoid: [] }); continue; }
      const anyRouted = all.some((p) => capMode(board, p, cap) === 'matrix');
      groups.push({
        cap,
        mode: anyRouted ? 'any' : 'native',
        pins: all.filter((p) => pinSeverity(p) === null),
        avoid: all.filter((p) => pinSeverity(p) !== null),
      });
    }
    for (const flag of parsed.flags) {
      groups.push({ cap: flag, mode: 'flag', pins: board.pins.filter((p) => p.flags.includes(flag)), avoid: [] });
    }
    if (parsed.pinTokens.length) {
      const pins = board.pins.filter((p) => parsed.pinTokens.some((t) => pinMatchesToken(p, t)));
      groups.push({ cap: parsed.pinTokens.join(' '), mode: 'pin', pins, avoid: [] });
    }
    // Board named but nothing else asked: list the board itself.
    if (!groups.length && parsed.boardTokens.length) groups.push({ cap: null, mode: 'board', pins: [], avoid: [] });
    if (groups.length && groups.some((g) => g.mode === 'board' || g.pins.length || g.avoid.length || g.mode === 'none')) {
      results.push({ board, groups });
    }
  }
  return { parsed, unknown, results };
}

// ---------------------------------------------------------------- Pin Planner

/**
 * Signal requirement kinds used by part templates (data/parts/parts.json):
 * out, in, adc, pwm, i2c-sda, i2c-scl, spi-mosi, spi-miso, spi-sck, uart-tx, uart-rx
 */
const ROLE = {
  'i2c-sda': ['I2C', /SDA/i],
  'i2c-scl': ['I2C', /SCL/i],
  'spi-mosi': ['SPI', /MOSI|COPI|SDO|\bTX\b|SPID\b/i],
  'spi-miso': ['SPI', /MISO|CIPO|SDI|\bRX\b|SPIQ\b/i],
  'spi-sck': ['SPI', /SCK|SCLK|CLK/i],
  'uart-tx': ['UART', /TX/i],
  'uart-rx': ['UART', /RX/i],
};
const OUTPUT_KINDS = new Set(['out', 'pwm', 'i2c-sda', 'i2c-scl', 'spi-mosi', 'spi-sck', 'uart-tx']);
// Signals where the part drives (or pulls up) the MCU pin. I2C lines count because the part's pull-ups set the level.
const INPUT_KINDS = new Set(['in', 'adc', 'i2c-sda', 'i2c-scl', 'spi-miso', 'uart-rx']);

/** Can this pin serve the requirement? Returns { ok, how, reason }. */
export function pinFitsKind(board, pin, kind) {
  if (!isIoPin(pin)) return { ok: false, reason: 'not an I/O pin' };
  if (kind === 'in') return { ok: true };
  if (kind === 'out') return canOutput(pin) ? { ok: true } : { ok: false, reason: 'cannot drive an output' };
  if (kind === 'adc') return pin.functions.some((f) => f.type === 'ADC') ? { ok: true } : { ok: false, reason: 'no ADC on this pin' };
  if (kind === 'pwm') {
    const m = capMode(board, pin, 'PWM');
    if (!canOutput(pin)) return { ok: false, reason: 'cannot drive an output' };
    return m ? { ok: true, how: m } : { ok: false, reason: 'no PWM on this pin' };
  }
  const role = ROLE[kind];
  if (role) {
    const [type, rx] = role;
    if (pin.functions.some((f) => f.type === type && rx.test(f.name))) return { ok: true, how: 'native' };
    if (board.routing?.[type] === 'any' && (OUTPUT_KINDS.has(kind) ? canOutput(pin) : isIoPin(pin))) {
      return { ok: true, how: 'matrix' };
    }
    return { ok: false, reason: `pin has no ${type} ${kind.split('-')[1].toUpperCase()} function` };
  }
  return { ok: true };
}

/**
 * Checks a project. `project` = { boardId, parts: [{ uid, template, name, level, pins: { signalKey: pinId } }] },
 * `templates` = map id -> template from parts.json.
 * Returns issues: [{ level: 'error'|'warn'|'info', text, partUid?, signal?, pinId? }]
 */
export function checkProject(board, project, templates) {
  const issues = [];
  const add = (level, text, extra = {}) => issues.push({ level, text, ...extra });
  const pinById = new Map(board.pins.map((p) => [p.id, p]));
  const uses = new Map(); // pinId -> [{ part, sig }]
  const hasWifi = (board.wireless || []).includes('wifi');

  for (const part of project.parts) {
    const tpl = templates[part.template];
    if (!tpl) { add('error', `Unknown part type "${part.template}"`, { partUid: part.uid }); continue; }
    for (const sig of tpl.signals) {
      const pinId = part.pins?.[sig.key];
      const where = `${part.name} ${sig.label}`;
      if (!pinId) {
        if (!sig.optional) add('info', `${where}: not assigned yet`, { partUid: part.uid, signal: sig.key });
        continue;
      }
      const pin = pinById.get(pinId);
      if (!pin) { add('error', `${where}: pin "${pinId}" does not exist on ${board.name}`, { partUid: part.uid, signal: sig.key }); continue; }
      const ctx = { partUid: part.uid, signal: sig.key, pinId };
      const fit = pinFitsKind(board, pin, sig.kind);
      if (!fit.ok) add('error', `${where} on ${pin.label}: ${fit.reason}`, ctx);

      if (pin.flags.includes('flash')) add('error', `${where} on ${pin.label}: connected to SPI flash. Do not use.`, ctx);
      if (pin.flags.includes('reserved')) add('error', `${where} on ${pin.label}: reserved on this board${pin.notes ? ` (${pin.notes})` : ''}.`, ctx);
      if (pin.flags.includes('psram')) add('warn', `${where} on ${pin.label}: used by PSRAM on some module variants.`, ctx);
      if (pin.flags.includes('strapping')) add('warn', `${where} on ${pin.label}: strapping pin. Make sure this part doesn't pull it during reset.`, ctx);
      if (pin.flags.includes('boot-glitch') && OUTPUT_KINDS.has(sig.kind)) add('warn', `${where} on ${pin.label}: pin toggles during boot.`, ctx);
      if (pin.flags.includes('usb')) add('warn', `${where} on ${pin.label}: used by USB.`, ctx);
      if (pin.flags.includes('console-uart')) add('warn', `${where} on ${pin.label}: shared with the serial console / upload port.`, ctx);
      if (pin.flags.includes('adc2-wifi') && sig.kind === 'adc' && hasWifi) add('warn', `${where} on ${pin.label}: ADC2 does not work while Wi-Fi is active.`, ctx);
      const level = Number(part.level) || board.logicVoltage;
      if (level > board.logicVoltage) {
        // A higher-voltage part driving the pin can damage the MCU; the MCU driving the part may just be too weak a "high".
        if (INPUT_KINDS.has(sig.kind) && !pin.flags.includes('5v-tolerant')) {
          add('error', `${where} on ${pin.label}: part uses ${level} V signals but ${board.name} I/O is ${board.logicVoltage} V. Use a level shifter or divider.`, ctx);
        } else if (!INPUT_KINDS.has(sig.kind)) {
          add('warn', `${where} on ${pin.label}: ${board.logicVoltage} V output driving a ${level} V part. Check the part's input-high threshold or use a level shifter.`, ctx);
        }
      }
      if (!pin.verified) add('info', `${where} on ${pin.label}: pin data is marked unverified. Check the datasheet.`, ctx);

      if (!uses.has(pinId)) uses.set(pinId, []);
      uses.get(pinId).push({ part, sig });
    }
  }

  // Pin sharing: allowed only when every user marks the signal shareable and the kinds match (e.g. one I2C bus).
  for (const [pinId, list] of uses) {
    if (list.length < 2) continue;
    const pin = pinById.get(pinId);
    const sameKind = list.every((u) => u.sig.kind === list[0].sig.kind);
    const allShare = list.every((u) => u.sig.shareable);
    if (!(sameKind && allShare)) {
      add('error', `Conflict on ${pin.label}: ${list.map((u) => `${u.part.name} ${u.sig.label}`).join(', ')}`, { pinId });
    }
  }

  // I2C address clashes: devices on the same SDA pin form one bus.
  const buses = new Map();
  for (const part of project.parts) {
    const tpl = templates[part.template];
    const sda = tpl?.signals.find((s) => s.kind === 'i2c-sda');
    const addr = part.i2cAddress || tpl?.i2cAddress;
    if (!sda || !addr || !part.pins?.[sda.key]) continue;
    const key = `${part.pins[sda.key]}|${String(addr).toLowerCase()}`;
    if (!buses.has(key)) buses.set(key, []);
    buses.get(key).push(part);
  }
  for (const [key, parts] of buses) {
    if (parts.length < 2) continue;
    const [pinId, addr] = key.split('|');
    add('error', `I2C address clash: ${parts.map((p) => p.name).join(', ')} all use ${addr} on the bus at ${pinById.get(pinId)?.label}. ` +
      'Use an I2C multiplexer (e.g. TCA9548A) or put them on separate I2C buses.', { pinId });
  }
  return issues;
}

/** Turns a free name into a C identifier fragment: "X axis" -> "X_AXIS". */
export function macroName(s) {
  const m = String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(m) ? `P_${m}` : m || 'PIN';
}

/** Builds a C header with #define lines for every assigned signal. */
export function exportHeader(board, project, templates, issues = [], date = new Date()) {
  const pinById = new Map(board.pins.map((p) => [p.id, p]));
  const used = new Set();
  const lines = [
    '/*',
    ` * Pin plan: ${String(project.name || 'Untitled').replace(/\*\//g, '')}`,
    ` * Board:    ${board.name} (${board.mcu})`,
    ` * Source:   ${board.datasheet}`,
    ` * Generated by PinMap on ${date.toISOString().slice(0, 10)}.`,
    ' * Check every pin against your actual hardware before use.',
    ' */',
    '#pragma once',
    '',
  ];
  const problems = issues.filter((i) => i.level !== 'info');
  if (problems.length) {
    lines.push('/* Planner warnings:');
    problems.forEach((i) => lines.push(` *  [${i.level}] ${i.text.replace(/\*\//g, '')}`));
    lines.push(' */', '');
  }
  for (const part of project.parts) {
    const tpl = templates[part.template];
    if (!tpl) continue;
    const rows = tpl.signals.filter((s) => part.pins?.[s.key] && pinById.get(part.pins[s.key])?.code != null);
    if (!rows.length) continue;
    lines.push(`// ${part.name} (${tpl.name})`);
    for (const sig of rows) {
      const pin = pinById.get(part.pins[sig.key]);
      let name = `${macroName(part.name)}_${macroName(sig.key)}_PIN`;
      for (let n = 2; used.has(name); n++) name = `${macroName(part.name)}_${macroName(sig.key)}_PIN_${n}`;
      used.add(name);
      lines.push(`#define ${name.padEnd(28)} ${pin.code.padEnd(5)} // ${pin.label}`);
    }
    if (part.i2cAddress || tpl.i2cAddress) {
      lines.push(`#define ${`${macroName(part.name)}_I2C_ADDR`.padEnd(28)} ${part.i2cAddress || tpl.i2cAddress}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
