/** Renderer, camera, lights, sky dome, cloud sea, birds and the day/night cycle. */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Grid } from './grid';

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
  camera.position.set(22, 19, 24);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.6, 0);
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
  const puffs: THREE.Matrix4[] = [];
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
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 60 + Math.random() * 50;
    addCloud(Math.cos(a) * r, 4 + Math.random() * 14, Math.sin(a) * r, 2.5 + Math.random() * 2.5);
  }
  const cloudMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), cloudMat, puffs.length);
  puffs.forEach((p, i) => cloudMesh.setMatrixAt(i, p));
  cloudMesh.receiveShadow = true;
  const clouds = new THREE.Group();
  clouds.add(cloudMesh);
  scene.add(clouds);

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
      controls.update();
      renderer.render(scene, camera);
    },
  };
}
