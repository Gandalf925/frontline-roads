import { BASE_RESOURCES, ORE_RESOURCES, PROCESSED_RESOURCES, RESOURCE_KEYS } from '../civilization/data.js';

export const OFFLINE_FILL_WINDOWS = Object.freeze({
  production: Object.freeze({ minSeconds: 4 * 60 * 60, targetSeconds: 5 * 60 * 60, maxSeconds: 6 * 60 * 60 }),
  roadside: Object.freeze({ minSeconds: 4 * 60 * 60, targetSeconds: 4.5 * 60 * 60, maxSeconds: 6 * 60 * 60 }),
  recovery: Object.freeze({ minSeconds: 4 * 60 * 60, targetSeconds: 5 * 60 * 60, maxSeconds: 6 * 60 * 60 })
});

export const OFFLINE_PRODUCTIVE_CAP_SECONDS = OFFLINE_FILL_WINDOWS.production.maxSeconds;
export const OFFLINE_ROADSIDE_REFILL_SECONDS = OFFLINE_FILL_WINDOWS.roadside.minSeconds;

const METAL_RESOURCES = new Set(['copperIngot', 'tinIngot', 'bronzeIngot', 'ironBloom', 'wroughtIron', 'steel', 'mechanism']);

function resourceCapacityCategory(resourceKey) {
  if (BASE_RESOURCES.includes(resourceKey)) return 'base';
  if (ORE_RESOURCES.includes(resourceKey)) return 'ore';
  if (PROCESSED_RESOURCES.includes(resourceKey)) return 'processed';
  if (METAL_RESOURCES.has(resourceKey)) return 'metal';
  return null;
}

function finiteSeconds(value) {
  return Math.max(0, Number(value) || 0);
}

export function offlineFillWindow(subsystem = 'production') {
  return OFFLINE_FILL_WINDOWS[subsystem] ?? OFFLINE_FILL_WINDOWS.production;
}

export function offlineProductiveSeconds(elapsedSeconds, subsystem = 'production') {
  const elapsed = finiteSeconds(elapsedSeconds);
  const window = offlineFillWindow(subsystem);
  return Math.min(elapsed, window.maxSeconds);
}

export function offlineFillRatio(elapsedSeconds, subsystem = 'production') {
  const elapsed = finiteSeconds(elapsedSeconds);
  const window = offlineFillWindow(subsystem);
  return Math.max(0, Math.min(1, elapsed / Math.max(1, window.targetSeconds)));
}

export function offlineStepProductiveSeconds(state, deltaSeconds, subsystem = 'production') {
  if (!state?.runtime?.offlineSimulation) return finiteSeconds(deltaSeconds);
  const elapsed = finiteSeconds(state.runtime.offlineSimulationElapsedSeconds);
  const step = finiteSeconds(deltaSeconds);
  const cap = offlineFillWindow(subsystem).maxSeconds;
  return Math.max(0, Math.min(step, cap - elapsed));
}

export function markRoadsideRefillReady(state, elapsedSeconds) {
  if (finiteSeconds(elapsedSeconds) < OFFLINE_ROADSIDE_REFILL_SECONDS) return false;
  const supplies = state?.world?.roadsideSupplies;
  if (!supplies || typeof supplies !== 'object') return false;
  supplies.active = [];
  supplies.lastRefreshPoint = null;
  supplies.nextRefreshAt = 0;
  supplies.offlineRefillReady = true;
  return true;
}

export function offlineFillSummary(state, elapsedSeconds) {
  const elapsed = finiteSeconds(elapsedSeconds);
  const result = {};
  for (const subsystem of Object.keys(OFFLINE_FILL_WINDOWS)) {
    const window = offlineFillWindow(subsystem);
    result[subsystem] = {
      elapsedSeconds: elapsed,
      productiveSeconds: offlineProductiveSeconds(elapsed, subsystem),
      minSeconds: window.minSeconds,
      targetSeconds: window.targetSeconds,
      maxSeconds: window.maxSeconds,
      ratio: offlineFillRatio(elapsed, subsystem),
      filled: elapsed >= window.minSeconds,
      capped: elapsed > window.maxSeconds
    };
  }
  const capacity = state?.inventory?.capacity ?? {};
  const resources = state?.inventory?.resources ?? {};
  const remainingCapacity = {};
  for (const key of RESOURCE_KEYS) {
    const category = resourceCapacityCategory(key);
    const categoryCapacity = Math.max(0, Number(category ? capacity[category] : 0) || 0);
    const stored = Math.max(0, Number(resources[key]) || 0);
    if (categoryCapacity > 0) remainingCapacity[key] = Math.max(0, categoryCapacity - stored);
  }
  result.remainingCapacity = remainingCapacity;
  return result;
}
