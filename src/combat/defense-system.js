import { distanceSquared, worldNow } from '../core/utilities.js';
import { consumeBundle } from '../civilization/inventory-system.js';
import { repairCostForDefense } from '../civilization/repair-cost.js';
import { defenseRuntimeDefinition } from './definitions.js';
import { defenseWorldPosition } from './combat-geometry.js';
import { damageEnemy } from './enemy-system.js';
import { enemyUnitCount, splashDamageMultiplierForGroup } from './enemy-grouping.js';
import { buildCombatSpatialIndex } from './combat-spatial-index.js';
import { applyMedicalAreaHealing } from './friendly-healing-system.js';

const MAX_ACTIONS_PER_UPDATE = 128;

function setTowerAim(tower, entry, position, splashRadius = 0) {
  if (!tower || !entry?.enemy || !entry.position) return;
  tower.currentTargetEnemyId = entry.enemy.id;
  tower.currentAimPoint = { x: entry.position.x, y: entry.position.y };
  tower.currentAimAt = worldNow(state);
  tower.currentSplashRadius = Math.max(0, Number(splashRadius) || 0);
}

function clearTowerAim(tower) {
  if (!tower) return;
  tower.currentTargetEnemyId = null;
  tower.currentAimPoint = null;
  tower.currentSplashRadius = 0;
}

function nearestEntry(entries, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const entry of entries) {
    if (entry.enemy.hp <= 0) continue;
    const gapSquared = distanceSquared(entry.position, point);
    if (gapSquared < bestDistance) { best = entry; bestDistance = gapSquared; }
  }
  return best;
}

function automaticRepairCost(state, target, repairHp) {
  const cost = repairCostForDefense(target, repairHp);
  const level = Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
  if (level < 5) return cost;
  const activeDefenses = (state.combat?.defenses ?? []).filter(defense => defense.hp > 0).length;
  const threshold = 18 + level * 7;
  if (activeDefenses <= threshold) return cost;
  const discount = 0.72;
  return Object.fromEntries(
    Object.entries(cost).map(([resource, amount]) => [resource, Math.max(1, Math.ceil(amount * discount))])
  );
}

function automaticRepairLimit(state, target, definition) {
  const base = target.kind === 'barrier' ? definition.repairBarrier : definition.repairTower;
  const level = Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
  if (level < 5) return base;
  const activeDefenses = (state.combat?.defenses ?? []).filter(defense => defense.hp > 0).length;
  const threshold = 18 + level * 7;
  if (activeDefenses <= threshold) return base;
  return base;
}

function shouldDeferAutomaticRepair(state, target, repairLimit) {
  const level = Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
  if (level < 5) return false;
  const activeDefenses = (state.combat?.defenses ?? []).filter(defense => defense.hp > 0).length;
  const threshold = 18 + level * 7;
  if (activeDefenses <= threshold) return false;
  const missing = Math.max(0, Number(target.maxHp) - Number(target.hp));
  const hpRatio = Number(target.hp) / Math.max(1, Number(target.maxHp) || 1);
  return missing < Math.max(8, repairLimit * 0.9) && hpRatio > 0.88;
}

function operateRelay(state, tower, definition, graph, position, events) {
  let target = null;
  let mostMissing = 0;
  for (const defense of state.combat.defenses) {
    if (defense === tower || defense.hp <= 0 || defense.hp >= defense.maxHp) continue;
    const targetPosition = defenseWorldPosition(graph, defense);
    if (!targetPosition || distanceSquared(position, targetPosition) > definition.range * definition.range) continue;
    const missing = defense.maxHp - defense.hp;
    if (missing > mostMissing) { target = defense; mostMissing = missing; }
  }
  if (!target) return false;
  const repairLimit = automaticRepairLimit(state, target, definition);
  if (shouldDeferAutomaticRepair(state, target, repairLimit)) return true;
  const repairHp = Math.min(repairLimit, target.maxHp - target.hp);
  const cost = automaticRepairCost(state, target, repairHp);
  if (!consumeBundle(state, cost)) return false;
  target.hp = Math.min(target.maxHp, target.hp + repairHp);
  events?.emit('combat:defense-repaired', { defenseId: target.id, repairHp, cost, automatic: true });
  return true;
}



