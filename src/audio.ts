/** Small procedural sound effects (no audio files). */
let ctx: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem('cloudhaven.muted') === '1';
} catch {
  /* storage unavailable */
}

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function blip(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; slide?: number; delay?: number } = {}) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + (opts.delay ?? 0);
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * (opts.slide ?? 1.5), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.12, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const note = (i: number) => 330 * Math.pow(2, PENTA[Math.min(i, PENTA.length - 1)] / 12);

export const sfx = {
  place(level: number) {
    blip(note(level), 0.16, { type: 'triangle', slide: 1.35 });
    blip(note(level) * 2, 0.08, { gain: 0.04, slide: 1.2 });
  },
  remove() {
    blip(260, 0.14, { type: 'triangle', slide: 0.55, gain: 0.1 });
  },
  reroll(level: number) {
    blip(note(level + 1), 0.12, { type: 'sine', slide: 1.1 });
    blip(note(level + 3), 0.16, { type: 'sine', slide: 1.1, delay: 0.07 });
  },
  paint() {
    blip(620, 0.1, { type: 'sine', slide: 1.25, gain: 0.07 });
  },
};

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem('cloudhaven.muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
}
