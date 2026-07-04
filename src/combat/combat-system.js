import { DefenseSystem } from './defense-system.js';
import { EnemySystem, enemyPosition } from './enemy-system.js';
import { WaveSystem } from './wave-system.js';
import { buildCombatSpatialIndex } from './combat-spatial-index.js';
import { FrontierSystem } from '../exploration/frontier-system.js';
import { FriendlyForceSystem, friendlySquadPosition } from './friendly-force-system.js';
import { RecoverySystem } from '../exploration/recovery-system.js';
import { CITY_RECOVERY_HP_PER_SECOND } from './definitions.js';
import { defenseWorldPosition } from './combat-geometry.js';
import { GAME_OVER_SOURCE, markHomeBaseDestroyed } from '../core/home-base-destruction.js';
import { LifecycleState } from '../core/constants.js';
import { maybeEmitHomeBaseRiskWarnings } from './operation-tempo.js';
import { updateSiegeEvents } from './siege-event.js';
import {
  REGION_ACTIVITY,
  REGION_ACTIVITY_CONFIG,
  consumeRegionalSimulationTime,
  regionActivityAnchors,
  regionActivityForAnchors
} from './region-activity.js';

function defensePoint(state, defense) {
  return defenseWorldPosition(state.world.roadGraph, defense);
}

function updateCityRecovery(state, deltaSeconds) {
  const city = state.world.city;
  if (!city || city.hp <= 0 || city.hp >= city.maxHp) return;
  const elapsed = Math.max(0, Number(deltaSeconds) || 0);
  const cooldown = Math.max(0, Number(state.combat.cityRecoveryCooldown) || 0);
  state.combat.cityRecoveryCooldown = Math.max(0, cooldown - elapsed);
  const recoverySeconds = Math.max(0, elapsed - cooldown);
  if (recoverySeconds <= 0) return;
  city.hp = Math.min(city.maxHp, city.hp + CITY_RECOVERY_HP_PER_SECOND * recoverySeconds);
}

function assignmentsForState(state, spatial) {
  const enemies = new Map();
  const defenses = new Map();
  const friendlySquads = new Map();
  const anchors = regionActivityAnchors(state);
  const counts = {
    [REGION_ACTIVITY.ACTIVE]: 0,
    [REGION_ACTIVITY.PERIPHERAL]: 0,
    [REGION_ACTIVITY.DORMANT]: 0
  };
  const assign = (collection, id, point) => {
    const activity = regionActivityForAnchors(point, anchors);
    collection.set(id, activity);
    counts[activity] += 1;
  };
  for (const enemy of state.combat.enemies) {
    assign(enemies, enemy.id, spatial.positions.get(enemy.id) ?? enemyPosition(state, enemy));
  }
  for (const squad of state.combat.friendlySquads ?? []) {
    assign(friendlySquads, squad.id, friendlySquadPosition(state, squad));
  }
  for (const defense of state.combat.defenses) {
    if (defense.kind !== 'tower') continue;
    assign(defenses, defense.id, defensePoint(state, defense));
  }
  return { enemies, defenses, friendlySquads, counts };
}


function homeBaseHp(state) {
  return Number(state?.world?.city?.hp ?? 0);
}

function homeBaseDestroyed(state) {
  return homeBaseHp(state) <= 0;
}

export function offlineCombatSubstepSeconds(activity, simulatedSoFar = 0) {
  if (activity === REGION_ACTIVITY.DORMANT) return Infinity;
  const elapsed = Math.max(0, Number(simulatedSoFar) || 0);
  if (activity === REGION_ACTIVITY.ACTIVE) {
    if (elapsed < 5 * 60) return REGION_ACTIVITY_CONFIG.offlineActiveSubstepSeconds;
    if (elapsed < 30 * 60) return Math.max(REGION_ACTIVITY_CONFIG.offlineActiveSubstepSeconds, 2);
    if (elapsed < 2 * 60 * 60) return Math.max(REGION_ACTIVITY_CONFIG.offlineActiveSubstepSeconds, 5);
    return Math.max(REGION_ACTIVITY_CONFIG.offlineActiveSubstepSeconds, 15);
  }
  if (activity === REGION_ACTIVITY.PERIPHERAL) {
    if (elapsed < 5 * 60) return REGION_ACTIVITY_CONFIG.offlinePeripheralSubstepSeconds;
    if (elapsed < 30 * 60) return Math.max(REGION_ACTIVITY_CONFIG.offlinePeripheralSubstepSeconds, 8);
    if (elapsed < 2 * 60 * 60) return Math.max(REGION_ACTIVITY_CONFIG.offlinePeripheralSubstepSeconds, 15);
    return Math.max(REGION_ACTIVITY_CONFIG.offlinePeripheralSubstepSeconds, 30);
  }
  return Infinity;
}

function simulationSubstepSeconds(state, activity) {
  if (!state?.runtime?.offlineSimulation) return REGION_ACTIVITY_CONFIG.maximumSimulationSubstepSeconds;
  return offlineCombatSubstepSeconds(activity, state.runtime.offlineSimulationElapsedSeconds);
}

