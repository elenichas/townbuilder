/**
 * Irregular quad grid.
 *
 * 1. Start from a hexagon-shaped triangular lattice.
 * 2. Randomly merge neighbouring triangles into quads (some triangles stay single).
 * 3. Subdivide every polygon into quads (triangle -> 3, quad -> 4) so everything is a quad.
 * 4. Relax the vertices so every quad gets as close to a square as it can.
 *
 * The player builds on the grid's *vertices*. Each vertex owns a "dual cell":
 * the polygon formed by the centres of its surrounding quads and the midpoints
 * of its edges. Each quad is therefore split into 4 "quarters", one per corner.
 */
import { mulberry32 } from './rng';

export interface Vec2 {
  x: number;
  z: number;
}

/** The part of quad `q` that belongs to the corner vertex. Points are CCW:
 *  P0 = the vertex, P1 = midpoint toward n1, P2 = quad centre, P3 = midpoint toward n3. */
export interface Quarter {
  q: number;
  n1: number; // next corner (edge neighbour)
  n2: number; // opposite corner (diagonal)
  n3: number; // previous corner (edge neighbour)
  P0: Vec2;
  P1: Vec2;
  P2: Vec2;
  P3: Vec2;
}

export interface Grid {
  pos: Vec2[];
  quads: number[][];
  quadCenter: Vec2[];
  vertQuads: number[][];
  edgeNbrs: number[][];
  quadMates: number[][];
  boundary: boolean[];
  buildable: boolean[];
  quarters: Quarter[][];
  /** Dual cell outline (sorted CCW) for each vertex. */
  ring: Vec2[][];
  radius: number;
}

const edgeKey = (a: number, b: number) => (a < b ? a * 1_000_003 + b : b * 1_000_003 + a);

function area2(P: Vec2[], q: number[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = P[q[i]];
    const b = P[q[(i + 1) % q.length]];
    s += a.x * b.z - b.x * a.z;
  }
  return s;
}

