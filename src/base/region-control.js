import { distance, worldNow } from '../core/utilities.js';
import { activePlayerBases, playerBasesView } from './player-bases.js';
import { activeFieldBases } from './field-bases.js';
import { defenseWorldPosition } from '../combat/combat-geometry.js';
import { addBundle, bundleText } from '../civilization/inventory-system.js';
import { RESOURCE_KEYS } from '../civilization/data.js';
import { enemyUnitCount } from '../combat/enemy-grouping.js';

export const REGION_SIMULATION_MODE = Object.freeze({
  ACTIVE: 'ACTIVE',
  ABSTRACT: 'ABSTRACT',
  SECURED: 'SECURED'
});

const PROFILE_VERSION = 3;
const REGION_RADIUS_METERS = 720;
const DEFENSE_RADIUS_METERS = 420;
const MAX_CONTROL_DELTA_PER_SECOND = 0.000045;
const CONTROL_DECAY_PER_SECOND = 0.000006;

const KIND_DEFAULTS = Object.freeze({
  PRIMARY: Object.freeze({ control: 0.34, enemyPressure: 0.45, baseYieldPerHour: 18, logisticsBase: 1.4 }),
  MAJOR: Object.freeze({ control: 0.18, enemyPressure: 0.25, baseYieldPerHour: 30, logisticsBase: 1.15 }),
  FIELD: Object.freeze({ control: 0.12, enemyPressure: 0.20, baseYieldPerHour: 14, logisticsBase: 0.65 })
});

const PRIMARY_BASELINE_YIELD_BY_LEVEL = Object.freeze([12, 18, 24, 30]);

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function clamp01(value) { return clamp(value, 0, 1); }
function finitePoint(point) { return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)); }
function nowMs(state) { return worldNow(state); }
function civilizationLevel(state) { return Math.max(0, Math.min(7, Math.floor(Number(state?.civilization?.level) || 0))); }

function baseKind(base) {
  if (base?.primary) return 'PRIMARY';
  return String(base?.kind ?? base?.frontlineKind ?? '').toUpperCase() === 'FIELD' ? 'FIELD' : 'MAJOR';
}

export function activeRegionAnchors(state) {
  return [
    ...playerBasesView(state).filter(base => base.status !== 'DESTROYED' && base.hp > 0).map(base => ({ ...base, regionKind: base.primary ? 'PRIMARY' : 'MAJOR' })),
    ...activeFieldBases(state).map(base => ({ ...base, regionKind: 'FIELD' }))
  ].filter(base => base?.id && base.nodeId && finitePoint(base));
}

function profileDefaultsForBase(base) {
  const kind = base?.regionKind ?? baseKind(base);
  const defaults = KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.MAJOR;
  return {
    version: PROFILE_VERSION,
    anchorBaseId: base.id,
    kind,
    control: defaults.control,
    computedEnemyPressure: defaults.enemyPressure,
    pressureMemory: 0,
    enemyPressure: defaults.enemyPressure,
    defenseScore: 0,
    logisticsScore: defaults.logisticsBase,
    resourceYieldPerHour: 0,
    simulationMode: REGION_SIMULATION_MODE.ACTIVE,
    modeCandidate: null,
    modeCandidateSince: 0,
    modeChangedAt: 0,
    regionUpdateAccumulatorSeconds: 0,
    resourceRemainders: {},
    lastUpdatedAt: 0,
    lastIncidentAt: 0,
    lastYieldAt: 0,
    lifetimeYield: {}
  };
}

