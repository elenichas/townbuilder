/**
 * "Surprise me": grows islands, shapes the land and sprinkles buildings on them.
 *
 * Themes:
 *  - pastel:   the original colourful town.
 *  - island:   a Cycladic village: whitewashed houses clustered tightly, flat roofs and vaults,
 *              lone chapels, windmills on the high ground, olive groves, squares with plane trees.
 *  - mountain: a Zagori / Pelion style village: stone houses with slate roofs climbing steep
 *              hills, Mani-style towers, woods, rocky slopes, stone arched bridges.
 */
import { hash32 } from './rng';
import {
  KIND_BUILDING,
  STYLE_ISLAND,
  STYLE_MOUNTAIN,
  STYLE_PASTEL,
  ZONE_MEADOW,
  ZONE_OLIVE,
  ZONE_PLAZA,
  ZONE_ROCKY,
  ZONE_WATER,
  ZONE_WOODS,
} from './tiles';
import { MAX_LEVEL, type Town, key } from './town';

export type Theme = 'pastel' | 'island' | 'mountain';
export const THEMES: { id: Theme; name: string }[] = [
  { id: 'island', name: 'Greek island village' },
  { id: 'mountain', name: 'Greek mountain village' },
  { id: 'pastel', name: 'Pastel town' },
];

/** Palette indices (see palette.ts) that suit each theme's painted details. */
const AEGEAN_BLUE = 8;
const SHUTTER_GREEN = 9;
const OXBLOOD = 10;

interface Recipe {
  style: number;
  hills: [number, number]; // count range
  hillTop: [number, number]; // peak height range
  woods: number;
  olives: number;
  rocky: number;
  lake: number; // chance
  density: number; // islands cells per building
  size: [number, number]; // building footprint range
  height: [number, number]; // storeys range
  towers: number; // lone tall towers
  chapels: number;
  colors: number[];
}

const RECIPES: Record<Theme, Recipe> = {
  pastel: {
    style: STYLE_PASTEL,
    hills: [1, 3],
    hillTop: [2, 3],
    woods: 2,
    olives: 0,
    rocky: 0,
    lake: 0.85,
    density: 17,
    size: [1, 9],
    height: [1, 3],
    towers: 2,
    chapels: 0,
    colors: [0, 1, 2, 3, 4, 5, 6, 7],
  },
  island: {
    style: STYLE_ISLAND,
    hills: [1, 2],
    hillTop: [1, 2],
    woods: 0,
    olives: 3,
    rocky: 4,
    lake: 0.35,
    density: 9,
    size: [1, 5],
    height: [1, 2],
    towers: 3,
    chapels: 3,
    colors: [AEGEAN_BLUE, AEGEAN_BLUE, AEGEAN_BLUE, SHUTTER_GREEN, OXBLOOD, 4],
  },
  mountain: {
    style: STYLE_MOUNTAIN,
    hills: [2, 3],
    hillTop: [3, 4],
    woods: 3,
    olives: 1,
    rocky: 3,
    lake: 0.6,
    density: 9,
    size: [1, 4],
    height: [2, 3],
    towers: 2,
    chapels: 0,
    colors: [SHUTTER_GREEN, SHUTTER_GREEN, OXBLOOD, AEGEAN_BLUE, 0],
  },
};

