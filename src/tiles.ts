/**
 * The tile catalogue the WFC solver picks from.
 *
 * Every filled voxel is one WFC variable. What it *can* be depends on its context
 * (the fill pattern around it): a voxel at level 0 is an island, above that it is a
 * storey of a house. Which version of that it becomes is chosen by the solver so that
 * neighbouring pieces fit together (the adjacency rules in `compat`).
 */

export const WIN = ['square', 'arch', 'round'] as const;
export const FEAT = ['plain', 'shutters', 'flowers', 'balcony', 'door', 'shop'] as const;
export const ROOF = ['none', 'hip', 'steep', 'flat'] as const;
export const GROUND = ['grass', 'flowers', 'tree', 'plaza', 'pond'] as const;

export const W_SQUARE = 0, W_ARCH = 1, W_ROUND = 2;
export const F_PLAIN = 0, F_SHUTTERS = 1, F_FLOWERS = 2, F_BALCONY = 3, F_DOOR = 4, F_SHOP = 5;
export const R_NONE = 0, R_HIP = 1, R_STEEP = 2, R_FLAT = 3;
export const G_GRASS = 0, G_FLOWERS = 1, G_TREE = 2, G_PLAZA = 3, G_POND = 4;

export const N_STOREY = WIN.length * FEAT.length * ROOF.length; // 72
export const ISLAND0 = N_STOREY; // 72..76
export const COVERED = ISLAND0 + GROUND.length; // 77: island hidden under a building
export const N_TILES = COVERED + 1;

export const storeyTile = (w: number, f: number, r: number) => (w * FEAT.length + f) * ROOF.length + r;
export const islandTile = (g: number) => ISLAND0 + g;
export const isStorey = (t: number) => t >= 0 && t < N_STOREY;
export const isIsland = (t: number) => t >= ISLAND0 && t < COVERED;

export interface StoreyStyle {
  win: number;
  feat: number;
  roof: number;
}
export function decodeStorey(t: number): StoreyStyle {
  return { win: Math.floor(t / (FEAT.length * ROOF.length)), feat: Math.floor(t / ROOF.length) % FEAT.length, roof: t % ROOF.length };
}
export const decodeIsland = (t: number) => t - ISLAND0;

/** Relations between neighbouring variables. */
export const REL_SAME = 0; // two voxels on the same level sharing a quad
export const REL_IS = 1; // this var is an island top, neighbour is a ground-floor storey next to it
export const REL_SI = 2; // reverse of REL_IS
export const revRel = (r: number) => (r === REL_IS ? REL_SI : r === REL_SI ? REL_IS : r);

/** Adjacency rules ("sockets"). `a` is this variable's tile, `b` the neighbour's. */
export function compat(rel: number, a: number, b: number): boolean {
  if (rel === REL_SI) return compat(REL_IS, b, a);
  if (rel === REL_IS) {
    if (!isIsland(a) || !isStorey(b)) return true;
    const f = decodeStorey(b).feat;
    // Doors and shopfronts never open straight into a tree.
    if ((f === F_DOOR || f === F_SHOP) && decodeIsland(a) === G_TREE) return false;
    return true;
  }
  // REL_SAME
  if (isStorey(a) && isStorey(b)) {
    const A = decodeStorey(a);
    const B = decodeStorey(b);
    // A floor of a building shares one window style, so facades read as one building.
    if (A.win !== B.win) return false;
    // Roofs that touch must be the same kind, otherwise their shared ridge points don't line up.
    if (A.roof !== R_NONE && B.roof !== R_NONE && A.roof !== B.roof) return false;
    // No two doors right next to each other.
    if (A.feat === F_DOOR && B.feat === F_DOOR) return false;
    return true;
  }
  if (isIsland(a) && isIsland(b)) {
    // Trees need a bit of room.
    if (decodeIsland(a) === G_TREE && decodeIsland(b) === G_TREE) return false;
    return true;
  }
  return true;
}

export const WIN_WEIGHT = [1.4, 1.0, 0.7];
export const FEAT_WEIGHT = [2.2, 1.6, 1.3, 1.4, 3.0, 1.2];
export const ROOF_WEIGHT = [1, 3, 2.2, 1];
export const GROUND_WEIGHT = [2.5, 1.2, 1.4, 0.4, 0.5];
