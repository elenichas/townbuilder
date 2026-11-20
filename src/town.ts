/**
 * Town state: which voxels are filled, their paint colour, seed and chosen tile.
 * Also the bridge between the town and the WFC solver (it implements `Csp`).
 */
import type { Grid } from './grid';
import { hash32, randomSeed } from './rng';
import {
  COVERED,
  F_BALCONY,
  F_DOOR,
  F_FLOWERS,
  F_PLAIN,
  F_SHOP,
  F_SHUTTERS,
  FEAT_WEIGHT,
  G_PLAZA,
  G_POND,
  GROUND,
  GROUND_WEIGHT,
  R_FLAT,
  R_HIP,
  R_NONE,
  R_STEEP,
  REL_IS,
  REL_SAME,
  REL_SI,
  ROOF_WEIGHT,
  W_ARCH,
  W_ROUND,
  W_SQUARE,
  WIN_WEIGHT,
  compat,
  decodeIsland,
  decodeStorey,
  islandTile,
  isIsland,
  storeyTile,
} from './tiles';
import { type Csp, type Nb, solve } from './wfc';

export const MAX_LEVEL = 14;
export const key = (v: number, k: number) => v * 32 + k;
export const keyV = (key: number) => key >> 5;
export const keyK = (key: number) => key & 31;

export interface Voxel {
  color: number;
  seed: number;
  tile: number;
}

/** What an edit changed: `fill` = voxels added/removed, `look` = voxels whose tile or colour changed. */
export interface Change {
  fill: Set<number>;
  look: Set<number>;
}

const COMPONENT_CAP = 240;

export class Town implements Csp {
  cells = new Map<number, Voxel>();

  constructor(readonly grid: Grid) {}

  has(v: number, k: number): boolean {
    return k >= 0 && this.cells.has(key(v, k));
  }

  get(v: number, k: number): Voxel | undefined {
    return this.cells.get(key(v, k));
  }

  canPlace(v: number, k: number): boolean {
    return v >= 0 && k >= 0 && k <= MAX_LEVEL && this.grid.buildable[v] && !this.has(v, k);
  }

  // ---------- CSP interface ----------

  seed(k: number): number {
    return this.cells.get(k)?.seed ?? 0;
  }

  compat(rel: number, a: number, b: number): boolean {
    return compat(rel, a, b);
  }

  /** True if an edge-neighbour of `v` is an open island with nothing built on it. */
  private hasOpenGroundNeighbour(v: number): boolean {
    return this.grid.edgeNbrs[v].some((n) => this.has(n, 0) && !this.has(n, 1));
  }

  allowed(k: number): number[] {
    const v = keyV(k);
    const lvl = keyK(k);
    const g = this.grid;
    if (lvl === 0) {
      if (this.has(v, 1)) return [COVERED];
      const nearStorey = g.edgeNbrs[v].some((n) => this.has(n, 1));
      const out: number[] = [];
      for (let gi = 0; gi < GROUND.length; gi++) {
        if (gi === G_POND && nearStorey) continue; // no ponds against walls
        out.push(islandTile(gi));
      }
      return out;
    }
    const top = !this.has(v, lvl + 1);
    const sideCount = g.edgeNbrs[v].filter((n) => this.has(n, lvl)).length;
    const hasWall = sideCount < g.edgeNbrs[v].length;
    const canFront = lvl === 1 && this.has(v, 0) && this.hasOpenGroundNeighbour(v);

    const roofs = top ? [R_HIP, R_FLAT, ...(sideCount <= 1 ? [R_STEEP] : [])] : [R_NONE];
    const wins = lvl >= 2 ? [W_SQUARE, W_ARCH, W_ROUND] : [W_SQUARE, W_ARCH];
    const feats = !hasWall
      ? [F_PLAIN]
      : [F_PLAIN, F_SHUTTERS, F_FLOWERS, ...(lvl >= 2 ? [F_BALCONY] : []), ...(canFront ? [F_DOOR, F_SHOP] : [])];
    const out: number[] = [];
    for (const w of wins) for (const f of feats) for (const r of roofs) out.push(storeyTile(w, f, r));
    return out;
  }

