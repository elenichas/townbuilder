/** Keeps one mesh per voxel in sync with the town, with pop-in/out animations,
 *  plus the hover "ghost" and little puffs of cloud when something is placed. */
import * as THREE from 'three';
import { H, buildVoxel, levelBottom } from './builder';
import type { Vec2 } from './grid';
import { type Change, MAX_LEVEL, type Town, key, keyV } from './town';

interface Anim {
  mesh: THREE.Mesh;
  t0: number;
  kind: 'in' | 'out';
}

const easeOutBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export class TownView {
  readonly group = new THREE.Group();
  private dying = new THREE.Group();
  private meshes = new Map<number, THREE.Mesh>();
  private anims = new Map<THREE.Mesh, Anim>();
  private mats: THREE.Material[];
  /** Voxel meshes that carry moving parts (sails, boats) or smoking chimneys. */
  private living = new Set<THREE.Mesh>();
  private smoke: Smoke;

  constructor(
    private town: Town,
    scene: THREE.Scene,
    litGlass: THREE.Material,
  ) {
    const base = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, side: THREE.DoubleSide });
    const dark = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.35, side: THREE.DoubleSide });
    this.mats = [base, litGlass, dark];
    scene.add(this.group, this.dying);
    this.smoke = new Smoke(scene);
  }

  rebuildAll() {
    for (const m of this.meshes.values()) this.disposeMesh(m);
    this.meshes.clear();
    for (const k of this.town.cells.keys()) this.rebuild(k, false);
  }

  /** Update meshes after an edit. Voxels in `pop` animate in (or out, if removed). */
  apply(ch: Change, pop: Set<number> = new Set()) {
    const g = this.town.grid;
    const dirty = new Set<number>(ch.look);
    // Terrain heights and walls depend on whole neighbouring columns.
    for (const fk of ch.fill) {
      const v = keyV(fk);
      for (const u of [v, ...g.quadMates[v]]) for (let j = 0; j <= MAX_LEVEL + 1; j++) dirty.add(key(u, j));
    }
    for (const k of dirty) {
      if (this.town.cells.has(k)) this.rebuild(k, pop.has(k));
      else this.kill(k, pop.has(k));
    }
  }

  private rebuild(k: number, pop: boolean) {
    const old = this.meshes.get(k);
    const res = buildVoxel(this.town, k);
    let carried: Anim | undefined;
    if (old) {
      carried = this.anims.get(old);
      this.anims.delete(old);
      this.group.remove(old);
      this.disposeMesh(old);
      this.meshes.delete(k);
    }
    if (!res) return;
    const mesh = new THREE.Mesh(res.geometry, this.mats);
    mesh.position.set(...res.origin);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.key = k;
    // Moving parts become children, so they pop in, scale and disappear with their voxel.
    const parts: THREE.Mesh[] = [];
    const smoke: THREE.Vector3[] = [];
    for (const a of res.anims) {
      const local = new THREE.Vector3(a.pos[0] - res.origin[0], a.pos[1] - res.origin[1], a.pos[2] - res.origin[2]);
      if (a.kind === 'smoke') {
        smoke.push(local);
        continue;
      }
      if (!a.geometry) continue;
      const part = new THREE.Mesh(a.geometry, this.mats);
      part.position.copy(local);
      part.castShadow = true;
      part.userData.anim = { ...a, base: local.clone(), axis: new THREE.Vector3(...(a.axis ?? [0, 1, 0])).normalize() };
      mesh.add(part);
      parts.push(part);
    }
    mesh.userData.parts = parts;
    mesh.userData.smoke = smoke;
    mesh.userData.smokeClock = Math.random() * 2;
    if (parts.length || smoke.length) this.living.add(mesh);
    this.group.add(mesh);
    this.meshes.set(k, mesh);
    if (pop) this.anims.set(mesh, { mesh, t0: performance.now(), kind: 'in' });
    else if (carried?.kind === 'in') this.anims.set(mesh, { ...carried, mesh });
    if (this.anims.has(mesh)) this.tickOne(this.anims.get(mesh)!, performance.now());
  }

  private kill(k: number, animate: boolean) {
    const m = this.meshes.get(k);
    if (!m) return;
    this.meshes.delete(k);
    this.anims.delete(m);
    this.group.remove(m);
    if (animate) {
      this.dying.add(m);
      this.anims.set(m, { mesh: m, t0: performance.now(), kind: 'out' });
    } else this.disposeMesh(m);
  }

  private disposeMesh(m: THREE.Mesh) {
    m.geometry.dispose();
    for (const p of (m.userData.parts as THREE.Mesh[] | undefined) ?? []) p.geometry.dispose();
    this.living.delete(m);
  }

  private tickOne(a: Anim, now: number): boolean {
    if (a.kind === 'in') {
      const p = Math.min(1, (now - a.t0) / 420);
      const s = easeOutBack(p);
      a.mesh.scale.set(0.82 + 0.18 * s, Math.max(0.001, s), 0.82 + 0.18 * s);
      return p >= 1;
    }
    const p = Math.min(1, (now - a.t0) / 200);
    a.mesh.scale.set(1 - 0.25 * p, Math.max(0.001, 1 - p), 1 - 0.25 * p);
    if (p >= 1) {
      this.dying.remove(a.mesh);
      this.disposeMesh(a.mesh);
    }
    return p >= 1;
  }

  tick(now: number, dt = 1 / 60) {
    for (const [m, a] of this.anims) if (this.tickOne(a, now)) this.anims.delete(m);
    const t = now / 1000;
    const world = new THREE.Vector3();
    for (const mesh of this.living) {
      for (const part of mesh.userData.parts as THREE.Mesh[]) {
        const a = part.userData.anim;
        if (a.kind === 'spin') {
          // Windmill sails turning slowly in the meltemi.
          part.quaternion.setFromAxisAngle(a.axis, t * a.speed + a.phase);
        } else if (a.kind === 'bob') {
          // Boats bobbing and rocking on the water.
          const p = a.phase ?? 0;
          part.position.y = a.base.y + Math.sin(t * 1.4 + p) * 0.012;
          part.rotation.set(Math.sin(t * 1.1 + p) * 0.045, 0, Math.sin(t * 0.9 + p * 1.7) * 0.06);
        }
      }
      // Chimney smoke: a soft puff every couple of seconds.
      const smoke = mesh.userData.smoke as THREE.Vector3[];
      if (smoke.length && mesh.parent === this.group) {
        mesh.userData.smokeClock -= dt;
        if (mesh.userData.smokeClock <= 0) {
          mesh.userData.smokeClock = 1.4 + Math.random() * 1.4;
          for (const p of smoke) this.smoke.emit(world.copy(p).add(mesh.position));
        }
      }
    }
    this.smoke.tick(dt);
  }
}

