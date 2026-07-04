import { stableId, worldNow } from '../core/utilities.js';
import { ENEMY_BASE_DEFINITIONS, ENEMY_DEFINITIONS, ENEMY_GENERATIONS } from './definitions.js';
import { spawnEnemy } from './enemy-system.js';
import { enemyGroupLimitForState, enemyUnitCount } from './enemy-grouping.js';
import { enemyBaseLevelForState, enemyDensityForState, expandedWaveSize, waveIntervalForBase } from './enemy-scaling.js';
import { INITIAL_BASE_TYPES, selectEnemyBaseNode } from './enemy-base-placement.js';
import { enemyBehaviorForDefinition, waveDoctrineDefinition } from './enemy-personalities.js';
import { enemyRegroupActive } from '../core/recovery-balance.js';
import { OPERATION_TEMPO_CONFIG, operationActiveWaveLimit, operationWaveIntervalMultiplier } from './operation-tempo.js';
import { activePlayerBases } from '../base/player-bases.js';
import { activeFieldBases } from '../base/field-bases.js';
import { basePressureProfile } from '../base/base-pressure.js';
import { REGION_SIMULATION_MODE, anchorIdForEnemyBaseRegion, enemyBaseSpawnIntervalMultiplierForRegion, frontlineSlotCapForRegion, regionProfileForBase } from '../base/region-control.js';

export { INITIAL_BASE_TYPES } from './enemy-base-placement.js';

const OPENING_WAVE_INTERVAL_MULTIPLIER = 1.35;
const OPENING_ACTIVE_WAVE_LIMIT = 2;
const OPENING_GRACE_SECONDS = 15 * 60;
const WAVE_SPAWN_RETRY_SECONDS = 12;

function activeEnemyBaseWaveCount(state) {
  return Object.values(state.combat?.waves?.active ?? {})
    .filter(wave => (wave?.remaining ?? 0) > 0 && !wave?.frontierSourceId)
    .length;
}

export function activeEnemyBaseWaveCountForState(state) {
  return activeEnemyBaseWaveCount(state);
}

export function reconcileActiveWaveRecords(state) {
  state.combat.waves ??= { active: {} };
  state.combat.waves.active ??= {};
  const liveCounts = new Map();
  const representative = new Map();
  for (const enemy of state.combat.enemies ?? []) {
    if (enemy.hp <= 0 || enemy.waveResolved || !enemy.waveId) continue;
    liveCounts.set(enemy.waveId, (liveCounts.get(enemy.waveId) ?? 0) + enemyUnitCount(enemy));
    if (!representative.has(enemy.waveId)) representative.set(enemy.waveId, enemy);
  }
  for (const [waveId, record] of Object.entries(state.combat.waves.active)) {
    const remaining = liveCounts.get(waveId) ?? 0;
    if (remaining <= 0) delete state.combat.waves.active[waveId];
    else record.remaining = remaining;
  }
  for (const [waveId, remaining] of liveCounts) {
    if (state.combat.waves.active[waveId]) continue;
    const enemy = representative.get(waveId);
    const frontierSource = (state.world.frontierSources ?? []).find(source => source.id === enemy?.sourceBaseId) ?? null;
    state.combat.waves.active[waveId] = {
      id: waveId,
      baseId: enemy?.sourceBaseId ?? null,
      frontierSourceId: enemy?.frontierSourceId ?? frontierSource?.id ?? null,
      remaining,
      breached: false,
      guard: Boolean(enemy?.waveGuard),
      doctrineKey: enemy?.doctrineKey ?? 'frontal',
      startedAt: Number(enemy?.waveStartedAt) || worldNow(state),
      recovered: true
    };
  }
  return state.combat.waves.active;
}


function openingPressureLimited(state) {
  if (Math.max(0, Math.floor(Number(state.civilization?.level) || 0)) !== 0) return false;
  const createdAt = Number(state.runtime?.createdAt) || worldNow(state);
  const worldTime = Number(state.runtime?.worldTimeMs) || createdAt;
  return Math.max(0, worldTime - createdAt) < OPENING_GRACE_SECONDS * 1000;
}


function deterministicIndex(text, length) {
  let hash = 2166136261;
  for (const character of text) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return length ? (hash >>> 0) % length : 0;
}

export function waveDoctrineForBase(state, base, guard = false) {
  if (guard) return waveDoctrineDefinition('guard');
  const level = Math.max(0, Math.floor(Number(state.civilization?.level) || 0));
  const available = ['frontal'];
  if (level >= 1) available.push('flank', 'raid');
  if (level >= 2) available.push('breach');
  if (level >= 3) available.push('support');
  if (level >= 4) available.push('hunt');
  const key = available[deterministicIndex(`${base.id}:${base.wavesSent}:doctrine:${level}`, available.length)];
  return waveDoctrineDefinition(key);
}

function doctrinePool(pool, doctrine) {
  const preferred = new Set(doctrine.preferredPersonalities ?? []);
  const matching = pool.filter(type => preferred.has(enemyBehaviorForDefinition(ENEMY_DEFINITIONS[type]).personalityKey));
  return matching.length ? matching : pool;
}

