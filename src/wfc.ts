/**
 * Wave Function Collapse on an arbitrary graph.
 *
 * Variables are keys (voxels), each with a domain of possible tiles. The solver:
 *   1. starts every variable in the region with all tiles its context allows,
 *   2. propagates adjacency constraints (arc consistency) — including from fixed
 *      neighbours outside the region,
 *   3. repeatedly collapses the variable with the fewest options to one tile, picked
 *      with a seeded weighted choice, and propagates again.
 *
 * The weighted choice uses an "exponential race": every (seed, tile) pair gets a fixed
 * random score, and the best allowed score wins. This makes the result stable — removing
 * some other option never changes the winner — so editing one building doesn't reshuffle
 * the rest of the town.
 */
import { hash01 } from './rng';
import { revRel } from './tiles';

export interface Nb {
  key: number;
  rel: number;
}

export interface Csp {
  allowed(key: number): number[];
  weight(key: number, tile: number): number;
  neighbors(key: number): Nb[];
  compat(rel: number, a: number, b: number): boolean;
  seed(key: number): number;
}

export interface SolveOptions {
  /** Collapse this variable first (used for re-rolling). */
  first?: number;
  /** Tile `first` must not end up as, if any alternative exists. */
  exclude?: number;
}

export function solve(
  csp: Csp,
  region: Iterable<number>,
  fixed: (key: number) => number | undefined,
  opts: SolveOptions = {},
): Map<number, number> | null {
  const D = new Map<number, number[]>();
  for (const k of region) {
    let d = csp.allowed(k);
    if (opts.first === k && opts.exclude !== undefined) {
      const f = d.filter((t) => t !== opts.exclude);
      if (f.length) d = f;
    }
    if (!d.length) return null;
    D.set(k, d);
  }

  const nbCache = new Map<number, Nb[]>();
  const nbs = (k: number) => {
    let n = nbCache.get(k);
    if (!n) {
      n = csp.neighbors(k);
      nbCache.set(k, n);
    }
    return n;
  };
  const dom = (k: number): number[] | null => {
    const d = D.get(k);
    if (d) return d;
    const f = fixed(k);
    return f === undefined || f < 0 ? null : [f];
  };

  const propagate = (start: Iterable<number>): boolean => {
    const queue = [...start];
    const queued = new Set(queue);
    while (queue.length) {
      const x = queue.pop()!;
      queued.delete(x);
      const dx = dom(x);
      if (!dx) continue;
      for (const { key: y, rel } of nbs(x)) {
        const dy = D.get(y);
        if (!dy) continue;
        const r = revRel(rel);
        const keep = dy.filter((b) => dx.some((a) => csp.compat(r, b, a)));
        if (keep.length !== dy.length) {
          if (!keep.length) return false;
          D.set(y, keep);
          if (!queued.has(y)) {
            queue.push(y);
            queued.add(y);
          }
        }
      }
    }
    return true;
  };

  const start = new Set<number>(D.keys());
  for (const k of D.keys()) for (const n of nbs(k)) if (!D.has(n.key)) start.add(n.key);
  if (!propagate(start)) return null;

  const vars = [...D.keys()];
  const tieBreak = new Map(vars.map((k) => [k, hash01(csp.seed(k), 99) * 0.5]));
  for (;;) {
    let best = -1;
    if (opts.first !== undefined && (D.get(opts.first)?.length ?? 0) > 1) {
      best = opts.first;
    } else {
      let bestScore = Infinity;
      for (const k of vars) {
        const len = D.get(k)!.length;
        if (len <= 1) continue;
        const s = len + tieBreak.get(k)!;
        if (s < bestScore) {
          bestScore = s;
          best = k;
        }
      }
    }
    if (best < 0) break;

    const d = D.get(best)!;
    const seed = csp.seed(best);
    let pick = d[0];
    let bestRace = Infinity;
    for (const t of d) {
      const w = csp.weight(best, t);
      if (w <= 0) continue;
      const race = -Math.log(hash01(seed, t) + 1e-12) / w;
      if (race < bestRace) {
        bestRace = race;
        pick = t;
      }
    }
    D.set(best, [pick]);
    if (!propagate([best])) return null;
  }

  const out = new Map<number, number>();
  for (const [k, d] of D) out.set(k, d[0]);
  return out;
}
