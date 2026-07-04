import { RESOURCE_KEYS } from '../civilization/data.js';
import { LifecycleState } from '../core/constants.js';
import { GAME_OVER_SOURCE } from '../core/home-base-destruction.js';
import { markRoadsideRefillReady, offlineFillSummary } from './offline-fill-policy.js';
import { offlineSiegeSummary } from '../combat/siege-event.js';

const DEFAULT_MAXIMUM_OFFLINE_ITERATIONS = 6000;
const DEFAULT_MAXIMUM_OFFLINE_STEP_SECONDS = 1;

export function offlineSimulationStepSeconds(simulatedSoFar, maximumStepSeconds = DEFAULT_MAXIMUM_OFFLINE_STEP_SECONDS) {
  const elapsed = Math.max(0, Number(simulatedSoFar) || 0);
  const baseStep = Math.max(0.25, Number(maximumStepSeconds) || DEFAULT_MAXIMUM_OFFLINE_STEP_SECONDS);
  if (elapsed < 5 * 60) return baseStep;
  if (elapsed < 30 * 60) return Math.max(baseStep, 5);
  if (elapsed < 2 * 60 * 60) return Math.max(baseStep, 15);
  return Math.max(baseStep, 60);
}

function resourceSnapshot(state) {
  return Object.fromEntries(RESOURCE_KEYS.map(key => [key, state.inventory.resources[key] ?? 0]));
}

function resourceDelta(before, after) {
  const delta = {};
  for (const key of RESOURCE_KEYS) {
    const value = (after[key] ?? 0) - (before[key] ?? 0);
    if (value !== 0) delta[key] = value;
  }
  return delta;
}

function productionCompletedUnits(state) {
  return (state.civilization?.productionQueues ?? []).reduce((sum, queue) => sum + Math.max(0, Math.floor(Number(queue.completedUnits) || 0)), 0);
}

function recoveringSquadIds(state) {
  return new Set((state.combat?.friendlySquads ?? [])
    .filter(squad => squad?.status === 'RECOVERING' && squad.hp > 0)
    .map(squad => String(squad.id)));
}

function completedReorganizations(state, beforeIds) {
  let count = 0;
  for (const squad of state.combat?.friendlySquads ?? []) {
    if (beforeIds.has(String(squad.id)) && squad.status === 'READY' && squad.hp > 0) count += 1;
  }
  return count;
}

export class OfflineSimulator {
  constructor({ combatSystem, civilizationSystem = null, maximumSeconds = 24 * 60 * 60, maximumIterations = DEFAULT_MAXIMUM_OFFLINE_ITERATIONS, maximumStepSeconds = DEFAULT_MAXIMUM_OFFLINE_STEP_SECONDS } = {}) {
    this.combatSystem = combatSystem;
    this.civilizationSystem = civilizationSystem;
    this.maximumSeconds = Math.max(0, Number(maximumSeconds) || 0);
    this.maximumIterations = Math.max(1, Math.floor(Number(maximumIterations) || DEFAULT_MAXIMUM_OFFLINE_ITERATIONS));
    this.maximumStepSeconds = Math.max(0.25, Number(maximumStepSeconds) || DEFAULT_MAXIMUM_OFFLINE_STEP_SECONDS);
  }

  simulate(state, elapsedSeconds) {
    if (state?.lifecycle === LifecycleState.DESTROYED || state?.runtime?.gameOver) return null;
    const simulatedSeconds = Math.min(this.maximumSeconds, Math.max(0, elapsedSeconds));
    if (simulatedSeconds < 2) return null;
    const before = {
      kills: state.statistics.kills,
      cityHp: state.world.city?.hp ?? 0,
      resources: resourceSnapshot(state),
      enemies: state.combat.enemies.length,
      defenses: state.combat.defenses.length,
      buildings: (state.civilization?.buildings ?? []).length,
      civilizationLevel: state.civilization?.level ?? 0,
      productionCompletedUnits: productionCompletedUnits(state),
      recoveringSquadIds: recoveringSquadIds(state)
    };

    let remaining = simulatedSeconds;
    let iterations = 0;
    const previousOfflineSimulation = state.runtime.offlineSimulation;
    const previousOfflineSimulationElapsedSeconds = state.runtime.offlineSimulationElapsedSeconds;
    state.runtime.offlineSimulation = true;
    try {
      while (remaining > 0.0001 && iterations < this.maximumIterations) {
        const simulatedSoFar = simulatedSeconds - remaining;
        const currentStep = Math.min(
          offlineSimulationStepSeconds(simulatedSoFar, this.maximumStepSeconds),
          remaining
        );
        state.runtime.offlineSimulationElapsedSeconds = simulatedSoFar;
        state.runtime.worldTimeMs = (state.runtime.worldTimeMs ?? Date.now()) + currentStep * 1000;
        this.combatSystem.update(state, currentStep);
        if (state.lifecycle === LifecycleState.DESTROYED || state.runtime?.gameOver) {
          state.runtime.gameOver = { ...state.runtime.gameOver, source: GAME_OVER_SOURCE.OFFLINE };
          remaining -= currentStep;
          iterations += 1;
          break;
        }
        this.civilizationSystem?.update(state, currentStep);
        remaining -= currentStep;
        iterations += 1;
      }
    } finally {
      if (previousOfflineSimulation === undefined) delete state.runtime.offlineSimulation;
      else state.runtime.offlineSimulation = previousOfflineSimulation;
      if (previousOfflineSimulationElapsedSeconds === undefined) delete state.runtime.offlineSimulationElapsedSeconds;
      else state.runtime.offlineSimulationElapsedSeconds = previousOfflineSimulationElapsedSeconds;
    }

    const roadsideRefillReady = markRoadsideRefillReady(state, simulatedSeconds);
    const afterResources = resourceSnapshot(state);
    const afterDefenses = state.combat.defenses.length;
    const afterBuildings = (state.civilization?.buildings ?? []).length;
    state.runtime.lastOfflineSimulationAt = Date.now();
    return {
      requestedSeconds: elapsedSeconds,
      simulatedSeconds: simulatedSeconds - remaining,
      capped: elapsedSeconds > this.maximumSeconds || remaining > 0.0001,
      kills: state.statistics.kills - before.kills,
      cityDamage: Math.max(0, before.cityHp - (state.world.city?.hp ?? 0)),
      resources: resourceDelta(before.resources, afterResources),
      productionCompleted: Math.max(0, productionCompletedUnits(state) - before.productionCompletedUnits),
      completedReorganizations: completedReorganizations(state, before.recoveringSquadIds),
      enemiesDelta: state.combat.enemies.length - before.enemies,
      defensesLost: Math.max(0, before.defenses - afterDefenses),
      buildingsLost: Math.max(0, before.buildings - afterBuildings),
      civilizationAdvanced: (state.civilization?.level ?? 0) - before.civilizationLevel,
      roadsideRefillReady,
      fill: offlineFillSummary(state, simulatedSeconds),
      siege: offlineSiegeSummary(state),
      interception: {
        kills: state.statistics.kills - before.kills,
        cityDamage: Math.max(0, before.cityHp - (state.world.city?.hp ?? 0)),
        enemiesDelta: state.combat.enemies.length - before.enemies,
        defensesLost: Math.max(0, before.defenses - afterDefenses),
        buildingsLost: Math.max(0, before.buildings - afterBuildings)
      },
      iterations,
      gameOver: state.runtime?.gameOver ?? null
    };
  }
}
