import {
  CatmullRomCurve3, Color, CylinderGeometry, Group, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial,
  Quaternion, SphereGeometry, TubeGeometry, Vector3, type BufferGeometry, type Material,
} from 'three';

// Festoon lights (§11.5): a dark wire along a catenary with warm emissive bulbs hanging from it.
// Bulbs are emissive only (no light per bulb); one draw call per material.

export interface StrandSpec {
  z: number;
  fromX: number;
  toX: number;
  endHeightM: number;
  sagM: number;
}

export interface StringLightOptions {
  strands: StrandSpec[];
  bulbSpacingM: number;
  /** Linear emissive colour × intensity. */
  bulbEmissive: Color;
}

/** Catenary parameter a with a·(cosh(L/2a) − 1) = sag. */
function catenaryA(span: number, sag: number): number {
  let lo = 0.01;
  let hi = 1e4;
  for (let i = 0; i < 100; i++) {
    const a = (lo + hi) / 2;
    if (a * (Math.cosh(span / 2 / a) - 1) > sag) lo = a;
    else hi = a;
  }
  return (lo + hi) / 2;
}

export function buildStringLights(opts: StringLightOptions): { group: Group; dispose(): void } {
  const group = new Group();
  group.name = 'stringLights';
  const disposables: (BufferGeometry | Material)[] = [];

  const wireMat = new MeshStandardMaterial({ color: 0x151412, roughness: 0.6, metalness: 0.1 });
  const bulbMat = new MeshBasicMaterial({ color: opts.bulbEmissive });
  const socketMat = new MeshStandardMaterial({ color: 0x1b1a18, roughness: 0.5, metalness: 0.3 });
  disposables.push(wireMat, bulbMat, socketMat);

  // ~4 cm bulb, hanging 3 cm under the wire on a short socket.
  const bulbGeo = new SphereGeometry(0.02, 12, 8);
  bulbGeo.scale(1, 1.25, 1);
  const socketGeo = new CylinderGeometry(0.009, 0.011, 0.03, 8);
  disposables.push(bulbGeo, socketGeo);

  const bulbs: Matrix4[] = [];
  const sockets: Matrix4[] = [];
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);

  for (const s of opts.strands) {
    const span = s.toX - s.fromX;
    const a = catenaryA(span, s.sagM);
    const mid = (s.fromX + s.toX) / 2;
    const yAt = (x: number) => s.endHeightM - s.sagM + a * (Math.cosh((x - mid) / a) - 1);

    const pts: Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const x = s.fromX + (span * i) / 64;
      pts.push(new Vector3(x, yAt(x), s.z));
    }
    const wireGeo = new TubeGeometry(new CatmullRomCurve3(pts), 128, 0.002, 4, false);
    disposables.push(wireGeo);
    const wire = new InstancedMesh(wireGeo, wireMat, 1);
    wire.setMatrixAt(0, new Matrix4());
    wire.userData.noRangefinder = true;
    group.add(wire);

    const n = Math.round(span / opts.bulbSpacingM);
    for (let i = 0; i <= n; i++) {
      const x = s.fromX + (span * i) / n;
      const y = yAt(x);
      sockets.push(new Matrix4().compose(new Vector3(x, y - 0.017, s.z), q, one));
      bulbs.push(new Matrix4().compose(new Vector3(x, y - 0.055, s.z), q, one));
    }
  }

  const bulbMesh = new InstancedMesh(bulbGeo, bulbMat, bulbs.length);
  const socketMesh = new InstancedMesh(socketGeo, socketMat, sockets.length);
  bulbs.forEach((m, i) => bulbMesh.setMatrixAt(i, m));
  sockets.forEach((m, i) => socketMesh.setMatrixAt(i, m));
  bulbMesh.name = 'bulbs';
  group.add(bulbMesh, socketMesh);

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
