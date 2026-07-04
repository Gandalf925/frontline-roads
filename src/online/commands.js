import { CommandRegistry } from './command-log.js';
import { worldNow } from '../core/utilities.js';
import {
  allOutAssault,
  dispatchCoordinatedSquads,
  dispatchFriendlySquad,
  holdFriendlySquad,
  issueFriendlyRouteOrder,
  repairNearbyDefenseWithEngineer,
  queueFriendlyDispatch,
  rallyReadySquadsToBase,
  setEngineerAutoRepairPatrol
} from '../combat/friendly-force-system.js';
import { BuildSystem } from '../combat/build-system.js';
import { PlayerBaseSystem, dismantlePlayerBase } from '../base/player-base-system.js';
import { FieldBaseSystem, dismantleFieldBase } from '../base/field-base-system.js';
import { ProgressionSystem, safeProjectContributionAmount } from '../civilization/progression-system.js';
import { SettlementSystem } from '../civilization/settlement-system.js';
import { ProductionSystem } from '../civilization/production-system.js';
import { CIVILIZATION_PROJECTS } from '../civilization/data.js';
import { claimDailyMission } from '../civilization/daily-missions.js';
import { RoadsideSupplySystem } from '../exploration/roadside-supplies.js';
import { RecoverySystem } from '../exploration/recovery-system.js';

function withBuildSystem(events, fn) {
  return fn(new BuildSystem(events));
}

function withPlayerBaseSystem(events, fn) {
  return fn(new PlayerBaseSystem(events));
}

function withFieldBaseSystem(events, fn) {
  return fn(new FieldBaseSystem(events));
}

function withProgressionSystem(events, fn) {
  return fn(new ProgressionSystem(events));
}

function withSettlementSystem(events, fn) {
  return fn(new SettlementSystem(events));
}

function withProductionSystem(events, fn) {
  return fn(new ProductionSystem(events));
}

function withRoadsideSupplySystem(events, fn) {
  return fn(new RoadsideSupplySystem(events));
}

function withRecoverySystem(events, fn) {
  return fn(new RecoverySystem(events));
}

function safeAllContribution(state, { basicOnly = false } = {}, events = null) {
  return withProgressionSystem(events, progression => {
    let total = 0;
    const protectedKeys = new Set(['bronzeIngot', 'wroughtIron', 'steel', 'mechanism']);
    const project = state.civilization?.project;
    const definition = project ? CIVILIZATION_PROJECTS[project.targetLevel] : null;
    for (const key of Object.keys(definition?.contributions ?? {})) {
      if (basicOnly && protectedKeys.has(key)) continue;
      const amount = safeProjectContributionAmount(state, key);
      if (amount <= 0) continue;
      const contributed = progression.contribute(state, key, amount);
      if (contributed?.ok) total += contributed.amount;
    }
    return total > 0
      ? { ok: true, amount: total }
      : { ok: false, reasonKey: basicOnly ? 'reason.civilization.noSafeBasicContribution' : 'reason.civilization.noSafeContribution', reason: basicOnly ? '加工・金属資材を除外し、予備を残して納入できる資源がありません。' : '予備を残して一括納入できる資源がありません。' };
  });
}