/** Pool of soft smoke puffs that rise, drift with the breeze and fade. */
class Smoke {
  private pool: { m: THREE.Mesh; mat: THREE.MeshStandardMaterial; age: number; life: number; vel: THREE.Vector3 }[] = [];
  private geo = new THREE.IcosahedronGeometry(1, 0);

  constructor(private scene: THREE.Scene) {}

  emit(at: THREE.Vector3) {
    let p = this.pool.find((x) => x.age >= x.life);
    if (!p) {
      if (this.pool.length >= 140) return;
      const mat = new THREE.MeshStandardMaterial({ color: '#efeeea', flatShading: true, transparent: true, depthWrite: false, roughness: 1 });
      const m = new THREE.Mesh(this.geo, mat);
      this.scene.add(m);
      p = { m, mat, age: 0, life: 1, vel: new THREE.Vector3() };
      this.pool.push(p);
    }
    p.age = 0;
    p.life = 3 + Math.random() * 1.5;
    p.m.position.copy(at);
    p.vel.set(0.06 + Math.random() * 0.04, 0.22 + Math.random() * 0.06, 0.03 * (Math.random() - 0.5));
    p.m.visible = true;
  }

  tick(dt: number) {
    for (const p of this.pool) {
      if (p.age >= p.life) continue;
      p.age += dt;
      const k = Math.min(1, p.age / p.life);
      p.m.position.addScaledVector(p.vel, dt);
      p.m.scale.setScalar(0.05 + 0.15 * k);
      p.mat.opacity = 0.75 * Math.sin(Math.PI * Math.min(1, k * 1.2)) * (1 - k * 0.6);
      if (p.age >= p.life) p.m.visible = false;
    }
  }
}

