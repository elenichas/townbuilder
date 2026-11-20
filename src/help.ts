/**
 * The help dialog: tab switching, grid diagrams drawn from the real grid generator,
 * and a small interactive Wave Function Collapse demo.
 */
import { type GridStage, type Vec2, generateGrid } from './grid';
import { mulberry32 } from './rng';

export type HelpTab = 'play' | 'grid' | 'wfc' | 'rules' | 'game' | 'greek' | 'terrain';

const SVG = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
};

// ---------------------------------------------------------------- tabs

export function initHelp(): { select(tab: HelpTab): void; pause(): void } {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#help [role="tab"]')];
  const select = (tab: HelpTab) => {
    for (const t of tabs) {
      const on = t.dataset.tab === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls')!)!;
      panel.hidden = !on;
      if (on) panel.scrollTop = 0;
    }
    if (tab === 'wfc') demo.show();
    else demo.pause();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t.dataset.tab as HelpTab));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = tabs[(i + d + tabs.length) % tabs.length];
      select(next.dataset.tab as HelpTab);
      next.focus();
    });
  });
  drawGridDiagrams();
  const demo = mountWfcDemo(document.getElementById('wfcDemo')!);
  return { select, pause: () => demo.pause() };
}

// ---------------------------------------------------------------- grid diagrams

function drawGridDiagrams() {
  const stages = new Map<GridStage, { pts: Vec2[]; polys: number[][] }>();
  const grid = generateGrid(2, 5, 2, 80, (stage, pts, polys) => stages.set(stage, { pts, polys }));
  const R = grid.radius + 0.4;
  const host = document.getElementById('gridSteps')!;
  const labels: [GridStage, string, string][] = [
    ['triangles', '1 · Triangles', 'A hexagon of triangles'],
    ['merged', '2 · Merge', 'Random neighbours join into quads'],
    ['subdivided', '3 · Subdivide', 'Every shape is cut into quads'],
    ['relaxed', '4 · Relax', 'Points ease toward squares'],
  ];
  for (const [stage, title, sub] of labels) {
    const { pts, polys } = stages.get(stage)!;
    const fig = document.createElement('figure');
    const svg = el('svg', { viewBox: `${-R} ${-R} ${2 * R} ${2 * R}`, role: 'img', 'aria-label': `${title}: ${sub}` }, fig);
    for (const poly of polys) {
      el('polygon', { points: poly.map((v) => `${pts[v].x},${pts[v].z}`).join(' '), class: poly.length === 3 ? 'g-tri' : 'g-quad' }, svg);
    }
    const cap = document.createElement('figcaption');
    cap.innerHTML = `<b>${title}</b><span>${sub}</span>`;
    fig.appendChild(cap);
    host.appendChild(fig);
  }

  // The cell you build on: the quarters of every quad around one corner.
  const cellSvg = document.getElementById('dualCell')!;
  const r = 1.55;
  cellSvg.setAttribute('viewBox', `${-r} ${-r} ${2 * r} ${2 * r}`);
  const v = grid.pos.map((_, i) => i).filter((i) => grid.buildable[i]).sort((a, b) => Math.hypot(grid.pos[a].x, grid.pos[a].z) - Math.hypot(grid.pos[b].x, grid.pos[b].z))[0];
  const c = grid.pos[v];
  const shift = (p: Vec2) => `${p.x - c.x},${p.z - c.z}`;
  for (const q of grid.quads) el('polygon', { points: q.map((i) => shift(grid.pos[i])).join(' '), class: 'g-quad' }, cellSvg);
  for (const Q of grid.quarters[v]) el('polygon', { points: [Q.P0, Q.P1, Q.P2, Q.P3].map(shift).join(' '), class: 'g-quarter' }, cellSvg);
  el('polygon', { points: grid.ring[v].map(shift).join(' '), class: 'g-ring' }, cellSvg);
  el('circle', { cx: 0, cy: 0, r: 0.07, class: 'g-dot' }, cellSvg);
}

// ---------------------------------------------------------------- WFC demo

const TILES = [
  { name: 'Water', color: '#79c3e2', weight: 1 },
  { name: 'Sand', color: '#ead9a8', weight: 0.7 },
  { name: 'Grass', color: '#93cc6e', weight: 1.2 },
  { name: 'Forest', color: '#4f9a63', weight: 0.9 },
];
const ALL = (1 << TILES.length) - 1;
/** The demo's only rule: a tile may touch itself or its neighbour in the chain Water–Sand–Grass–Forest. */
const allowedNext = (mask: number) => {
  let out = 0;
  for (let t = 0; t < TILES.length; t++) if (mask & (1 << t)) out |= (1 << t) | (t > 0 ? 1 << (t - 1) : 0) | (t < TILES.length - 1 ? 1 << (t + 1) : 0);
  return out & ALL;
};
const bits = (m: number) => {
  let n = 0;
  for (let t = 0; t < TILES.length; t++) if (m & (1 << t)) n++;
  return n;
};

