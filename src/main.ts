import * as THREE from 'three';
import './style.css';
import { sfx, isMuted, setMuted } from './audio';
import { ACT_DOWN, ACT_NONE, ACT_UP, H } from './builder';
import { generateTown } from './generate';
import { MODE_ISLAND, SKY, modeInfo } from './modes';
import { cellAt, generateGrid } from './grid';
import { WALL_HEX } from './palette';
import { mulberry32, randomSeed } from './rng';
import { createScene } from './scene';
import { type HelpTab, initHelp } from './help';
import { decode, encode } from './share';
import { KIND_BUILDING, STYLE_PASTEL, ZONES, ZONE_MEADOW, ZONE_WATER, isZone } from './tiles';
import { type Change, Town, type Voxel, key, keyK, keyV } from './town';
import { GRID_OPACITY, Ghost, Puffs, TownView, gridLines } from './view';

type Tool = 'build' | 'land' | 'restyle' | 'paint' | 'erase';
type Hit = { kind: 'voxel'; key: number; act: number } | { kind: 'ground'; v: number };
type Action = { op: 'add' | 'remove' | 'reroll' | 'paint' | 'zone'; v: number; k: number; kind?: number };

/** Older versions autosaved the town; each visit now starts fresh, so that key is cleared. */
const OLD_TOWN_KEY = 'cloudhaven.town';
const MODE_KEY = 'cloudhaven.mode';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('scene');
const grid = generateGrid(9, 7);
const town = new Town(grid);
const ctx = createScene(canvas, grid);
const view = new TownView(town, ctx.scene, ctx.litGlass);
const ghost = new Ghost(ctx.scene);
const puffs = new Puffs(ctx.scene);
const grid3d = gridLines(town);
ctx.scene.add(grid3d);

let tool: Tool = 'build';
let color = 0;
let style = STYLE_PASTEL;
let zone = ZONE_MEADOW;
/** History entries remember the mode too, so undoing a mode switch brings the old town back as it was. */
interface HistoryEntry {
  cells: Map<number, Voxel>;
  mode: number;
}
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
const current = (): HistoryEntry => ({ cells: town.snapshot(), mode: town.mode });

// ---------------------------------------------------------------- persistence

/** Remember the last mode so a refresh opens an empty scene in the same mode. */
function save() {
  try {
    localStorage.setItem(MODE_KEY, String(town.mode));
  } catch {
    /* storage unavailable */
  }
}

async function loadInitial(): Promise<boolean> {
  const m = location.hash.match(/^#t=(.+)$/);
  if (m) {
    try {
      if (town.load(await decode(m[1]))) {
        history.replaceState(null, '', location.pathname + location.search);
        return true;
      }
    } catch {
      toast('That town link looks broken');
    }
  }
  // Otherwise start with an empty scene, in the mode used last time.
  try {
    localStorage.removeItem(OLD_TOWN_KEY);
    const m = Number(localStorage.getItem(MODE_KEY));
    if (modeInfo(m).id === m) town.mode = m;
  } catch {
    /* ignore */
  }
  return false;
}

// ---------------------------------------------------------------- picking

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const tmp = new THREE.Vector3();

function pick(x: number, y: number): Hit | null {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, ctx.camera);
  const hits = ray.intersectObjects(view.group.children, false);
  for (const h of hits) {
    if (!h.face) continue;
    const mesh = h.object as THREE.Mesh;
    const act = (mesh.geometry.getAttribute('act') as THREE.BufferAttribute).getX(h.face.a);
    return { kind: 'voxel', key: mesh.userData.key as number, act };
  }
  if (ray.ray.intersectPlane(ground, tmp)) {
    const v = cellAt(grid, { x: tmp.x, z: tmp.z });
    if (v >= 0) return { kind: 'ground', v };
  }
  return null;
}

function toolFor(e: { button?: number; altKey: boolean; shiftKey: boolean }): Tool {
  if (e.button === 2) return 'erase';
  if (e.altKey) return 'restyle';
  if (e.shiftKey) return 'paint';
  return tool;
}

