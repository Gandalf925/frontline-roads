import { distance } from '../core/utilities.js';
import { activeOwnedBases, ownedBaseById } from '../base/field-bases.js';
import { activePlayerBases } from '../base/player-bases.js';
import { activeFriendlyBarrierEdgeIds, combineRoadPaths, findFriendlyRoadPathWeighted } from './routing-system.js';
import { enemyPursuitNodeId, friendlySquadPosition, FRIENDLY_SQUAD_DEFINITIONS } from './friendly-force-system.js';
import { buildCombatSpatialIndex } from './combat-spatial-index.js';
import { graphElementsNearPoint } from '../roads/road-graph.js';

export const FRIENDLY_ORDER_MODE = Object.freeze({
  RETREAT: 'RETREAT',
  RESUME: 'RESUME',
  WITHDRAW: 'WITHDRAW',
  DEPLOYMENT: 'DEPLOYMENT'
});

const ROUTE_LABELS = Object.freeze({
  shortest: '最短',
  safe: '敵回避',
  support: '味方援護'
});

function pointToSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return distance(point, { x: a.x + dx * t, y: a.y + dy * t });
}

function cellKey(x, y, size) {
  return `${Math.floor(x / size)},${Math.floor(y / size)}`;
}

function createPointIndex(entries, cellSize = 128) {
  const cells = new Map();
  for (const entry of entries) {
    const key = cellKey(entry.point.x, entry.point.y, cellSize);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(entry);
  }
  return {
    query(point, range) {
      const result = [];
      const minX = Math.floor((point.x - range) / cellSize);
      const maxX = Math.floor((point.x + range) / cellSize);
      const minY = Math.floor((point.y - range) / cellSize);
      const maxY = Math.floor((point.y + range) / cellSize);
      const rangeSquared = range * range;
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          for (const entry of cells.get(`${x},${y}`) ?? []) {
            const dx = entry.point.x - point.x;
            const dy = entry.point.y - point.y;
            if (dx * dx + dy * dy <= rangeSquared) result.push(entry);
          }
        }
      }
      return result;
    }
  };
}