  weight(k: number, t: number): number {
    if (t === COVERED) return 1;
    if (isIsland(t)) {
      const gi = decodeIsland(t);
      if (gi === G_PLAZA) return this.grid.edgeNbrs[keyV(k)].some((n) => this.has(n, 1)) ? 3 : 0.4;
      return GROUND_WEIGHT[gi];
    }
    const s = decodeStorey(t);
    return WIN_WEIGHT[s.win] * FEAT_WEIGHT[s.feat] * ROOF_WEIGHT[s.roof];
  }

  neighbors(k: number): Nb[] {
    const v = keyV(k);
    const lvl = keyK(k);
    const out: Nb[] = [];
    for (const u of this.grid.quadMates[v]) if (this.has(u, lvl)) out.push({ key: key(u, lvl), rel: REL_SAME });
    if (lvl === 0 && !this.has(v, 1)) {
      for (const u of this.grid.edgeNbrs[v]) if (this.has(u, 1)) out.push({ key: key(u, 1), rel: REL_IS });
    } else if (lvl === 1) {
      for (const u of this.grid.edgeNbrs[v]) if (this.has(u, 0) && !this.has(u, 1)) out.push({ key: key(u, 0), rel: REL_SI });
    }
    return out;
  }

  // ---------- editing ----------

  add(v: number, k: number, color: number, seed = randomSeed()): Change | null {
    if (!this.canPlace(v, k)) return null;
    const kk = key(v, k);
    this.cells.set(kk, { color, seed, tile: -1 });
    const ch: Change = { fill: new Set([kk]), look: new Set([kk]) };
    this.resolve([kk], ch);
    return ch;
  }

  remove(v: number, k: number): Change | null {
    const kk = key(v, k);
    if (!this.cells.has(kk)) return null;
    this.cells.delete(kk);
    const ch: Change = { fill: new Set([kk]), look: new Set() };
    this.resolve([kk], ch);
    return ch;
  }

  /** Ask for a different version of this piece. Neighbours re-solve so everything still fits. */
  reroll(v: number, k: number): Change | null {
    const kk = key(v, k);
    const cell = this.cells.get(kk);
    if (!cell) return null;
    const old = cell.tile;
    cell.seed = hash32(cell.seed, 0x5eed);
    const ch: Change = { fill: new Set(), look: new Set() };
    this.resolve([kk], ch, { first: kk, exclude: old });
    return ch;
  }

  paint(v: number, k: number, color: number): Change | null {
    const kk = key(v, k);
    const cell = this.cells.get(kk);
    if (!cell || cell.color === color) return null;
    cell.color = color;
    return { fill: new Set(), look: new Set([kk]) };
  }

  clear(): Change {
    const ch: Change = { fill: new Set(this.cells.keys()), look: new Set() };
    this.cells.clear();
    return ch;
  }

  /** Re-solve the whole town (used after loading). */
  solveAll(): void {
    const all = new Set(this.cells.keys());
    const res = solve(this, all, () => undefined);
    if (res) this.applyTiles(res, null);
    else this.fallback(all, null);
  }

  // ---------- solving ----------

  /** Voxels whose context (and therefore allowed tiles) may have changed after editing `edited`. */
  private baseRegion(edited: number[]): Set<number> {
    const R = new Set<number>();
    const g = this.grid;
    for (const e of edited) {
      const v = keyV(e);
      const k = keyK(e);
      const U = new Set<number>([v, ...g.quadMates[v]]);
      for (const u of [...U]) for (const w of g.quadMates[u]) U.add(w);
      const levels = new Set([k - 1, k, k + 1]);
      if (k <= 2) {
        levels.add(0);
        levels.add(1);
      }
      for (const u of U) for (const j of levels) if (this.has(u, j)) R.add(key(u, j));
    }
    return R;
  }