function normalizeProfile(profile, base) {
  const defaults = profileDefaultsForBase(base);
  const value = { ...defaults, ...(profile && typeof profile === 'object' ? profile : {}) };
  value.version = PROFILE_VERSION;
  value.anchorBaseId = base.id;
  value.kind = base?.regionKind ?? baseKind(base);
  value.control = clamp01(value.control);
  value.computedEnemyPressure = clamp01(value.computedEnemyPressure ?? value.enemyPressure);
  value.pressureMemory = clamp(Number(value.pressureMemory) || 0, -0.45, 0.65);
  value.enemyPressure = clamp01(value.enemyPressure ?? (value.computedEnemyPressure + value.pressureMemory));
  value.defenseScore = Math.max(0, Number(value.defenseScore) || 0);
  value.logisticsScore = Math.max(0, Number(value.logisticsScore) || 0);
  value.resourceYieldPerHour = Math.max(0, Number(value.resourceYieldPerHour) || 0);
  value.simulationMode = Object.values(REGION_SIMULATION_MODE).includes(value.simulationMode) ? value.simulationMode : REGION_SIMULATION_MODE.ACTIVE;
  value.modeCandidate = Object.values(REGION_SIMULATION_MODE).includes(value.modeCandidate) ? value.modeCandidate : null;
  value.modeCandidateSince = Math.max(0, Number(value.modeCandidateSince) || 0);
  value.modeChangedAt = Math.max(0, Number(value.modeChangedAt) || 0);
  value.regionUpdateAccumulatorSeconds = Math.max(0, Number(value.regionUpdateAccumulatorSeconds) || 0);
  value.resourceRemainders = RESOURCE_KEYS.reduce((result, key) => {
    const amount = Number(value.resourceRemainders?.[key]) || 0;
    if (amount > 0) result[key] = amount;
    return result;
  }, {});
  value.lifetimeYield = RESOURCE_KEYS.reduce((result, key) => {
    const amount = Math.max(0, Math.floor(Number(value.lifetimeYield?.[key]) || 0));
    if (amount > 0) result[key] = amount;
    return result;
  }, {});
  value.lastUpdatedAt = Math.max(0, Number(value.lastUpdatedAt) || 0);
  value.lastIncidentAt = Math.max(0, Number(value.lastIncidentAt) || 0);
  value.lastYieldAt = Math.max(0, Number(value.lastYieldAt) || 0);
  return value;
}

export function ensureRegionControlState(state) {
  state.world ??= {};
  const existing = state.world.regionProfiles && typeof state.world.regionProfiles === 'object' && !Array.isArray(state.world.regionProfiles)
    ? state.world.regionProfiles
    : {};
  const next = {};
  for (const base of activeRegionAnchors(state)) {
    next[base.id] = normalizeProfile(existing[base.id], base);
  }
  state.world.regionProfiles = next;
  return next;
}

export function regionProfileForBase(state, baseOrId) {
  const id = typeof baseOrId === 'string' ? baseOrId : baseOrId?.id;
  if (!id) return null;
  const profiles = ensureRegionControlState(state);
  return profiles[id] ?? null;
}

function pointForNode(state, nodeId) {
  return nodeId ? state.world?.roadGraph?.nodeById?.get(nodeId) ?? null : null;
}

function defenseScoreForBase(state, base) {
  if (!finitePoint(base)) return 0;
  const radius = base.primary ? DEFENSE_RADIUS_METERS + 160 : DEFENSE_RADIUS_METERS;
  let score = 0;
  for (const defense of state.combat?.defenses ?? []) {
    if (!defense || defense.hp <= 0) continue;
    const point = defenseWorldPosition(state.world?.roadGraph, defense);
    if (!finitePoint(point) || distance(base, point) > radius) continue;
    const hpRatio = clamp01(Number(defense.hp) / Math.max(1, Number(defense.maxHp) || Number(defense.hp) || 1));
    const tier = Math.max(0, Math.floor(Number(defense.tier) || 0));
    const kindWeight = defense.kind === 'barrier' ? 0.55 : defense.type === 'medical' || defense.type === 'relay' ? 0.85 : defense.type === 'survey' || defense.type === 'fieldBarracks' ? 0.45 : 1;
    score += (1 + tier * 0.28) * hpRatio * kindWeight;
  }
  return Math.round(score * 10) / 10;
}