function mountWfcDemo(root: HTMLElement) {
  const W = 12;
  const Hc = 7;
  const canvas = root.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const caption = root.querySelector<HTMLElement>('.demo-caption')!;
  const stepBtn = root.querySelector<HTMLButtonElement>('[data-demo="step"]')!;
  const playBtn = root.querySelector<HTMLButtonElement>('[data-demo="play"]')!;
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-demo="reset"]')!;
  const stepItems = [...document.querySelectorAll<HTMLElement>('#wfcSteps li')];

  let dom: number[] = [];
  let rand = mulberry32(1);
  let picked = -1;
  let pulses: { i: number; t0: number }[] = [];
  let timer = 0;
  let raf = 0;
  let failed = false;
  let seedN = 1;

  const size = () => {
    const css = canvas.clientWidth || 480;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(((css * Hc) / W) * dpr);
    return canvas.width / W;
  };

  const phase = (n: number) => stepItems.forEach((li, i) => li.classList.toggle('on', i === n));

  const reset = () => {
    seedN++;
    rand = mulberry32(seedN * 7919);
    dom = new Array(W * Hc).fill(ALL);
    picked = -1;
    pulses = [];
    failed = false;
    caption.innerHTML = 'Every cell can still be <b>anything</b>: each small square is one tile it might become. Press <b>Step</b>, or click a small square to choose it yourself.';
    phase(0);
    draw();
  };

  const nbrs = (i: number) => {
    const x = i % W;
    const y = Math.floor(i / W);
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (y > 0) out.push(i - W);
    if (y < Hc - 1) out.push(i + W);
    return out;
  };

  /** Arc consistency from cell `start`. Returns how many options were removed and from how many cells. */
  const propagate = (start: number) => {
    const queue = [start];
    const touched = new Set<number>();
    let removed = 0;
    const now = performance.now();
    const depth = new Map([[start, 0]]);
    while (queue.length) {
      const c = queue.shift()!;
      const ok = allowedNext(dom[c]);
      for (const n of nbrs(c)) {
        const next = dom[n] & ok;
        if (next !== dom[n]) {
          removed += bits(dom[n]) - bits(next);
          dom[n] = next;
          touched.add(n);
          const d = depth.get(c)! + 1;
          depth.set(n, d);
          pulses.push({ i: n, t0: now + d * 70 });
          if (!next) failed = true;
          queue.push(n);
        }
      }
    }
    return { removed, cells: touched.size };
  };

  const collapse = (i: number, tile: number, byUser: boolean) => {
    const options = bits(dom[i]);
    dom[i] = 1 << tile;
    picked = i;
    pulses.push({ i, t0: performance.now() });
    const { removed, cells } = propagate(i);
    const who = byUser ? 'You chose' : `Picked the cell with the fewest options (${options}) and chose`;
    caption.innerHTML = failed
      ? 'No tile fits one of the cells any more (a <b>contradiction</b>). The game handles this by re-solving a bigger area. Press <b>New puzzle</b>.'
      : `${who} <b style="color:${TILES[tile].color === '#ead9a8' ? '#b59a4c' : TILES[tile].color}">${TILES[tile].name}</b>. ` +
        (removed ? `That ruled out <b>${removed}</b> option${removed > 1 ? 's' : ''} in <b>${cells}</b> cell${cells > 1 ? 's' : ''} around it.` : 'Its neighbours already fit, so nothing else changed.');
    phase(removed ? 3 : 2);
    if (dom.every((m) => bits(m) === 1)) {
      caption.innerHTML += ' <b>Done:</b> every cell is decided and every neighbour fits.';
      stop();
    }
    kick();
  };

  const step = () => {
    if (failed) return reset();
    let best = -1;
    let bestScore = Infinity;
    dom.forEach((m, i) => {
      const n = bits(m);
      if (n > 1) {
        const s = n + rand() * 0.5;
        if (s < bestScore) {
          bestScore = s;
          best = i;
        }
      }
    });
    if (best < 0) {
      stop();
      return;
    }
    phase(1);
    let pick = -1;
    let race = Infinity;
    for (let t = 0; t < TILES.length; t++) {
      if (!(dom[best] & (1 << t))) continue;
      const r = -Math.log(rand() + 1e-9) / TILES[t].weight;
      if (r < race) {
        race = r;
        pick = t;
      }
    }
    collapse(best, pick, false);
  };

  const stop = () => {
    clearInterval(timer);
    timer = 0;
    playBtn.textContent = 'Play';
    playBtn.setAttribute('aria-pressed', 'false');
  };
  const play = () => {
    if (timer) return stop();
    if (failed || dom.every((m) => bits(m) === 1)) reset();
    timer = window.setInterval(step, 260);
    playBtn.textContent = 'Pause';
    playBtn.setAttribute('aria-pressed', 'true');
  };

  const draw = () => {
    const cs = size();
    const now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pad = cs * 0.05;
    for (let i = 0; i < dom.length; i++) {
      const x = (i % W) * cs;
      const y = Math.floor(i / W) * cs;
      const m = dom[i];
      if (bits(m) === 1) {
        const t = Math.log2(m);
        ctx.fillStyle = TILES[t].color;
        ctx.fillRect(x + pad * 0.3, y + pad * 0.3, cs - pad * 0.6, cs - pad * 0.6);
        drawIcon(ctx, t, x + cs / 2, y + cs / 2, cs);
      } else {
        ctx.fillStyle = m ? '#f6f1e8' : '#f7c9c3';
        ctx.fillRect(x + pad * 0.3, y + pad * 0.3, cs - pad * 0.6, cs - pad * 0.6);
        const q = (cs - pad * 2.4) / 2;
        for (let t = 0; t < TILES.length; t++) {
          const qx = x + pad * 1.2 + (t % 2) * q;
          const qy = y + pad * 1.2 + Math.floor(t / 2) * q;
          if (m & (1 << t)) {
            ctx.fillStyle = TILES[t].color;
            ctx.fillRect(qx + 1, qy + 1, q - 2, q - 2);
          } else {
            ctx.strokeStyle = 'rgba(61,58,79,0.12)';
            ctx.lineWidth = 1;
            ctx.strokeRect(qx + 2.5, qy + 2.5, q - 5, q - 5);
          }
        }
      }
    }
    // Ripple showing propagation spreading out from the chosen cell.
    pulses = pulses.filter((p) => now - p.t0 < 700);
    for (const p of pulses) {
      const a = Math.max(0, Math.min(1, 1 - (now - p.t0) / 700));
      if (now < p.t0) continue;
      ctx.strokeStyle = p.i === picked ? `rgba(239,138,111,${a})` : `rgba(255,190,60,${a})`;
      ctx.lineWidth = Math.max(2, cs * 0.08);
      ctx.strokeRect((p.i % W) * cs + 2, Math.floor(p.i / W) * cs + 2, cs - 4, cs - 4);
    }
    if (picked >= 0) {
      ctx.strokeStyle = '#ef8a6f';
      ctx.lineWidth = Math.max(2, cs * 0.06);
      ctx.strokeRect((picked % W) * cs + 2, Math.floor(picked / W) * cs + 2, cs - 4, cs - 4);
    }
    raf = pulses.length ? requestAnimationFrame(draw) : 0;
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };

  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const cs = r.width / W;
    const cx = Math.floor((e.clientX - r.left) / cs);
    const cy = Math.floor((e.clientY - r.top) / cs);
    if (cx < 0 || cy < 0 || cx >= W || cy >= Hc) return;
    const i = cy * W + cx;
    if (failed || bits(dom[i]) <= 1) return;
    const lx = (e.clientX - r.left - cx * cs) / cs;
    const ly = (e.clientY - r.top - cy * cs) / cs;
    const t = (ly < 0.5 ? 0 : 2) + (lx < 0.5 ? 0 : 1);
    if (!(dom[i] & (1 << t))) {
      caption.innerHTML = `<b>${TILES[t].name}</b> isn't possible there any more: a neighbour has ruled it out.`;
      return;
    }
    stop();
    collapse(i, t, true);
  });
  stepBtn.addEventListener('click', () => {
    stop();
    step();
  });
  playBtn.addEventListener('click', play);
  resetBtn.addEventListener('click', () => {
    stop();
    reset();
  });
  window.addEventListener('resize', () => draw());

  reset();
  return {
    show: () => draw(),
    pause: () => stop(),
  };
}

function drawIcon(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, cs: number) {
  const s = cs / 40;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  if (t === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-10, 2);
    ctx.quadraticCurveTo(-5, -3, 0, 2);
    ctx.quadraticCurveTo(5, 7, 10, 2);
    ctx.stroke();
  } else if (t === 1) {
    ctx.fillStyle = 'rgba(181,154,76,0.55)';
    for (const [dx, dy] of [
      [-6, -4],
      [5, -6],
      [2, 5],
      [-4, 7],
    ]) {
      ctx.beginPath();
      ctx.arc(dx, dy, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (t === 2) {
    ctx.strokeStyle = 'rgba(70,130,60,0.7)';
    ctx.lineWidth = 1.6;
    for (const dx of [-7, 0, 7]) {
      ctx.beginPath();
      ctx.moveTo(dx - 2, 6);
      ctx.lineTo(dx, -1);
      ctx.lineTo(dx + 2, 6);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = '#2f6e45';
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(9, 6);
    ctx.lineTo(-9, 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#8a644a';
    ctx.fillRect(-1.5, 6, 3, 5);
  }
  ctx.restore();
}
