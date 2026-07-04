import { consumeBundle, missingBundle } from '../civilization/inventory-system.js';
import { repairCostForDefense } from '../civilization/repair-cost.js';
import { CIVILIZATION_ABILITY, ensureCivilizationAbilityState, hasCivilizationAbility, requireCivilizationAbility } from '../civilization/abilities.js';
import { activePlayerBases, ensurePlayerBaseState } from '../base/player-bases.js';
import { deploymentBases, ensureFieldBaseState, nearestOwnedBase, ownedBaseById } from '../base/field-bases.js';
import { distanceSquared, stableId, worldNow } from '../core/utilities.js';
import { activeFriendlyBarrierEdgeIds, findFriendlyRoadPath } from './routing-system.js';
import { damageEnemy, enemyPosition } from './enemy-system.js';
import { enemyUnitCount, splashDamageMultiplierForGroup } from './enemy-grouping.js';
import { destroyEnemyBase } from './enemy-base-system.js';
import { spawnEnemyBaseGuard } from './wave-system.js';
import { roadUnitPosition } from './road-unit-position.js';
import {
  FRIENDLY_RECOVERY_STATUS,
  beginFriendlyRecovery,
  recoveryPresentation,
  updateFriendlyRecovery
} from './friendly-recovery-system.js';
import {
  FRIENDLY_SQUAD_DEFINITIONS,
  friendlySquadDefinition,
  friendlySquadRuntimeDefinition,
  friendlySquadEnemyDamage,
  friendlySquadUnlocked,
  friendlySquadLevel,
  friendlySquadXpForNextLevel
} from './friendly-force-definitions.js';
import { defenseRuntimeDefinition } from './definitions.js';
import {
  RECOVERY_ITEM_STATUS,
  SQUAD_RECOVERY_COLLECTION_DURATION_SECONDS,
  deliverRecoveryItem,
  markRecoveryItemCarried,
  recoveryItemPoint,
  recoveryItemPresentation,
  releaseRecoveryItem,
  reserveRecoveryItem
} from '../exploration/recovery-system.js';

export { FRIENDLY_SQUAD_DEFINITIONS, FRIENDLY_SQUAD_TYPES } from './friendly-force-definitions.js';

export const FRIENDLY_SQUAD_STATUS = Object.freeze({
  OUTBOUND: 'OUTBOUND',
  ENGAGED: 'ENGAGED',
  ATTACKING_BASE: 'ATTACKING_BASE',
  COLLECTING_ITEM: 'COLLECTING_ITEM',
  HALTED: 'HALTED',
  RETREATING: 'RETREATING',
  WITHDRAWING: 'WITHDRAWING',
  RETURNING: 'RETURNING',
  STRANDED: 'STRANDED',
  RECOVERING: FRIENDLY_RECOVERY_STATUS.RECOVERING,
  READY: FRIENDLY_RECOVERY_STATUS.READY
});

export const FRIENDLY_ANNIHILATION_RECOVERY_SECONDS = Object.freeze({
  assault: 180,
  skirmisher: 240,
  retrieval: 180,
  siege: 420,
  heavy: 480,
  expedition: 540,
  engineer: 660,
  artillery: 720,
  command: 900
});

export const ROADSIDE_SPEED_BOOST_MULTIPLIER = 0.20;

const SKIRMISHER_AVOID_ENEMY_TYPES = new Set([
  'shield', 'heavy', 'siegeBreaker', 'sapper', 'bronzeShield', 'siegeCaptain', 'ironclad', 'heavySiege',
  'commander', 'ironSaboteur', 'bodyguard', 'steelGuard', 'demolitionEngineer', 'steelCaptain',
  'mechanicalSiege', 'armoredAgent', 'machineCommander', 'royalGuard', 'fortressBreaker', 'royalCommander'
]);

function skirmisherTargetRisk(enemy) {
  if (!enemy) return 0;
  const count = enemyUnitCount(enemy);
  const armored = SKIRMISHER_AVOID_ENEMY_TYPES.has(enemy.type) ? 1 : 0;
  const crowd = count >= 32 ? 3 : count >= 18 ? 2 : count >= 10 ? 1 : 0;
  return armored * 4 + crowd;
}

function shouldSkirmisherAutoWithdraw(squad, definition, enemy) {
  if (squad?.type !== 'skirmisher' || !enemy) return false;
  const maxHp = Math.max(1, Number(squad.maxHp) || Number(definition.hp) || 1);
  const hpRatio = Math.max(0, Number(squad.hp) || 0) / maxHp;
  if (hpRatio > 0.35) return false;
  return skirmisherTargetRisk(enemy) >= 2 || enemyUnitCount(enemy) >= 12;
}

export const FRIENDLY_SQUAD_MISSION = Object.freeze({ ATTACK: 'ATTACK', INTERCEPT: 'INTERCEPT', RECOVERY: 'RECOVERY' });

export const FRIENDLY_SQUAD_ORDER = Object.freeze({
  ADVANCE: 'ADVANCE',
  HOLD: 'HOLD',
  RETREAT: 'RETREAT',
  WITHDRAW: 'WITHDRAW',
  RETURN: 'RETURN'
});

const VALID_STATUS = new Set(Object.values(FRIENDLY_SQUAD_STATUS));
const VALID_ORDER = new Set(Object.values(FRIENDLY_SQUAD_ORDER));

const FRIENDLY_GLOBAL_COMMAND_LIMITS = Object.freeze([6, 10, 14, 18, 22, 28, 34, 40]);
const FRIENDLY_MAJOR_BASE_CAPACITY = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9]);
const FRIENDLY_COORDINATED_LIMITS = Object.freeze([3, 3, 4, 5, 6, 7, 8, 8]);

export const FRIENDLY_STRANDED_RETRY_INITIAL_SECONDS = 5;
export const FRIENDLY_STRANDED_RETRY_MAX_SECONDS = 60;
export const FRIENDLY_STRANDED_NOTIFY_AFTER_SECONDS = 60;
export const FRIENDLY_STRANDED_FORCE_RECOVERY_AFTER_SECONDS = 300;
export const FRIENDLY_STRANDED_FORCE_RECOVERY_SCALE = 0.5;


function civilizationTableValue(table, state) {
  const index = Math.max(0, Math.min(table.length - 1, Math.floor(Number(state.civilization?.level) || 0)));
  return table[index];
}

export function friendlyGlobalCommandLimit(state) { return civilizationTableValue(FRIENDLY_GLOBAL_COMMAND_LIMITS, state); }
export function friendlyCoordinatedDeploymentLimit(state) { return civilizationTableValue(FRIENDLY_COORDINATED_LIMITS, state); }
export function friendlyGlobalCommandStatus(state) {
  const assigned = (state.combat?.friendlySquads ?? []).filter(squad => squad.hp > 0).length;
  const capacity = friendlyGlobalCommandLimit(state);
  return { capacity, assigned, available: Math.max(0, capacity - assigned) };
}

function statusForOrder(order) {
  if (order === FRIENDLY_SQUAD_ORDER.HOLD) return FRIENDLY_SQUAD_STATUS.HALTED;
  if (order === FRIENDLY_SQUAD_ORDER.RETREAT) return FRIENDLY_SQUAD_STATUS.RETREATING;
  if (order === FRIENDLY_SQUAD_ORDER.WITHDRAW) return FRIENDLY_SQUAD_STATUS.WITHDRAWING;
  if (order === FRIENDLY_SQUAD_ORDER.RETURN) return FRIENDLY_SQUAD_STATUS.RETURNING;
  return FRIENDLY_SQUAD_STATUS.OUTBOUND;
}

function normalizePath(path) {
  if (!path || !Array.isArray(path.nodeIds) || !Array.isArray(path.edgeIds)) return null;
  return {
    nodeIds: [...path.nodeIds],
    edgeIds: [...path.edgeIds],
    cost: Math.max(0, Number(path.cost) || 0),
    targetId: path.targetId ?? path.nodeIds[path.nodeIds.length - 1] ?? null
  };
}

function validatedDeploymentPath(state, path, startNodeId, targetNodeId) {
  const normalized = normalizePath(path);
  const graph = state.world?.roadGraph;
  if (!normalized || !graph?.nodeById?.has(startNodeId) || !graph.nodeById.has(targetNodeId)) return null;
  if (normalized.nodeIds.length !== normalized.edgeIds.length + 1) return null;
  if (normalized.nodeIds[0] !== startNodeId || normalized.nodeIds.at(-1) !== targetNodeId) return null;
  const blocked = activeFriendlyBarrierEdgeIds(state);
  let physicalDistance = 0;
  for (let index = 0; index < normalized.edgeIds.length; index += 1) {
    const edge = graph.edgeById.get(normalized.edgeIds[index]);
    const from = normalized.nodeIds[index];
    const to = normalized.nodeIds[index + 1];
    if (!edge || edge.routingDisabled || blocked.has(edge.id)) return null;
    if (!((edge.a === from && edge.b === to) || (edge.a === to && edge.b === from))) return null;
    physicalDistance += Math.max(0, Number(edge.length) || 0);
  }
  return { ...normalized, cost: physicalDistance, targetId: targetNodeId };
}

function routePhysicalDistance(state, path) {
  let total = 0;
  for (const edgeId of path?.edgeIds ?? []) total += Math.max(0, Number(state.world?.roadGraph?.edgeById?.get(edgeId)?.length) || 0);
  return total;
}

export function ensureFriendlyForceState(state) {
  ensurePlayerBaseState(state);
  ensureFieldBaseState(state);
  state.combat.friendlySquads = Array.isArray(state.combat.friendlySquads) ? state.combat.friendlySquads : [];
  for (const squad of state.combat.friendlySquads) {
    const definition = friendlySquadRuntimeDefinition(state, squad.type, squad);
    squad.type = definition.type;
    squad.unitLevel = friendlySquadLevel(squad);
    squad.unitXp = Math.max(0, Number(squad.unitXp) || 0);
    const previousMaxHp = Math.max(1, Number(squad.maxHp) || definition.hp);
    const previousHp = Math.max(0, Math.min(previousMaxHp, Number(squad.hp ?? previousMaxHp) || 0));
    squad.maxHp = Math.max(1, definition.hp);
    squad.hp = Math.max(0, Math.min(squad.maxHp, previousMaxHp === squad.maxHp ? previousHp : previousHp / previousMaxHp * squad.maxHp));
    squad.status = VALID_STATUS.has(squad.status) ? squad.status : FRIENDLY_SQUAD_STATUS.OUTBOUND;
    squad.order = VALID_ORDER.has(squad.order)
      ? squad.order
      : squad.status === FRIENDLY_SQUAD_STATUS.RETURNING
        ? FRIENDLY_SQUAD_ORDER.RETURN
        : FRIENDLY_SQUAD_ORDER.ADVANCE;
    squad.missionType = squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY || definition.missionKind === 'RECOVERY'
      ? FRIENDLY_SQUAD_MISSION.RECOVERY
      : squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT || squad.targetEnemyId
        ? FRIENDLY_SQUAD_MISSION.INTERCEPT
        : FRIENDLY_SQUAD_MISSION.ATTACK;
    squad.missionTargetBaseId ??= squad.targetBaseId ?? null;
    squad.targetEnemyId ??= null;
    squad.targetRecoveryItemId ??= null;
    squad.recoveryCollectionProgressSec = squad.recoveryCollectionProgressSec == null
      ? null
      : Math.max(0, Math.min(SQUAD_RECOVERY_COLLECTION_DURATION_SECONDS, Number(squad.recoveryCollectionProgressSec) || 0));
    squad.commandDestinationNodeId ??= squad.path?.targetId ?? null;
    squad.heldOrder = VALID_ORDER.has(squad.heldOrder) ? squad.heldOrder : null;
    squad.heldDestinationNodeId ??= null;
    squad.pathIndex = Math.max(0, Number(squad.pathIndex) || 0);
    squad.edgeProgress = Math.max(0, Number(squad.edgeProgress) || 0);
    squad.combatCooldown = Math.max(0, Number(squad.combatCooldown) || 0);
    squad.departDelay = Math.max(0, Number(squad.departDelay) || 0);
    squad.formationId ??= null;
    squad.formationTargetId ??= null;
    squad.formationSpeed = squad.formationSpeed == null ? null : Math.max(0.1, Number(squad.formationSpeed) || 0.1);
    squad.formationSize = squad.formationSize == null ? null : Math.max(1, Math.floor(Number(squad.formationSize) || 1));
    squad.engagedEnemyId ??= null;
    squad.reroutePending = Boolean(squad.reroutePending);
    squad.path = normalizePath(squad.path);
    squad.travelHistoryNodeIds = Array.isArray(squad.travelHistoryNodeIds) && squad.travelHistoryNodeIds.length
      ? [...squad.travelHistoryNodeIds]
      : [squad.nodeId].filter(Boolean);
    squad.recoveryBaseId ??= null;
    squad.recoveryStartedAt = Number(squad.recoveryStartedAt) || null;
    squad.reorganizationRemaining = Math.max(0, Number(squad.reorganizationRemaining) || 0);
    delete squad.recoveryTargetHp;
    delete squad.recoveryFacilityType;
    delete squad.recoveryFacilityId;
    squad.readyAt = Number(squad.readyAt) || null;
    squad.annihilatedRecovery = Boolean(squad.annihilatedRecovery);
    squad.annihilatedAt = Number(squad.annihilatedAt) || null;
    squad.roadsideSpeedBoostUntil = Math.max(0, Number(squad.roadsideSpeedBoostUntil) || 0);
    squad.roadsideSpeedBoostMultiplier = Math.max(0, Number(squad.roadsideSpeedBoostMultiplier) || 0);
    squad.queuedDispatch = squad.queuedDispatch && typeof squad.queuedDispatch === 'object' ? {
      targetId: String(squad.queuedDispatch.targetId ?? ''),
      targetKind: String(squad.queuedDispatch.targetKind ?? 'enemyBase'),
      squadType: FRIENDLY_SQUAD_DEFINITIONS[squad.queuedDispatch.squadType]?.type ?? squad.type,
      routeOverride: normalizePath(squad.queuedDispatch.routeOverride),
      queuedAt: Math.max(0, Number(squad.queuedDispatch.queuedAt) || 0)
    } : null;
    squad.autoRepairPatrol = Boolean(squad.autoRepairPatrol);
    squad.autoRepairCooldown = Math.max(0, Number(squad.autoRepairCooldown) || 0);
  }
  return state.combat.friendlySquads;
}

export function friendlySquadPosition(state, squad) {
  return roadUnitPosition(state, squad);
}

export function friendlySquadById(state, squadId) {
  return (state.combat?.friendlySquads ?? []).find(squad => squad.id === squadId && squad.hp > 0) ?? null;
}

function squadsFromBase(state, baseId) {
  return (state.combat?.friendlySquads ?? []).filter(squad => squad.originBaseId === baseId && squad.hp > 0);
}

function fieldBarracksCapacityBonus(state, baseId) {
  if (!baseId) return 0;
  const facility = (state.combat?.defenses ?? []).find(defense =>
    defense.type === 'fieldBarracks'
    && defense.baseId === baseId
    && defense.hp > 0
    && (defense.disabledTimer ?? 0) <= 0
  );
  if (!facility) return 0;
  return Math.max(0, Math.floor(Number(defenseRuntimeDefinition(facility).squadCapacityBonus) || 0));
}