function logisticsScoreForBase(state, base, defenseScore) {
  const kind = base?.regionKind ?? baseKind(base);
  const defaults = KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.MAJOR;
  let score = defaults.logisticsBase + defenseScore * 0.12;
  for (const defense of state.combat?.defenses ?? []) {
    if (!defense || defense.hp <= 0) continue;
    const point = defenseWorldPosition(state.world?.roadGraph, defense);
    if (!finitePoint(point) || distance(base, point) > DEFENSE_RADIUS_METERS + 120) continue;
    if (defense.type === 'survey') score += 0.55 + Math.max(0, Number(defense.tier) || 0) * 0.08;
    if (defense.type === 'fieldBarracks') score += 0.35;
    if (defense.type === 'relay') score += 0.25;
  }
  return Math.round(score * 10) / 10;
}

function enemyPressureForBase(state, base) {
  const kind = base?.regionKind ?? baseKind(base);
  let score = kind === 'PRIMARY' ? 0.28 : 0.12;
  for (const enemyBase of state.world?.enemyBases ?? []) {
    if (!enemyBase?.alive || enemyBase.hp <= 0) continue;
    const anchored = enemyBase.frontlineAnchorBaseId === base.id;
    const point = finitePoint(enemyBase) ? enemyBase : pointForNode(state, enemyBase.nodeId);
    const nearby = finitePoint(point) && distance(base, point) <= REGION_RADIUS_METERS;
    if (anchored) score += 0.26 + Math.max(0, Number(enemyBase.level) || 1) * 0.045;
    else if (kind === 'PRIMARY' && !enemyBase.frontlineAnchorBaseId && nearby) score += 0.18 + Math.max(0, Number(enemyBase.level) || 1) * 0.035;
    else if (nearby) score += 0.08;
  }
  for (const enemy of state.combat?.enemies ?? []) {
    if (!enemy || enemy.hp <= 0) continue;
    const units = enemyUnitCount(enemy);
    if (enemy.frontlineAnchorBaseId === base.id || enemy.targetPlayerBaseId === base.id || enemy.targetFieldBaseId === base.id) {
      score += Math.min(0.32, units * 0.018);
      continue;
    }
    const point = pointForNode(state, enemy.nodeId);
    if (finitePoint(point) && distance(base, point) <= REGION_RADIUS_METERS) score += Math.min(0.14, units * 0.009);
  }
  return clamp01(score);
}

function targetSimulationModeForProfile(profile) {
  if (profile.control >= 0.86 && profile.defenseScore >= profile.enemyPressure * 16 + 3.2) return REGION_SIMULATION_MODE.SECURED;
  if (profile.control >= 0.58 && profile.defenseScore >= profile.enemyPressure * 10 + 1.5) return REGION_SIMULATION_MODE.ABSTRACT;
  return REGION_SIMULATION_MODE.ACTIVE;
}

const MODE_RANK = Object.freeze({
  [REGION_SIMULATION_MODE.ACTIVE]: 0,
  [REGION_SIMULATION_MODE.ABSTRACT]: 1,
  [REGION_SIMULATION_MODE.SECURED]: 2
});

function modeImprovementTarget(current, target) {
  if (current === REGION_SIMULATION_MODE.ACTIVE && target === REGION_SIMULATION_MODE.SECURED) return REGION_SIMULATION_MODE.ABSTRACT;
  return target;
}

function transitionDelayMs(current, target, profile) {
  const currentRank = MODE_RANK[current] ?? 0;
  const targetRank = MODE_RANK[target] ?? 0;
  if (targetRank > currentRank) {
    if (current === REGION_SIMULATION_MODE.ACTIVE && target === REGION_SIMULATION_MODE.ABSTRACT) return 5 * 60 * 1000;
    if (current === REGION_SIMULATION_MODE.ABSTRACT && target === REGION_SIMULATION_MODE.SECURED) return 15 * 60 * 1000;
    return 5 * 60 * 1000;
  }
  if (targetRank < currentRank) {
    if (target === REGION_SIMULATION_MODE.ACTIVE) return profile.enemyPressure >= 0.72 ? 0 : 2 * 60 * 1000;
    return 10 * 60 * 1000;
  }
  return 0;
}

