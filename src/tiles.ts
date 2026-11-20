/**
 * The tile catalogue the WFC solver picks from.
 *
 * Every filled voxel is one WFC variable. What it *can* be depends on its context
 * (the fill pattern around it, and for land the terrain type the player painted).
 * Which version it becomes is chosen by the solver so neighbouring pieces fit
 * together (the adjacency rules in `compat`).
 */

// ---------------------------------------------------------------- voxel kinds

export const KIND_BUILDING = 0;
export const ZONE_MEADOW = 1;
export const ZONE_WOODS = 2;
export const ZONE_PLAZA = 3;
export const ZONE_WATER = 4;
export const ZONE_OLIVE = 5;
export const ZONE_ROCKY = 6;
/** Streets: island lanes, mountain kalderimi (cobbled mule paths) or plain paths. */
export const ZONE_ROAD = 7;
export const isZone = (kind: number) => kind >= ZONE_MEADOW && kind <= ZONE_ROAD;
/** Land you can walk on to reach a door. */
export const isWalkableZone = (z: number) => isZone(z) && z !== ZONE_WATER && z !== ZONE_WOODS;

export const ZONES = [
  { id: ZONE_MEADOW, name: 'Meadow', color: '#93cc6e' },
  { id: ZONE_WOODS, name: 'Woods', color: '#4f9a63' },
  { id: ZONE_PLAZA, name: 'Square', color: '#e2d6c0' },
  { id: ZONE_WATER, name: 'Water', color: '#79c3e2' },
  { id: ZONE_OLIVE, name: 'Olive grove', color: '#a8ad62' },
  { id: ZONE_ROCKY, name: 'Rocky hillside', color: '#c9b78a' },
  { id: ZONE_ROAD, name: 'Path', color: '#d9cbb0' },
] as const;

// ---------------------------------------------------------------- building styles

/** Architectural style of a storey. Island = Cycladic, Mountain = Zagori / Pelion / Mani stone. */
export const STYLE_PASTEL = 0;
export const STYLE_ISLAND = 1;
export const STYLE_MOUNTAIN = 2;
export const STYLES = [
  { id: STYLE_PASTEL, name: 'Pastel town' },
  { id: STYLE_ISLAND, name: 'Greek island (Cycladic)' },
  { id: STYLE_MOUNTAIN, name: 'Greek mountain (stone)' },
] as const;

// ---------------------------------------------------------------- storey tiles

export const WIN = ['square', 'arch', 'round'] as const;
export const FEAT = ['plain', 'shutters', 'flowers', 'balcony', 'door', 'shop', 'chapel'] as const;
export const ROOF = ['none', 'hip', 'steep', 'flat', 'dome', 'slate', 'mill'] as const;

export const W_SQUARE = 0, W_ARCH = 1, W_ROUND = 2;
export const F_PLAIN = 0, F_SHUTTERS = 1, F_FLOWERS = 2, F_BALCONY = 3, F_DOOR = 4, F_SHOP = 5, F_CHAPEL = 6;
/** dome = rounded Cycladic roof (a dome on a lone house, a barrel vault along a row); slate = mountain roof; mill = windmill cap. */
export const R_NONE = 0, R_HIP = 1, R_STEEP = 2, R_FLAT = 3, R_DOME = 4, R_SLATE = 5, R_MILL = 6;

export const N_STOREY = WIN.length * FEAT.length * ROOF.length; // 147
export const storeyTile = (w: number, f: number, r: number) => (w * FEAT.length + f) * ROOF.length + r;
export const isStorey = (t: number) => t >= 0 && t < N_STOREY;

export interface StoreyStyle {
  win: number;
  feat: number;
  roof: number;
}
export function decodeStorey(t: number): StoreyStyle {
  return { win: Math.floor(t / (FEAT.length * ROOF.length)), feat: Math.floor(t / ROOF.length) % FEAT.length, roof: t % ROOF.length };
}

// ---------------------------------------------------------------- ground tiles

export interface GroundTile {
  zone: number;
  name: string;
  weight: number;
}