export function friendlySquadCapacityForBase(state, baseOrId) {
  const base = typeof baseOrId === 'string' ? ownedBaseById(state, baseOrId, { includeDestroyed: true }) : baseOrId;
  if (!base) return 0;
  const civilizationLevel = Math.max(0, Math.floor(Number(state.civilization?.level) || 0));
  if (base.kind === 'FIELD') {
    return 2 + Math.floor(civilizationLevel / 2) + fieldBarracksCapacityBonus(state, base.id);
  }
  return FRIENDLY_MAJOR_BASE_CAPACITY[Math.min(FRIENDLY_MAJOR_BASE_CAPACITY.length - 1, civilizationLevel)];
}

export function friendlySquadCapacityStatus(state, baseOrId) {
  const base = typeof baseOrId === 'string' ? ownedBaseById(state, baseOrId, { includeDestroyed: true }) : baseOrId;
  if (!base) return { capacity: 0, assigned: 0, active: 0, recovering: 0, ready: 0, available: 0 };
  const squads = squadsFromBase(state, base.id);
  const recovering = squads.filter(squad => squad.status === FRIENDLY_SQUAD_STATUS.RECOVERING).length;
  const ready = squads.filter(squad => squad.status === FRIENDLY_SQUAD_STATUS.READY).length;
  const active = squads.length - recovering - ready;
  const capacity = friendlySquadCapacityForBase(state, base);
  return { capacity, assigned: squads.length, active, recovering, ready, available: Math.max(0, capacity - squads.length) };
}

function garrisonSquadsFromBase(state, baseId) {
  return squadsFromBase(state, baseId).filter(squad => [FRIENDLY_SQUAD_STATUS.READY, FRIENDLY_SQUAD_STATUS.RECOVERING].includes(squad.status));
}

function planningReservationCount(planning, baseId) {
  return Math.max(0, Number(planning?.additionalSquadsByBase?.get(baseId)) || 0);
}

function planningSquadReserved(planning, squadId) {
  return Boolean(squadId && planning?.reservedSquadIds?.has(squadId));
}

function planningTypeReservationCount(planning, baseId, squadType) {
  return Math.max(0, Number(planning?.squadTypesByBase?.get(`${baseId}:${squadType}`)) || 0);
}

function reservePlanningSlot(planning, preview) {
  if (!planning || !preview?.origin) return;
  if (preview.garrison?.id) planning.reservedSquadIds.add(preview.garrison.id);
  else {
    planning.additionalSquadsByBase.set(
      preview.origin.id,
      planningReservationCount(planning, preview.origin.id) + 1
    );
  }
  if (!preview.reuseReadySquad) {
    const key = `${preview.origin.id}:${preview.definition.type}`;
    planning.squadTypesByBase.set(key, planningTypeReservationCount(planning, preview.origin.id, preview.definition.type) + 1);
  }
}

export function enemyPursuitNodeId(state, enemy) {
  const graph = state.world?.roadGraph;
  if (!graph || !enemy) return null;
  const pathNodeIds = Array.isArray(enemy.path?.nodeIds) ? enemy.path.nodeIds : [];
  const nextNodeId = pathNodeIds.length
    ? pathNodeIds[Math.min(Math.max(0, Number(enemy.pathIndex) || 0) + 1, pathNodeIds.length - 1)]
    : null;
  if (nextNodeId && graph.nodeById.has(nextNodeId)) return nextNodeId;
  return graph.nodeById.has(enemy.nodeId) ? enemy.nodeId : null;
}

function deploymentTarget(state, definition, targetId, targetKind = 'enemyBase') {
  if (definition.missionKind === 'RECOVERY') {
    if (state.world.recoveryCollection?.itemId === targetId) return null;
    const item = (state.world?.recoveryItems ?? []).find(value => value.id === targetId && value.status === RECOVERY_ITEM_STATUS.AVAILABLE) ?? null;
    return item ? { target: item, nodeId: item.nodeId, missionType: FRIENDLY_SQUAD_MISSION.RECOVERY, targetKind: 'recoveryItem' } : null;
  }
  if (targetKind === 'enemy') {
    const enemy = state.combat.enemies.find(value => value.id === targetId && value.hp > 0 && value.departDelay <= 0) ?? null;
    const nodeId = enemyPursuitNodeId(state, enemy);
    return enemy && nodeId ? { target: enemy, nodeId, missionType: FRIENDLY_SQUAD_MISSION.INTERCEPT, targetKind: 'enemy' } : null;
  }
  const base = state.world.enemyBases.find(value => value.id === targetId && value.alive && value.hp > 0) ?? null;
  return base ? { target: base, nodeId: base.nodeId, missionType: FRIENDLY_SQUAD_MISSION.ATTACK, targetKind: 'enemyBase' } : null;
}

function unavailableTargetReason(definition, targetKind) {
  if (definition.missionKind === 'RECOVERY') return { reasonKey: 'reason.deployment.unavailableRecoveryTarget', reason: '回収可能な特殊アイテムではありません。' };
  if (targetKind === 'enemy') return { reasonKey: 'reason.deployment.unavailableEnemyTarget', reason: '迎撃可能な敵部隊ではありません。' };
  return { reasonKey: 'reason.deployment.enemyBaseUnavailable', reason: '攻撃可能な敵拠点ではありません。' };
}

function unreachableTargetReason(definition, targetKind) {
  if (definition.missionKind === 'RECOVERY') return { reasonKey: 'reason.deployment.unreachableRecoveryTarget', reason: '回収地点へ到達できる道路経路がありません。' };
  if (targetKind === 'enemy') return { reasonKey: 'reason.deployment.unreachableEnemyTarget', reason: '敵部隊の進路へ到達できる道路経路がありません。' };
  return { reasonKey: 'reason.deployment.unreachableEnemyBase', reason: '敵拠点へ到達できる道路経路がありません。' };
}

export function previewFriendlyDeployment(state, squadType, originBaseId, targetId, planning = null, targetKind = 'enemyBase', routeOverride = null) {
  const baseDefinition = FRIENDLY_SQUAD_DEFINITIONS[squadType];
  if (!baseDefinition) return { ok: false, reasonKey: 'reason.squad.unknownType', reason: '選択した部隊種類は存在しません。' };
  const definition = friendlySquadRuntimeDefinition(state, squadType);
  if (!friendlySquadUnlocked(state, squadType)) return { ok: false, reasonKey: 'reason.squad.unlockLevel', reasonParams: { squadName: definition.name, level: definition.unlockLevel }, reason: `${definition.name}は文明Lv.${definition.unlockLevel}で解禁されます。`, definition };
  const origin = ownedBaseById(state, originBaseId);
  if (!origin || origin.status !== 'ESTABLISHED' || origin.hp <= 0) return { ok: false, reasonKey: 'reason.deployment.originUnavailable', reason: '出撃可能な拠点ではありません。', definition };
  if (!deploymentBases(state, squadType).some(base => base.id === origin.id)) return { ok: false, reasonKey: 'reason.deployment.originCannotDeploySquad', reasonParams: { squadName: definition.name }, reason: `この拠点から${definition.name}は派兵できません。`, definition };
  const resolved = deploymentTarget(state, definition, targetId, targetKind);
  if (!resolved) return { ok: false, ...unavailableTargetReason(definition, targetKind), definition };
  const overriddenPath = routeOverride ? validatedDeploymentPath(state, routeOverride, origin.nodeId, resolved.nodeId) : null;
  if (routeOverride && !overriddenPath) return { ok: false, reasonKey: 'reason.deployment.routeInvalidated', reason: '選択した派兵経路は道路更新または防壁によって利用できなくなりました。経路を選び直してください。', definition, origin, target: resolved.target, missionType: resolved.missionType };
  const path = overriddenPath ?? findFriendlyRoadPath(state, origin.nodeId, resolved.nodeId);
  if (!path) return { ok: false, ...unreachableTargetReason(definition, targetKind), definition };

  const routeDistance = routePhysicalDistance(state, path);
  const assignedSquads = squadsFromBase(state, origin.id);
  const capacity = friendlySquadCapacityForBase(state, origin);
  const plannedAdditional = planningReservationCount(planning, origin.id);
  const availableGarrisons = garrisonSquadsFromBase(state, origin.id)
    .filter(squad => !planningSquadReserved(planning, squad.id));
  const reusableGarrison = availableGarrisons.find(squad => squad.status === FRIENDLY_SQUAD_STATUS.READY && squad.type === squadType) ?? null;
  const canCreateNewSquad = assignedSquads.length + plannedAdditional < capacity;
  const replaceableGarrison = !reusableGarrison && !canCreateNewSquad
    ? availableGarrisons.find(squad => squad.status === FRIENDLY_SQUAD_STATUS.READY && squad.type !== squadType) ?? null
    : null;
  const plannedGlobal = planning ? [...planning.additionalSquadsByBase.values()].reduce((total, value) => total + value, 0) : 0;
  const globalStatus = friendlyGlobalCommandStatus(state);
  if (!reusableGarrison && !replaceableGarrison && globalStatus.assigned + plannedGlobal >= globalStatus.capacity) {
    return { ok: false, reasonKey: 'reason.deployment.globalCommandLimit', reasonParams: { assigned: globalStatus.assigned + plannedGlobal, capacity: globalStatus.capacity }, reason: `全体指揮上限に達しています（${globalStatus.assigned + plannedGlobal}/${globalStatus.capacity}）。既存部隊を帰還・再編成してから派兵してください。`, definition, origin, target: resolved.target, missionType: resolved.missionType, path, routeDistance };
  }
  const plannedTypeCount = planningTypeReservationCount(planning, origin.id, squadType);
  if (definition.maxPerBase && !reusableGarrison && assignedSquads.filter(squad => squad.type === squadType).length + plannedTypeCount >= definition.maxPerBase) {
    return { ok: false, reasonKey: 'reason.deployment.maxPerBase', reasonParams: { squadName: definition.name, limit: definition.maxPerBase }, reason: `${definition.name}は主要拠点ごとに${definition.maxPerBase}隊までです。`, definition, origin, target: resolved.target, missionType: resolved.missionType, path, routeDistance };
  }
  if (!reusableGarrison && !canCreateNewSquad && !replaceableGarrison) {
    const capacityStatus = friendlySquadCapacityStatus(state, origin);
    const recoveryNote = capacityStatus.recovering ? `・回復中 ${capacityStatus.recovering}` : '';
    return {
      ok: false,
      reasonKey: 'reason.deployment.baseSquadSlotsFull',
      reasonParams: { assigned: capacityStatus.assigned + plannedAdditional, capacity, recovering: capacityStatus.recovering ?? 0 },
      reason: `この拠点の部隊枠が満員です（${capacityStatus.assigned + plannedAdditional}/${capacity}${recoveryNote}）。文明レベルを上げるか、待機部隊を再編成してください。`,
      definition,
      origin,
      target: resolved.target,
      missionType: resolved.missionType,
      path,
      routeDistance,
      capacity,
      assignedSquads: capacityStatus.assigned,
      plannedAdditional
    };
  }
  const garrison = reusableGarrison ?? replaceableGarrison;
  const reuseReadySquad = Boolean(reusableGarrison);
  const replaceReadySquad = Boolean(replaceableGarrison);
  const deploymentCost = reuseReadySquad ? {} : definition.cost;
  const missing = missingBundle(state, deploymentCost);
  return {
    ok: Object.keys(missing).length === 0,
    reasonKey: Object.keys(missing).length ? 'reason.deployment.resourceShortage' : null,
    reason: Object.keys(missing).length ? '派兵に必要な資源が不足しています。' : null,
    origin,
    target: resolved.target,
    missionType: resolved.missionType,
    targetKind: resolved.targetKind,
    path,
    routeDistance,
    cost: { ...deploymentCost },
    missing,
    definition,
    garrison,
    reuseReadySquad,
    replaceReadySquad,
    capacity,
    assignedSquads: assignedSquads.length,
    availableSlots: Math.max(0, capacity - assignedSquads.length - plannedAdditional)
  };
}

function instantiateFriendlySquad(state, preview, squadType, originBaseId, targetId, events = null, formation = null) {
  const definition = preview.definition;
  const worldTime = worldNow(state);
  const squadId = preview.reuseReadySquad && preview.garrison
    ? preview.garrison.id
    : stableId('friendly_squad', definition.type, originBaseId, targetId, worldTime, state.combat.friendlySquads.length);
  if (preview.replaceReadySquad && preview.garrison) {
    state.combat.friendlySquads = state.combat.friendlySquads.filter(item => item.id !== preview.garrison.id);
  }
  const squad = preview.reuseReadySquad && preview.garrison ? preview.garrison : {
    id: squadId,
    type: definition.type, hp: definition.hp, maxHp: definition.hp, members: definition.members, originBaseId, deployedAt: worldTime, unitLevel: 1, unitXp: 0
  };
  Object.assign(squad, {
    type: definition.type,
    members: definition.members,
    missionType: preview.missionType,
    originBaseId,
    targetBaseId: preview.missionType === FRIENDLY_SQUAD_MISSION.ATTACK ? targetId : null,
    missionTargetBaseId: preview.missionType === FRIENDLY_SQUAD_MISSION.ATTACK ? targetId : null,
    targetEnemyId: preview.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT ? targetId : null,
    targetRecoveryItemId: preview.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY ? targetId : null,
    recoveryCollectionProgressSec: null,
    nodeId: preview.origin.nodeId,
    path: normalizePath(preview.path), pathIndex: 0, edgeId: preview.path.edgeIds[0] ?? null, edgeProgress: 0,
    status: FRIENDLY_SQUAD_STATUS.OUTBOUND, order: FRIENDLY_SQUAD_ORDER.ADVANCE,
    commandDestinationNodeId: preview.path.targetId, travelHistoryNodeIds: [preview.origin.nodeId],
    engagedEnemyId: null, combatCooldown: 0, departDelay: Math.max(0, Number(formation?.departDelay) || 0),
    formationId: formation?.id ?? null,
    formationTargetId: formation?.targetId ?? null,
    formationSpeed: formation?.speed ?? null,
    formationSize: formation?.size ?? null,
    recoveryBaseId: null, recoveryStartedAt: null, reorganizationRemaining: 0,
    readyAt: null, deployedAt: worldTime, unitLevel: friendlySquadLevel(squad), unitXp: Math.max(0, Number(squad.unitXp) || 0)
  });
  if (!preview.reuseReadySquad) state.combat.friendlySquads.push(squad);
  events?.emit('friendly:squad-deployed', { squad, origin: preview.origin, target: preview.target, cost: preview.cost, redeployed: preview.reuseReadySquad, formationId: formation?.id ?? null });
  const targetLabel = preview.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY
    ? `${recoveryItemPresentation(preview.target).name}の回収へ`
    : preview.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT
      ? '指定敵部隊の迎撃へ'
      : '';
  events?.emit('message', { key: preview.reuseReadySquad ? 'friendly.notice.squadRedeployed' : 'friendly.notice.squadDeployed', params: { originName: preview.origin.name, squadName: definition.name, targetLabel: targetLabel || '', fallbackLabel: targetLabel || '再' }, text: preview.reuseReadySquad ? `${preview.origin.name}から${definition.name}が${targetLabel || '再'}出撃しました。` : `${preview.origin.name}から${definition.name}が${targetLabel || ''}出撃しました。` });
  return { squad, cost: preview.cost, routeDistance: preview.routeDistance, redeployed: preview.reuseReadySquad, replaced: preview.replaceReadySquad };
}

