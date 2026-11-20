/** Renderer, camera, lights, sky dome, cloud sea, birds and the day/night cycle. */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Grid } from './grid';
import { SEA_LEVEL } from './modes';

interface Look {
  top: THREE.Color;
  mid: THREE.Color;
  bottom: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemi: number;
  sun: THREE.Color;
  sunI: number;
  cloud: THREE.Color;
  glow: number;
}

const c = (h: string) => new THREE.Color(h);
const DAY: Look = {
  top: c('#6aa6e6'),
  mid: c('#fbe4cf'),
  bottom: c('#b4d3f2'),
  hemiSky: c('#d4ebff'),
  hemiGround: c('#f6dcc3'),
  hemi: 1.35,
  sun: c('#fff0d6'),
  sunI: 2.5,
  cloud: c('#ffffff'),
  glow: 0,
};
const NIGHT: Look = {
  top: c('#131b45'),
  mid: c('#3d4680'),
  bottom: c('#2d356a'),
  hemiSky: c('#9aa8e6'),
  hemiGround: c('#5a4a6e'),
  hemi: 1.0,
  sun: c('#c4cfff'),
  sunI: 0.75,
  cloud: c('#a3a8d6'),
  glow: 2.2,
};

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  litGlass: THREE.MeshStandardMaterial;
  setNight(night: boolean, instant?: boolean): void;
  isNight(): boolean;
  /** 0 = day, 1 = night (animated). */
  nightness(): number;
  tick(dt: number, t: number): void;
  /** Islands in a real sea (Greek island mode) instead of floating above the clouds. */
  setSea(on: boolean): void;
  /** Set the daytime sky colours (top, horizon, below horizon). */
  setSky(top: string, mid: string, bottom: string): void;
  /** Glide the camera back to the starting view. */
  resetView(): void;
}

