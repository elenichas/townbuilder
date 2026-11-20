/**
 * "Surprise me": grows a whole settlement for the current mode.
 *
 *  - Pastel town: colourful houses scattered over green islands, woods, a lake and squares.
 *  - Greek island: one big island. A Chora (old town) crowns the main hill: dense whitewashed houses
 *    threaded with lanes, chapels and a ridge of windmills. Down at the shore there is a port: a
 *    harbour basin with caiques, a quay square and waterfront tavernas. A whitewashed lane climbs from
 *    the port to the Chora; the rest is dry summer hillside, phrygana scrub and olive groves.
 *  - Greek mountain village: steep hills with fir and chestnut forest and limestone near the peaks.
 *    A stone village on the slopes around a square with a plane tree, cobbled kalderimi paths linking
 *    it to outlying hamlets, a river below, and Mani-style towers.
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
  ZONE_ROAD,
  ZONE_ROCKY,
  ZONE_WATER,
  ZONE_WOODS,
} from './tiles';
import { MAX_LEVEL, MODE_ISLAND, MODE_MOUNTAIN, MODE_PASTEL, type Town, key } from './town';

/** Palette indices (see palette.ts). */
const AEGEAN_BLUE = 8;
const SHUTTER_GREEN = 9;
const OXBLOOD = 10;

