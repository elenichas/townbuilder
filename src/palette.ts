import * as THREE from 'three';

/** Paint colours. On pastel houses they colour the walls; on Greek island and mountain houses
 *  (whitewash and stone) they colour the doors, shutters, railings and domes. The last three are
 *  the classic Aegean blue, shutter green and oxblood. */
export const WALL_HEX = ['#f6ead6', '#f4b3a3', '#f7d68b', '#a8d8c6', '#9cc4ea', '#c9b2ea', '#f2a1c2', '#ebe9f0', '#2f6db5', '#3f7f5a', '#9b3b33'];
export const WALL = WALL_HEX.map((h) => new THREE.Color(h));

const c = (h: string) => new THREE.Color(h);
export const COL = {
  trim: c('#fbf7ef'),
  stone: c('#d8cebf'),
  glass: c('#4c6688'),
  wood: c('#8d5b3c'),
  iron: c('#4b4f5c'),
  roofHip: c('#d06f55'),
  roofSteep: [c('#5a7db3'), c('#3f8f86'), c('#8a6bb8')],
  terrace: c('#e6dac4'),
  grass: c('#93cc6e'),
  grassDark: c('#6aa553'),
  plaza: c('#e2d6c0'),
  rock: c('#c3a68b'),
  rockDark: c('#8e7464'),
  water: c('#79c3e2'),
  leaf: [c('#6fbf5b'), c('#5aa85a'), c('#8fd06a')],
  pine: c('#4f9a63'),
  trunk: c('#8a644a'),
  flag: [c('#ff6b6b'), c('#ffd166'), c('#4ecdc4')],
};
export const SHUTTER = [c('#5f9e7a'), c('#4d7fb3'), c('#c0574a'), c('#d9a441')];
export const AWNING = [c('#e06a5c'), c('#4c8dbf'), c('#57a77c'), c('#e3a33b')];
export const FLOWER = [c('#ff8fb1'), c('#ffd166'), c('#ffffff'), c('#c49bff'), c('#ff7a6b')];

export const shade = (col: THREE.Color, f: number) => col.clone().multiplyScalar(f);
export const mix = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t);
