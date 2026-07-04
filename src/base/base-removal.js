import { RECOVERY_ITEM_STATUS, releaseRecoveryItem } from '../exploration/recovery-system.js';
import { worldNow } from '../core/utilities.js';

function markEnemyBaseNetworkDirty(state) {
  state.combat ??= {};
  state.combat.waves ??= { active: {}, resourceBaseCheckClock: 30 };
  state.combat.waves.enemyBaseNetworkDirty = true;
  state.combat.waves.resourceBaseCheckClock = 0;
}

export function clearFrontlineEnemyNetworkForAnchor(state, anchorBaseId) {
  if (!anchorBaseId) return { retiredBases: 0, removedRespawns: 0 };
  let retiredBases = 0;
  const retiredBaseIds = new Set();
  for (const enemyBase of state.world?.enemyBases ?? []) {
    if (enemyBase.frontlineAnchorBaseId !== anchorBaseId) continue;
    if (enemyBase.alive || enemyBase.hp > 0) retiredBases += 1;
    enemyBase.alive = false;
    enemyBase.hp = 0;
    enemyBase.destroyed = false;
    enemyBase.retired = true;
    enemyBase.retiredAt = worldNow(state);
    retiredBaseIds.add(enemyBase.id);
  }
  const beforeRespawns = state.world?.baseRespawns?.length ?? 0;
  if (Array.isArray(state.world?.baseRespawns)) {
    state.world.baseRespawns = state.world.baseRespawns.filter(respawn => respawn.frontlineAnchorBaseId !== anchorBaseId);
  }
  for (const enemy of state.combat?.enemies ?? []) {
    if (!retiredBaseIds.has(enemy.sourceBaseId)) continue;
    enemy.sourceBaseDestroyed = true;
  }
  const removedRespawns = Math.max(0, beforeRespawns - (state.world?.baseRespawns?.length ?? 0));
  if (retiredBases > 0 || removedRespawns > 0) markEnemyBaseNetworkDirty(state);
  return { retiredBases, removedRespawns };
}


function removedBaseSquadIds(state, removedBaseId) {
  if (!removedBaseId) return new Set();
  return new Set((state.combat?.friendlySquads ?? [])
    .filter(squad => squad?.originBaseId === removedBaseId || squad?.recoveryBaseId === removedBaseId)
    .map(squad => squad.id)
    .filter(Boolean));
}

function releaseRemovedSquadRecoveryItems(state, squadIds) {
  if (!squadIds?.size) return 0;
  let released = 0;
  for (const item of state.world?.recoveryItems ?? []) {
    if (!item?.assignedSquadId || !squadIds.has(item.assignedSquadId)) continue;
    if (![RECOVERY_ITEM_STATUS.RESERVED, RECOVERY_ITEM_STATUS.CARRIED].includes(item.status)) continue;
    const result = releaseRecoveryItem(state, item.id, item.assignedSquadId);
    if (result?.ok) released += 1;
  }
  return released;
}

function clearRemovedSquadReferences(state, squadIds) {
  if (!squadIds?.size) return;
  for (const enemy of state.combat?.enemies ?? []) {
    if (squadIds.has(enemy.engagedSquadId)) enemy.engagedSquadId = null;
    if (squadIds.has(enemy.targetSquadId)) {
      enemy.targetSquadId = null;
      enemy.reroutePending = true;
    }
  }
}

export function demobilizeOwnedBaseSquads(state, removedBaseId) {
  state.combat ??= {};
  state.combat.friendlySquads = Array.isArray(state.combat.friendlySquads) ? state.combat.friendlySquads : [];
  const squadIds = removedBaseSquadIds(state, removedBaseId);
  if (!squadIds.size) return { demobilizedSquads: 0, releasedRecoveryItems: 0 };
  const releasedRecoveryItems = releaseRemovedSquadRecoveryItems(state, squadIds);
  clearRemovedSquadReferences(state, squadIds);
  state.combat.friendlySquads = (state.combat?.friendlySquads ?? []).filter(squad => !squadIds.has(squad.id));
  return { demobilizedSquads: squadIds.size, releasedRecoveryItems };
}

export function clearOwnedBaseReferences(state, removedBaseId) {
  if (!removedBaseId) return { demobilizedSquads: 0, releasedRecoveryItems: 0 };
  for (const enemy of state.combat?.enemies ?? []) {
    let changed = false;
    if (enemy.targetPlayerBaseId === removedBaseId) { enemy.targetPlayerBaseId = null; changed = true; }
    if (enemy.targetFieldBaseId === removedBaseId) { enemy.targetFieldBaseId = null; changed = true; }
    if (changed) {
      enemy.path = null;
      enemy.pathIndex = 0;
      enemy.edgeId = null;
      enemy.edgeProgress = 0;
      enemy.reroutePending = true;
    }
  }
  clearFrontlineEnemyNetworkForAnchor(state, removedBaseId);
  return demobilizeOwnedBaseSquads(state, removedBaseId);
}
