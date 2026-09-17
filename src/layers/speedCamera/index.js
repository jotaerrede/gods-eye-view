import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  LAYER_ID,
  REQUEST_DEBOUNCE_MS,
  QUERY_LIMIT,
  MAX_RENDERED,
  QUERY_SNAP_DEGREES,
  QUERY_REUSE_MS,
  SPEED_CAMERA_COLOR,
  SPEED_CAMERA_SELECTED_COLOR,
  MARKER_ICON_SIZE,
  SELECTED_MARKER_ICON_SIZE,
  MAX_VIEWPORT_DEGREES,
  DIRECTION_CONE_M,
  DIRECTION_CONE_HALF_ANGLE_DEG,
  EARTH_MEAN_RADIUS_M,
  CREDIT_DISPLAY_MS,
} from './policy.js';
import {
  snapSpeedCameraBox,
  boxContains,
  speedCameraRetryDelayMs,
  validateSpeedCameraSnapshot,
  speedCameraDisplayId,
  speedCameraLabelDetails,
} from './records.js';

function makeMarkerSvg(color, size) {
  const r = size / 2 - 2;
  const inner = r * 0.44;
  const dot = r * 0.26;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${color}" stroke="white" stroke-width="2.5"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${inner}" fill="white" fill-opacity="0.9"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${dot}" fill="${color}"/>` +
    `</svg>`
  );
}

const MARKER_IMAGE = `data:image/svg+xml,${encodeURIComponent(makeMarkerSvg(SPEED_CAMERA_COLOR, MARKER_ICON_SIZE))}`;
const SELECTED_IMAGE = `data:image/svg+xml,${encodeURIComponent(makeMarkerSvg(SPEED_CAMERA_SELECTED_COLOR, SELECTED_MARKER_ICON_SIZE))}`;

function destinationPointDeg(latDeg, lonDeg, bearingDeg, distanceM) {
  const angularDistance = distanceM / EARTH_MEAN_RADIUS_M;
  const bearing = Cesium.Math.toRadians(bearingDeg);
  const lat1 = Cesium.Math.toRadians(latDeg);
  const lon1 = Cesium.Math.toRadians(lonDeg);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );
  return {
    latitude: Cesium.Math.toDegrees(lat2),
    longitude: Cesium.Math.toDegrees(lon2),
  };
}

function directionWedgePositions(record) {
  if (!Number.isFinite(record.directionDeg)) return null;
  const left = destinationPointDeg(
    record.latitude,
    record.longitude,
    record.directionDeg - DIRECTION_CONE_HALF_ANGLE_DEG,
    DIRECTION_CONE_M,
  );
  const right = destinationPointDeg(
    record.latitude,
    record.longitude,
    record.directionDeg + DIRECTION_CONE_HALF_ANGLE_DEG,
    DIRECTION_CONE_M,
  );
  return [
    Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, 0),
    Cesium.Cartesian3.fromDegrees(left.longitude, left.latitude, 0),
    Cesium.Cartesian3.fromDegrees(right.longitude, right.latitude, 0),
  ];
}

