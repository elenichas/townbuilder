/** "Surprise me": grows a few islands and sprinkles houses and towers on them. */
import { hash32 } from './rng';
import { MAX_LEVEL, type Town, key } from './town';
import { WALL } from './palette';

export function generateTown(town: Town, rand: () => number): void {
  const g = town.grid;
  town.cells.clear();
  const dist = (v: number) => Math.hypot(g.pos[v].x, g.pos[v].z);
  const maxR = g.radius * 0.72;
  const cands = g.pos.map((_, v) => v).filter((v) => g.buildable[v] && dist(v) < maxR * 0.8);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const seed = () => hash32(Math.floor(rand() * 2 ** 31), 77);

  const island = new Set<number>();
  const nIslands = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < nIslands; i++) {
    const start = i === 0 ? cands.reduce((a, b) => (dist(a) < dist(b) ? a : b)) : pick(cands);
    const size = 18 + Math.floor(rand() * 45);
    const grown = [start];
    const frontier = [start];
    island.add(start);
    while (grown.length < size && frontier.length) {
      const fi = Math.floor(rand() * frontier.length);
      const v = frontier[fi];
      const opts = g.edgeNbrs[v].filter((n) => g.buildable[n] && !island.has(n) && dist(n) < maxR);
      if (!opts.length) {
        frontier.splice(fi, 1);
        continue;
      }
      const n = pick(opts);
      island.add(n);
      grown.push(n);
      frontier.push(n);
    }
  }
  for (const v of island) town.cells.set(key(v, 0), { color: 0, seed: seed(), tile: -1 });

  const claimed = new Set<number>();
  const free = () => [...island].filter((v) => !claimed.has(v));
  const nBuildings = Math.max(2, Math.floor(island.size / 10));
  for (let b = 0; b < nBuildings; b++) {
    const options = free();
    if (!options.length) break;
    const start = pick(options);
    const size = 1 + Math.floor(rand() ** 2 * 9);
    const color = Math.floor(rand() * WALL.length);
    const base = 1 + Math.floor(rand() * 3);
    const cells = [start];
    claimed.add(start);
    while (cells.length < size) {
      const opts = cells.flatMap((c) => g.edgeNbrs[c]).filter((n) => island.has(n) && !claimed.has(n));
      if (!opts.length) break;
      const n = pick(opts);
      claimed.add(n);
      cells.push(n);
    }
    const tower = cells.length === 1 && rand() < 0.7;
    for (const v of cells) {
      let h = base + (rand() < 0.3 ? 1 : 0);
      if (tower) h += 2 + Math.floor(rand() * 3);
      h = Math.min(h, MAX_LEVEL);
      const c = rand() < 0.15 ? Math.floor(rand() * WALL.length) : color;
      for (let k = 1; k <= h; k++) town.cells.set(key(v, k), { color: c, seed: seed(), tile: -1 });
    }
  }
  town.solveAll();
}
