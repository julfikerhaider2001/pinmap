// Core logic tests. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capMode, parseQuery, search, checkProject, exportHeader, macroName, pinFitsKind, pinSeverity, matchBoards,
} from '../js/core.js';
import { validateBoard } from '../js/schema.js';
import { renderBoardSvg, pinXY } from '../js/render.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

// ---- fixtures (synthetic, not real board data) ----
const io = (id, pos, gpio, functions = [], flags = [], extra = {}) => ({
  id, header: 'L', pos, label: extra.label ?? String(gpio), gpio, code: extra.code ?? String(gpio),
  functions: [{ type: 'GPIO', name: `GPIO${gpio}` }, ...functions], flags, notes: '', verified: extra.verified ?? true,
});
const base = {
  category: 'board', aliases: [], wireless: [], sources: [{ title: 't', url: 'https://example.com' }], datasheet: 'https://example.com',
  verified: true, summary: 's', warnings: [], codeStyle: 'gpio',
  layout: { width: 10, height: 10, headers: [{ id: 'L', x: 1, y: 1, dir: 'down', count: 8, labelSide: 'left' }] },
};
const esp = {
  ...base, id: 'test-esp', name: 'Test ESP', family: 'ESP32', mcu: 'ESP32-TEST', aliases: ['testesp'], logicVoltage: 3.3, wireless: ['wifi'],
  routing: { I2C: 'any', SPI: 'any', UART: 'any', PWM: 'any' },
  pins: [
    { id: 'p3v3', header: 'L', pos: 1, label: '3V3', gpio: null, code: null, functions: [{ type: 'POWER', name: '3V3' }], flags: ['power'], verified: true },
    io('g0', 2, 0, [{ type: 'ADC', name: 'ADC2_CH1' }], ['strapping', 'adc2-wifi', 'not-5v-tolerant']),
    io('g4', 3, 4, [{ type: 'ADC', name: 'ADC1_CH0' }, { type: 'TOUCH', name: 'TOUCH0' }], ['not-5v-tolerant']),
    io('g34', 4, 34, [{ type: 'ADC', name: 'ADC1_CH6' }], ['input-only', 'no-pullup', 'not-5v-tolerant']),
    io('g6', 5, 6, [], ['flash']),
    io('g21', 6, 21, [], ['not-5v-tolerant']),
    io('g22', 7, 22, [], ['not-5v-tolerant'], { verified: false }),
    { id: 'gnd', header: 'L', pos: 8, label: 'GND', gpio: null, code: null, functions: [{ type: 'GND', name: 'GND' }], flags: ['ground'], verified: true },
  ],
};
const avr = {
  ...base, id: 'test-avr', name: 'Test AVR', family: 'Arduino', mcu: 'ATtest', aliases: ['testavr'], logicVoltage: 5, codeStyle: 'arduino',
  routing: { I2C: 'fixed', SPI: 'fixed', UART: 'fixed', PWM: 'fixed' },
  pins: [
    io('d2', 1, 2, [{ type: 'INT', name: 'INT0' }], [], { label: 'D2' }),
    io('d3', 2, 3, [{ type: 'PWM', name: 'OC2B' }], [], { label: 'D3' }),
    io('a4', 3, 18, [{ type: 'ADC', name: 'ADC4' }, { type: 'I2C', name: 'SDA' }], [], { label: 'A4', code: 'A4' }),
    io('a5', 4, 19, [{ type: 'ADC', name: 'ADC5' }, { type: 'I2C', name: 'SCL' }], [], { label: 'A5', code: 'A5' }),
    io('d13', 5, 13, [{ type: 'SPI', name: 'SCK' }], ['onboard-led'], { label: 'D13' }),
    io('d11', 6, 11, [{ type: 'SPI', name: 'MOSI' }, { type: 'PWM', name: 'OC2A' }], [], { label: 'D11' }),
  ],
};
const templates = Object.fromEntries(readJson('data', 'parts', 'parts.json').parts.map((p) => [p.id, p]));
const pin = (b, id) => b.pins.find((p) => p.id === id);

