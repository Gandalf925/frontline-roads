import { CIVILIZATION_PROJECTS, MAX_CIVILIZATION_LEVEL, RESOURCE_KEYS } from './data.js';
import { addBundle, normalizeBundle } from './inventory-system.js';
import { unlockTableForLevel } from './unlock-table.js';

export const DAILY_MISSION_DAY_MS = 86_400_000;
export const DAILY_MISSION_PROJECT_DISCOUNT_BPS = 500;
export const DAILY_MISSION_PROJECT_DISCOUNT_DAILY_CAP_BPS = 1500;

const MISSION_TYPES = Object.freeze(['killEnemies', 'captureEnemyBases', 'completeProduction']);

function floorNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

export function dailyMissionEpochFromMs(nowMs) {
  return Math.max(0, Math.floor((Number(nowMs) || 0) / DAILY_MISSION_DAY_MS));
}

function hash32(...parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function metricValue(state, type) {
  if (type === 'killEnemies') return Math.max(0, floorNumber(state?.statistics?.kills));
  if (type === 'captureEnemyBases') return Math.max(0, floorNumber(state?.statistics?.campsCaptured));
  if (type === 'completeProduction') return Math.max(0, floorNumber(state?.statistics?.productionRuns));
  return 0;
}

function currentBaselines(state) {
  return Object.fromEntries(MISSION_TYPES.map(type => [type, metricValue(state, type)]));
}

function targetForMission(type, epoch, level) {
  const daySalt = hash32('daily-target', epoch, type) % 4;
  if (type === 'killEnemies') return 18 + level * 8 + daySalt * 4;
  if (type === 'captureEnemyBases') return 1 + (level >= 5 && daySalt >= 2 ? 1 : 0);
  if (type === 'completeProduction') return 4 + level * 2 + daySalt;
  return 1;
}

function normalizeMission(mission, state, epoch, level) {
  const type = MISSION_TYPES.includes(mission?.type) ? mission.type : 'killEnemies';
  const index = Math.max(0, Math.min(2, floorNumber(mission?.index)));
  const target = Math.max(1, floorNumber(mission?.target, targetForMission(type, epoch, level)));
  const id = String(mission?.id || `daily_${epoch}_${type}_${index}`);
  return { id, type, index, target };
}

export function generateDailyMissions(epoch, civilizationLevel = 0) {
  const level = Math.max(0, Math.min(MAX_CIVILIZATION_LEVEL, floorNumber(civilizationLevel)));
  const rotation = hash32('daily-missions', epoch, level) % MISSION_TYPES.length;
  return MISSION_TYPES.map((_, index) => {
    const type = MISSION_TYPES[(rotation + index) % MISSION_TYPES.length];
    return normalizeMission({ type, index }, null, epoch, level);
  });
}

function dailyMissionDefaultNowMs(state) {
  const existingEpoch = state?.progression?.daily?.epoch;
  if (existingEpoch !== undefined && existingEpoch !== null && existingEpoch !== '') {
    return Math.max(0, floorNumber(existingEpoch)) * DAILY_MISSION_DAY_MS;
  }
  return Number(state?.runtime?.worldTimeMs) || 0;
}

function normalizeDailyState(state, nowMs = dailyMissionDefaultNowMs(state)) {
  state.progression = state.progression && typeof state.progression === 'object' ? state.progression : {};
  const epoch = String(dailyMissionEpochFromMs(nowMs));
  const level = Math.max(0, Math.min(MAX_CIVILIZATION_LEVEL, floorNumber(state?.civilization?.level)));
  const existing = state.progression.daily && typeof state.progression.daily === 'object' ? state.progression.daily : null;
  const reset = !existing || String(existing.epoch ?? '') !== epoch;
  const daily = reset ? {
    epoch,
    levelAtGeneration: level,
    // This field intentionally stores a local-day epoch. It is isolated from
    // deterministic world-time simulation and can be swapped for an online
    // server/chain day source later without touching mission progress logic.
    localDayEpoch: epoch,
    baselines: currentBaselines(state),
    missions: generateDailyMissions(epoch, level),
    claimedMissionIds: [],
    projectDiscountBpsApplied: 0,
    projectDiscountMissionIds: []
  } : existing;

  daily.epoch = String(daily.epoch ?? epoch);
  daily.localDayEpoch = String(daily.localDayEpoch ?? daily.epoch);
  daily.levelAtGeneration = Math.max(0, Math.min(MAX_CIVILIZATION_LEVEL, floorNumber(daily.levelAtGeneration, level)));
  daily.baselines = { ...currentBaselines({}), ...(daily.baselines && typeof daily.baselines === 'object' ? daily.baselines : {}) };
  for (const type of MISSION_TYPES) daily.baselines[type] = Math.max(0, floorNumber(daily.baselines[type]));
  daily.missions = Array.isArray(daily.missions)
    ? daily.missions.slice(0, 3).map((mission, index) => normalizeMission({ ...mission, index }, state, Number(daily.epoch) || 0, daily.levelAtGeneration))
    : generateDailyMissions(Number(daily.epoch) || 0, daily.levelAtGeneration);
  if (daily.missions.length < 3) daily.missions = generateDailyMissions(Number(daily.epoch) || 0, daily.levelAtGeneration);
  const missionIds = new Set(daily.missions.map(mission => mission.id));
  daily.claimedMissionIds = Array.isArray(daily.claimedMissionIds)
    ? [...new Set(daily.claimedMissionIds.map(String).filter(id => missionIds.has(id)))]
    : [];
  daily.projectDiscountMissionIds = Array.isArray(daily.projectDiscountMissionIds)
    ? [...new Set(daily.projectDiscountMissionIds.map(String).filter(id => missionIds.has(id)))]
    : [];
  daily.projectDiscountBpsApplied = Math.max(0, Math.min(
    DAILY_MISSION_PROJECT_DISCOUNT_DAILY_CAP_BPS,
    floorNumber(daily.projectDiscountBpsApplied)
  ));
  state.progression.daily = daily;
  return daily;
}

export function ensureDailyMissionState(state, { nowMs = dailyMissionDefaultNowMs(state) } = {}) {
  return normalizeDailyState(state, nowMs);
}

export function dailyMissionProgress(state, mission) {
  const daily = ensureDailyMissionState(state);
  const current = Math.max(0, metricValue(state, mission.type) - Math.max(0, floorNumber(daily.baselines?.[mission.type])));
  const target = Math.max(1, floorNumber(mission.target, 1));
  return {
    current: Math.min(current, target),
    rawCurrent: current,
    target,
    complete: current >= target,
    ratio: Math.max(0, Math.min(1, current / target))
  };
}

export function dailyMissionRewardBundleForLevel(level) {
  const civilizationLevel = Math.max(0, Math.min(MAX_CIVILIZATION_LEVEL, floorNumber(level)));
  if (civilizationLevel <= 0) return { wood: 45, stone: 35, fiber: 24 };
  const table = unlockTableForLevel(civilizationLevel);
  const keys = (table?.coreResources ?? []).filter(key => RESOURCE_KEYS.includes(key));
  if (!keys.length) return { wood: 45, stone: 35, fiber: 24 };
  const baseAmount = Math.max(2, 6 + civilizationLevel * 2);
  const bundle = {};
  keys.forEach((key, index) => {
    const divider = index === 0 ? 1 : 2;
    bundle[key] = Math.max(1, Math.floor(baseAmount / divider));
  });
  return normalizeBundle(bundle);
}

function applyDailyProjectDiscount(state, missionId) {
  const daily = ensureDailyMissionState(state);
  if (daily.projectDiscountMissionIds.includes(missionId)) return { applied: false, accepted: {}, duplicate: true, bps: 0 };
  const remainingBps = Math.max(0, DAILY_MISSION_PROJECT_DISCOUNT_DAILY_CAP_BPS - daily.projectDiscountBpsApplied);
  const bps = Math.min(DAILY_MISSION_PROJECT_DISCOUNT_BPS, remainingBps);
  if (bps <= 0) return { applied: false, accepted: {}, capped: true, bps: 0 };
  const project = state.civilization?.project;
  const definition = project ? CIVILIZATION_PROJECTS[project.targetLevel] : null;
  if (!project || ['BUILDING', 'PAUSED'].includes(project.status) || !definition?.contributions) {
    daily.projectDiscountMissionIds.push(missionId);
    daily.projectDiscountBpsApplied += bps;
    return { applied: false, accepted: {}, noProject: true, bps };
  }
  project.contributions ??= {};
  const accepted = {};
  for (const [resource, requiredRaw] of Object.entries(definition.contributions ?? {})) {
    const required = Math.max(0, floorNumber(requiredRaw));
    if (required <= 0) continue;
    const current = Math.max(0, floorNumber(project.contributions[resource]));
    const remaining = Math.max(0, required - current);
    if (remaining <= 0) continue;
    const credit = Math.max(1, Math.floor(required * bps / 10_000));
    const applied = Math.min(remaining, credit);
    if (applied > 0) {
      project.contributions[resource] = current + applied;
      accepted[resource] = applied;
    }
  }
  daily.projectDiscountMissionIds.push(missionId);
  daily.projectDiscountBpsApplied += bps;
  return { applied: Object.keys(accepted).length > 0, accepted, bps };
}

export function dailyMissionSnapshots(state, { nowMs = dailyMissionDefaultNowMs(state) } = {}) {
  const daily = ensureDailyMissionState(state, { nowMs });
  const reward = dailyMissionRewardBundleForLevel(daily.levelAtGeneration);
  return daily.missions.map(mission => {
    const progress = dailyMissionProgress(state, mission);
    const claimed = daily.claimedMissionIds.includes(mission.id);
    return {
      ...mission,
      progress,
      claimed,
      claimable: progress.complete && !claimed,
      reward,
      discountBps: DAILY_MISSION_PROJECT_DISCOUNT_BPS
    };
  });
}

export function claimDailyMission(state, missionId, events = null) {
  const daily = ensureDailyMissionState(state);
  const id = String(missionId ?? '');
  const mission = daily.missions.find(item => item.id === id);
  if (!mission) return { ok: false, reasonKey: 'reason.dailyMission.notFound', reason: 'デイリー任務が見つかりません。' };
  if (daily.claimedMissionIds.includes(id)) return { ok: false, reasonKey: 'reason.dailyMission.alreadyClaimed', reason: 'このデイリー任務の報酬は受領済みです。' };
  const progress = dailyMissionProgress(state, mission);
  if (!progress.complete) return { ok: false, reasonKey: 'reason.dailyMission.notComplete', reason: 'デイリー任務がまだ完了していません。' };
  const reward = dailyMissionRewardBundleForLevel(daily.levelAtGeneration);
  const inventory = addBundle(state, reward);
  const discount = applyDailyProjectDiscount(state, id);
  daily.claimedMissionIds.push(id);
  const result = { ok: true, missionId: id, mission, reward, accepted: inventory.accepted ?? {}, rejected: inventory.rejected ?? {}, discount };
  events?.emit('progression:daily-mission-claimed', result);
  events?.emit('message', {
    key: 'daily.claimNotice',
    params: { resourceText: { __resourceBundle: true, bundle: result.accepted }, percent: Math.floor(discount.bps / 100) },
    text: 'デイリー任務報酬を受け取りました。'
  });
  return result;
}

export class DailyMissionSystem {
  constructor(events = null) {
    this.events = events;
  }

  update(state) {
    ensureDailyMissionState(state);
  }

  snapshots(state) {
    return dailyMissionSnapshots(state);
  }

  claim(state, missionId) {
    return claimDailyMission(state, missionId, this.events);
  }
}
