export function normalizedRoadLayer(value) {
  const layer = Number.parseInt(value?.layer ?? value ?? 0, 10);
  return Number.isFinite(layer) ? layer : 0;
}

export function roadElevationKey(value) {
  return `${normalizedRoadLayer(value)}:${value?.bridge ? 1 : 0}:${value?.tunnel ? 1 : 0}`;
}

export function roadElevationKnown(value) {
  return value?.elevationKnown !== false;
}

export function sameRoadElevation(first, second) {
  return roadElevationKey(first) === roadElevationKey(second);
}

export function normalizeRoadElevation(target) {
  target.layer = normalizedRoadLayer(target);
  target.bridge = Boolean(target.bridge);
  target.tunnel = Boolean(target.tunnel);
  target.elevationKnown = roadElevationKnown(target);
  target.elevationKey = roadElevationKey(target);
  return target;
}