test('fixtures are valid against the schema', () => {
  assert.deepEqual(validateBoard(esp, 'test-esp'), []);
  assert.deepEqual(validateBoard(avr, 'test-avr'), []);
});

test('schema rejects bad data', () => {
  const bad = structuredClone(esp);
  bad.pins[1].flags.push('made-up');
  bad.pins[2].pos = 99;
  delete bad.sources;
  const errs = validateBoard(bad, 'test-esp');
  assert.ok(errs.some((e) => e.includes('bad flag')));
  assert.ok(errs.some((e) => e.includes('out of range')));
  assert.ok(errs.some((e) => e.includes('sources')));
});

test('capMode: native vs GPIO-matrix vs none', () => {
  assert.equal(capMode(esp, pin(esp, 'g4'), 'TOUCH'), 'native');
  assert.equal(capMode(esp, pin(esp, 'g21'), 'I2C'), 'matrix');
  assert.equal(capMode(esp, pin(esp, 'g34'), 'I2C'), null, 'input-only pin cannot be routed I2C');
  assert.equal(capMode(esp, pin(esp, 'g6'), 'PWM'), null, 'flash pin excluded');
  assert.equal(capMode(esp, pin(esp, 'p3v3'), 'PWM'), null);
  assert.equal(capMode(avr, pin(avr, 'd2'), 'PWM'), null, 'fixed routing: only listed pins');
  assert.equal(capMode(avr, pin(avr, 'd3'), 'PWM'), 'native');
});

test('pinSeverity ranks danger over warn', () => {
  assert.equal(pinSeverity(pin(esp, 'g6')), 'danger');
  assert.equal(pinSeverity(pin(esp, 'g0')), 'warn');
  assert.equal(pinSeverity(pin(esp, 'g4')), null);
});

test('parseQuery understands the example question', () => {
  const q = parseQuery('which pins can do I2C on ESP32-S3?');
  assert.deepEqual(q.caps, ['I2C']);
  assert.deepEqual(q.boardTokens, ['esp32s3']);
  assert.deepEqual(parseQuery('CAN bus esp32').caps, ['CAN']);
  assert.deepEqual(parseQuery('input only').flags, ['input-only']);
  assert.deepEqual(parseQuery('gpio34').pinTokens, ['gpio34']);
});

test('matchBoards picks boards by alias and reports unknown words', () => {
  assert.deepEqual(matchBoards([esp, avr], ['testavr']).boards.map((b) => b.id), ['test-avr']);
  const r = matchBoards([esp, avr], ['nosuchboard']);
  assert.equal(r.boards.length, 0);
  assert.deepEqual(r.unknown, ['nosuchboard']);
});

test('search: I2C on fixed vs matrix boards', () => {
  const a = search([esp, avr], 'i2c testavr').results;
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].groups[0].pins.map((p) => p.id), ['a4', 'a5']);
  const e = search([esp, avr], 'i2c testesp').results[0].groups[0];
  assert.equal(e.mode, 'any');
  assert.ok(e.pins.some((p) => p.id === 'g21'));
  assert.ok(e.avoid.some((p) => p.id === 'g0'), 'strapping pin listed under avoid');
  assert.ok(!e.pins.concat(e.avoid).some((p) => p.id === 'g6' || p.id === 'g34'));
});

test('search: pin token and flag', () => {
  const r = search([esp, avr], 'gpio34').results;
  assert.equal(r.length, 1);
  assert.equal(r[0].groups[0].pins[0].id, 'g34');
  const s = search([esp, avr], 'strapping').results;
  assert.deepEqual(s.map((x) => x.board.id), ['test-esp']);
});

