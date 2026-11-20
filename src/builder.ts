/**
 * Procedural "modules": turns one voxel (plus the fill state around it and the tile WFC
 * chose) into geometry. Nothing is modelled by hand. Every piece is built directly
 * on the irregular dual cell, so it fits the grid without needing to be warped.
 *
 * A storey is made of wall segments wherever a neighbouring quarter is empty, a roof
 * whose height field rises away from the eaves, arches where it overhangs open space,
 * and the facade details (windows, doors, shops, balconies) its tile asks for.
 */
import * as THREE from 'three';
import { Geo, MAT_BASE, MAT_DARK, MAT_LIT, type V3 } from './geo';
import type { Quarter, Vec2 } from './grid';
import { AWNING, COL, FLOWER, SHUTTER, WALL, mix, shade } from './palette';
import { hash01, hash32 } from './rng';
import {
  F_BALCONY,
  F_DOOR,
  F_FLOWERS,
  F_SHOP,
  F_SHUTTERS,
  N_STOREY,
  R_FLAT,
  R_HIP,
  R_NONE,
  R_STEEP,
  type StoreyStyle,
  T,
  W_ARCH,
  W_ROUND,
  W_SQUARE,
  ZONE_PLAZA,
  ZONE_WATER,
  ZONE_WOODS,
  decodeStorey,
  isZone,
} from './tiles';
import { type Town, type Voxel, keyK, keyV } from './town';

/** Storey height. Grid cells are ~1 unit across. */
export const H = 0.62;
/** Depth of the island cliff before the rocky underside starts. */
export const ISLAND_D = 0.28;

/** Picking actions stored per vertex: >0 means "build sideways toward vertex act-1". */
export const ACT_UP = 0;
export const ACT_DOWN = -1;
export const ACT_NONE = -2;

export const levelBottom = (k: number) => (k === 0 ? -ISLAND_D : (k - 1) * H);
export const levelTop = (k: number) => (k === 0 ? 0 : k * H);

type P2 = [number, number];

interface Seg {
  A: Vec2;
  B: Vec2;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  len: number;
  target: number;
  /** Grid vertices sharing the wall's end points (for terrain heights). */
  ownersA: number[];
  ownersB: number[];
}

function mkSeg(A: Vec2, B: Vec2, Q: Quarter, target: number, ownersA: number[] = [], ownersB: number[] = []): Seg {
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  const len = Math.hypot(dx, dz) || 1e-6;
  const tx = dx / len;
  const tz = dz / len;
  let nx = tz;
  let nz = -tx;
  const cx = (Q.P0.x + Q.P1.x + Q.P2.x + Q.P3.x) / 4;
  const cz = (Q.P0.z + Q.P1.z + Q.P2.z + Q.P3.z) / 4;
  if ((cx - (A.x + B.x) / 2) * nx + (cz - (A.z + B.z) / 2) * nz > 0) {
    nx = -nx;
    nz = -nz;
  }
  return { A, B, tx, tz, nx, nz, len, target, ownersA, ownersB };
}

/** Point on a wall: `u` along it, height `y`, `d` outward from its face. */
const at = (s: Seg, u: number, y: number, d: number): V3 => [s.A.x + s.tx * u + s.nx * d, y, s.A.z + s.tz * u + s.nz * d];

function segBox(g: Geo, s: Seg, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, col: THREE.Color, top = col) {
  g.boxFromCorners(
    [at(s, u0, y0, d0), at(s, u1, y0, d0), at(s, u1, y0, d1), at(s, u0, y0, d1), at(s, u0, y1, d0), at(s, u1, y1, d0), at(s, u1, y1, d1), at(s, u0, y1, d1)],
    col,
    top,
  );
}

function segShape(g: Geo, s: Seg, cu: number, cy: number, pts: P2[], d: number, col: THREE.Color) {
  const c = at(s, cu, cy, d);
  const vs = pts.map(([u, y]) => at(s, cu + u, cy + y, d));
  for (let i = 0; i < vs.length; i++) g.tri(c, vs[i], vs[(i + 1) % vs.length], col);
}

const rect = (w: number, h: number): P2[] => [
  [-w / 2, -h / 2],
  [w / 2, -h / 2],
  [w / 2, h / 2],
  [-w / 2, h / 2],
];
function archShape(w: number, h: number): P2[] {
  const r = w / 2;
  const pts: P2[] = [
    [-r, -h / 2],
    [r, -h / 2],
  ];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    pts.push([Math.cos(a) * r, h / 2 - r + Math.sin(a) * r]);
  }
  return pts;
}
const circle = (r: number, n = 12): P2[] => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r] as P2);
const scalePts = (pts: P2[], sx: number, sy = sx): P2[] => pts.map(([x, y]) => [x * sx, y * sy]);

const LAMP = new THREE.Color('#ffe3a3');
const BRICK = new THREE.Color('#b8604c');
const ROOF_HIP = [COL.roofHip, new THREE.Color('#c25b4c'), new THREE.Color('#dc8b52')];

