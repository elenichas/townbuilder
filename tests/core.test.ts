import { describe, expect, it } from 'vitest';
import { buildVoxel } from '../src/builder';
import { generateTown } from '../src/generate';
import { cellAt, generateGrid, pointInPolygon } from '../src/grid';
import { mulberry32 } from '../src/rng';
import { compat, isIsland, isStorey } from '../src/tiles';
import { Town, key, keyK, keyV } from '../src/town';

const grid = generateGrid(9, 7);

function quadArea(q: number[]) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = grid.pos[q[i]];
    const b = grid.pos[q[(i + 1) % 4]];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

/** Every filled voxel has an allowed tile and every neighbour pair satisfies the rules. */
function assertConsistent(town: Town) {
  for (const [k, cell] of town.cells) {
    expect(town.allowed(k), `tile allowed for ${keyV(k)},${keyK(k)}`).toContain(cell.tile);
    for (const n of town.neighbors(k)) {
      expect(compat(n.rel, cell.tile, town.cells.get(n.key)!.tile)).toBe(true);
    }
  }
}

describe('grid', () => {
  it('is all convex, positively oriented quads after relaxation', () => {
    expect(grid.quads.length).toBeGreaterThan(1000);
    for (const q of grid.quads) {
      expect(quadArea(q)).toBeGreaterThan(0.2);
      for (let i = 0; i < 4; i++) {
        const a = grid.pos[q[i]];
        const b = grid.pos[q[(i + 1) % 4]];
        const c = grid.pos[q[(i + 2) % 4]];
        const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
        expect(cross).toBeGreaterThan(0);
      }
    }
  });

  it('gives each buildable vertex a dual cell that contains it', () => {
    for (let v = 0; v < grid.pos.length; v++) {
      if (!grid.buildable[v]) continue;
      expect(pointInPolygon(grid.pos[v], grid.ring[v])).toBe(true);
      expect(cellAt(grid, grid.pos[v])).toBe(v);
    }
  });

  it('is deterministic', () => {
    const again = generateGrid(9, 7);
    expect(again.pos).toEqual(grid.pos);
  });
});

describe('wfc town', () => {
  it('keeps every constraint satisfied through random edits', () => {
    const town = new Town(grid);
    const rand = mulberry32(42);
    const buildable = grid.pos.map((_, v) => v).filter((v) => grid.buildable[v] && Math.hypot(grid.pos[v].x, grid.pos[v].z) < 6);
    for (let step = 0; step < 400; step++) {
      const v = buildable[Math.floor(rand() * buildable.length)];
      const r = rand();
      if (r < 0.65) {
        let k = 0;
        while (town.has(v, k)) k++;
        town.add(v, k, Math.floor(rand() * 8), Math.floor(rand() * 1e9));
      } else if (r < 0.8) {
        const filled = [...town.cells.keys()];
        if (filled.length) {
          const kk = filled[Math.floor(rand() * filled.length)];
          town.remove(keyV(kk), keyK(kk));
        }
      } else {
        const filled = [...town.cells.keys()];
        if (filled.length) {
          const kk = filled[Math.floor(rand() * filled.length)];
          town.reroll(keyV(kk), keyK(kk));
        }
      }
    }
    expect(town.cells.size).toBeGreaterThan(50);
    assertConsistent(town);
  });

  it('reroll changes the clicked piece when an alternative exists', () => {
    const town = new Town(grid);
    const v = grid.pos.findIndex((_, i) => grid.buildable[i] && Math.hypot(grid.pos[i].x, grid.pos[i].z) < 2);
    town.add(v, 0, 0, 1);
    town.add(v, 1, 0, 2);
    town.add(v, 2, 0, 3);
    const kk = key(v, 2);
    for (let i = 0; i < 10; i++) {
      const before = town.cells.get(kk)!.tile;
      const ch = town.reroll(v, 2)!;
      expect(town.cells.get(kk)!.tile).not.toBe(before);
      expect(ch.look.has(kk)).toBe(true);
    }
    assertConsistent(town);
  });

  it('round-trips through serialize/load and undo snapshots', () => {
    const town = new Town(grid);
    generateTown(town, mulberry32(3));
    assertConsistent(town);
    const data = town.serialize();
    const copy = new Town(grid);
    expect(copy.load(data)).toBe(true);
    expect(copy.cells.size).toBe(town.cells.size);
    for (const [k, c] of town.cells) expect(copy.cells.get(k)!.tile).toBe(c.tile);

    const snap = town.snapshot();
    const any = [...town.cells.keys()][0];
    town.remove(keyV(any), keyK(any));
    const ch = town.restore(snap);
    expect(ch.fill.has(any)).toBe(true);
    expect(town.cells.size).toBe(snap.size);
  });

  it('generates islands and houses', () => {
    const town = new Town(grid);
    generateTown(town, mulberry32(11));
    const tiles = [...town.cells.values()].map((c) => c.tile);
    expect(tiles.some(isIsland)).toBe(true);
    expect(tiles.some(isStorey)).toBe(true);
  });
});

describe('builder', () => {
  it('produces finite geometry for every voxel of a generated town', () => {
    const town = new Town(grid);
    generateTown(town, mulberry32(5));
    let tris = 0;
    for (const k of town.cells.keys()) {
      const res = buildVoxel(town, k);
      if (!res) continue; // fully enclosed voxels have nothing visible
      const pos = res.geometry.getAttribute('position').array as Float32Array;
      for (const x of pos) expect(Number.isFinite(x)).toBe(true);
      tris += pos.length / 9;
    }
    expect(tris).toBeGreaterThan(1000);
  });
});

describe('picking actions', () => {
  it('walls and cliffs always point at an empty edge neighbour on the same level', () => {
    const town = new Town(grid);
    generateTown(town, mulberry32(9));
    for (const k of town.cells.keys()) {
      const res = buildVoxel(town, k);
      if (!res) continue;
      const act = res.geometry.getAttribute('act').array as Float32Array;
      const v = keyV(k);
      const lvl = keyK(k);
      for (const a of new Set(act)) {
        expect(a).toBeGreaterThanOrEqual(-2);
        if (a > 0) {
          const n = a - 1;
          expect(grid.edgeNbrs[v]).toContain(n);
          expect(town.has(n, lvl)).toBe(false);
        }
      }
    }
  });
});
