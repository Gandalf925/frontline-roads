import { distance, stableId, worldNow } from '../core/utilities.js';
import { chunkBounds, chunkForWorldPoint, chunkId } from '../roads/world-chunk-grid.js';
import { spawnEnemy } from '../combat/enemy-system.js';
import { activeFieldBases } from '../base/field-bases.js';
import { activePlayerBases } from '../base/player-bases.js';
import { reachableRoadNodeIds } from '../roads/road-graph.js';

const MAX_FRONTIER_SOURCES = 8;
const ACTIVE_FRONTIER_SOURCE_LIMIT = 3;
const FRONTIER_ACTIVE_WAVE_LIMIT_BY_CIVILIZATION = Object.freeze([1, 1, 2, 2, 2, 3, 3, 3]);
const FRONTIER_SPAWN_INTERVAL_MULTIPLIER = 1.65;
const FRONTIER_EDGE_MARGIN_METERS = 130;
const MIN_SOURCE_SEPARATION_METERS = 720;
const FRONTIER_SPAWN_RETRY_SECONDS = 12;

const DIRECTIONS = Object.freeze([
  { key: 'W', dx: -1, dy: 0, near: (point, bounds) => point.x - bounds.minX <= FRONTIER_EDGE_MARGIN_METERS },
  { key: 'E', dx: 1, dy: 0, near: (point, bounds) => bounds.maxX - point.x <= FRONTIER_EDGE_MARGIN_METERS },
  { key: 'N', dx: 0, dy: -1, near: (point, bounds) => point.y - bounds.minY <= FRONTIER_EDGE_MARGIN_METERS },
  { key: 'S', dx: 0, dy: 1, near: (point, bounds) => bounds.maxY - point.y <= FRONTIER_EDGE_MARGIN_METERS }
]);

const PROFILE_DEFINITIONS = Object.freeze({
  patrol: { label: '巡回部隊', waves: [['scout', 'infantry'], ['scout', 'infantry', 'shield'], ['scout', 'shield', 'infantry', 'infantry']] },
  sabotage: { label: '工作部隊', waves: [['raider', 'scout'], ['raider', 'infantry', 'scout'], ['raider', 'raider', 'engineer', 'scout']] },
  breach: { label: '突破部隊', waves: [['engineer', 'infantry'], ['engineer', 'shield', 'infantry'], ['engineer', 'heavy', 'shield', 'infantry']] },
  siege: { label: '攻城部隊', waves: [['shield', 'infantry', 'infantry'], ['heavy', 'shield', 'engineer'], ['heavy', 'heavy', 'engineer', 'shield']] }
});

