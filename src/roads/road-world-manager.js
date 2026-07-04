import { ROAD_CONFIG } from '../core/constants.js';
import { distance, stableId } from '../core/utilities.js';
import { attachGraphIndexes, graphElementsNearPoint, roadGraphBounds } from './road-graph.js';
import { pointToSegmentProjection } from './geometry.js';
import { mergeRoadGraphs } from './graph-merge.js';
import {
  chunkCenterLocation,
  chunkForWorldPoint,
  chunksIntersectingCircle,
  chunksNearWorldPoint,
  roadChunkAdd,
  roadChunkDelete,
  roadChunkHas,
  roadChunkSet,
  roadChunkState
} from './world-chunk-grid.js';
import { activeSurveyFacilities, surveyChunkCandidates, synchronizeSurveyFacility } from '../exploration/survey-system.js';
import { defenseRuntimeDefinition } from '../combat/definitions.js';

const ROAD_CHUNK_CACHE_VERSION = 4;


function currentStoreState(store) {
  if (typeof store?.renderView === 'function') return store.renderView();
  if (typeof store?.read === 'function') return store.read(state => state);
  return store?.snapshot?.() ?? null;
}

function statusMessage(type, chunkId, key, params = {}, text = '') {
  return { type, chunkId, key, params, text };
}

function nearestRoadDistance(graph, point, radius = ROAD_CONFIG.roadFrontierDistanceMeters * 2) {
  if (!graph?.nodeById || !point) return Infinity;
  const elements = graphElementsNearPoint(graph, point, radius);
  let nearest = Infinity;
  for (const node of elements.nodes) nearest = Math.min(nearest, distance(point, node));
  for (const edge of elements.edges) {
    const a = graph.nodeById.get(edge.a);
    const b = graph.nodeById.get(edge.b);
    if (!a || !b) continue;
    nearest = Math.min(nearest, pointToSegmentProjection(point, a, b).distance);
  }
  return nearest;
}

function isOuterTerminal(node, bounds, margin = ROAD_CONFIG.roadFrontierEdgeMarginMeters) {
  if (!bounds) return false;
  return node.x - bounds.minX <= margin
    || bounds.maxX - node.x <= margin
    || node.y - bounds.minY <= margin
    || bounds.maxY - node.y <= margin;
}

function nearestTerminalNode(graph, point, radius = ROAD_CONFIG.roadFrontierDistanceMeters) {
  const bounds = roadGraphBounds(graph);
  let best = null;
  let bestDistance = radius;
  for (const node of graphElementsNearPoint(graph, point, radius).nodes) {
    if ((graph.adjacency?.get(node.id)?.length ?? 0) !== 1 || !isOuterTerminal(node, bounds)) continue;
    const gap = distance(point, node);
    if (gap <= bestDistance) {
      best = node;
      bestDistance = gap;
    }
  }
  return best ? { node: best, distance: bestDistance } : null;
}

function normalizedDirection(from, to) {
  const dx = Number(to?.x) - Number(from?.x);
  const dy = Number(to?.y) - Number(from?.y);
  const magnitude = Math.hypot(dx, dy);
  return magnitude > 0 ? { x: dx / magnitude, y: dy / magnitude } : null;
}

function terminalOutwardDirection(graph, terminal) {
  const connection = graph?.adjacency?.get(terminal?.id)?.[0];
  const neighbor = connection ? graph.nodeById?.get(connection.to) : null;
  return neighbor ? normalizedDirection(neighbor, terminal) : null;
}

