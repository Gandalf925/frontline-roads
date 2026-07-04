import { ENEMY_DEFINITIONS } from './definitions.js';
import { scaleEnemyDefinition } from './enemy-scaling.js';

const IMPORTANT_ENEMY_TYPES = new Set([
  'siegeCaptain', 'steelCaptain', 'machineCommander', 'royalCommander',
  'commander', 'warDrummer', 'bodyguard', 'steelGuard', 'royalGuard'
]);

export function enemyUnitCount(enemy) {
  return Math.max(1, Math.floor(Number(enemy?.unitCount ?? enemy?.count) || 1));
}

export function enemyUnitHp(enemy) {
  const base = ENEMY_DEFINITIONS[enemy?.type] ?? ENEMY_DEFINITIONS.infantry;
  const definition = scaleEnemyDefinition(base, enemy?.level ?? 1);
  return Math.max(1, Number(enemy?.unitHp) || Number(definition.hp) || Number(enemy?.maxHp) || 1);
}

export function enemyTotalPopulation(state) {
  return (state?.combat?.enemies ?? []).reduce((total, enemy) => {
    if (!enemy || enemy.hp <= 0 || enemy.rewardGranted) return total;
    return total + enemyUnitCount(enemy);
  }, 0);
}

export function enemyGroupLimitForState(state, type = 'infantry') {
  if (IMPORTANT_ENEMY_TYPES.has(type)) return 1;
  const level = Math.max(0, Math.min(7, Math.floor(Number(state?.civilization?.level) || 0)));
  if (level <= 1) return 4;
  if (level === 2) return 8;
  if (level === 3) return 12;
  if (level === 4) return 18;
  if (level === 5) return 26;
  return 56;
}

export function normalizeEnemyGroup(enemy) {
  if (!enemy) return enemy;
  const count = enemyUnitCount(enemy);
  const unitHp = enemyUnitHp(enemy);
  enemy.unitCount = count;
  enemy.unitHp = unitHp;
  const maximumPool = unitHp * count;
  const previousMax = Math.max(1, Number(enemy.maxHp) || maximumPool);
  const previousHp = Math.max(0, Math.min(previousMax, Number(enemy.hp ?? previousMax) || 0));
  if (enemy.hpPool == null) {
    enemy.hpPool = count === 1 ? previousHp : previousHp / previousMax * maximumPool;
  }
  enemy.maxHp = maximumPool;
  enemy.hp = Math.max(0, Math.min(maximumPool, Number(enemy.hpPool) || 0));
  enemy.maxUnitCount ??= count;
  return enemy;
}

export function setEnemyUnitCount(enemy, unitCount, preserveRatio = true) {
  const previousCount = enemyUnitCount(enemy);
  const previousUnitHp = enemyUnitHp(enemy);
  const previousMaximum = Math.max(1, previousUnitHp * previousCount);
  const previousHp = Math.max(0, Math.min(previousMaximum, Number(enemy.hpPool ?? enemy.hp ?? previousMaximum) || 0));
  const nextCount = Math.max(1, Math.floor(Number(unitCount) || 1));
  const unitHp = previousUnitHp;
  const nextMaximum = unitHp * nextCount;
  enemy.unitCount = nextCount;
  enemy.unitHp = unitHp;
  enemy.maxHp = nextMaximum;
  enemy.hpPool = preserveRatio ? previousHp / previousMaximum * nextMaximum : Math.min(previousHp, nextMaximum);
  enemy.hp = Math.max(0, Math.min(nextMaximum, enemy.hpPool));
  enemy.maxUnitCount = Math.max(nextCount, Math.floor(Number(enemy.maxUnitCount) || nextCount));
  return enemy;
}

export function enemyRepresentativeBlipCount(enemy, quality = 'balanced') {
  const count = enemyUnitCount(enemy);
  if (count <= 1) return 1;
  if (quality === 'minimal') {
    if (count <= 6) return count;
    if (count <= 30) return Math.min(10, Math.ceil(5 + Math.sqrt(count) * 1.3));
    if (count <= 80) return Math.min(15, Math.ceil(8 + Math.sqrt(count) * 1.1));
    return Math.min(22, Math.ceil(10 + Math.sqrt(count) * 1.0));
  }
  if (quality === 'full') {
    if (count <= 12) return count;
    if (count <= 30) return Math.min(18, Math.ceil(8 + Math.sqrt(count) * 1.8));
    if (count <= 80) return Math.min(28, Math.ceil(12 + Math.sqrt(count) * 1.9));
    if (count <= 160) return Math.min(36, Math.ceil(16 + Math.sqrt(count) * 1.7));
    return Math.min(40, Math.ceil(20 + Math.sqrt(count) * 1.4));
  }
  if (count <= 8) return count;
  if (count <= 30) return Math.min(14, Math.ceil(6 + Math.sqrt(count) * 1.5));
  if (count <= 80) return Math.min(22, Math.ceil(10 + Math.sqrt(count) * 1.6));
  if (count <= 160) return Math.min(30, Math.ceil(14 + Math.sqrt(count) * 1.4));
  return Math.min(34, Math.ceil(17 + Math.sqrt(count) * 1.25));
}

