import { stableId, worldNow } from '../core/utilities.js';
import { ENEMY_BASE_DEFINITIONS } from './definitions.js';
import { createBaseRecoveryItem } from '../exploration/recovery-system.js';
import { RESOURCE_KEYS, applyCivilizationEfficiencyBonusToBundle } from '../civilization/data.js';
import { applyRegionControlEvent, anchorIdForEnemyBaseRegion, respawnDelayMultiplierForEnemyBase } from '../base/region-control.js';

export const BASE_RESPAWN_MIN_SECONDS = 4 * 60 * 60;
export const BASE_RESPAWN_MAX_SECONDS = 6 * 60 * 60;
export const RESOURCE_BASE_RESPAWN_MIN_SECONDS = 45 * 60;
export const RESOURCE_BASE_RESPAWN_MAX_SECONDS = 75 * 60;

const EARLY_ENEMY_BASE_CAPTURE_BONUSES = Object.freeze([
  Object.freeze({ wood: 40, stone: 30, fiber: 20 }),
  Object.freeze({ wood: 30, stone: 30, fiber: 20 }),
  Object.freeze({ wood: 20, stone: 20, fiber: 20 })
]);

function sanitizeBonusBundle(bundle = {}) {
  return RESOURCE_KEYS.reduce((result, key) => {
    const amount = Math.max(0, Math.floor(Number(bundle[key]) || 0));
    if (amount > 0) result[key] = amount;
    return result;
  }, {});
}

export function earlyEnemyBaseCaptureBonus(captureCount) {
  const index = Math.max(0, Math.floor(Number(captureCount) || 0) - 1);
  return sanitizeBonusBundle(EARLY_ENEMY_BASE_CAPTURE_BONUSES[index] ?? {});
}

function addBundleTo(base = {}, bonus = {}) {
  const result = { ...(base ?? {}) };
  for (const [key, amount] of Object.entries(sanitizeBonusBundle(bonus))) {
    result[key] = (Math.max(0, Math.floor(Number(result[key]) || 0)) + amount);
  }
  return result;
}

function deterministicRespawnSeconds(baseId, resourceBase = false) {
  let hash = 2166136261;
  for (const character of String(baseId)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const minimum = resourceBase ? RESOURCE_BASE_RESPAWN_MIN_SECONDS : BASE_RESPAWN_MIN_SECONDS;
  const maximum = resourceBase ? RESOURCE_BASE_RESPAWN_MAX_SECONDS : BASE_RESPAWN_MAX_SECONDS;
  const span = maximum - minimum;
  return minimum + ((hash >>> 0) % (span + 1));
}

export function scheduleEnemyBaseRespawn(state, base) {
  state.world.baseRespawns ??= [];
  if (state.world.baseRespawns.some(item => item.sourceBaseId === base.id)) return null;
  const respawn = {
    id: stableId('respawn', base.id, state.statistics.campsCaptured),
    sourceBaseId: base.id,
    baseType: base.type,
    sourceNodeId: base.nodeId,
    remainingSec: Math.round(deterministicRespawnSeconds(base.id, Boolean(ENEMY_BASE_DEFINITIONS[base.type]?.isResourceBase)) * respawnDelayMultiplierForEnemyBase(state, base)),
    attempts: 0,
    frontlineAnchorBaseId: base.frontlineAnchorBaseId ?? null,
    frontlineAnchorNodeId: base.frontlineAnchorNodeId ?? null,
    frontlineSlotIndex: Number.isInteger(base.frontlineSlotIndex) ? base.frontlineSlotIndex : null
  };
  state.world.baseRespawns.push(respawn);
  return respawn;
}

export function destroyEnemyBase(state, base, events = null, cause = {}) {
  if (!base?.alive || base.hp > 0) return false;
  base.hp = 0;
  base.alive = false;
  base.destroyed = true;
  base.destroyedAt = worldNow(state);
  state.statistics.campsCaptured = (state.statistics.campsCaptured ?? 0) + 1;
  const captureCount = state.statistics.campsCaptured;
  state.civilization.progress.campsCapturedByType[base.type] = (state.civilization.progress.campsCapturedByType[base.type] ?? 0) + 1;
  scheduleEnemyBaseRespawn(state, base);
  const anchorId = anchorIdForEnemyBaseRegion(state, base);
  applyRegionControlEvent(state, anchorId, ENEMY_BASE_DEFINITIONS[base.type]?.isResourceBase ? 0.018 : 0.035, { pressure: -0.055 });
  const definition = ENEMY_BASE_DEFINITIONS[base.type];
  const reward = applyCivilizationEfficiencyBonusToBundle(addBundleTo(definition?.reward ?? {}, earlyEnemyBaseCaptureBonus(captureCount)), state.civilization?.level ?? 0);
  const recoveryItem = createBaseRecoveryItem(state, base, reward);
  for (const enemy of state.combat.enemies) {
    if (enemy.sourceBaseId === base.id) enemy.sourceBaseDestroyed = true;
  }
  base.rewardAssigned = true;
  events?.emit('combat:enemy-base-destroyed', { baseId: base.id, base, cause, recoveryItem, reward });
  events?.emit('message', { key: 'enemyBase.destroyedLoot', params: { enemyBaseName: definition?.name ?? '敵拠点' }, text: `${definition?.name ?? '敵拠点'}を破壊しました。特殊回収物と資源備蓄が現地に残されています。` });
  return true;
}
