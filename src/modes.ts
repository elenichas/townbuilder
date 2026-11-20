/**
 * The three world modes. A mode sets the building style for new houses, which land types the
 * Land tool offers (and what they're called), the colours of the landscape, the sky, and what
 * "Surprise me" grows.
 */
import * as THREE from 'three';
import {
  STYLE_ISLAND,
  STYLE_MOUNTAIN,
  STYLE_PASTEL,
  ZONE_MEADOW,
  ZONE_OLIVE,
  ZONE_PLAZA,
  ZONE_ROAD,
  ZONE_ROCKY,
  ZONE_WATER,
  ZONE_WOODS,
} from './tiles';
import { MODE_ISLAND, MODE_MOUNTAIN, MODE_PASTEL } from './town';

export { MODE_ISLAND, MODE_MOUNTAIN, MODE_PASTEL };

export interface ZoneChoice {
  zone: number;
  label: string;
  color: string;
}

export interface ModeInfo {
  id: number;
  name: string;
  tagline: string;
  style: number;
  /** Default paint colour index for this mode. */
  color: number;
  zones: ZoneChoice[];
}

export const MODES: ModeInfo[] = [
  {
    id: MODE_PASTEL,
    name: 'Pastel town',
    tagline: 'Colourful plastered houses and tiled roofs on green islands',
    style: STYLE_PASTEL,
    color: 0,
    zones: [
      { zone: ZONE_MEADOW, label: 'Meadow', color: '#93cc6e' },
      { zone: ZONE_WOODS, label: 'Woods', color: '#4f9a63' },
      { zone: ZONE_PLAZA, label: 'Square', color: '#e2d6c0' },
      { zone: ZONE_ROAD, label: 'Path', color: '#d9cbb0' },
      { zone: ZONE_WATER, label: 'Water', color: '#79c3e2' },
    ],
  },
  {
    id: MODE_ISLAND,
    name: 'Greek island',
    tagline: 'Whitewashed Chora on the hill, a port below, lanes and summer flowers',
    style: STYLE_ISLAND,
    color: 8,
    zones: [
      { zone: ZONE_MEADOW, label: 'Summer hillside', color: '#d6cb8c' },
      { zone: ZONE_ROCKY, label: 'Phrygana scrub', color: '#cbbd94' },
      { zone: ZONE_OLIVE, label: 'Olive grove', color: '#a8ad62' },
      { zone: ZONE_ROAD, label: 'Whitewashed lane', color: '#ece8de' },
      { zone: ZONE_PLAZA, label: 'Square / quay', color: '#e4ddcf' },
      { zone: ZONE_WATER, label: 'Sea / harbour', color: '#36a3c4' },
    ],
  },
  {
    id: MODE_MOUNTAIN,
    name: 'Greek mountain village',
    tagline: 'Stone houses and slate roofs, cobbled kalderimi paths, firs and rivers',
    style: STYLE_MOUNTAIN,
    color: 9,
    zones: [
      { zone: ZONE_MEADOW, label: 'Mountain meadow', color: '#7fba5c' },
      { zone: ZONE_WOODS, label: 'Fir & chestnut forest', color: '#2f6b46' },
      { zone: ZONE_ROCKY, label: 'Limestone slope', color: '#b5b3ab' },
      { zone: ZONE_ROAD, label: 'Kalderimi (cobbled path)', color: '#9c958a' },
      { zone: ZONE_PLAZA, label: 'Village square', color: '#c9c1b2' },
      { zone: ZONE_WATER, label: 'River / lake', color: '#5aa4b4' },
    ],
  },
];

/** Sea level in Greek island mode: the same height as harbour water, so the port opens onto the sea. */
export const SEA_LEVEL = -0.1;

export const modeInfo = (m: number) => MODES.find((x) => x.id === m) ?? MODES[0];

const c = (h: string) => new THREE.Color(h);

/** Landscape colours per mode. */
export interface LandPalette {
  meadow: THREE.Color;
  tuft: THREE.Color;
  lip: THREE.Color;
  woods: THREE.Color;
  olive: THREE.Color;
  rocky: THREE.Color;
  plaza: THREE.Color;
  road: THREE.Color;
  roadEdge: THREE.Color;
  joint: THREE.Color;
  rock: THREE.Color;
  rockDark: THREE.Color;
  water: THREE.Color;
  bed: THREE.Color;
}

export const LAND: Record<number, LandPalette> = {
  [MODE_PASTEL]: {
    meadow: c('#93cc6e'),
    tuft: c('#6aa553'),
    lip: c('#6aa553'),
    woods: c('#7fb862'),
    olive: c('#bfc277'),
    rocky: c('#cfbd8f'),
    plaza: c('#e2d6c0'),
    road: c('#ddcfb3'),
    roadEdge: c('#c4b393'),
    joint: c('#fbfaf6'),
    rock: c('#c3a68b'),
    rockDark: c('#8e7464'),
    water: c('#79c3e2'),
    bed: c('#d6c79c'),
  },
  // Dry, sun-bleached Cycladic summer: golden grass, pale limestone, turquoise sea.
  [MODE_ISLAND]: {
    meadow: c('#d3c78a'),
    tuft: c('#a99a5a'),
    lip: c('#b6a66b'),
    woods: c('#b9b67a'),
    olive: c('#c2bd80'),
    rocky: c('#cbbd94'),
    plaza: c('#e4ddcf'),
    road: c('#e3ded2'),
    roadEdge: c('#fbfaf6'),
    joint: c('#fbfaf6'),
    rock: c('#ddd3c3'),
    rockDark: c('#a8998a'),
    water: c('#36a3c4'),
    bed: c('#e6d9b0'),
  },
  // Green mountain slopes, grey limestone, cobbled paths and cool rivers.
  [MODE_MOUNTAIN]: {
    meadow: c('#7fba5c'),
    tuft: c('#4f8a3e'),
    lip: c('#5d9a48'),
    woods: c('#5e9a4c'),
    olive: c('#a9b56a'),
    rocky: c('#b5b3ab'),
    plaza: c('#c9c1b2'),
    road: c('#958c7e'),
    roadEdge: c('#6a6358'),
    joint: c('#6e675c'),
    rock: c('#a8a399'),
    rockDark: c('#6f6a63'),
    water: c('#5aa4b4'),
    bed: c('#b7ae97'),
  },
};

/** Daytime sky per mode (top, horizon, below horizon). */
export const SKY: Record<number, [string, string, string]> = {
  [MODE_PASTEL]: ['#6aa6e6', '#fbe4cf', '#b4d3f2'],
  [MODE_ISLAND]: ['#3d8fe0', '#eaf2f8', '#9ccdf0'],
  [MODE_MOUNTAIN]: ['#6a9fd4', '#e6eee6', '#b9d2e6'],
};