export function dispatchFriendlySquad(state, squadType, originBaseId, targetId, events = null, targetKind = 'enemyBase', routeOverride = null) {
  const preview = previewFriendlyDeployment(state, squadType, originBaseId, targetId, null, targetKind, routeOverride);
  if (!preview.ok) return preview;

  let reservation = null;
  const squadId = preview.reuseReadySquad && preview.garrison
    ? preview.garrison.id
    : stableId('friendly_squad', preview.definition.type, originBaseId, targetId, worldNow(state), state.combat.friendlySquads.length);
  if (preview.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY) {
    reservation = reserveRecoveryItem(state, targetId, squadId);
    if (!reservation.ok) return reservation;
  }

  if (!consumeBundle(state, preview.cost)) {
    if (reservation) releaseRecoveryItem(state, targetId, squadId);
    return { ok: false, reasonKey: 'reason.deployment.shortageAtCommit', reason: '派兵確定時に資源が不足しました。' };
  }
  const result = instantiateFriendlySquad(state, preview, squadType, originBaseId, targetId, events);
  return { ok: true, ...result };
}

function addCost(total, bundle) {
  for (const [resource, amount] of Object.entries(bundle ?? {})) total[resource] = (total[resource] ?? 0) + amount;
  return total;
}


export const COORDINATED_DEPLOYMENT_TIMING = Object.freeze({
  LEAD: 'LEAD',
  SYNCHRONIZED: 'SYNCHRONIZED',
  MANUAL: 'MANUAL'
});

const FORMATION_ROLE_ORDER = Object.freeze({
  skirmisher: 0,
  assault: 1,
  command: 2,
  heavy: 3,
  expedition: 4,
  siege: 5,
  engineer: 6,
  artillery: 7
});

const LEAD_DEPARTURE_SECONDS = Object.freeze({
  skirmisher: 0,
  assault: 10,
  command: 12,
  heavy: 14,
  expedition: 16,
  siege: 24,
  engineer: 28,
  artillery: 30
});

function normalizedCoordinatedOptions(options = null) {
  const timingMode = Object.values(COORDINATED_DEPLOYMENT_TIMING).includes(options?.timingMode)
    ? options.timingMode
    : COORDINATED_DEPLOYMENT_TIMING.LEAD;
  const manualDelays = Object.fromEntries(Object.entries(options?.manualDelays ?? {})
    .map(([type, value]) => [type, Math.max(0, Math.min(180, Math.floor(Number(value) || 0)))]));
  return { timingMode, manualDelays, routeOverride: normalizePath(options?.routeOverride) };
}

function formationRoleForType(type) {
  if (type === 'skirmisher') return '先導';
  if (type === 'assault') return '本隊';
  if (type === 'siege') return '攻城';
  if (type === 'heavy') return '護衛';
  if (type === 'engineer') return '後方支援';
  if (type === 'artillery') return '後方火力';
  if (type === 'command') return '指揮';
  if (type === 'expedition') return '前線支援';
  return '本隊';
}

function applyCoordinatedTiming(assignments, options) {
  const normalized = normalizedCoordinatedOptions(options);
  const byTypeIndex = new Map();
  if (normalized.timingMode === COORDINATED_DEPLOYMENT_TIMING.SYNCHRONIZED) {
    const estimatedArrivalSeconds = Math.max(...assignments.map(assignment => {
      const naturalSpeed = Math.max(0.1, Number(assignment.definition.speed) || 0.1);
      return Math.max(0, Number(assignment.routeDistance) || 0) / naturalSpeed;
    }));
    for (const assignment of assignments) {
      const naturalSpeed = Math.max(0.1, Number(assignment.definition.speed) || 0.1);
      assignment.synchronizedSpeed = naturalSpeed;
      assignment.travelSeconds = Math.max(0, Number(assignment.routeDistance) || 0) / naturalSpeed;
      assignment.departDelay = Math.max(0, estimatedArrivalSeconds - assignment.travelSeconds);
      assignment.formationRole = formationRoleForType(assignment.squadType);
    }
    return { timingMode: normalized.timingMode, estimatedArrivalSeconds };
  }
  let estimatedArrivalSeconds = 0;
  const ordered = [...assignments].sort((left, right) =>
    (FORMATION_ROLE_ORDER[left.squadType] ?? 50) - (FORMATION_ROLE_ORDER[right.squadType] ?? 50)
    || left.requestIndex - right.requestIndex
  );
  for (const assignment of ordered) {
    const sameTypeIndex = byTypeIndex.get(assignment.squadType) ?? 0;
    byTypeIndex.set(assignment.squadType, sameTypeIndex + 1);
    const baseDelay = normalized.timingMode === COORDINATED_DEPLOYMENT_TIMING.MANUAL
      ? normalized.manualDelays[assignment.squadType] ?? 0
      : LEAD_DEPARTURE_SECONDS[assignment.squadType] ?? Math.min(30, (FORMATION_ROLE_ORDER[assignment.squadType] ?? 3) * 5);
    assignment.departDelay = Math.max(0, Number(baseDelay) || 0) + sameTypeIndex * 3;
    assignment.synchronizedSpeed = Math.max(0.1, Number(assignment.definition.speed) || 0.1);
    assignment.travelSeconds = Math.max(0, Number(assignment.routeDistance) || 0) / assignment.synchronizedSpeed;
    assignment.formationRole = formationRoleForType(assignment.squadType);
    estimatedArrivalSeconds = Math.max(estimatedArrivalSeconds, assignment.departDelay + assignment.travelSeconds);
  }
  return { timingMode: normalized.timingMode, estimatedArrivalSeconds };
}

function coordinatedTimingLabel(mode) {
  if (mode === COORDINATED_DEPLOYMENT_TIMING.SYNCHRONIZED) return '同時到着';
  if (mode === COORDINATED_DEPLOYMENT_TIMING.MANUAL) return '手動遅延';
  return '先導';
}

function coordinatedOriginBaseAllowed(state, base) {
  if (base?.kind !== 'FIELD') return true;
  return hasCivilizationAbility(state, CIVILIZATION_ABILITY.FIELD_COORDINATED_DISPATCH);
}

function commonDeploymentBaseCandidates(state, requested) {
  const baseById = new Map();
  for (const item of requested) {
    for (const base of deploymentBases(state, item.type).filter(candidate => coordinatedOriginBaseAllowed(state, candidate))) {
      baseById.set(base.id, base);
    }
  }
  return [...baseById.values()].filter(base => requested.every(item => deploymentBases(state, item.type).some(candidate => candidate.id === base.id && coordinatedOriginBaseAllowed(state, candidate))));
}

function previewCoordinatedFromOrigin(state, targetId, requested, origin, sharedRoute) {
  const planning = {
    additionalSquadsByBase: new Map(),
    squadTypesByBase: new Map(),
    reservedSquadIds: new Set()
  };
  const assignments = [];
  for (const item of requested) {
    const preview = previewFriendlyDeployment(state, item.type, origin.id, targetId, planning, 'enemyBase', sharedRoute);
    if (!preview.origin || !preview.path) return { ok: false, reasonKey: preview.reasonKey ?? 'reason.deployment.commonRouteUnavailableForSquad', reasonParams: preview.reasonParams ?? { squadName: item.definition.name }, reason: preview.reason ?? `${item.definition.name}の共通経路を利用できません。`, assignments };
    if (!preview.ok && Object.keys(preview.missing ?? {}).length === 0) return { ok: false, reasonKey: preview.reasonKey ?? 'reason.deployment.squadCannotDeploy', reasonParams: preview.reasonParams ?? { squadName: item.definition.name }, reason: preview.reason ?? `${item.definition.name}を出撃できません。`, assignments };
    reservePlanningSlot(planning, preview);
    assignments.push({ ...preview, squadType: item.type, requestIndex: item.index });
  }
  return { ok: true, assignments };
}

export function previewCoordinatedDeployment(state, targetId, squadTypes, options = null) {
  const ability = requireCivilizationAbility(state, CIVILIZATION_ABILITY.COORDINATED_DISPATCH);
  if (!ability.ok) return { ...ability, assignments: [], squadTypes: [] };
  const normalizedOptions = normalizedCoordinatedOptions(options);
  const requested = (Array.isArray(squadTypes) ? squadTypes : [])
    .filter(type => FRIENDLY_SQUAD_DEFINITIONS[type]?.missionKind !== 'RECOVERY')
    .slice(0, friendlyCoordinatedDeploymentLimit(state))
    .map((type, index) => ({ type, index, definition: FRIENDLY_SQUAD_DEFINITIONS[type] ? friendlySquadRuntimeDefinition(state, type) : null }))
    .filter(item => item.definition);
  if (requested.length < 2) return { ok: false, reasonKey: 'reason.deployment.coordinatedNeedsTwo', reason: '連携出撃には2部隊以上を選択してください。', assignments: [], squadTypes: requested.map(item => item.type) };
  for (const item of requested) {
    if (!friendlySquadUnlocked(state, item.type)) return { ok: false, reasonKey: 'reason.squad.unlockLevel', reasonParams: { squadName: item.definition.name, level: item.definition.unlockLevel }, reason: `${item.definition.name}は文明Lv.${item.definition.unlockLevel}で解禁されます。`, assignments: [] };
  }
  const target = state.world.enemyBases.find(base => base.id === targetId && base.alive && base.hp > 0) ?? null;
  if (!target) return { ok: false, reasonKey: 'reason.deployment.enemyBaseUnavailable', reason: '攻撃可能な敵拠点ではありません。', assignments: [] };

  const candidates = [];
  for (const origin of commonDeploymentBaseCandidates(state, requested)) {
    const seedPreview = previewFriendlyDeployment(state, requested[0].type, origin.id, targetId, null, 'enemyBase', normalizedOptions.routeOverride);
    if (!seedPreview.path) continue;
    const candidate = previewCoordinatedFromOrigin(state, targetId, requested, origin, seedPreview.path);
    if (!candidate.ok) {
      candidates.push({ ...candidate, origin, routeDistance: seedPreview.routeDistance ?? Infinity, path: seedPreview.path });
      continue;
    }
    const routeDistance = routePhysicalDistance(state, seedPreview.path);
    candidates.push({ ...candidate, origin, routeDistance, path: seedPreview.path });
  }
  const viable = candidates
    .filter(candidate => candidate.ok)
    .sort((left, right) => (left.routeDistance ?? Infinity) - (right.routeDistance ?? Infinity)
      || String(left.origin?.id ?? '').localeCompare(String(right.origin?.id ?? '')));
  const selected = viable[0] ?? null;
  if (!selected) {
    const failure = candidates.find(candidate => candidate.reason || candidate.reasonKey) ?? null;
    return { ok: false, reasonKey: failure?.reasonKey ?? 'reason.deployment.coordinatedCommonRouteUnavailable', reasonParams: failure?.reasonParams ?? {}, reason: failure?.reason ?? '連携部隊が同じ拠点から共通ルートで出撃できません。部隊枠・解禁Lv・出撃元を確認してください。', assignments: [], target };
  }

  const assignments = [...selected.assignments].sort((left, right) => left.requestIndex - right.requestIndex);
  const cost = assignments.reduce((total, assignment) => addCost(total, assignment.cost), {});
  const missing = missingBundle(state, cost);
  const slowestSpeed = Math.min(...assignments.map(assignment => Math.max(0.1, Number(assignment.definition.speed) || 0.1)));
  const fastestSpeed = Math.max(...assignments.map(assignment => Math.max(0.1, Number(assignment.definition.speed) || 0.1)));
  const maximumDistance = Math.max(...assignments.map(assignment => Math.max(0, Number(assignment.routeDistance) || 0)));
  const timing = applyCoordinatedTiming(assignments, normalizedOptions);
  return {
    ok: Object.keys(missing).length === 0,
    reasonKey: Object.keys(missing).length ? 'reason.deployment.coordinatedResourceShortage' : null,
    reason: Object.keys(missing).length ? '連携出撃に必要な合計資源が不足しています。' : null,
    target,
    origin: selected.origin,
    commonRoute: normalizePath(selected.path),
    assignments,
    cost,
    missing,
    synchronizedSpeed: null,
    slowestSpeed,
    fastestSpeed,
    maximumRouteDistance: maximumDistance,
    estimatedArrivalSeconds: timing.estimatedArrivalSeconds,
    timingMode: timing.timingMode,
    timingLabel: coordinatedTimingLabel(timing.timingMode),
    commonRouteDistance: selected.routeDistance
  };
}

export function dispatchCoordinatedSquads(state, targetId, squadTypes, events = null, options = null) {
  const preview = previewCoordinatedDeployment(state, targetId, squadTypes, options);
  if (!preview.ok) return preview;
  if (!consumeBundle(state, preview.cost)) return { ok: false, reasonKey: 'reason.deployment.coordinatedShortageAtCommit', reason: '連携出撃確定時に合計資源が不足しました。', preview };
  const worldTime = worldNow(state);
  const formation = {
    id: stableId('friendly_formation', targetId, worldTime, state.combat.friendlySquads.length),
    targetId,
    speed: null,
    size: preview.assignments.length,
    timingMode: preview.timingMode,
    originBaseId: preview.origin?.id ?? null
  };
  const squads = preview.assignments.map(assignment => instantiateFriendlySquad(
    state,
    { ...assignment, cost: {} },
    assignment.squadType,
    assignment.origin.id,
    targetId,
    events,
    {
      ...formation,
      speed: assignment.synchronizedSpeed,
      departDelay: assignment.departDelay,
      role: assignment.formationRole
    }
  ).squad);
  events?.emit('friendly:formation-deployed', { formationId: formation.id, targetId, squadIds: squads.map(squad => squad.id), cost: preview.cost, timingMode: preview.timingMode, originBaseId: formation.originBaseId });
  events?.emit('message', { key: 'friendly.notice.formationDeployed', params: { count: squads.length, timingLabel: preview.timingLabel }, text: `${squads.length}部隊が${preview.timingLabel}モードで連携出撃しました。同じ拠点から同じルートを進軍します。` });
  return { ok: true, squads, formationId: formation.id, cost: preview.cost, estimatedArrivalSeconds: preview.estimatedArrivalSeconds, timingMode: preview.timingMode, originBaseId: formation.originBaseId };
}


export const ALL_OUT_ASSAULT_COOLDOWN_SECONDS = 30 * 60;

function readyFriendlySquads(state) {
  return (state.combat?.friendlySquads ?? [])
    .filter(squad => squad.hp > 0 && squad.status === FRIENDLY_SQUAD_STATUS.READY)
    .sort((left, right) => String(left.originBaseId ?? '').localeCompare(String(right.originBaseId ?? ''))
      || String(left.type ?? '').localeCompare(String(right.type ?? ''))
      || String(left.id ?? '').localeCompare(String(right.id ?? '')));
}