export function buildVoxel(town: Town, kk: number): { geometry: THREE.BufferGeometry; origin: V3 } | null {
  const cell = town.cells.get(kk);
  if (!cell) return null;
  const v = keyV(kk);
  const k = keyK(kk);
  const p = town.grid.pos[v];
  const origin: V3 = [p.x, k === 0 ? 0 : (k - 1) * H, p.z];
  const g = new Geo(...origin);
  if (isZone(cell.kind)) buildGround(town, v, k, cell, g);
  else buildStorey(town, v, k, cell, g);
  const geometry = g.build();
  return geometry ? { geometry, origin } : null;
}

// ---------------------------------------------------------------- storeys

function buildStorey(town: Town, v: number, k: number, cell: Voxel, g: Geo) {
  const grid = town.grid;
  const has = (u: number, j: number) => town.has(u, j);
  const top = !has(v, k + 1);
  const st: StoreyStyle =
    cell.tile >= 0 && cell.tile < N_STOREY ? decodeStorey(cell.tile) : { win: W_SQUARE, feat: 0, roof: top ? R_HIP : R_NONE };
  const seed = cell.seed;
  const wall = WALL[cell.color % WALL.length];
  const y0 = (k - 1) * H;
  const y1 = k * H;
  const below = has(v, k - 1);
  const belowGround = town.isGround(v, k - 1);
  const bld = (u: number, j: number) => town.isBuilding(u, j);
  const qs = grid.quarters[v];

  const segs: Seg[] = [];
  for (const Q of qs) {
    if (!bld(Q.n1, k)) segs.push(mkSeg(Q.P1, Q.P2, Q, Q.n1, [v, Q.n1], [v, Q.n1, Q.n2, Q.n3]));
    if (!bld(Q.n3, k)) segs.push(mkSeg(Q.P2, Q.P3, Q, Q.n3, [v, Q.n1, Q.n2, Q.n3], [v, Q.n3]));
  }
  const trim = mix(wall, COL.trim, 0.6);
  const wallLow = shade(wall, belowGround ? 0.8 : 0.92);

  // Walls, storey bands and plinth.
  for (const s of segs) {
    g.act = s.target + 1;
    g.quad(at(s, 0, y0, 0), at(s, s.len, y0, 0), at(s, s.len, y1, 0), at(s, 0, y1, 0), wallLow, wallLow, wall, wall);
    segBox(g, s, -0.01, s.len + 0.01, y1 - 0.045, y1, 0, 0.03, trim);
    if (belowGround) {
      segBox(g, s, -0.01, s.len + 0.01, y0, y0 + 0.07, 0, 0.022, COL.stone);
      // Stone foundation down to where the ground falls away on a slope.
      const hA = Math.min(y0, pointHeight(town, s.ownersA));
      const hB = Math.min(y0, pointHeight(town, s.ownersB));
      if (hA < y0 - 0.01 || hB < y0 - 0.01) {
        const st = shade(COL.stone, 0.9);
        g.quad([s.A.x, hA - 0.02, s.A.z], [s.B.x, hB - 0.02, s.B.z], [s.B.x, y0, s.B.z], [s.A.x, y0, s.A.z], shade(st, 0.85), shade(st, 0.85), st, st);
      }
    }
  }

  // Overhang: a vaulted underside that dips down onto neighbouring walls (arches),
  // or a pillar when it floats free above something.
  if (!below) {
    const DIP = 0.26;
    const dipAt = (...owners: number[]) => (owners.some((u) => has(u, k - 1)) ? -DIP : 0);
    const soffit = shade(wall, 0.72);
    let anyDip = false;
    for (const Q of qs) {
      const h1 = dipAt(Q.n1);
      const h2 = dipAt(Q.n1, Q.n2, Q.n3);
      const h3 = dipAt(Q.n3);
      if (h1 || h2 || h3) anyDip = true;
      const p0: V3 = [Q.P0.x, y0, Q.P0.z];
      const p1: V3 = [Q.P1.x, y0 + h1, Q.P1.z];
      const p2: V3 = [Q.P2.x, y0 + h2, Q.P2.z];
      const p3: V3 = [Q.P3.x, y0 + h3, Q.P3.z];
      g.act = ACT_DOWN;
      g.tri(p0, p1, p2, soffit);
      g.tri(p0, p2, p3, soffit);
      if (!bld(Q.n1, k) && (h1 || h2)) {
        g.act = Q.n1 + 1;
        g.quad(p1, p2, [Q.P2.x, y0, Q.P2.z], [Q.P1.x, y0, Q.P1.z], wallLow);
      }
      if (!bld(Q.n3, k) && (h2 || h3)) {
        g.act = Q.n3 + 1;
        g.quad(p2, p3, [Q.P3.x, y0, Q.P3.z], [Q.P2.x, y0, Q.P2.z], wallLow);
      }
    }
    if (!anyDip && k >= 2) {
      for (let j = k - 2; j >= 0; j--) {
        if (has(v, j)) {
          g.act = ACT_DOWN;
          g.cylinder(qs[0].P0.x, qs[0].P0.z, j * H, y0, 0.055, 7, COL.stone);
          break;
        }
      }
    }
  }

  // Facade details.
  const idx = segs.map((_, i) => i);
  const walkable = (n: number) => {
    const z = town.kindAt(n, k - 1);
    return isZone(z) && z !== ZONE_WATER && z !== ZONE_WOODS && !has(n, k);
  };
  const fronts = belowGround ? idx.filter((i) => walkable(segs[i].target)) : [];
  let doorSeg = -1;
  let balcSeg = -1;
  const shopSegs = new Set<number>();
  if (st.feat === F_DOOR && fronts.length) doorSeg = fronts[hash32(seed, 7) % fronts.length];
  if (st.feat === F_SHOP) for (const i of fronts) if (segs[i].len > 0.3) shopSegs.add(i);
  if (st.feat === F_BALCONY) {
    const c = idx.filter((i) => segs[i].len > 0.34);
    if (c.length) balcSeg = c[hash32(seed, 11) % c.length];
  }
  segs.forEach((s, i) => {
    g.act = s.target + 1;
    if (i === doorSeg) drawDoor(g, s, y0);
    else if (shopSegs.has(i)) drawShop(g, s, y0, seed);
    else if (i === balcSeg) drawBalcony(g, s, y0, seed);
    else if (s.len >= 0.3) drawWindow(g, s, y0, st, seed, i);
  });

  // Roof.
  if (top) {
    g.act = ACT_UP;
    if (st.roof === R_FLAT) {
      for (const Q of qs) g.poly([Q.P0, Q.P1, Q.P2, Q.P3].map((P) => [P.x, y1 + 0.004, P.z] as V3), COL.terrace);
      for (const s of segs) segBox(g, s, -0.02, s.len + 0.02, y1, y1 + 0.12, -0.045, 0.012, shade(wall, 0.97), trim);
      const P0 = qs[0].P0;
      const r = hash01(seed, 31);
      if (r < 0.35) {
        g.cylinder(P0.x, P0.z, y1, y1 + 0.08, 0.05, 6, COL.wood, 0.06);
        g.blob(P0.x, y1 + 0.17, P0.z, 0.1, COL.leaf[hash32(seed, 32) % 3]);
      } else if (r < 0.65) {
        const ac = AWNING[hash32(seed, 33) % AWNING.length];
        g.cylinder(P0.x, P0.z, y1, y1 + 0.3, 0.012, 4, COL.trim);
        g.cylinder(P0.x, P0.z, y1 + 0.24, y1 + 0.34, 0.2, 8, ac, 0, false);
      }
    } else {
      const ridge = st.roof === R_STEEP ? 0.85 : 0.34;
      const rc = st.roof === R_STEEP ? COL.roofSteep[st.win % 3] : ROOF_HIP[st.win % 3];
      for (const Q of qs) {
        const f1 = bld(Q.n1, k);
        const f3 = bld(Q.n3, k);
        const h1 = f1 ? ridge : 0;
        const h3 = f3 ? ridge : 0;
        const h2 = f1 && f3 && bld(Q.n2, k) ? ridge : 0;
        const p0: V3 = [Q.P0.x, y1 + ridge, Q.P0.z];
        const p1: V3 = [Q.P1.x, y1 + h1, Q.P1.z];
        const p2: V3 = [Q.P2.x, y1 + h2, Q.P2.z];
        const p3: V3 = [Q.P3.x, y1 + h3, Q.P3.z];
        g.tri(p0, p1, p2, rc);
        g.tri(p0, p2, p3, shade(rc, 0.97));
      }
      const eave = shade(rc, 0.82);
      for (const s of segs) g.quad(at(s, 0, y1, 0), at(s, s.len, y1, 0), at(s, s.len + 0.04, y1 - 0.06, 0.11), at(s, -0.04, y1 - 0.06, 0.11), eave);

      if (st.roof === R_HIP && hash01(seed, 41) < 0.4) {
        const Q = qs[hash32(seed, 42) % qs.length];
        const x = Q.P0.x + (Q.P2.x - Q.P0.x) * 0.45;
        const z = Q.P0.z + (Q.P2.z - Q.P0.z) * 0.45;
        g.box(x, z, 0.045, 0.045, y1, y1 + ridge + 0.12, BRICK, shade(BRICK, 0.7));
      }
      const sideCount = grid.edgeNbrs[v].filter((n) => bld(n, k)).length;
      if (st.roof === R_STEEP && sideCount === 0) {
        const P0 = qs[0].P0;
        const yt = y1 + ridge;
        g.cylinder(P0.x, P0.z, yt - 0.05, yt + 0.26, 0.012, 4, COL.iron);
        const fc = COL.flag[hash32(seed, 43) % COL.flag.length];
        const ang = hash01(seed, 44) * Math.PI * 2;
        g.tri([P0.x, yt + 0.26, P0.z], [P0.x, yt + 0.17, P0.z], [P0.x + Math.cos(ang) * 0.15, yt + 0.215, P0.z + Math.sin(ang) * 0.15], fc);
      }
    }
  }
}