function updateSimulationMode(profile, now) {
  const current = Object.values(REGION_SIMULATION_MODE).includes(profile.simulationMode) ? profile.simulationMode : REGION_SIMULATION_MODE.ACTIVE;
  let target = modeImprovementTarget(current, targetSimulationModeForProfile(profile));
  if (target === current) {
    profile.modeCandidate = null;
    profile.modeCandidateSince = 0;
    profile.simulationMode = current;
    return current;
  }
  const delay = transitionDelayMs(current, target, profile);
  if (profile.modeCandidate !== target) {
    profile.modeCandidate = target;
    profile.modeCandidateSince = now;
  }
  if (delay <= 0 || now - Number(profile.modeCandidateSince || now) >= delay) {
    profile.simulationMode = target;
    profile.modeChangedAt = now;
    profile.modeCandidate = null;
    profile.modeCandidateSince = 0;
  }
  return profile.simulationMode;
}

function updateIntervalForProfile(profile) {
  if (profile.simulationMode === REGION_SIMULATION_MODE.SECURED) return 60;
  if (profile.simulationMode === REGION_SIMULATION_MODE.ABSTRACT) return 20;
  return 5;
}

function controlYieldFactor(control) {
  const value = clamp01(control);
  if (value < 0.20) return value * 0.30;
  if (value < 0.50) return 0.06 + (value - 0.20) / 0.30 * 0.30;
  if (value < 0.80) return 0.36 + (value - 0.50) / 0.30 * 0.44;
  return 0.80 + (value - 0.80) / 0.20 * 0.32;
}

function defensePressureYieldFactor(profile, state) {
  const level = civilizationLevel(state);
  const defenseCapacity = profile.defenseScore / Math.max(2.2, 3.4 + level * 0.75);
  const pressureLoad = profile.enemyPressure * (1.10 + level * 0.06);
  const margin = defenseCapacity - pressureLoad;
  if (margin < -0.45) return 0.18;
  if (margin < 0) return 0.18 + (margin + 0.45) / 0.45 * 0.37;
  if (margin < 0.55) return 0.55 + margin / 0.55 * 0.35;
  return Math.min(1.12, 0.90 + Math.min(0.22, (margin - 0.55) * 0.18));
}

function regionalYieldScaleForState(state) {
  const profileCount = Math.max(0, Object.keys(state.world?.regionProfiles ?? {}).length || activeRegionAnchors(state).length);
  if (profileCount <= 20) return 1;
  const scaled = 1 / (1 + (profileCount - 20) * 0.006);
  return clamp(scaled, 0.45, 1);
}

function primaryBaselineYieldPerHour(state, profile) {
  if (profile.kind !== 'PRIMARY') return 0;
  if (state?.lifecycle === 'DESTROYED' || state?.runtime?.gameOver) return 0;
  const level = civilizationLevel(state);
  const baseline = PRIMARY_BASELINE_YIELD_BY_LEVEL[Math.min(level, PRIMARY_BASELINE_YIELD_BY_LEVEL.length - 1)] ?? 0;
  if (baseline <= 0) return 0;
  const pressurePenalty = clamp(1 - Math.max(0, profile.enemyPressure - 0.55) * 1.25, 0.35, 1);
  const modePenalty = profile.simulationMode === REGION_SIMULATION_MODE.ACTIVE ? 1 : 0.94;
  return baseline * pressurePenalty * modePenalty;
}

