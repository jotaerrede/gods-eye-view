import { createApplicationSpeedCameras } from '../app/layers/speedCameras.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createOverpassSpeedCameraSource } from '../layers/speedCamera/index.js';
export * from '../layers/speedCamera/index.js';

const slot = createSourceSlot(
  createOverpassSpeedCameraSource(),
  ['fetch'],
  'Speed camera source',
);
export const configureSpeedCameraSource = slot.configure;
export default createApplicationSpeedCameras({ source: slot.source });