export function enemyGenerationMix(state) {
  const generation = Math.max(0, Math.floor(Number(state.civilization.level) || 0));
  if (generation <= 0) return { generation: 0, probability: 0 };
  const nowMs = worldNow(state);
  const elapsed = nowMs - (Number(state.civilization.completedAt) || nowMs);
  if (elapsed < 60 * 60 * 1000) return { generation, probability: 0 };
  if (elapsed < 3 * 60 * 60 * 1000) return { generation, probability: 0.25 };
  if (elapsed < 6 * 60 * 60 * 1000) return { generation, probability: 0.50 };
  if (elapsed < 12 * 60 * 60 * 1000) return { generation, probability: 0.75 };
  return { generation, probability: 1 };
}

function levelWave(definition, base) {
  const level = Math.max(1, Math.min(8, Math.floor(Number(base.level) || 1)));
  const initial = [...(definition.waves[1] ?? [])];
  const desiredCount = initial.length + level - 1;
  const template = [...(definition.waves[Math.min(level, 3)] ?? initial)];
  const reinforcementPool = [
    ...(definition.waves[3] ?? []),
    ...(definition.waves[2] ?? []),
    ...initial
  ];
  const wave = template.length > desiredCount && desiredCount > 1
    ? [...template.slice(0, desiredCount - 1), template.at(-1)]
    : template.slice(0, desiredCount);
  while (wave.length < desiredCount && reinforcementPool.length) {
    const index = deterministicIndex(`${base.id}:${base.wavesSent}:${level}:reinforcement:${wave.length}`, reinforcementPool.length);
    wave.push(reinforcementPool[index]);
  }
  return wave;
}

export function waveForBase(state, base, doctrineKey = null) {
  const definition = ENEMY_BASE_DEFINITIONS[base.type];
  if (!definition) return [];
  const wave = levelWave(definition, base);
  const doctrine = doctrineKey ? waveDoctrineDefinition(doctrineKey) : waveDoctrineForBase(state, base);
  const mix = enemyGenerationMix(state);
  if (mix.generation <= 0 || wave.length === 0) return wave;
  const current = ENEMY_GENERATIONS[mix.generation] ?? [];
  const previous = Object.entries(ENEMY_GENERATIONS)
    .filter(([generation]) => Number(generation) > 0 && Number(generation) < mix.generation)
    .flatMap(([, values]) => values);
  if (mix.probability <= 0 && previous.length === 0) return wave;
  const replacementSlots = Math.min(wave.length, 1 + Math.floor(Math.max(1, Number(base.level) || 1) / 2));
  for (let index = 0; index < Math.min(replacementSlots, wave.length); index += 1) {
    const roll = deterministicIndex(`${base.id}:${base.wavesSent}:${index}:roll`, 1000) / 1000;
    const rawPool = current.length && roll < mix.probability ? current : previous;
    const pool = doctrinePool(rawPool, doctrine);
    if (!pool.length) continue;
    const type = pool[deterministicIndex(`${base.id}:${base.wavesSent}:${index}:${doctrine.key}:type`, pool.length)];
    wave[wave.length - 1 - index] = type;
  }
  return wave;
}

export const CORE_ENEMY_BASE_CAP = 10;
export const MAX_ACTIVE_ENEMY_BASES = 64;

export function enemyBaseTypesForCivilization(level) {
  const normalized = Math.max(0, Math.min(7, Math.floor(Number(level) || 0)));
  const types = [...INITIAL_BASE_TYPES];
  if (normalized >= 2) types.push('copperCamp', 'tinCamp');
  if (normalized >= 3) types.push('ironCamp');
  if (normalized >= 3 && normalized < 5) types.push('bronzeCamp');
  if (normalized >= 3 && normalized < 6) types.push('siegeWorks');
  if (normalized >= 5) types.push('steelCamp');
  if (normalized >= 6) types.push('machineWorks');
  if (normalized >= 7) types.push('commandFortress');
  return [...new Set(types)].slice(0, CORE_ENEMY_BASE_CAP);
}

export function unlockedBaseTypes(state) {
  return enemyBaseTypesForCivilization(state.civilization.level ?? 0);
}

const ENEMY_BASE_REPLACEMENTS = Object.freeze([
  Object.freeze({ level: 5, from: 'bronzeCamp', to: 'steelCamp' }),
  Object.freeze({ level: 6, from: 'siegeWorks', to: 'machineWorks' })
]);

const FRONTLINE_MAX_SLOTS_BY_KIND = Object.freeze({ MAJOR: 3, FIELD: 2 });

function activeEnemyBaseCount(state) {
  return (state.world?.enemyBases ?? []).filter(base => base.alive).length;
}

function activeExpansionBases(state) {
  return [
    ...activePlayerBases(state).filter(base => !base.primary).map(base => ({ ...base, frontlineKind: 'MAJOR' })),
    ...activeFieldBases(state).map(base => ({ ...base, frontlineKind: 'FIELD' }))
  ].filter(base => base?.id && base.nodeId);
}