export function rallyReadySquadsToBase(state, targetBaseId, events = null) {
  const ability = requireCivilizationAbility(state, CIVILIZATION_ABILITY.RALLY_ALL);
  if (!ability.ok) return ability;
  ensureFriendlyForceState(state);
  const targetBase = ownedBaseById(state, targetBaseId);
  if (!targetBase || targetBase.status !== 'ESTABLISHED' || targetBase.hp <= 0) {
    return { ok: false, reasonKey: 'reason.rally.targetBaseUnavailable', reason: '集結先の拠点が利用できません。' };
  }
  const moved = [];
  const failed = [];
  for (const squad of readyFriendlySquads(state)) {
    const currentBase = ownedBaseById(state, squad.recoveryBaseId ?? squad.originBaseId);
    if (!currentBase || currentBase.id === targetBase.id) continue;
    const path = findFriendlyRoadPath(state, currentBase.nodeId, targetBase.nodeId);
    if (!path) { failed.push(squad.id); continue; }
    squad.nodeId = currentBase.nodeId;
    squad.path = normalizePath(path);
    squad.pathIndex = 0;
    squad.edgeId = path.edgeIds[0] ?? null;
    squad.edgeProgress = 0;
    squad.order = FRIENDLY_SQUAD_ORDER.RETURN;
    squad.status = FRIENDLY_SQUAD_STATUS.RETURNING;
    squad.commandDestinationNodeId = targetBase.nodeId;
    squad.originBaseId = targetBase.id;
    squad.recoveryBaseId = targetBase.id;
    squad.targetBaseId = null;
    squad.missionTargetBaseId = null;
    squad.targetEnemyId = null;
    squad.targetRecoveryItemId = null;
    squad.recoveryCollectionProgressSec = null;
    squad.engagedEnemyId = null;
    moved.push(squad);
  }
  if (!moved.length) return { ok: false, reasonKey: failed.length ? 'reason.rally.noRoute' : 'reason.rally.noReadySquads', reason: failed.length ? '集結可能な道路経路がありません。' : '集結対象の待機部隊がありません。', failedSquadIds: failed };
  events?.emit('friendly:rally-all', { baseId: targetBase.id, squadIds: moved.map(squad => squad.id), failedSquadIds: failed });
  events?.emit('message', { key: 'friendly.notice.rallyAllIssued', params: { count: moved.length, baseName: targetBase.name }, text: `待機部隊${moved.length}隊へ${targetBase.name}への集結命令を出しました。` });
  return { ok: true, squads: moved, count: moved.length, failedSquadIds: failed, base: targetBase };
}

export function setEngineerAutoRepairPatrol(state, squadId, enabled = true, events = null) {
  const ability = requireCivilizationAbility(state, CIVILIZATION_ABILITY.AUTO_REPAIR_PATROL);
  if (!ability.ok) return ability;
  ensureFriendlyForceState(state);
  const squad = friendlySquadById(state, squadId);
  if (!squad || squad.type !== 'engineer') return { ok: false, reasonKey: 'reason.engineer.selectRequired', reason: '工兵部隊を選択してください。' };
  squad.autoRepairPatrol = Boolean(enabled);
  squad.autoRepairCooldown = 0;
  events?.emit('friendly:engineer-auto-repair', { squadId: squad.id, enabled: squad.autoRepairPatrol });
  events?.emit('message', { key: squad.autoRepairPatrol ? 'friendly.notice.autoRepairEnabled' : 'friendly.notice.autoRepairDisabled', params: { squadName: friendlySquadDefinition(squad.type).name }, text: squad.autoRepairPatrol ? `${friendlySquadDefinition(squad.type).name}の自動修理巡回を開始しました。` : `${friendlySquadDefinition(squad.type).name}の自動修理巡回を停止しました。` });
  return { ok: true, squad, enabled: squad.autoRepairPatrol };
}