function actionFor(hit: Hit | null, t: Tool): Action | null {
  if (!hit) return null;
  const newLand = t === 'land' ? zone : ZONE_MEADOW;
  if (hit.kind === 'ground') {
    if (t !== 'build' && t !== 'land') return null;
    return town.canPlace(hit.v, 0, newLand) ? { op: 'add', v: hit.v, k: 0, kind: newLand } : null;
  }
  const v = keyV(hit.key);
  let k = keyK(hit.key);
  const ground = isZone(town.kindAt(v, k));
  // Any click on a land column (even its rocky underside) acts on the column's top.
  if (ground) k = town.groundTop(v);
  const sideIsland = (): Action | null => {
    const n = hit.act - 1;
    return town.canPlace(n, 0, newLand) ? { op: 'add', v: n, k: 0, kind: newLand } : null;
  };
  switch (t) {
    case 'build': {
      if (ground) {
        if (hit.act > 0) return sideIsland();
        if (hit.act !== ACT_UP) return null;
        return town.canPlace(v, k + 1) ? { op: 'add', v, k: k + 1, kind: KIND_BUILDING } : null;
      }
      let tv = v;
      let tk = k;
      if (hit.act === ACT_UP) tk = k + 1;
      else if (hit.act === ACT_DOWN) tk = k - 1;
      else if (hit.act > 0) tv = hit.act - 1;
      else return null;
      const kind = tk === 0 ? ZONE_MEADOW : KIND_BUILDING;
      return town.canPlace(tv, tk, kind) ? { op: 'add', v: tv, k: tk, kind } : null;
    }
    case 'land': {
      if (!ground) return null;
      if (hit.act > 0) return sideIsland();
      if (hit.act === ACT_NONE || town.has(v, k + 1)) return null;
      // First click paints the land; clicking land that already has this type raises a hill.
      if (town.kindAt(v, k) !== zone) return { op: 'zone', v, k };
      if (zone === ZONE_WATER) return null;
      return town.canPlace(v, k + 1, zone) ? { op: 'add', v, k: k + 1, kind: zone } : null;
    }
    case 'erase':
      return { op: 'remove', v, k };
    case 'restyle':
      return { op: 'reroll', v, k };
    case 'paint':
      return !ground && (town.get(v, k)?.color !== color || town.styleAt(v, k) !== style) ? { op: 'paint', v, k } : null;
  }
}

const GHOST_COLOR: Record<Action['op'], string> = { add: '#ffffff', remove: '#ff7b7b', reroll: '#ffd65c', paint: '#ffffff', zone: '#ffffff' };
const zoneColor = (z: number) => modeInfo(town.mode).zones.find((x) => x.zone === z)?.color ?? ZONES.find((x) => x.id === z)?.color ?? '#ffffff';

function showGhost(a: Action | null) {
  if (!a) return ghost.hide();
  let col = GHOST_COLOR[a.op];
  if (a.op === 'paint') col = WALL_HEX[color];
  else if (a.op === 'zone' || (a.op === 'add' && isZone(a.kind ?? -1) && tool === 'land')) col = zoneColor(zone);
  ghost.show(grid.ring[a.v], a.k, col, a.op === 'add' ? 0.0 : 0.04);
}

// ---------------------------------------------------------------- actions

function perform(a: Action) {
  const snap = town.snapshot();
  let ch: Change | null = null;
  if (a.op === 'add') ch = town.add(a.v, a.k, color, randomSeed(), a.kind ?? KIND_BUILDING, style);
  else if (a.op === 'zone') ch = town.setZone(a.v, a.k, zone);
  else if (a.op === 'remove') ch = town.remove(a.v, a.k);
  else if (a.op === 'reroll') ch = town.reroll(a.v, a.k);
  else ch = town.paint(a.v, a.k, color, style);
  if (!ch) return;
  undoStack.push({ cells: snap, mode: town.mode });
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;

  const kk = key(a.v, a.k);
  // On a restyle, everything that changed to fit pops, so you can see what is connected.
  view.apply(ch, a.op === 'reroll' || a.op === 'zone' || a.op === 'paint' ? new Set([kk, ...ch.look]) : new Set([kk]));

  const p = grid.pos[a.v];
  const y = a.k === 0 ? 0.1 : (a.k - 0.4) * H;
  if (a.op === 'add' || a.op === 'zone') {
    puffs.burst(p.x, y, p.z, a.op === 'zone' ? 4 : 7);
    sfx.place(a.k);
  } else if (a.op === 'remove') {
    puffs.burst(p.x, y, p.z, 4);
    sfx.remove();
  } else if (a.op === 'reroll') {
    sfx.reroll(a.k);
  } else sfx.paint();
  afterChange();
}

function stepHistory(from: HistoryEntry[], to: HistoryEntry[]) {
  const entry = from.pop();
  if (!entry) return;
  to.push(current());
  if (entry.mode !== town.mode) {
    town.restore(entry.cells);
    setMode(entry.mode, { rebuild: false });
    view.rebuildAll();
  } else view.apply(town.restore(entry.cells));
  afterChange();
}

function replaceTown(fn: () => void) {
  undoStack.push(current());
  redoStack.length = 0;
  fn();
  view.rebuildAll();
  afterChange();
}

function afterChange() {
  save();
  $('undo').toggleAttribute('disabled', !undoStack.length);
  $('redo').toggleAttribute('disabled', !redoStack.length);
  $('hint').classList.toggle('hidden', town.cells.size > 0);
  refreshHover();
}