function drawWindow(g: Geo, s: Seg, y0: number, st: StoreyStyle, seed: number, i: number) {
  const cu = s.len / 2;
  const cy = y0 + 0.35;
  const w = 0.15;
  let h: number;
  let shape: P2[];
  if (st.win === W_ROUND) {
    h = 0.15;
    shape = circle(0.075);
  } else if (st.win === W_ARCH) {
    h = 0.23;
    shape = archShape(w, h);
  } else {
    h = 0.21;
    shape = rect(w, h);
  }
  g.mat = MAT_BASE;
  segShape(g, s, cu, cy, scalePts(shape, 1.3, 1.2), 0.006, COL.trim);
  g.mat = hash01(seed, i, 3) < 0.62 ? MAT_LIT : MAT_DARK;
  segShape(g, s, cu, cy, shape, 0.011, COL.glass);
  g.mat = MAT_BASE;
  if (st.win === W_SQUARE) {
    segBox(g, s, cu - 0.008, cu + 0.008, cy - h / 2, cy + h / 2, 0.011, 0.016, COL.trim);
    segBox(g, s, cu - w / 2, cu + w / 2, cy - 0.008, cy + 0.008, 0.011, 0.016, COL.trim);
  }
  segBox(g, s, cu - w * 0.75, cu + w * 0.75, cy - h / 2 - 0.04, cy - h / 2 - 0.015, 0, 0.045, COL.trim);
  if (st.feat === F_SHUTTERS) {
    const sc = SHUTTER[hash32(seed, 5) % SHUTTER.length];
    for (const side of [-1, 1]) segShape(g, s, cu + side * (w * 0.65 + w * 0.27), cy, rect(w * 0.5, h * 1.05), 0.012, sc);
  }
  if (st.feat === F_FLOWERS) {
    segBox(g, s, cu - w * 0.7, cu + w * 0.7, cy - h / 2 - 0.1, cy - h / 2 - 0.045, 0, 0.075, COL.wood);
    for (let j = 0; j < 4; j++) {
      const p = at(s, cu - w * 0.55 + j * w * 0.37, cy - h / 2 - 0.035, 0.045);
      g.blob(p[0], p[1], p[2], 0.032, FLOWER[hash32(seed, i, j) % FLOWER.length]);
    }
  }
}

