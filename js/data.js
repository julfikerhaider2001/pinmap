// Loads board and part data. All paths are relative so the site works under /<repo>/ on GitHub Pages.
import { validateBoard } from './schema.js';

/** Loads every board in data/boards/index.json. Boards that fail to load or validate are reported, not thrown. */
export async function loadBoards() {
  const manifest = await fetchJson('data/boards/index.json');
  const results = await Promise.all(manifest.boards.map(async (id) => {
    try {
      const board = await fetchJson(`data/boards/${id}.json`);
      const errors = validateBoard(board, id);
      if (errors.length) return { id, error: `invalid data: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ' …' : ''}` };
      return { id, board };
    } catch (err) {
      return { id, error: err.message };
    }
  }));
  const boards = results.filter((r) => r.board).map((r) => r.board);
  const failed = results.filter((r) => r.error);
  if (failed.length) console.warn('PinMap: some boards could not be loaded', failed);
  return { boards, failed };
}

export async function loadParts() {
  const data = await fetchJson('data/parts/parts.json');
  return Object.fromEntries(data.parts.map((p) => [p.id, p]));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