// Serializable command set for the online foundation. Every executor delegates
// to the same simulation functions the single-player UI uses, accepts only
// JSON-safe payload fields, and derives everything else from state.
export function createDefaultCommandRegistry() {
  const registry = new CommandRegistry();

  registry.register('friendly.dispatch', (state, payload, events) =>
    dispatchFriendlySquad(
      state,
      String(payload.squadType ?? 'assault'),
      String(payload.originBaseId ?? ''),
      String(payload.targetId ?? ''),
      events,
      String(payload.targetKind ?? 'enemyBase'),
      payload.routeOverride ?? null
    ));

  registry.register('friendly.coordinatedDispatch', (state, payload, events) =>
    dispatchCoordinatedSquads(
      state,
      String(payload.targetId ?? ''),
      Array.isArray(payload.squadTypes) ? payload.squadTypes.map(type => String(type)) : [],
      events,
      payload.options && typeof payload.options === 'object' ? payload.options : null
    ));

  registry.register('friendly.hold', (state, payload, events) =>
    holdFriendlySquad(state, String(payload.squadId ?? ''), events));

  registry.register('friendly.engineerRepairNearby', (state, payload, events) =>
    repairNearbyDefenseWithEngineer(state, String(payload.squadId ?? ''), events));

  registry.register('friendly.routeOrder', (state, payload, events) =>
    issueFriendlyRouteOrder(state, String(payload.squadId ?? ''), {
      order: String(payload.order ?? ''),
      path: payload.path ?? null,
      destinationNodeId: payload.destinationNodeId == null ? null : String(payload.destinationNodeId)
    }, events));

  registry.register('friendly.rallyAll', (state, payload, events) =>
    rallyReadySquadsToBase(state, String(payload.baseId ?? ''), events));

  registry.register('friendly.autoRepairPatrol', (state, payload, events) =>
    setEngineerAutoRepairPatrol(state, String(payload.squadId ?? ''), payload.enabled !== false, events));

  registry.register('friendly.queueDispatch', (state, payload, events) =>
    queueFriendlyDispatch(state, String(payload.squadId ?? ''), String(payload.targetId ?? ''), events, {
      squadType: payload.squadType == null ? null : String(payload.squadType),
      targetKind: String(payload.targetKind ?? 'enemyBase'),
      routeOverride: payload.routeOverride ?? null
    }));

  registry.register('friendly.allOutAssault', (state, payload, events) =>
    allOutAssault(state, String(payload.targetId ?? ''), events));

  registry.register('defense.build', (state, payload, events) => withBuildSystem(events, buildSystem => {
    const type = String(payload.defenseType ?? '');
    const nodeId = String(payload.nodeId ?? '');
    const candidate = buildSystem.listBuildSites(state, type)
      .find(site => String(site.nodeId ?? site.node?.id ?? '') === nodeId);
    if (!candidate) return { ok: false, reasonKey: 'reason.defense.noBuildSiteAtNode', reason: '指定地点に建設候補がありません。' };
    return buildSystem.buildCandidate(state, candidate);
  }));

  registry.register('defense.remove', (state, payload, events) =>
    withBuildSystem(events, buildSystem => buildSystem.removeDefense(state, String(payload.defenseId ?? ''))));

  registry.register('defense.upgrade', (state, payload, events) =>
    withProgressionSystem(events, progression => progression.upgradeDefense(state, String(payload.defenseId ?? ''))));

  registry.register('defense.repair', (state, payload, events) =>
    withProgressionSystem(events, progression => progression.repairDefense(state, String(payload.defenseId ?? ''))));

  registry.register('defense.convertGate', (state, payload, events) =>
    withProgressionSystem(events, progression => progression.convertBarrierToGate(state, String(payload.defenseId ?? ''))));

  registry.register('base.establishMajor', (state, _payload, events) =>
    withPlayerBaseSystem(events, system => system.establishAtCurrentLocation(state, worldNow(state))));

  registry.register('base.establishField', (state, _payload, events) =>
    withFieldBaseSystem(events, system => system.establishAtCurrentLocation(state, worldNow(state))));

  registry.register('base.rebuildMajor', (state, payload, events) =>
    withPlayerBaseSystem(events, system => system.rebuild(state, String(payload.baseId ?? ''), worldNow(state))));

  registry.register('base.rebuildField', (state, payload, events) =>
    withFieldBaseSystem(events, system => system.rebuild(state, String(payload.baseId ?? ''), worldNow(state))));

  registry.register('base.dismantleField', (state, payload, events) =>
    dismantleFieldBase(state, String(payload.baseId ?? ''), events));

  registry.register('base.dismantleMajor', (state, payload, events) =>
    dismantlePlayerBase(state, String(payload.baseId ?? ''), events));

  registry.register('civilization.contributeSafeAll', (state, payload, events) =>
    safeAllContribution(state, { basicOnly: Boolean(payload.basicOnly) }, events));

  registry.register('civilization.contributeSafeResource', (state, payload, events) =>
    withProgressionSystem(events, progression => progression.contributeSafely(state, String(payload.resource ?? ''))));

  registry.register('civilization.contributeAllResource', (state, payload, events) =>
    withProgressionSystem(events, progression => progression.contribute(state, String(payload.resource ?? ''))));

  registry.register('civilization.withdraw', (state, _payload, events) =>
    withProgressionSystem(events, progression => progression.withdraw(state)));

  registry.register('civilization.startProject', (state, _payload, events) =>
    withProgressionSystem(events, progression => progression.start(state)));

  registry.register('civilization.building.build', (state, payload, events) =>
    withSettlementSystem(events, settlement => settlement.build(state, String(payload.type ?? ''))));

  registry.register('civilization.building.repair', (state, payload, events) =>
    withSettlementSystem(events, settlement => settlement.repair(state, String(payload.buildingId ?? ''))));

  registry.register('civilization.building.demolish', (state, payload, events) =>
    withSettlementSystem(events, settlement => settlement.demolish(state, String(payload.buildingId ?? ''))));

  registry.register('civilization.production.enqueue', (state, payload, events) => withProductionSystem(events, production => {
    const buildingId = String(payload.buildingId ?? '');
    const recipeId = String(payload.recipeId ?? '');
    const requested = payload.quantity === 'max'
      ? production.maximumProducible(state, buildingId, recipeId).quantity
      : Math.max(1, Number(payload.quantity) || 1);
    if (requested <= 0) return production.maximumProducible(state, buildingId, recipeId);
    return production.enqueue(state, buildingId, recipeId, requested);
  }));

  registry.register('civilization.production.collect', (state, payload, events) =>
    withProductionSystem(events, production => production.collectOutput(state, String(payload.buildingId ?? ''))));

  registry.register('daily.claimMission', (state, payload, events) =>
    claimDailyMission(state, String(payload.missionId ?? ''), events));

  registry.register('recovery.beginCollection', (state, payload, events) =>
    withRecoverySystem(events, system => system.beginCollection(state, String(payload.itemId ?? ''), worldNow(state))));

  registry.register('roadside.refresh', (state, _payload, events) =>
    withRoadsideSupplySystem(events, system => ({ ok: true, supplies: system.refresh(state, true) })));

  registry.register('roadside.use', (state, payload, events) =>
    withRoadsideSupplySystem(events, system => system.use(state, String(payload.key ?? ''))));

  registry.register('roadside.useDeploymentTarget', (state, payload, events) =>
    withRoadsideSupplySystem(events, system => system.useDeploymentTarget(state, String(payload.key ?? ''), payload.target ?? null)));

  registry.register('roadside.useLureTarget', (state, payload, events) =>
    withRoadsideSupplySystem(events, system => system.useLureTarget(state, payload.target ?? null)));

  registry.register('roadside.useOnTarget', (state, payload, events) =>
    withRoadsideSupplySystem(events, system => system.useOnTarget(state, String(payload.key ?? ''), payload.target ?? null)));

  registry.register('roadside.useOnSquad', (state, payload, events) =>
    withRoadsideSupplySystem(events, system => system.useOnSquad(state, String(payload.key ?? ''), String(payload.squadId ?? ''))));

  registry.register('roadside.craft', (state, payload, events) =>
    withRoadsideSupplySystem(events, system => system.craft(state, String(payload.recipeKey ?? ''))));

  registry.register('roadside.removeMine', (state, payload, events) =>
    withRoadsideSupplySystem(events, system => system.removeMine(state, String(payload.mineId ?? ''))));

  return registry;
}
