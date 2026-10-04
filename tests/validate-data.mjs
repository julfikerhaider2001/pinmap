// Validates board JSON files against js/schema.js.
// Usage: node tests/validate-data.mjs            (every file in data/boards)
//        node tests/validate-data.mjs <file.json> (one file)
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBoard } from '../js/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'data', 'boards');
const files = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => join(dir, f));

let failed = 0;
for (const f of files) {
  const id = basename(f, '.json');
  let errs;
  try {
    errs = validateBoard(JSON.parse(readFileSync(f, 'utf8')), id);
  } catch (err) {
    errs = [`cannot parse: ${err.message}`];
  }
  if (errs.length) {
    failed++;
    console.log(`FAIL ${id}`);
    errs.forEach((m) => console.log(`   - ${m}`));
  } else {
    console.log(`ok   ${id}`);
  }
}
process.exitCode = failed ? 1 : 0;