export const GROUND_TILES: GroundTile[] = [
  { zone: ZONE_MEADOW, name: 'grass', weight: 2.5 },
  { zone: ZONE_MEADOW, name: 'flowers', weight: 1.2 },
  { zone: ZONE_MEADOW, name: 'tree', weight: 1.1 },
  { zone: ZONE_MEADOW, name: 'bush', weight: 0.9 },
  { zone: ZONE_MEADOW, name: 'rocks', weight: 0.45 },
  { zone: ZONE_WOODS, name: 'pines', weight: 2 },
  { zone: ZONE_WOODS, name: 'oaks', weight: 2 },
  { zone: ZONE_WOODS, name: 'grove', weight: 1.3 },
  { zone: ZONE_WOODS, name: 'clearing', weight: 0.45 },
  { zone: ZONE_PLAZA, name: 'paving', weight: 2.4 },
  { zone: ZONE_PLAZA, name: 'lamp', weight: 1.2 },
  { zone: ZONE_PLAZA, name: 'fountain', weight: 0.6 },
  { zone: ZONE_PLAZA, name: 'bench', weight: 1 },
  { zone: ZONE_PLAZA, name: 'market', weight: 0.7 },
  { zone: ZONE_PLAZA, name: 'planter', weight: 0.9 },
  { zone: ZONE_PLAZA, name: 'plane', weight: 0.7 },
  { zone: ZONE_PLAZA, name: 'cafe', weight: 0.9 },
  { zone: ZONE_WATER, name: 'open', weight: 2.5 },
  { zone: ZONE_WATER, name: 'lilies', weight: 1 },
  { zone: ZONE_WATER, name: 'reeds', weight: 1.6 },
  { zone: ZONE_WATER, name: 'boat', weight: 0.5 },
  { zone: ZONE_WATER, name: 'rock', weight: 0.4 },
  { zone: ZONE_WATER, name: 'caique', weight: 2.5 },
  { zone: ZONE_OLIVE, name: 'olives', weight: 2.4 },
  { zone: ZONE_OLIVE, name: 'cypresses', weight: 1 },
  { zone: ZONE_OLIVE, name: 'olive_cypress', weight: 1.2 },
  { zone: ZONE_OLIVE, name: 'drywall', weight: 1 },
  { zone: ZONE_OLIVE, name: 'poppies', weight: 0.8 },
  { zone: ZONE_ROCKY, name: 'boulders', weight: 1.6 },
  { zone: ZONE_ROCKY, name: 'scrub', weight: 2 },
  { zone: ZONE_ROCKY, name: 'goat', weight: 0.6 },
  { zone: ZONE_ROCKY, name: 'shrine', weight: 0.35 },
  { zone: ZONE_ROCKY, name: 'stones', weight: 1.2 },
  { zone: ZONE_ROAD, name: 'lane', weight: 2.6 },
  { zone: ZONE_ROAD, name: 'lane_pots', weight: 1.1 },
  { zone: ZONE_ROAD, name: 'lane_lamp', weight: 0.7 },
  { zone: ZONE_ROAD, name: 'lane_cat', weight: 0.35 },
];

export const GROUND0 = N_STOREY;
export const COVERED = GROUND0 + GROUND_TILES.length; // land hidden under something
export const N_TILES = COVERED + 1;

const gid = (name: string) => {
  const i = GROUND_TILES.findIndex((t) => t.name === name);
  if (i < 0) throw new Error(`unknown ground tile ${name}`);
  return GROUND0 + i;
};
/** Ground tile ids by name. */
export const T = Object.fromEntries(GROUND_TILES.map((t) => [t.name, gid(t.name)])) as Record<string, number>;

export const isGroundTile = (t: number) => t >= GROUND0 && t < COVERED;
export const groundTile = (t: number): GroundTile | undefined => GROUND_TILES[t - GROUND0];
export const zoneTiles = (zone: number) => GROUND_TILES.flatMap((t, i) => (t.zone === zone ? [GROUND0 + i] : []));

// ---------------------------------------------------------------- adjacency rules

/** Relations between neighbouring variables. */
export const REL_SAME = 0; // same level, sharing a quad, same kind (both buildings or both land)
export const REL_IS = 1; // this var is open land, neighbour is a building storey standing next to it
export const REL_SI = 2; // reverse of REL_IS
export const REL_MIX = 3; // same level, sharing a quad, both buildings but of different styles
export const revRel = (r: number) => (r === REL_IS ? REL_SI : r === REL_SI ? REL_IS : r);

/** Pairs of land tiles that may not sit next to each other. */
const FORBIDDEN_PAIRS: [string, string][] = [
  ['tree', 'tree'], // lone meadow trees need room
  ['clearing', 'clearing'], // woods stay woods
  ['pines', 'oaks'], // forests grow in stands; groves blend between them
  ['fountain', 'fountain'],
  ['fountain', 'market'],
  ['lamp', 'lamp'],
  ['boat', 'boat'],
  ['rock', 'rock'],
  ['plane', 'plane'], // one big plane tree shades a square
  ['plane', 'fountain'],
  ['goat', 'goat'],
  ['shrine', 'shrine'],
  ['drywall', 'drywall'],
  ['lane_lamp', 'lane_lamp'],
  ['lane_cat', 'lane_cat'],
];
const forbidden = new Set<number>();
for (const [a, b] of FORBIDDEN_PAIRS) {
  forbidden.add(T[a] * N_TILES + T[b]);
  forbidden.add(T[b] * N_TILES + T[a]);
}

/** Land tiles that would block a door or shopfront. */
const BLOCKS_DOOR = new Set(['tree', 'fountain', 'market', 'planter', 'plane', 'cypresses', 'olive_cypress', 'olives', 'boulders', 'goat', 'shrine'].map((n) => T[n]));

/** `a` is this variable's tile, `b` the neighbour's. */
export function compat(rel: number, a: number, b: number): boolean {
  if (rel === REL_SI) return compat(REL_IS, b, a);
  if (rel === REL_IS) {
    if (!isGroundTile(a) || !isStorey(b)) return true;
    const f = decodeStorey(b).feat;
    return !((f === F_DOOR || f === F_SHOP) && BLOCKS_DOOR.has(a));
  }
  if (rel === REL_MIX) {
    // Different styles may stand side by side; only the doorway rule still applies.
    if (isStorey(a) && isStorey(b)) return !(decodeStorey(a).feat === F_DOOR && decodeStorey(b).feat === F_DOOR);
    return true;
  }
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
  if (isGroundTile(a) && isGroundTile(b)) return !forbidden.has(a * N_TILES + b);
  return true;
}

export const WIN_WEIGHT = [1.4, 1.0, 0.7];
export const FEAT_WEIGHT = [2.2, 1.6, 1.3, 1.4, 3.0, 1.2, 4];
export const ROOF_WEIGHT = [1, 3, 2.2, 1, 2.2, 3, 4];