function drawDoor(g: Geo, s: Seg, y0: number) {
  const cu = s.len / 2;
  const w = 0.19;
  const h = 0.36;
  const cy = y0 + h / 2 + 0.035;
  segShape(g, s, cu, cy + 0.01, scalePts(archShape(w, h), 1.25, 1.1), 0.006, COL.trim);
  segShape(g, s, cu, cy, archShape(w, h), 0.012, COL.wood);
  const knob = at(s, cu + w * 0.28, cy, 0.02);
  g.blob(knob[0], knob[1], knob[2], 0.013, COL.iron);
  segBox(g, s, cu - 0.15, cu + 0.15, y0, y0 + 0.035, 0, 0.1, COL.stone);
  g.mat = MAT_LIT;
  const lamp = at(s, cu + w * 0.5 + 0.07, cy + 0.12, 0.03);
  g.blob(lamp[0], lamp[1], lamp[2], 0.028, LAMP);
  g.mat = MAT_BASE;
}

function drawShop(g: Geo, s: Seg, y0: number, seed: number) {
  const cu = s.len / 2;
  const hw = Math.min(s.len * 0.38, 0.2);
  segShape(g, s, cu, y0 + 0.22, rect(hw * 2 + 0.04, 0.3), 0.006, COL.trim);
  g.mat = MAT_LIT;
  segShape(g, s, cu, y0 + 0.22, rect(hw * 2, 0.26), 0.011, COL.glass);
  g.mat = MAT_BASE;
  const ac = AWNING[hash32(seed, 13) % AWNING.length];
  const u0 = cu - hw - 0.03;
  const u1 = cu + hw + 0.03;
  const n = 4;
  for (let j = 0; j < n; j++) {
    const a = u0 + ((u1 - u0) * j) / n;
    const b = u0 + ((u1 - u0) * (j + 1)) / n;
    g.quad(at(s, a, y0 + 0.47, 0.005), at(s, b, y0 + 0.47, 0.005), at(s, b, y0 + 0.39, 0.17), at(s, a, y0 + 0.39, 0.17), j % 2 ? COL.trim : ac);
  }
  g.quad(at(s, u0, y0 + 0.39, 0.17), at(s, u1, y0 + 0.39, 0.17), at(s, u1, y0 + 0.35, 0.17), at(s, u0, y0 + 0.35, 0.17), ac);
}

