/** "Surprise me": grows islands with hills, woods, lakes and squares, then sprinkles houses on them. */
import { WALL } from './palette';
import { hash32 } from './rng';
import { KIND_BUILDING, ZONE_MEADOW, ZONE_PLAZA, ZONE_WATER, ZONE_WOODS } from './tiles';
import { MAX_LEVEL, type Town, key } from './town';

export function generateTown(town: Town, rand: () => number): void {
  const g = town.grid;
  town.cells.clear();
  const dist = (v: number) => Math.hypot(g.pos[v].x, g.pos[v].z);
  const maxR = g.radius * 0.72;
  const cands = g.pos.map((_, v) => v).filter((v) => g.buildable[v] && dist(v) < maxR * 0.8);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const seed = () => hash32(Math.floor(rand() * 2 ** 31), 77);

  /** Grow a random connected blob of `size` vertices from `start` within `allowed`. */
  const grow = (start: number, size: number, allowed: (v: number) => boolean): number[] => {
    const out = [start];
    const inSet = new Set(out);
    const frontier = [start];
    while (out.length < size && frontier.length) {
      const fi = Math.floor(rand() * frontier.length);
      const opts = g.edgeNbrs[frontier[fi]].filter((n) => !inSet.has(n) && allowed(n));
      if (!opts.length) {
        frontier.splice(fi, 1);
        continue;
      }
      const n = pick(opts);
      inSet.add(n);
      out.push(n);
      frontier.push(n);
    }
    return out;
  };

  // Islands.
  const island = new Set<number>();
  const nIslands = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < nIslands; i++) {
    const start = i === 0 ? cands.reduce((a, b) => (dist(a) < dist(b) ? a : b)) : pick(cands);
    for (const v of grow(start, 22 + Math.floor(rand() * 45), (n) => g.buildable[n] && !island.has(n) && dist(n) < maxR)) island.add(v);
  }
  const height = new Map<number, number>([...island].map((v) => [v, 0]));
  const zone = new Map<number, number>([...island].map((v) => [v, ZONE_MEADOW]));
  const isl = [...island];

  // Hills: a peak with land falling away around it.
  const nHills = 1 + Math.floor(rand() * 3);
  for (let h = 0; h < nHills; h++) {
    const peak = pick(isl);
    const top = 2 + Math.floor(rand() * 2);
    const depth = new Map<number, number>([[peak, 0]]);
    const queue = [peak];
    while (queue.length) {
      const v = queue.shift()!;
      const d = depth.get(v)!;
      const hgt = top - Math.floor(d * (0.7 + rand() * 0.6));
      if (hgt <= 0) continue;
      height.set(v, Math.max(height.get(v)!, hgt));
      for (const n of g.edgeNbrs[v]) if (island.has(n) && !depth.has(n)) {
        depth.set(n, d + 1);
        queue.push(n);
      }
    }
  }

  // Woods (often on hills) and lakes (on flat ground).
  const nWoods = 1 + Math.floor(rand() * 3);
  for (let w = 0; w < nWoods; w++) {
    for (const v of grow(pick(isl), 5 + Math.floor(rand() * 10), (n) => island.has(n))) zone.set(v, ZONE_WOODS);
  }
  const flat = isl.filter((v) => height.get(v) === 0 && zone.get(v) === ZONE_MEADOW);
  if (flat.length && rand() < 0.85) {
    for (const v of grow(pick(flat), 3 + Math.floor(rand() * 7), (n) => height.get(n) === 0 && zone.get(n) === ZONE_MEADOW)) zone.set(v, ZONE_WATER);
  }

  // Buildings on open meadow.
  const claimed = new Set<number>();
  const buildable = () => isl.filter((v) => !claimed.has(v) && zone.get(v) === ZONE_MEADOW);
  const nBuildings = Math.max(2, Math.floor(island.size / 17));
  const storeys: [number, number, number][] = [];
  for (let b = 0; b < nBuildings; b++) {
    const options = buildable();
    if (!options.length) break;
    const cells = grow(pick(options), 1 + Math.floor(rand() ** 2 * 8), (n) => !claimed.has(n) && zone.get(n) === ZONE_MEADOW && island.has(n));
    cells.forEach((c) => claimed.add(c));
    const color = Math.floor(rand() * WALL.length);
    const base = 1 + Math.floor(rand() * 3);
    const tower = cells.length === 1 && rand() < 0.7;
    for (const v of cells) {
      let h = base + (rand() < 0.3 ? 1 : 0);
      if (tower) h += 2 + Math.floor(rand() * 3);
      const c = rand() < 0.15 ? Math.floor(rand() * WALL.length) : color;
      const g0 = height.get(v)!;
      for (let k = g0 + 1; k <= Math.min(g0 + h, MAX_LEVEL); k++) storeys.push([v, k, c]);
    }
    // Squares around some buildings.
    if (rand() < 0.6) {
      for (const v of cells) for (const n of g.edgeNbrs[v]) if (island.has(n) && !claimed.has(n) && zone.get(n) === ZONE_MEADOW && rand() < 0.6) zone.set(n, ZONE_PLAZA);
    }
  }

  for (const v of island) {
    const top = height.get(v)!;
    for (let k = 0; k <= top; k++) town.cells.set(key(v, k), { kind: zone.get(v)!, color: 0, seed: seed(), tile: -1 });
  }
  for (const [v, k, c] of storeys) town.cells.set(key(v, k), { kind: KIND_BUILDING, color: c, seed: seed(), tile: -1 });
  town.solveAll();
}