function movementExpansionCandidates(graph, point, previousPoint, sizeMeters) {
  const candidates = new Map();
  const add = (chunk, priority, reason) => {
    const current = candidates.get(chunk.id);
    if (!current || priority < current.priority) candidates.set(chunk.id, { ...chunk, priority, reason });
  };
  for (const chunk of chunksNearWorldPoint(point, sizeMeters)) add(chunk, 0, 'position');

  const moved = previousPoint ? distance(previousPoint, point) : 0;
  const movementDirection = moved >= ROAD_CONFIG.roadMinimumMovementMeters
    ? normalizedDirection(previousPoint, point)
    : null;
  const terminal = nearestTerminalNode(graph, point);
  const roadGap = nearestRoadDistance(graph, point);
  const nearFrontier = Boolean(terminal) || roadGap > ROAD_CONFIG.roadOffNetworkDistanceMeters;

  if (nearFrontier) {
    for (const chunk of chunksIntersectingCircle(point, ROAD_CONFIG.roadExpansionRadiusMeters, sizeMeters)) add(chunk, 1, 'road-frontier');
  }

  const direction = movementDirection ?? (terminal ? terminalOutwardDirection(graph, terminal.node) : null);
  if (direction && (movementDirection || nearFrontier)) {
    const origin = terminal?.node ?? point;
    const lookahead = {
      x: origin.x + direction.x * ROAD_CONFIG.roadLookaheadMeters,
      y: origin.y + direction.y * ROAD_CONFIG.roadLookaheadMeters
    };
    for (const chunk of chunksNearWorldPoint(lookahead, sizeMeters)) add(chunk, 2, 'movement-lookahead');
  }

  return {
    nearFrontier,
    moving: Boolean(movementDirection),
    roadGap,
    terminalDistance: terminal?.distance ?? Infinity,
    chunks: [...candidates.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  };
}

function compactChunkGraph(graph) {
  return {
    nodes: graph.nodes.map(({ lat, lon, ...node }) => ({ ...node })),
    edges: graph.edges.map(({ points, mid, angle, ...edge }) => ({ ...edge })),
    center: graph.center,
    source: graph.source,
    roadSpecVersion: graph.roadSpecVersion,
    chunkId: graph.chunkId,
    cacheVersion: ROAD_CHUNK_CACHE_VERSION
  };
}

const finite = value => Number.isFinite(Number(value));

function usableCachedChunk(graph) {
  if (Number(graph?.cacheVersion) !== ROAD_CHUNK_CACHE_VERSION) return false;
  if (Number(graph?.roadSpecVersion) < 4) return false;
  if (!graph?.center || !finite(graph.center.lat) || !finite(graph.center.lon)) return false;
  if (!Array.isArray(graph?.nodes) || graph.nodes.length <= 0) return false;
  if (!Array.isArray(graph?.edges) || graph.edges.length <= 0) return false;
  const nodeIds = new Set();
  for (const node of graph.nodes) {
    if (!node || !node.id || !finite(node.x) || !finite(node.y)) return false;
    nodeIds.add(String(node.id));
  }
  for (const edge of graph.edges) {
    if (!edge || !edge.id || !nodeIds.has(String(edge.a)) || !nodeIds.has(String(edge.b)) || !finite(edge.length) || Number(edge.length) <= 0) return false;
  }
  return true;
}

export function roadWorldId(graph) {
  const lat = Number(graph?.center?.lat ?? 0).toFixed(4);
  const lon = Number(graph?.center?.lon ?? 0).toFixed(4);
  return stableId('road_world', lat, lon);
}

export class RoadWorldManager {
  constructor({ roadService, cache, store, renderer = null, onGraphChanged = null, onStatus = null, now = () => Date.now() }) {
    this.roadService = roadService;
    this.cache = cache;
    this.store = store;
    this.renderer = renderer;
    this.onGraphChanged = onGraphChanged;
    this.onStatus = onStatus;
    this.now = now;
    this.queue = [];
    this.pending = new Set();
    this.chunkWaiters = new Map();
    this.running = false;
    this.abortController = null;
    this.lastSurveyCheckAt = 0;
    this.lastMovementPoint = null;
    this.generation = 0;
  }

  async restoreCachedChunks() {
    const state = currentStoreState(this.store);
    const graph = state.world.roadGraph;
    if (!graph || !this.cache?.isAvailable?.()) return { restored: 0 };
    const chunks = roadChunkState(state.world);
    const worldId = roadWorldId(graph);
    const candidates = (chunks.cached ?? []).filter(id => !roadChunkHas(chunks, 'integrated', id));
    const payloads = await Promise.all(candidates.map(async id => ({
      id,
      payload: await this.cache.get(worldId, id).catch(() => null)
    })));
    const staleIds = [];
    const valid = [];
    for (const item of payloads) {
      if (!usableCachedChunk(item.payload)) {
        if (item.payload) await this.cache.remove?.(worldId, item.id).catch(() => false);
        staleIds.push(item.id);
        continue;
      }
      attachGraphIndexes(item.payload);
      valid.push(item);
    }
    if (staleIds.length > 0 || valid.length > 0) {
      this.store.advance(draft => {
        const chunkState = roadChunkState(draft.world);
        for (const id of staleIds) roadChunkDelete(chunkState, 'cached', id);
        for (const [index, item] of valid.entries()) {
          mergeRoadGraphs(draft.world.roadGraph, item.payload, {
            chunkId: item.id,
            rebuildIndexes: index === valid.length - 1
          });
          roadChunkAdd(chunkState, 'loaded', item.id);
          roadChunkAdd(chunkState, 'cached', item.id);
          roadChunkAdd(chunkState, 'integrated', item.id);
        }
      }, 'roads:cache-restored', { validate: true });
    }
    if (valid.length > 0) this.graphChanged({ reason: 'cache', restored: valid.length });
    return { restored: valid.length };
  }

  considerLocation(location) {
    const state = currentStoreState(this.store);
    const graph = state.world.roadGraph;
    if (!graph || !location) return [];
    const chunks = roadChunkState(state.world);
    const worldPoint = Number.isFinite(Number(location.x)) && Number.isFinite(Number(location.y))
      ? location
      : state.player.worldPosition;
    if (!worldPoint) return [];

    const observedChunkId = chunkForWorldPoint(worldPoint, chunks.sizeMeters).id;
    const knownObservedChunk = roadChunkHas(chunks, 'loaded', observedChunkId) || roadChunkHas(chunks, 'empty', observedChunkId);
    if (knownObservedChunk && !roadChunkHas(chunks, 'playerObserved', observedChunkId)) {
      this.store.advance(draft => {
        const chunkState = roadChunkState(draft.world);
        roadChunkAdd(chunkState, 'playerObserved', observedChunkId);
        chunkState.updatedAt = this.now();
      }, 'roads:player-observed');
      // Observation affects exploration and enemy-base eligibility, but not road geometry.
      this.onGraphChanged?.({ reason: 'player-observed', chunkId: observedChunkId, topologyChanged: false });
    }

    const expansion = movementExpansionCandidates(graph, worldPoint, this.lastMovementPoint, chunks.sizeMeters);
    this.lastMovementPoint = { x: worldPoint.x, y: worldPoint.y };
    const retryCooldownMs = expansion.nearFrontier || expansion.moving
      ? ROAD_CONFIG.movementChunkRetryCooldownMs
      : ROAD_CONFIG.chunkRetryCooldownMs;
    const refresh = roadChunkSet(chunks, 'refresh');
    const loaded = roadChunkSet(chunks, 'loaded');
    const empty = roadChunkSet(chunks, 'empty');
    const candidates = expansion.chunks
      .filter(chunk => (refresh.has(chunk.id) || (!loaded.has(chunk.id) && !empty.has(chunk.id))) && !this.pending.has(chunk.id))
      .filter(chunk => {
        const failure = chunks.failed?.[chunk.id];
        if (!failure) return true;
        const failedAt = Number(failure.at);
        return !Number.isFinite(failedAt) || this.now() - failedAt >= retryCooldownMs;
      })
      .slice(0, ROAD_CONFIG.movementChunkBatchLimit);
    for (const chunk of candidates) this.enqueue(chunk, graph.center, {
      mode: 'movement',
      observe: chunk.id === observedChunkId,
      reason: chunk.reason
    });
    return candidates.map(chunk => chunk.id);
  }

  considerSurveyFacilities({ forceDefenseId = null } = {}) {
    const realNow = this.now();
    if (!forceDefenseId && realNow - this.lastSurveyCheckAt < 30000) return [];
    this.lastSurveyCheckAt = realNow;
    const hasSurveyFacility = activeSurveyFacilities(currentStoreState(this.store))
      .some(defense => !forceDefenseId || defense.id === forceDefenseId);
    if (!hasSurveyFacility) return [];
    let plan = null;
    this.store.advance(state => {
      const worldTimeMs = Number(state.runtime?.worldTimeMs) || realNow;
      const facilities = activeSurveyFacilities(state)
        .filter(defense => !forceDefenseId || defense.id === forceDefenseId);
      for (const defense of facilities) {
        synchronizeSurveyFacility(defense, worldTimeMs);
        if (forceDefenseId) {
          defense.surveyNextAt = 0;
          defense.surveyRetryAt = 0;
        }
        if (defense.disabledTimer > 0 || (!forceDefenseId && worldTimeMs < Math.max(defense.surveyNextAt, defense.surveyRetryAt))) continue;
        const candidateOptions = {
          pendingIds: this.pending,
          now: realNow,
          retryCooldownMs: forceDefenseId ? 0 : ROAD_CONFIG.surveyRetryCooldownMs
        };
        const candidates = surveyChunkCandidates(state, defense, candidateOptions);
        const allCandidates = surveyChunkCandidates(state, defense, {
          pendingIds: new Set(),
          now: realNow,
          retryCooldownMs: 0
        });
        const definition = defenseRuntimeDefinition(defense);
        const intervalSeconds = Math.max(30, Number(definition?.scanInterval) || 180);
        defense.surveyNextAt = worldTimeMs + intervalSeconds * 1000;
        if (!candidates.length) {
          const pendingCandidate = allCandidates.some(candidate => this.pending.has(candidate.id));
          const failedCandidate = allCandidates.some(candidate => state.world.roadChunks.failed?.[candidate.id]);
          defense.surveyStatus = pendingCandidate ? 'QUEUED' : failedCandidate ? 'RETRY_WAIT' : 'COMPLETE';
          if (failedCandidate) defense.surveyRetryAt = Math.max(defense.surveyRetryAt, worldTimeMs + ROAD_CONFIG.surveyRetryCooldownMs);
          continue;
        }
        const chunk = candidates[0];
        defense.surveyStatus = 'QUEUED';
        defense.surveyLastChunkId = chunk.id;
        plan = { chunk, worldCenter: state.world.roadGraph.center, defenseId: defense.id };
        break;
      }
    }, forceDefenseId ? 'survey:manual-schedule' : 'survey:schedule');
    if (!plan) return [];
    this.enqueue(plan.chunk, plan.worldCenter, { mode: 'survey', defenseId: plan.defenseId });
    return [plan.chunk.id];
  }

  requestSurvey(defenseId) {
    const state = currentStoreState(this.store);
    const defense = activeSurveyFacilities(state).find(item => item.id === defenseId);
    if (!defense) return { ok: false, reasonKey: 'reason.survey.unavailable', reason: 'この測量施設は現在稼働できません。' };
    if (defense.disabledTimer > 0) return { ok: false, reasonKey: 'reason.survey.disabledTimer', reasonParams: { seconds: Math.ceil(defense.disabledTimer) }, reason: `機能停止中です。あと${Math.ceil(defense.disabledTimer)}秒待ってください。` };
    const queued = this.considerSurveyFacilities({ forceDefenseId: defenseId });
    const latest = currentStoreState(this.store).combat.defenses.find(item => item.id === defenseId);
    if (queued.length > 0) return { ok: true, messageKey: 'combat.panel.surveyStarted', message: '道路測量を開始しました。', chunkId: queued[0] };
    if (latest?.surveyStatus === 'LOADING' || latest?.surveyStatus === 'QUEUED') {
      return { ok: true, messageKey: 'reason.survey.alreadyRunning', message: '道路測量はすでに進行中です。' };
    }
    if (latest?.surveyStatus === 'COMPLETE') {
      return { ok: false, reasonKey: 'reason.survey.noUnloadedChunk', reason: '現在の測量半径内に未取得の道路区域はありません。' };
    }
    return latest?.surveyLastError
    ? { ok: false, reasonKey: 'reason.survey.fetchFailed', reasonParams: { error: latest.surveyLastError }, reason: `道路取得に失敗しました：${latest.surveyLastError}` }
    : { ok: false, reasonKey: 'reason.survey.noAdjacentChunk', reason: '測量可能な隣接区域がありません。' };
  }

  waitForChunk(chunkId) {
    return new Promise(resolve => {
      if (!this.chunkWaiters.has(chunkId)) this.chunkWaiters.set(chunkId, []);
      this.chunkWaiters.get(chunkId).push(resolve);
    });
  }

  settleChunkWaiters(chunkId, result) {
    const waiters = this.chunkWaiters.get(chunkId) ?? [];
    this.chunkWaiters.delete(chunkId);
    for (const resolve of waiters) resolve(result);
  }

  enqueue(chunk, worldCenter, options = {}) {
    const completion = this.waitForChunk(chunk.id);
    if (this.pending.has(chunk.id)) return completion;
    this.pending.add(chunk.id);
    this.queue.push({ chunk, worldCenter, options, generation: this.generation });
    this.processQueue();
    return completion;
  }

  async ensureAreaAroundPoint(point, {
    radiusMeters = ROAD_CONFIG.initialBaseCoverageRadiusMeters,
    observe = true,
    reason = 'base-selection'
  } = {}) {
    const state = currentStoreState(this.store);
    const graph = state.world.roadGraph;
    const chunks = roadChunkState(state.world);
    if (!graph || !chunks || !point) return { ok: false, requested: [], failed: [] };
    const requested = chunksIntersectingCircle(point, radiusMeters, chunks.sizeMeters)
      .sort((left, right) => {
        const leftCenter = { x: (left.x + 0.5) * chunks.sizeMeters, y: (left.y + 0.5) * chunks.sizeMeters };
        const rightCenter = { x: (right.x + 0.5) * chunks.sizeMeters, y: (right.y + 0.5) * chunks.sizeMeters };
        return distance(point, leftCenter) - distance(point, rightCenter) || left.id.localeCompare(right.id);
      });
    const results = await Promise.all(requested.map(chunk => this.enqueue(chunk, graph.center, {
      mode: 'movement',
      observe,
      reason
    })));
    const latest = roadChunkState(currentStoreState(this.store).world);
    const loaded = roadChunkSet(latest, 'loaded');
    const empty = roadChunkSet(latest, 'empty');
    const failed = requested
      .filter(chunk => !loaded.has(chunk.id) && !empty.has(chunk.id))
      .map(chunk => chunk.id);
    return {
      ok: failed.length === 0,
      requested: requested.map(chunk => chunk.id),
      failed,
      results
    };
  }

  async processQueue() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next.generation !== this.generation) {
          this.pending.delete(next.chunk.id);
          this.settleChunkWaiters(next.chunk.id, { ok: false, chunkId: next.chunk.id, aborted: true });
          continue;
        }
        let result = { ok: false, chunkId: next.chunk.id };
        try {
          await this.loadChunk(next.chunk, next.worldCenter, { ...next.options, generation: next.generation });
          const latest = roadChunkState(currentStoreState(this.store).world);
          result = {
            ok: roadChunkHas(latest, 'loaded', next.chunk.id) || roadChunkHas(latest, 'empty', next.chunk.id),
            chunkId: next.chunk.id
          };
        } catch (error) {
          result = { ok: false, chunkId: next.chunk.id, error: String(error?.message ?? error) };
          this.onStatus?.(statusMessage('error', next.chunk.id, 'road.chunkMergeFailed'));
        } finally {
          this.pending.delete(next.chunk.id);
          this.settleChunkWaiters(next.chunk.id, result);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async loadChunk(chunk, worldCenter, { mode = 'movement', defenseId = null, observe = mode === 'movement', generation = this.generation } = {}) {
    const stale = () => generation !== this.generation;
    if (stale()) return;
    const state = currentStoreState(this.store);
    const currentChunks = roadChunkState(state.world);
    const refreshRequired = roadChunkHas(currentChunks, 'refresh', chunk.id);
    if (!refreshRequired && (roadChunkHas(currentChunks, 'loaded', chunk.id) || roadChunkHas(currentChunks, 'empty', chunk.id))) {
      const observationKey = mode === 'survey' ? 'surveyed' : observe ? 'playerObserved' : null;
      const observationMissing = observationKey ? !roadChunkHas(currentChunks, observationKey, chunk.id) : false;
      const defense = defenseId ? state.combat.defenses.find(item => item.id === defenseId) : null;
      const defenseNeedsReset = Boolean(defense && (defense.surveyStatus !== 'WAITING' || defense.surveyErrorCount || defense.surveyRetryAt || defense.surveyLastError));
      if (observationMissing || defenseNeedsReset) {
        this.store.advance(draft => {
          const chunkState = roadChunkState(draft.world);
          if (observationKey) roadChunkAdd(chunkState, observationKey, chunk.id);
          if (defenseId) {
            const currentDefense = draft.combat.defenses.find(item => item.id === defenseId);
            if (currentDefense) {
              currentDefense.surveyStatus = 'WAITING';
              currentDefense.surveyErrorCount = 0;
              currentDefense.surveyRetryAt = 0;
              currentDefense.surveyLastError = null;
            }
          }
        }, 'roads:chunk-already-loaded');
      }
      return;
    }
    const worldId = roadWorldId(state.world.roadGraph);
    this.onStatus?.(statusMessage('loading', chunk.id, mode === 'survey' ? 'road.chunkLoadingSurvey' : 'road.chunkLoadingMovement'));
    if (defenseId) {
      this.store.advance(draft => {
        const defense = draft.combat.defenses.find(item => item.id === defenseId);
        if (defense) defense.surveyStatus = 'LOADING';
      }, 'survey:loading');
    }

    let graph = refreshRequired ? null : await this.cache?.get?.(worldId, chunk.id).catch(() => null);
    if (refreshRequired) await this.cache?.remove?.(worldId, chunk.id).catch(() => false);
    if (stale()) return;
    if (graph && !usableCachedChunk(graph)) {
      await this.cache?.remove?.(worldId, chunk.id).catch(() => false);
      this.store.advance(draft => {
        const chunkState = roadChunkState(draft.world);
        roadChunkDelete(chunkState, 'cached', chunk.id);
      }, 'roads:stale-cache-removed');
      graph = null;
    }
    let source = 'cache';
    let networkSuccess = null;
    let acquisitionReport = null;
    if (graph) attachGraphIndexes(graph);
    if (!graph) {
      source = 'network';
      this.abortController = new AbortController();
      const connectionBeforeSequence = Number(this.roadService.overpassClient?.getLastSuccess?.()?.sequence) || 0;
      try {
        const chunkCenter = chunkCenterLocation(chunk, worldCenter, currentChunks.sizeMeters);
        graph = await this.roadService.loadChunk({
          worldCenter,
          chunkCenter,
          chunkId: chunk.id,
          radiusMeters: ROAD_CONFIG.chunkFetchRadiusMeters
        }, { signal: this.abortController.signal });
        networkSuccess = this.roadService.overpassClient?.getLastSuccess?.() ?? null;
        acquisitionReport = graph?.acquisitionReport ?? this.roadService.lastAcquisitionReport ?? null;
        if (stale()) return;
        if (graph.nodes.length > 0 && graph.edges.length > 0) {
          await this.cache?.put?.(worldId, chunk.id, compactChunkGraph(graph)).catch(() => false);
        }
        if (stale()) return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        const connectionAfter = this.roadService.overpassClient?.getLastSuccess?.() ?? null;
        const communicationSucceeded = Number(connectionAfter?.sequence) > connectionBeforeSequence;
        const unconfirmedEmpty = communicationSucceeded
          && Number(connectionAfter?.elementCount) === 0
          && connectionAfter?.confirmedEmpty !== true;
        const processingFailed = communicationSucceeded && !unconfirmedEmpty;
        const failureDetail = String(error?.details ?? error?.message ?? error).replace(/\s+/g, ' ').slice(0, 210);
        this.store.advance(draft => {
          const chunkState = roadChunkState(draft.world);
          chunkState.failed[chunk.id] = { at: this.now(), message: String(error?.message ?? error).slice(0, 160) };
          chunkState.updatedAt = this.now();
          if (defenseId) {
            const defense = draft.combat.defenses.find(item => item.id === defenseId);
            if (defense) {
              const worldTimeMs = Number(draft.runtime?.worldTimeMs) || this.now();
              defense.surveyErrorCount = Math.max(0, Number(defense.surveyErrorCount) || 0) + 1;
              defense.surveyLastErrorStage = processingFailed ? 'PROCESSING' : 'NETWORK';
              defense.surveyLastError = `${processingFailed ? '通信成功・道路処理失敗' : unconfirmedEmpty ? '空応答の確認未完了' : '通信失敗'}：${failureDetail}`.slice(0, 240);
              if (communicationSucceeded) {
                defense.surveyLastConnectionAt = worldTimeMs;
                defense.surveyLastEndpoint = connectionAfter.host ?? 'overpass';
                defense.surveyLastTransport = connectionAfter.transport ?? null;
                defense.surveyLastResponseElements = Math.max(0, Number(connectionAfter.elementCount) || 0);
              }
              defense.surveyRetryAt = worldTimeMs + ROAD_CONFIG.surveyRetryCooldownMs;
              defense.surveyNextAt = Math.max(Number(defense.surveyNextAt) || 0, defense.surveyRetryAt);
              defense.surveyStatus = 'RETRY_WAIT';
            }
          }
        }, 'roads:chunk-failed');
        const statusKey = mode === 'survey'
          ? processingFailed
            ? 'road.chunkSurveyProcessingFailed'
            : unconfirmedEmpty
              ? 'road.chunkSurveyEmptyUnconfirmed'
              : 'road.chunkSurveyConnectFailed'
          : unconfirmedEmpty
            ? 'road.chunkMovementEmptyUnconfirmed'
            : 'road.chunkMovementFetchFailed';
        this.onStatus?.(statusMessage('error', chunk.id, statusKey));
        return;
      } finally {
        this.abortController = null;
      }
    }

    if (stale()) return;
    let mergeResult = { addedNodes: 0, addedEdges: 0, mergedEdges: 0 };
    this.store.advance(draft => {
      const chunkState = roadChunkState(draft.world);
      delete chunkState.failed[chunk.id];
      roadChunkDelete(chunkState, 'refresh', chunk.id);
      if (graph.nodes.length === 0 || graph.edges.length === 0) {
        roadChunkAdd(chunkState, 'empty', chunk.id);
      } else {
        mergeResult = mergeRoadGraphs(draft.world.roadGraph, graph, { chunkId: chunk.id });
        roadChunkAdd(chunkState, 'loaded', chunk.id);
        roadChunkAdd(chunkState, 'cached', chunk.id);
        roadChunkAdd(chunkState, 'integrated', chunk.id);
      }
      const observationKey = mode === 'survey' ? 'surveyed' : observe ? 'playerObserved' : null;
      if (observationKey) roadChunkAdd(chunkState, observationKey, chunk.id);
      if (defenseId) {
        const defense = draft.combat.defenses.find(item => item.id === defenseId);
        if (defense) {
          defense.surveyStatus = 'WAITING';
          defense.surveyCompletedCount = Math.max(0, Number(defense.surveyCompletedCount) || 0) + 1;
          defense.surveyLastChunkId = chunk.id;
          defense.surveyErrorCount = 0;
          defense.surveyRetryAt = 0;
          defense.surveyLastError = null;
          defense.surveyLastErrorStage = null;
          defense.surveyLastSuccessAt = Number(draft.runtime?.worldTimeMs) || this.now();
          if (source === 'network') {
            defense.surveyLastConnectionAt = defense.surveyLastSuccessAt;
            defense.surveyLastEndpoint = networkSuccess?.host ?? 'overpass';
            defense.surveyLastTransport = networkSuccess?.transport ?? 'POST';
            defense.surveyLastResponseElements = Math.max(0, Number(networkSuccess?.elementCount) || 0);
          } else if (!defense.surveyLastEndpoint) {
            defense.surveyLastEndpoint = 'local-cache';
            defense.surveyLastTransport = 'CACHE';
          }
          defense.surveyLastRoadCount = Math.max(0, graph.edges.length);
        }
      }
      chunkState.lastAcquisition = {
        chunkId: chunk.id,
        source,
        at: this.now(),
        responseElements: Math.max(0, Number(acquisitionReport?.responseElements) || 0),
        acceptedWays: Math.max(0, Number(acquisitionReport?.acceptedWays) || 0),
        excludedWays: Math.max(0, Number(acquisitionReport?.excludedWays) || 0),
        retainedSegments: Math.max(0, Number(acquisitionReport?.retainedSegmentCount) || 0),
        graphEdges: Math.max(0, Number(graph.edges.length) || 0),
        addedEdges: Math.max(0, Number(mergeResult.addedEdges) || 0)
      };
      chunkState.updatedAt = this.now();
    }, 'roads:chunk-merged', { validate: true });

    this.graphChanged({ reason: source, chunkId: chunk.id, ...mergeResult });
    const loadedParams = {
      count: Math.max(0, Number(mergeResult.addedEdges) || 0),
      host: networkSuccess?.host ?? '',
      transport: networkSuccess?.transport ?? ''
    };
    const loadedKey = graph.edges.length > 0
      ? mode === 'survey' && networkSuccess?.host
        ? 'road.chunkLoadedSurveyWithHost'
        : mode === 'survey'
          ? 'road.chunkLoadedSurvey'
          : 'road.chunkLoadedMovement'
      : mode === 'survey'
        ? 'road.chunkLoadedSurveyEmpty'
        : 'road.chunkLoadedMovementEmpty';
    this.onStatus?.(statusMessage('loaded', chunk.id, loadedKey, loadedParams));
  }

  graphChanged(detail) {
    const graph = currentStoreState(this.store).world.roadGraph;
    this.renderer?.setGraph(graph);
    this.renderer?.invalidateStatic?.();
    this.renderer?.render?.();
    this.onGraphChanged?.(detail);
  }

  abort() {
    this.generation += 1;
    this.queue.length = 0;
    for (const chunkId of this.pending) this.settleChunkWaiters(chunkId, { ok: false, chunkId, aborted: true });
    this.pending.clear();
    this.abortController?.abort();
    this.abortController = null;
    this.lastSurveyCheckAt = 0;
    this.lastMovementPoint = null;
  }

  async clearCurrentWorld() {
    const graph = currentStoreState(this.store).world.roadGraph;
    if (!graph) return false;
    return this.cache?.removeWorld?.(roadWorldId(graph)).catch(() => false) ?? false;
  }

  async clearAllWorlds() {
    return this.cache?.removeAll?.().catch(() => false) ?? false;
  }

  destroy() {
    this.abort();
    this.cache?.close?.();
  }
}