function drawBalcony(g: Geo, s: Seg, y0: number, seed: number) {
  const cu = s.len / 2;
  const hw = Math.min(s.len * 0.42, 0.22);
  segShape(g, s, cu, y0 + 0.21, rect(0.19, 0.36), 0.006, COL.trim);
  g.mat = hash01(seed, 21) < 0.6 ? MAT_LIT : MAT_DARK;
  segShape(g, s, cu, y0 + 0.2, rect(0.15, 0.32), 0.011, COL.glass);
  g.mat = MAT_BASE;
  segBox(g, s, cu - hw, cu + hw, y0, y0 + 0.035, 0, 0.17, COL.stone);
  segBox(g, s, cu - hw, cu + hw, y0 + 0.16, y0 + 0.18, 0.15, 0.17, COL.trim);
  segBox(g, s, cu - hw, cu - hw + 0.02, y0 + 0.16, y0 + 0.18, 0, 0.17, COL.trim);
  segBox(g, s, cu + hw - 0.02, cu + hw, y0 + 0.16, y0 + 0.18, 0, 0.17, COL.trim);
  for (let j = 0; j <= 4; j++) {
    const u = cu - hw + 0.01 + ((2 * hw - 0.02) * j) / 4;
    segBox(g, s, u - 0.008, u + 0.008, y0 + 0.035, y0 + 0.16, 0.152, 0.168, COL.trim);
  }
  const p = at(s, cu + hw * 0.6, y0 + 0.08, 0.09);
  g.blob(p[0], p[1], p[2], 0.045, COL.leaf[hash32(seed, 22) % 3]);
}

// ---------------------------------------------------------------- terrain

/** How far a lake bed sits below the land level, and the water surface below it. */
export const WATER_DIP = 0.22;
export const WATER_LEVEL = 0.1;

const colTop = (town: Town, u: number): number | null => {
  const g = town.groundTop(u);
  return g < 0 ? null : g * H;
};
const isWaterCol = (town: Town, u: number): boolean => {
  const g = town.groundTop(u);
  return g >= 0 && town.kindAt(u, g) === ZONE_WATER && !town.has(u, g + 1);
};

/**
 * Height of the ground at a point shared by the cells of `owners`. Every cell sharing the
 * point computes the same value, so neighbouring terrain always joins without cracks.
 * Land averages its neighbours (smooth hills); water pulls shared points down into a
 * basin, unless that would let the lake spill over lower ground, in which case it
 * becomes a rim that holds the water in.
 */
export function pointHeight(town: Town, owners: number[]): number {
  let sum = 0;
  let n = 0;
  let allGrounded = true;
  let wMax = -Infinity;
  let wMin = Infinity;
  let landMin = Infinity;
  for (const u of owners) {
    const t = colTop(town, u);
    if (t === null) {
      allGrounded = false;
      continue;
    }
    sum += t;
    n++;
    if (isWaterCol(town, u)) {
      wMax = Math.max(wMax, t);
      wMin = Math.min(wMin, t);
    } else landMin = Math.min(landMin, t);
  }
  if (!n) return 0;
  if (wMax > -Infinity) {
    if (allGrounded && wMin === wMax && landMin >= wMax - 1e-6) return wMax - WATER_DIP;
    return wMax;
  }
  return sum / n;
}

interface Pt {
  x: number;
  z: number;
  qi: number;
}

function randomPoint(qs: Quarter[], seed: number, j: number, lo = 0.15, hi = 0.85): Pt {
  const qi = hash32(seed, j, 1) % qs.length;
  const Q = qs[qi];
  const u = lo + (hi - lo) * hash01(seed, j, 2);
  const w = lo + (hi - lo) * hash01(seed, j, 3);
  const a = (1 - u) * (1 - w);
  const b = u * (1 - w);
  const c = u * w;
  const d = (1 - u) * w;
  return { x: Q.P0.x * a + Q.P1.x * b + Q.P2.x * c + Q.P3.x * d, z: Q.P0.z * a + Q.P1.z * b + Q.P2.z * c + Q.P3.z * d, qi };
}

/** Height on the triangulated surface of quarter Q with corner heights h. */
function surfY(Q: Quarter, h: number[], x: number, z: number): number {
  const tri = (a: Vec2, b: Vec2, c: Vec2, ha: number, hb: number, hc: number): number | null => {
    const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(d) < 1e-9) return null;
    const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
    const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) return null;
    return l1 * ha + l2 * hb + l3 * hc;
  };
  return tri(Q.P0, Q.P1, Q.P2, h[0], h[1], h[2]) ?? tri(Q.P0, Q.P2, Q.P3, h[0], h[2], h[3]) ?? (h[0] + h[1] + h[2] + h[3]) / 4;
}

const WOODS_FLOOR = new THREE.Color('#7fb862');
const SAND = new THREE.Color('#d6c79c');
const REED = new THREE.Color('#a2b45a');
const MUSHROOM = new THREE.Color('#e0503f');
const ROCK_GREY = new THREE.Color('#b9b4ad');