export function generateTown(town: Town, rand: () => number, mode = MODE_PASTEL): void {
  const g = town.grid;
  town.cells.clear();
  town.mode = mode;
  const dist = (v: number) => Math.hypot(g.pos[v].x, g.pos[v].z);
  const maxR = g.radius * 0.74;
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const seed = () => hash32(Math.floor(rand() * 2 ** 31), 77);
  const shuffled = <T>(arr: T[]) => arr.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map((p) => p[1]);

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

  // ---- land masses
  const island = new Set<number>();
  const buildable = g.pos.map((_, v) => v).filter((v) => g.buildable[v]);
  const centre = buildable.reduce((a, b) => (dist(a) < dist(b) ? a : b));
  const addIsland = (start: number, size: number) => {
    for (const v of grow(start, size, (n) => g.buildable[n] && !island.has(n) && dist(n) < maxR)) island.add(v);
  };
  if (mode === MODE_ISLAND) {
    addIsland(centre, 170 + between(0, 40));
    const far = buildable.filter((v) => !island.has(v) && dist(v) > maxR * 0.75 && dist(v) < maxR);
    if (far.length) addIsland(pick(far), 14);
  } else if (mode === MODE_MOUNTAIN) {
    addIsland(centre, 150 + between(0, 40));
    for (let i = 0; i < 2; i++) addIsland(pick(buildable.filter((v) => dist(v) < maxR * 0.85)), between(25, 45));
  } else {
    const cands = buildable.filter((v) => dist(v) < maxR * 0.8);
    for (let i = 0, n = between(3, 5); i < n; i++) addIsland(i === 0 ? centre : pick(cands), between(22, 66));
  }
  const isl = [...island];
  const edge = (v: number) => g.edgeNbrs[v].some((n) => !island.has(n));
  const height = new Map<number, number>(isl.map((v) => [v, 0]));
  const zone = new Map<number, number>(isl.map((v) => [v, ZONE_MEADOW]));
  const hOf = (v: number) => height.get(v)!;
  /** Hop distance over the land from `from`. */
  const hop = (from: number) => {
    const d = new Map<number, number>([[from, 0]]);
    const q = [from];
    while (q.length) {
      const v = q.shift()!;
      for (const n of g.edgeNbrs[v])
        if (island.has(n) && !d.has(n)) {
          d.set(n, d.get(v)! + 1);
          q.push(n);
        }
    }
    return d;
  };

  // ---- hills
  const raise = (peak: number, top: number, falloff: number) => {
    for (const [v, dd] of hop(peak)) {
      const h = Math.round(top - dd * falloff * (0.8 + rand() * 0.4));
      if (h > hOf(v)) height.set(v, Math.min(h, 5));
    }
  };
  const inland = isl.filter((v) => !edge(v));
  let choraPeak = centre;
  if (mode === MODE_ISLAND) {
    const middle = inland.filter((v) => dist(v) < maxR * 0.45);
    choraPeak = pick(middle.length ? middle : inland);
    raise(choraPeak, 3, 0.55);
    raise(pick(inland), 2, 0.7);
  } else if (mode === MODE_MOUNTAIN) {
    for (let i = 0; i < 3; i++) raise(pick(inland), between(4, 5), 0.75);
    raise(pick(isl), 2, 0.6);
  } else {
    for (let i = 0, n = between(1, 3); i < n; i++) raise(pick(isl), between(2, 3), 0.8);
  }

  /** Cheapest route over the land, preferring gentle slopes (Dijkstra). */
  const route = (from: number, to: number, ok: (v: number) => boolean): number[] => {
    const cost = new Map<number, number>([[from, 0]]);
    const prev = new Map<number, number>();
    const open = [from];
    while (open.length) {
      open.sort((a, b) => cost.get(a)! - cost.get(b)!);
      const v = open.shift()!;
      if (v === to) break;
      for (const n of g.edgeNbrs[v]) {
        if (!island.has(n) || (!ok(n) && n !== to)) continue;
        const c = cost.get(v)! + 1 + 3 * Math.abs(hOf(n) - hOf(v)) + rand() * 0.3;
        if (c < (cost.get(n) ?? Infinity)) {
          cost.set(n, c);
          prev.set(n, v);
          open.push(n);
        }
      }
    }
    if (from !== to && !prev.has(to)) return [];
    const out = [to];
    while (out[out.length - 1] !== from) out.push(prev.get(out[out.length - 1])!);
    return out;
  };

  // ---- buildings
  const claimed = new Set<number>();
  const houses = new Set<number>();
  const storeys: [number, number, number][] = [];
  const style = mode === MODE_ISLAND ? STYLE_ISLAND : mode === MODE_MOUNTAIN ? STYLE_MOUNTAIN : STYLE_PASTEL;
  const palette =
    mode === MODE_ISLAND ? [AEGEAN_BLUE, AEGEAN_BLUE, AEGEAN_BLUE, SHUTTER_GREEN, OXBLOOD, 4] : mode === MODE_MOUNTAIN ? [SHUTTER_GREEN, SHUTTER_GREEN, OXBLOOD, AEGEAN_BLUE, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const color = () => pick(palette);
  const free = (v: number) => island.has(v) && !claimed.has(v) && zone.get(v) === ZONE_MEADOW;
  const stack = (v: number, h: number, c: number) => {
    claimed.add(v);
    houses.add(v);
    for (let k = hOf(v) + 1; k <= Math.min(hOf(v) + h, MAX_LEVEL); k++) storeys.push([v, k, c]);
  };
  /** Free and with no house next to it, so it stays standing alone (chapels, windmills, towers). */
  const lone = (v: number) => free(v) && g.edgeNbrs[v].every((n) => !houses.has(n));
  const isolate = (v: number) => g.edgeNbrs[v].forEach((n) => claimed.add(n));
  const cluster = (start: number, size: number, h: [number, number], ok: (v: number) => boolean) => {
    const cells = grow(start, size, (n) => free(n) && ok(n));
    const c0 = color();
    const base = between(h[0], h[1]);
    for (const v of cells) stack(v, Math.max(1, base + (rand() < 0.3 ? 1 : 0) - (rand() < 0.2 ? 1 : 0)), rand() < 0.15 ? color() : c0);
    return cells;
  };

  if (mode === MODE_ISLAND) {
    // Port: a harbour basin on the shore, as far from the Chora as possible.
    const fromChora = hop(choraPeak);
    const shore = isl.filter((v) => edge(v) && hOf(v) === 0);
    const harbourStart = shore.length ? shore.reduce((a, b) => ((fromChora.get(a) ?? 0) > (fromChora.get(b) ?? 0) ? a : b)) : centre;
    grow(harbourStart, between(5, 8), (n) => island.has(n) && hOf(n) === 0 && edge(n)).forEach((v) => zone.set(v, ZONE_WATER));
    const quay = isl.filter((v) => zone.get(v) === ZONE_MEADOW && hOf(v) === 0 && g.edgeNbrs[v].some((n) => zone.get(n) === ZONE_WATER));
    quay.forEach((v) => zone.set(v, ZONE_PLAZA));
    // The main lane from the port up to the Chora, laid before any houses so nothing blocks it.
    const quayEnd = quay.length ? pick(quay) : harbourStart;
    for (const v of route(quayEnd, choraPeak, (n) => zone.get(n) !== ZONE_WATER)) if (zone.get(v) === ZONE_MEADOW) zone.set(v, ZONE_ROAD);
    // Waterfront houses and tavernas right behind the quay.
    for (const v of isl.filter((u) => free(u) && hOf(u) === 0 && g.edgeNbrs[u].some((n) => quay.includes(n)))) if (rand() < 0.7) stack(v, between(1, 2), color());

    // Chora on the hill: lanes first, then houses packed around them.
    const choraArea = isl.filter((v) => (fromChora.get(v) ?? 99) <= 4 && hOf(v) >= 1);
    const choraSet = new Set(choraArea);
    for (let i = 0; i < 5; i++) for (const v of route(choraPeak, pick(choraArea), (n) => choraSet.has(n))) zone.set(v, ZONE_ROAD);
    zone.set(choraPeak, ZONE_PLAZA);
    // Windmills on the Chora's outer ridge, then the dense whitewashed houses.
    let mills = 0;
    for (const v of shuffled(choraArea.filter((u) => (fromChora.get(u) ?? 0) >= 3))) {
      if (mills >= 3) break;
      if (!lone(v)) continue;
      stack(v, between(2, 3), 0);
      isolate(v);
      mills++;
    }
    for (const v of shuffled(choraArea)) if (free(v) && rand() < 0.85) cluster(v, between(2, 5), [1, 2], (n) => choraSet.has(n));
    // Chapels dotted over the countryside, and a few farmhouses.
    for (let i = 0; i < 4; i++) {
      const opts = isl.filter((v) => lone(v) && !choraSet.has(v));
      if (!opts.length) break;
      const v = pick(opts);
      stack(v, 1, AEGEAN_BLUE);
      isolate(v);
    }
    for (let i = 0; i < 4; i++) {
      const opts = isl.filter((v) => free(v) && !choraSet.has(v));
      if (opts.length) cluster(pick(opts), between(1, 3), [1, 2], () => true);
    }
    // Landscape: phrygana on the high and outer ground, olive groves lower down, summer hillside.
    for (const v of isl) {
      if (zone.get(v) !== ZONE_MEADOW || claimed.has(v)) continue;
      const r = rand();
      if (hOf(v) >= 2 || (edge(v) && r < 0.6)) zone.set(v, ZONE_ROCKY);
      else if (r < 0.35) zone.set(v, ZONE_OLIVE);
      else if (r < 0.5) zone.set(v, ZONE_ROCKY);
    }
  } else if (mode === MODE_MOUNTAIN) {
    // River / lake in the lowest ground, limestone near the peaks.
    const low = isl.filter((v) => hOf(v) === 0 && !edge(v));
    if (low.length) grow(pick(low), between(5, 9), (n) => island.has(n) && hOf(n) === 0).forEach((v) => zone.set(v, ZONE_WATER));
    for (const v of isl) if (zone.get(v) === ZONE_MEADOW && hOf(v) >= 4) zone.set(v, ZONE_ROCKY);
    // The village on the middle slopes around a square with a plane tree.
    const slopes = isl.filter((v) => zone.get(v) === ZONE_MEADOW && hOf(v) >= 1 && hOf(v) <= 3);
    const square = pick(slopes.length ? slopes : isl);
    zone.set(square, ZONE_PLAZA);
    claimed.add(square);
    const nearSquare = hop(square);
    const villageArea = new Set(isl.filter((v) => (nearSquare.get(v) ?? 99) <= 4 && zone.get(v) === ZONE_MEADOW));
    // Keep the square's surroundings open (more square or the start of the streets) so paths can leave it.
    for (const v of g.edgeNbrs[square])
      if (island.has(v) && zone.get(v) === ZONE_MEADOW) {
        zone.set(v, rand() < 0.5 ? ZONE_PLAZA : ZONE_ROAD);
        claimed.add(v);
      }
    // Lanes through the village first, then houses along them with gardens in between.
    for (let i = 0; i < 4; i++) for (const v of route(square, pick([...villageArea]), (n) => villageArea.has(n))) if (zone.get(v) === ZONE_MEADOW) zone.set(v, ZONE_ROAD);
    for (const v of shuffled([...villageArea])) if (free(v) && rand() < 0.3) cluster(v, between(1, 2), [2, 3], (n) => villageArea.has(n));
    // Towers.
    for (let i = 0; i < 2; i++) {
      const opts = isl.filter(lone);
      if (!opts.length) break;
      const v = pick(opts);
      stack(v, between(4, 5), color());
      isolate(v);
    }
    // Hamlets linked to the square by kalderimi.
    for (let i = 0; i < 3; i++) {
      const opts = isl.filter((v) => free(v) && !villageArea.has(v));
      if (!opts.length) break;
      const t = pick(opts);
      cluster(t, between(1, 2), [1, 2], () => true);
      const goal = g.edgeNbrs[t].find((n) => island.has(n) && !claimed.has(n) && zone.get(n) === ZONE_MEADOW);
      if (goal === undefined) continue;
      for (const v of route(square, goal, (n) => !houses.has(n) && zone.get(n) !== ZONE_WATER)) if (zone.get(v) === ZONE_MEADOW || zone.get(v) === ZONE_ROCKY) zone.set(v, ZONE_ROAD);
    }
    // Fir and chestnut forest on the free slopes.
    for (let i = 0; i < 4; i++) {
      const opts = isl.filter((v) => zone.get(v) === ZONE_MEADOW && !claimed.has(v) && hOf(v) >= 2);
      if (!opts.length) break;
      grow(pick(opts), between(6, 14), (n) => zone.get(n) === ZONE_MEADOW && !claimed.has(n)).forEach((v) => zone.set(v, ZONE_WOODS));
    }
  } else {
    const paint = (count: number, size: [number, number], z: number, where: (v: number) => boolean) => {
      for (let i = 0; i < count; i++) {
        const opts = isl.filter((v) => zone.get(v) === ZONE_MEADOW && where(v));
        if (!opts.length) return;
        grow(pick(opts), between(...size), (n) => island.has(n) && zone.get(n) === ZONE_MEADOW && where(n)).forEach((v) => zone.set(v, z));
      }
    };
    paint(2, [5, 12], ZONE_WOODS, () => true);
    if (rand() < 0.85) paint(1, [3, 8], ZONE_WATER, (v) => hOf(v) === 0 && !edge(v));
    for (let i = 0; i < 2; i++) {
      const opts = isl.filter(lone);
      if (!opts.length) break;
      const v = pick(opts);
      stack(v, between(4, 6), color());
      isolate(v);
    }
    const n = Math.max(2, Math.floor(island.size / 17));
    for (let b = 0; b < n; b++) {
      const opts = isl.filter(free);
      if (!opts.length) break;
      const cells = cluster(pick(opts), 1 + Math.floor(rand() ** 2 * 8), [1, 3], () => true);
      if (rand() < 0.6) for (const v of cells) for (const m of g.edgeNbrs[v]) if (free(m) && rand() < 0.5) zone.set(m, ZONE_PLAZA);
    }
  }

  // ---- commit
  for (const v of island) for (let k = 0; k <= hOf(v); k++) town.cells.set(key(v, k), { kind: zone.get(v)!, color: 0, seed: seed(), tile: -1 });
  for (const [v, k, c] of storeys) if (!town.has(v, k)) town.cells.set(key(v, k), { kind: KIND_BUILDING, color: c, seed: seed(), tile: -1, style });
  // Mountain villages get stone bridges: a storey spanning the gap between two houses.
  if (mode === MODE_MOUNTAIN) {
    let bridges = 0;
    for (const v of isl) {
      if (bridges >= 2) break;
      for (let k = 2; k <= 6 && bridges < 2; k++) {
        if (town.has(v, k) || town.has(v, k - 1)) continue;
        const sides = g.edgeNbrs[v].filter((n) => town.isBuilding(n, k) && town.isBuilding(n, k - 1));
        if (sides.length >= 2 && !g.quadMates[sides[0]].includes(sides[1])) {
          town.cells.set(key(v, k), { kind: KIND_BUILDING, color: color(), seed: seed(), tile: -1, style });
          bridges++;
        }
      }
    }
  }
  town.solveAll();
}
