import { describe, expect, it } from 'vitest';
import { buildVoxel, pointHeight } from '../src/builder';
import { generateTown } from '../src/generate';
import { cellAt, generateGrid, pointInPolygon } from '../src/grid';
import { mulberry32 } from '../src/rng';
import {
  F_CHAPEL,
  KIND_BUILDING,
  R_DOME,
  R_FLAT,
  R_HIP,
  R_MILL,
  R_NONE,
  R_SLATE,
  R_STEEP,
  STYLE_ISLAND,
  STYLE_MOUNTAIN,
  STYLE_PASTEL,
  ZONE_MEADOW,
  ZONE_OLIVE,
  ZONE_PLAZA,
  ZONE_ROCKY,
  ZONE_WATER,
  ZONE_WOODS,
  compat,
  decodeStorey,
  isGroundTile,
  isStorey,
} from '../src/tiles';
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
        const zones = [ZONE_MEADOW, ZONE_WOODS, ZONE_PLAZA, ZONE_WATER];
        // Land at the bottom and sometimes stacked into hills; buildings above.
        const land = k === 0 || (town.isGround(v, k - 1) && rand() < 0.35);
        town.add(v, k, Math.floor(rand() * 8), Math.floor(rand() * 1e9), land ? zones[Math.floor(rand() * 4)] : KIND_BUILDING);
      } else if (r < 0.72) {
        const gt = town.groundTop(v);
        if (gt >= 0) town.setZone(v, gt, [ZONE_MEADOW, ZONE_WOODS, ZONE_PLAZA, ZONE_WATER][Math.floor(rand() * 4)]);
      } else if (r < 0.85) {
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
    town.add(v, 0, 0, 1, ZONE_MEADOW);
    town.add(v, 1, 0, 2);
    town.add(v, 2, 0, 3);
    const kk = key(v, 2);
    for (let i = 0; i < 10; i++) {
      const before = town.cells.get(kk)!.tile;
      const ch = town.reroll(v, 2)!;
      expect(town.cells.get(kk)!.tile).not.toBe(before);
      expect(isStorey(town.cells.get(kk)!.tile)).toBe(true);
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
    expect(tiles.some(isGroundTile)).toBe(true);
    expect(tiles.some(isStorey)).toBe(true);
  });
});

describe('builder', () => {
  it.each(['pastel', 'island', 'mountain'] as const)('produces finite geometry for every voxel of a %s village', (theme) => {
    const town = new Town(grid);
    generateTown(town, mulberry32(5), theme);
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
  it('walls face non-buildings and cliffs face open sky', () => {
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
          if (town.isGround(v, lvl)) expect(town.groundTop(n)).toBe(-1); // cliffs face open sky
          else expect(town.isBuilding(n, lvl)).toBe(false); // walls face anything but another building
        }
      }
    }
  });
});

describe('terrain', () => {
  it('keeps land columns solid and only lets buildings sit above level 0', () => {
    const town = new Town(grid);
    const v = grid.pos.findIndex((_, i) => grid.buildable[i] && Math.hypot(grid.pos[i].x, grid.pos[i].z) < 2);
    expect(town.add(v, 1, 0, 1, ZONE_MEADOW)).toBeNull(); // no floating land
    expect(town.add(v, 0, 0, 1, KIND_BUILDING)).toBeNull(); // no buildings at sea level
    town.add(v, 0, 0, 1, ZONE_MEADOW);
    town.add(v, 1, 0, 2, ZONE_WOODS);
    expect(town.groundTop(v)).toBe(1);
    expect(town.remove(v, 0)).toBeNull(); // can't dig out the middle of a hill
    expect(town.remove(v, 1)).not.toBeNull();
    expect(town.groundTop(v)).toBe(0);
  });

  it('joins neighbouring terrain without cracks', () => {
    const town = new Town(grid);
    generateTown(town, mulberry32(21));
    for (let v = 0; v < grid.pos.length; v++) {
      for (const Q of grid.quarters[v]) {
        // The shared corner computed from either side must agree.
        const a = pointHeight(town, [v, Q.n1, Q.n2, Q.n3]);
        const b = pointHeight(town, [Q.n2, Q.n3, v, Q.n1]);
        expect(a).toBeCloseTo(b, 9);
      }
    }
  });

  it('generates hills, woods, water and squares', () => {
    const town = new Town(grid);
    generateTown(town, mulberry32(8));
    const kinds = new Set([...town.cells.values()].map((c) => c.kind));
    for (const z of [ZONE_MEADOW, ZONE_WOODS, ZONE_WATER, ZONE_PLAZA, KIND_BUILDING]) expect(kinds.has(z)).toBe(true);
    expect([...town.cells.keys()].some((k) => keyK(k) > 0 && town.isGround(keyV(k), keyK(k)))).toBe(true);
    assertConsistent(town);
  });
});

