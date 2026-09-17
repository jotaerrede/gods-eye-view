import { createSpeedCamerasLayer } from '../../layers/speedCamera/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

export function createApplicationSpeedCameras({ source }) {
  const layer = createSpeedCamerasLayer({ source, services: { render, context, picking } });
  const originalInit = layer.init.bind(layer);
  layer.init = function (viewer) {
    originalInit(viewer);
    layer.installClickHandler(viewer);
  };
  return layer;
}
