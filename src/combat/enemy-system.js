import { barrierEdgeProgress, defenseWorldPosition } from './combat-geometry.js';
import { distanceSquared, stableId, worldNow } from '../core/utilities.js';
import { addBundle } from '../civilization/inventory-system.js';
import { CITY_RECOVERY_DELAY_SECONDS, ENEMY_DEFINITIONS, MAX_ENEMIES, defenseRuntimeDefinition } from './definitions.js';
import { enemyPopulationCap, normalizeEnemyLevel, scaleEnemyDefinition } from './enemy-scaling.js';
import { enemyTotalPopulation, enemyUnitCount, enemyUnitHp, groupAttackMultiplier, mergeEnemyCohorts, normalizeEnemyGroup, setEnemyUnitCount } from './enemy-grouping.js';
import { findCombatPath, findCombatPathToTargets } from './routing-system.js';
import { reachableRoadNodeIds } from '../roads/road-graph.js';
import { roadUnitPosition } from './road-unit-position.js';
import { activeFieldBases, fieldBaseById } from '../base/field-bases.js';
import { activePlayerBases, playerBaseById } from '../base/player-bases.js';
import { activeSettlementAttackCounts, basePressureLoadPenaltySeconds, basePressureProfile } from '../base/base-pressure.js';
import { applyRegionControlEvent } from '../base/region-control.js';
import { destroyPlayerBase } from '../base/player-base-system.js';
import { enemyBehaviorForDefinition } from './enemy-personalities.js';
import { destroyFieldBase } from '../base/field-base-system.js';
import { FRIENDLY_SQUAD_DEFINITIONS, friendlySquadDefinition, friendlySquadRuntimeDefinition } from './friendly-force-definitions.js';
import { RECOVERY_BALANCE, beginEnemyRegroup } from '../core/recovery-balance.js';
import { detachDefense } from './defense-lifecycle.js';
import { applyHomeBaseDamage } from './operation-tempo.js';

const FACILITY_ATTACK_RANGE_METERS = 20;
const FACILITY_PRIORITY_PENALTY_SECONDS = 18;
const FIELD_BASE_PRIORITY_PENALTY_SECONDS = 20;
const FRIENDLY_SQUAD_ATTACK_RANGE_METERS = 24;
const DEFAULT_FACILITY_SEARCH_RADIUS_METERS = 480;
const DEFAULT_SQUAD_HUNT_RADIUS_METERS = 650;
const ROUTE_RECOVERY_RESET_SECONDS = 8;
const NO_ROUTE_RETIRE_SECONDS = 45;

function barrierContactDamageMultiplier(enemy, definition) {
  const contactDuration = Math.max(0, Number(enemy.contactDuration) || 0);
  const type = enemy?.type ?? '';
  const dps = Math.max(0, Number(definition?.barrierDps) || 0);
  const eliteBreacher = ['siegeBreaker', 'sapper', 'heavySiege', 'demolitionEngineer', 'mechanicalSiege', 'fortressBreaker'].includes(type) || dps >= 12;
  if (eliteBreacher) return 1 + Math.min(0.95, contactDuration / 36);
  if (['engineer', 'ropeCutter', 'heavy'].includes(type) || dps >= 5) return 1 + Math.min(0.45, contactDuration / 62);
  return 1 + Math.min(0.16, contactDuration / 120);
}


function barrierCrowdPressureMultiplier(state, enemy, barrier, barrierPosition) {
  if (!barrier?.edgeId) return 1;
  const currentProgress = Number(enemy.edgeProgress) || 0;
  let pressureUnits = enemyUnitCount(enemy);
  for (const other of state.combat?.enemies ?? []) {
    if (other === enemy || other.hp <= 0 || other.departDelay > 0 || other.edgeId !== barrier.edgeId) continue;
    const progress = Number(other.edgeProgress) || 0;
    if (progress < barrierPosition - 46 || progress > barrierPosition + 6) continue;
    pressureUnits += enemyUnitCount(other);
  }
  const rearCompression = Math.max(0, pressureUnits - enemyUnitCount(enemy));
  const contactBonus = currentProgress >= barrierPosition - 1.5 ? 0.15 : 0;
  return 1 + contactBonus + Math.min(0.85, rearCompression / 70);
}

function fortifiedDefenseDamageMultiplier(state) {
  const level = Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
  if (level < 5) return 1;
  const activeDefenses = (state.combat?.defenses ?? []).filter(defense => defense.hp > 0).length;
  const fortifiedThreshold = 18 + level * 7;
  const surplusRatio = Math.max(0, activeDefenses - fortifiedThreshold) / Math.max(1, fortifiedThreshold);
  return Math.max(0.72, 1 - Math.min(0.28, surplusRatio * 0.70));
}

function underbuiltBreakthroughMultiplier(state) {
  const level = Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
  if (level < 5) return 1;
  const activeDefenses = (state.combat?.defenses ?? []).filter(defense => defense.hp > 0).length;
  const expectedLine = (18 + level * 7) * 0.85;
  if (activeDefenses >= expectedLine) return 1;
  const deficitRatio = Math.max(0, expectedLine - activeDefenses) / Math.max(1, expectedLine);
  return 1 + Math.min(0.95, deficitRatio * 1.55);
}

function expansionBaseDamageMultiplier(state, base, kind) {
  if (!base?.id || base?.primary) return 1;
  const profile = basePressureProfile(state, base, kind);
  const rawRatio = Math.max(0, Math.min(1, Number(profile?.rawRatio ?? 1)));
  const minimum = kind === 'FIELD' ? 0.20 : 0.28;
  const offlineMultiplier = state?.runtime?.offlineSimulation ? 0.85 : 1;
  return Math.max(0.12, Math.min(1, (minimum + (1 - minimum) * rawRatio) * offlineMultiplier));
}

function sourceEnemyBaseForEnemy(state, enemy) {
  return (state.world?.enemyBases ?? []).find(base => base.id === enemy?.sourceBaseId) ?? null;
}

function baseNodePoint(state, base) {
  if (!base?.nodeId) return null;
  return state.world?.roadGraph?.nodeById?.get(base.nodeId) ?? null;
}

function localDefenseCount(state, base, radiusMeters = 360) {
  const point = baseNodePoint(state, base);
  if (!point) return 0;
  const radiusSquared = radiusMeters * radiusMeters;
  return (state.combat?.defenses ?? []).filter(defense => {
    if (defense.hp <= 0) return false;
    const node = defense.nodeId ? state.world?.roadGraph?.nodeById?.get(defense.nodeId) : null;
    if (!node) return false;
    return distanceSquared(point, node) <= radiusSquared;
  }).length;
}