function hashNumber(text) {
  let hash = 2166136261;
  for (const character of String(text)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function observedChunkIds(state) {
  const result = new Set([
    ...(state.world.roadChunks?.loaded ?? []),
    ...(state.world.roadChunks?.empty ?? [])
  ]);
  for (const node of state.world.roadGraph?.nodes ?? []) result.add(chunkForWorldPoint(node).id);
  return result;
}

function settlementNodeIds(state) {
  const nodeIds = [
    state.world.city?.nodeId,
    ...activePlayerBases(state).map(base => base.nodeId),
    ...activeFieldBases(state).map(base => base.nodeId)
  ];
  return [...new Set(nodeIds.filter(nodeId => state.world.roadGraph?.nodeById?.has(nodeId)))];
}

function reachableFrontierNodeIds(state) {
  return reachableRoadNodeIds(state.world.roadGraph, settlementNodeIds(state));
}

function relocateWaitingFrontierEnemies(state, source, nextNodeId) {
  if (!nextNodeId) return;
  for (const enemy of state.combat.enemies ?? []) {
    if (enemy.hp <= 0 || enemy.sourceBaseId !== source.id || enemy.edgeId) continue;
    const hasDeparted = enemy.hasDeparted === true
      || (Number(enemy.pathIndex) || 0) > 0
      || (Number(enemy.edgeProgress) || 0) > 0;
    if (hasDeparted || (Number(enemy.departDelay) || 0) <= 0 && enemy.path) continue;
    if (enemy.nodeId === nextNodeId && enemy.path) continue;
    enemy.nodeId = nextNodeId;
    enemy.path = null;
    enemy.pathIndex = 0;
    enemy.edgeId = null;
    enemy.edgeProgress = 0;
    enemy.reroutePending = true;
    enemy.routeFailureSeconds = 0;
    enemy.routeFailureTopologyRevision = null;
  }
}


export function findFrontierCandidates(state) {
  const graph = state.world.roadGraph;
  const cityNode = graph?.nodeById?.get(state.world.city?.nodeId);
  if (!graph || !cityNode || !state.world.roadChunks) return [];
  const observed = observedChunkIds(state);
  const reachable = reachableFrontierNodeIds(state);
  const size = state.world.roadChunks.sizeMeters;
  const candidates = [];
  for (const node of graph.terminalNodes ?? graph.nodes) {
    if (!reachable.has(node.id)) continue;
    const degree = graph.adjacency.get(node.id)?.length ?? 0;
    if (degree !== 1 || distance(node, cityNode) < 260) continue;
    const chunk = chunkForWorldPoint(node, size);
    const bounds = chunkBounds(chunk, size);
    const connection = graph.adjacency.get(node.id)?.[0];
    const neighbor = connection ? graph.nodeById.get(connection.to) : null;
    const outward = neighbor ? normalizeVector({ x: node.x - neighbor.x, y: node.y - neighbor.y }) : { x: 0, y: 0 };
    const availableDirections = DIRECTIONS
      .filter(direction => direction.near(node, bounds))
      .map(direction => ({
        direction,
        neighborId: chunkId(chunk.x + direction.dx, chunk.y + direction.dy),
        alignment: direction.dx * outward.x + direction.dy * outward.y
      }))
      .filter(item => !observed.has(item.neighborId))
      .sort((a, b) => b.alignment - a.alignment);
    const selected = availableDirections[0];
    if (!selected) continue;
    const direction = selected.direction;
    candidates.push({
      nodeId: node.id,
      point: { x: node.x, y: node.y },
      direction: { x: direction.dx, y: direction.dy },
      directionKey: direction.key,
      neighborChunkId: selected.neighborId,
      cityDistance: distance(node, cityNode)
    });
  }
  candidates.sort((a, b) => b.cityDistance - a.cityDistance || a.nodeId.localeCompare(b.nodeId));
  const deduplicated = [];
  for (const candidate of candidates) {
    if (deduplicated.some(item => distance(item.point, candidate.point) < 180 && item.directionKey === candidate.directionKey)) continue;
    deduplicated.push(candidate);
  }
  return deduplicated;
}

function createSource(candidate, worldTimeMs) {
  const seed = `${Math.round(candidate.point.x / 50)}:${Math.round(candidate.point.y / 50)}:${candidate.directionKey}`;
  const hash = hashNumber(seed);
  const sourceDistance = 700 + (hash % 501);
  const point = {
    x: candidate.point.x + candidate.direction.x * sourceDistance,
    y: candidate.point.y + candidate.direction.y * sourceDistance
  };
  const profiles = Object.keys(PROFILE_DEFINITIONS);
  const profile = profiles[hash % profiles.length];
  const threat = 1 + ((hash >>> 5) % 3);
  return {
    id: stableId('frontier_source', Math.round(point.x / 25), Math.round(point.y / 25), profile),
    point,
    entryNodeId: candidate.nodeId,
    direction: candidate.direction,
    profile,
    threat,
    status: 'UNCONFIRMED',
    signalStage: 'DISTANT',
    spawnClock: 60 + ((hash >>> 9) % 120),
    spawnIntervalSec: 420 - threat * 45 + ((hash >>> 13) % 61),
    wavesSent: 0,
    createdAt: worldTimeMs,
    discoveredAt: null,
    clearedAt: null
  };
}

function nearestEntryNode(graph, source, candidates, reachableNodeIds) {
  const nearest = candidates.reduce((best, candidate) => {
    const gap = distance(candidate.point, source.point);
    return !best || gap < best.gap ? { nodeId: candidate.nodeId, point: candidate.point, gap } : best;
  }, null);
  if (nearest) return nearest;
  if (source.entryNodeId && reachableNodeIds.has(source.entryNodeId)) {
    const current = graph.nodeById.get(source.entryNodeId);
    if (current) return { nodeId: current.id, point: current, gap: distance(current, source.point), preserved: true };
  }
  return null;
}

function updateSignal(source, playerPoint, sourceChunkLoaded, worldTimeMs) {
  const gap = playerPoint ? distance(playerPoint, source.point) : Infinity;
  source.signalStage = gap <= 180 ? 'CONTACT' : gap <= 450 ? 'LOCATED' : gap <= 900 ? 'TRACE' : 'DISTANT';
  if (sourceChunkLoaded && source.status === 'UNCONFIRMED') {
    source.status = 'LOCATED';
    source.discoveredAt ??= worldTimeMs;
  }
  return gap;
}

export function ensureFrontierState(state) {
  state.world.frontierSources = Array.isArray(state.world.frontierSources) ? state.world.frontierSources : [];
  state.combat.waves.frontierReconcileClock = Number(state.combat.waves.frontierReconcileClock) || 0;
  for (const source of state.world.frontierSources) {
    source.spawnClock = Number(source.spawnClock) || 0;
    source.wavesSent = Number(source.wavesSent) || 0;
    source.status ??= 'UNCONFIRMED';
    source.signalStage ??= 'DISTANT';
  }
  return state.world.frontierSources;
}

export function reconcileFrontiers(state) {
  const sources = ensureFrontierState(state);
  const graph = state.world.roadGraph;
  if (!graph?.nodes?.length || !state.world.city || !state.world.roadChunks) return sources;
  const candidates = findFrontierCandidates(state);
  const reachable = reachableFrontierNodeIds(state);
  const playerObserved = new Set(state.world.roadChunks.playerObserved ?? state.world.roadChunks.loaded ?? []);
  const worldTimeMs = worldNow(state);

  for (const source of sources) {
    if (source.status === 'CLEARED') continue;
    const previousEntryNodeId = source.entryNodeId;
    const previousEntryReachable = Boolean(previousEntryNodeId && reachable.has(previousEntryNodeId));
    const entry = nearestEntryNode(graph, source, candidates, reachable);
    if (entry) {
      source.entryNodeId = entry.nodeId;
      source.direction = normalizeVector({ x: source.point.x - entry.point.x, y: source.point.y - entry.point.y });
      if (previousEntryNodeId !== entry.nodeId && !previousEntryReachable) {
        relocateWaitingFrontierEnemies(state, source, entry.nodeId);
      }
    } else {
      source.entryNodeId = null;
    }
    const sourceChunkObserved = playerObserved.has(chunkForWorldPoint(source.point, state.world.roadChunks.sizeMeters).id);
    updateSignal(source, state.player.worldPosition, sourceChunkObserved, worldTimeMs);
  }

  for (const candidate of candidates) {
    if (sources.filter(source => source.status !== 'CLEARED').length >= MAX_FRONTIER_SOURCES) break;
    const source = createSource(candidate, worldTimeMs);
    if (sources.some(existing => existing.status !== 'CLEARED' && distance(existing.point, source.point) < MIN_SOURCE_SEPARATION_METERS)) continue;
    sources.push(source);
  }
  return sources;
}

function waveForSource(state, source) {
  const profile = PROFILE_DEFINITIONS[source.profile] ?? PROFILE_DEFINITIONS.patrol;
  const civilizationBonus = Math.floor((state.civilization.level ?? 0) / 2);
  const tier = Math.min(3, Math.max(1, source.threat + civilizationBonus));
  return [...profile.waves[tier - 1]];
}

function frontierActiveWaveCount(state) {
  return Object.values(state.combat?.waves?.active ?? {})
    .filter(wave => (wave?.remaining ?? 0) > 0 && wave?.frontierSourceId)
    .length;
}

export function frontierActiveWaveLimit(state) {
  const level = Math.max(0, Math.min(7, Math.floor(Number(state?.civilization?.level) || 0)));
  const limit = FRONTIER_ACTIVE_WAVE_LIMIT_BY_CIVILIZATION[level] ?? FRONTIER_ACTIVE_WAVE_LIMIT_BY_CIVILIZATION[0];
  return state?.runtime?.offlineSimulation ? Math.max(1, Math.floor(limit * 0.50)) : limit;
}

export function frontierSpawnIntervalSeconds(source) {
  return Math.max(1, Number(source?.spawnIntervalSec) || 1) * FRONTIER_SPAWN_INTERVAL_MULTIPLIER;
}

function activeSources(state, reachableNodeIds) {
  return state.world.frontierSources
    .filter(source => source.status !== 'CLEARED' && source.entryNodeId && reachableNodeIds.has(source.entryNodeId))
    .sort((a, b) => b.threat - a.threat || a.id.localeCompare(b.id))
    .slice(0, ACTIVE_FRONTIER_SOURCE_LIMIT);
}

export function frontierPresentation(source) {
  const profile = PROFILE_DEFINITIONS[source?.profile] ?? PROFILE_DEFINITIONS.patrol;
  const stage = source?.signalStage ?? 'DISTANT';
  const identityVisible = ['LOCATED', 'CONTACT'].includes(stage) || source?.status === 'LOCATED';
  return {
    title: identityVisible ? profile.label : '未確認の敵性反応',
    profileLabel: identityVisible ? profile.label : '不明',
    stage,
    threat: Number(source?.threat) || 1
  };
}

export class FrontierSystem {
  constructor(events) { this.events = events; }

  reconcile(state) {
    return reconcileFrontiers(state);
  }

  spawnWave(state, source, reachableNodeIds = null) {
    const reachable = reachableNodeIds ?? reachableFrontierNodeIds(state);
    if (!source?.entryNodeId || !reachable.has(source.entryNodeId)) return false;
    const wave = waveForSource(state, source);
    const waveId = stableId('frontier_wave', source.id, source.wavesSent, worldNow(state));
    let spawned = 0;
    const pseudoBase = { id: source.id, nodeId: source.entryNodeId, wavesSent: source.wavesSent };
    wave.forEach((type, index) => {
      const enemy = spawnEnemy(state, pseudoBase, type, index * 7, waveId);
      if (!enemy) return;
      enemy.waveStartedAt = worldNow(state);
      enemy.frontierSourceId = source.id;
      spawned += 1;
    });
    if (spawned <= 0) return false;
    state.combat.waves.active ??= {};
    state.combat.waves.active[waveId] = {
      id: waveId,
      baseId: source.id,
      frontierSourceId: source.id,
      remaining: spawned,
      breached: false,
      startedAt: worldNow(state)
    };
    source.wavesSent += 1;
    this.events?.emit('combat:wave-launched', { frontierSourceId: source.id, waveId, count: spawned });
    this.events?.emit('message', { key: 'frontier.notice.enemyWaveInvaded', text: '未踏破の道路方面から敵部隊が侵入しました。進入方向を確認してください。' });
    return true;
  }

  update(state, deltaSeconds) {
    if (state?.lifecycle === 'DESTROYED' || state?.runtime?.gameOver) return;
    ensureFrontierState(state);
    state.combat.waves.frontierReconcileClock += deltaSeconds;
    let reachable = reachableFrontierNodeIds(state);
    const invalidEntryExists = state.world.frontierSources.some(source =>
      source.status !== 'CLEARED' && source.entryNodeId && !reachable.has(source.entryNodeId)
    );
    if (state.combat.waves.frontierReconcileClock >= 30 || state.world.frontierSources.length === 0 || invalidEntryExists) {
      state.combat.waves.frontierReconcileClock = 0;
      this.reconcile(state);
      reachable = reachableFrontierNodeIds(state);
    }
    const activeLimit = frontierActiveWaveLimit(state);
    for (const source of activeSources(state, reachable)) {
      source.spawnClock += deltaSeconds;
      const interval = frontierSpawnIntervalSeconds(source);
      while (source.spawnClock >= interval) {
        if (frontierActiveWaveCount(state) >= activeLimit) {
          source.spawnClock = Math.min(source.spawnClock, interval);
          break;
        }
        if (!this.spawnWave(state, source, reachable)) {
          source.spawnClock = Math.max(0, interval - FRONTIER_SPAWN_RETRY_SECONDS);
          break;
        }
        source.spawnClock -= interval;
      }
    }
  }
}