export function queueFriendlyDispatch(state, squadId, targetId, events = null, { squadType = null, targetKind = 'enemyBase', routeOverride = null } = {}) {
  const ability = requireCivilizationAbility(state, CIVILIZATION_ABILITY.QUEUED_DISPATCH);
  if (!ability.ok) return ability;
  ensureFriendlyForceState(state);
  const squad = friendlySquadById(state, squadId);
  if (!squad) return { ok: false, reasonKey: 'reason.squad.notFound', reason: '部隊が見つかりません。' };
  if (targetKind !== 'enemyBase') return { ok: false, reasonKey: 'reason.queue.enemyBaseOnly', reason: '派兵予約は敵拠点攻撃にのみ対応しています。' };
  const target = state.world.enemyBases.find(base => base.id === targetId && base.alive && base.hp > 0) ?? null;
  if (!target) return { ok: false, reasonKey: 'reason.deployment.enemyBaseUnavailable', reason: '攻撃可能な敵拠点ではありません。' };
  squad.queuedDispatch = {
    targetId: target.id,
    targetKind: 'enemyBase',
    squadType: FRIENDLY_SQUAD_DEFINITIONS[squadType]?.type ?? squad.type,
    routeOverride: normalizePath(routeOverride),
    queuedAt: worldNow(state)
  };
  events?.emit('friendly:dispatch-queued', { squadId: squad.id, targetId: target.id, targetKind: 'enemyBase' });
  events?.emit('message', { key: 'friendly.notice.dispatchQueued', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}へ帰還後の派兵予約を設定しました。` });
  return { ok: true, squad, queuedDispatch: squad.queuedDispatch };
}

function executeQueuedDispatches(state, events = null) {
  if (!hasCivilizationAbility(state, CIVILIZATION_ABILITY.QUEUED_DISPATCH)) return;
  for (const squad of readyFriendlySquads(state).filter(item => item.queuedDispatch)) {
    const queued = squad.queuedDispatch;
    squad.queuedDispatch = null;
    const result = dispatchFriendlySquad(state, queued.squadType ?? squad.type, squad.originBaseId, queued.targetId, events, queued.targetKind ?? 'enemyBase', queued.routeOverride ?? null);
    if (result.ok) {
      events?.emit('friendly:queued-dispatch-executed', { squadId: squad.id, targetId: queued.targetId });
      events?.emit('message', { key: 'friendly.notice.queuedDispatchExecuted', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}が予約済みの派兵を実行しました。` });
    } else {
      events?.emit('friendly:queued-dispatch-failed', { squadId: squad.id, targetId: queued.targetId, reasonKey: result.reasonKey ?? null });
      events?.emit('message', { key: 'friendly.notice.queuedDispatchFailed', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}の派兵予約を実行できませんでした。` });
    }
  }
}

function updateEngineerAutoRepairPatrol(state, squad, deltaSeconds, events = null) {
  if (!squad.autoRepairPatrol || squad.type !== 'engineer' || !hasCivilizationAbility(state, CIVILIZATION_ABILITY.AUTO_REPAIR_PATROL)) return;
  if ([FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(squad.status)) return;
  squad.autoRepairCooldown = Math.max(0, Number(squad.autoRepairCooldown) || 0) - Math.max(0, Number(deltaSeconds) || 0);
  if (squad.autoRepairCooldown > 0) return;
  const result = repairNearbyDefenseWithEngineer(state, squad.id, events);
  squad.autoRepairCooldown = result.ok ? 10 : (result.reasonKey === 'reason.engineer.noRepairTargetNearby' ? 8 : 20);
}

export function allOutAssault(state, targetId, events = null) {
  const ability = requireCivilizationAbility(state, CIVILIZATION_ABILITY.ALL_OUT_ASSAULT);
  if (!ability.ok) return ability;
  ensureFriendlyForceState(state);
  const abilityState = ensureCivilizationAbilityState(state);
  const now = worldNow(state);
  if (now < abilityState.allOutAssaultReadyAt) {
    return { ok: false, reasonKey: 'reason.allOutAssault.cooldown', reasonParams: { seconds: Math.ceil((abilityState.allOutAssaultReadyAt - now) / 1000) }, reason: '総攻撃は再使用待機中です。' };
  }
  const target = state.world.enemyBases.find(base => base.id === targetId && base.alive && base.hp > 0) ?? null;
  if (!target) return { ok: false, reasonKey: 'reason.deployment.enemyBaseUnavailable', reason: '攻撃可能な敵拠点ではありません。' };
  const launched = [];
  const failed = [];
  for (const squad of readyFriendlySquads(state).filter(item => FRIENDLY_SQUAD_DEFINITIONS[item.type]?.missionKind !== 'RECOVERY')) {
    const result = dispatchFriendlySquad(state, squad.type, squad.originBaseId, target.id, events, 'enemyBase');
    if (result.ok) launched.push(result.squad);
    else failed.push({ squadId: squad.id, reasonKey: result.reasonKey ?? null });
  }
  if (!launched.length) return { ok: false, reasonKey: 'reason.allOutAssault.noReadySquads', reason: '総攻撃に参加できる待機部隊がありません。', failed };
  abilityState.allOutAssaultReadyAt = now + ALL_OUT_ASSAULT_COOLDOWN_SECONDS * 1000;
  events?.emit('friendly:all-out-assault', { targetId: target.id, squadIds: launched.map(squad => squad.id), cooldownSeconds: ALL_OUT_ASSAULT_COOLDOWN_SECONDS, failed });
  events?.emit('message', { key: 'friendly.notice.allOutAssaultIssued', params: { count: launched.length, minutes: 30 }, text: `待機部隊${launched.length}隊へ総攻撃を発令しました。次の総攻撃まで30分です。` });
  return { ok: true, squads: launched, count: launched.length, failed, cooldownSeconds: ALL_OUT_ASSAULT_COOLDOWN_SECONDS };
}

export function previewAssaultDeployment(state, originBaseId, targetBaseId) { return previewFriendlyDeployment(state, 'assault', originBaseId, targetBaseId); }
export function dispatchAssaultSquad(state, originBaseId, targetBaseId, events = null) { return dispatchFriendlySquad(state, 'assault', originBaseId, targetBaseId, events); }

function clearEnemyEngagements(state, squadId) {
  for (const enemy of state.combat.enemies) {
    if (enemy.engagedSquadId === squadId) enemy.engagedSquadId = null;
  }
}

function appendHistory(squad, nodeId) {
  if (!nodeId) return;
  squad.travelHistoryNodeIds ??= [];
  if (squad.travelHistoryNodeIds[squad.travelHistoryNodeIds.length - 1] !== nodeId) squad.travelHistoryNodeIds.push(nodeId);
  if (squad.travelHistoryNodeIds.length > 96) squad.travelHistoryNodeIds.splice(0, squad.travelHistoryNodeIds.length - 96);
}

function routeMatchesGraph(state, route, expectedStartNodeId, expectedDestinationNodeId = null) {
  if (!route || route.nodeIds.length !== route.edgeIds.length + 1) return false;
  if (route.nodeIds[0] !== expectedStartNodeId) return false;
  if (expectedDestinationNodeId && route.nodeIds[route.nodeIds.length - 1] !== expectedDestinationNodeId) return false;
  for (let index = 0; index < route.edgeIds.length; index += 1) {
    const edge = state.world.roadGraph.edgeById.get(route.edgeIds[index]);
    const from = route.nodeIds[index];
    const to = route.nodeIds[index + 1];
    if (!edge || !((edge.a === from && edge.b === to) || (edge.a === to && edge.b === from))) return false;
  }
  return true;
}

function assignPathAtCurrentPosition(state, squad, route, expectedDestinationNodeId = null) {
  const normalized = normalizePath(route);
  if (!normalized) return false;
  const currentEdge = squad.edgeId ? state.world.roadGraph.edgeById.get(squad.edgeId) : null;
  const movingInsideEdge = Boolean(squad.edgeId && currentEdge && squad.edgeProgress > 0 && squad.edgeProgress < currentEdge.length);
  if (movingInsideEdge) {
    const currentFrom = squad.path?.nodeIds?.[squad.pathIndex] ?? null;
    const currentTo = squad.path?.nodeIds?.[squad.pathIndex + 1] ?? null;
    if (currentTo && routeMatchesGraph(state, normalized, currentTo, expectedDestinationNodeId)) {
      squad.path = {
        nodeIds: [currentFrom, ...normalized.nodeIds],
        edgeIds: [squad.edgeId, ...normalized.edgeIds],
        cost: Math.max(0, currentEdge.length - squad.edgeProgress) + normalized.cost,
        targetId: normalized.targetId
      };
      squad.pathIndex = 0;
      return true;
    }
    if (currentFrom && routeMatchesGraph(state, normalized, currentFrom, expectedDestinationNodeId)) {
      squad.path = {
        nodeIds: [currentTo, ...normalized.nodeIds],
        edgeIds: [squad.edgeId, ...normalized.edgeIds],
        cost: Math.max(0, squad.edgeProgress) + normalized.cost,
        targetId: normalized.targetId
      };
      squad.pathIndex = 0;
      squad.edgeProgress = Math.max(0, currentEdge.length - squad.edgeProgress);
      return true;
    }
    return false;
  }
  if (!routeMatchesGraph(state, normalized, squad.nodeId, expectedDestinationNodeId)) return false;
  squad.path = normalized;
  squad.pathIndex = 0;
  squad.edgeId = normalized.edgeIds[0] ?? null;
  squad.edgeProgress = 0;
  squad.nodeId = normalized.nodeIds[0] ?? squad.nodeId;
  return true;
}

function findFriendlyPathFromBestCurrentEdgeExit(state, squad, destinationNodeId) {
  const currentEdge = squad.edgeId ? state.world.roadGraph.edgeById.get(squad.edgeId) : null;
  const currentFrom = currentEdge ? squad.path?.nodeIds?.[squad.pathIndex] : null;
  const currentTo = currentEdge ? squad.path?.nodeIds?.[squad.pathIndex + 1] : null;
  if (!currentEdge || !(squad.edgeProgress > 0) || squad.edgeProgress >= currentEdge.length || !currentFrom || !currentTo) {
    return findFriendlyRoadPath(state, squad.nodeId, destinationNodeId);
  }
  let best = null;
  for (const option of [
    { nodeId: currentFrom, leadingDistance: Math.max(0, squad.edgeProgress) },
    { nodeId: currentTo, leadingDistance: Math.max(0, currentEdge.length - squad.edgeProgress) }
  ]) {
    const path = findFriendlyRoadPath(state, option.nodeId, destinationNodeId);
    if (!path) continue;
    const score = option.leadingDistance + Math.max(0, Number(path.cost) || 0);
    if (!best || score < best.score) best = { path, score };
  }
  return best?.path ?? null;
}

export function holdFriendlySquad(state, squadId, events = null) {
  const squad = friendlySquadById(state, squadId);
  if (!squad) return { ok: false, reasonKey: 'reason.squad.notFound', reason: '部隊が見つかりません。' };
  if ([FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(squad.status)) {
    return { ok: false, reasonKey: 'reason.order.squadAtBaseCannotMove', reason: '拠点で回復・待機中の部隊には移動命令を出せません。' };
  }
  if (squad.order === FRIENDLY_SQUAD_ORDER.WITHDRAW || squad.order === FRIENDLY_SQUAD_ORDER.RETURN) {
    return { ok: false, reasonKey: 'reason.order.returningCannotHold', reason: '帰還中の部隊は停止命令へ変更できません。' };
  }
  if (squad.order !== FRIENDLY_SQUAD_ORDER.HOLD) {
    squad.heldOrder = squad.order;
    squad.heldDestinationNodeId = squad.commandDestinationNodeId;
  }
  squad.order = FRIENDLY_SQUAD_ORDER.HOLD;
  if (squad.status !== FRIENDLY_SQUAD_STATUS.ENGAGED) squad.status = FRIENDLY_SQUAD_STATUS.HALTED;
  events?.emit('friendly:squad-order', { squadId, order: squad.order });
  events?.emit('message', { key: 'friendly.notice.holdOrderIssued', text: '味方部隊へ停止命令を出しました。' });
  return { ok: true, squad };
}

export function issueFriendlyRouteOrder(state, squadId, { order, path, destinationNodeId }, events = null) {
  const squad = friendlySquadById(state, squadId);
  if (!squad) return { ok: false, reasonKey: 'reason.squad.notFound', reason: '部隊が見つかりません。' };
  if ([FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(squad.status)) {
    return { ok: false, reasonKey: 'reason.order.squadAtBaseCannotRoute', reason: '拠点で回復・待機中の部隊には経路命令を出せません。' };
  }
  if (![FRIENDLY_SQUAD_ORDER.ADVANCE, FRIENDLY_SQUAD_ORDER.RETREAT, FRIENDLY_SQUAD_ORDER.WITHDRAW].includes(order)) {
    return { ok: false, reasonKey: 'reason.order.invalidMode', reason: '無効な部隊命令です。' };
  }
  if ([FRIENDLY_SQUAD_ORDER.WITHDRAW, FRIENDLY_SQUAD_ORDER.RETURN].includes(squad.order)) {
    return { ok: false, reasonKey: 'reason.order.withdrawnCannotChange', reason: '撤退・帰還を開始した部隊の任務は変更できません。' };
  }
  let advanceTarget = null;
  if (order === FRIENDLY_SQUAD_ORDER.ADVANCE) {
    if (squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY) {
      advanceTarget = (state.world?.recoveryItems ?? []).find(item => item.id === squad.targetRecoveryItemId && item.assignedSquadId === squad.id && [RECOVERY_ITEM_STATUS.RESERVED, RECOVERY_ITEM_STATUS.CARRIED].includes(item.status)) ?? null;
      if (!advanceTarget) return { ok: false, reasonKey: 'reason.order.recoveryTargetLost', reason: '回収目標が失われています。撤退してください。' };
    } else if (squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT) {
      advanceTarget = currentTargetEnemy(state, squad);
      if (!advanceTarget) return { ok: false, reasonKey: 'reason.order.interceptTargetLost', reason: '迎撃対象は既に失われています。撤退してください。' };
    } else {
      const targetId = squad.missionTargetBaseId ?? squad.targetBaseId;
      advanceTarget = state.world.enemyBases.find(base => base.id === targetId && base.alive && base.hp > 0) ?? null;
      if (!advanceTarget) return { ok: false, reasonKey: 'reason.order.attackTargetLost', reason: '元の攻撃目標は既に失われています。撤退してください。' };
    }
  }
  if (order === FRIENDLY_SQUAD_ORDER.WITHDRAW) {
    const origin = ownedBaseById(state, squad.originBaseId) ?? activePlayerBases(state)[0] ?? null;
    if (!origin || origin.status !== 'ESTABLISHED' || origin.hp <= 0) return { ok: false, reasonKey: 'reason.order.noReturnBase', reason: '帰還可能な拠点がありません。' };
  }
  if (!assignPathAtCurrentPosition(state, squad, path, destinationNodeId ?? path?.targetId ?? null)) return { ok: false, reasonKey: 'reason.order.routeNotConnected', reason: '現在位置から選択ルートへ接続できません。' };
  if (advanceTarget && squad.missionType === FRIENDLY_SQUAD_MISSION.ATTACK) squad.targetBaseId = advanceTarget.id;
  if (advanceTarget && squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT) squad.targetEnemyId = advanceTarget.id;
  if (order === FRIENDLY_SQUAD_ORDER.WITHDRAW) {
    if (squad.targetRecoveryItemId) releaseRecoveryItem(state, squad.targetRecoveryItemId, squad.id, squad.status === FRIENDLY_SQUAD_STATUS.COLLECTING_ITEM ? friendlySquadPosition(state, squad) : null);
    squad.targetRecoveryItemId = null;
    squad.recoveryCollectionProgressSec = null;
    squad.targetBaseId = null;
    squad.missionTargetBaseId = null;
    squad.targetEnemyId = null;
  }
  squad.commandDestinationNodeId = destinationNodeId ?? path.targetId ?? null;
  if (squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY && order !== FRIENDLY_SQUAD_ORDER.HOLD) squad.recoveryCollectionProgressSec = null;
  squad.order = order;
  squad.heldOrder = null;
  squad.heldDestinationNodeId = null;
  squad.status = statusForOrder(order);
  squad.engagedEnemyId = null;
  events?.emit('friendly:squad-order', { squadId, order, destinationNodeId: squad.commandDestinationNodeId });
  const label = order === FRIENDLY_SQUAD_ORDER.RETREAT ? '後退' : order === FRIENDLY_SQUAD_ORDER.WITHDRAW ? '撤退' : '進軍再開';
  events?.emit('message', { key: 'friendly.notice.routeOrderIssued', params: { orderLabel: label }, text: `味方部隊へ${label}命令を出しました。` });
  return { ok: true, squad };
}

function planReturn(state, squad) {
  const origin = ownedBaseById(state, squad.originBaseId) ?? activePlayerBases(state)[0] ?? null;
  if (!origin) return false;
  const path = findFriendlyPathFromBestCurrentEdgeExit(state, squad, origin.nodeId);
  if ([FRIENDLY_SQUAD_MISSION.ATTACK, FRIENDLY_SQUAD_MISSION.INTERCEPT].includes(squad.missionType)) {
    squad.targetBaseId = null;
    squad.missionTargetBaseId = null;
    squad.targetEnemyId = null;
  }
  squad.engagedEnemyId = null;
  squad.order = FRIENDLY_SQUAD_ORDER.RETURN;
  squad.heldOrder = null;
  squad.heldDestinationNodeId = null;
  squad.commandDestinationNodeId = origin.nodeId;
  squad.recoveryBaseId = origin.id;
  if (squad.originBaseId !== origin.id && !ownedBaseById(state, squad.originBaseId)) squad.originBaseId = origin.id;
  if (!path || !assignPathAtCurrentPosition(state, squad, path, origin.nodeId)) {
    squad.status = FRIENDLY_SQUAD_STATUS.STRANDED;
    squad.path = null;
    squad.edgeId = null;
    return false;
  }
  squad.status = FRIENDLY_SQUAD_STATUS.RETURNING;
  return true;
}

function redirectRecoverySquadToMajorBase(state, squad, events = null) {
  const candidates = activePlayerBases(state)
    .map(base => ({ base, path: findFriendlyRoadPath(state, squad.nodeId, base.nodeId) }))
    .filter(candidate => candidate.path)
    .sort((a, b) => a.path.cost - b.path.cost);
  const fallback = candidates[0] ?? null;
  if (!fallback || !assignPathAtCurrentPosition(state, squad, fallback.path, fallback.base.nodeId)) {
    squad.status = FRIENDLY_SQUAD_STATUS.STRANDED;
    squad.path = null;
    squad.edgeId = null;
    squad.edgeProgress = 0;
    return false;
  }
  squad.originBaseId = fallback.base.id;
  squad.recoveryBaseId = fallback.base.id;
  squad.targetBaseId = null;
  squad.missionTargetBaseId = null;
  squad.targetEnemyId = null;
  squad.commandDestinationNodeId = fallback.base.nodeId;
  squad.order = FRIENDLY_SQUAD_ORDER.RETURN;
  squad.status = FRIENDLY_SQUAD_STATUS.RETURNING;
  squad.heldOrder = null;
  squad.heldDestinationNodeId = null;
  squad.recoveryStartedAt = null;
  squad.reorganizationRemaining = 0;
  squad.readyAt = null;
  events?.emit('friendly:squad-recovery-relocated', { squadId: squad.id, baseId: fallback.base.id });
  events?.emit('message', { key: 'friendly.notice.recoveryBaseLostFallback', params: { baseName: fallback.base.name }, text: `療養中の拠点が失われたため、部隊は${fallback.base.name}へ退避します。` });
  return true;
}

function currentTargetBase(state, squad) {
  return squad.targetBaseId
    ? state.world.enemyBases.find(base => base.id === squad.targetBaseId && base.alive && base.hp > 0) ?? null
    : null;
}

function currentTargetEnemy(state, squad) {
  return squad.targetEnemyId
    ? state.combat.enemies.find(enemy => enemy.id === squad.targetEnemyId && enemy.hp > 0 && enemy.departDelay <= 0) ?? null
    : null;
}

function replanIntercept(state, squad, target = currentTargetEnemy(state, squad)) {
  const destinationNodeId = enemyPursuitNodeId(state, target);
  if (!destinationNodeId) return false;
  if (squad.commandDestinationNodeId === destinationNodeId && (squad.path || squad.nodeId === destinationNodeId)) return true;
  const currentEdge = squad.edgeId ? state.world.roadGraph.edgeById.get(squad.edgeId) : null;
  const routeStart = currentEdge && squad.edgeProgress > 0 && squad.edgeProgress < currentEdge.length && squad.path?.nodeIds?.[squad.pathIndex + 1]
    ? squad.path.nodeIds[squad.pathIndex + 1]
    : squad.nodeId;
  squad.commandDestinationNodeId = destinationNodeId;
  if (routeStart === destinationNodeId) {
    if (!currentEdge || squad.edgeProgress <= 0 || squad.edgeProgress >= currentEdge.length) {
      squad.path = null;
      squad.edgeId = null;
      squad.edgeProgress = 0;
      squad.nodeId = destinationNodeId;
    }
    squad.status = FRIENDLY_SQUAD_STATUS.OUTBOUND;
    return true;
  }
  const path = findFriendlyRoadPath(state, routeStart, destinationNodeId);
  if (!path || !assignPathAtCurrentPosition(state, squad, path, destinationNodeId)) return false;
  squad.status = FRIENDLY_SQUAD_STATUS.OUTBOUND;
  return true;
}

function currentRecoveryItem(state, squad) {
  return squad.targetRecoveryItemId
    ? (state.world?.recoveryItems ?? []).find(item => item.id === squad.targetRecoveryItemId && item.assignedSquadId === squad.id) ?? null
    : null;
}

function recoveryDropPlacement(state, squad) {
  const point = friendlySquadPosition(state, squad);
  const edge = squad.edgeId ? state.world.roadGraph.edgeById.get(squad.edgeId) : null;
  let nodeId = squad.nodeId;
  if (edge) nodeId = squad.edgeProgress <= edge.length / 2 ? edge.a : edge.b;
  return { nodeId, x: point.x, y: point.y };
}

function releaseSquadRecoveryItem(state, squad, dropCarried = false) {
  const item = currentRecoveryItem(state, squad);
  if (!item) return null;
  const placement = dropCarried && item.status === RECOVERY_ITEM_STATUS.CARRIED ? recoveryDropPlacement(state, squad) : null;
  const released = releaseRecoveryItem(state, item.id, squad.id, placement);
  squad.targetRecoveryItemId = null;
  squad.recoveryCollectionProgressSec = null;
  return released.item ?? null;
}

function synchronizeCarriedItem(state, squad) {
  const item = currentRecoveryItem(state, squad);
  if (!item || item.status !== RECOVERY_ITEM_STATUS.CARRIED) return;
  const placement = recoveryDropPlacement(state, squad);
  item.nodeId = placement.nodeId;
  item.x = placement.x;
  item.y = placement.y;
}

function updateRecoveryCollection(state, squad, definition, deltaSeconds, events) {
  const item = currentRecoveryItem(state, squad);
  if (!item) { planReturn(state, squad); return; }
  if (item.status === RECOVERY_ITEM_STATUS.CARRIED) { planReturn(state, squad); return; }
  if (item.status !== RECOVERY_ITEM_STATUS.RESERVED) { releaseSquadRecoveryItem(state, squad); planReturn(state, squad); return; }
  squad.status = FRIENDLY_SQUAD_STATUS.COLLECTING_ITEM;
  squad.recoveryCollectionProgressSec = Math.min(definition.collectionSeconds ?? SQUAD_RECOVERY_COLLECTION_DURATION_SECONDS, (squad.recoveryCollectionProgressSec ?? 0) + deltaSeconds);
  if (squad.recoveryCollectionProgressSec < (definition.collectionSeconds ?? SQUAD_RECOVERY_COLLECTION_DURATION_SECONDS)) return;
  const pickedUp = markRecoveryItemCarried(state, item.id, squad.id);
  if (!pickedUp.ok) { releaseSquadRecoveryItem(state, squad); planReturn(state, squad); return; }
  squad.recoveryCollectionProgressSec = null;
  events?.emit('friendly:recovery-item-picked-up', { squadId: squad.id, itemId: item.id });
  events?.emit('message', { key: 'friendly.notice.recoveryItemSecuredReturn', params: { itemName: recoveryItemPresentation(item).name }, text: `${recoveryItemPresentation(item).name}を確保しました。拠点へ帰還します。` });
  planReturn(state, squad);
}

function acquireEnemy(state, squad, spatial, definition) {
  const position = friendlySquadPosition(state, squad);
  const priority = new Map((definition.targetPriorityTypes ?? []).map((type, index) => [type, index]));
  const candidates = spatial.query(position, definition.engagementRange)
    .filter(entry => entry.enemy.hp > 0 && entry.enemy.departDelay <= 0)
    .sort((a, b) => {
      if (a.enemy.id === squad.targetEnemyId) return -1;
      if (b.enemy.id === squad.targetEnemyId) return 1;
      const rankA = priority.has(a.enemy.type) ? priority.get(a.enemy.type) : Number.MAX_SAFE_INTEGER;
      const rankB = priority.has(b.enemy.type) ? priority.get(b.enemy.type) : Number.MAX_SAFE_INTEGER;
      const riskA = squad.type === 'skirmisher' ? skirmisherTargetRisk(a.enemy) : 0;
      const riskB = squad.type === 'skirmisher' ? skirmisherTargetRisk(b.enemy) : 0;
      const distanceA = distanceSquared(a.position, position);
      const distanceB = distanceSquared(b.position, position);
      if (squad.type === 'skirmisher') return rankA - rankB || riskA - riskB || distanceA - distanceB;
      return rankA - rankB || distanceA - distanceB;
    });
  const target = candidates[0]?.enemy ?? null;
  squad.engagedEnemyId = target?.id ?? null;
  if (target) target.engagedSquadId = squad.id;
  return target;
}

function friendlyCommandBonuses(state, squad) {
  const point = friendlySquadPosition(state, squad);
  let attack = 0;
  let speed = 0;
  for (const commander of state.combat?.friendlySquads ?? []) {
    if (commander.id === squad.id || commander.type !== 'command' || commander.hp <= 0) continue;
    if ([FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(commander.status)) continue;
    const definition = friendlySquadRuntimeDefinition(state, commander.type, commander);
    if (distanceSquared(point, friendlySquadPosition(state, commander)) > (definition.auraRange ?? 0) ** 2) continue;
    attack = Math.max(attack, Number(definition.commandAura) || 0);
    speed = Math.max(speed, Number(definition.speedAura) || 0);
  }
  return { attack, speed };
}


function friendlySquadLevelCap(state) {
  const civilizationLevel = Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
  return Math.max(1, Math.min(5, 1 + civilizationLevel));
}

function awardFriendlySquadExperience(state, squad, amount, events = null) {
  if (!squad || squad.hp <= 0 || amount <= 0) return;
  squad.unitLevel = friendlySquadLevel(squad);
  if (squad.unitLevel >= 5) return;
  squad.unitXp = Math.max(0, Number(squad.unitXp) || 0) + amount;
  const levelCap = friendlySquadLevelCap(state);
  let leveled = false;
  while (squad.unitLevel < levelCap && squad.unitLevel < 5 && squad.unitXp >= friendlySquadXpForNextLevel(squad.unitLevel)) {
    squad.unitLevel += 1;
    leveled = true;
  }
  if (!leveled) return;
  const previousMaxHp = Math.max(1, Number(squad.maxHp) || 1);
  const previousRatio = Math.max(0, Math.min(1, Number(squad.hp) / previousMaxHp));
  const definition = friendlySquadRuntimeDefinition(state, squad.type, squad);
  squad.maxHp = definition.hp;
  squad.hp = Math.max(1, Math.min(squad.maxHp, Math.round(squad.maxHp * previousRatio)));
  events?.emit('friendly:squad-leveled', { squadId: squad.id, type: squad.type, unitLevel: squad.unitLevel });
  events?.emit('message', { key: 'friendly.notice.squadLevelUp', params: { squadName: friendlySquadDefinition(squad.type).name, level: squad.unitLevel }, text: `${friendlySquadDefinition(squad.type).name}がLv.${squad.unitLevel}になりました。` });
}

function awardFriendlyCombatExperience(state, squad, { damage = 0, seconds = 0, enemyType = null, killed = 0, baseDamage = 0 } = {}, events = null) {
  if (!squad || squad.hp <= 0) return;
  let amount = 0;
  const activeSeconds = Math.max(0, Number(seconds) || 0);
  const dealtDamage = Math.max(0, Number(damage) || 0);
  const dealtBaseDamage = Math.max(0, Number(baseDamage) || 0);
  if (dealtDamage > 0) amount += Math.min(3.2, dealtDamage * 0.11) + activeSeconds * 0.55;
  if (dealtBaseDamage > 0) amount += Math.min(3.6, dealtBaseDamage * 0.10) + activeSeconds * 0.45;
  if (killed > 0) amount += Math.max(0, Number(killed) || 0) * (enemyType === 'scout' ? 9 : 13);
  const definition = friendlySquadDefinition(squad.type);
  if (squad.type === 'skirmisher' && enemyType && (definition.targetPriorityTypes ?? []).includes(enemyType)) amount *= 1.35;
  if (squad.type === 'siege' && dealtBaseDamage > 0) amount *= 1.25;
  awardFriendlySquadExperience(state, squad, amount, events);
}

function applyArtillerySplash(state, squad, definition, primaryEnemy, primaryDamage, spatial, events) {
  if (!(definition.splashRadius > 0) || !(definition.maxSplashTargets > 1)) return;
  const center = enemyPosition(state, primaryEnemy);
  const targets = spatial.query(center, definition.splashRadius)
    .filter(entry => entry.enemy.id !== primaryEnemy.id && entry.enemy.hp > 0 && entry.enemy.departDelay <= 0)
    .sort((left, right) => distanceSquared(left.position, center) - distanceSquared(right.position, center))
    .slice(0, definition.maxSplashTargets - 1);
  for (const entry of targets) {
    const groupMultiplier = splashDamageMultiplierForGroup(entry.enemy, definition, { centered: false });
    const before = enemyUnitCount(entry.enemy);
    const beforeHp = Math.max(0, Number(entry.enemy.hpPool ?? entry.enemy.hp) || 0);
    damageEnemy(state, entry.enemy, primaryDamage * (definition.splashMultiplier ?? 0) * groupMultiplier, events, spatial);
    const afterHp = Math.max(0, Number(entry.enemy.hpPool ?? entry.enemy.hp) || 0);
    const killed = Math.max(0, before - enemyUnitCount(entry.enemy));
    awardFriendlyCombatExperience(state, squad, { damage: beforeHp - afterHp, seconds: 0, enemyType: entry.enemy.type, killed }, events);
  }
}

function updateEngagement(state, squad, definition, deltaSeconds, spatial, events) {
  let enemy = squad.engagedEnemyId ? state.combat.enemies.find(item => item.id === squad.engagedEnemyId && item.hp > 0) : null;
  const squadPoint = friendlySquadPosition(state, squad);
  const designated = squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT ? currentTargetEnemy(state, squad) : null;
  if (designated && distanceSquared(enemyPosition(state, designated), squadPoint) <= definition.engagementRange * definition.engagementRange) {
    if (enemy && enemy.id !== designated.id && enemy.engagedSquadId === squad.id) enemy.engagedSquadId = null;
    enemy = designated;
    squad.engagedEnemyId = designated.id;
    designated.engagedSquadId = squad.id;
  }
  if (enemy && distanceSquared(enemyPosition(state, enemy), squadPoint) > (definition.engagementRange + 5) ** 2) {
    if (enemy.engagedSquadId === squad.id) enemy.engagedSquadId = null;
    squad.engagedEnemyId = null;
    enemy = null;
  }
  enemy ??= acquireEnemy(state, squad, spatial, definition);
  if (!enemy) return false;
  if (shouldSkirmisherAutoWithdraw(squad, definition, enemy)) {
    if (enemy.engagedSquadId === squad.id) enemy.engagedSquadId = null;
    squad.engagedEnemyId = null;
    if (planReturn(state, squad)) {
      events?.emit('friendly:squad-auto-withdraw', { squadId: squad.id, enemyId: enemy.id });
      events?.emit('message', { key: 'friendly.notice.skirmisherAutoWithdraw', text: '遊撃部隊が不利な敵群から自動後退しました。' });
      return true;
    }
  }
  squad.status = FRIENDLY_SQUAD_STATUS.ENGAGED;
  squad.combatCooldown = Math.max(squad.combatCooldown ?? 0, definition.recoveryDelaySeconds ?? 0);
  const commandBonus = friendlyCommandBonuses(state, squad).attack;
  const primaryDamage = friendlySquadEnemyDamage(definition, enemy.type) * (1 + commandBonus) * deltaSeconds;
  applyArtillerySplash(state, squad, definition, enemy, primaryDamage, spatial, events);
  const beforeCount = enemyUnitCount(enemy);
  const beforeHp = Math.max(0, Number(enemy.hpPool ?? enemy.hp) || 0);
  damageEnemy(state, enemy, primaryDamage, events, spatial);
  const afterHp = Math.max(0, Number(enemy.hpPool ?? enemy.hp) || 0);
  const killed = Math.max(0, beforeCount - enemyUnitCount(enemy));
  awardFriendlyCombatExperience(state, squad, {
    damage: beforeHp - afterHp,
    seconds: deltaSeconds,
    enemyType: enemy.type,
    killed
  }, events);
  if (enemy.hp <= 0) squad.engagedEnemyId = null;
  return true;
}


function exposeEvasiveSquad(state, squad, definition, spatial) {
  const position = friendlySquadPosition(state, squad);
  const candidate = spatial.query(position, definition.engagementRange)
    .filter(entry => entry.enemy.hp > 0 && entry.enemy.departDelay <= 0)
    .sort((a, b) => distanceSquared(a.position, position) - distanceSquared(b.position, position))[0]?.enemy ?? null;
  if (candidate && (!candidate.engagedSquadId || candidate.engagedSquadId === squad.id)) candidate.engagedSquadId = squad.id;
}


function updateNonCombatRecovery(squad, definition, deltaSeconds) {
  squad.combatCooldown = Math.max(0, (squad.combatCooldown ?? 0) - deltaSeconds);
  if (!(definition.nonCombatRecoveryPerSecond > 0)) return;
  if (squad.combatCooldown > 0 || squad.status === FRIENDLY_SQUAD_STATUS.ENGAGED || squad.status === FRIENDLY_SQUAD_STATUS.ATTACKING_BASE) return;
  squad.hp = Math.min(squad.maxHp, squad.hp + definition.nonCombatRecoveryPerSecond * deltaSeconds);
}

function advanceAlongPath(state, squad, definition, deltaSeconds) {
  if (!squad.path || !squad.edgeId) return { status: 'ARRIVED', remainingSeconds: Math.max(0, deltaSeconds) };
  const formationActive = Boolean(
    squad.formationId && squad.order === FRIENDLY_SQUAD_ORDER.ADVANCE &&
    squad.missionType === FRIENDLY_SQUAD_MISSION.ATTACK &&
    state.world.enemyBases.some(base => base.id === squad.formationTargetId && base.alive && base.hp > 0)
  );
  const baseMovementSpeed = formationActive ? Math.min(definition.speed, squad.formationSpeed ?? definition.speed) : definition.speed;
  const nowMs = worldNow(state);
  const activeRoadsideBoost = Number(squad.roadsideSpeedBoostUntil) > nowMs ? Math.max(0, Number(squad.roadsideSpeedBoostMultiplier) || 0) : 0;
  if (activeRoadsideBoost <= 0 && Number(squad.roadsideSpeedBoostUntil) > 0 && Number(squad.roadsideSpeedBoostUntil) <= nowMs) {
    squad.roadsideSpeedBoostUntil = 0;
    squad.roadsideSpeedBoostMultiplier = 0;
  }
  const movementSpeed = Math.max(0.001, baseMovementSpeed * (1 + friendlyCommandBonuses(state, squad).speed + activeRoadsideBoost));
  let remainingSeconds = Math.max(0, Number(deltaSeconds) || 0);
  let transitions = 0;
  while (squad.path && squad.edgeId && remainingSeconds > 1e-9 && transitions < 4096) {
    const edge = state.world.roadGraph.edgeById.get(squad.edgeId);
    if (!edge) return { status: 'BROKEN', remainingSeconds };
    const remainingDistance = Math.max(0, edge.length - squad.edgeProgress);
    const timeToNode = remainingDistance / movementSpeed;
    if (remainingSeconds + 1e-9 < timeToNode) {
      squad.edgeProgress += movementSpeed * remainingSeconds;
      return { status: 'MOVING', remainingSeconds: 0 };
    }
    remainingSeconds = Math.max(0, remainingSeconds - timeToNode);
    squad.nodeId = squad.path.nodeIds[squad.pathIndex + 1];
    appendHistory(squad, squad.nodeId);
    squad.pathIndex += 1;
    squad.edgeProgress = 0;
    transitions += 1;
    if (squad.pathIndex >= squad.path.edgeIds.length) {
      squad.edgeId = null;
      return { status: 'ARRIVED', remainingSeconds };
    }
    squad.edgeId = squad.path.edgeIds[squad.pathIndex];
  }
  return { status: squad.edgeId ? 'MOVING' : 'ARRIVED', remainingSeconds };
}

function attackEnemyBase(state, squad, definition, deltaSeconds, events) {
  const target = currentTargetBase(state, squad);
  if (!target) {
    planReturn(state, squad);
    return;
  }
  squad.status = FRIENDLY_SQUAD_STATUS.ATTACKING_BASE;
  squad.combatCooldown = Math.max(squad.combatCooldown ?? 0, definition.recoveryDelaySeconds ?? 0);
  spawnEnemyBaseGuard(state, target, events);
  const beforeHp = Math.max(0, Number(target.hp) || 0);
  target.hp = Math.max(0, target.hp - definition.baseDps * deltaSeconds);
  const baseDamage = Math.max(0, beforeHp - Math.max(0, Number(target.hp) || 0));
  awardFriendlyCombatExperience(state, squad, { baseDamage, seconds: deltaSeconds }, events);
  if (target.hp > 0) return;
  awardFriendlySquadExperience(state, squad, 18, events);
  destroyEnemyBase(state, target, events, { squadId: squad.id });
  planReturn(state, squad);
}

function currentOrderDestinationNodeId(state, squad) {
  if (squad.order === FRIENDLY_SQUAD_ORDER.ADVANCE) return squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY
    ? currentRecoveryItem(state, squad)?.nodeId ?? null
    : squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT
      ? enemyPursuitNodeId(state, currentTargetEnemy(state, squad))
      : currentTargetBase(state, squad)?.nodeId ?? null;
  if ([FRIENDLY_SQUAD_ORDER.RETURN, FRIENDLY_SQUAD_ORDER.WITHDRAW].includes(squad.order)) {
    return ownedBaseById(state, squad.originBaseId)?.nodeId ?? activePlayerBases(state)[0]?.nodeId ?? null;
  }
  if (squad.order === FRIENDLY_SQUAD_ORDER.RETREAT) return squad.commandDestinationNodeId;
  return null;
}

function routeNeedsBarrierReroute(squad, blockedEdgeIds) {
  if (!squad.path?.edgeIds?.length) return false;
  for (let index = Math.max(0, squad.pathIndex ?? 0); index < squad.path.edgeIds.length; index += 1) {
    if (blockedEdgeIds.has(squad.path.edgeIds[index])) return true;
  }
  return false;
}

function rerouteFriendlySquadAroundBarriers(state, squad) {
  const blockedEdgeIds = activeFriendlyBarrierEdgeIds(state);
  const barrierBlocksRoute = routeNeedsBarrierReroute(squad, blockedEdgeIds);
  if (!barrierBlocksRoute) {
    squad.reroutePending = false;
    return true;
  }
  squad.reroutePending = false;
  if ([FRIENDLY_SQUAD_ORDER.HOLD].includes(squad.order)) return true;
  const targetNodeId = currentOrderDestinationNodeId(state, squad);
  if (!targetNodeId) return true;
  const path = findFriendlyPathFromBestCurrentEdgeExit(state, squad, targetNodeId);
  if (!path || !assignPathAtCurrentPosition(state, squad, path, targetNodeId)) {
    squad.status = FRIENDLY_SQUAD_STATUS.STRANDED;
    squad.path = null;
    squad.edgeId = null;
    squad.edgeProgress = 0;
    return false;
  }
  squad.commandDestinationNodeId = targetNodeId;
  squad.status = statusForOrder(squad.order);
  return true;
}

function clearStrandedMetadata(squad) {
  delete squad.strandedSince;
  delete squad.strandedRetryAt;
  delete squad.strandedRetryDelaySeconds;
  delete squad.strandedRetryAttempts;
  delete squad.strandedNotifiedAt;
  delete squad.strandedForcedRecoveryAt;
}

function ensureStrandedMetadata(state, squad) {
  const now = worldNow(state);
  if (!Number.isFinite(Number(squad.strandedSince))) squad.strandedSince = now;
  if (!Number.isFinite(Number(squad.strandedRetryDelaySeconds)) || squad.strandedRetryDelaySeconds <= 0) {
    squad.strandedRetryDelaySeconds = FRIENDLY_STRANDED_RETRY_INITIAL_SECONDS;
  }
  if (!Number.isFinite(Number(squad.strandedRetryAt))) {
    squad.strandedRetryAt = now + FRIENDLY_STRANDED_RETRY_INITIAL_SECONDS * 1000;
  }
  if (!Number.isFinite(Number(squad.strandedRetryAttempts)) || squad.strandedRetryAttempts < 0) squad.strandedRetryAttempts = 0;
  return now;
}

function scheduleNextStrandedRetry(state, squad, now = worldNow(state)) {
  const delaySeconds = Math.max(
    FRIENDLY_STRANDED_RETRY_INITIAL_SECONDS,
    Math.min(FRIENDLY_STRANDED_RETRY_MAX_SECONDS, Number(squad.strandedRetryDelaySeconds) || FRIENDLY_STRANDED_RETRY_INITIAL_SECONDS)
  );
  squad.strandedRetryAttempts = Math.max(0, Math.floor(Number(squad.strandedRetryAttempts) || 0)) + 1;
  squad.strandedRetryAt = now + delaySeconds * 1000;
  squad.strandedRetryDelaySeconds = Math.min(FRIENDLY_STRANDED_RETRY_MAX_SECONDS, delaySeconds * 2);
}

function strandedTargetNodeId(state, squad) {
  if (squad.order === FRIENDLY_SQUAD_ORDER.ADVANCE) return squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY
    ? currentRecoveryItem(state, squad)?.nodeId ?? null
    : squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT
      ? enemyPursuitNodeId(state, currentTargetEnemy(state, squad))
      : currentTargetBase(state, squad)?.nodeId ?? null;
  if ([FRIENDLY_SQUAD_ORDER.RETURN, FRIENDLY_SQUAD_ORDER.WITHDRAW].includes(squad.order)) return ownedBaseById(state, squad.originBaseId)?.nodeId ?? activePlayerBases(state)[0]?.nodeId ?? null;
  if (squad.order === FRIENDLY_SQUAD_ORDER.RETREAT) return squad.commandDestinationNodeId;
  return null;
}

function notifyLongStranding(state, squad, events = null, now = worldNow(state)) {
  const strandedSeconds = Math.max(0, (now - Number(squad.strandedSince)) / 1000);
  if (strandedSeconds < FRIENDLY_STRANDED_NOTIFY_AFTER_SECONDS || Number.isFinite(Number(squad.strandedNotifiedAt))) return;
  squad.strandedNotifiedAt = now;
  events?.emit('friendly:squad-stranded', { squadId: squad.id, strandedSeconds: Math.floor(strandedSeconds), retryAttempts: Math.max(0, Math.floor(Number(squad.strandedRetryAttempts) || 0)) });
  events?.emit('message', {
    key: 'friendly.notice.squadStranded',
    params: { squadName: friendlySquadDefinition(squad.type).name },
    text: `${friendlySquadDefinition(squad.type).name}が道路分断で孤立しています。経路復旧を一定間隔で再試行します。`
  });
}

function forceRecoverStrandedSquad(state, squad, events = null, now = worldNow(state)) {
  const strandedSeconds = Math.max(0, (now - Number(squad.strandedSince)) / 1000);
  if (strandedSeconds < FRIENDLY_STRANDED_FORCE_RECOVERY_AFTER_SECONDS || Number.isFinite(Number(squad.strandedForcedRecoveryAt))) return false;
  const fallback = nearestOwnedBase(state, friendlySquadPosition(state, squad));
  const base = fallback?.base ?? null;
  if (!base || base.status !== 'ESTABLISHED' || base.hp <= 0) return false;
  squad.strandedForcedRecoveryAt = now;
  squad.originBaseId = base.id;
  squad.recoveryBaseId = base.id;
  events?.emit('friendly:squad-stranded-forced-recovery', { squadId: squad.id, baseId: base.id, strandedSeconds: Math.floor(strandedSeconds) });
  const recovery = beginAnnihilationRecovery(state, squad, events, {
    recoveryScale: FRIENDLY_STRANDED_FORCE_RECOVERY_SCALE,
    notice: {
      key: 'friendly.notice.squadStrandedForcedRecovery',
      params: { squadName: friendlySquadDefinition(squad.type).name, baseName: base.name },
      text: `${friendlySquadDefinition(squad.type).name}は長時間孤立したため、${base.name}で壊滅再編成に入ります。`
    }
  });
  if (recovery.ok) clearStrandedMetadata(squad);
  return Boolean(recovery.ok);
}

function replanStranded(state, squad, events = null) {
  const now = ensureStrandedMetadata(state, squad);
  notifyLongStranding(state, squad, events, now);
  if (forceRecoverStrandedSquad(state, squad, events, now)) return true;
  if (now < Number(squad.strandedRetryAt)) return false;
  const targetNodeId = strandedTargetNodeId(state, squad);
  if (!targetNodeId) {
    scheduleNextStrandedRetry(state, squad, now);
    return false;
  }
  const path = findFriendlyRoadPath(state, squad.nodeId, targetNodeId);
  if (!path) {
    scheduleNextStrandedRetry(state, squad, now);
    return false;
  }
  squad.path = normalizePath(path);
  squad.pathIndex = 0;
  squad.edgeId = path.edgeIds[0] ?? null;
  squad.edgeProgress = 0;
  squad.status = statusForOrder(squad.order);
  clearStrandedMetadata(squad);
  return true;
}

export function repairNearbyDefenseWithEngineer(state, squadId, events = null) {
  ensureFriendlyForceState(state);
  const squad = friendlySquadById(state, squadId);
  if (!squad || squad.type !== 'engineer') return { ok: false, reasonKey: 'reason.engineer.selectRequired', reason: '工兵部隊を選択してください。' };
  if ([FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(squad.status)) return { ok: false, reasonKey: 'reason.engineer.activeOnly', reason: '出撃中の工兵部隊だけが現地修復できます。' };
  const definition = friendlySquadRuntimeDefinition(state, squad.type, squad);
  const point = friendlySquadPosition(state, squad);
  const target = (state.combat?.defenses ?? [])
    .filter(defense => defense.hp > 0 && defense.hp < defense.maxHp && distanceSquared(point, defense.position) <= definition.repairRange * definition.repairRange)
    .sort((left, right) => (left.hp / left.maxHp) - (right.hp / right.maxHp) || distanceSquared(point, left.position) - distanceSquared(point, right.position))[0] ?? null;
  if (!target) return { ok: false, reasonKey: 'reason.engineer.noRepairTargetNearby', reasonParams: { range: definition.repairRange }, reason: `周囲${definition.repairRange}mに修復可能な設備がありません。` };
  const repairHp = Math.min(definition.repairAmount, target.maxHp - target.hp);
  const cost = repairCostForDefense(target, repairHp);
  const missing = missingBundle(state, cost);
  if (Object.keys(missing).length) return { ok: false, reasonKey: 'reason.engineer.repairShortage', reason: '現地修復に必要な資源が不足しています。', missing, cost, target };
  if (!consumeBundle(state, cost)) return { ok: false, reasonKey: 'reason.engineer.repairShortageAtCommit', reason: '現地修復の確定時に資源が不足しました。' };
  target.hp = Math.min(target.maxHp, target.hp + repairHp);
  events?.emit('friendly:engineer-repair', { squadId, defenseId: target.id, repairHp, cost });
  events?.emit('message', { key: 'friendly.notice.engineerFieldRepair', params: { hp: Math.round(repairHp) }, text: `工兵部隊が${Math.round(repairHp)}HPを現地修復しました。` });
  return { ok: true, target, repairHp, cost };
}


function primaryRecoveryBaseId(state) {
  const primary = activePlayerBases(state).find(base => base.primary && base.hp > 0) ?? activePlayerBases(state).find(base => base.hp > 0) ?? state.world?.homeBase ?? null;
  return primary?.id ?? null;
}

function annihilationRecoverySeconds(squad) {
  const definition = FRIENDLY_SQUAD_DEFINITIONS[squad.type] ?? FRIENDLY_SQUAD_DEFINITIONS.assault;
  const base = FRIENDLY_ANNIHILATION_RECOVERY_SECONDS[definition.type] ?? 420;
  const levelBonus = Math.max(0, Math.floor(Number(definition.unlockLevel) || 0)) * 30;
  return base + levelBonus;
}

function beginAnnihilationRecovery(state, squad, events = null, { recoveryScale = 1, notice = null } = {}) {
  const dropped = releaseSquadRecoveryItem(state, squad, true);
  if (dropped) {
    events?.emit('friendly:recovery-item-dropped', { squadId: squad.id, itemId: dropped.id, position: recoveryItemPoint(state, dropped) });
    events?.emit('message', { key: 'friendly.notice.recoverySquadDroppedItem', text: '回収部隊が壊滅し、特殊アイテムが道路上へ残されました。' });
  }
  const baseId = (ownedBaseById(state, squad.originBaseId) ? squad.originBaseId : null) ?? primaryRecoveryBaseId(state);
  squad.hp = 1;
  squad.maxHp = Math.max(1, Number(squad.maxHp) || friendlySquadRuntimeDefinition(state, squad.type, squad).hp);
  squad.path = null;
  squad.edgeId = null;
  squad.edgeProgress = 0;
  squad.engagedEnemyId = null;
  squad.targetEnemyId = null;
  squad.targetBaseId = null;
  squad.missionTargetBaseId = null;
  squad.targetRecoveryItemId = null;
  squad.recoveryCollectionProgressSec = null;
  squad.annihilatedRecovery = true;
  squad.annihilatedAt = worldNow(state);
  const recovery = beginFriendlyRecovery(state, squad, baseId);
  if (!recovery.ok) {
    squad.status = FRIENDLY_SQUAD_STATUS.STRANDED;
    squad.order = FRIENDLY_SQUAD_ORDER.HOLD;
    return recovery;
  }
  squad.reorganizationRemaining = Math.max(squad.reorganizationRemaining ?? 0, annihilationRecoverySeconds(squad) * Math.max(0.1, recoveryScale));
  events?.emit('friendly:squad-annihilated', { squadId: squad.id, originBaseId: baseId, recoverySeconds: squad.reorganizationRemaining });
  events?.emit('message', notice ?? { key: 'friendly.notice.squadAnnihilatedRecovery', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}が壊滅しました。部隊枠を占有したまま長時間の再編成に入ります。` });
  return { ok: true, squad, recovery };
}