function advanceDormantTimers(state, elapsedSeconds, assignments) {
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
  if (elapsed <= 0) return;
  for (const enemy of state.combat?.enemies ?? []) {
    if (assignments.enemies.get(enemy.id) !== REGION_ACTIVITY.DORMANT) continue;
    enemy.departDelay = Math.max(0, (Number(enemy.departDelay) || 0) - elapsed);
    enemy.slowTimer = Math.max(0, (Number(enemy.slowTimer) || 0) - elapsed);
    enemy.routeFailureSeconds = Math.max(0, Number(enemy.routeFailureSeconds) || 0);
  }
}

export class CombatSystem {
  constructor(events) {
    this.enemySystem = new EnemySystem(events);
    this.defenseSystem = new DefenseSystem(events);
    this.waveSystem = new WaveSystem(events);
    this.friendlyForceSystem = new FriendlyForceSystem(events);
    this.recoverySystem = new RecoverySystem(events);
    this.frontierSystem = new FrontierSystem(events);
    this.events = events;
  }

  finishHomeBaseDestruction(state, { source = GAME_OVER_SOURCE.COMBAT, beforeHp = null } = {}) {
    const gameOver = markHomeBaseDestroyed(state, {
      source,
      finalDamage: Math.max(0, Number(beforeHp ?? 0) - homeBaseHp(state))
    });
    this.events?.emit('game:home-base-destroyed', { gameOver });
    return gameOver;
  }

  updateRegion(state, elapsedSeconds, activity, assignments, initialSpatial = null) {
    const substepSeconds = simulationSubstepSeconds(state, activity);
    if (!Number.isFinite(substepSeconds)) {
      advanceDormantTimers(state, elapsedSeconds, assignments);
      return true;
    }
    let remaining = Math.max(0, elapsedSeconds);
    let spatial = initialSpatial;
    while (remaining > 0.0001) {
      if (homeBaseDestroyed(state)) return false;
      const step = Math.min(substepSeconds, remaining);
      spatial ??= buildCombatSpatialIndex(state);
      this.defenseSystem.update(
        state,
        step,
        spatial,
        defense => assignments.defenses.get(defense.id) === activity
      );
      if (homeBaseDestroyed(state)) return false;
      this.friendlyForceSystem.update(
        state,
        step,
        spatial,
        squad => assignments.friendlySquads.get(squad.id) === activity
      );
      if (homeBaseDestroyed(state)) return false;
      this.enemySystem.update(
        state,
        step,
        spatial,
        enemy => assignments.enemies.get(enemy.id) === activity
      );
      if (homeBaseDestroyed(state)) return false;
      remaining -= step;
      spatial = null;
    }
    return true;
  }

  update(state, deltaSeconds) {
    if (state?.lifecycle === LifecycleState.DESTROYED || state?.runtime?.gameOver) return;
    const beforeHp = homeBaseHp(state);
    if (beforeHp <= 0) {
      this.finishHomeBaseDestruction(state, { source: GAME_OVER_SOURCE.COMBAT, beforeHp });
      return;
    }
    updateCityRecovery(state, deltaSeconds);
    maybeEmitHomeBaseRiskWarnings(state, this.events);
    this.recoverySystem.update(state, deltaSeconds);
    this.waveSystem.update(state, deltaSeconds);
    updateSiegeEvents(state, deltaSeconds, this.waveSystem, this.events);
    this.frontierSystem.update(state, deltaSeconds);

    const due = consumeRegionalSimulationTime(state, deltaSeconds);
    const spatial = buildCombatSpatialIndex(state);
    const assignments = assignmentsForState(state, spatial);
    if (due.active > 0 && assignments.counts[REGION_ACTIVITY.ACTIVE] > 0) {
      if (!this.updateRegion(state, due.active, REGION_ACTIVITY.ACTIVE, assignments, spatial)) {
        this.finishHomeBaseDestruction(state, { source: GAME_OVER_SOURCE.COMBAT, beforeHp });
        return;
      }
    }
    if (due.peripheral > 0 && assignments.counts[REGION_ACTIVITY.PERIPHERAL] > 0) {
      if (!this.updateRegion(state, due.peripheral, REGION_ACTIVITY.PERIPHERAL, assignments)) {
        this.finishHomeBaseDestruction(state, { source: GAME_OVER_SOURCE.COMBAT, beforeHp });
        return;
      }
    }
    if (due.dormant > 0 && assignments.counts[REGION_ACTIVITY.DORMANT] > 0) {
      if (!this.updateRegion(state, due.dormant, REGION_ACTIVITY.DORMANT, assignments)) {
        this.finishHomeBaseDestruction(state, { source: GAME_OVER_SOURCE.COMBAT, beforeHp });
        return;
      }
    }

    if (homeBaseDestroyed(state)) {
      this.finishHomeBaseDestruction(state, { source: GAME_OVER_SOURCE.COMBAT, beforeHp });
    }
  }
}