function edgeGeometry(state, edge) {
  const a = state.world.roadGraph.nodeById.get(edge.a);
  const b = state.world.roadGraph.nodeById.get(edge.b);
  if (!a || !b) return null;
  return { a, b, middle: edge.mid ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

function createRouteAnalysis(state) {
  const enemySpatial = buildCombatSpatialIndex(state, 96);
  const blockedEdgeIds = activeFriendlyBarrierEdgeIds(state);
  const supportEntries = [];
  let maximumSupportRange = 110;
  for (const base of activeOwnedBases(state)) {
    if (base.status !== 'ESTABLISHED' || base.hp <= 0) continue;
    const point = state.world.roadGraph.nodeById.get(base.nodeId) ?? base;
    supportEntries.push({ point, range: 110, value: 1.25 });
  }
  for (const defense of state.combat.defenses ?? []) {
    if (defense.kind !== 'tower' || defense.hp <= 0) continue;
    const point = state.world.roadGraph.nodeById.get(defense.nodeId);
    if (!point) continue;
    const range = Math.max(50, Number(defense.range) || 80);
    maximumSupportRange = Math.max(maximumSupportRange, range);
    supportEntries.push({ point, range, value: 0.6 });
  }
  const supportSpatial = createPointIndex(supportEntries, 128);
  const pressureCache = new Map();
  const supportCache = new Map();

  return {
    enemySpatial,
    blockedEdgeIds,
    pressure(edge) {
      if (pressureCache.has(edge.id)) return pressureCache.get(edge.id);
      const geometry = edgeGeometry(state, edge);
      if (!geometry) return 0;
      let pressure = 0;
      for (const entry of enemySpatial.query(geometry.middle, 90)) {
        const gap = distance(geometry.middle, entry.position);
        pressure += (1 - gap / 90) * Math.max(1, Number(entry.enemy.level) || 1);
      }
      pressureCache.set(edge.id, pressure);
      return pressure;
    },
    support(edge) {
      if (supportCache.has(edge.id)) return supportCache.get(edge.id);
      const geometry = edgeGeometry(state, edge);
      if (!geometry) return 0;
      let support = 0;
      for (const entry of supportSpatial.query(geometry.middle, maximumSupportRange)) {
        if (distance(geometry.middle, entry.point) <= entry.range) support += entry.value;
      }
      supportCache.set(edge.id, support);
      return support;
    },
    enemiesNearSegment(a, b, range = 32) {
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const radius = distance(a, b) / 2 + range;
      return enemySpatial.query(middle, radius)
        .filter(entry => pointToSegmentDistance(entry.position, a, b) <= range);
    }
  };
}

function pathWithStrategy(state, startId, targetId, strategy, analysis, penalizedEdges = null) {
  return findFriendlyRoadPathWeighted(state, startId, targetId, edge => {
    let weight = edge.length;
    if (strategy === 'safe') weight *= 1 + analysis.pressure(edge) * 2.25;
    if (strategy === 'support') {
      const support = analysis.support(edge);
      const pressure = analysis.pressure(edge);
      weight *= Math.max(0.58, 1.18 - Math.min(0.6, support * 0.14) + pressure * 0.45);
    }
    if (penalizedEdges?.has(edge.id)) weight *= 8;
    return weight;
  }, analysis.blockedEdgeIds);
}

function routeThrough(state, startId, waypointNodeIds, destinationNodeId, strategy, analysis, penalizedEdges = null) {
  const targets = [...waypointNodeIds, destinationNodeId];
  const paths = [];
  let cursor = startId;
  for (const targetId of targets) {
    const segment = pathWithStrategy(state, cursor, targetId, strategy, analysis, penalizedEdges);
    if (!segment) return null;
    paths.push(segment);
    cursor = targetId;
  }
  return combineRoadPaths(paths);
}

function currentEdgeEndpoints(state, squad) {
  if (!squad.edgeId || !(squad.edgeProgress > 0)) return null;
  const graph = state.world.roadGraph;
  const edge = graph.edgeById.get(squad.edgeId);
  const fromId = squad.path?.nodeIds?.[squad.pathIndex];
  const toId = squad.path?.nodeIds?.[squad.pathIndex + 1];
  const from = fromId ? graph.nodeById.get(fromId) : null;
  const to = toId ? graph.nodeById.get(toId) : null;
  if (!edge || !from || !to || squad.edgeProgress >= edge.length) return null;
  return {
    edge,
    fromId,
    toId,
    from,
    to,
    progress: Math.max(0, Math.min(edge.length, Number(squad.edgeProgress) || 0)),
    remaining: Math.max(0, edge.length - (Number(squad.edgeProgress) || 0))
  };
}

function currentEdgeLead(state, squad, path) {
  const endpoints = currentEdgeEndpoints(state, squad);
  const startNodeId = path?.nodeIds?.[0] ?? null;
  if (!endpoints || !startNodeId) return null;
  const current = friendlySquadPosition(state, squad);
  if (startNodeId === endpoints.toId) {
    return { edge: endpoints.edge, from: current, to: endpoints.to, distance: endpoints.remaining };
  }
  if (startNodeId === endpoints.fromId) {
    return { edge: endpoints.edge, from: current, to: endpoints.from, distance: endpoints.progress };
  }
  return null;
}

function pathMetrics(state, path, speed, analysis, squad) {
  let physicalDistance = 0;
  let enemyContacts = 0;
  let supportScore = 0;
  const counted = new Set();
  const leading = currentEdgeLead(state, squad, path);
  if (leading) {
    physicalDistance += leading.distance;
    supportScore += analysis.support(leading.edge) * Math.min(1, leading.distance / Math.max(1, leading.edge.length));
    for (const entry of analysis.enemiesNearSegment(leading.from, leading.to)) {
      if (counted.has(entry.enemy.id)) continue;
      counted.add(entry.enemy.id);
      enemyContacts += Math.max(1, Number(entry.enemy.level) || 1);
    }
  }
  for (const edgeId of path.edgeIds) {
    const edge = state.world.roadGraph.edgeById.get(edgeId);
    if (!edge) continue;
    physicalDistance += edge.length;
    supportScore += analysis.support(edge);
    const geometry = edgeGeometry(state, edge);
    if (!geometry) continue;
    for (const entry of analysis.enemiesNearSegment(geometry.a, geometry.b)) {
      if (counted.has(entry.enemy.id)) continue;
      counted.add(entry.enemy.id);
      enemyContacts += Math.max(1, Number(entry.enemy.level) || 1);
    }
  }
  const risk = enemyContacts <= 1 ? '低' : enemyContacts <= 4 ? '中' : '高';
  return {
    physicalDistance,
    etaSeconds: physicalDistance / Math.max(0.1, speed),
    enemyContacts,
    supportScore,
    risk
  };
}

export function commandStartNodeId(state, squad) {
  if (squad.edgeId && (squad.edgeProgress ?? 0) > 0 && squad.path?.nodeIds?.[squad.pathIndex + 1]) return squad.path.nodeIds[squad.pathIndex + 1];
  return squad.nodeId;
}

export function nearestRoadNode(state, point, tolerance = Infinity) {
  const graph = state.world.roadGraph;
  const nearby = graph ? graphElementsNearPoint(graph, point, tolerance).nodes : [];
  let best = null;
  let bestDistance = Infinity;
  for (const node of nearby) {
    const gap = distance(point, node);
    if (gap < bestDistance) { best = node; bestDistance = gap; }
  }
  return best && bestDistance <= tolerance ? { node: best, distance: bestDistance } : null;
}

export function orderDestinationNodeId(state, squad, mode) {
  if (mode === FRIENDLY_ORDER_MODE.RESUME) {
    if (squad.heldOrder === 'RETREAT' && squad.heldDestinationNodeId) return squad.heldDestinationNodeId;
    if (squad.missionType === 'RECOVERY') {
      return (state.world.recoveryItems ?? []).find(item => item.id === squad.targetRecoveryItemId && item.assignedSquadId === squad.id)?.nodeId ?? null;
    }
    if (squad.missionType === 'INTERCEPT') {
      const enemy = state.combat.enemies.find(item => item.id === squad.targetEnemyId && item.hp > 0 && item.departDelay <= 0);
      return enemyPursuitNodeId(state, enemy);
    }
    const targetId = squad.missionTargetBaseId ?? squad.targetBaseId;
    return state.world.enemyBases.find(base => base.id === targetId && base.alive && base.hp > 0)?.nodeId ?? null;
  }
  if (mode === FRIENDLY_ORDER_MODE.WITHDRAW) {
    return ownedBaseById(state, squad.originBaseId)?.nodeId ?? activePlayerBases(state)[0]?.nodeId ?? null;
  }
  return null;
}

export function validateRetreatDestination(state, squad, nodeId) {
  const node = state.world.roadGraph.nodeById.get(nodeId);
  if (!node) return { ok: false, reasonKey: 'combat.order.selectRoadPoint', reason: '道路上の地点を選択してください。' };
  const startId = commandStartNodeId(state, squad);
  if (nodeId === startId) return { ok: false, reasonKey: 'combat.order.selectDifferentRetreatPoint', reason: '現在の進路先とは別の地点を選択してください。' };
  const missionId = squad.missionTargetBaseId ?? squad.targetBaseId;
  const targetBase = state.world.enemyBases.find(base => base.id === missionId && base.alive && base.hp > 0);
  const targetEnemy = squad.missionType === 'INTERCEPT'
    ? state.combat.enemies.find(enemy => enemy.id === squad.targetEnemyId && enemy.hp > 0 && enemy.departDelay <= 0)
    : null;
  const targetNodeId = targetEnemy ? enemyPursuitNodeId(state, targetEnemy) : targetBase?.nodeId;
  if (targetNodeId) {
    const targetNode = state.world.roadGraph.nodeById.get(targetNodeId);
    const start = state.world.roadGraph.nodeById.get(startId) ?? friendlySquadPosition(state, squad);
    const isOwnedBase = activeOwnedBases(state).some(base => base.nodeId === nodeId);
    if (!isOwnedBase && targetNode && distance(node, targetNode) + 5 < distance(start, targetNode)) {
      return { ok: false, reasonKey: 'combat.order.retreatAwayFromEnemyBase', reason: '後退地点は現在より敵基地から遠い道路上を選択してください。' };
    }
  }
  return { ok: true, node };
}

function routeFromBestCurrentEdgeExit(state, squad, fallbackStartId, waypointNodeIds, destinationNodeId, strategy, analysis, penalizedEdges = null) {
  const endpoints = currentEdgeEndpoints(state, squad);
  if (!endpoints) return routeThrough(state, fallbackStartId, waypointNodeIds, destinationNodeId, strategy, analysis, penalizedEdges);
  const starts = [
    { nodeId: endpoints.fromId, leadingDistance: endpoints.progress },
    { nodeId: endpoints.toId, leadingDistance: endpoints.remaining }
  ].filter((entry, index, list) => entry.nodeId && list.findIndex(other => other.nodeId === entry.nodeId) === index);
  let best = null;
  for (const start of starts) {
    const path = routeThrough(state, start.nodeId, waypointNodeIds, destinationNodeId, strategy, analysis, penalizedEdges);
    if (!path) continue;
    const score = start.leadingDistance + Math.max(0, Number(path.cost) || 0);
    if (!best || score < best.score) best = { path, score };
  }
  return best?.path ?? null;
}

function buildRouteOptions(state, squad, startId, destinationNodeId, waypointNodeIds = []) {
  if (!startId || !destinationNodeId) return [];
  const definition = FRIENDLY_SQUAD_DEFINITIONS[squad.type] ?? FRIENDLY_SQUAD_DEFINITIONS.assault;
  const analysis = createRouteAnalysis(state);
  const options = [];
  const signatures = new Set();
  const addOption = (id, label, path) => {
    if (!path) return false;
    const signature = `${path.nodeIds.join('>')}|${path.edgeIds.join('|')}`;
    if (signatures.has(signature)) return false;
    signatures.add(signature);
    options.push({ id, label, path, ...pathMetrics(state, path, definition.speed, analysis, squad) });
    return true;
  };
  for (const strategy of ['shortest', 'safe', 'support']) {
    addOption(strategy, ROUTE_LABELS[strategy], routeFromBestCurrentEdgeExit(state, squad, startId, waypointNodeIds, destinationNodeId, strategy, analysis));
  }
  let detourIndex = 1;
  for (const basis of [...options]) {
    if (options.length >= 3) break;
    const penalized = new Set(basis.path.edgeIds);
    const path = routeFromBestCurrentEdgeExit(state, squad, startId, waypointNodeIds, destinationNodeId, 'shortest', analysis, penalized);
    if (addOption(`detour-${detourIndex}`, `別経路${detourIndex}`, path)) detourIndex += 1;
  }
  options.sort((a, b) => a.physicalDistance - b.physicalDistance || a.id.localeCompare(b.id));
  return options.slice(0, 3);
}

export function deploymentRouteSubject(squadType, originNodeId) {
  return {
    id: null,
    type: FRIENDLY_SQUAD_DEFINITIONS[squadType] ? squadType : 'assault',
    nodeId: originNodeId,
    edgeId: null,
    edgeProgress: 0,
    path: null,
    pathIndex: 0
  };
}

export function buildDeploymentRouteOptions(state, squadType, originNodeId, destinationNodeId, waypointNodeIds = []) {
  const subject = deploymentRouteSubject(squadType, originNodeId);
  return buildRouteOptions(state, subject, originNodeId, destinationNodeId, waypointNodeIds);
}

export function buildFriendlyRouteOptions(state, squad, destinationNodeId, waypointNodeIds = []) {
  return buildRouteOptions(state, squad, commandStartNodeId(state, squad), destinationNodeId, waypointNodeIds);
}

function routeWorldPoints(state, squad, route) {
  const points = [friendlySquadPosition(state, squad)];
  for (const nodeId of route?.path?.nodeIds ?? []) {
    const node = state.world.roadGraph.nodeById.get(nodeId);
    if (!node) continue;
    if (!points.length || distance(points[points.length - 1], node) > 0.01) points.push(node);
  }
  return points;
}

export function friendlyRouteIndexAtPoint(state, squad, routes, point, tolerance) {
  let bestIndex = -1;
  let bestDistance = Infinity;
  routes.forEach((route, index) => {
    const points = routeWorldPoints(state, squad, route);
    for (let cursor = 0; cursor < points.length - 1; cursor += 1) {
      const gap = pointToSegmentDistance(point, points[cursor], points[cursor + 1]);
      if (gap < bestDistance) {
        bestDistance = gap;
        bestIndex = index;
      }
    }
  });
  return bestDistance <= tolerance ? bestIndex : -1;
}
