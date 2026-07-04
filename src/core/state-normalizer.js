import { attachGraphIndexes } from '../roads/road-graph.js';
import { ensureRoadChunkState } from '../roads/world-chunk-grid.js';
import { repairRoadGraphTopology } from '../roads/road-topology-repair.js';
import { normalizeCombatState } from '../combat/combat-initializer.js';
import { ensureRoadsideSupplyState } from '../exploration/roadside-supplies.js';
import { ensureExplorationState } from '../exploration/exploration-system.js';
import { ensureRegionControlState } from '../base/region-control.js';
import { ensureCivilizationAbilityState } from '../civilization/abilities.js';
import { ensureDailyMissionState } from '../civilization/daily-missions.js';
import { ensureSiegeEventState } from '../combat/siege-event.js';
import { ensureRuntimeCommandLog } from '../online/command-bus.js';

export function normalizeRuntimeState(state) {
  state.runtime ??= {};
  if (!('gameOver' in state.runtime)) state.runtime.gameOver = null;
  if (state.world?.roadGraph) {
    attachGraphIndexes(state.world.roadGraph);
    repairRoadGraphTopology(state.world.roadGraph);
  }
  ensureRoadChunkState(state.world);
  normalizeCombatState(state);
  ensureExplorationState(state);
  ensureRoadsideSupplyState(state);
  ensureRegionControlState(state);
  ensureCivilizationAbilityState(state);
  ensureDailyMissionState(state);
  ensureSiegeEventState(state);
  ensureRuntimeCommandLog(state);
  return state;
}