function yieldPerHourForProfile(state, profile) {
  const level = civilizationLevel(state);
  const kindDefaults = KIND_DEFAULTS[profile.kind] ?? KIND_DEFAULTS.MAJOR;
  const controlFactor = controlYieldFactor(profile.control);
  const pressureFactor = defensePressureYieldFactor(profile, state);
  const logisticsFactor = 0.58 + Math.min(1.20, profile.logisticsScore / 9.5);
  const levelFactor = 1 + level * 0.135;
  const modeFactor = profile.simulationMode === REGION_SIMULATION_MODE.SECURED
    ? 1.10
    : profile.simulationMode === REGION_SIMULATION_MODE.ABSTRACT
      ? 0.98
      : 0.92;
  const globalScale = regionalYieldScaleForState(state);
  const formulaYield = kindDefaults.baseYieldPerHour * controlFactor * pressureFactor * logisticsFactor * levelFactor * modeFactor * globalScale;
  const baselineYield = primaryBaselineYieldPerHour(state, profile);
  return Math.max(0, formulaYield, baselineYield);
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (total <= 0) return { wood: 1 };
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Math.max(0, Number(value) || 0) / total]));
}

function resourceWeightsForState(state, profile) {
  const level = civilizationLevel(state);
  const weights = { wood: 0.34, stone: 0.32, fiber: 0.26 };
  if (level >= 1) { weights.timber = 0.05; weights.rope = 0.04; weights.cutStone = 0.04; }
  if (level >= 2) { weights.copperOre = 0.06; weights.tinOre = 0.04; weights.copperIngot = 0.015; weights.tinIngot = 0.012; }
  if (level >= 3) { weights.ironOre = 0.055; weights.bronzeIngot = 0.018; }
  if (level >= 4) { weights.ironBloom = 0.016; weights.wroughtIron = 0.012; }
  if (level >= 5) { weights.steel = 0.008; }
  if (level >= 6) { weights.mechanism = 0.004; }
  if (profile.kind === 'FIELD') {
    weights.wood *= 1.08; weights.fiber *= 1.08; weights.stone *= 0.92;
  } else if (profile.kind === 'MAJOR') {
    weights.stone *= 1.08; weights.wood *= 1.04;
  }
  return normalizeWeights(weights);
}

function addResourceBundleTo(target, bundle = {}) {
  for (const [key, amount] of Object.entries(bundle)) {
    const value = Math.max(0, Math.floor(Number(amount) || 0));
    if (value <= 0) continue;
    target[key] = (target[key] ?? 0) + value;
  }
  return target;
}

