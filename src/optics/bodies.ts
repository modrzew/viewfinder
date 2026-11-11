import type { CameraBody } from './types';

export const EOS_90D: CameraBody = {
  id: 'eos-90d',
  name: 'Canon EOS 90D',
  acceptsMounts: ['EF', 'EF-S'],
  sensorWidthMm: 22.3,
  imageAspect: 3 / 2,
  imagePx: { width: 6960, height: 4640 },
  cocMm: 0.019,
  cropFactorNominal: 1.6,
};

export const BODIES: CameraBody[] = [EOS_90D];

export function getBody(id: string): CameraBody {
  return BODIES.find((b) => b.id === id) ?? BODIES[0];
}