function pruneStaleFrontlineEnemyNetwork(state) {
  const activeAnchorIds = new Set(activeExpansionBases(state).map(base => base.id));
  let changed = false;
  for (const base of state.world?.enemyBases ?? []) {
    if (!base.frontlineAnchorBaseId || activeAnchorIds.has(base.frontlineAnchorBaseId)) continue;
    if (base.alive || base.hp > 0) changed = true;
    base.alive = false;
    base.hp = 0;
    base.destroyed = false;
    base.retired = true;
    base.retiredAt = worldNow(state);
  }
  if (Array.isArray(state.world?.baseRespawns)) {
    const before = state.world.baseRespawns.length;
    state.world.baseRespawns = state.world.baseRespawns.filter(respawn => !respawn.frontlineAnchorBaseId || activeAnchorIds.has(respawn.frontlineAnchorBaseId));
    if (state.world.baseRespawns.length !== before) changed = true;
  }
  if (changed && state.combat?.waves) state.combat.waves.enemyBaseNetworkDirty = true;
  return changed;
}

function frontlineKindForAnchor(anchorBase) {
  return anchorBase?.frontlineKind === 'FIELD' || String(anchorBase?.kind ?? '').toUpperCase() === 'FIELD'
    ? 'FIELD'
    : 'MAJOR';
}

function frontlineSlotCountForAnchor(state, anchorBase) {
  const kind = frontlineKindForAnchor(anchorBase);
  const maxSlots = FRONTLINE_MAX_SLOTS_BY_KIND[kind] ?? FRONTLINE_MAX_SLOTS_BY_KIND.MAJOR;
  const profile = basePressureProfile(state, anchorBase, kind);
  const ratio = Math.max(0, Math.min(1, Number(profile?.rawRatio ?? 1)));
  if (maxSlots <= 1) return 1;
  const naturalSlots = ratio >= 0.70 ? maxSlots : ratio >= 0.35 ? Math.min(maxSlots, 2) : 1;
  return frontlineSlotCapForRegion(state, anchorBase, naturalSlots);
}

function pruneSuppressedFrontlineSlots(state) {
  const anchors = new Map(activeExpansionBases(state).map(base => [base.id, base]));
  let changed = false;
  for (const base of state.world?.enemyBases ?? []) {
    if (!base?.frontlineAnchorBaseId) continue;
    const anchor = anchors.get(base.frontlineAnchorBaseId);
    const slotCount = anchor ? frontlineSlotCountForAnchor(state, anchor) : 0;
    const slotIndex = Math.max(0, Number(base.frontlineSlotIndex) || 0);
    if (base.alive && slotIndex >= slotCount) {
      base.alive = false;
      base.hp = 0;
      base.destroyed = false;
      base.retired = true;
      base.retiredAt = worldNow(state);
      changed = true;
    }
  }
  if (Array.isArray(state.world?.baseRespawns)) {
    const before = state.world.baseRespawns.length;
    state.world.baseRespawns = state.world.baseRespawns.filter(respawn => {
      if (!respawn.frontlineAnchorBaseId) return true;
      const anchor = anchors.get(respawn.frontlineAnchorBaseId);
      const slotCount = anchor ? frontlineSlotCountForAnchor(state, anchor) : 0;
      return Math.max(0, Number(respawn.frontlineSlotIndex) || 0) < slotCount;
    });
    if (state.world.baseRespawns.length !== before) changed = true;
  }
  if (changed && state.combat?.waves) state.combat.waves.enemyBaseNetworkDirty = true;
  return changed;
}

function frontlineSlotPotential(state) {
  return activeExpansionBases(state).reduce((sum, base) => sum + frontlineSlotCountForAnchor(state, base), 0);
}

export function maxActiveEnemyBases(state) {
  const core = unlockedBaseTypes(state).length;
  const expansionSlots = frontlineSlotPotential(state);
  return Math.max(core, Math.min(MAX_ACTIVE_ENEMY_BASES, core + expansionSlots));
}

function desiredEnemyBaseCount(state) {
  return Math.min(maxActiveEnemyBases(state), unlockedBaseTypes(state).length + frontlineSlotPotential(state));
}

function frontlineSlotOccupied(state, anchorBaseId, slotIndex) {
  const normalizedSlot = Math.max(0, Number(slotIndex) || 0);
  const alive = (state.world?.enemyBases ?? []).some(base => base.alive && base.frontlineAnchorBaseId === anchorBaseId && Math.max(0, Number(base.frontlineSlotIndex) || 0) === normalizedSlot);
  if (alive) return true;
  return (state.world?.baseRespawns ?? []).some(respawn => respawn.frontlineAnchorBaseId === anchorBaseId && Math.max(0, Number(respawn.frontlineSlotIndex) || 0) === normalizedSlot);
}

function frontlineAnchorOccupancy(state, anchorBaseId) {
  const slots = new Set();
  for (const base of state.world?.enemyBases ?? []) {
    if (base.alive && base.frontlineAnchorBaseId === anchorBaseId) slots.add(Math.max(0, Number(base.frontlineSlotIndex) || 0));
  }
  for (const respawn of state.world?.baseRespawns ?? []) {
    if (respawn.frontlineAnchorBaseId === anchorBaseId) slots.add(Math.max(0, Number(respawn.frontlineSlotIndex) || 0));
  }
  return slots.size;
}