function applyAnchoredOverrunDamage(state, anchorId, population, deltaSeconds, level, events = null) {
  const majorBase = playerBaseById(state, anchorId, { includeDestroyed: false });
  const fieldBase = majorBase ? null : fieldBaseById(state, anchorId, { includeDestroyed: false });
  const base = majorBase ?? fieldBase;
  if (!base || base.hp <= 0) return;
  const kind = fieldBase ? 'FIELD' : 'MAJOR';
  const expectedDefenses = kind === 'FIELD' ? 2 + Math.floor(level / 2) : 3 + level;
  const defenses = localDefenseCount(state, base);
  if (defenses >= expectedDefenses) return;
  const deficitRatio = Math.max(0, expectedDefenses - defenses) / Math.max(1, expectedDefenses);
  const pressureRatio = Math.min(1, Math.max(0, population - 4) / Math.max(8, 18 + level * 4));
  if (pressureRatio <= 0) return;
  const rawDamage = (level - 4) * deficitRatio * pressureRatio * 0.18 * Math.max(0, Number(deltaSeconds) || 0);
  const damage = rawDamage * expansionBaseDamageMultiplier(state, base, kind);
  if (damage <= 0) return;
  base.hp = Math.max(0, base.hp - damage);
  applyRegionControlEvent(state, base.id, -Math.min(0.045, damage / Math.max(1, Number(base.maxHp) || 1) * 0.35), { pressure: 0.035, incident: true });
  if (kind === 'FIELD') {
    events?.emit('combat:field-base-hit', { baseId: base.id, damage, rawDamage, enemyId: 'anchored-overrun', unitCount: population, pressure: true });
    if (base.hp <= 0) destroyFieldBase(state, base, events, { enemyId: 'anchored-overrun' });
  } else {
    events?.emit('combat:player-base-hit', { baseId: base.id, damage, rawDamage, enemyId: 'anchored-overrun', unitCount: population, pressure: true });
    if (base.hp <= 0) destroyPlayerBase(state, base, events, { enemyId: 'anchored-overrun' });
  }
}

function applyUnderbuiltOverrunPressure(state, deltaSeconds, events = null) {
  const level = Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
  if (level < 5 || !state.world?.city || state.world.city.hp <= 0) return;
  const activeDefenses = (state.combat?.defenses ?? []).filter(defense => defense.hp > 0).length;
  const expectedLine = (18 + level * 7) * 0.85;
  const populationByAnchor = new Map();
  let corePopulation = 0;
  for (const enemy of state.combat?.enemies ?? []) {
    if (!enemy || enemy.hp <= 0) continue;
    const units = enemyUnitCount(enemy);
    const sourceBase = sourceEnemyBaseForEnemy(state, enemy);
    const anchorId = enemy.frontlineAnchorBaseId ?? sourceBase?.frontlineAnchorBaseId ?? null;
    if (anchorId) populationByAnchor.set(anchorId, (populationByAnchor.get(anchorId) ?? 0) + units);
    else corePopulation += units;
  }
  for (const [anchorId, population] of populationByAnchor) {
    applyAnchoredOverrunDamage(state, anchorId, population, deltaSeconds, level, events);
  }
  if (activeDefenses >= expectedLine || corePopulation <= 0) return;
  const populationCap = Math.max(1, enemyPopulationCap(state));
  const pressureStart = populationCap * 0.45;
  if (corePopulation <= pressureStart) return;
  const deficitRatio = Math.max(0, expectedLine - activeDefenses) / Math.max(1, expectedLine);
  const pressureRatio = Math.max(0, corePopulation - pressureStart) / populationCap;
  const rawDamage = (level - 4) * deficitRatio * (0.34 + pressureRatio) * 0.34 * Math.max(0, Number(deltaSeconds) || 0);
  const damage = applyHomeBaseDamage(state, rawDamage);
  if (damage <= 0) return;
  state.combat.cityRecoveryCooldown = CITY_RECOVERY_DELAY_SECONDS;
  events?.emit('combat:city-hit', { damage, rawDamage, enemyId: 'underbuilt-overrun', unitCount: corePopulation, pressure: true });
}


function clearBarrierContact(enemy) {
  if (!enemy) return;
  enemy.contactKind = null;
  enemy.contactDefenseId = null;
  enemy.contactDuration = 0;
}

