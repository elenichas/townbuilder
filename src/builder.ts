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
  COVERED,
  F_BALCONY,
  F_DOOR,
  F_FLOWERS,
  F_SHOP,
  F_SHUTTERS,
  G_FLOWERS,
  G_GRASS,
  G_PLAZA,
  G_POND,
  G_TREE,
  ISLAND0,
  N_STOREY,
  R_FLAT,
  R_HIP,
  R_NONE,
  R_STEEP,
  type StoreyStyle,
  W_ARCH,
  W_ROUND,
  W_SQUARE,
  decodeIsland,
  decodeStorey,
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
}

function mkSeg(A: Vec2, B: Vec2, Q: Quarter, target: number): Seg {
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
  return { A, B, tx, tz, nx, nz, len, target };
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
  if (k === 0) buildIsland(town, v, cell, g);
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
  const qs = grid.quarters[v];

  const segs: Seg[] = [];
  for (const Q of qs) {
    if (!has(Q.n1, k)) segs.push(mkSeg(Q.P1, Q.P2, Q, Q.n1));
    if (!has(Q.n3, k)) segs.push(mkSeg(Q.P2, Q.P3, Q, Q.n3));
  }
  const trim = mix(wall, COL.trim, 0.6);
  const wallLow = shade(wall, k === 1 ? 0.8 : 0.92);

  // Walls, storey bands and plinth.
  for (const s of segs) {
    g.act = s.target + 1;
    g.quad(at(s, 0, y0, 0), at(s, s.len, y0, 0), at(s, s.len, y1, 0), at(s, 0, y1, 0), wallLow, wallLow, wall, wall);
    segBox(g, s, -0.01, s.len + 0.01, y1 - 0.045, y1, 0, 0.03, trim);
    if (k === 1 && below) segBox(g, s, -0.01, s.len + 0.01, y0, y0 + 0.07, 0, 0.022, COL.stone);
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
      if (!has(Q.n1, k) && (h1 || h2)) {
        g.act = Q.n1 + 1;
        g.quad(p1, p2, [Q.P2.x, y0, Q.P2.z], [Q.P1.x, y0, Q.P1.z], wallLow);
      }
      if (!has(Q.n3, k) && (h2 || h3)) {
        g.act = Q.n3 + 1;
        g.quad(p2, p3, [Q.P3.x, y0, Q.P3.z], [Q.P2.x, y0, Q.P2.z], wallLow);
      }
    }
    if (!anyDip && k >= 2) {
      for (let j = k - 2; j >= 0; j--) {
        if (has(v, j)) {
          g.act = ACT_DOWN;
          g.cylinder(qs[0].P0.x, qs[0].P0.z, j === 0 ? 0 : j * H, y0, 0.055, 7, COL.stone);
          break;
        }
      }
    }
  }

  // Facade details.
  const idx = segs.map((_, i) => i);
  const fronts = k === 1 && below ? idx.filter((i) => has(segs[i].target, 0) && !has(segs[i].target, 1)) : [];
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
        const f1 = has(Q.n1, k);
        const f3 = has(Q.n3, k);
        const h1 = f1 ? ridge : 0;
        const h3 = f3 ? ridge : 0;
        const h2 = f1 && f3 && has(Q.n2, k) ? ridge : 0;
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
      const sideCount = grid.edgeNbrs[v].filter((n) => has(n, k)).length;
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

// ---------------------------------------------------------------- islands

function randomPoint(qs: Quarter[], seed: number, j: number): Vec2 {
  const Q = qs[hash32(seed, j, 1) % qs.length];
  const u = 0.15 + 0.7 * hash01(seed, j, 2);
  const w = 0.15 + 0.7 * hash01(seed, j, 3);
  const a = (1 - u) * (1 - w);
  const b = u * (1 - w);
  const c = u * w;
  const d = (1 - u) * w;
  return { x: Q.P0.x * a + Q.P1.x * b + Q.P2.x * c + Q.P3.x * d, z: Q.P0.z * a + Q.P1.z * b + Q.P2.z * c + Q.P3.z * d };
}

function tree(g: Geo, x: number, z: number, seed: number) {
  g.cylinder(x, z, 0, 0.22, 0.045, 6, COL.trunk, 0.035);
  if (hash01(seed, 50) < 0.4) {
    for (let i = 0; i < 3; i++) {
      const y = 0.18 + i * 0.16;
      g.cylinder(x, z, y, y + 0.28, 0.26 - i * 0.07, 7, COL.pine, 0, false);
    }
  } else {
    const lc = COL.leaf[hash32(seed, 51) % 3];
    g.blob(x, 0.42, z, 0.25, lc, 0.9);
    g.blob(x + 0.1, 0.6, z - 0.05, 0.17, shade(lc, 1.08));
    g.blob(x - 0.12, 0.34, z + 0.08, 0.15, shade(lc, 0.92));
  }
}