describe('greek villages', () => {
  const ROOFS: Record<number, number[]> = {
    [STYLE_PASTEL]: [R_NONE, R_HIP, R_STEEP, R_FLAT],
    [STYLE_ISLAND]: [R_NONE, R_FLAT, R_DOME, R_MILL],
    [STYLE_MOUNTAIN]: [R_NONE, R_SLATE, R_STEEP, R_FLAT],
  };

  for (const theme of ['island', 'mountain'] as const) {
    it(`generates a consistent ${theme} village with only that style's roofs`, () => {
      const town = new Town(grid);
      generateTown(town, mulberry32(theme === 'island' ? 5 : 6), theme);
      assertConsistent(town);
      const style = theme === 'island' ? STYLE_ISLAND : STYLE_MOUNTAIN;
      let storeys = 0;
      for (const c of town.cells.values()) {
        if (!isStorey(c.tile)) continue;
        storeys++;
        expect(c.style).toBe(style);
        expect(ROOFS[style]).toContain(decodeStorey(c.tile).roof);
      }
      expect(storeys).toBeGreaterThan(30);
      const zones = new Set([...town.cells.values()].map((c) => c.kind));
      expect(zones.has(ZONE_ROCKY) || zones.has(ZONE_OLIVE)).toBe(true);
    });
  }

  it('turns a lone single-storey island house into a chapel or plain house, and lone towers may become windmills', () => {
    const town = new Town(grid);
    const v = grid.pos.findIndex((_, i) => grid.buildable[i] && Math.hypot(grid.pos[i].x, grid.pos[i].z) < 2);
    town.add(v, 0, 0, 1, ZONE_MEADOW);
    town.add(v, 1, 8, 2, KIND_BUILDING, STYLE_ISLAND);
    const seen = new Set<number>();
    for (let i = 0; i < 25; i++) {
      town.reroll(v, 1);
      const st = decodeStorey(town.get(v, 1)!.tile);
      if (st.feat === F_CHAPEL) expect(st.roof).toBe(R_DOME);
      seen.add(st.feat);
    }
    expect(seen.has(F_CHAPEL)).toBe(true);
    town.add(v, 2, 8, 3, KIND_BUILDING, STYLE_ISLAND);
    town.add(v, 3, 8, 4, KIND_BUILDING, STYLE_ISLAND);
    const roofs = new Set<number>();
    for (let i = 0; i < 25; i++) {
      town.reroll(v, 3);
      roofs.add(decodeStorey(town.get(v, 3)!.tile).roof);
    }
    expect(roofs.has(R_MILL)).toBe(true);
    assertConsistent(town);
  });

  it('lets different styles stand side by side and repaints styles consistently', () => {
    const town = new Town(grid);
    const centre = grid.pos.map((_, i) => i).filter((i) => grid.buildable[i] && Math.hypot(grid.pos[i].x, grid.pos[i].z) < 3);
    for (const u of centre) town.add(u, 0, 0, u, ZONE_MEADOW);
    const styles = [STYLE_PASTEL, STYLE_ISLAND, STYLE_MOUNTAIN];
    centre.forEach((u, i) => town.add(u, 1, i % 11, u * 3, KIND_BUILDING, styles[i % 3]));
    assertConsistent(town);
    for (const u of centre.slice(0, 6)) town.paint(u, 1, 9, STYLE_MOUNTAIN);
    assertConsistent(town);
    expect(town.styleAt(centre[0], 1)).toBe(STYLE_MOUNTAIN);
    const copy = new Town(grid);
    copy.load(town.serialize());
    expect(copy.styleAt(centre[1], 1)).toBe(town.styleAt(centre[1], 1));
  });
});