function fireTower(state, tower, definition, position, spatial, events) {
  const targets = spatial.query(position, definition.range).filter(entry => entry.enemy.hp > 0);
  if (targets.length === 0) {
    clearTowerAim(tower);
    return false;
  }

  if (tower.type === 'gun') {
    const target = nearestEntry(targets, position);
    if (!target) {
      clearTowerAim(tower);
      return false;
    }
    setTowerAim(tower, target, position);
    damageEnemy(state, target.enemy, definition.damage, events, spatial);
    events?.emit('combat:shot', { type: tower.type, from: position, to: target.position, targetEnemyId: target.enemy.id, primaryTargetEnemyId: target.enemy.id });
    return true;
  }

  if (tower.type === 'mortar') {
    let best = targets[0];
    let bestCount = -1;
    for (const candidate of targets) {
      const count = spatial.query(candidate.position, definition.blastRadius)
        .filter(entry => entry.enemy.hp > 0)
        .reduce((total, entry) => total + Math.min(enemyUnitCount(entry.enemy), Math.max(1, Number(definition.maxTargets) || 1)), 0);
      if (count > bestCount) { best = candidate; bestCount = count; }
    }
    const hit = best.position;
    setTowerAim(tower, best, position, definition.blastRadius);
    const maximumTargets = Math.max(1, Number(definition.maxTargets) || 1);
    const splashMultiplier = Math.max(0, Math.min(1, Number(definition.splashMultiplier) || 0));
    const blastTargets = spatial.query(hit, definition.blastRadius)
      .filter(entry => entry.enemy.hp > 0)
      .sort((a, b) => {
        if (a.enemy.id === best.enemy.id) return -1;
        if (b.enemy.id === best.enemy.id) return 1;
        return distanceSquared(a.position, hit) - distanceSquared(b.position, hit);
      })
      .slice(0, maximumTargets);
    for (const [index, entry] of blastTargets.entries()) {
      const contactBonus = entry.enemy.edgeId && state.combat.defenses.some(defense => defense.kind === 'barrier' && defense.hp > 0 && defense.edgeId === entry.enemy.edgeId) ? 1.35 : 1;
      const groupMultiplier = splashDamageMultiplierForGroup(entry.enemy, definition, { centered: index === 0, contactBonus });
      const damage = (index === 0 ? definition.damage : definition.damage * splashMultiplier) * groupMultiplier;
      damageEnemy(state, entry.enemy, damage, events, spatial);
    }
    events?.emit('combat:explosion', { position: hit, radius: definition.blastRadius, targets: blastTargets.length, primaryTargetEnemyId: best.enemy.id });
    return true;
  }

  if (tower.type === 'slow') {
    const affected = [...targets]
      .sort((a, b) => distanceSquared(a.position, position) - distanceSquared(b.position, position))
      .slice(0, definition.maxTargets);
    setTowerAim(tower, affected[0], position);
    for (const entry of affected) {
      const enemy = entry.enemy;
      enemy.slowTimer = Math.max(enemy.slowTimer, definition.slowSeconds);
      enemy.slowMultiplier = 1 - definition.slow;
      damageEnemy(state, enemy, definition.damage, events, spatial);
    }
    events?.emit('combat:shot', { type: tower.type, from: position, to: affected[0].position, targetEnemyId: affected[0].enemy.id, primaryTargetEnemyId: affected[0].enemy.id });
    return true;
  }

  return false;
}

export class DefenseSystem {
  constructor(events) { this.events = events; }

  updateTower(state, tower, deltaSeconds, spatial) {
    if (tower.hp <= 0) return;
    const elapsed = Math.max(0, Number(deltaSeconds) || 0);
    const disabledBefore = Math.max(0, Number(tower.disabledTimer) || 0);
    tower.disabledTimer = Math.max(0, disabledBefore - elapsed);
    const operationalSeconds = Math.max(0, elapsed - disabledBefore);
    if (operationalSeconds <= 0 || ['survey', 'fieldBarracks'].includes(tower.type)) return;

    const definition = defenseRuntimeDefinition(tower);
    const graph = state.world.roadGraph;
    const position = graph.nodeById.get(tower.nodeId);
    if (!definition || !position) return;
    if (tower.type === 'medical') {
      applyMedicalAreaHealing(state, tower, operationalSeconds);
      return;
    }

    tower.cooldown = (Number(tower.cooldown) || 0) - operationalSeconds;
    let actions = 0;
    while (tower.cooldown <= 1e-9 && actions < MAX_ACTIONS_PER_UPDATE) {
      const operated = tower.type === 'relay'
        ? operateRelay(state, tower, definition, graph, position, this.events)
        : fireTower(state, tower, definition, position, spatial, this.events);
      if (!operated) {
        tower.cooldown = 0;
        break;
      }
      tower.cooldown += Math.max(0.001, Number(definition.cooldown) || 0.001);
      actions += 1;
    }
    tower.cooldown = Math.max(0, tower.cooldown);
  }

  update(state, deltaSeconds, spatial = null, shouldUpdate = null) {
    spatial ??= buildCombatSpatialIndex(state);
    for (const defense of state.combat.defenses) {
      if (defense.kind !== 'tower' || (shouldUpdate && !shouldUpdate(defense))) continue;
      this.updateTower(state, defense, deltaSeconds, spatial);
    }
    state.combat.enemies = state.combat.enemies.filter(enemy => enemy.hp > 0);
  }
}
