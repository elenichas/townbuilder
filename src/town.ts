/**
 * Town state: which voxels are filled, what kind they are (building or a land type),
 * their paint colour, seed and chosen tile. Also the bridge between the town and the
 * WFC solver (it implements `Csp`).
 *
 * Land is stacked in solid columns from level 0 up: the top of a column is the
 * ground surface, so a column two voxels high is a hill. Buildings sit on top of
 * land (or float, as bridges and overhangs).
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
  KIND_BUILDING,
  R_FLAT,
  R_HIP,
  R_NONE,
  R_STEEP,
  REL_IS,
  REL_SAME,
  REL_SI,
  ROOF_WEIGHT,
  T,
  W_ARCH,
  W_ROUND,
  W_SQUARE,
  WIN_WEIGHT,
  ZONE_MEADOW,
  ZONE_WATER,
  ZONE_WOODS,
  compat,
  decodeStorey,
  groundTile,
  isGroundTile,
  isZone,
  storeyTile,
  zoneTiles,
} from './tiles';
import { type Csp, type Nb, solve } from './wfc';

export const MAX_LEVEL = 14;
/** Highest level land can be raised to. */
export const MAX_HILL = 5;
export const key = (v: number, k: number) => v * 32 + k;
export const keyV = (key: number) => key >> 5;
export const keyK = (key: number) => key & 31;

export interface Voxel {
  /** KIND_BUILDING or a ZONE_* land type. */
  kind: number;
  color: number;
  seed: number;
  tile: number;
}