// ---------------------------------------------------------------- input

let down: { x: number; y: number; t: number; button: number; id: number } | null = null;
let pointers = 0;
let lastMouse: { x: number; y: number; altKey: boolean; shiftKey: boolean } | null = null;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  pointers++;
  down = pointers === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, id: e.pointerId } : null;
});
canvas.addEventListener('pointerup', (e) => {
  pointers = Math.max(0, pointers - 1);
  const d = down;
  down = null;
  if (!d || d.id !== e.pointerId || d.button !== e.button) return;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 600) return;
  const a = actionFor(pick(e.clientX, e.clientY), toolFor(e));
  if (a) perform(a);
});
canvas.addEventListener('pointercancel', () => {
  pointers = Math.max(0, pointers - 1);
  down = null;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  lastMouse = { x: e.clientX, y: e.clientY, altKey: e.altKey, shiftKey: e.shiftKey };
  hoverDirty = true;
});
canvas.addEventListener('pointerleave', () => {
  lastMouse = null;
  ghost.hide();
});

let hoverDirty = false;
function refreshHover() {
  hoverDirty = true;
}
function updateHover() {
  if (!hoverDirty) return;
  hoverDirty = false;
  if (!lastMouse || down) return ghost.hide();
  showGhost(actionFor(pick(lastMouse.x, lastMouse.y), toolFor(lastMouse)));
}

window.addEventListener('keydown', (e) => {
  if (lastMouse) {
    lastMouse.altKey = e.altKey;
    lastMouse.shiftKey = e.shiftKey;
    refreshHover();
  }
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) stepHistory(redoStack, undoStack);
    else stepHistory(undoStack, redoStack);
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    stepHistory(redoStack, undoStack);
  } else if (!mod) {
    const tools: Tool[] = ['build', 'land', 'restyle', 'paint', 'erase'];
    if (e.key >= '1' && e.key <= '5') setTool(tools[+e.key - 1]);
    else if (e.key.toLowerCase() === 'n') toggleNight();
    else if (e.key === '?') toggleHelp(true);
    else if (e.key === 'Escape') toggleHelp(false);
  }
});
window.addEventListener('keyup', (e) => {
  if (lastMouse) {
    lastMouse.altKey = e.altKey;
    lastMouse.shiftKey = e.shiftKey;
    refreshHover();
  }
});

// ---------------------------------------------------------------- UI

function setTool(t: Tool) {
  tool = t;
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
    const on = b.dataset.tool === t;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  swatches.hidden = t === 'land';
  zoneSwatches.hidden = t !== 'land';
  refreshHover();
}
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));

const swatches = $('swatches');
function selectColor(i: number) {
  color = i;
  swatches.querySelectorAll('.swatch').forEach((s, j) => s.classList.toggle('active', j === i));
}
WALL_HEX.forEach((hex, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' active' : '');
  b.style.background = hex;
  b.title = `Colour ${i + 1}`;
  b.setAttribute('aria-label', `Colour ${i + 1}`);
  b.addEventListener('click', () => {
    selectColor(i);
    if (tool !== 'paint' && tool !== 'build') setTool('build');
  });
  swatches.appendChild(b);
});

// Land types offered by the current mode (with the mode's own names, e.g. "Kalderimi").
const zoneSwatches = $('zones');
function renderZoneSwatches() {
  const choices = modeInfo(town.mode).zones;
  if (!choices.some((c) => c.zone === zone)) zone = choices[0].zone;
  zoneSwatches.replaceChildren(
    ...choices.map((c) => {
      const b = document.createElement('button');
      b.className = 'swatch zone' + (c.zone === zone ? ' active' : '');
      b.style.background = c.color;
      b.title = c.label;
      b.setAttribute('aria-label', c.label);
      b.addEventListener('click', () => {
        zone = c.zone;
        zoneSwatches.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === b));
        setTool('land');
      });
      return b;
    }),
  );
}
zoneSwatches.hidden = true;

// ---------------------------------------------------------------- modes