export function createScene(canvas: HTMLCanvasElement, grid: Grid): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.5, 900);
  const HOME_POS = new THREE.Vector3(22, 19, 24);
  const HOME_TARGET = new THREE.Vector3(0, 0.6, 0);
  camera.position.copy(HOME_POS);

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(HOME_TARGET);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 75;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.update();

  // Lights.
  const hemi = new THREE.HemisphereLight(DAY.hemiSky, DAY.hemiGround, DAY.hemi);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(DAY.sun, DAY.sunI);
  sun.position.set(14, 24, 9);
  sun.castShadow = true;
  const S = grid.radius + 4;
  sun.shadow.camera.left = -S;
  sun.shadow.camera.right = S;
  sun.shadow.camera.top = S;
  sun.shadow.camera.bottom = -S;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  scene.add(sun);

  // Sky dome.
  const skyUniforms = {
    top: { value: DAY.top.clone() },
    mid: { value: DAY.mid.clone() },
    bottom: { value: DAY.bottom.clone() },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(500, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vDir;
        void main(){ float h = vDir.y; vec3 col = h > 0.0 ? mix(mid, top, pow(h, 0.55)) : mix(mid, bottom, pow(-h, 0.45));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -1;
  scene.add(sky);
  scene.fog = new THREE.Fog(DAY.mid.clone().lerp(DAY.bottom, 0.45), 55, 160);

  // Stars.
  const starPos: number[] = [];
  for (let i = 0; i < 700; i++) {
    const u = Math.random() * Math.PI * 2;
    const y = 0.08 + Math.random() * 0.92;
    const r = Math.sqrt(1 - y * y);
    starPos.push(Math.cos(u) * r * 450, y * 450, Math.sin(u) * r * 450);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
  scene.add(new THREE.Points(starGeo, starMat));

  // Cloud sea + distant clouds (instanced low-poly puffs).
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.45 });
  let puffs: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const addCloud = (x: number, y: number, z: number, scale: number) => {
    const n = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const s = scale * (0.6 + Math.random() * 0.7);
      m.compose(
        new THREE.Vector3(x + (Math.random() - 0.5) * scale * 3, y + Math.random() * scale * 0.4, z + (Math.random() - 0.5) * scale * 1.6),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random(), Math.random() * 6, Math.random())),
        new THREE.Vector3(s, s * 0.62, s),
      );
      puffs.push(m.clone());
    }
  };
  for (let i = 0; i < 70; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * 55;
    addCloud(Math.cos(a) * r, -6.5 - Math.random() * 4, Math.sin(a) * r, 1.6 + Math.random() * 1.6);
  }
  const puffGeo = new THREE.IcosahedronGeometry(1, 1);
  const instanced = (mats: THREE.Matrix4[]) => {
    const mesh = new THREE.InstancedMesh(puffGeo, cloudMat, mats.length);
    mats.forEach((p, i) => mesh.setMatrixAt(i, p));
    mesh.receiveShadow = true;
    return mesh;
  };
  // The sea of clouds below the floating islands, kept separate so it can make way for a real sea.
  const lowClouds = instanced(puffs);
  puffs = [];
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 60 + Math.random() * 50;
    addCloud(Math.cos(a) * r, 4 + Math.random() * 14, Math.sin(a) * r, 2.5 + Math.random() * 2.5);
  }
  const clouds = new THREE.Group();
  clouds.add(lowClouds, instanced(puffs));
  scene.add(clouds);

  // The Aegean: in Greek island mode the islands sit in a real sea instead of floating.
  const SEA_DAY = new THREE.Color('#36a3c4');
  const SEA_NIGHT = new THREE.Color('#1a2a52');
  const seaMat = new THREE.MeshStandardMaterial({ color: SEA_DAY.clone(), roughness: 0.32, metalness: 0.05 });
  const sea = new THREE.Mesh(new THREE.CircleGeometry(700, 96), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA_LEVEL - 0.004;
  sea.receiveShadow = true;
  sea.visible = false;
  scene.add(sea);

  // Birds.
  const birdMat = new THREE.MeshStandardMaterial({ color: '#f4f1ea', flatShading: true, side: THREE.DoubleSide });
  const wingGeo = new THREE.BufferGeometry();
  wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.07, 0, 0, 0.07, 0.32, 0, 0.02], 3));
  wingGeo.computeVertexNormals();
  const birds: { g: THREE.Group; l: THREE.Mesh; r: THREE.Mesh; rad: number; h: number; sp: number; ph: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.28, 5), birdMat);
    body.rotation.x = Math.PI / 2;
    const l = new THREE.Mesh(wingGeo, birdMat);
    const r = new THREE.Mesh(wingGeo, birdMat);
    r.scale.x = -1;
    g.add(body, l, r);
    scene.add(g);
    birds.push({ g, l, r, rad: 7 + Math.random() * 12, h: 5 + Math.random() * 5, sp: (0.12 + Math.random() * 0.12) * (Math.random() < 0.5 ? 1 : -1), ph: Math.random() * 10 });
  }

  // Glowing window/lamp material (emissive ramps up at night).
  const litGlass = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.35,
    emissive: new THREE.Color('#ffc46b'),
    emissiveIntensity: 0,
    side: THREE.DoubleSide,
  });

  let target = 0;
  let night = 0;
  let flyFrom: { pos: THREE.Vector3; target: THREE.Vector3; t0: number } | null = null;
  const applyLook = (n: number) => {
    const lerp = (a: THREE.Color, b: THREE.Color, out: THREE.Color) => out.copy(a).lerp(b, n);
    lerp(DAY.top, NIGHT.top, skyUniforms.top.value);
    lerp(DAY.mid, NIGHT.mid, skyUniforms.mid.value);
    lerp(DAY.bottom, NIGHT.bottom, skyUniforms.bottom.value);
    (scene.fog as THREE.Fog).color.copy(DAY.mid).lerp(DAY.bottom, 0.45).lerp(NIGHT.bottom, n);
    lerp(DAY.hemiSky, NIGHT.hemiSky, hemi.color);
    lerp(DAY.hemiGround, NIGHT.hemiGround, hemi.groundColor);
    hemi.intensity = DAY.hemi + (NIGHT.hemi - DAY.hemi) * n;
    lerp(DAY.sun, NIGHT.sun, sun.color);
    sun.intensity = DAY.sunI + (NIGHT.sunI - DAY.sunI) * n;
    lerp(DAY.cloud, NIGHT.cloud, cloudMat.color);
    cloudMat.emissiveIntensity = 0.45 * (1 - n);
    seaMat.color.copy(SEA_DAY).lerp(SEA_NIGHT, n);
    litGlass.emissiveIntensity = NIGHT.glow * n;
    starMat.opacity = n;
  };

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  return {
    renderer,
    scene,
    camera,
    controls,
    litGlass,
    setNight(v: boolean, instant = false) {
      target = v ? 1 : 0;
      if (instant) {
        night = target;
        applyLook(night);
      }
    },
    isNight: () => target === 1,
    setSea(on: boolean) {
      sea.visible = on;
      lowClouds.visible = !on;
    },
    setSky(top: string, mid: string, bottom: string) {
      DAY.top.set(top);
      DAY.mid.set(mid);
      DAY.bottom.set(bottom);
      applyLook(night);
    },
    resetView() {
      flyFrom = { pos: camera.position.clone(), target: controls.target.clone(), t0: performance.now() };
    },
    nightness: () => night,
    tick(dt: number, t: number) {
      if (night !== target) {
        night += Math.sign(target - night) * Math.min(Math.abs(target - night), dt / 1.6);
        applyLook(night);
      }
      clouds.rotation.y = t * 0.004;
      for (const b of birds) {
        const a = t * b.sp + b.ph;
        b.g.position.set(Math.cos(a) * b.rad, b.h + Math.sin(t * 0.7 + b.ph) * 0.4, Math.sin(a) * b.rad);
        b.g.rotation.y = -a + (b.sp > 0 ? 0 : Math.PI);
        const flap = Math.sin(t * 9 + b.ph) * 0.55;
        b.l.rotation.z = flap;
        b.r.rotation.z = -flap;
      }
      if (flyFrom) {
        const p = Math.min(1, (performance.now() - flyFrom.t0) / 900);
        const e = 1 - Math.pow(1 - p, 3);
        camera.position.lerpVectors(flyFrom.pos, HOME_POS, e);
        controls.target.lerpVectors(flyFrom.target, HOME_TARGET, e);
        if (p >= 1) flyFrom = null;
      }
      controls.update();
      renderer.render(scene, camera);
    },
  };
}