function mergeKeyForEnemy(enemy) {
  if (!enemy || enemy.hp <= 0 || enemy.rewardGranted) return null;
  if (IMPORTANT_ENEMY_TYPES.has(enemy.type)) return null;
  if (enemy.engagedSquadId || enemy.targetSquadId) return null;
  const departDelay = Math.max(0, Number(enemy.departDelay) || 0);
  if (departDelay > 1.25) return null;
  const pathTarget = enemy.path?.targetId ?? '';
  const progressBucket = enemy.edgeId ? Math.floor((Number(enemy.edgeProgress) || 0) / 28) : -1;
  const contactKind = enemy.contactKind ?? 'none';
  return [
    enemy.type,
    Math.floor(Number(enemy.level) || 1),
    enemy.sourceBaseId ?? '',
    enemy.waveId ?? '',
    enemy.doctrineKey ?? '',
    enemy.edgeId ?? '',
    Math.floor(Number(enemy.pathIndex) || 0),
    pathTarget,
    enemy.targetDefenseId ?? '',
    enemy.targetPlayerBaseId ?? '',
    enemy.targetFieldBaseId ?? '',
    contactKind,
    progressBucket
  ].join('|');
}

function absorbEnemyGroup(target, source) {
  normalizeEnemyGroup(target);
  normalizeEnemyGroup(source);
  const targetCount = enemyUnitCount(target);
  const sourceCount = enemyUnitCount(source);
  const nextCount = targetCount + sourceCount;
  const targetHpPool = Math.max(0, Number(target.hpPool ?? target.hp) || 0);
  const sourceHpPool = Math.max(0, Number(source.hpPool ?? source.hp) || 0);
  const totalHpPool = targetHpPool + sourceHpPool;
  const weightedProgress = nextCount > 0
    ? ((Number(target.edgeProgress) || 0) * targetCount + (Number(source.edgeProgress) || 0) * sourceCount) / nextCount
    : Number(target.edgeProgress) || 0;
  target.unitCount = nextCount;
  target.maxUnitCount = Math.max(nextCount, Number(target.maxUnitCount) || 0, Number(source.maxUnitCount) || 0);
  target.unitHp = Math.max(1, Number(target.unitHp) || Number(source.unitHp) || enemyUnitHp(target));
  target.hpPool = totalHpPool;
  target.maxHp = target.unitHp * nextCount;
  target.hp = Math.max(0, Math.min(target.maxHp, totalHpPool));
  target.edgeProgress = weightedProgress;
  target.slowTimer = Math.max(Number(target.slowTimer) || 0, Number(source.slowTimer) || 0);
  target.attackClock = Math.max(Number(target.attackClock) || 0, Number(source.attackClock) || 0);
  target.contactDuration = Math.max(Number(target.contactDuration) || 0, Number(source.contactDuration) || 0);
  target.routeFailureSeconds = Math.min(Number(target.routeFailureSeconds) || 0, Number(source.routeFailureSeconds) || 0);
  target.notifiedDefenseIds = [...new Set([...(target.notifiedDefenseIds ?? []), ...(source.notifiedDefenseIds ?? [])])];
  target.hasDeparted = Boolean(target.hasDeparted || source.hasDeparted);
  return target;
}

export function mergeEnemyCohorts(state, options = {}) {
  const enemies = state?.combat?.enemies;
  if (!Array.isArray(enemies) || enemies.length < 2) return 0;
  const maxMergedCount = Math.max(4, Math.floor(Number(options.maxMergedCount) || 48));
  const buckets = new Map();
  const removed = new Set();
  let merged = 0;
  for (const enemy of enemies) {
    normalizeEnemyGroup(enemy);
    const key = mergeKeyForEnemy(enemy);
    if (!key) continue;
    const existing = buckets.get(key);
    if (!existing || enemyUnitCount(existing) >= maxMergedCount) {
      buckets.set(key, enemy);
      continue;
    }
    if (enemyUnitCount(existing) + enemyUnitCount(enemy) > maxMergedCount) {
      buckets.set(`${key}|overflow:${enemy.id}`, enemy);
      continue;
    }
    absorbEnemyGroup(existing, enemy);
    removed.add(enemy.id);
    merged += 1;
  }
  if (removed.size > 0) state.combat.enemies = enemies.filter(enemy => !removed.has(enemy.id));
  state.combat.lastCohortMerge = { merged, remainingCohorts: state.combat.enemies.length, population: enemyTotalPopulation(state) };
  return merged;
}

export function groupAttackMultiplier(enemy, mode = 'field') {
  const count = enemyUnitCount(enemy);
  if (count <= 1) return 1;
  const cap = mode === 'friendly'
    ? 8
    : mode === 'barrier'
      ? 16
      : mode === 'settlement'
        ? 13
        : mode === 'facility'
          ? 12
          : 6;
  const active = Math.min(count, cap);
  const efficiency = mode === 'friendly'
    ? 0.52
    : mode === 'barrier'
      ? 0.76
      : mode === 'facility'
        ? 0.68
        : mode === 'settlement'
          ? 0.68
          : 0.66;
  return 1 + (active - 1) * efficiency;
}

export function splashDamageMultiplierForGroup(enemy, definition = {}, { centered = false, contactBonus = 1 } = {}) {
  const count = enemyUnitCount(enemy);
  if (count <= 1) return 1;
  const radius = Math.max(1, Number(definition.blastRadius ?? definition.splashRadius) || 18);
  const baseAffected = Math.max(1, Number(definition.maxTargets ?? definition.maxSplashTargets) || 3);
  const denseContactBonus = Math.max(1, Number(contactBonus) || 1);
  const contactAffected = denseContactBonus > 1 ? Math.ceil(radius / 10) : 0;
  const density = Math.min(count, Math.ceil(baseAffected + contactAffected));
  const centeredBonus = centered ? 1.08 : 1;
  return Math.max(1, Math.min(count, density * centeredBonus * denseContactBonus));
}