function frontlineSlotRequests(state) {
  const now = worldNow(state);
  const bases = activeExpansionBases(state);
  const requests = [];
  for (const anchorBase of bases) {
    const slotCount = frontlineSlotCountForAnchor(state, anchorBase);
    const occupancy = frontlineAnchorOccupancy(state, anchorBase.id);
    const activeSince = Math.max(0, Number(anchorBase?.rebuiltAt) || 0, Number(anchorBase?.establishedAt) || 0);
    const ageSeconds = activeSince > 0 ? Math.max(0, (now - activeSince) / 1000) : Number.POSITIVE_INFINITY;
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      if (frontlineSlotOccupied(state, anchorBase.id, slotIndex)) continue;
      requests.push({ anchorBase, slotIndex, occupancy, ageSeconds });
    }
  }
  return requests.sort((a, b) =>
    a.slotIndex - b.slotIndex
    || a.occupancy - b.occupancy
    || a.ageSeconds - b.ageSeconds
    || String(a.anchorBase.id).localeCompare(String(b.anchorBase.id))
  );
}

function activeEnemyBaseWaveCountForAnchor(state, anchorBaseId) {
  if (!anchorBaseId) return 0;
  const sourceById = new Map((state.world?.enemyBases ?? []).map(base => [base.id, base]));
  return Object.values(state.combat?.waves?.active ?? {})
    .filter(wave => (wave?.remaining ?? 0) > 0)
    .filter(wave => sourceById.get(wave?.baseId)?.frontlineAnchorBaseId === anchorBaseId)
    .length;
}

function enemyBaseRegionProfile(state, base) {
  const anchorId = anchorIdForEnemyBaseRegion(state, base);
  return anchorId ? regionProfileForBase(state, anchorId) : null;
}

function activeSecuredCoreWaveCount(state) {
  const sourceById = new Map((state.world?.enemyBases ?? []).map(base => [base.id, base]));
  return Object.values(state.combat?.waves?.active ?? {})
    .filter(wave => (wave?.remaining ?? 0) > 0)
    .filter(wave => {
      const base = sourceById.get(wave?.baseId);
      if (!base || base.frontlineAnchorBaseId) return false;
      return enemyBaseRegionProfile(state, base)?.simulationMode === REGION_SIMULATION_MODE.SECURED;
    })
    .length;
}