function bundleTotal(bundle = {}) {
  return Object.values(bundle).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function normalizeRuntimeBundle(bundle = {}) {
  return RESOURCE_KEYS.reduce((result, key) => {
    const amount = Math.max(0, Math.floor(Number(bundle[key]) || 0));
    if (amount > 0) result[key] = amount;
    return result;
  }, {});
}

function regionLogisticsNotificationState(state) {
  state.runtime ??= {};
  const existing = state.runtime.regionLogisticsNotifications;
  const value = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  value.accepted = normalizeRuntimeBundle(value.accepted);
  value.rejected = normalizeRuntimeBundle(value.rejected);
  value.lastYieldMessageAt = Math.max(0, Number(value.lastYieldMessageAt) || 0);
  value.lastCapacityWarningAt = Math.max(0, Number(value.lastCapacityWarningAt) || 0);
  state.runtime.regionLogisticsNotifications = value;
  return value;
}

function collectRegionLogisticsNotification(state, result) {
  const accepted = normalizeRuntimeBundle(result?.accepted);
  const rejected = normalizeRuntimeBundle(result?.rejected);
  if (!bundleTotal(accepted) && !bundleTotal(rejected)) return;
  const notifications = regionLogisticsNotificationState(state);
  addResourceBundleTo(notifications.accepted, accepted);
  addResourceBundleTo(notifications.rejected, rejected);
}

function flushRegionLogisticsNotifications(state, events = null) {
  if (!events || state?.runtime?.offlineSimulation) return;
  const notifications = regionLogisticsNotificationState(state);
  const now = nowMs(state);
  const acceptedTotalAtFlush = bundleTotal(notifications.accepted);
  if (acceptedTotalAtFlush > 0 && now - notifications.lastYieldMessageAt >= 45 * 60 * 1000) {
    const accepted = { ...notifications.accepted };
    notifications.accepted = {};
    notifications.lastYieldMessageAt = now;
    events.emit('message', {
      key: 'region.logisticsYield',
      params: { resourceText: { __resourceBundle: true, bundle: accepted } },
      text: `各拠点の補給圏から資材を回収しました：${bundleText(accepted)}`
    });
  }
  if (bundleTotal(notifications.rejected) > 0 && now - notifications.lastCapacityWarningAt >= 30 * 60 * 1000) {
    const rejected = { ...notifications.rejected };
    const acceptedPending = acceptedTotalAtFlush > 0;
    notifications.rejected = {};
    notifications.lastCapacityWarningAt = now;
    events.emit('message', {
      key: acceptedPending ? 'region.logisticsCapacityPartial' : 'region.logisticsCapacityFull',
      params: { resourceText: { __resourceBundle: true, bundle: rejected } },
      text: `在庫容量不足により地域補給の一部を受け取れませんでした：${bundleText(rejected)}`
    });
  }
}

function accrueRegionResources(state, profile, deltaSeconds) {
  const elapsed = Math.max(0, Number(deltaSeconds) || 0);
  if (elapsed <= 0) return null;
  profile.resourceYieldPerHour = yieldPerHourForProfile(state, profile);
  profile.resourceRemainders ??= {};
  const bundle = {};
  const weights = resourceWeightsForState(state, profile);
  const hours = Math.min(elapsed, 30 * 60) / 3600;
  for (const [key, weight] of Object.entries(weights)) {
    const next = (Number(profile.resourceRemainders[key]) || 0) + profile.resourceYieldPerHour * weight * hours;
    const amount = Math.floor(next);
    profile.resourceRemainders[key] = next - amount;
    if (amount > 0) bundle[key] = amount;
  }
  if (!Object.keys(bundle).length) return null;
  const result = addBundle(state, bundle);
  for (const [key, amount] of Object.entries(result.accepted ?? {})) {
    profile.lifetimeYield[key] = (profile.lifetimeYield[key] ?? 0) + amount;
  }
  if (Object.keys(result.accepted ?? {}).length) profile.lastYieldAt = nowMs(state);
  return result;
}

export function updateRegionControlAndLogistics(state, deltaSeconds, events = null) {
  const profiles = ensureRegionControlState(state);
  const elapsed = Math.max(0, Number(deltaSeconds) || 0);
  if (elapsed <= 0) return profiles;
  const anchors = activeRegionAnchors(state);
  state.runtime ??= {};
  const batchSize = anchors.length <= 24 ? anchors.length : Math.max(12, Math.ceil(anchors.length / 8));
  const cursor = Math.max(0, Math.floor(Number(state.runtime.regionControlUpdateCursor) || 0)) % Math.max(1, anchors.length);
  const now = nowMs(state);
  for (let index = 0; index < anchors.length; index += 1) {
    const base = anchors[index];
    const profile = profiles[base.id];
    const previousControl = profile.control;
    profile.regionUpdateAccumulatorSeconds = Math.min(6 * 60 * 60, (Number(profile.regionUpdateAccumulatorSeconds) || 0) + elapsed);
    const updateInterval = updateIntervalForProfile(profile);
    const firstUpdate = !profile.lastUpdatedAt;
    if (!firstUpdate && profile.regionUpdateAccumulatorSeconds < updateInterval) continue;
    const profileElapsed = Math.max(0, profile.regionUpdateAccumulatorSeconds || elapsed);
    profile.regionUpdateAccumulatorSeconds = 0;
    const scoreThisTick = anchors.length <= 24 || ((index - cursor + anchors.length) % anchors.length) < batchSize || firstUpdate;
    if (scoreThisTick) {
      profile.defenseScore = defenseScoreForBase(state, base);
      profile.logisticsScore = logisticsScoreForBase(state, base, profile.defenseScore);
      profile.computedEnemyPressure = enemyPressureForBase(state, base);
    }
    const memory = Number(profile.pressureMemory) || 0;
    const decay = Math.min(Math.abs(memory), profileElapsed * 0.000025);
    profile.pressureMemory = memory > 0 ? memory - decay : memory < 0 ? memory + decay : 0;
    profile.enemyPressure = clamp01(profile.computedEnemyPressure + profile.pressureMemory);
    const defenseCapacity = clamp01(profile.defenseScore / Math.max(2.5, 4 + civilizationLevel(state) * 0.9));
    const logisticsCapacity = clamp01(profile.logisticsScore / Math.max(2, 3.5 + civilizationLevel(state) * 0.4));
    const controlGain = (defenseCapacity * 0.72 + logisticsCapacity * 0.28) * (1 - profile.enemyPressure * 0.78) * MAX_CONTROL_DELTA_PER_SECOND;
    const controlLoss = (profile.enemyPressure > defenseCapacity ? (profile.enemyPressure - defenseCapacity) * 0.000041 : 0) + CONTROL_DECAY_PER_SECOND * Math.max(0, 0.28 - defenseCapacity);
    profile.control = clamp01(profile.control + (controlGain - controlLoss) * profileElapsed);
    updateSimulationMode(profile, now);
    profile.resourceYieldPerHour = yieldPerHourForProfile(state, profile);
    profile.lastUpdatedAt = now;
    if (profile.enemyPressure >= 0.58 && previousControl - profile.control > 0.002) profile.lastIncidentAt = profile.lastUpdatedAt;
    const logisticsResult = accrueRegionResources(state, profile, profileElapsed);
    if (logisticsResult && !state.runtime.offlineSimulation) collectRegionLogisticsNotification(state, logisticsResult);
  }
  flushRegionLogisticsNotifications(state, events);
  if (anchors.length > 24) state.runtime.regionControlUpdateCursor = (cursor + batchSize) % anchors.length;
  else state.runtime.regionControlUpdateCursor = 0;
  return profiles;
}

export function applyRegionControlEvent(state, anchorBaseId, amount, { pressure = 0, incident = false } = {}) {
  if (!anchorBaseId) return null;
  const profiles = ensureRegionControlState(state);
  const profile = profiles[anchorBaseId];
  if (!profile) return null;
  profile.control = clamp01(profile.control + Number(amount || 0));
  if (pressure) profile.pressureMemory = clamp((Number(profile.pressureMemory) || 0) + Number(pressure || 0), -0.45, 0.65);
  profile.enemyPressure = clamp01((Number(profile.computedEnemyPressure) || 0) + (Number(profile.pressureMemory) || 0));
  if (incident) profile.lastIncidentAt = nowMs(state);
  updateSimulationMode(profile, nowMs(state));
  profile.resourceYieldPerHour = yieldPerHourForProfile(state, profile);
  profile.lastUpdatedAt = nowMs(state);
  return profile;
}

export function nearestRegionAnchor(state, point) {
  if (!finitePoint(point)) return null;
  return activeRegionAnchors(state)
    .map(base => ({ base, gap: distance(base, point) }))
    .sort((a, b) => a.gap - b.gap)[0]?.base ?? null;
}

export function anchorIdForEnemyBaseRegion(state, enemyBase) {
  if (enemyBase?.frontlineAnchorBaseId) return enemyBase.frontlineAnchorBaseId;
  const point = finitePoint(enemyBase) ? enemyBase : pointForNode(state, enemyBase?.nodeId);
  const nearest = nearestRegionAnchor(state, point);
  return nearest?.id ?? playerBasesView(state).find(base => base.primary)?.id ?? null;
}

export function respawnDelayMultiplierForEnemyBase(state, enemyBase) {
  const anchorId = anchorIdForEnemyBaseRegion(state, enemyBase);
  const profile = anchorId ? regionProfileForBase(state, anchorId) : null;
  if (!profile) return 1;
  if (profile.simulationMode === REGION_SIMULATION_MODE.SECURED) return 6 + profile.control * 6;
  if (profile.simulationMode === REGION_SIMULATION_MODE.ABSTRACT) return 2.1 + profile.control * 1.8;
  return 1 + Math.max(0, profile.control - 0.55) * 0.75;
}

export function enemyBaseSpawnIntervalMultiplierForRegion(state, enemyBase) {
  const anchorId = anchorIdForEnemyBaseRegion(state, enemyBase);
  const profile = anchorId ? regionProfileForBase(state, anchorId) : null;
  if (!profile) return 1;
  if (profile.simulationMode === REGION_SIMULATION_MODE.SECURED) return 10;
  if (profile.simulationMode === REGION_SIMULATION_MODE.ABSTRACT) return 2.8;
  return 1 + Math.max(0, profile.control - 0.75) * 0.7;
}

export function frontlineSlotCapForRegion(state, anchorBase, naturalSlotCount) {
  const count = Math.max(1, Math.floor(Number(naturalSlotCount) || 1));
  const profile = regionProfileForBase(state, anchorBase);
  if (!profile) return count;
  if (profile.simulationMode === REGION_SIMULATION_MODE.SECURED) return 0;
  if (profile.simulationMode === REGION_SIMULATION_MODE.ABSTRACT) return Math.min(count, 2);
  return count;
}

export function regionPressureLabelKey(profile) {
  if (!profile) return 'region.pressure.unknown';
  if (profile.enemyPressure >= 0.68) return 'region.pressure.high';
  if (profile.enemyPressure >= 0.38) return 'region.pressure.medium';
  return 'region.pressure.low';
}

export function regionModeLabelKey(profile) {
  if (!profile) return 'region.mode.active';
  if (profile.simulationMode === REGION_SIMULATION_MODE.SECURED) return 'region.mode.secured';
  if (profile.simulationMode === REGION_SIMULATION_MODE.ABSTRACT) return 'region.mode.abstract';
  return 'region.mode.active';
}

function regionText(i18n, key, params, fallback) {
  return i18n?.message?.(key, params, fallback) ?? fallback;
}

export function regionControlSummaryText(state, base, i18n = null) {
  const profile = regionProfileForBase(state, base);
  if (!profile) return regionText(i18n, 'region.summaryUnknown', {}, '制圧 不明');
  const control = Math.round(profile.control * 100);
  const pressure = regionText(i18n, regionPressureLabelKey(profile), {}, profile.enemyPressure >= 0.68 ? '高' : profile.enemyPressure >= 0.38 ? '中' : '低');
  const mode = regionText(i18n, regionModeLabelKey(profile), {}, profile.simulationMode === REGION_SIMULATION_MODE.SECURED ? '後方安定' : profile.simulationMode === REGION_SIMULATION_MODE.ABSTRACT ? '警戒維持' : '前線活動');
  return regionText(i18n, 'region.summary', { control, pressure, mode }, `制圧 ${control}%・敵圧 ${pressure}・${mode}`);
}

export function regionLogisticsSummaryText(state, base, i18n = null) {
  const profile = regionProfileForBase(state, base);
  if (!profile) return regionText(i18n, 'region.logisticsUnknown', {}, '補給収益 不明');
  return regionText(i18n, 'region.logistics', {
    yieldPerHour: Math.round(profile.resourceYieldPerHour),
    defenseScore: profile.defenseScore.toFixed(1),
    logisticsScore: profile.logisticsScore.toFixed(1)
  }, `補給 +${Math.round(profile.resourceYieldPerHour)}/時・防衛 ${profile.defenseScore.toFixed(1)}・物流 ${profile.logisticsScore.toFixed(1)}`);
}