export function generateTown(town: Town, rand: () => number, theme: Theme = 'pastel'): void {
  const R = RECIPES[theme];
  const g = town.grid;
  town.cells.clear();
  const dist = (v: number) => Math.hypot(g.pos[v].x, g.pos[v].z);
  const maxR = g.radius * 0.72;
  const cands = g.pos.map((_, v) => v).filter((v) => g.buildable[v] && dist(v) < maxR * 0.8);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const between = ([a, b]: [number, number]) => a + Math.floor(rand() * (b - a + 1));
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
  const nIslands = theme === 'island' ? 2 + Math.floor(rand() * 2) : 3 + Math.floor(rand() * 3);
  for (let i = 0; i < nIslands; i++) {
    const start = i === 0 ? cands.reduce((a, b) => (dist(a) < dist(b) ? a : b)) : pick(cands);
    const size = theme === 'island' ? 35 + Math.floor(rand() * 45) : 22 + Math.floor(rand() * 45);
    for (const v of grow(start, size, (n) => g.buildable[n] && !island.has(n) && dist(n) < maxR)) island.add(v);
  }
  const isl = [...island];
  const height = new Map<number, number>(isl.map((v) => [v, 0]));
  const zone = new Map<number, number>(isl.map((v) => [v, ZONE_MEADOW]));

  // Hills: a peak with land falling away around it.
  const nHills = between(R.hills);
  for (let h = 0; h < nHills; h++) {
    const peak = pick(isl);
    const top = between(R.hillTop);
    const depth = new Map<number, number>([[peak, 0]]);
    const queue = [peak];
    while (queue.length) {
      const v = queue.shift()!;
      const d = depth.get(v)!;
      const hgt = top - Math.floor(d * (0.6 + rand() * 0.6));
      if (hgt <= 0) continue;
      height.set(v, Math.max(height.get(v)!, hgt));
      for (const n of g.edgeNbrs[v])
        if (island.has(n) && !depth.has(n)) {
          depth.set(n, d + 1);
          queue.push(n);
        }
    }
  }

  // Land types.
  const paint = (count: number, size: [number, number], z: number, where: (v: number) => boolean) => {
    for (let i = 0; i < count; i++) {
      const opts = isl.filter((v) => zone.get(v) === ZONE_MEADOW && where(v));
      if (!opts.length) return;
      for (const v of grow(pick(opts), between(size), (n) => island.has(n) && zone.get(n) === ZONE_MEADOW && where(n))) zone.set(v, z);
    }
  };
  const edge = (v: number) => g.edgeNbrs[v].some((n) => !island.has(n));
  const high = (v: number) => height.get(v)! >= 1;
  paint(R.rocky, [4, 10], ZONE_ROCKY, (v) => edge(v) || height.get(v)! >= 2);
  paint(R.woods, [5, 12], ZONE_WOODS, () => true);
  paint(R.olives, [5, 12], ZONE_OLIVE, (v) => !high(v) || theme === 'island');
  if (rand() < R.lake) paint(1, [3, 8], ZONE_WATER, (v) => height.get(v) === 0 && !edge(v));

  // Buildings.
  const claimed = new Set<number>();
  const storeys: [number, number, number][] = [];
  const free = (v: number) => island.has(v) && !claimed.has(v) && zone.get(v) === ZONE_MEADOW;
  const color = () => pick(R.colors);
  const stack = (v: number, h: number, c: number) => {
    const g0 = height.get(v)!;
    for (let k = g0 + 1; k <= Math.min(g0 + h, MAX_LEVEL); k++) storeys.push([v, k, c]);
  };

  // Lone towers / windmills on the high ground, and lone chapels.
  const byHeight = isl.filter(free).sort((a, b) => height.get(b)! - height.get(a)!);
  for (let i = 0; i < R.towers && byHeight.length; i++) {
    const v = byHeight.splice(Math.floor(rand() * Math.min(6, byHeight.length)), 1)[0];
    if (!free(v) || g.edgeNbrs[v].some((n) => claimed.has(n))) continue;
    claimed.add(v);
    g.edgeNbrs[v].forEach((n) => claimed.add(n)); // keep it standing alone
    stack(v, theme === 'mountain' ? 4 + Math.floor(rand() * 2) : theme === 'island' ? 2 + Math.floor(rand() * 2) : 4 + Math.floor(rand() * 3), color());
  }
  for (let i = 0; i < R.chapels; i++) {
    const opts = isl.filter((v) => free(v) && g.edgeNbrs[v].every((n) => !claimed.has(n)));
    if (!opts.length) break;
    const v = pick(opts);
    claimed.add(v);
    g.edgeNbrs[v].forEach((n) => claimed.add(n));
    stack(v, 1, AEGEAN_BLUE);
  }

  // Clusters of houses.
  const nBuildings = Math.max(2, Math.floor(island.size / R.density));
  for (let b = 0; b < nBuildings; b++) {
    const options = isl.filter(free);
    if (!options.length) break;
    const cells = grow(pick(options), between(R.size), free);
    cells.forEach((c) => claimed.add(c));
    const c0 = color();
    const base = between(R.height);
    for (const v of cells) {
      const h = Math.max(1, base + (rand() < 0.3 ? 1 : 0) - (theme === 'island' && rand() < 0.3 ? 1 : 0));
      stack(v, h, rand() < 0.15 ? color() : c0);
    }
    // Squares around some buildings.
    if (rand() < (theme === 'pastel' ? 0.6 : 0.45)) {
      for (const v of cells) for (const n of g.edgeNbrs[v]) if (free(n) && rand() < 0.5) zone.set(n, ZONE_PLAZA);
    }
  }

  for (const v of island) {
    const top = height.get(v)!;
    for (let k = 0; k <= top; k++) town.cells.set(key(v, k), { kind: zone.get(v)!, color: 0, seed: seed(), tile: -1 });
  }
  const occupied = new Set<number>();
  for (const [v, k, c] of storeys) {
    town.cells.set(key(v, k), { kind: KIND_BUILDING, color: c, seed: seed(), tile: -1, style: R.style });
    occupied.add(key(v, k));
  }

  // Mountain villages get a stone bridge or two: a storey spanning the gap between two houses.
  if (theme === 'mountain') {
    let bridges = 0;
    for (const v of isl) {
      if (bridges >= 2) break;
      for (let k = 2; k <= 6 && bridges < 2; k++) {
        if (town.has(v, k) || town.has(v, k - 1)) continue;
        const sides = g.edgeNbrs[v].filter((n) => town.isBuilding(n, k) && town.isBuilding(n, k - 1));
        if (sides.length >= 2 && !g.quadMates[sides[0]].includes(sides[1])) {
          town.cells.set(key(v, k), { kind: KIND_BUILDING, color: color(), seed: seed(), tile: -1, style: R.style });
          bridges++;
        }
      }
    }
  }
  town.solveAll();
}

