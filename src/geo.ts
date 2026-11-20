/** Tiny mesh builder: collects flat-shaded, vertex-coloured triangles into up to three
 *  material groups (base, lit glass, dark glass) and a per-vertex "act" attribute that
 *  tells the picker what clicking that triangle should do. */
import * as THREE from 'three';

export type V3 = [number, number, number];
export const MAT_BASE = 0;
export const MAT_LIT = 1;
export const MAT_DARK = 2;

const ICO = (() => {
  const g = new THREE.IcosahedronGeometry(1, 0);
  return Array.from(g.getAttribute('position').array as Float32Array);
})();

export class Geo {
  private p: number[][] = [[], [], []];
  private c: number[][] = [[], [], []];
  private a: number[][] = [[], [], []];
  mat = MAT_BASE;
  /** Picking action written into every vertex added while set. */
  act = 0;

  constructor(
    readonly ox = 0,
    readonly oy = 0,
    readonly oz = 0,
  ) {}

  private vert(v: V3, col: THREE.Color) {
    const m = this.mat;
    this.p[m].push(v[0] - this.ox, v[1] - this.oy, v[2] - this.oz);
    this.c[m].push(col.r, col.g, col.b);
    this.a[m].push(this.act);
  }

  tri(a: V3, b: V3, c: V3, ca: THREE.Color, cb = ca, cc = ca) {
    this.vert(a, ca);
    this.vert(b, cb);
    this.vert(c, cc);
  }

  quad(a: V3, b: V3, c: V3, d: V3, ca: THREE.Color, cb = ca, cc = cb, cd = ca) {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }

  /** Convex polygon, fan triangulated. */
  poly(pts: V3[], col: THREE.Color) {
    for (let i = 1; i < pts.length - 1; i++) this.tri(pts[0], pts[i], pts[i + 1], col);
  }

  /** Axis-aligned box. */
  box(x: number, z: number, hw: number, hd: number, y0: number, y1: number, col: THREE.Color, top = col) {
    const c: V3[] = [
      [x - hw, y0, z - hd],
      [x + hw, y0, z - hd],
      [x + hw, y0, z + hd],
      [x - hw, y0, z + hd],
      [x - hw, y1, z - hd],
      [x + hw, y1, z - hd],
      [x + hw, y1, z + hd],
      [x - hw, y1, z + hd],
    ];
    this.boxFromCorners(c, col, top);
  }

  /** Box from 8 corners: 0-3 bottom ring, 4-7 top ring (same order). */
  boxFromCorners(c: V3[], col: THREE.Color, top = col) {
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(c[i], c[j], c[j + 4], c[i + 4], col);
    }
    this.quad(c[4], c[5], c[6], c[7], top);
    this.quad(c[0], c[3], c[2], c[1], col);
  }

  cylinder(x: number, z: number, y0: number, y1: number, r0: number, segs: number, col: THREE.Color, r1 = r0, cap = true) {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const b0: V3 = [x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0];
      const b1: V3 = [x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0];
      const t0: V3 = [x + Math.cos(a0) * r1, y1, z + Math.sin(a0) * r1];
      const t1: V3 = [x + Math.cos(a1) * r1, y1, z + Math.sin(a1) * r1];
      if (r1 > 0) this.quad(b0, b1, t1, t0, col);
      else this.tri(b0, b1, [x, y1, z], col);
      if (cap && r1 > 0) this.tri([x, y1, z], t0, t1, col);
    }
  }

  blob(x: number, y: number, z: number, r: number, col: THREE.Color, sy = 1) {
    for (let i = 0; i < ICO.length; i += 9) {
      const v = (j: number): V3 => [x + ICO[i + j] * r, y + ICO[i + j + 1] * r * sy, z + ICO[i + j + 2] * r];
      this.tri(v(0), v(3), v(6), col);
    }
  }

  get empty(): boolean {
    return this.p.every((p) => p.length === 0);
  }

  build(): THREE.BufferGeometry | null {
    const total = this.p.reduce((s, p) => s + p.length, 0);
    if (!total) return null;
    const pos = new Float32Array(total);
    const col = new Float32Array(total);
    const act = new Float32Array(total / 3);
    const g = new THREE.BufferGeometry();
    let off = 0;
    for (let m = 0; m < 3; m++) {
      pos.set(this.p[m], off);
      col.set(this.c[m], off);
      act.set(this.a[m], off / 3);
      if (this.p[m].length) g.addGroup(off / 3, this.p[m].length / 3, m);
      off += this.p[m].length;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('act', new THREE.BufferAttribute(act, 1));
    g.computeBoundingSphere();
    return g;
  }
}