/** What an edit changed: `fill` = voxels added/removed or whose land type changed
 *  (neighbour geometry depends on these), `look` = voxels whose tile or colour changed. */
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
    return k >= 0 ? this.cells.get(key(v, k)) : undefined;
  }

  kindAt(v: number, k: number): number {
    return this.get(v, k)?.kind ?? -1;
  }

  isGround(v: number, k: number): boolean {
    return isZone(this.kindAt(v, k));
  }

  isBuilding(v: number, k: number): boolean {
    return this.kindAt(v, k) === KIND_BUILDING;
  }

  /** Level of the top of the solid land column at `v`, or -1 if there is no land. */
  groundTop(v: number): number {
    let k = -1;
    while (this.isGround(v, k + 1)) k++;
    return k;
  }

  /** Land at `v` whose surface is open to the sky (nothing built on it). */
  openGround(v: number): { level: number; zone: number } | null {
    const g = this.groundTop(v);
    if (g < 0 || this.has(v, g + 1)) return null;
    return { level: g, zone: this.kindAt(v, g) };
  }

  canPlace(v: number, k: number, kind = KIND_BUILDING): boolean {
    if (v < 0 || k < 0 || k > MAX_LEVEL || !this.grid.buildable[v] || this.has(v, k)) return false;
    if (kind === KIND_BUILDING) return k >= 1;
    return k === 0 || (k <= MAX_HILL && this.isGround(v, k - 1));
  }

  // ---------- CSP interface ----------

  seed(k: number): number {
    return this.cells.get(k)?.seed ?? 0;
  }

  compat(rel: number, a: number, b: number): boolean {
    return compat(rel, a, b);
  }

  /** Is the open land at `n` level `lvl` water? */
  private isOpenWater(n: number, lvl: number): boolean {
    return this.kindAt(n, lvl) === ZONE_WATER && !this.has(n, lvl + 1);
  }

  /** Can a storey at (v, k) have a door or shop: it stands on land and faces open, walkable land. */
  private canFront(v: number, k: number): boolean {
    if (!this.isGround(v, k - 1)) return false;
    return this.grid.edgeNbrs[v].some((n) => {
      const z = this.kindAt(n, k - 1);
      return isZone(z) && !this.has(n, k) && z !== ZONE_WATER && z !== ZONE_WOODS;
    });
  }

  allowed(kk: number): number[] {
    const v = keyV(kk);
    const lvl = keyK(kk);
    const g = this.grid;
    const kind = this.kindAt(v, lvl);
    if (isZone(kind)) {
      if (this.has(v, lvl + 1)) return [COVERED];
      let tiles = zoneTiles(kind);
      if (kind === ZONE_WATER) {
        const shore = g.edgeNbrs[v].some((n) => !this.isOpenWater(n, lvl));
        tiles = tiles.filter((t) => (t === T.reeds ? shore : t === T.boat ? !shore : true));
      }
      return tiles;
    }
    const top = !this.has(v, lvl + 1);
    const sideCount = g.edgeNbrs[v].filter((n) => this.isBuilding(n, lvl)).length;
    const hasWall = sideCount < g.edgeNbrs[v].length;
    const front = this.canFront(v, lvl);

    const roofs = top ? [R_HIP, R_FLAT, ...(sideCount <= 1 ? [R_STEEP] : [])] : [R_NONE];
    const wins = lvl >= 2 ? [W_SQUARE, W_ARCH, W_ROUND] : [W_SQUARE, W_ARCH];
    const feats = !hasWall
      ? [F_PLAIN]
      : [F_PLAIN, F_SHUTTERS, F_FLOWERS, ...(lvl >= 2 ? [F_BALCONY] : []), ...(front ? [F_DOOR, F_SHOP] : [])];
    const out: number[] = [];
    for (const w of wins) for (const f of feats) for (const r of roofs) out.push(storeyTile(w, f, r));
    return out;
  }

  weight(_k: number, t: number): number {
    if (t === COVERED) return 1;
    if (isGroundTile(t)) return groundTile(t)!.weight;
    const s = decodeStorey(t);
    return WIN_WEIGHT[s.win] * FEAT_WEIGHT[s.feat] * ROOF_WEIGHT[s.roof];
  }

  neighbors(kk: number): Nb[] {
    const v = keyV(kk);
    const lvl = keyK(kk);
    const out: Nb[] = [];
    const ground = this.isGround(v, lvl);
    for (const u of this.grid.quadMates[v]) {
      if (this.has(u, lvl) && this.isGround(u, lvl) === ground) out.push({ key: key(u, lvl), rel: REL_SAME });
    }
    if (ground) {
      if (!this.has(v, lvl + 1)) {
        for (const u of this.grid.edgeNbrs[v]) if (this.isBuilding(u, lvl + 1)) out.push({ key: key(u, lvl + 1), rel: REL_IS });
      }
    } else {
      for (const u of this.grid.edgeNbrs[v]) {
        if (this.isGround(u, lvl - 1) && !this.has(u, lvl)) out.push({ key: key(u, lvl - 1), rel: REL_SI });
      }
    }
    return out;
  }

  // ---------- editing ----------

  add(v: number, k: number, color: number, seed = randomSeed(), kind = KIND_BUILDING): Change | null {
    if (!this.canPlace(v, k, kind)) return null;
    const kk = key(v, k);
    this.cells.set(kk, { kind, color, seed, tile: -1 });
    const ch: Change = { fill: new Set([kk]), look: new Set([kk]) };
    this.resolve([kk], ch);
    return ch;
  }

  remove(v: number, k: number): Change | null {
    const kk = key(v, k);
    if (!this.cells.has(kk)) return null;
    // Land columns stay solid: only the top of a column can be dug away.
    if (this.isGround(v, k) && this.isGround(v, k + 1)) return null;
    this.cells.delete(kk);
    const ch: Change = { fill: new Set([kk]), look: new Set() };
    this.resolve([kk], ch);
    return ch;
  }

  /** Change the land type (meadow, woods, square, water) of a land voxel. */
  setZone(v: number, k: number, zone: number): Change | null {
    const kk = key(v, k);
    const cell = this.cells.get(kk);
    if (!cell || !isZone(cell.kind) || !isZone(zone) || cell.kind === zone) return null;
    cell.kind = zone;
    const ch: Change = { fill: new Set([kk]), look: new Set([kk]) };
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
    if (!cell || cell.kind !== KIND_BUILDING || cell.color === color) return null;
    cell.color = color;
    return { fill: new Set(), look: new Set([kk]) };
  }

  clear(): Change {
    const ch: Change = { fill: new Set(this.cells.keys()), look: new Set() };
    this.cells.clear();
    return ch;
  }

  /** Re-solve the whole town (used after loading or generating). */
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
    const addAt = (u: number, j: number) => {
      if (this.has(u, j)) R.add(key(u, j));
    };
    for (const e of edited) {
      const v = keyV(e);
      const k = keyK(e);
      const U = new Set<number>([v, ...g.quadMates[v]]);
      for (const u of [...U]) for (const w of g.quadMates[u]) U.add(w);
      for (const u of U) {
        for (let j = k - 1; j <= k + 1; j++) addAt(u, j);
        const gt = this.groundTop(u);
        addAt(u, gt);
        addAt(u, gt + 1);
      }
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
      if (!a || !b || a.kind !== b.kind) ch.fill.add(k);
      else if (a.tile !== b.tile || a.color !== b.color) ch.look.add(k);
    }
    this.cells = new Map([...snap].map(([k, c]) => [k, { ...c }]));
    return ch;
  }

  serialize(): string {
    const parts: string[] = [];
    for (const [k, c] of this.cells) {
      parts.push([keyV(k), keyK(k), c.color, c.seed, c.kind].map((x) => x.toString(36)).join('.'));
    }
    return 'c2:' + parts.join('_');
  }

  /** Replace contents from `serialize()` output (current or older format). Returns false if invalid. */
  load(data: string): boolean {
    const version = data.slice(0, 3);
    if (version !== 'c1:' && version !== 'c2:') return false;
    const cells = new Map<number, Voxel>();
    const body = data.slice(3);
    if (body) {
      for (const part of body.split('_')) {
        const nums = part.split('.').map((x) => parseInt(x, 36));
        const [v, k, c, s] = nums;
        if ([v, k, c, s].some((x) => !Number.isFinite(x))) return false;
        let kind = version === 'c1:' ? (k === 0 ? ZONE_MEADOW : KIND_BUILDING) : nums[4];
        if (!Number.isFinite(kind) || (kind !== KIND_BUILDING && !isZone(kind))) kind = k === 0 ? ZONE_MEADOW : KIND_BUILDING;
        if (v < 0 || v >= this.grid.pos.length || !this.grid.buildable[v] || k < 0 || k > MAX_LEVEL) continue;
        cells.set(key(v, k), { kind, color: c, seed: s >>> 0, tile: -1 });
      }
    }
    // Repair invalid stacks: land must rest on land, buildings never sit at level 0.
    for (const [kk, c] of [...cells].sort((a, b) => keyK(a[0]) - keyK(b[0]))) {
      const v = keyV(kk);
      const k = keyK(kk);
      if (isZone(c.kind) && k > 0 && !isZone(cells.get(key(v, k - 1))?.kind ?? -1)) c.kind = KIND_BUILDING;
      if (c.kind === KIND_BUILDING && k === 0) c.kind = ZONE_MEADOW;
    }
    this.cells = cells;
    this.solveAll();
    return true;
  }
}