// Garrison squads caught in a base's fall scatter instead of fighting to the
// last, so their reorganization runs at a fraction of the battlefield
// annihilation timer. Losing the base itself is already the main penalty;
// this keeps unit slots from being double-locked for the full duration.
export const GARRISON_LOSS_RECOVERY_SCALE = 0.6;

function fallbackActiveMajorBase(state, referencePoint = null) {
  const bases = activePlayerBases(state);
  if (!bases.length) return null;
  if (!referencePoint) return bases.find(base => base.primary) ?? bases[0];
  return [...bases].sort((left, right) =>
    distanceSquared(left, referencePoint) - distanceSquared(right, referencePoint)
    || String(left.id).localeCompare(String(right.id)))[0];
}

export function reconcileSquadsWithLostBases(state, events = null) {
  // Enemy destruction of an owned base (destroyPlayerBase / destroyFieldBase,
  // anchored overruns, offline simulation, legacy saves) used to leave squads
  // referencing the fallen base forever: garrisoned READY squads had no update
  // path at all and RECOVERING squads could strand permanently. This pass runs
  // every simulation tick and applies one deterministic policy for all of
  // those routes: a garrison falls with its base and re-forms at the nearest
  // active major base, while squads in the field keep their mission but are
  // re-homed so returns and retreats resolve to a living base.
  ensureFriendlyForceState(state);
  const summary = { garrisonsLost: 0, rehomedSquads: 0 };
  for (const squad of state.combat.friendlySquads ?? []) {
    if (squad.hp <= 0) continue;
    const garrisoned = [FRIENDLY_SQUAD_STATUS.READY, FRIENDLY_SQUAD_STATUS.RECOVERING].includes(squad.status);
    if (garrisoned) {
      const garrisonBaseId = squad.recoveryBaseId ?? squad.originBaseId;
      if (ownedBaseById(state, garrisonBaseId)) continue;
      const lostBase = ownedBaseById(state, garrisonBaseId, { includeDestroyed: true });
      const fallback = fallbackActiveMajorBase(state, lostBase ?? friendlySquadPosition(state, squad));
      if (!fallback) continue; // total collapse is handled by home-base destruction
      squad.originBaseId = fallback.id;
      squad.recoveryBaseId = fallback.id;
      summary.garrisonsLost += 1;
      beginAnnihilationRecovery(state, squad, events, { recoveryScale: GARRISON_LOSS_RECOVERY_SCALE });
      events?.emit('friendly:garrison-lost-with-base', { squadId: squad.id, lostBaseId: garrisonBaseId, baseId: fallback.id });
      continue;
    }
    let rehomed = false;
    if (squad.originBaseId && !ownedBaseById(state, squad.originBaseId)) {
      const fallback = fallbackActiveMajorBase(state, friendlySquadPosition(state, squad));
      if (fallback) {
        squad.originBaseId = fallback.id;
        rehomed = true;
      }
    }
    if (squad.recoveryBaseId && !ownedBaseById(state, squad.recoveryBaseId)) {
      squad.recoveryBaseId = squad.originBaseId;
      rehomed = true;
    }
    if (rehomed) {
      summary.rehomedSquads += 1;
      events?.emit('friendly:squad-rehomed', { squadId: squad.id, baseId: squad.originBaseId });
    }
  }
  if (summary.garrisonsLost > 0) {
    events?.emit('message', {
      key: 'friendly.notice.garrisonLostWithBase',
      params: { count: summary.garrisonsLost },
      text: `拠点の陥落に巻き込まれ、駐留部隊${summary.garrisonsLost}隊が壊滅しました。後方の主要拠点で再編成に入ります。`
    });
  }
  return summary;
}

