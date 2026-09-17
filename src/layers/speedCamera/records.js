import { QUERY_LIMIT, QUERY_SNAP_DEGREES } from './policy.js';

export function textTag(value) {
  const t = String(value ?? '').trim();
  return t || null;
}

function numTag(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function snapSpeedCameraBox(box, step = QUERY_SNAP_DEGREES) {
  const down = (v) => Math.floor(v / step) * step;
  const up = (v) => Math.ceil(v / step) * step;
  return {
    south: Math.max(-90, down(box.south)),
    west: Math.max(-180, down(box.west)),
    north: Math.min(90, up(box.north)),
    east: Math.min(180, up(box.east)),
  };
}

export function boxContains(outer, inner) {
  if (!outer || !inner) return false;
  return (
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east
  );
}

export function speedCameraRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}

function normalizeDirection(value) {
  const degrees = numTag(value);
  return degrees != null && degrees >= 0 && degrees <= 360
    ? degrees % 360
    : null;
}

export function normalizeSpeedCameraNode(el) {
  if (
    !el ||
    el.type !== 'node' ||
    !Number.isSafeInteger(el.id) ||
    el.id <= 0 ||
    !Number.isFinite(el.lat) ||
    Math.abs(el.lat) > 90 ||
    !Number.isFinite(el.lon) ||
    Math.abs(el.lon) > 180
  )
    return null;
  const tags = el.tags || {};
  return {
    id: `speed:${el.id}`,
    osmId: el.id,
    latitude: el.lat,
    longitude: el.lon,
    maxspeed: textTag(tags.maxspeed),
    ref: textTag(tags.ref),
    operator: textTag(tags.operator),
    enforcement: textTag(tags.enforcement),
    directionDeg: normalizeDirection(
      tags['camera:direction'] ?? tags.direction,
    ),
    lastVerified: textTag(tags.check_date) || textTag(tags['survey:date']),
    name: textTag(tags.name),
  };
}

export function buildSpeedCameraQuery(south, west, north, east) {
  return (
    `[out:json][timeout:20];node["highway"="speed_camera"]` +
    `(${south},${west},${north},${east});out body ${QUERY_LIMIT};`
  );
}

export function validateSpeedCameraSnapshot(snapshot) {
  if (
    !Array.isArray(snapshot?.records) ||
    typeof snapshot.stale !== 'boolean' ||
    typeof snapshot.saturated !== 'boolean'
  ) {
    throw new TypeError('Speed camera source returned an invalid snapshot');
  }
  const ids = new Set();
  for (const record of snapshot.records) {
    if (
      !record ||
      typeof record.id !== 'string' ||
      !record.id.trim() ||
      ids.has(record.id) ||
      !Number.isFinite(record.latitude) ||
      Math.abs(record.latitude) > 90 ||
      !Number.isFinite(record.longitude) ||
      Math.abs(record.longitude) > 180 ||
      (record.directionDeg != null &&
        (!Number.isFinite(record.directionDeg) ||
          record.directionDeg < 0 ||
          record.directionDeg >= 360))
    ) {
      throw new TypeError('Speed camera source returned an invalid record');
    }
    ids.add(record.id);
  }
  return snapshot;
}

export function speedCameraDisplayId(record) {
  if (record.ref) return `SPD-${record.ref}`;
  if (!Number.isSafeInteger(record.osmId)) return 'SPEED CAMERA';
  return `SPD-${String(record.osmId).slice(-4).padStart(4, '0')}`;
}

export function speedCameraLabelDetails(record) {
  const details = ['OSM MAPPED'];
  if (record.maxspeed) details.push(`MAX ${record.maxspeed} km/h`);
  const enforcementLabel =
    record.enforcement?.replace(/_/g, ' ').toUpperCase() || 'SPEED';
  details.push(enforcementLabel);
  if (record.operator) details.push(record.operator.toUpperCase());
  if (Number.isFinite(record.directionDeg))
    details.push(`DIR ${Math.round(record.directionDeg)}°`);
  return details;
}