export function createSpeedCamerasLayer({ source, services } = {}) {
  if (typeof source?.fetch !== 'function')
    throw new TypeError('Speed camera layer requires a camera source');
  const { governorRequestRender } = services.render;
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context;

  const state = {
    viewer: null,
    dataSource: null,
    credit: null,
    creditPresented: false,
    enabled: false,
    records: [],
    recordById: new Map(),
    selectedId: null,
    lastUpdate: null,
    error: null,
    status: 'idle',
    stale: false,
    saturated: false,
    loading: false,
    abort: null,
    pendingQueryBox: null,
    retryTimer: null,
    retryDelayMs: 0,
    retryAt: 0,
    retrying: false,
    moveEndRemove: null,
    clickHandler: null,
    debounceTimer: null,
    lastQueryBox: null,
  };

  function setStatus(status, error = null) {
    if (state.status === status && state.error === error) return;
    state.status = status;
    state.error = error;
    governorRequestRender('speed-camera-status');
  }

  function viewportBox(viewer) {
    const camera = viewer?.camera;
    const canvas = viewer?.scene.canvas;
    if (typeof camera?.pickEllipsoid === 'function' && canvas) {
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (!width || !height) return null;
      const focus = camera.pickEllipsoid(
        new Cesium.Cartesian2(width / 2, height / 2),
        viewer.scene.globe.ellipsoid,
      );
      if (!focus) return null;
      const location = Cesium.Cartographic.fromCartesian(focus);
      const range = Cesium.Cartesian3.distance(camera.positionWC, focus);
      const radius = Math.max(1000, 2 * range);
      const latitude = Cesium.Math.toDegrees(location.latitude);
      const longitude = Cesium.Math.toDegrees(location.longitude);
      const latSpan = radius / 111000;
      const lonSpan = latSpan / Math.cos(location.latitude);
      if (
        !Number.isFinite(latSpan + lonSpan) ||
        2 * Math.max(latSpan, lonSpan) > MAX_VIEWPORT_DEGREES ||
        Math.abs(latitude) + latSpan > 90 ||
        Math.abs(longitude) + lonSpan > 180
      )
        return null;
      return {
        south: latitude - latSpan,
        west: longitude - lonSpan,
        north: latitude + latSpan,
        east: longitude + lonSpan,
      };
    }
    const rectangle = viewer?.camera?.computeViewRectangle(
      viewer.scene.globe.ellipsoid,
    );
    if (!rectangle) return null;
    const south = Cesium.Math.toDegrees(rectangle.south);
    const north = Cesium.Math.toDegrees(rectangle.north);
    const west = Cesium.Math.toDegrees(rectangle.west);
    const east = Cesium.Math.toDegrees(rectangle.east);
    if (
      !Number.isFinite(south + north + west + east) ||
      east <= west ||
      north - south > MAX_VIEWPORT_DEGREES ||
      east - west > MAX_VIEWPORT_DEGREES
    )
      return null;
    return { south, west, north, east };
  }

  function updateAppearance(entity, selected) {
    const color = Cesium.Color.fromCssColorString(
      selected ? SPEED_CAMERA_SELECTED_COLOR : SPEED_CAMERA_COLOR,
    );
    entity.billboard.image = selected ? SELECTED_IMAGE : MARKER_IMAGE;
    entity.billboard.width = selected
      ? SELECTED_MARKER_ICON_SIZE
      : MARKER_ICON_SIZE;
    entity.billboard.height = selected
      ? SELECTED_MARKER_ICON_SIZE
      : MARKER_ICON_SIZE;
    if (entity.polyline) {
      entity.polyline.width = selected ? 3 : 1.75;
      entity.polyline.material = color.withAlpha(selected ? 0.98 : 0.76);
    }
    if (entity.polygon)
      entity.polygon.material = color.withAlpha(selected ? 0.7 : 0.18);
    if (entity.gevLabelModel) {
      entity.gevLabelModel.accent = color.toCssColorString();
    }
  }

  function clearRendered() {
    if (state.dataSource?.entities) state.dataSource.entities.removeAll();
    removeEntityContextsForLayer(LAYER_ID);
  }

  function clearSelection() {
    const entity = state.selectedId
      ? state.dataSource?.entities.getById(state.selectedId)
      : null;
    const record = state.recordById.get(state.selectedId);
    if (entity && record) updateAppearance(entity, false);
    state.selectedId = null;
    clearSelectedEntityContextForLayer(LAYER_ID);
    governorRequestRender('speed-camera-select');
  }

  function selectRecord(id) {
    const entity = state.dataSource?.entities.getById(id);
    if (!entity || !state.recordById.has(id)) return false;
    clearSelection();
    state.selectedId = id;
    updateAppearance(entity, true);
    selectEntityContext(entity);
    governorRequestRender('speed-camera-select');
    return true;
  }

  function renderRecords() {
    const selectedContext = getSelectedEntityContext();
    const box = viewportBox(state.viewer);
    const visible = box
      ? state.records
          .filter((record) =>
            boxContains(box, {
              south: record.latitude,
              north: record.latitude,
              west: record.longitude,
              east: record.longitude,
            }),
          )
          .slice(0, MAX_RENDERED)
      : [];

    if (
      selectedContext?.layerId !== LAYER_ID ||
      selectedContext.id !== state.selectedId ||
      !visible.some((record) => record.id === state.selectedId)
    ) {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
    }

    governorRequestRender('speed-camera-render');
    const visibleIds = new Set(visible.map((record) => record.id));
    for (const entity of [...state.dataSource.entities.values]) {
      if (!visibleIds.has(entity.id)) state.dataSource.entities.remove(entity);
    }
    removeEntityContextsForLayer(LAYER_ID, { retainIds: visibleIds });

    const color = Cesium.Color.fromCssColorString(SPEED_CAMERA_COLOR);
    for (const record of visible) {
      const existing = state.dataSource.entities.getById(record.id);
      if (existing?.gevSpeedCameraRecord === record) {
        updateAppearance(existing, record.id === state.selectedId);
        continue;
      }
      const selected = record.id === state.selectedId;
      const position = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
      );
      const entityDef = {
        id: record.id,
        position,
        billboard: {
          image: selected ? SELECTED_IMAGE : MARKER_IMAGE,
          width: selected ? SELECTED_MARKER_ICON_SIZE : MARKER_ICON_SIZE,
          height: selected ? SELECTED_MARKER_ICON_SIZE : MARKER_ICON_SIZE,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(350, 1.1, 4_000_000, 0.45),
        },
      };
      const wedge = directionWedgePositions(record);
      if (wedge) {
        entityDef.polyline = {
          positions: [wedge[1], position, wedge[2]],
          width: selected ? 3 : 1.75,
          material: color.withAlpha(0.76),
          clampToGround: true,
        };
        entityDef.polygon = {
          hierarchy: wedge,
          material: color.withAlpha(0.18),
          height: 0,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          classificationType: Cesium.ClassificationType.BOTH,
        };
      }
      let entity = existing;
      if (!entity) entity = state.dataSource.entities.add(entityDef);
      else {
        const previous = entity.gevSpeedCameraRecord;
        if (
          previous?.latitude !== record.latitude ||
          previous?.longitude !== record.longitude
        ) {
          entity.position = position;
        }
        if (
          previous?.latitude !== record.latitude ||
          previous?.longitude !== record.longitude ||
          previous?.directionDeg !== record.directionDeg
        ) {
          entity.polyline = entityDef.polyline;
          entity.polygon = entityDef.polygon;
        }
      }
      entity.gevSpeedCameraRecord = record;
      entity.gevTrackedId = record.id;
      entity.gevDisplayPosition = () => null;
      entity.gevLabelModel = {
        title: speedCameraDisplayId(record),
        details: speedCameraLabelDetails(record),
        accent: color.toCssColorString(),
        cardStyle: 'tactical',
        selected: true,
        leaderStyle: 'elbow',
        leaderAnimationMs: 440,
        leaderAnimationStartedAt: selected ? (globalThis.performance?.now?.() ?? Date.now()) : 0,
        leaderDrawRatio: 0.68,
        anchorRadiusPx: SELECTED_MARKER_ICON_SIZE / 2,
        anchorRadiusScale: null,
      };
      updateAppearance(entity, selected);
      registerEntityContext(entity, {
        id: record.id,
        layerId: LAYER_ID,
        dataSource: state.dataSource,
        layerName: 'Speed Cameras',
        source: source.attribution?.description || source.label || 'Camera source',
        label: 'Speed camera',
        latitude: record.latitude,
        longitude: record.longitude,
        properties: {
          maxspeed: record.maxspeed,
          ref: record.ref,
          operator: record.operator,
          enforcement: record.enforcement,
          directionDeg: record.directionDeg,
          osmId: record.osmId,
          lastVerified: record.lastVerified,
          name: record.name,
        },
      });
    }
    governorRequestRender('speed-camera-entities');

    if (state.credit && !state.creditPresented && visible.length) {
      state.creditPresented = true;
      state.viewer.creditDisplay?.addStaticCredit(state.credit);
      setTimeout(() => {
        if (state.credit)
          state.viewer?.creditDisplay?.removeStaticCredit(state.credit);
      }, CREDIT_DISPLAY_MS);
    }
  }

  function scheduleRetry() {
    if (!state.enabled) return;
    clearTimeout(state.retryTimer);
    state.retryDelayMs = speedCameraRetryDelayMs(state.retryDelayMs);
    state.retryAt = Date.now() + state.retryDelayMs;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      state.retryAt = 0;
      if (state.enabled && !state.loading) loadCameras();
    }, state.retryDelayMs);
  }

  function clearRetry({ resetBackoff = true } = {}) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retryAt = 0;
    if (resetBackoff) state.retryDelayMs = 0;
  }

  function scheduleLoad() {
    if (!state.enabled) return;
    clearRetry({ resetBackoff: false });
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      loadCameras();
    }, REQUEST_DEBOUNCE_MS);
  }

  async function loadCameras() {
    if (!state.enabled || !state.viewer) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    clearRetry({ resetBackoff: false });
    const box = viewportBox(state.viewer);
    if (!box) {
      state.abort?.abort();
      state.abort = null;
      state.pendingQueryBox = null;
      state.loading = false;
      state.retrying = false;
      clearRetry();
      renderRecords();
      setStatus('zoom-in');
      return;
    }
    if (
      state.lastQueryBox &&
      boxContains(state.lastQueryBox, box) &&
      state.lastUpdate &&
      Date.now() - state.lastUpdate < QUERY_REUSE_MS &&
      !state.stale &&
      state.status !== 'unavailable'
    ) {
      if (state.abort) {
        state.abort.abort();
        state.abort = null;
        state.pendingQueryBox = null;
        state.loading = false;
      }
      renderRecords();
      state.retrying = false;
      setStatus(state.dataSource.entities.values.length ? 'ready' : 'empty');
      return;
    }
    if (state.abort && boxContains(state.pendingQueryBox, box)) {
      renderRecords();
      return;
    }
    const queryBox = snapSpeedCameraBox(box);
    state.abort?.abort();
    const requestAbort = new AbortController();
    state.abort = requestAbort;
    state.pendingQueryBox = queryBox;
    state.loading = true;
    state.retrying = state.status === 'unavailable' || state.retryDelayMs > 0;
    setStatus('loading');
    renderRecords();
    try {
      const snapshot = await source.fetch(queryBox, requestAbort.signal);
      if (
        requestAbort.signal.aborted ||
        state.abort !== requestAbort ||
        !state.enabled
      )
        return;
      const { records, stale, saturated } =
        validateSpeedCameraSnapshot(snapshot);
      state.records = records;
      state.recordById = new Map(records.map((r) => [r.id, r]));
      state.lastUpdate = Date.now();
      state.stale = stale;
      state.saturated = saturated || records.length > MAX_RENDERED;
      state.lastQueryBox = queryBox;
      clearRetry();
      renderRecords();
      setStatus(
        state.dataSource.entities.values.length
          ? stale
            ? 'stale'
            : 'ready'
          : 'empty',
      );
    } catch (error) {
      if (
        error?.name === 'AbortError' ||
        requestAbort.signal.aborted ||
        state.abort !== requestAbort ||
        !state.enabled
      )
        return;
      state.stale = Boolean(state.lastUpdate);
      setStatus(
        'unavailable',
        error?.message || 'Speed camera source temporarily unavailable',
      );
      scheduleRetry();
    } finally {
      if (state.abort === requestAbort) {
        state.abort = null;
        state.pendingQueryBox = null;
        state.loading = false;
        state.retrying = false;
        governorRequestRender('speed-camera-status');
      }
    }
  }

  function focusNearest() {
    const camera = state.viewer?.camera;
    if (!state.enabled || !camera?.positionWC || state.viewer.trackedEntity)
      return false;
    let nearest = null,
      distance = Infinity;
    for (const entity of state.dataSource.entities.values) {
      const position = entity.position.getValue(Cesium.JulianDate.now());
      const candidate = Cesium.Cartesian3.distanceSquared(
        camera.positionWC,
        position,
      );
      if (candidate < distance) {
        nearest = entity;
        distance = candidate;
      }
    }
    if (!nearest) return false;
    const record = state.recordById.get(nearest.id);
    const center = Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      0,
    );
    if (!selectRecord(nearest.id)) return false;
    camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 30), {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(
        camera.heading || 0,
        -Math.PI / 4,
        600,
      ),
    });
    governorRequestRender('speed-camera-focus');
    return true;
  }

  const speedCamerasLayer = {
    id: LAYER_ID,
    name: 'Speed Cameras',
    icon: '🚦',
    source: source.label || 'Mapped speed camera locations',
    updateInterval: 0,
    statsRefreshInterval: 1000,
    init(viewer) {
      if (state.viewer) throw new Error('Speed camera layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource('speed-cameras');
      const attribution = source.attribution;
      if (attribution?.text && attribution?.href) {
        try {
          const href = new URL(attribution.href);
          if (href.protocol === 'https:') {
            const esc = (v) =>
              String(v).replace(/[&<>"']/g, (c) =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
              );
            state.credit = new Cesium.Credit(
              `<span>Speed cameras: <a href="${esc(href.href)}" target="_blank" rel="noopener">${esc(attribution.text)}</a></span>`,
              true,
            );
          }
        } catch {
          /* malformed attribution */
        }
      }
      viewer.dataSources.add(state.dataSource);
      state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
    },
    enable() {
      if (state.enabled) return;
      state.enabled = true;
      state.creditPresented = false;
      registerPickOwner(LAYER_ID, (id) => state.recordById.has(id));
      state.dataSource.show = true;
    },
    disable() {
      state.enabled = false;
      unregisterPickOwner(LAYER_ID);
      clearRetry();
      clearTimeout(state.debounceTimer);
      state.abort?.abort();
      state.abort = null;
      state.pendingQueryBox = null;
      state.loading = false;
      state.retrying = false;
      if (state.dataSource) state.dataSource.show = false;
      clearSelection();
      clearRendered();
      setStatus('idle');
    },
    update() {
      return loadCameras();
    },
    destroy(viewer = state.viewer) {
      this.disable();
      state.moveEndRemove?.();
      state.moveEndRemove = null;
      state.clickHandler?.destroy();
      state.clickHandler = null;
      clearRendered();
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.credit = null;
      state.creditPresented = false;
      state.records = [];
      state.recordById = new Map();
      state.lastQueryBox = null;
      state.lastUpdate = null;
      state.error = null;
      state.status = 'idle';
      state.stale = false;
      state.saturated = false;
      state.viewer = null;
    },
    getRowControls() {
      const count = state.dataSource?.entities.values.length || 0;
      return {
        chips: [
          {
            id: 'find-speed-camera',
            label: 'SHOW NEAREST',
            title: state.viewer?.trackedEntity
              ? 'Stop following the current object before navigating to a speed camera'
              : 'Move to the nearest loaded speed camera and show its details',
            disabled:
              !state.enabled || !count || Boolean(state.viewer?.trackedEntity),
            onClick: focusNearest,
          },
        ],
        legend: [
          {
            label: 'Speed camera markers',
            color: SPEED_CAMERA_COLOR,
            count,
            blurb:
              'Amber markers are community-mapped speed cameras. Wedges show direction of enforcement where available. Coverage depends on OSM contributions.',
          },
        ],
      };
    },
    getStats() {
      return {
        count: state.dataSource?.entities.values.length || 0,
        countLabel: state.enabled
          ? `${state.dataSource?.entities.values.length || 0} nearby`
          : '',
        lastUpdate: state.lastUpdate,
        stale: state.stale,
        saturated: state.saturated,
        error: state.error,
        status: state.status,
        loading: state.loading,
        retryAt: state.retryAt,
        retrying: state.retrying,
        retryInSec: state.retryAt
          ? Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000))
          : 0,
        loadingLabel: state.loading
          ? state.retrying
            ? 'retrying mapped speed cameras'
            : 'loading mapped speed cameras'
          : state.status === 'zoom-in'
            ? 'Zoom in to load speed cameras'
            : [
                state.stale ? 'Showing cached locations' : '',
                state.saturated ? 'Coverage limited — zoom in' : '',
                state.status === 'empty'
                  ? 'No mapped cameras here — coverage may be incomplete'
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
      };
    },
    installClickHandler(viewer) {
      if (state.clickHandler) return;
      state.clickHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      state.clickHandler.setInputAction((click) => {
        if (!isPointerFree()) return;
        if (!state.enabled) return;
        const picked = viewer.scene.pick(click.position);
        const id =
          typeof picked?.id?.id === 'string' ? picked.id.id : null;
        if (
          id &&
          state.recordById.has(id) &&
          (id !== state.selectedId || getSelectedEntityContext()?.id !== id)
        )
          selectRecord(id);
        else if (state.selectedId) clearSelection();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
  };

  return speedCamerasLayer;
}

export { createOverpassSpeedCameraSource } from './source.js';
export {
  QUERY_LIMIT,
  MAX_RENDERED,
  QUERY_SNAP_DEGREES,
  QUERY_REUSE_MS,
} from './policy.js';