  /** Grow a region to whole same-level connected components (equality constraints chain along them). */
  private components(seedKeys: Iterable<number>, cap = Infinity): Set<number> {
    const out = new Set<number>();
    const stack = [...seedKeys].filter((k) => this.cells.has(k));
    for (const k of stack) out.add(k);
    while (stack.length && out.size < cap) {
      const k = stack.pop()!;
      for (const n of this.neighbors(k)) {
        if (n.rel === REL_SAME && !out.has(n.key)) {
          out.add(n.key);
          stack.push(n.key);
        }
      }
    }
    return out;
  }

  private resolve(edited: number[], ch: Change, opts: { first?: number; exclude?: number } = {}): void {
    const fixed = (k: number) => this.cells.get(k)?.tile;
    const base = this.baseRegion(edited);
    const attempts: Set<number>[] = [];
    if (opts.first !== undefined) {
      const comp = this.components([opts.first], COMPONENT_CAP);
      if (comp.size < COMPONENT_CAP) attempts.push(new Set([...base, ...comp]));
    }
    attempts.push(base, this.components(base), new Set(this.cells.keys()));
    for (const region of attempts) {
      const res = solve(this, region, fixed, opts);
      if (res) {
        this.applyTiles(res, ch);
        return;
      }
    }
    this.fallback(new Set(this.cells.keys()), ch);
  }

  private applyTiles(res: Map<number, number>, ch: Change | null): void {
    for (const [k, t] of res) {
      const cell = this.cells.get(k)!;
      if (cell.tile !== t) {
        cell.tile = t;
        ch?.look.add(k);
      }
    }
  }

  /** Last resort if the constraints ever can't be met: take the first allowed tile. */
  private fallback(keys: Set<number>, ch: Change | null): void {
    for (const k of keys) {
      const cell = this.cells.get(k)!;
      const t = this.allowed(k)[0];
      if (cell.tile !== t) {
        cell.tile = t;
        ch?.look.add(k);
      }
    }
  }

  // ---------- history & persistence ----------

  snapshot(): Map<number, Voxel> {
    const m = new Map<number, Voxel>();
    for (const [k, c] of this.cells) m.set(k, { ...c });
    return m;
  }

  restore(snap: Map<number, Voxel>): Change {
    const ch: Change = { fill: new Set(), look: new Set() };
    for (const k of new Set([...this.cells.keys(), ...snap.keys()])) {
      const a = this.cells.get(k);
      const b = snap.get(k);
      if (!a || !b) ch.fill.add(k);
      else if (a.tile !== b.tile || a.color !== b.color) ch.look.add(k);
    }
    this.cells = new Map([...snap].map(([k, c]) => [k, { ...c }]));
    return ch;
  }

  serialize(): string {
    const parts: string[] = [];
    for (const [k, c] of this.cells) parts.push(`${keyV(k).toString(36)}.${keyK(k).toString(36)}.${c.color.toString(36)}.${c.seed.toString(36)}`);
    return 'c1:' + parts.join('_');
  }

  /** Replace contents from `serialize()` output. Returns false if the data is invalid. */
  load(data: string): boolean {
    if (!data.startsWith('c1:')) return false;
    const cells = new Map<number, Voxel>();
    const body = data.slice(3);
    if (body) {
      for (const part of body.split('_')) {
        const [v, k, c, s] = part.split('.').map((x) => parseInt(x, 36));
        if ([v, k, c, s].some((x) => !Number.isFinite(x))) return false;
        if (v < 0 || v >= this.grid.pos.length || !this.grid.buildable[v] || k < 0 || k > MAX_LEVEL) continue;
        cells.set(key(v, k), { color: c, seed: s >>> 0, tile: -1 });
      }
    }
    this.cells = cells;
    this.solveAll();
    return true;
  }
}