test('pinFitsKind', () => {
  assert.equal(pinFitsKind(esp, pin(esp, 'g34'), 'out').ok, false);
  assert.equal(pinFitsKind(esp, pin(esp, 'g34'), 'in').ok, true);
  assert.equal(pinFitsKind(esp, pin(esp, 'g21'), 'adc').ok, false);
  assert.equal(pinFitsKind(esp, pin(esp, 'g21'), 'i2c-sda').how, 'matrix');
  assert.equal(pinFitsKind(avr, pin(avr, 'a4'), 'i2c-sda').ok, true);
  assert.equal(pinFitsKind(avr, pin(avr, 'a4'), 'i2c-scl').ok, false);
  assert.equal(pinFitsKind(avr, pin(avr, 'd11'), 'spi-mosi').ok, true);
  assert.equal(pinFitsKind(avr, pin(avr, 'd2'), 'pwm').ok, false);
});

const project = (boardId, parts) => ({ name: 'T', boardId, parts: parts.map((p, i) => ({ uid: `u${i}`, level: null, ...p })) });
const errorsOf = (issues) => issues.filter((i) => i.level === 'error').map((i) => i.text);

test('planner: duplicate pin is a conflict, shared EN and I2C bus are not', () => {
  const p = project('test-esp', [
    { template: 'stepper-driver', name: 'X', pins: { step: 'g21', dir: 'g22', en: 'g4' } },
    { template: 'stepper-driver', name: 'Y', pins: { step: 'g21', dir: 'g0', en: 'g4' } },
  ]);
  const errs = errorsOf(checkProject(esp, p, templates));
  assert.equal(errs.filter((t) => t.startsWith('Conflict')).length, 1, 'only STEP conflicts');
  assert.ok(errs[0].includes('X STEP') && errs[0].includes('Y STEP'));
});

test('planner: flash pin, input-only output, strapping, unverified', () => {
  const p = project('test-esp', [
    { template: 'stepper-driver', name: 'X', pins: { step: 'g6', dir: 'g34' } },
    { template: 'limit-switch', name: 'L', pins: { sig: 'g0' } },
    { template: 'digital-out', name: 'O', pins: { pin: 'g22' } },
  ]);
  const issues = checkProject(esp, p, templates);
  const text = issues.map((i) => `${i.level}:${i.text}`).join('\n');
  assert.match(text, /error:X STEP .*SPI flash/);
  assert.match(text, /error:X DIR .*cannot drive an output/);
  assert.match(text, /warn:L Signal .*strapping/);
  assert.match(text, /info:O Output .*unverified/);
});

test('planner: four AS5600 on one bus clash on address 0x36', () => {
  const enc = (n) => ({ template: 'as5600', name: `Enc ${n}`, pins: { sda: 'g21', scl: 'g22' } });
  const issues = checkProject(esp, project('test-esp', [enc(1), enc(2), enc(3), enc(4)]), templates);
  const clash = issues.filter((i) => i.text.startsWith('I2C address clash'));
  assert.equal(clash.length, 1);
  assert.match(clash[0].text, /0x36/);
  assert.equal(issues.filter((i) => i.text.startsWith('Conflict')).length, 0, 'shared SDA/SCL is fine');
});

test('planner: 5 V part into 3.3 V input is an error; ADC2 + Wi-Fi warns', () => {
  const issues = checkProject(esp, project('test-esp', [
    { template: 'limit-switch', name: 'L', level: 5, pins: { sig: 'g21' } },
    { template: 'analog-in', name: 'Pot', pins: { pin: 'g0' } },
  ]), templates);
  assert.ok(issues.some((i) => i.level === 'error' && /5 V signals/.test(i.text)));
  assert.ok(issues.some((i) => i.level === 'warn' && /ADC2/.test(i.text)));
});

test('planner: wrong-function pins on fixed-routing board', () => {
  const errs = errorsOf(checkProject(avr, project('test-avr', [
    { template: 'as5600', name: 'E', pins: { sda: 'd2', scl: 'a5' } },
    { template: 'servo', name: 'S', pins: { sig: 'd2' } },
  ]), templates));
  assert.ok(errs.some((t) => /E SDA .*no I2C SDA/.test(t)));
  assert.ok(errs.some((t) => /S Signal .*no PWM/.test(t)));
});