function buildIsland(town: Town, v: number, cell: Voxel, g: Geo) {
  const grid = town.grid;
  const has = (u: number, j: number) => town.has(u, j);
  const qs = grid.quarters[v];
  const covered = has(v, 1);
  const gi = !covered && cell.tile >= ISLAND0 && cell.tile < COVERED ? decodeIsland(cell.tile) : G_GRASS;
  const seed = cell.seed;
  const D = ISLAND_D;

  if (!covered) {
    g.act = ACT_UP;
    const base = gi === G_PLAZA ? COL.plaza : COL.grass;
    qs.forEach((Q, i) => {
      g.poly(
        [Q.P0, Q.P1, Q.P2, Q.P3].map((P) => [P.x, 0, P.z] as V3),
        shade(base, 0.95 + 0.1 * hash01(seed, i, 1)),
      );
    });
  }

  const lip = !covered && gi === G_PLAZA ? shade(COL.plaza, 0.85) : COL.grassDark;
  const rockLow = shade(COL.rock, 0.88);
  for (const Q of qs) {
    const edges: [Vec2, Vec2, number][] = [
      [Q.P1, Q.P2, Q.n1],
      [Q.P2, Q.P3, Q.n3],
    ];
    for (const [A, B, n] of edges) {
      if (has(n, 0)) continue;
      g.act = n + 1;
      g.quad([A.x, 0, A.z], [B.x, 0, B.z], [B.x, -0.06, B.z], [A.x, -0.06, A.z], lip);
      g.quad([A.x, -0.06, A.z], [B.x, -0.06, B.z], [B.x, -D, B.z], [A.x, -D, A.z], COL.rock, COL.rock, rockLow, rockLow);
    }
  }

  // Rocky underside: a jagged cone per cell; neighbours together form a floating boulder.
  g.act = ACT_NONE;
  const nb = grid.edgeNbrs[v].filter((n) => has(n, 0)).length;
  const P0 = qs[0].P0;
  const depth = D + 0.45 + 0.22 * nb + 0.35 * hash01(seed, 2);
  const apex: V3 = [P0.x + (hash01(seed, 3) - 0.5) * 0.25, -depth, P0.z + (hash01(seed, 4) - 0.5) * 0.25];
  for (const Q of qs) {
    const p1: V3 = [Q.P1.x, -D, Q.P1.z];
    const p2: V3 = [Q.P2.x, -D, Q.P2.z];
    const p3: V3 = [Q.P3.x, -D, Q.P3.z];
    g.tri(apex, p1, p2, COL.rockDark, rockLow, rockLow);
    g.tri(apex, p2, p3, COL.rockDark, rockLow, rockLow);
  }

  if (covered) return;
  g.act = ACT_UP;
  switch (gi) {
    case G_GRASS:
      for (let j = 0; j < 4; j++) {
        const p = randomPoint(qs, seed, j);
        g.cylinder(p.x, p.z, 0, 0.09, 0.035, 4, COL.grassDark, 0, false);
      }
      break;
    case G_FLOWERS:
      for (let j = 0; j < 9; j++) {
        const p = randomPoint(qs, seed, j);
        g.blob(p.x, 0.035, p.z, 0.036, FLOWER[hash32(seed, j, 9) % FLOWER.length]);
      }
      for (let j = 9; j < 12; j++) {
        const p = randomPoint(qs, seed, j);
        g.cylinder(p.x, p.z, 0, 0.08, 0.03, 4, COL.grassDark, 0, false);
      }
      break;
    case G_TREE:
      tree(g, P0.x, P0.z, seed);
      break;
    case G_PLAZA:
      if (hash01(seed, 60) < 0.5) {
        const p = randomPoint(qs, seed, 0);
        g.cylinder(p.x, p.z, 0, 0.5, 0.018, 5, COL.iron);
        g.mat = MAT_LIT;
        g.blob(p.x, 0.53, p.z, 0.045, LAMP);
        g.mat = MAT_BASE;
      }
      break;
    case G_POND:
      for (const Q of qs) {
        g.poly(
          [Q.P0, Q.P1, Q.P2, Q.P3].map((P) => [P0.x + (P.x - P0.x) * 0.62, 0.006, P0.z + (P.z - P0.z) * 0.62] as V3),
          COL.water,
        );
      }
      {
        const p = randomPoint(qs, seed, 1);
        const x = P0.x + (p.x - P0.x) * 0.5;
        const z = P0.z + (p.z - P0.z) * 0.5;
        g.blob(x, 0.012, z, 0.06, COL.leaf[2], 0.15);
      }
      break;
  }
}