function canUseRoadsideSquadItem(squad, { allowTemporary = true } = {}) {
  return squad
    && squad.hp > 0
    && (allowTemporary || !squad.temporaryDeployment)
    && ![FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(squad.status);
}

function applyEmergencyWithdraw(state, squad, events = null) {
  if (!canUseRoadsideSquadItem(squad, { allowTemporary: false })) return { ok: false, reasonKey: 'reason.item.noWithdrawableSquad', reason: '撤退可能な通常味方部隊ではありません。' };
  clearEnemyEngagements(state, squad.id);
  squad.engagedEnemyId = null;
  if (!planReturn(state, squad)) return { ok: false, reasonKey: 'reason.item.withdrawRouteUnavailable', reason: '撤退経路を確保できません。' };
  squad.order = FRIENDLY_SQUAD_ORDER.WITHDRAW;
  squad.status = FRIENDLY_SQUAD_STATUS.WITHDRAWING;
  events?.emit('friendly:squad-emergency-withdraw', { squadId: squad.id });
  events?.emit('message', { key: 'friendly.notice.emergencyWithdraw', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}を緊急撤退させました。壊滅再編成を回避します。` });
  return { ok: true, squad };
}

function applySpeedBoostToSquads(state, targets, durationSeconds, multiplier = ROADSIDE_SPEED_BOOST_MULTIPLIER, events = null) {
  const activeTargets = targets.filter(squad => canUseRoadsideSquadItem(squad));
  if (!activeTargets.length) return { ok: false, reasonKey: 'reason.item.noBoostableSquad', reason: '加速可能な味方部隊がありません。' };
  const now = worldNow(state);
  for (const squad of activeTargets) {
    squad.roadsideSpeedBoostUntil = Math.max(Number(squad.roadsideSpeedBoostUntil) || 0, now + Math.max(1, Number(durationSeconds) || 1) * 1000);
    squad.roadsideSpeedBoostMultiplier = Math.max(Number(squad.roadsideSpeedBoostMultiplier) || 0, Math.max(0, Number(multiplier) || 0));
  }
  events?.emit('friendly:squad-speed-boosted', { squadIds: activeTargets.map(squad => squad.id), durationSeconds, multiplier });
  events?.emit('message', { key: 'friendly.notice.speedBoosted', params: { count: activeTargets.length }, text: `行軍加速旗で味方部隊${activeTargets.length}隊の移動速度を一時的に上げました。` });
  return { ok: true, squads: activeTargets };
}

export function emergencyWithdrawFriendlySquadById(state, squadId, events = null) {
  const squad = (state.combat?.friendlySquads ?? []).find(item => item.id === squadId) ?? null;
  if (!squad) return { ok: false, reasonKey: 'reason.item.selectedSquadMissing', reason: '選択中の味方部隊が見つかりません。' };
  return applyEmergencyWithdraw(state, squad, events);
}

export function emergencyWithdrawFriendlySquadNear(state, point, radiusMeters, events = null) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return { ok: false, reasonKey: 'reason.location.currentRequired', reason: '現在地を取得してください。' };
  const radius2 = Math.max(0, Number(radiusMeters) || 0) ** 2;
  const candidates = (state.combat?.friendlySquads ?? [])
    .filter(squad => canUseRoadsideSquadItem(squad, { allowTemporary: false }))
    .map(squad => ({ squad, d2: distanceSquared(friendlySquadPosition(state, squad), point) }))
    .filter(entry => entry.d2 <= radius2)
    .sort((a, b) => {
      const aPriority = [FRIENDLY_SQUAD_STATUS.ENGAGED, FRIENDLY_SQUAD_STATUS.ATTACKING_BASE].includes(a.squad.status) ? 0 : 1;
      const bPriority = [FRIENDLY_SQUAD_STATUS.ENGAGED, FRIENDLY_SQUAD_STATUS.ATTACKING_BASE].includes(b.squad.status) ? 0 : 1;
      return aPriority - bPriority || a.d2 - b.d2;
    });
  const squad = candidates[0]?.squad ?? null;
  if (!squad) return { ok: false, reasonKey: 'reason.item.noWithdrawableSquadNearby', reasonParams: { radius: Math.round(radiusMeters) }, reason: `半径${Math.round(radiusMeters)}m以内に撤退可能な味方部隊がありません。` };
  return applyEmergencyWithdraw(state, squad, events);
}

export function boostFriendlySquadById(state, squadId, durationSeconds, multiplier = ROADSIDE_SPEED_BOOST_MULTIPLIER, events = null) {
  const squad = (state.combat?.friendlySquads ?? []).find(item => item.id === squadId) ?? null;
  if (!squad) return { ok: false, reasonKey: 'reason.item.selectedSquadMissing', reason: '選択中の味方部隊が見つかりません。' };
  return applySpeedBoostToSquads(state, [squad], durationSeconds, multiplier, events);
}

export function boostFriendlySquadsNear(state, point, radiusMeters, durationSeconds, multiplier = ROADSIDE_SPEED_BOOST_MULTIPLIER, events = null) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return { ok: false, reasonKey: 'reason.location.currentRequired', reason: '現在地を取得してください。' };
  const radius2 = Math.max(0, Number(radiusMeters) || 0) ** 2;
  const targets = (state.combat?.friendlySquads ?? [])
    .filter(squad => canUseRoadsideSquadItem(squad))
    .map(squad => ({ squad, d2: distanceSquared(friendlySquadPosition(state, squad), point) }))
    .filter(entry => entry.d2 <= radius2)
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, 3)
    .map(entry => entry.squad);
  if (!targets.length) return { ok: false, reasonKey: 'reason.item.noBoostableSquadNearby', reasonParams: { radius: Math.round(radiusMeters) }, reason: `半径${Math.round(radiusMeters)}m以内に加速可能な味方部隊がありません。` };
  return applySpeedBoostToSquads(state, targets, durationSeconds, multiplier, events);
}

export class FriendlyForceSystem {
  constructor(events = null) {
    this.events = events;
  }

  previewDeployment(state, originBaseId, targetId, squadType = 'assault', targetKind = 'enemyBase', routeOverride = null) {
    return previewFriendlyDeployment(state, squadType, originBaseId, targetId, null, targetKind, routeOverride);
  }

  dispatch(state, originBaseId, targetId, squadType = 'assault', targetKind = 'enemyBase', routeOverride = null) {
    return dispatchFriendlySquad(state, squadType, originBaseId, targetId, this.events, targetKind, routeOverride);
  }

  previewCoordinatedDeployment(state, targetBaseId, squadTypes, options = null) {
    return previewCoordinatedDeployment(state, targetBaseId, squadTypes, options);
  }

  dispatchCoordinated(state, targetBaseId, squadTypes, options = null) {
    return dispatchCoordinatedSquads(state, targetBaseId, squadTypes, this.events, options);
  }

  rallyAll(state, targetBaseId) {
    return rallyReadySquadsToBase(state, targetBaseId, this.events);
  }

  queueDispatch(state, squadId, targetId, options = {}) {
    return queueFriendlyDispatch(state, squadId, targetId, this.events, options);
  }

  autoRepairPatrol(state, squadId, enabled = true) {
    return setEngineerAutoRepairPatrol(state, squadId, enabled, this.events);
  }

  allOutAssault(state, targetBaseId) {
    return allOutAssault(state, targetBaseId, this.events);
  }

  hold(state, squadId) {
    return holdFriendlySquad(state, squadId, this.events);
  }

  repairNearby(state, squadId) {
    return repairNearbyDefenseWithEngineer(state, squadId, this.events);
  }

  issueRouteOrder(state, squadId, order) {
    return issueFriendlyRouteOrder(state, squadId, order, this.events);
  }

  update(state, deltaSeconds, spatial, shouldUpdate = null) {
    reconcileSquadsWithLostBases(state, this.events);
    executeQueuedDispatches(state, this.events);
    const remove = new Set();
    for (const squad of state.combat.friendlySquads) {
      if (squad.hp <= 0) {
        if (squad.temporaryDeployment || friendlySquadRuntimeDefinition(state, squad.type, squad).missionKind === 'RECOVERY') {
          const dropped = releaseSquadRecoveryItem(state, squad, true);
          if (dropped) {
            this.events?.emit('friendly:recovery-item-dropped', { squadId: squad.id, itemId: dropped.id, position: recoveryItemPoint(state, dropped) });
            this.events?.emit('message', { key: 'friendly.notice.temporarySquadDroppedItem', text: '現地出撃部隊が壊滅し、特殊アイテムが道路上へ残されました。' });
          }
          remove.add(squad.id);
          this.events?.emit('message', squad.temporaryDeployment ? { key: 'friendly.notice.temporarySquadDestroyed', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}は壊滅し、現地出撃任務を終了しました。` } : { key: 'friendly.notice.squadDestroyed', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}が壊滅しました。` });
        } else {
          beginAnnihilationRecovery(state, squad, this.events);
        }
        continue;
      }
      if (shouldUpdate && !shouldUpdate(squad)) continue;
      const definition = friendlySquadRuntimeDefinition(state, squad.type, squad);
      synchronizeCarriedItem(state, squad);
      if (squad.status === FRIENDLY_SQUAD_STATUS.READY) continue;
      updateEngineerAutoRepairPatrol(state, squad, deltaSeconds, this.events);
      if (squad.status === FRIENDLY_SQUAD_STATUS.RECOVERING) {
        const recovery = updateFriendlyRecovery(state, squad, deltaSeconds, this.events);
        if (recovery.stranded) redirectRecoverySquadToMajorBase(state, squad, this.events);
        continue;
      }
      let activeSeconds = Math.max(0, Number(deltaSeconds) || 0);
      if (squad.departDelay > 0) {
        const waitingSeconds = Math.min(squad.departDelay, activeSeconds);
        squad.departDelay = Math.max(0, squad.departDelay - waitingSeconds);
        activeSeconds -= waitingSeconds;
        if (activeSeconds <= 1e-9) continue;
      }

      if (!rerouteFriendlySquadAroundBarriers(state, squad)) continue;

      if (squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT && squad.order === FRIENDLY_SQUAD_ORDER.ADVANCE) {
        const target = currentTargetEnemy(state, squad);
        if (!target) {
          planReturn(state, squad);
          continue;
        }
        const destinationNodeId = enemyPursuitNodeId(state, target);
        if (destinationNodeId && (squad.commandDestinationNodeId !== destinationNodeId || (!squad.path && squad.nodeId !== destinationNodeId))) {
          if (!replanIntercept(state, squad, target)) {
            squad.status = FRIENDLY_SQUAD_STATUS.STRANDED;
            squad.path = null;
            squad.edgeId = null;
            continue;
          }
        }
      }

      const evasive = [FRIENDLY_SQUAD_ORDER.RETREAT, FRIENDLY_SQUAD_ORDER.WITHDRAW].includes(squad.order);
      if (evasive) exposeEvasiveSquad(state, squad, definition, spatial);
      if (!evasive && updateEngagement(state, squad, definition, activeSeconds, spatial, this.events)) continue;
      if (squad.status === FRIENDLY_SQUAD_STATUS.ENGAGED) squad.status = statusForOrder(squad.order);
      updateNonCombatRecovery(squad, definition, activeSeconds);

      if (squad.order === FRIENDLY_SQUAD_ORDER.HOLD) {
        squad.status = FRIENDLY_SQUAD_STATUS.HALTED;
        if (squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY) {
          if (squad.targetRecoveryItemId && !currentRecoveryItem(state, squad)) planReturn(state, squad);
        } else if (squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT) {
          if (squad.targetEnemyId && !currentTargetEnemy(state, squad)) planReturn(state, squad);
        } else {
          const missionId = squad.missionTargetBaseId ?? squad.targetBaseId;
          if (missionId && !state.world.enemyBases.some(base => base.id === missionId && base.alive && base.hp > 0)) planReturn(state, squad);
        }
        continue;
      }

      if (squad.recoveryCollectionProgressSec != null || squad.status === FRIENDLY_SQUAD_STATUS.COLLECTING_ITEM) {
        updateRecoveryCollection(state, squad, definition, activeSeconds, this.events);
        continue;
      }

      if (squad.status === FRIENDLY_SQUAD_STATUS.ATTACKING_BASE) {
        attackEnemyBase(state, squad, definition, activeSeconds, this.events);
        continue;
      }
      if (squad.status === FRIENDLY_SQUAD_STATUS.STRANDED) {
        replanStranded(state, squad, this.events);
        continue;
      }

      const movement = advanceAlongPath(state, squad, definition, activeSeconds);
      if (movement.status === 'BROKEN') {
        squad.status = FRIENDLY_SQUAD_STATUS.STRANDED;
        squad.path = null;
        squad.edgeId = null;
        continue;
      }
      if (movement.status !== 'ARRIVED') continue;

      if ([FRIENDLY_SQUAD_ORDER.RETURN, FRIENDLY_SQUAD_ORDER.WITHDRAW].includes(squad.order)) {
        clearEnemyEngagements(state, squad.id);
        const recoveryBaseId = squad.recoveryBaseId ?? squad.originBaseId;
        if (squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY && squad.targetRecoveryItemId) {
          const item = currentRecoveryItem(state, squad);
          if (item?.status === RECOVERY_ITEM_STATUS.CARRIED) {
            const delivered = deliverRecoveryItem(state, item.id, squad.id);
            if (delivered.ok) {
              this.events?.emit('exploration:recovery-collected', delivered);
              const presentation = recoveryItemPresentation(item);
              const lootText = Object.keys(delivered.loot ?? {}).length ? ` 資源：${presentation.lootText}。` : '';
              this.events?.emit('message', { key: Object.keys(delivered.loot ?? {}).length ? 'friendly.notice.recoveryDeliveredWithLoot' : 'friendly.notice.recoveryDelivered', params: { itemName: presentation.name, resourceText: { __resourceBundle: true, bundle: delivered.loot ?? {} } }, text: `${presentation.name}を拠点へ持ち帰りました。${lootText}` });
            }
          } else releaseSquadRecoveryItem(state, squad);
          squad.targetRecoveryItemId = null;
          squad.recoveryCollectionProgressSec = null;
        }
        if (squad.temporaryDeployment) {
          remove.add(squad.id);
          this.events?.emit('friendly:squad-returned', { squadId: squad.id, originBaseId: recoveryBaseId, hp: squad.hp, temporary: true });
          this.events?.emit('message', { key: 'friendly.notice.temporarySquadCompleted', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}は現地出撃任務を完了し、解散しました。` });
          continue;
        }
        const recovery = beginFriendlyRecovery(state, squad, recoveryBaseId);
        if (!recovery.ok) {
          squad.status = FRIENDLY_SQUAD_STATUS.STRANDED;
          squad.path = null;
          squad.edgeId = null;
          continue;
        }
        this.events?.emit('friendly:squad-returned', { squadId: squad.id, originBaseId: recoveryBaseId, hp: squad.hp, withdrawal: squad.order === FRIENDLY_SQUAD_ORDER.WITHDRAW });
        this.events?.emit('message', recovery.profile?.kind === 'MAJOR'
          ? { key: 'friendly.notice.returnedMajorRecovery', text: '部隊が主要拠点へ帰還し、補給・回復・再編成を開始しました。' }
          : { key: 'friendly.notice.returnedFieldRecovery', text: '部隊が簡易拠点へ帰還し、再編成を開始しました。回復には回復施設の範囲内での待機が必要です。' });
      } else if (squad.order === FRIENDLY_SQUAD_ORDER.RETREAT) {
        squad.order = FRIENDLY_SQUAD_ORDER.HOLD;
        squad.heldOrder = FRIENDLY_SQUAD_ORDER.ADVANCE;
        squad.heldDestinationNodeId = squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY
          ? currentRecoveryItem(state, squad)?.nodeId ?? null
          : squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT
            ? enemyPursuitNodeId(state, currentTargetEnemy(state, squad))
            : state.world.enemyBases.find(base => base.id === (squad.missionTargetBaseId ?? squad.targetBaseId) && base.alive && base.hp > 0)?.nodeId ?? null;
        squad.status = FRIENDLY_SQUAD_STATUS.HALTED;
        squad.path = null;
        squad.edgeId = null;
        squad.edgeProgress = 0;
        this.events?.emit('message', { key: 'friendly.notice.retreatPointReached', text: '味方部隊が指定地点まで後退し、停止しました。' });
      } else if (squad.missionType === FRIENDLY_SQUAD_MISSION.RECOVERY) {
        squad.path = null;
        squad.edgeId = null;
        squad.edgeProgress = 0;
        squad.recoveryCollectionProgressSec = 0;
        updateRecoveryCollection(state, squad, definition, movement.remainingSeconds, this.events);
      } else if (squad.missionType === FRIENDLY_SQUAD_MISSION.INTERCEPT) {
        squad.path = null;
        squad.edgeId = null;
        squad.edgeProgress = 0;
        const target = currentTargetEnemy(state, squad);
        if (!target) planReturn(state, squad);
        else if (!replanIntercept(state, squad, target)) {
          squad.status = FRIENDLY_SQUAD_STATUS.STRANDED;
        }
      } else {
        attackEnemyBase(state, squad, definition, movement.remainingSeconds, this.events);
      }
    }
    if (remove.size) state.combat.friendlySquads = state.combat.friendlySquads.filter(squad => !remove.has(squad.id));
  }
}