const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
/** Switch the world mode: building style, land palette, landscape colours and sky. */
function setMode(m: number, opts: { announce?: boolean; rebuild?: boolean } = {}) {
  const info = modeInfo(m);
  const changed = town.mode !== m;
  // Switching modes from the switcher starts a fresh scene (undo brings the old town back).
  const cleared = !!opts.announce && changed && town.cells.size > 0;
  if (cleared) {
    undoStack.push(current());
    redoStack.length = 0;
    town.clear();
  }
  town.mode = m;
  style = info.style;
  selectColor(info.color);
  renderZoneSwatches();
  ctx.setSky(...SKY[m]);
  ctx.setSea(m === MODE_ISLAND);
  $('hint').textContent = m === MODE_ISLAND ? 'Click the sea to raise an island' : 'Click the clouds to raise an island';
  modeButtons.forEach((b) => {
    const on = Number(b.dataset.mode) === m;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  $('modeTagline').textContent = info.tagline;
  document.body.dataset.mode = String(m);
  if (opts.rebuild !== false && changed) view.rebuildAll();
  if (opts.announce && changed) {
    ctx.resetView();
    const start = m === MODE_ISLAND ? 'click the sea' : 'click the clouds';
    toast(cleared ? `${info.name}: fresh start (undo brings your town back)` : `${info.name}: ${start} to start, or try Surprise me`);
    afterChange();
  }
  refreshHover();
}
modeButtons.forEach((b, i) => {
  b.addEventListener('click', () => setMode(Number(b.dataset.mode), { announce: true }));
  b.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = modeButtons[(i + d + modeButtons.length) % modeButtons.length];
    next.click();
    next.focus();
  });
});

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2200);
}

const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />';
const SUN = '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />';
function toggleNight(instant = false) {
  const n = !ctx.isNight();
  ctx.setNight(n, instant);
  $('night').querySelector('svg')!.innerHTML = n ? SUN : MOON;
}
$('night').addEventListener('click', () => toggleNight());

/** Grow a whole village for the current mode. */
function surprise() {
  replaceTown(() => generateTown(town, mulberry32(randomSeed()), town.mode));
  ctx.resetView();
  puffs.burst(0, 1, 0, 14);
  sfx.reroll(4);
}
$('surprise').addEventListener('click', () => surprise());

$('clear').addEventListener('click', () => {
  if (!town.cells.size) return;
  if (!confirm('Clear the whole town? (You can undo this.)')) return;
  replaceTown(() => town.clear());
});

$('undo').addEventListener('click', () => stepHistory(undoStack, redoStack));
$('redo').addEventListener('click', () => stepHistory(redoStack, undoStack));

$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#t=${await encode(town.serialize())}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    history.replaceState(null, '', url);
    toast('Link is in the address bar');
  }
});

$('photo').addEventListener('click', () => {
  ghost.hide();
  ctx.tick(0, performance.now() / 1000);
  const a = document.createElement('a');
  a.download = 'cloudhaven.png';
  a.href = ctx.renderer.domElement.toDataURL('image/png');
  a.click();
});

const SOUND_ON = '<path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7" />';
const SOUND_OFF = '<path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6" />';
const syncSound = () => ($('sound').querySelector('svg')!.innerHTML = isMuted() ? SOUND_OFF : SOUND_ON);
$('sound').addEventListener('click', () => {
  setMuted(!isMuted());
  syncSound();
});
syncSound();

const help = initHelp();
function toggleHelp(show: boolean, tab?: HelpTab) {
  $('help').classList.toggle('hidden', !show);
  if (tab) help.select(tab);
  if (show) $('helpClose').focus();
  else help.pause();
}
$('helpBtn').addEventListener('click', () => toggleHelp(true, 'play'));
// "Start building" means a fresh start: clear the town (undoable) and return the camera home.
$('helpClose').addEventListener('click', () => {
  toggleHelp(false);
  ctx.resetView();
  if (!town.cells.size) return;
  replaceTown(() => town.clear());
  puffs.burst(0, 0.5, 0, 12);
  toast('Fresh start. Undo brings your town back');
});
$('helpSurprise').addEventListener('click', () => {
  toggleHelp(false);
  surprise();
});
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) toggleHelp(false);
});

// ---------------------------------------------------------------- start

let seenHelp = false;
try {
  seenHelp = localStorage.getItem('cloudhaven.seenHelp') === '1';
  localStorage.setItem('cloudhaven.seenHelp', '1');
} catch {
  /* ignore */
}

// Optional camera override, e.g. ?cam=10,8,10,0,1,0 (handy for screenshots).
const camParam = new URLSearchParams(location.search).get('cam')?.split(',').map(Number);
if (camParam?.length === 6 && camParam.every(Number.isFinite)) {
  ctx.camera.position.set(camParam[0], camParam[1], camParam[2]);
  ctx.controls.target.set(camParam[3], camParam[4], camParam[5]);
}
if (new URLSearchParams(location.search).has('night')) toggleNight(true);

void loadInitial().then((loaded) => {
  setMode(town.mode, { rebuild: false });
  view.rebuildAll();
  afterChange();
  if (seenHelp || loaded) toggleHelp(false);
});

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  updateHover();
  view.tick(now);
  puffs.tick(now, dt);
  (grid3d.material as THREE.LineBasicMaterial).opacity = GRID_OPACITY * (town.mode === MODE_ISLAND ? 0.45 : 1) * (1 - 0.65 * ctx.nightness());
  ctx.tick(dt, now / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