export function generateGrid(rings = 9, seed = 7, edge = 2, relaxIterations = 80): Grid {
  const rand = mulberry32(seed);

  // 1. Triangular lattice inside a hexagon.
  const ids = new Map<string, number>();
  const P: Vec2[] = [];
  for (let q = -rings; q <= rings; q++) {
    for (let r = -rings; r <= rings; r++) {
      if (Math.abs(q + r) > rings) continue;
      ids.set(`${q},${r}`, P.length);
      P.push({ x: edge * (q + r / 2), z: edge * ((r * Math.sqrt(3)) / 2) });
    }
  }
  const id = (q: number, r: number) => ids.get(`${q},${r}`);
  const tris: number[][] = [];
  for (let q = -rings; q <= rings; q++) {
    for (let r = -rings; r <= rings; r++) {
      const a = id(q, r);
      const b = id(q + 1, r);
      const c = id(q, r + 1);
      const d = id(q + 1, r + 1);
      if (a !== undefined && b !== undefined && c !== undefined) tris.push([a, b, c]);
      if (b !== undefined && d !== undefined && c !== undefined) tris.push([b, d, c]);
    }
  }

  // 2. Random triangle-pair merging.
  const edgeTris = new Map<number, number[]>();
  tris.forEach((t, i) => {
    for (let j = 0; j < 3; j++) {
      const k = edgeKey(t[j], t[(j + 1) % 3]);
      const list = edgeTris.get(k);
      if (list) list.push(i);
      else edgeTris.set(k, [i]);
    }
  });
  const order = tris.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const used = new Array<boolean>(tris.length).fill(false);
  const polys: number[][] = [];
  for (const i of order) {
    if (used[i]) continue;
    const t = tris[i];
    const options: { o: number; a: number; b: number; p: number }[] = [];
    for (let j = 0; j < 3; j++) {
      const a = t[j];
      const b = t[(j + 1) % 3];
      for (const o of edgeTris.get(edgeKey(a, b)) ?? []) {
        if (o !== i && !used[o]) options.push({ o, a, b, p: t[(j + 2) % 3] });
      }
    }
    used[i] = true;
    if (options.length) {
      const opt = options[Math.floor(rand() * options.length)];
      used[opt.o] = true;
      const other = tris[opt.o].find((x) => x !== opt.a && x !== opt.b)!;
      polys.push([opt.p, opt.a, other, opt.b]);
    } else {
      polys.push([...t]);
    }
  }
  for (const poly of polys) if (area2(P, poly) < 0) poly.reverse();

  // 3. Subdivide into quads.
  const polyEdgeCount = new Map<number, number>();
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const k = edgeKey(poly[i], poly[(i + 1) % poly.length]);
      polyEdgeCount.set(k, (polyEdgeCount.get(k) ?? 0) + 1);
    }
  }
  const midIds = new Map<number, number>();
  const mid = (a: number, b: number) => {
    const k = edgeKey(a, b);
    let m = midIds.get(k);
    if (m === undefined) {
      m = P.length;
      P.push({ x: (P[a].x + P[b].x) / 2, z: (P[a].z + P[b].z) / 2 });
      midIds.set(k, m);
    }
    return m;
  };
  const quads: number[][] = [];
  for (const poly of polys) {
    const n = poly.length;
    const c = P.length;
    P.push({
      x: poly.reduce((s, v) => s + P[v].x, 0) / n,
      z: poly.reduce((s, v) => s + P[v].z, 0) / n,
    });
    for (let i = 0; i < n; i++) {
      const v = poly[i];
      const next = poly[(i + 1) % n];
      const prev = poly[(i + n - 1) % n];
      quads.push([v, mid(v, next), c, mid(prev, v)]);
    }
  }
  for (const q of quads) if (area2(P, q) < 0) q.reverse();

  const boundary = new Array<boolean>(P.length).fill(false);
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (polyEdgeCount.get(edgeKey(a, b)) === 1) {
        boundary[a] = boundary[b] = true;
        boundary[mid(a, b)] = true;
      }
    }
  }

  // 4. Relaxation: pull every quad toward the best-fitting square.
  const fx = new Float64Array(P.length);
  const fz = new Float64Array(P.length);
  const cnt = new Float64Array(P.length);
  for (let it = 0; it < relaxIterations; it++) {
    fx.fill(0);
    fz.fill(0);
    cnt.fill(0);
    for (const q of quads) {
      let cx = 0;
      let cz = 0;
      for (const v of q) {
        cx += P[v].x;
        cz += P[v].z;
      }
      cx /= 4;
      cz /= 4;
      // Rotate each corner back by -90°*i so they all line up, then average.
      let dx = 0;
      let dz = 0;
      for (let i = 0; i < 4; i++) {
        let x = P[q[i]].x - cx;
        let z = P[q[i]].z - cz;
        for (let r = 0; r < i; r++) [x, z] = [z, -x];
        dx += x;
        dz += z;
      }
      dx /= 4;
      dz /= 4;
      let tx = dx;
      let tz = dz;
      for (let i = 0; i < 4; i++) {
        const v = q[i];
        fx[v] += cx + tx - P[v].x;
        fz[v] += cz + tz - P[v].z;
        cnt[v]++;
        [tx, tz] = [-tz, tx];
      }
    }
    for (let v = 0; v < P.length; v++) {
      if (boundary[v] || !cnt[v]) continue;
      P[v].x += (0.5 * fx[v]) / cnt[v];
      P[v].z += (0.5 * fz[v]) / cnt[v];
    }
  }

  // 5. Adjacency and dual cells.
  const vertQuads: number[][] = P.map(() => []);
  quads.forEach((q, i) => q.forEach((v) => vertQuads[v].push(i)));
  const edgeSets: Set<number>[] = P.map(() => new Set());
  const mateSets: Set<number>[] = P.map(() => new Set());
  for (const q of quads) {
    for (let i = 0; i < 4; i++) {
      edgeSets[q[i]].add(q[(i + 1) % 4]);
      edgeSets[q[(i + 1) % 4]].add(q[i]);
      for (const o of q) if (o !== q[i]) mateSets[q[i]].add(o);
    }
  }
  const quadCenter = quads.map((q) => ({
    x: q.reduce((s, v) => s + P[v].x, 0) / 4,
    z: q.reduce((s, v) => s + P[v].z, 0) / 4,
  }));
  const midpoint = (a: number, b: number): Vec2 => ({ x: (P[a].x + P[b].x) / 2, z: (P[a].z + P[b].z) / 2 });

  const quarters: Quarter[][] = P.map((_, v) =>
    vertQuads[v].map((qi) => {
      const q = quads[qi];
      const i = q.indexOf(v);
      const n1 = q[(i + 1) % 4];
      const n2 = q[(i + 2) % 4];
      const n3 = q[(i + 3) % 4];
      return { q: qi, n1, n2, n3, P0: P[v], P1: midpoint(v, n1), P2: quadCenter[qi], P3: midpoint(v, n3) };
    }),
  );

  const ring: Vec2[][] = P.map((p, v) => {
    const pts = new Map<string, Vec2>();
    for (const Q of quarters[v]) {
      pts.set(`m${Q.n1}`, Q.P1);
      pts.set(`m${Q.n3}`, Q.P3);
      pts.set(`c${Q.q}`, Q.P2);
    }
    return [...pts.values()].sort((a, b) => Math.atan2(a.z - p.z, a.x - p.x) - Math.atan2(b.z - p.z, b.x - p.x));
  });

  return {
    pos: P,
    quads,
    quadCenter,
    vertQuads,
    edgeNbrs: edgeSets.map((s) => [...s]),
    quadMates: mateSets.map((s) => [...s]),
    boundary,
    buildable: boundary.map((b) => !b),
    quarters,
    ring,
    radius: edge * rings,
  };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Which buildable vertex's dual cell contains the point (or -1). */
export function cellAt(grid: Grid, p: Vec2): number {
  const cands: { v: number; d: number }[] = [];
  for (let v = 0; v < grid.pos.length; v++) {
    if (!grid.buildable[v]) continue;
    const dx = grid.pos[v].x - p.x;
    const dz = grid.pos[v].z - p.z;
    cands.push({ v, d: dx * dx + dz * dz });
  }
  cands.sort((a, b) => a.d - b.d);
  for (let i = 0; i < Math.min(8, cands.length); i++) {
    if (pointInPolygon(p, grid.ring[cands[i].v])) return cands[i].v;
  }
  return -1;
}
