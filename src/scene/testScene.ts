import {
  CanvasTexture, DataTexture, EquirectangularReflectionMapping, FloatType, Group, LinearFilter, Mesh,
  MeshBasicMaterial, PlaneGeometry, RepeatWrapping, RGBAFormat, Scene, SphereGeometry, SRGBColorSpace,
  BoxGeometry, Color, type Material, type Texture, type BufferGeometry,
} from 'three';
import type { SceneSetup } from './types';

// Optics test scene (§11.7): checkerboard ground, distance cards with point sources, gradient sky.

export const TEST_TARGET_DISTANCES_M = [0.5, 1, 2, 4, 8, 16, 32];
const EYE = 1.2;
/** Point-source luminance (linear), bright enough to stay visible when spread into a large disc. */
const POINT_SOURCE_INTENSITY = 1000;

function gradientSky(): DataTexture {
  const w = 8;
  const h = 256;
  const data = new Float32Array(w * h * 4);
  const zenith = new Color(0.18, 0.34, 0.8);
  const horizon = new Color(1.1, 1.05, 0.95);
  const ground = new Color(0.22, 0.21, 0.2);
  const c = new Color();
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h; // 0 = straight down, 1 = straight up
    const elev = (v - 0.5) * Math.PI;
    if (elev < 0) c.copy(ground).lerp(horizon, Math.exp(elev * 30));
    else c.copy(horizon).lerp(zenith, Math.pow(Math.sin(elev), 0.6));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = 1;
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat, FloatType);
  tex.mapping = EquirectangularReflectionMapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function checkerTexture(): CanvasTexture {
  // One tile = 2 × 2 m; thin lines on every 1 m boundary.
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d')!;
  const h = s / 2;
  g.fillStyle = '#8a8a8a';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#6e6e6e';
  g.fillRect(0, 0, h, h);
  g.fillRect(h, h, h, h);
  g.fillStyle = '#2a2a2a';
  for (const p of [0, h]) {
    g.fillRect(p, 0, 3, s);
    g.fillRect(0, p, s, 3);
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

function cardTexture(title: string, subtitle: string, wide = false): CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = wide ? 1536 : 1024;
  cv.height = 1024 * (wide ? 1 : 0.75);
  const g = cv.getContext('2d')!;
  const { width: w, height: h } = cv;
  g.fillStyle = '#f2f0ea';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#111';
  g.lineWidth = 12;
  g.strokeRect(6, 6, w - 12, h - 12);
  g.fillStyle = '#111';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(h * 0.34)}px system-ui, sans-serif`;
  g.fillText(title, w / 2, h * 0.36);
  g.font = `${Math.round(h * 0.07)}px system-ui, sans-serif`;
  g.fillText(subtitle, w / 2, h * 0.62);
  // Resolution bars: line pairs getting finer to the right.
  let x = w * 0.08;
  for (const lw of [16, 12, 8, 6, 4, 3, 2]) {
    for (let i = 0; i < 4; i++) {
      g.fillRect(x, h * 0.72, lw, h * 0.18);
      x += lw * 2;
    }
    x += 24;
  }
  // Centre cross for aiming.
  g.fillRect(w / 2 - 2, h * 0.5 - 24, 4, 48);
  g.fillRect(w / 2 - 24, h * 0.5 - 2, 48, 4);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

export function buildTestScene(): SceneSetup {
  const scene = new Scene();
  const sky = gradientSky();
  scene.background = sky;

  const disposables: (Material | Texture | BufferGeometry)[] = [sky];
  const root = new Group();
  scene.add(root);

  const groundTex = checkerTexture();
  const groundSize = 160;
  groundTex.repeat.set(groundSize / 2, groundSize / 2);
  const groundMat = new MeshBasicMaterial({ map: groundTex });
  const groundGeo = new PlaneGeometry(groundSize, groundSize);
  const ground = new Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);
  disposables.push(groundTex, groundMat, groundGeo);

  const postMat = new MeshBasicMaterial({ color: 0x333333 });
  const sourceMat = new MeshBasicMaterial({ color: new Color(1, 0.92, 0.8).multiplyScalar(POINT_SOURCE_INTENSITY) });
  const sourceGeo = new SphereGeometry(1, 16, 12);
  const postGeo = new BoxGeometry(1, 1, 1);
  disposables.push(postMat, sourceMat, sourceGeo, postGeo);

  // Cards fan out from −24° to +24° so none hides another; each faces the spawn eye.
  TEST_TARGET_DISTANCES_M.forEach((d, i) => {
    const az = ((-24 + 8 * i) * Math.PI) / 180;
    const w = 0.12 * d;
    const h = 0.09 * d;
    const cy = Math.max(EYE, h / 2 + 0.02 * d);
    const card = new Group();
    card.position.set(d * Math.sin(az), 0, -d * Math.cos(az));
    card.rotation.y = -az;
    root.add(card);

    const tex = cardTexture(d < 1 ? `${d * 100} cm` : `${d} m`, `${d.toFixed(2)} m from spawn`);
    const mat = new MeshBasicMaterial({ map: tex });
    const geo = new PlaneGeometry(w, h);
    const face = new Mesh(geo, mat);
    face.position.y = cy;
    card.add(face);
    disposables.push(tex, mat, geo);

    const postW = Math.max(0.006, 0.004 * d);
    const post = new Mesh(postGeo, postMat);
    post.scale.set(postW, cy - h / 2, postW);
    post.position.set(0, (cy - h / 2) / 2, -postW);
    card.add(post);

    const r = 0.0007 * d;
    const src = new Mesh(sourceGeo, sourceMat);
    src.scale.setScalar(r);
    src.position.set(0, cy + h / 2 + r * 1.5, 0);
    card.add(src);
  });

  // Framing card to the right: 1 m wide at 2.24 m exactly fills the frame width at 50 mm.
  {
    const tex = cardTexture('1 m', '1 m wide at 2.24 m = the 50 mm frame', true);
    const mat = new MeshBasicMaterial({ map: tex });
    const geo = new PlaneGeometry(1, 2 / 3);
    const face = new Mesh(geo, mat);
    face.position.set(2.24, EYE, 0);
    face.rotation.y = -Math.PI / 2;
    root.add(face);
    const post = new Mesh(postGeo, postMat);
    post.scale.set(0.02, EYE - 1 / 3, 0.02);
    post.position.set(2.25, (EYE - 1 / 3) / 2, 0);
    root.add(post);
    disposables.push(tex, mat, geo);
  }

  return {
    id: 'test',
    scene,
    spawn: { x: 0, z: 0, eyeHeightM: EYE, yawDeg: 0, pitchDeg: 0 },
    colliders: [],
    walkArea: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
    lighting: { ev100: 12, baseExposure: 1 },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