/** Translucent prism showing where the next click lands. */
export class Ghost {
  readonly mesh: THREE.Mesh;
  readonly edges: THREE.LineSegments;
  private mat: THREE.MeshBasicMaterial;
  private lineMat: THREE.LineBasicMaterial;
  private current = '';

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.32, depthWrite: false });
    this.lineMat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.edges = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMat);
    this.mesh.renderOrder = 10;
    this.edges.renderOrder = 11;
    scene.add(this.mesh, this.edges);
    this.hide();
  }

  hide() {
    this.mesh.visible = this.edges.visible = false;
    this.current = '';
  }

  show(ring: Vec2[], k: number, color: THREE.ColorRepresentation, grow = 0.03) {
    const id = `${ring[0].x},${ring[0].z},${k},${grow}`;
    this.mat.color.set(color);
    this.lineMat.color.set(color);
    this.mesh.visible = this.edges.visible = true;
    if (id === this.current) return;
    this.current = id;
    const y0 = levelBottom(k) - grow;
    const y1 = (k === 0 ? 0.02 : k * H) + grow;
    const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
    const cz = ring.reduce((s, p) => s + p.z, 0) / ring.length;
    const pts = ring.map((p) => ({ x: cx + (p.x - cx) * (1 + grow), z: cz + (p.z - cz) * (1 + grow) }));
    const pos: number[] = [];
    const line: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      pos.push(a.x, y0, a.z, b.x, y0, b.z, b.x, y1, b.z, a.x, y0, a.z, b.x, y1, b.z, a.x, y1, a.z);
      pos.push(cx, y1, cz, a.x, y1, a.z, b.x, y1, b.z);
      line.push(a.x, y1, a.z, b.x, y1, b.z, a.x, y0, a.z, b.x, y0, b.z);
    }
    this.mesh.geometry.dispose();
    this.edges.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.mesh.geometry = g;
    const l = new THREE.BufferGeometry();
    l.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
    this.edges.geometry = l;
  }
}

/** Little cloud puffs on placement. */
export class Puffs {
  private items: { m: THREE.Mesh; v: THREE.Vector3; t0: number }[] = [];
  private geo = new THREE.IcosahedronGeometry(1, 0);
  constructor(private scene: THREE.Scene) {}

  burst(x: number, y: number, z: number, n = 7) {
    const now = performance.now();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const m = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, transparent: true, emissive: '#ffffff', emissiveIntensity: 0.3 }));
      m.position.set(x, y, z);
      m.scale.setScalar(0.08);
      this.scene.add(m);
      this.items.push({ m, v: new THREE.Vector3(Math.cos(a) * 1.4, 0.4 + Math.random() * 0.6, Math.sin(a) * 1.4), t0: now });
    }
  }

  tick(now: number, dt: number) {
    this.items = this.items.filter((it) => {
      const p = (now - it.t0) / 550;
      if (p >= 1) {
        this.scene.remove(it.m);
        (it.m.material as THREE.Material).dispose();
        return false;
      }
      it.m.position.addScaledVector(it.v, dt * (1 - p));
      it.m.scale.setScalar(0.08 + 0.12 * p);
      (it.m.material as THREE.MeshStandardMaterial).opacity = 1 - p;
      return true;
    });
  }
}

export const GRID_OPACITY = 0.18;

/** Faint outline of every buildable cell, drawn just below the island tops. */
export function gridLines(town: Town): THREE.LineSegments {
  const g = town.grid;
  const pos: number[] = [];
  const y = -0.03;
  g.quads.forEach((q, qi) => {
    const c = g.quadCenter[qi];
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      if (!g.buildable[a] && !g.buildable[b]) continue;
      const mx = (g.pos[a].x + g.pos[b].x) / 2;
      const mz = (g.pos[a].z + g.pos[b].z) / 2;
      pos.push(mx, y, mz, c.x, y, c.z);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: GRID_OPACITY, depthWrite: false }));
}

