import { distance, worldNow } from '../core/utilities.js';
import { activeOwnedBases } from '../base/field-bases.js';
import { REGION_SIMULATION_MODE } from '../base/region-control.js';

export const REGION_ACTIVITY = Object.freeze({
  ACTIVE: 'ACTIVE',
  PERIPHERAL: 'PERIPHERAL',
  DORMANT: 'DORMANT'
});

export const REGION_ACTIVITY_CONFIG = Object.freeze({
  activeRadiusMeters: 900,
  peripheralRadiusMeters: 2400,
  peripheralIntervalSeconds: 2,
  dormantIntervalSeconds: 8,
  maximumSimulationSubstepSeconds: 0.25,
  offlineActiveSubstepSeconds: 1,
  offlinePeripheralSubstepSeconds: 4
});

function finitePoint(point) {
  return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
}

function regionProfileForAnchor(state, base) {
  return base?.id ? state.world?.regionProfiles?.[base.id] ?? null : null;
}

function recentlyIncident(profile, now) {
  return profile && now - Math.max(0, Number(profile.lastIncidentAt) || 0) <= 10 * 60 * 1000;
}

function anchorActivityShape(profile, now) {
  if (!profile) return { activeRadius: REGION_ACTIVITY_CONFIG.activeRadiusMeters, peripheralRadius: REGION_ACTIVITY_CONFIG.peripheralRadiusMeters };
  if (profile.simulationMode === REGION_SIMULATION_MODE.SECURED) {
    if (!recentlyIncident(profile, now)) return null;
    return { activeRadius: 180, peripheralRadius: 900 };
  }
  if (profile.simulationMode === REGION_SIMULATION_MODE.ABSTRACT) return { activeRadius: 360, peripheralRadius: 1500 };
  return { activeRadius: REGION_ACTIVITY_CONFIG.activeRadiusMeters, peripheralRadius: REGION_ACTIVITY_CONFIG.peripheralRadiusMeters };
}

export function regionActivityAnchors(state) {
  const now = worldNow(state);
  const anchors = [];
  for (const base of activeOwnedBases(state).filter(finitePoint)) {
    const shape = anchorActivityShape(regionProfileForAnchor(state, base), now);
    if (!shape) continue;
    anchors.push({ x: base.x, y: base.y, ...shape });
  }
  if (finitePoint(state.player?.worldPosition)) {
    const player = state.player.worldPosition;
    if (!anchors.some(anchor => distance(anchor, player) < 1)) {
      anchors.push({ x: player.x, y: player.y, activeRadius: REGION_ACTIVITY_CONFIG.activeRadiusMeters, peripheralRadius: REGION_ACTIVITY_CONFIG.peripheralRadiusMeters });
    }
  }
  return anchors;
}

export function regionActivityForAnchors(point, anchors = []) {
  if (!finitePoint(point)) return REGION_ACTIVITY.ACTIVE;
  if (anchors.length === 0) return REGION_ACTIVITY.DORMANT;
  let active = false;
  let peripheral = false;
  for (const anchor of anchors) {
    const dx = Number(anchor.x) - Number(point.x);
    const dy = Number(anchor.y) - Number(point.y);
    const squared = dx * dx + dy * dy;
    const activeRadius = Math.max(0, Number(anchor.activeRadius) || REGION_ACTIVITY_CONFIG.activeRadiusMeters);
    const peripheralRadius = Math.max(activeRadius, Number(anchor.peripheralRadius) || REGION_ACTIVITY_CONFIG.peripheralRadiusMeters);
    if (squared <= activeRadius ** 2) active = true;
    if (squared <= peripheralRadius ** 2) peripheral = true;
    if (active) break;
  }
  if (active) return REGION_ACTIVITY.ACTIVE;
  if (peripheral) return REGION_ACTIVITY.PERIPHERAL;
  return REGION_ACTIVITY.DORMANT;
}

export function regionActivityAtPoint(state, point) {
  return regionActivityForAnchors(point, regionActivityAnchors(state));
}

export function ensureRegionalSimulationState(state) {
  state.runtime.regionalSimulation ??= {};
  const value = state.runtime.regionalSimulation;
  value.peripheralAccumulator = Math.max(0, Number(value.peripheralAccumulator) || 0);
  value.dormantAccumulator = Math.max(0, Number(value.dormantAccumulator) || 0);
  return value;
}

function consumeInterval(value, interval) {
  const count = Math.floor((value + 1e-9) / interval);
  return {
    elapsed: count * interval,
    remainder: Math.max(0, value - count * interval)
  };
}

export function consumeRegionalSimulationTime(state, deltaSeconds) {
  const elapsed = Math.max(0, Number(deltaSeconds) || 0);
  const runtime = ensureRegionalSimulationState(state);
  runtime.peripheralAccumulator += elapsed;
  runtime.dormantAccumulator += elapsed;

  const peripheral = consumeInterval(runtime.peripheralAccumulator, REGION_ACTIVITY_CONFIG.peripheralIntervalSeconds);
  const dormant = consumeInterval(runtime.dormantAccumulator, REGION_ACTIVITY_CONFIG.dormantIntervalSeconds);
  runtime.peripheralAccumulator = peripheral.remainder;
  runtime.dormantAccumulator = dormant.remainder;

  return {
    active: elapsed,
    peripheral: peripheral.elapsed,
    dormant: dormant.elapsed
  };
}