function pine(g: Geo, x: number, y: number, z: number, s: number) {
  g.cylinder(x, z, y, y + 0.2 * s, 0.04 * s, 5, COL.trunk, 0.03 * s);
  for (let i = 0; i < 3; i++) {
    const yy = y + (0.16 + i * 0.15) * s;
    g.cylinder(x, z, yy, yy + 0.27 * s, (0.25 - i * 0.065) * s, 7, COL.pine, 0, false);
  }
}

function oak(g: Geo, x: number, y: number, z: number, s: number, seed: number) {
  g.cylinder(x, z, y, y + 0.22 * s, 0.045 * s, 6, COL.trunk, 0.035 * s);
  const lc = COL.leaf[hash32(seed, 51) % 3];
  g.blob(x, y + 0.42 * s, z, 0.25 * s, lc, 0.9);
  g.blob(x + 0.1 * s, y + 0.6 * s, z - 0.05 * s, 0.17 * s, shade(lc, 1.08));
  g.blob(x - 0.12 * s, y + 0.34 * s, z + 0.08 * s, 0.15 * s, shade(lc, 0.92));
}

function buildGround(town: Town, v: number, k: number, cell: Voxel, g: Geo) {
  const grid = town.grid;
  const qs = grid.quarters[v];
  const seed = cell.seed;
  const D = ISLAND_D;
  const P0 = qs[0].P0;
  const isTop = !town.isGround(v, k + 1);

  if (isTop) {
    const covered = town.has(v, k + 1);
    const zone = cell.kind;
    const water = isWaterCol(town, v);
    const y = k * H;
    const h0 = water ? y - WATER_DIP : y;
    const heights = qs.map((Q) => [
      h0,
      pointHeight(town, [v, Q.n1]),
      pointHeight(town, [v, Q.n1, Q.n2, Q.n3]),
      pointHeight(town, [v, Q.n3]),
    ]);
    const corner = (P: Vec2, h: number): V3 => [P.x, h, P.z];

    // Surface.
    if (!covered) {
      g.act = ACT_UP;
      qs.forEach((Q, i) => {
        const h = heights[i];
        let col: THREE.Color;
        if (water) col = SAND;
        else if (zone === ZONE_PLAZA) col = shade(COL.plaza, (hash32(seed, i) & 1 ? 0.97 : 1.03) + 0.02 * hash01(seed, i, 7));
        else if (zone === ZONE_WOODS) col = shade(WOODS_FLOOR, 0.95 + 0.08 * hash01(seed, i, 1));
        else col = shade(COL.grass, 0.95 + 0.1 * hash01(seed, i, 1));
        g.tri(corner(Q.P0, h[0]), corner(Q.P1, h[1]), corner(Q.P2, h[2]), col);
        g.tri(corner(Q.P0, h[0]), corner(Q.P2, h[2]), corner(Q.P3, h[3]), col);
      });
    }

    // Cliffs where the land ends.
    const lip = zone === ZONE_PLAZA && !covered ? shade(COL.plaza, 0.85) : COL.grassDark;
    const rockLow = shade(COL.rock, 0.88);
    qs.forEach((Q, i) => {
      const h = heights[i];
      const edges: [Vec2, Vec2, number, number, number][] = [
        [Q.P1, Q.P2, h[1], h[2], Q.n1],
        [Q.P2, Q.P3, h[2], h[3], Q.n3],
      ];
      for (const [A, B, ha, hb, n] of edges) {
        if (town.groundTop(n) >= 0) continue;
        g.act = n + 1;
        g.quad([A.x, ha, A.z], [B.x, hb, B.z], [B.x, hb - 0.06, B.z], [A.x, ha - 0.06, A.z], lip);
        g.quad([A.x, ha - 0.06, A.z], [B.x, hb - 0.06, B.z], [B.x, -D, B.z], [A.x, -D, A.z], COL.rock, COL.rock, rockLow, rockLow);
      }
    });

    if (!covered) {
      g.act = ACT_UP;
      const at = (p: Pt, lift = 0): V3 => [p.x, surfY(qs[p.qi], heights[p.qi], p.x, p.z) + lift, p.z];
      const wy = y - WATER_LEVEL;
      if (water) {
        // Water surface, pushed out over the banks so the land clips a natural shoreline.
        qs.forEach((Q, i) => {
          const h = heights[i];
          const ext = (P: Vec2, hp: number, f: number): V3 => (hp < wy - 0.01 ? [P0.x + (P.x - P0.x) * f, wy, P0.z + (P.z - P0.z) * f] : [P.x, wy, P.z]);
          g.poly([[P0.x, wy, P0.z], ext(Q.P1, h[1], 1.6), ext(Q.P2, h[2], 1.35), ext(Q.P3, h[3], 1.6)], COL.water);
        });
      }
      decorate(g, cell.tile, qs, seed, at, P0, water ? wy : y);
    }
  }

  // Rocky underside: a jagged cone per column; neighbours together form a floating boulder.
  if (k === 0) {
    g.act = ACT_NONE;
    const nb = grid.edgeNbrs[v].filter((n) => town.groundTop(n) >= 0).length;
    const depth = D + 0.45 + 0.22 * nb + 0.12 * Math.max(0, town.groundTop(v)) + 0.35 * hash01(seed, 2);
    const apex: V3 = [P0.x + (hash01(seed, 3) - 0.5) * 0.25, -depth, P0.z + (hash01(seed, 4) - 0.5) * 0.25];
    const rockLow = shade(COL.rock, 0.88);
    for (const Q of qs) {
      g.tri(apex, [Q.P1.x, -D, Q.P1.z], [Q.P2.x, -D, Q.P2.z], COL.rockDark, rockLow, rockLow);
      g.tri(apex, [Q.P2.x, -D, Q.P2.z], [Q.P3.x, -D, Q.P3.z], COL.rockDark, rockLow, rockLow);
    }
  }
}