function stableRouteBias(text) {
  let hash = 2166136261;
  for (const character of String(text)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 0.86 + ((hash >>> 0) % 29) / 100;
}

export function enemyPosition(state, enemy) {
  return roadUnitPosition(state, enemy);
}

export function spawnEnemy(state, base, type, departDelay = 0, waveId = null, doctrineKey = 'frontal', options = {}) {
  const populationLimit = Math.min(MAX_ENEMIES, enemyPopulationCap(state));
  const currentPopulation = enemyTotalPopulation(state);
  if (currentPopulation >= populationLimit) return null;
  const baseDefinition = ENEMY_DEFINITIONS[type];
  if (!baseDefinition) return null;
  const requestedCount = Math.max(1, Math.floor(Number(options.unitCount) || 1));
  const unitCount = Math.min(requestedCount, Math.max(0, populationLimit - currentPopulation));
  if (unitCount <= 0) return null;
  const level = normalizeEnemyLevel(base.level);
  const definition = scaleEnemyDefinition(baseDefinition, level);
  const id = stableId('enemy', base.id, type, base.wavesSent, state.combat.enemies.length, unitCount, Math.round(departDelay * 100), worldNow(state));
  const enemy = {
    id,
    type, level, unitCount, maxUnitCount: unitCount, unitHp: definition.hp, hpPool: definition.hp * unitCount,
    hp: definition.hp * unitCount, maxHp: definition.hp * unitCount, radius: definition.radius, nodeId: base.nodeId,
    path: null, pathIndex: 0, edgeId: null, edgeProgress: 0,
    slowTimer: 0, slowMultiplier: 0.52, attackClock: 0, departDelay,
    sourceBaseId: base.id, frontlineAnchorBaseId: base.frontlineAnchorBaseId ?? null, waveId, doctrineKey, waveResolved: false, rewardGranted: false,
    reroutePending: false, routeFailureSeconds: 0, routeFailureTopologyRevision: null, routeRecoveryStage: 0, hasDeparted: false, routeBias: stableRouteBias(id), targetDefenseId: null, targetFieldBaseId: null, targetPlayerBaseId: null, targetSquadId: null,
    notifiedDefenseIds: [], engagedSquadId: null
  };
  state.combat.enemies.push(enemy);
  return enemy;
}

function activeTowerById(state, defenseId) {
  if (!defenseId) return null;
  return state.combat.defenses.find(defense =>
    defense.id === defenseId && defense.kind === 'tower' && defense.hp > 0
  ) ?? null;
}

function facilityTargetCandidates(state, definition, enemy) {
  const priorities = definition.targetPriorities ?? [];
  if (!priorities.length) return [];
  const rankByType = new Map(priorities.map((type, index) => [type, index]));
  const origin = enemyPosition(state, enemy);
  const maxDistance = Math.max(50, Number(definition.facilitySearchRadius) || DEFAULT_FACILITY_SEARCH_RADIUS_METERS);
  return state.combat.defenses
    .filter(defense => defense.kind === 'tower' && defense.hp > 0 && rankByType.has(defense.type))
    .filter(defense => {
      const node = state.world.roadGraph.nodeById.get(defense.nodeId);
      return node && distanceSquared(origin, node) <= maxDistance * maxDistance;
    })
    .map(defense => ({
      nodeId: defense.nodeId,
      targetObjectId: defense.id,
      priorityPenalty: rankByType.get(defense.type) * Math.max(0, Number(definition.facilityPriorityPenaltySeconds ?? FACILITY_PRIORITY_PENALTY_SECONDS))
    }));
}

function activeFieldBaseById(state, baseId) {
  return baseId ? fieldBaseById(state, baseId, { includeDestroyed: false }) : null;
}

function activeHuntSquadById(state, squadId, enemy = null, definition = null) {
  if (!squadId) return null;
  const squad = (state.combat.friendlySquads ?? []).find(item =>
    item.id === squadId && item.hp > 0 && !['RECOVERING', 'READY'].includes(item.status)
  ) ?? null;
  if (!squad || !enemy || !definition) return squad;
  const nodeId = squadTargetNodeId(state, squad);
  const node = nodeId ? state.world.roadGraph.nodeById.get(nodeId) : null;
  const maxDistance = Math.max(80, Number(definition.huntRadius) || DEFAULT_SQUAD_HUNT_RADIUS_METERS);
  return node && distanceSquared(enemyPosition(state, enemy), node) <= maxDistance * maxDistance ? squad : null;
}

function squadTargetNodeId(state, squad) {
  if (!squad) return null;
  if (squad.path?.nodeIds?.length) {
    const next = squad.path.nodeIds[Math.min(squad.pathIndex + 1, squad.path.nodeIds.length - 1)];
    if (next && state.world.roadGraph.nodeById.has(next)) return next;
  }
  return state.world.roadGraph.nodeById.has(squad.nodeId) ? squad.nodeId : null;
}

function friendlySquadTargetCandidates(state, enemy, definition) {
  const origin = enemyPosition(state, enemy);
  const maxDistance = Math.max(80, Number(definition.huntRadius) || DEFAULT_SQUAD_HUNT_RADIUS_METERS);
  return (state.combat.friendlySquads ?? [])
    .filter(squad => squad.hp > 0 && !['RECOVERING', 'READY'].includes(squad.status))
    .map(squad => ({ squad, nodeId: squadTargetNodeId(state, squad) }))
    .filter(entry => entry.nodeId && distanceSquared(origin, state.world.roadGraph.nodeById.get(entry.nodeId)) <= maxDistance * maxDistance)
    .map(({ squad, nodeId }) => ({
      nodeId,
      targetObjectId: `squad:${squad.id}`,
      priorityPenalty: squad.type === 'retrieval' ? 0 : 5
    }));
}

function planPath(state, enemy) {
  const definition = ENEMY_DEFINITIONS[enemy.type] ?? ENEMY_DEFINITIONS.infantry;
  const behavior = enemyBehaviorForDefinition(definition, enemy.doctrineKey);
  const nowMs = worldNow(state);
  if (enemy.roadsideLureNodeId && Number(enemy.roadsideLureUntil) > nowMs && state.world.roadGraph?.nodeById?.has(enemy.roadsideLureNodeId)) {
    const lurePath = findCombatPathToTargets(
      state,
      enemy.nodeId,
      [{ nodeId: enemy.roadsideLureNodeId, targetObjectId: 'roadside-lure', priorityPenalty: -180 }],
      enemy.type,
      enemy.routeBias ?? 1,
      enemy.level ?? 1,
      enemy.doctrineKey
    );
    if (lurePath) {
      enemy.targetDefenseId = null;
      enemy.targetFieldBaseId = null;
      enemy.targetPlayerBaseId = null;
      enemy.targetSquadId = null;
      return lurePath;
    }
  }
  enemy.roadsideLureNodeId = null;
  enemy.roadsideLureUntil = 0;
  enemy.roadsideLureMineId = null;
  if (definition.huntFriendlySquads || behavior.targetMode === 'SQUADS') {
    const squadPath = findCombatPathToTargets(
      state,
      enemy.nodeId,
      friendlySquadTargetCandidates(state, enemy, definition),
      enemy.type,
      enemy.routeBias ?? 1,
      enemy.level ?? 1,
      enemy.doctrineKey
    );
    if (squadPath?.targetObjectId?.startsWith('squad:')) {
      enemy.targetSquadId = squadPath.targetObjectId.slice(6);
      enemy.targetDefenseId = null;
      enemy.targetFieldBaseId = null;
      enemy.targetPlayerBaseId = null;
      return squadPath;
    }
  }
  enemy.targetSquadId = null;

  const targets = facilityTargetCandidates(state, definition, enemy);
  if (targets.length) {
    const facilityPath = findCombatPathToTargets(state, enemy.nodeId, targets, enemy.type, enemy.routeBias ?? 1, enemy.level ?? 1, enemy.doctrineKey);
    if (facilityPath) {
      enemy.targetDefenseId = facilityPath.targetObjectId;
      enemy.targetFieldBaseId = null;
      enemy.targetPlayerBaseId = null;
      return facilityPath;
    }
  }
  enemy.targetDefenseId = null;
  const raid = behavior.targetMode === 'BASES';
  const cityPenalty = Math.max(0, Number(definition.cityPriorityPenalty ?? 0)) + (raid ? 60 : 0);
  const fieldPenalty = Math.max(0, Number(definition.fieldBasePriorityPenalty ?? FIELD_BASE_PRIORITY_PENALTY_SECONDS)) + (raid ? 0 : 0);
  const majorPenalty = Math.max(0, Number(definition.majorBasePriorityPenalty ?? 14)) + (raid ? 0 : 0);
  const attackCounts = activeSettlementAttackCounts(state);
  const sourceBase = sourceEnemyBaseForEnemy(state, enemy);
  const anchorTargetId = enemy.frontlineAnchorBaseId ?? sourceBase?.frontlineAnchorBaseId ?? null;
  const anchorBias = -220;
  const majorTargets = activePlayerBases(state).filter(base => !base.primary).map(base => {
    const pressure = basePressureProfile(state, base, 'MAJOR');
    const currentAttackers = attackCounts.major.get(base.id) ?? 0;
    const localBias = anchorTargetId === base.id ? anchorBias : 0;
    return {
      nodeId: base.nodeId,
      targetObjectId: `major:${base.id}`,
      priorityPenalty: majorPenalty + pressure.targetPenaltySeconds + basePressureLoadPenaltySeconds(pressure, currentAttackers) + localBias
    };
  });
  const fieldTargets = activeFieldBases(state).map(base => {
    const pressure = basePressureProfile(state, base, 'FIELD');
    const currentAttackers = attackCounts.field.get(base.id) ?? 0;
    const localBias = anchorTargetId === base.id ? anchorBias : 0;
    return {
      nodeId: base.nodeId,
      targetObjectId: `field:${base.id}`,
      priorityPenalty: fieldPenalty + pressure.targetPenaltySeconds + basePressureLoadPenaltySeconds(pressure, currentAttackers) + localBias
    };
  });
  const settlementTargets = [
    { nodeId: state.world.city.nodeId, targetObjectId: 'city', priorityPenalty: cityPenalty },
    ...majorTargets,
    ...fieldTargets
  ];
  const path = findCombatPathToTargets(state, enemy.nodeId, settlementTargets, enemy.type, enemy.routeBias ?? 1, enemy.level ?? 1, enemy.doctrineKey);
  enemy.targetFieldBaseId = path?.targetObjectId?.startsWith('field:') ? path.targetObjectId.slice(6) : null;
  enemy.targetPlayerBaseId = path?.targetObjectId?.startsWith('major:') ? path.targetObjectId.slice(6) : null;
  return path;
}

function ensurePath(state, enemy) {
  if (enemy.targetDefenseId && !activeTowerById(state, enemy.targetDefenseId)) {
    enemy.targetDefenseId = null;
    enemy.reroutePending = true;
  }
  if (enemy.targetPlayerBaseId && !playerBaseById(state, enemy.targetPlayerBaseId, { includeDestroyed: false })) {
    enemy.targetPlayerBaseId = null;
    enemy.reroutePending = true;
  }
  if (enemy.targetFieldBaseId && !activeFieldBaseById(state, enemy.targetFieldBaseId)) {
    enemy.targetFieldBaseId = null;
    enemy.reroutePending = true;
  }
  const definition = ENEMY_DEFINITIONS[enemy.type] ?? ENEMY_DEFINITIONS.infantry;
  if (enemy.targetSquadId && !activeHuntSquadById(state, enemy.targetSquadId, enemy, definition)) {
    enemy.targetSquadId = null;
    enemy.reroutePending = true;
  }
  const targetSquad = activeHuntSquadById(state, enemy.targetSquadId, enemy, definition);
  const nowMs = worldNow(state);
  if (enemy.roadsideLureNodeId && Number(enemy.roadsideLureUntil) <= nowMs) {
    enemy.roadsideLureNodeId = null;
    enemy.roadsideLureUntil = 0;
    enemy.roadsideLureMineId = null;
    enemy.reroutePending = true;
  }
  const expectedTargetId = enemy.roadsideLureNodeId && state.world.roadGraph?.nodeById?.has(enemy.roadsideLureNodeId)
    ? enemy.roadsideLureNodeId
    : enemy.targetDefenseId
    ? activeTowerById(state, enemy.targetDefenseId)?.nodeId
    : enemy.targetPlayerBaseId
      ? playerBaseById(state, enemy.targetPlayerBaseId, { includeDestroyed: false })?.nodeId
      : enemy.targetFieldBaseId
        ? activeFieldBaseById(state, enemy.targetFieldBaseId)?.nodeId
        : targetSquad
        ? squadTargetNodeId(state, targetSquad)
        : state.world.city.nodeId;
  const currentPathValid = expectedTargetId && enemy.path?.targetId === expectedTargetId && enemy.pathIndex < enemy.path.edgeIds.length;
  if (currentPathValid && !enemy.reroutePending) return true;

  const currentEdgeLength = enemy.edgeId ? state.world.roadGraph.edgeById.get(enemy.edgeId)?.length ?? 0 : 0;
  if (enemy.path && enemy.edgeId && enemy.edgeProgress > 0 && enemy.edgeProgress < currentEdgeLength) {
    enemy.reroutePending = true;
    return true;
  }

  const path = planPath(state, enemy);
  enemy.path = path;
  enemy.pathIndex = 0;
  enemy.edgeId = path?.edgeIds[0] ?? null;
  enemy.edgeProgress = 0;
  enemy.reroutePending = false;
  return Boolean(path);
}

function attackTargetFacility(state, enemy, definition, deltaSeconds, events) {
  const target = activeTowerById(state, enemy.targetDefenseId);
  if (!target) return false;
  const node = state.world.roadGraph.nodeById.get(target.nodeId);
  if (!node || distanceSquared(enemyPosition(state, enemy), node) > FACILITY_ATTACK_RANGE_METERS * FACILITY_ATTACK_RANGE_METERS) return false;

  enemy.notifiedDefenseIds ??= [];
  if (!enemy.notifiedDefenseIds.includes(target.id)) {
    enemy.notifiedDefenseIds.push(target.id);
    if ((definition.stunSeconds ?? 0) > 0) {
      target.disabledTimer = Math.max(target.disabledTimer ?? 0, definition.stunSeconds);
    }
    events?.emit('message', { key: 'enemy.notice.facilityAttacking', params: { enemyName: definition.name }, text: definition.attackMessage ?? `${definition.name}が防衛施設を攻撃しています。` });
  }

  target.hp -= Math.max(0.1, definition.facilityDps ?? definition.barrierDps ?? 1) * groupAttackMultiplier(enemy, 'facility') * deltaSeconds * fortifiedDefenseDamageMultiplier(state) * underbuiltBreakthroughMultiplier(state);
  if (target.hp > 0) return true;

  target.hp = 0;
  const destroyed = detachDefense(state, target.id) ?? target;
  beginEnemyRegroup(state, RECOVERY_BALANCE.defenseBreakthroughRegroupSeconds);
  events?.emit('combat:defense-destroyed', { defenseId: destroyed.id, defense: destroyed, position: node });
  events?.emit('message', { key: 'enemy.notice.defenseDestroyedRemoved', params: { facilityName: defenseRuntimeDefinition(destroyed).name ?? '防衛施設' }, text: `${defenseRuntimeDefinition(destroyed).name ?? '防衛施設'}が破壊され、建設地点から撤去されました。` });
  return true;
}

function resolveWaveUnits(state, enemy, breached, unitCount = 1, countOutcome = true) {
  if (!enemy.waveId) return;
  const record = state.combat.waves.active?.[enemy.waveId];
  if (!record) return;
  const units = Math.max(1, Math.floor(Number(unitCount) || 1));
  record.remaining = Math.max(0, record.remaining - units);
  if (breached) record.breached = true;
  if (record.remaining > 0) return;
  delete state.combat.waves.active[enemy.waveId];
}

function multiplyBundle(bundle, multiplier) {
  const factor = Math.max(1, Math.floor(Number(multiplier) || 1));
  if (factor <= 1) return bundle;
  return Object.fromEntries(Object.entries(bundle ?? {}).map(([key, value]) => [key, Math.max(0, Number(value) || 0) * factor]));
}

function resolveWaveEnemy(state, enemy, breached, countOutcome = true, unitCount = null) {
  if (!enemy.waveId || enemy.waveResolved) return;
  enemy.waveResolved = true;
  resolveWaveUnits(state, enemy, breached, unitCount ?? enemyUnitCount(enemy), countOutcome);
}

export function damageEnemy(state, enemy, amount, events = null, spatial = null) {
  normalizeEnemyGroup(enemy);
  if (enemy.hp <= 0 || enemy.rewardGranted) return false;
  let finalAmount = Math.max(0, Number(amount) || 0);
  if (!(ENEMY_DEFINITIONS[enemy.type]?.shieldAura > 0)) {
    const position = spatial?.positions?.get(enemy.id) ?? enemyPosition(state, enemy);
    const shieldCandidates = spatial ? spatial.query(position, 24) : state.combat.enemies.map(other => ({ enemy: other, position: enemyPosition(state, other) }));
    let strongestShield = 0;
    for (const entry of shieldCandidates) {
      const other = entry.enemy;
      const shield = Math.max(0, Math.min(0.8, Number(ENEMY_DEFINITIONS[other.type]?.shieldAura) || 0));
      const range = Math.max(1, Number(ENEMY_DEFINITIONS[other.type]?.shieldRange) || 14);
      if (other !== enemy && other.hp > 0 && shield > 0 && distanceSquared(entry.position, position) <= range * range) strongestShield = Math.max(strongestShield, shield);
    }
    if (strongestShield > 0) finalAmount *= 1 - strongestShield;
  }
  const unitHp = enemyUnitHp(enemy);
  const beforeCount = enemyUnitCount(enemy);
  enemy.hpPool = Math.max(0, Number(enemy.hpPool ?? enemy.hp) - finalAmount);
  enemy.hp = enemy.hpPool;
  const afterCount = enemy.hpPool > 0 ? Math.max(1, Math.ceil(enemy.hpPool / unitHp)) : 0;
  const killedUnits = Math.max(0, beforeCount - afterCount);
  if (killedUnits > 0) {
    const definition = ENEMY_DEFINITIONS[enemy.type];
    const sourceBase = state.world.enemyBases.find(base => base.id === enemy.sourceBaseId);
    for (let index = 0; index < killedUnits; index += 1) {
      let drops = { ...(definition.drops ?? {}) };
      if (['miner', 'oreCarrier'].includes(enemy.type)) {
        if (sourceBase?.type === 'tinCamp') drops = { stone: drops.stone ?? 2, tinOre: Math.max(1, drops.tinOre ?? 1) };
        if (sourceBase?.type === 'ironCamp') drops = { stone: drops.stone ?? 2, ironOre: Math.max(1, drops.ironOre ?? 1) };
      }
      const rewardMultiplier = Math.max(1, Math.floor(Number(enemy.siegeRewardMultiplier) || 1));
      drops = multiplyBundle(drops, rewardMultiplier);
      addBundle(state, drops);
      resolveWaveUnits(state, enemy, false, 1);
      state.statistics.kills += 1;
      const siegeProgressBonus = Math.max(0, Math.floor(Number(enemy.siegeProgressKillBonus) || 0));
      if (siegeProgressBonus > 0) {
        state.civilization ??= {};
        state.civilization.progress ??= {};
        state.civilization.progress.siegeBonusKills = Math.max(0, Math.floor(Number(state.civilization.progress.siegeBonusKills) || 0)) + siegeProgressBonus;
      }
      if (['siegeCaptain', 'steelCaptain', 'machineCommander', 'royalCommander'].includes(enemy.type)) {
        state.civilization.progress.bossesDefeated[enemy.type] = (state.civilization.progress.bossesDefeated[enemy.type] ?? 0) + 1;
      }
      events?.emit('combat:enemy-killed', { enemyId: enemy.id, position: enemyPosition(state, enemy), type: enemy.type, drops, unitCount: beforeCount });
    }
  }
  if (afterCount > 0) {
    enemy.unitCount = afterCount;
    enemy.maxHp = unitHp * afterCount;
    enemy.hp = Math.max(0, Math.min(enemy.hpPool, enemy.maxHp));
    return false;
  }
  enemy.hp = 0;
  enemy.hpPool = 0;
  enemy.unitCount = 0;
  enemy.rewardGranted = true;
  enemy.waveResolved = true;
  return true;
}



function activeFriendlySquadById(state, squadId) {
  if (!squadId) return null;
  return (state.combat.friendlySquads ?? []).find(squad => squad.id === squadId && squad.hp > 0) ?? null;
}

function destroyFriendlySquad(state, squad, squadPoint, events) {
  squad.hp = 0;
  for (const other of state.combat.enemies) {
    if (other.engagedSquadId === squad.id) other.engagedSquadId = null;
  }
  events?.emit('friendly:squad-destroyed', { squadId: squad.id, position: squadPoint, originBaseId: squad.originBaseId });
  events?.emit('message', { key: 'friendly.notice.squadWipedOut', params: { squadName: friendlySquadDefinition(squad.type).name }, text: `${friendlySquadDefinition(squad.type).name}が全滅しました。` });
}

function applyFriendlyDamage(state, squad, amount, events) {
  if (!squad || squad.hp <= 0 || amount <= 0) return;
  const definition = friendlySquadDefinition(squad.type);
  squad.combatCooldown = Math.max(squad.combatCooldown ?? 0, definition.recoveryDelaySeconds ?? 0);
  squad.hp = Math.max(0, squad.hp - amount);
  if (squad.hp <= 0) destroyFriendlySquad(state, squad, roadUnitPosition(state, squad), events);
}

function nearbyHeavyGuard(state, protectedSquad, protectedPoint) {
  if (protectedSquad.type === 'heavy') return null;
  const definition = FRIENDLY_SQUAD_DEFINITIONS.heavy;
  return (state.combat.friendlySquads ?? [])
    .filter(squad => squad.id !== protectedSquad.id && squad.type === 'heavy' && squad.hp > 0 && !['RECOVERING', 'READY'].includes(squad.status))
    .map(squad => ({ squad, gapSquared: distanceSquared(roadUnitPosition(state, squad), protectedPoint) }))
    .filter(entry => entry.gapSquared <= definition.guardRange * definition.guardRange)
    .sort((a, b) => a.gapSquared - b.gapSquared)[0]?.squad ?? null;
}

function acquireHuntEngagement(state, enemy, definition) {
  if (!definition.huntFriendlySquads || enemy.engagedSquadId) return;
  const squad = activeHuntSquadById(state, enemy.targetSquadId, enemy, definition);
  if (!squad) return;
  if (distanceSquared(enemyPosition(state, enemy), roadUnitPosition(state, squad)) > FRIENDLY_SQUAD_ATTACK_RANGE_METERS * FRIENDLY_SQUAD_ATTACK_RANGE_METERS) return;
  enemy.engagedSquadId = squad.id;
  squad.engagedEnemyId ??= enemy.id;
}

function attackFriendlySquad(state, enemy, definition, deltaSeconds, events) {
  const squad = activeFriendlySquadById(state, enemy.engagedSquadId);
  if (!squad) {
    enemy.engagedSquadId = null;
    return false;
  }
  const enemyPoint = enemyPosition(state, enemy);
  const squadPoint = roadUnitPosition(state, squad);
  if (distanceSquared(enemyPoint, squadPoint) > FRIENDLY_SQUAD_ATTACK_RANGE_METERS * FRIENDLY_SQUAD_ATTACK_RANGE_METERS) {
    enemy.engagedSquadId = null;
    if (squad.engagedEnemyId === enemy.id) squad.engagedEnemyId = null;
    return false;
  }
  const fieldDps = Math.max(1, (definition.cityDamage ?? 4) * 0.32 + (definition.barrierDps ?? 1) * 0.22);
  const squadRuntime = friendlySquadRuntimeDefinition(state, squad.type, squad);
  const totalDamage = fieldDps * groupAttackMultiplier(enemy, 'friendly') * Math.max(0.5, Number(squadRuntime.incomingDamageMultiplier) || 1) * deltaSeconds;
  const guard = nearbyHeavyGuard(state, squad, squadPoint);
  if (guard) {
    const guardDefinition = FRIENDLY_SQUAD_DEFINITIONS.heavy;
    const redirected = totalDamage * guardDefinition.guardShare;
    applyFriendlyDamage(state, guard, redirected, events);
    applyFriendlyDamage(state, squad, totalDamage - redirected, events);
  } else {
    applyFriendlyDamage(state, squad, totalDamage, events);
  }
  return true;
}

function sourceNodeIdForEnemy(state, enemy) {
  const enemyBase = (state.world.enemyBases ?? []).find(base => base.id === enemy.sourceBaseId && base.alive);
  if (enemyBase?.nodeId && state.world.roadGraph.nodeById.has(enemyBase.nodeId)) return enemyBase.nodeId;
  const frontierSource = (state.world.frontierSources ?? []).find(source => source.id === enemy.sourceBaseId && source.status !== 'CLEARED');
  if (frontierSource?.entryNodeId && state.world.roadGraph.nodeById.has(frontierSource.entryNodeId)) return frontierSource.entryNodeId;
  return null;
}

function settlementNodeIds(state) {
  return [
    state.world.city?.nodeId,
    ...activePlayerBases(state).map(base => base.nodeId),
    ...activeFieldBases(state).map(base => base.nodeId)
  ].filter(Boolean);
}

function clearEnemyStrategicTargets(enemy) {
  enemy.targetDefenseId = null;
  enemy.targetFieldBaseId = null;
  enemy.targetPlayerBaseId = null;
  enemy.targetSquadId = null;
  enemy.path = null;
  enemy.pathIndex = 0;
  enemy.edgeId = null;
  enemy.edgeProgress = 0;
  enemy.reroutePending = true;
}

function relocateWaitingEnemyToCurrentSource(state, enemy) {
  const hasDeparted = enemy.hasDeparted === true
    || (Number(enemy.pathIndex) || 0) > 0
    || (Number(enemy.edgeProgress) || 0) > 0;
  if (hasDeparted || enemy.edgeId) return false;
  const sourceNodeId = sourceNodeIdForEnemy(state, enemy);
  if (!sourceNodeId || sourceNodeId === enemy.nodeId) return false;
  enemy.nodeId = sourceNodeId;
  clearEnemyStrategicTargets(enemy);
  enemy.routeFailureSeconds = 0;
  enemy.routeFailureTopologyRevision = Math.max(1, Math.floor(Number(state.world.roadGraph.topologyRevision) || 1));
  enemy.routeRecoveryStage = 1;
  return true;
}

function routeFailureCanRetire(state, enemy) {
  const graph = state.world.roadGraph;
  const reachable = reachableRoadNodeIds(graph, settlementNodeIds(state));
  const sourceNodeId = sourceNodeIdForEnemy(state, enemy);
  return !reachable.has(enemy.nodeId) && (!sourceNodeId || !reachable.has(sourceNodeId));
}

export class EnemySystem {
  constructor(events) { this.events = events; }

  invalidateAllPaths(state) {
    for (const enemy of state.combat.enemies) enemy.reroutePending = true;
  }

  updateEnemy(state, enemy, deltaSeconds, frame) {
    let remainingSeconds = Math.max(0, Number(deltaSeconds) || 0);
    if (enemy.departDelay > 0) {
      const waitingSeconds = Math.min(enemy.departDelay, remainingSeconds);
      enemy.departDelay = Math.max(0, enemy.departDelay - waitingSeconds);
      enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - waitingSeconds);
      remainingSeconds -= waitingSeconds;
      if (remainingSeconds <= 1e-9) return false;
    }

    normalizeEnemyGroup(enemy);
    const baseDefinition = ENEMY_DEFINITIONS[enemy.type] ?? ENEMY_DEFINITIONS.infantry;
    enemy.radius = Math.max(1, Number(enemy.radius) || Number(baseDefinition.radius) || 5);
    enemy.doctrineKey ??= 'frontal';
    enemy.targetDefenseId ??= null;
    enemy.targetFieldBaseId ??= null;
    enemy.targetPlayerBaseId ??= null;
    enemy.targetSquadId ??= null;
    const definition = scaleEnemyDefinition(baseDefinition, enemy.level ?? 1);

    acquireHuntEngagement(state, enemy, definition);
    if (attackFriendlySquad(state, enemy, definition, remainingSeconds, this.events)) {
      enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - remainingSeconds);
      return false;
    }
    if (attackTargetFacility(state, enemy, definition, remainingSeconds, this.events)) {
      enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - remainingSeconds);
      return false;
    }

    let transitions = 0;
    while (remainingSeconds > 1e-9 && transitions < 4096) {
      let routeReady = ensurePath(state, enemy) && Boolean(enemy.edgeId);
      if (!routeReady) {
        const topologyRevision = Math.max(1, Math.floor(Number(state.world.roadGraph.topologyRevision) || 1));
        if (enemy.routeFailureTopologyRevision !== topologyRevision) {
          enemy.routeFailureTopologyRevision = topologyRevision;
          enemy.routeFailureSeconds = 0;
          enemy.routeRecoveryStage = 0;
          enemy.reroutePending = true;
          routeReady = ensurePath(state, enemy) && Boolean(enemy.edgeId);
        }
      }
      if (!routeReady) {
        enemy.routeFailureSeconds = Math.max(0, Number(enemy.routeFailureSeconds) || 0) + remainingSeconds;
        enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - remainingSeconds);

        if (enemy.routeFailureSeconds >= ROUTE_RECOVERY_RESET_SECONDS && (enemy.routeRecoveryStage ?? 0) < 1) {
          clearEnemyStrategicTargets(enemy);
          enemy.routeRecoveryStage = 1;
          routeReady = ensurePath(state, enemy) && Boolean(enemy.edgeId);
        }
        if (!routeReady && enemy.routeFailureSeconds >= ROUTE_RECOVERY_RESET_SECONDS && relocateWaitingEnemyToCurrentSource(state, enemy)) {
          routeReady = ensurePath(state, enemy) && Boolean(enemy.edgeId);
        }
        if (routeReady) {
          enemy.routeFailureSeconds = 0;
          enemy.routeRecoveryStage = 0;
        } else if (enemy.waveId && enemy.routeFailureSeconds >= NO_ROUTE_RETIRE_SECONDS && routeFailureCanRetire(state, enemy)) {
          resolveWaveEnemy(state, enemy, false, false);
          this.events?.emit('combat:enemy-route-abandoned', { enemyId: enemy.id, sourceBaseId: enemy.sourceBaseId, reason: 'disconnected-road-fragment' });
          return true;
        } else {
          return false;
        }
      }
      enemy.routeFailureSeconds = 0;
      enemy.routeRecoveryStage = 0;
      const graph = state.world.roadGraph;
      const edge = graph.edgeById.get(enemy.edgeId);
      if (!edge) { enemy.path = null; return false; }

      const barrier = frame.barriers.get(edge.id) ?? null;
      const barrierPosition = barrier ? barrierEdgeProgress(graph, barrier) : edge.length * 0.5;
      const atBarrier = barrier && enemy.edgeProgress >= barrierPosition - 1 && enemy.edgeProgress <= barrierPosition + 2;
      if (atBarrier) {
        enemy.contactKind = barrier.isGate ? 'gate' : 'wall';
        enemy.contactDefenseId = barrier.id;
        const timeToStrike = Math.max(0, 0.5 - (Number(enemy.attackClock) || 0));
        if (remainingSeconds + 1e-9 < timeToStrike) {
          enemy.attackClock = (Number(enemy.attackClock) || 0) + remainingSeconds;
          enemy.contactDuration = Math.max(0, Number(enemy.contactDuration) || 0) + remainingSeconds;
          enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - remainingSeconds);
          return false;
        }
        remainingSeconds = Math.max(0, remainingSeconds - timeToStrike);
        enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - timeToStrike);
        enemy.contactDuration = Math.max(0, Number(enemy.contactDuration) || 0) + timeToStrike + 0.5;
        enemy.attackClock = 0;
        barrier.hp -= definition.barrierDps * barrierContactDamageMultiplier(enemy, definition) * barrierCrowdPressureMultiplier(state, enemy, barrier, barrierPosition) * groupAttackMultiplier(enemy, 'barrier') * 0.5 * fortifiedDefenseDamageMultiplier(state) * underbuiltBreakthroughMultiplier(state);
        if (barrier.hp > 0) continue;
        barrier.hp = 0;
        const destroyed = detachDefense(state, barrier.id) ?? barrier;
        beginEnemyRegroup(state, RECOVERY_BALANCE.defenseBreakthroughRegroupSeconds);
        frame.barriers.delete(edge.id);
        clearBarrierContact(enemy);
        this.invalidateAllPaths(state);
        this.events?.emit('combat:defense-destroyed', { defenseId: destroyed.id, defense: destroyed, position: defenseWorldPosition(graph, destroyed) });
        this.events?.emit('message', { key: 'enemy.notice.roadDefenseDestroyedRemoved', params: { facilityName: destroyed.isGate ? '門' : '防壁' }, text: `${destroyed.isGate ? '門' : '防壁'}が破壊され、道路から撤去されました。` });
        continue;
      }

      clearBarrierContact(enemy);
      let commandMultiplier = 1;
      const position = enemyPosition(state, enemy);
      for (const entry of frame.spatial.speedAuras ?? frame.spatial.commanders ?? []) {
        if (entry.enemy.id === enemy.id || entry.enemy.hp <= 0) continue;
        const auraDefinition = ENEMY_DEFINITIONS[entry.enemy.type] ?? {};
        const aura = Math.max(0, Number(auraDefinition.speedAura ?? auraDefinition.commanderAura) || 0);
        const range = Math.max(1, Number(auraDefinition.auraRange) || 35);
        if (aura > 0 && distanceSquared(entry.position, position) <= range * range) commandMultiplier = Math.max(commandMultiplier, 1 + aura);
      }
      const slowBase = enemy.slowMultiplier ?? 0.52;
      const slowMultiplier = enemy.slowTimer > 0
        ? 1 - (1 - slowBase) * (1 - (definition.slowResistance ?? 0))
        : 1;
      const movementSpeed = Math.max(0.001, definition.speed * commandMultiplier * slowMultiplier);
      const slowWindow = enemy.slowTimer > 0 ? Math.min(remainingSeconds, enemy.slowTimer) : remainingSeconds;

      if (barrier && enemy.edgeProgress < barrierPosition - 1) {
        const distanceToBarrier = barrierPosition - 1 - enemy.edgeProgress;
        const timeToBarrier = distanceToBarrier / movementSpeed;
        if (timeToBarrier <= slowWindow + 1e-9) {
          enemy.edgeProgress = barrierPosition - 1;
          enemy.hasDeparted = true;
          remainingSeconds = Math.max(0, remainingSeconds - timeToBarrier);
          enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - timeToBarrier);
          continue;
        }
      }

      const distanceToNode = Math.max(0, edge.length - enemy.edgeProgress);
      const timeToNode = distanceToNode / movementSpeed;
      if (timeToNode > slowWindow + 1e-9) {
        enemy.edgeProgress += movementSpeed * slowWindow;
        enemy.hasDeparted = true;
        remainingSeconds = Math.max(0, remainingSeconds - slowWindow);
        enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - slowWindow);
        continue;
      }

      enemy.edgeProgress = edge.length;
      enemy.hasDeparted = true;
      remainingSeconds = Math.max(0, remainingSeconds - timeToNode);
      enemy.slowTimer = Math.max(0, (enemy.slowTimer ?? 0) - timeToNode);
      enemy.nodeId = enemy.path.nodeIds[enemy.pathIndex + 1];
      enemy.pathIndex += 1;
      enemy.edgeProgress = 0;
      transitions += 1;

      if (enemy.roadsideLureNodeId && enemy.nodeId === enemy.roadsideLureNodeId) {
        enemy.roadsideLureNodeId = null;
        enemy.roadsideLureUntil = 0;
        enemy.roadsideLureMineId = null;
        enemy.path = null;
        enemy.pathIndex = 0;
        enemy.edgeId = null;
        enemy.reroutePending = true;
        continue;
      }

      if (enemy.reroutePending && enemy.nodeId !== enemy.path.targetId) {
        enemy.path = null;
        enemy.pathIndex = 0;
        enemy.edgeId = null;
        enemy.reroutePending = false;
        continue;
      }

      if (enemy.nodeId === enemy.path.targetId && enemy.targetPlayerBaseId) {
        const majorBase = playerBaseById(state, enemy.targetPlayerBaseId, { includeDestroyed: false });
        if (majorBase && majorBase.nodeId === enemy.path.targetId) {
          const rawDamage = definition.cityDamage * groupAttackMultiplier(enemy, 'settlement');
          const damage = rawDamage * expansionBaseDamageMultiplier(state, majorBase, 'MAJOR');
          majorBase.hp = Math.max(0, majorBase.hp - damage);
          applyRegionControlEvent(state, majorBase.id, -Math.min(0.04, damage / Math.max(1, Number(majorBase.maxHp) || 1) * 0.32), { pressure: 0.035, incident: true });
          this.events?.emit('combat:player-base-hit', { baseId: majorBase.id, damage, rawDamage, enemyId: enemy.id, unitCount: enemyUnitCount(enemy) });
          if (majorBase.hp <= 0) destroyPlayerBase(state, majorBase, this.events, { enemyId: enemy.id });
          resolveWaveEnemy(state, enemy, true);
          return true;
        }
        enemy.targetPlayerBaseId = null;
        enemy.path = null;
        enemy.edgeId = null;
        continue;
      }

      if (enemy.nodeId === enemy.path.targetId && enemy.targetFieldBaseId) {
        const fieldBase = activeFieldBaseById(state, enemy.targetFieldBaseId);
        if (fieldBase && fieldBase.nodeId === enemy.path.targetId) {
          const rawDamage = definition.cityDamage * groupAttackMultiplier(enemy, 'settlement');
          const damage = rawDamage * expansionBaseDamageMultiplier(state, fieldBase, 'FIELD');
          fieldBase.hp = Math.max(0, fieldBase.hp - damage);
          applyRegionControlEvent(state, fieldBase.id, -Math.min(0.05, damage / Math.max(1, Number(fieldBase.maxHp) || 1) * 0.40), { pressure: 0.045, incident: true });
          this.events?.emit('combat:field-base-hit', { baseId: fieldBase.id, damage, rawDamage, enemyId: enemy.id, unitCount: enemyUnitCount(enemy) });
          if (fieldBase.hp <= 0) destroyFieldBase(state, fieldBase, this.events, { enemyId: enemy.id });
          resolveWaveEnemy(state, enemy, true);
          return true;
        }
        enemy.targetFieldBaseId = null;
        enemy.path = null;
        enemy.edgeId = null;
        continue;
      }

      if (enemy.nodeId === enemy.path.targetId && enemy.path.targetId === state.world.city.nodeId) {
        const rawCityDamage = definition.cityDamage * groupAttackMultiplier(enemy, 'settlement');
        const cityDamage = applyHomeBaseDamage(state, rawCityDamage);
        const primaryBase = activePlayerBases(state).find(base => base.primary) ?? null;
        applyRegionControlEvent(state, primaryBase?.id, -Math.min(0.035, cityDamage / Math.max(1, Number(state.world.city.maxHp) || 1) * 0.30), { pressure: 0.04, incident: true });
        state.combat.cityRecoveryCooldown = CITY_RECOVERY_DELAY_SECONDS;
        if ((definition.settlementDamage ?? 0) > 0) {
          state.combat.pendingSettlementDamage ??= [];
          state.combat.pendingSettlementDamage.push({ enemyId: enemy.id, enemyType: enemy.type, damage: definition.settlementDamage * groupAttackMultiplier(enemy, 'settlement') });
        }
        resolveWaveEnemy(state, enemy, true);
        this.events?.emit('combat:city-hit', { damage: cityDamage, rawDamage: rawCityDamage, enemyId: enemy.id, unitCount: enemyUnitCount(enemy) });
        return true;
      }

      if (enemy.pathIndex >= enemy.path.edgeIds.length) {
        enemy.edgeId = null;
        return false;
      }
      enemy.edgeId = enemy.path.edgeIds[enemy.pathIndex];
    }
    return false;
  }

  update(state, deltaSeconds, spatial = null, shouldUpdate = null) {
    if (!spatial) {
      const positions = new Map();
      const commanders = [];
      const speedAuras = [];
      const entries = [];
      for (const enemy of state.combat.enemies) {
        if (enemy.hp <= 0 || enemy.departDelay > 0) continue;
        const position = enemyPosition(state, enemy);
        const entry = { enemy, position };
        positions.set(enemy.id, position);
        entries.push(entry);
        if (enemy.type === 'commander') commanders.push(entry);
        const auraDefinition = ENEMY_DEFINITIONS[enemy.type] ?? {};
        if ((auraDefinition.speedAura ?? auraDefinition.commanderAura ?? 0) > 0) speedAuras.push(entry);
      }
      spatial = {
        positions,
        commanders,
        speedAuras,
        query(point, range) {
          const limit = range * range;
          return entries.filter(entry => {
            const dx = entry.position.x - point.x;
            const dy = entry.position.y - point.y;
            return dx * dx + dy * dy <= limit;
          });
        }
      };
    }
    const barriers = new Map();
    for (const defense of state.combat.defenses) {
      if (defense.kind === 'barrier' && defense.hp > 0) barriers.set(defense.edgeId, defense);
    }
    const frame = { spatial, barriers };
    const remove = new Set();
    for (const enemy of state.combat.enemies) {
      if (enemy.hp <= 0 || enemyUnitCount(enemy) <= 0) { remove.add(enemy.id); continue; }
      if (shouldUpdate && !shouldUpdate(enemy)) continue;
      if (this.updateEnemy(state, enemy, deltaSeconds, frame)) remove.add(enemy.id);
    }
    if (remove.size > 0) state.combat.enemies = state.combat.enemies.filter(enemy => !remove.has(enemy.id) && enemy.hp > 0);
    applyUnderbuiltOverrunPressure(state, deltaSeconds, this.events);
    state.combat.cohortRegroupClock = Math.max(0, Number(state.combat.cohortRegroupClock) || 0) + Math.max(0, Number(deltaSeconds) || 0);
    if (state.combat.cohortRegroupClock >= 0.75) {
      const civilizationLevel = Math.max(0, Math.floor(Number(state.civilization?.level) || 0));
      mergeEnemyCohorts(state, { maxMergedCount: civilizationLevel >= 6 ? 112 : civilizationLevel === 5 ? 72 : civilizationLevel >= 4 ? 52 : 40 });
      state.combat.cohortRegroupClock = 0;
    }
  }
}