function securedCoreBasesForProfile(state, profile) {
  if (!profile || profile.simulationMode !== REGION_SIMULATION_MODE.SECURED) return [];
  return (state.world?.enemyBases ?? [])
    .filter(base => base?.alive && !base.frontlineAnchorBaseId && enemyBaseRegionProfile(state, base)?.anchorBaseId === profile.anchorBaseId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function securedCoreBaseIsDormant(state, base) {
  if (base?.frontlineAnchorBaseId) return false;
  const profile = enemyBaseRegionProfile(state, base);
  if (!profile || profile.simulationMode !== REGION_SIMULATION_MODE.SECURED) return false;
  if (profile.enemyPressure >= 0.62 || profile.control < 0.78) return false;
  const securedCores = securedCoreBasesForProfile(state, profile);
  const activeCore = securedCores[0] ?? null;
  return activeCore && activeCore.id !== base.id;
}

function enemyBaseActiveWaveLimit(state) {
  const baseLimit = operationActiveWaveLimit(state);
  if (state?.runtime?.offlineSimulation) return baseLimit;
  const expansionBonus = Math.ceil(activeExpansionBases(state).length / 2);
  return Math.min(28, baseLimit + expansionBonus);
}

function perAnchorActiveWaveLimit(state, anchorBase) {
  const kind = frontlineKindForAnchor(anchorBase);
  const profile = basePressureProfile(state, anchorBase, kind);
  return Number(profile?.rawRatio ?? 0) >= 0.70 ? 2 : 1;
}

function frontlineBaseTypeForAnchor(state, anchorBase, index) {
  const available = unlockedBaseTypes(state);
  if (!available.length) return null;
  const preferredByCivilization = Math.max(0, Math.floor(Number(state.civilization?.level) || 0)) >= 2
    ? available
    : available.filter(type => INITIAL_BASE_TYPES.includes(type));
  const pool = preferredByCivilization.length ? preferredByCivilization : available;
  let hash = 2166136261;
  for (const character of `${anchorBase.id}:${anchorBase.nodeId}:${index}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return pool[(hash >>> 0) % pool.length];
}

function markEnemyBaseNetworkClean(state) {
  if (state.combat?.waves) state.combat.waves.enemyBaseNetworkDirty = false;
}
function recordFrontlinePlacementDeferred(state, anchorBase, slotIndex, type, events = null) {
  state.runtime ??= {};
  state.runtime.frontlinePlacementDeferrals ??= {};
  const key = `${anchorBase?.id ?? 'unknown'}:${slotIndex}:${type}`;
  const now = worldNow(state);
  const record = state.runtime.frontlinePlacementDeferrals[key] ?? { count: 0, lastMessageAt: 0 };
  record.count += 1;
  record.lastAttemptAt = now;
  if (now - (Number(record.lastMessageAt) || 0) >= 15 * 60 * 1000) {
    record.lastMessageAt = now;
    events?.emit('message', {
      key: 'enemyBase.placementDeferred',
      params: { baseName: anchorBase?.name ?? '新設拠点' },
      text: `${anchorBase?.name ?? '新設拠点'}周辺の敵拠点配置を保留しました。周辺道路の取得後に再試行します。`
    });
  }
  state.runtime.frontlinePlacementDeferrals[key] = record;
}


function transformEnemyBase(base, targetType) {
  const definition = ENEMY_BASE_DEFINITIONS[targetType];
  if (!definition) return false;
  const oldMaximum = Math.max(1, Number(base.maxHp) || 120);
  const healthRatio = Math.max(0, Math.min(1, Number(base.hp ?? oldMaximum) / oldMaximum));
  base.upgradedFromType ??= base.type;
  base.type = targetType;
  base.maxHp = definition.isResourceBase ? 120 : 100;
  base.hp = Math.max(1, Math.round(base.maxHp * healthRatio));
  base.alive = true;
  base.destroyed = false;
  base.retired = false;
  base.spawnClock = Math.max(0, definition.interval - definition.firstDelay);
  base.wavesSent = 0;
  base.guardWaveTriggered = false;
  return true;
}

export function synchronizeEnemyBaseNetwork(state, events = null) {
  state.world.enemyBases ??= [];
  state.world.baseRespawns ??= [];
  pruneStaleFrontlineEnemyNetwork(state);
  pruneSuppressedFrontlineSlots(state);
  const level = Math.max(0, Math.floor(Number(state.civilization?.level) || 0));
  for (const replacement of ENEMY_BASE_REPLACEMENTS) {
    if (level < replacement.level) continue;
    const current = state.world.enemyBases.find(base => base.type === replacement.to && base.alive) ?? null;
    const obsolete = state.world.enemyBases.filter(base => base.type === replacement.from && base.alive);
    if (!current && obsolete.length) {
      const converted = obsolete.shift();
      transformEnemyBase(converted, replacement.to);
      events?.emit('message', { key: 'enemyBase.reorganized', params: { fromName: ENEMY_BASE_DEFINITIONS[replacement.from].name, toName: ENEMY_BASE_DEFINITIONS[replacement.to].name }, text: `${ENEMY_BASE_DEFINITIONS[replacement.from].name}が${ENEMY_BASE_DEFINITIONS[replacement.to].name}へ再編されました。` });
    }
    for (const base of obsolete) {
      base.alive = false;
      base.hp = 0;
      base.retired = true;
      base.destroyed = false;
    }
    const targetExists = state.world.enemyBases.some(base => base.type === replacement.to && base.alive);
    let targetPending = state.world.baseRespawns.some(respawn => respawn.baseType === replacement.to);
    const nextRespawns = [];
    for (const respawn of state.world.baseRespawns) {
      if (respawn.baseType !== replacement.from) {
        nextRespawns.push(respawn);
        continue;
      }
      if (targetExists || targetPending) continue;
      respawn.baseType = replacement.to;
      targetPending = true;
      nextRespawns.push(respawn);
    }
    state.world.baseRespawns = nextRespawns;
  }
  return state.world.enemyBases;
}

function uniqueEnemyBaseId(state, type, idSeed) {
  const existing = new Set((state.world?.enemyBases ?? []).map(base => base.id).filter(Boolean));
  let suffix = 0;
  while (suffix < 1000) {
    const seed = suffix <= 0 ? idSeed : `${idSeed}:${suffix}`;
    const id = stableId('enemy_base', type, seed);
    if (!existing.has(id)) return id;
    suffix += 1;
  }
  // Deterministic last-resort suffix: online play replays commands from a
  // shared log, so simulation code must never draw from Math.random.
  return stableId('enemy_base', type, idSeed, state.runtime?.worldTimeMs ?? 0, state.world?.enemyBases?.length ?? 0, 'overflow');
}

export function createBase(state, type, placement, idSeed = placement.node.id, metadata = {}) {
  const definition = ENEMY_BASE_DEFINITIONS[type];
  const slotIndex = Number.isInteger(metadata.frontlineSlotIndex) ? metadata.frontlineSlotIndex : null;
  const operationWarmupSeconds = Math.max(0, Number(metadata.operationWarmupSeconds) || 0);
  const now = worldNow(state);
  return {
    id: uniqueEnemyBaseId(state, type, idSeed), type, nodeId: placement.node.id,
    x: placement.node.x,
    y: placement.node.y,
    hp: definition.isResourceBase ? 120 : 100,
    maxHp: definition.isResourceBase ? 120 : 100,
    alive: true,
    level: 1, ageSeconds: 0,
    spawnClock: metadata.frontlineAnchorBaseId ? 0 : definition.interval - definition.firstDelay - (placement.initialDelayBonusSec ?? 0),
    initialDelayBonusSec: placement.initialDelayBonusSec ?? 0,
    frontPressureMultiplier: placement.frontPressureMultiplier ?? 1,
    frontlineFirstWaveReadyAt: metadata.frontlineAnchorBaseId && operationWarmupSeconds > 0 ? now + operationWarmupSeconds * 1000 : null,
    wavesSent: 0, routeDistance: placement.route,
    frontlineAnchorBaseId: metadata.frontlineAnchorBaseId ?? null,
    frontlineAnchorNodeId: metadata.frontlineAnchorNodeId ?? placement.anchorNodeId ?? null,
    frontlineSlotIndex: slotIndex
  };
}

export function spawnEnemyBaseGuard(state, base, events = null) {
  if (!base?.alive || base.guardWaveTriggered) return 0;
  const spawned = new WaveSystem(events).spawnWave(state, base, true);
  if (spawned > 0) {
    base.guardWaveTriggered = true;
    events?.emit('message', { key: 'enemyBase.guardStarted', params: { enemyBaseName: ENEMY_BASE_DEFINITIONS[base.type].name }, text: `${ENEMY_BASE_DEFINITIONS[base.type].name}の守備隊が迎撃を開始しました。` });
  }
  return spawned;
}


function garbageCollectEnemyBases(state) {
  const bases = state.world?.enemyBases;
  if (!Array.isArray(bases) || bases.length <= 0) return 0;
  const liveSourceIds = new Set((state.combat?.enemies ?? []).filter(enemy => enemy.hp > 0).map(enemy => enemy.sourceBaseId).filter(Boolean));
  const recoverySourceIds = new Set((state.world?.recoveryItems ?? [])
    .filter(item => item && item.status !== 'COLLECTED')
    .map(item => item.sourceBaseId)
    .filter(Boolean));
  const respawnSourceIds = new Set((state.world?.baseRespawns ?? []).map(respawn => respawn.sourceBaseId).filter(Boolean));
  const before = bases.length;
  state.world.enemyBases = bases.filter(base => {
    if (base?.alive || Number(base?.hp) > 0) return true;
    if (liveSourceIds.has(base.id) || recoverySourceIds.has(base.id) || respawnSourceIds.has(base.id)) return true;
    return !(base.destroyed || base.retired);
  });
  return before - state.world.enemyBases.length;
}

export class WaveSystem {
  constructor(events) { this.events = events; }

  spawnWave(state, base, guard = false, options = {}) {
    const doctrine = waveDoctrineForBase(state, base, guard);
    const baseWave = waveForBase(state, base, doctrine.key);
    const density = enemyDensityForState(state);
    const desiredSize = guard ? baseWave.length : expandedWaveSize(state, baseWave.length);
    const wave = Array.from({ length: desiredSize }, (_, index) => baseWave[index % Math.max(1, baseWave.length)]).filter(Boolean);
    state.combat.waves.active ??= {};
    const siegeEventId = options?.siegeEventId ? String(options.siegeEventId) : null;
    const rewardMultiplier = Math.max(1, Math.floor(Number(options?.rewardMultiplier) || 1));
    const progressKillBonus = Math.max(0, Math.floor(Number(options?.progressKillBonus) || 0));
    const waveId = siegeEventId
      ? stableId('siege_wave', siegeEventId, base.id, base.wavesSent, worldNow(state))
      : stableId('wave', base.id, base.wavesSent, worldNow(state));
    let spawned = 0;
    const spacing = guard ? 3 : density.departureSpacingSeconds;
    const cohorts = [];
    for (const [index, type] of wave.entries()) {
      const departDelay = index * spacing;
      const limit = guard ? 1 : enemyGroupLimitForState(state, type);
      const windowSeconds = Math.max(spacing * 2.25, guard ? 4 : 5);
      const previous = cohorts.findLast(cohort =>
        cohort.type === type
        && cohort.count < limit
        && departDelay - cohort.departDelay <= windowSeconds
      );
      if (previous) previous.count += 1;
      else cohorts.push({ type, count: 1, departDelay });
    }
    for (const cohort of cohorts) {
      const enemy = spawnEnemy(state, base, cohort.type, cohort.departDelay, waveId, doctrine.key, { unitCount: cohort.count });
      if (!enemy) continue;
      enemy.waveGuard = guard;
      enemy.waveStartedAt = worldNow(state);
      if (siegeEventId) {
        enemy.siegeEventId = siegeEventId;
        enemy.siegeRewardMultiplier = rewardMultiplier;
        enemy.siegeProgressKillBonus = progressKillBonus;
      }
      spawned += enemyUnitCount(enemy);
    }
    if (spawned > 0) {
      state.combat.waves.active[waveId] = {
        id: waveId, baseId: base.id, remaining: spawned, breached: false, guard,
        doctrineKey: doctrine.key, startedAt: worldNow(state),
        siegeEventId, rewardMultiplier, progressKillBonus
      };
      this.events?.emit('combat:wave-launched', { baseId: base.id, waveId, count: spawned, guard, doctrineKey: doctrine.key, level: base.level ?? 1, siegeEventId });
    }
    if (!guard && spawned > 0) {
      base.wavesSent += 1;
      this.events?.emit('message', { key: 'enemyBase.waveStarted', params: { enemyBaseName: ENEMY_BASE_DEFINITIONS[base.type].name, level: base.level ?? 1, doctrineLabel: doctrine.label }, text: `${ENEMY_BASE_DEFINITIONS[base.type].name} Lv.${base.level ?? 1}が「${doctrine.label}」を開始しました。` });
    }
    return spawned;
  }

  ensureUnlockedBases(state) {
    synchronizeEnemyBaseNetwork(state, this.events);
    state.world.baseRespawns ??= [];
    const pendingTypes = new Set(state.world.baseRespawns.filter(item => !item.frontlineAnchorBaseId).map(item => item.baseType));
    for (const type of unlockedBaseTypes(state)) {
      const exists = state.world.enemyBases.some(base => base.type === type && base.alive);
      if (exists || pendingTypes.has(type)) continue;
      if (activeEnemyBaseCount(state) >= maxActiveEnemyBases(state)) break;
      const placement = selectEnemyBaseNode(state, type);
      if (!placement) continue;
      const base = createBase(state, type, placement);
      state.world.enemyBases.push(base);
      this.events?.emit('message', { key: 'enemyBase.roadAppeared', params: { enemyBaseName: ENEMY_BASE_DEFINITIONS[type].name }, text: `${ENEMY_BASE_DEFINITIONS[type].name}が道路網に出現しました。` });
    }

    const desiredCount = desiredEnemyBaseCount(state);
    if (activeEnemyBaseCount(state) >= desiredCount) {
      markEnemyBaseNetworkClean(state);
      return;
    }
    for (const request of frontlineSlotRequests(state)) {
      if (activeEnemyBaseCount(state) >= desiredCount || activeEnemyBaseCount(state) >= maxActiveEnemyBases(state)) break;
      const { anchorBase, slotIndex } = request;
      if (frontlineSlotOccupied(state, anchorBase.id, slotIndex)) continue;
      const type = frontlineBaseTypeForAnchor(state, anchorBase, slotIndex);
      if (!type) continue;
      const placement = selectEnemyBaseNode(state, type, null, { anchorNodeId: anchorBase.nodeId, frontline: true });
      if (!placement) {
        recordFrontlinePlacementDeferred(state, anchorBase, slotIndex, type, this.events);
        continue;
      }
      const base = createBase(state, type, placement, `${anchorBase.id}:slot:${slotIndex}:${type}`, {
        frontlineAnchorBaseId: anchorBase.id,
        frontlineAnchorNodeId: anchorBase.nodeId,
        frontlineSlotIndex: slotIndex,
        operationWarmupSeconds: OPERATION_TEMPO_CONFIG.frontlineReactionDelaySeconds
      });
      state.world.enemyBases.push(base);
      this.events?.emit('message', { key: 'enemyBase.frontlineAppeared', params: { baseName: anchorBase.name ?? '新設拠点', enemyBaseName: ENEMY_BASE_DEFINITIONS[type].name }, text: `${anchorBase.name ?? '新設拠点'}周辺で${ENEMY_BASE_DEFINITIONS[type].name}が活動を開始しました。` });
    }
    markEnemyBaseNetworkClean(state);
  }

  processRespawns(state, deltaSeconds) {
    state.world.baseRespawns ??= [];
    const remaining = [];
    for (const respawn of state.world.baseRespawns) {
      respawn.remainingSec = Math.max(0, Number(respawn.remainingSec) - deltaSeconds);
      if (respawn.remainingSec > 0) {
        remaining.push(respawn);
        continue;
      }
      const desiredTypes = new Set(unlockedBaseTypes(state));
      if (!desiredTypes.has(respawn.baseType)) continue;
      const isFrontline = Boolean(respawn.frontlineAnchorBaseId);
      const slotIndex = Math.max(0, Number(respawn.frontlineSlotIndex) || 0);
      let anchorBase = null;
      if (isFrontline) {
        anchorBase = activeExpansionBases(state).find(base => base.id === respawn.frontlineAnchorBaseId) ?? null;
        if (!anchorBase) continue;
        const unlockedSlotCount = frontlineSlotCountForAnchor(state, anchorBase);
        const slotStillUnlocked = slotIndex < unlockedSlotCount;
        if (!slotStillUnlocked) {
          if (unlockedSlotCount > 0) {
            respawn.remainingSec = 30 * 60;
            remaining.push(respawn);
          }
          continue;
        }
        const slotOccupied = state.world.enemyBases.some(base => base.alive && base.frontlineAnchorBaseId === respawn.frontlineAnchorBaseId && Math.max(0, Number(base.frontlineSlotIndex) || 0) === slotIndex);
        if (slotOccupied) continue;
      } else if (state.world.enemyBases.some(base => base.type === respawn.baseType && base.alive && !base.frontlineAnchorBaseId)) {
        continue;
      }
      if (activeEnemyBaseCount(state) >= maxActiveEnemyBases(state)) {
        respawn.remainingSec = 60 * 60;
        respawn.attempts = (respawn.attempts ?? 0) + 1;
        remaining.push(respawn);
        continue;
      }
      const placement = selectEnemyBaseNode(state, respawn.baseType, respawn.sourceNodeId, isFrontline ? { anchorNodeId: respawn.frontlineAnchorNodeId ?? anchorBase?.nodeId, frontline: true } : {});
      if (!placement) {
        if (isFrontline) recordFrontlinePlacementDeferred(state, anchorBase, slotIndex, respawn.baseType, this.events);
        respawn.remainingSec = 60 * 60;
        respawn.attempts = (respawn.attempts ?? 0) + 1;
        remaining.push(respawn);
        continue;
      }
      const base = createBase(state, respawn.baseType, placement, `${respawn.id}:${respawn.attempts ?? 0}`, isFrontline ? {
        frontlineAnchorBaseId: respawn.frontlineAnchorBaseId,
        frontlineAnchorNodeId: respawn.frontlineAnchorNodeId ?? anchorBase?.nodeId ?? placement.anchorNodeId,
        frontlineSlotIndex: slotIndex,
        operationWarmupSeconds: Math.floor(OPERATION_TEMPO_CONFIG.frontlineReactionDelaySeconds / 2)
      } : {});
      state.world.enemyBases.push(base);
      this.events?.emit('message', { key: 'enemyBase.respawned', params: { enemyBaseName: ENEMY_BASE_DEFINITIONS[respawn.baseType].name }, text: `${ENEMY_BASE_DEFINITIONS[respawn.baseType].name}が別の道路へ再出現しました。` });
    }
    state.world.baseRespawns = remaining;
  }

  update(state, deltaSeconds) {
    reconcileActiveWaveRecords(state);
    synchronizeEnemyBaseNetwork(state, this.events);
    garbageCollectEnemyBases(state);
    this.processRespawns(state, deltaSeconds);
    state.combat.waves.resourceBaseCheckClock = (state.combat.waves.resourceBaseCheckClock ?? 30) + deltaSeconds;
    if (state.combat.waves.enemyBaseNetworkDirty) {
      state.combat.waves.resourceBaseCheckClock = 0;
      this.ensureUnlockedBases(state);
    }
    while (state.combat.waves.resourceBaseCheckClock >= 30) {
      state.combat.waves.resourceBaseCheckClock -= 30;
      this.ensureUnlockedBases(state);
    }
    const regrouping = enemyRegroupActive(state);
    for (const base of state.world.enemyBases) {
      if (!base.alive) continue;
      const definition = ENEMY_BASE_DEFINITIONS[base.type];
      if (!definition) continue;
      if (securedCoreBaseIsDormant(state, base)) {
        base.regionDormant = true;
        base.spawnClock = 0;
        continue;
      }
      base.regionDormant = false;
      base.ageSeconds = (base.ageSeconds ?? 0) + deltaSeconds;
      const previousLevel = Math.max(1, Math.floor(Number(base.level) || 1));
      base.level = enemyBaseLevelForState(state, base.ageSeconds);
      if (base.level > previousLevel) {
        this.events?.emit('message', { key: 'enemyBase.levelUp', params: { enemyBaseName: definition.name, level: base.level }, text: `${definition.name}の脅威レベルがLv.${base.level}へ上昇しました。` });
        this.events?.emit('combat:enemy-base-level-up', { baseId: base.id, level: base.level });
      }
      if (regrouping) continue;
      base.spawnClock = (base.spawnClock ?? 0) + deltaSeconds;
      const openingMultiplier = openingPressureLimited(state) ? OPENING_WAVE_INTERVAL_MULTIPLIER : 1;
      const density = enemyDensityForState(state);
      const interval = waveIntervalForBase(definition, base.level, state.world.city.hp)
        * density.intervalMultiplier
        * Math.max(1, Number(base.frontPressureMultiplier) || 1)
        * openingMultiplier
        * operationWaveIntervalMultiplier(state, base)
        * enemyBaseSpawnIntervalMultiplierForRegion(state, base);
      if (!base.frontlineAnchorBaseId && enemyBaseRegionProfile(state, base)?.simulationMode === REGION_SIMULATION_MODE.SECURED && activeSecuredCoreWaveCount(state) >= 1) {
        base.spawnClock = Math.min(base.spawnClock, interval);
        continue;
      }
      const firstFrontlineWavePending = base.frontlineAnchorBaseId && Math.max(0, Math.floor(Number(base.wavesSent) || 0)) <= 0 && Number(base.frontlineFirstWaveReadyAt) > 0;
      if (firstFrontlineWavePending) {
        const now = worldNow(state);
        if (now < Number(base.frontlineFirstWaveReadyAt)) {
          base.spawnClock = 0;
          continue;
        }
        base.frontlineFirstWaveReadyAt = null;
        base.spawnClock = Math.max(base.spawnClock ?? 0, interval);
      }
      const activeLimit = Math.min(
        openingPressureLimited(state) ? OPENING_ACTIVE_WAVE_LIMIT : Number.POSITIVE_INFINITY,
        enemyBaseActiveWaveLimit(state)
      );
      if (base.frontlineAnchorBaseId) {
        const anchorBase = activeExpansionBases(state).find(item => item.id === base.frontlineAnchorBaseId) ?? null;
        if (anchorBase && activeEnemyBaseWaveCountForAnchor(state, base.frontlineAnchorBaseId) >= perAnchorActiveWaveLimit(state, anchorBase)) {
          base.spawnClock = Math.min(base.spawnClock, interval);
          continue;
        }
      }
      if (activeEnemyBaseWaveCount(state) >= activeLimit) {
        base.spawnClock = Math.min(base.spawnClock, interval);
        continue;
      }
      if (base.spawnClock >= interval) {
        if (activeEnemyBaseWaveCount(state) >= activeLimit) {
          base.spawnClock = Math.min(base.spawnClock, interval);
          continue;
        }
        if (base.frontlineAnchorBaseId) {
          const anchorBase = activeExpansionBases(state).find(item => item.id === base.frontlineAnchorBaseId) ?? null;
          if (anchorBase && activeEnemyBaseWaveCountForAnchor(state, base.frontlineAnchorBaseId) >= perAnchorActiveWaveLimit(state, anchorBase)) {
            base.spawnClock = Math.min(base.spawnClock, interval);
            continue;
          }
        }
        // Old saves or a civilization upgrade may carry a large clock. Launch only the
        // currently due wave; offline simulation already advances in bounded time steps.
        const spawned = this.spawnWave(state, base);
        base.spawnClock = spawned > 0
          ? base.spawnClock % interval
          : Math.max(0, interval - WAVE_SPAWN_RETRY_SECONDS);
      }
    }
  }
}