test('exportHeader writes #defines with codes and I2C address', () => {
  const p = project('test-avr', [
    { template: 'stepper-driver', name: 'X axis', pins: { step: 'd2', dir: 'd3' } },
    { template: 'as5600', name: 'Encoder X', pins: { sda: 'a4', scl: 'a5' } },
  ]);
  const h = exportHeader(avr, p, templates, [], new Date('2026-01-01'));
  assert.match(h, /#pragma once/);
  assert.match(h, /#define X_AXIS_STEP_PIN\s+2\s+\/\/ D2/);
  assert.match(h, /#define X_AXIS_DIR_PIN\s+3\b/);
  assert.match(h, /#define ENCODER_X_SDA_PIN\s+A4/);
  assert.match(h, /#define ENCODER_X_I2C_ADDR\s+0x36/);
  assert.doesNotMatch(h, /X_AXIS_EN_PIN/, 'unassigned signals are skipped');
});

test('macroName produces valid C identifiers', () => {
  assert.equal(macroName('X axis'), 'X_AXIS');
  assert.equal(macroName('4th motor!'), 'P_4TH_MOTOR');
  assert.equal(macroName(''), 'PIN');
});

test('renderBoardSvg draws every pin', () => {
  const svg = renderBoardSvg(esp);
  assert.equal((svg.match(/class="pin /g) || []).length, esp.pins.length);
  assert.match(svg, /data-pin="g34"/);
  assert.deepEqual(pinXY({ x: 1, y: 2, dir: 'right', count: 3 }, 3), [3, 2]);
});

// ---- real data files ----
const boardsDir = join(root, 'data', 'boards');
const manifest = readJson('data', 'boards', 'index.json').boards;

test('every board file is valid and listed in the manifest', () => {
  const files = readdirSync(boardsDir).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5));
  for (const id of files) {
    assert.ok(manifest.includes(id), `${id}.json is not listed in data/boards/index.json`);
    const errs = validateBoard(readJson('data', 'boards', `${id}.json`), id);
    assert.deepEqual(errs, [], `${id}: ${errs.join('; ')}`);
    const svg = renderBoardSvg(readJson('data', 'boards', `${id}.json`));
    assert.ok(svg.startsWith('<svg'), `${id} renders`);
  }
});

test('every manifest entry has a file', () => {
  for (const id of manifest) assert.ok(existsSync(join(boardsDir, `${id}.json`)), `missing data/boards/${id}.json`);
});

test('shortName keeps bus roles and drops notes', async () => {
  const { shortName } = await import('../js/render.js');
  assert.equal(shortName('HSPIQ (MISO)'), 'HSPIQ MISO');
  assert.equal(shortName('SDA1 (ALT0)'), 'SDA1');
  assert.equal(shortName('SPI3_MOSI (ALT3) [Pi 4B only]'), 'SPI3_MOSI');
  assert.equal(shortName('TOUCH_CHANNEL7'), 'TOUCH_CH7');
});

test('pinTags: name first, warning flags, at most 3 function tags', async () => {
  const { pinTags } = await import('../js/render.js');
  const tags = pinTags(esp, pin(esp, 'g0'));
  assert.equal(tags[0].text, '0');
  assert.ok(tags.some((t) => t.text === 'STRAP'));
  const big = { ...pin(esp, 'g4'), functions: [{ type: 'GPIO', name: 'GPIO4' }, ...'ABCDE'.split('').map((c) => ({ type: 'ADC', name: `ADC_${c}` }))] };
  const t2 = pinTags(esp, big);
  assert.equal(t2.filter((t) => t.cls.includes('t-ADC')).length, 3);
  assert.equal(t2.at(-1).text, '+2');
  assert.equal(pinTags(esp, pin(esp, 'g4'), 'names').length, 1);
});