/** Props for each land tile. `at` places a point on the ground surface. */
function decorate(g: Geo, tile: number, qs: Quarter[], seed: number, at: (p: Pt, lift?: number) => V3, P0: Vec2, cy: number) {
  const rp = (j: number, lo?: number, hi?: number) => randomPoint(qs, seed, j, lo, hi);
  const tuft = (j: number, col = COL.grassDark) => {
    const [x, y, z] = at(rp(j));
    g.cylinder(x, z, y, y + 0.09, 0.035, 4, col, 0, false);
  };
  const centre = { x: P0.x, z: P0.z, qi: 0 };
  switch (tile) {
    // Meadow
    case T.grass:
      for (let j = 0; j < 4; j++) tuft(j);
      break;
    case T.flowers:
      for (let j = 0; j < 9; j++) {
        const [x, y, z] = at(rp(j), 0.035);
        g.blob(x, y, z, 0.036, FLOWER[hash32(seed, j, 9) % FLOWER.length]);
      }
      for (let j = 9; j < 12; j++) tuft(j);
      break;
    case T.tree: {
      const [x, y, z] = at(centre);
      if (hash01(seed, 50) < 0.4) pine(g, x, y, z, 1);
      else oak(g, x, y, z, 1, seed);
      break;
    }
    case T.bush:
      for (let j = 0; j < 3; j++) {
        const [x, y, z] = at(rp(j));
        g.blob(x, y + 0.06, z, 0.11 + 0.05 * hash01(seed, j, 4), COL.leaf[hash32(seed, j) % 3], 0.75);
      }
      tuft(5);
      break;
    case T.rocks:
      for (let j = 0; j < 3; j++) {
        const [x, y, z] = at(rp(j));
        g.blob(x, y + 0.03, z, 0.07 + 0.07 * hash01(seed, j, 4), ROCK_GREY, 0.7);
      }
      tuft(4);
      tuft(6);
      break;
    // Woods
    case T.pines:
    case T.oaks:
    case T.grove: {
      const n = 3 + (hash32(seed, 70) % 2);
      for (let j = 0; j < n; j++) {
        const [x, y, z] = at(rp(j, 0.1, 0.8));
        const s = 0.75 + 0.45 * hash01(seed, j, 71);
        const isPine = tile === T.pines || (tile === T.grove && j % 2 === 0);
        if (isPine) pine(g, x, y, z, s);
        else oak(g, x, y, z, s * 0.85, seed + j);
      }
      if (tile === T.grove) {
        const [x, y, z] = at(rp(9));
        g.blob(x, y + 0.05, z, 0.1, COL.leaf[2], 0.75);
      }
      break;
    }
    case T.clearing: {
      const [x, y, z] = at(centre);
      g.cylinder(x, z, y, y + 0.08, 0.08, 7, COL.trunk);
      for (let j = 0; j < 3; j++) {
        const [mx, my, mz] = at(rp(j));
        g.cylinder(mx, mz, my, my + 0.06, 0.015, 4, COL.trim);
        g.cylinder(mx, mz, my + 0.05, my + 0.1, 0.05, 6, MUSHROOM, 0, false);
      }
      for (let j = 3; j < 7; j++) {
        const [fx, fy, fz] = at(rp(j), 0.035);
        g.blob(fx, fy, fz, 0.032, FLOWER[hash32(seed, j, 9) % FLOWER.length]);
      }
      break;
    }
    // Squares
    case T.lamp: {
      const [x, y, z] = at(rp(0));
      g.cylinder(x, z, y, y + 0.5, 0.018, 5, COL.iron);
      g.mat = MAT_LIT;
      g.blob(x, y + 0.53, z, 0.045, LAMP);
      g.mat = MAT_BASE;
      break;
    }
    case T.fountain: {
      const [x, y, z] = at(centre);
      g.cylinder(x, z, y, y + 0.11, 0.3, 10, COL.stone);
      g.cylinder(x, z, y + 0.11, y + 0.115, 0.26, 10, COL.water);
      g.cylinder(x, z, y, y + 0.32, 0.04, 6, COL.stone);
      g.cylinder(x, z, y + 0.3, y + 0.34, 0.11, 8, COL.stone, 0.13);
      g.blob(x, y + 0.4, z, 0.06, shade(COL.water, 1.15), 1.3);
      break;
    }
    case T.bench: {
      const [x, y, z] = at(rp(0));
      g.box(x, z, 0.14, 0.05, y + 0.07, y + 0.1, COL.wood);
      g.box(x, z - 0.045, 0.14, 0.012, y + 0.1, y + 0.2, COL.wood);
      g.box(x - 0.11, z, 0.015, 0.04, y, y + 0.07, COL.iron);
      g.box(x + 0.11, z, 0.015, 0.04, y, y + 0.07, COL.iron);
      const [bx, by, bz] = at(rp(1));
      g.cylinder(bx, bz, by, by + 0.08, 0.05, 6, COL.wood, 0.06);
      g.blob(bx, by + 0.15, bz, 0.08, FLOWER[hash32(seed, 3) % FLOWER.length]);
      break;
    }
    case T.market: {
      const [x, y, z] = at(centre);
      const ac = AWNING[hash32(seed, 13) % AWNING.length];
      for (const [dx, dz] of [
        [-0.15, -0.1],
        [0.15, -0.1],
        [-0.15, 0.1],
        [0.15, 0.1],
      ])
        g.cylinder(x + dx, z + dz, y, y + 0.36, 0.012, 4, COL.wood);
      g.box(x, z, 0.16, 0.1, y + 0.12, y + 0.17, COL.wood, shade(COL.wood, 1.2));
      g.cylinder(x, z, y + 0.34, y + 0.5, 0.28, 4, ac, 0, false);
      for (let j = 0; j < 5; j++) g.blob(x - 0.1 + j * 0.05, y + 0.19, z + (j % 2) * 0.04 - 0.02, 0.025, FLOWER[(hash32(seed, j) % 2) * 4]);
      break;
    }
    case T.planter: {
      const [x, y, z] = at(rp(0));
      g.box(x, z, 0.11, 0.11, y, y + 0.12, COL.stone, shade(COL.grassDark, 0.9));
      g.cylinder(x, z, y + 0.12, y + 0.24, 0.025, 5, COL.trunk);
      g.blob(x, y + 0.32, z, 0.14, COL.leaf[hash32(seed, 3) % 3]);
      break;
    }
    // Water
    case T.lilies:
      for (let j = 0; j < 4; j++) {
        const p = rp(j, 0.1, 0.6);
        g.blob(p.x, cy + 0.006, p.z, 0.06, COL.leaf[2], 0.12);
        if (j === 0) g.blob(p.x, cy + 0.025, p.z, 0.025, FLOWER[0]);
      }
      break;
    case T.reeds:
      for (let j = 0; j < 7; j++) {
        const p = rp(j, 0.55, 0.95);
        const hgt = 0.18 + 0.12 * hash01(seed, j, 5);
        g.cylinder(p.x, p.z, cy - 0.05, cy + hgt, 0.018, 4, REED, 0, false);
        if (j % 3 === 0) g.cylinder(p.x, p.z, cy + hgt - 0.08, cy + hgt - 0.02, 0.022, 4, COL.trunk);
      }
      break;
    case T.boat: {
      const a = hash01(seed, 80) * Math.PI;
      const ca = Math.cos(a) * 0.17;
      const sa = Math.sin(a) * 0.17;
      const cx = P0.x;
      const cz = P0.z;
      const pc = Math.cos(a + Math.PI / 2) * 0.07;
      const ps = Math.sin(a + Math.PI / 2) * 0.07;
      const top: V3[] = [
        [cx + ca, cy + 0.06, cz + sa],
        [cx + pc, cy + 0.06, cz + ps],
        [cx - ca, cy + 0.06, cz - sa],
        [cx - pc, cy + 0.06, cz - ps],
      ];
      const bot: V3[] = top.map(([x, , z]) => [cx + (x - cx) * 0.6, cy - 0.02, cz + (z - cz) * 0.6]);
      for (let i = 0; i < 4; i++) g.quad(bot[i], bot[(i + 1) % 4], top[(i + 1) % 4], top[i], COL.wood);
      g.poly(top, shade(COL.wood, 1.25));
      g.cylinder(cx, cz, cy + 0.05, cy + 0.36, 0.008, 4, COL.trunk);
      g.tri([cx, cy + 0.36, cz], [cx, cy + 0.1, cz], [cx + ca * 0.8, cy + 0.1, cz + sa * 0.8], COL.trim);
      break;
    }
    case T.rock: {
      const p = rp(0, 0.2, 0.6);
      g.blob(p.x, cy, p.z, 0.12, ROCK_GREY, 0.6);
      break;
    }
  }
}
