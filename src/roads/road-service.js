import { createRoadAcquisitionDiagnostics, parseOverpassSegments } from './road-parser.js';
import { buildRoadGraphFromSegments, attachGraphIndexes } from './road-graph.js';
import { finalizeRoadGraph } from './graph-cleanup.js';
import { ROAD_CONFIG } from '../core/constants.js';
import { chunkBounds, parseChunkId } from './world-chunk-grid.js';
import { repairRoadGraphTopology } from './road-topology-repair.js';

function acquisitionReport({ mode, diagnostics, graph, queryRadiusMeters, retention, timings = null }) {
  return Object.freeze({
    mode,
    queryRadiusMeters,
    retention,
    responseElements: diagnostics.responseElements,
    candidateWays: diagnostics.candidateWays,
    acceptedWays: diagnostics.acceptedWays,
    excludedWays: diagnostics.excludedWays,
    excludedByReason: { ...diagnostics.excludedByReason },
    highwayWayCounts: { ...diagnostics.highwayWayCounts },
    rawSegmentCount: diagnostics.rawSegmentCount,
    retainedSegmentCount: diagnostics.retainedSegmentCount,
    clippedSegmentCount: diagnostics.clippedSegmentCount,
    tooShortSegmentCount: diagnostics.tooShortSegmentCount,
    graphNodeCount: graph.nodes.length,
    graphEdgeCount: graph.edges.length,
    timings: timings ? Object.freeze({ ...timings }) : null
  });
}

function attachReport(graph, report) {
  Object.defineProperty(graph, 'acquisitionReport', {
    value: report,
    enumerable: false,
    writable: true,
    configurable: true
  });
  return graph;
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = callback => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(abortError()));
    const timer = setTimeout(() => finish(resolve), Math.max(0, Number(milliseconds) || 0));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function duration(clock, startedAt) {
  return Math.max(0, clock() - startedAt);
}

export class RoadService {
  constructor(overpassClient, { clock = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
    this.overpassClient = overpassClient;
    this.clock = clock;
    this.lastGraph = null;
    this.lastAcquisitionReport = null;
  }

  async loadAround(location, options = {}) {
    const center = { lat: location.lat, lon: location.lon };
    const radiusMeters = options.radiusMeters ?? ROAD_CONFIG.fetchRadiusMeters;
    const retentionRadiusMeters = options.retentionRadiusMeters ?? ROAD_CONFIG.initialRetentionRadiusMeters;
    const minimumRawSegments = options.minimumRawSegments ?? ROAD_CONFIG.minimumRawSegments;
    const minimumNodes = options.minimumNodes ?? ROAD_CONFIG.minimumNodes;
    const minimumEdges = options.minimumEdges ?? ROAD_CONFIG.minimumEdges;
    const mode = options.mode ?? 'initial';
    const recordAsLast = options.recordAsLast !== false;
    const totalStartedAt = this.clock();

    options.onPhase?.({ phase: 'network', mode, radiusMeters });
    const fetchStartedAt = this.clock();
    const rawData = await this.overpassClient.fetchRoads(center.lat, center.lon, {
      signal: options.signal,
      radiusMeters,
      queryShape: options.queryShape ?? 'around',
      endpointOffset: options.endpointOffset ?? 0,
      onAttempt: options.onAttempt
    });
    const fetchMs = duration(this.clock, fetchStartedAt);
    if (options.signal?.aborted) throw abortError();

    options.onPhase?.({ phase: 'parse', mode, responseElements: rawData.elements.length });
    const parseStartedAt = this.clock();
    const diagnostics = createRoadAcquisitionDiagnostics(rawData);
    const rawSegments = parseOverpassSegments(rawData, center, {
      maxDistanceMeters: retentionRadiusMeters,
      minimumRawSegments,
      diagnostics
    });
    const parseMs = duration(this.clock, parseStartedAt);
    if (options.signal?.aborted) throw abortError();

    options.onPhase?.({ phase: 'graph', mode, segmentCount: rawSegments.length });
    const graphStartedAt = this.clock();
    const graph = finalizeRoadGraph(buildRoadGraphFromSegments(rawSegments, center), {
      minimumNodes,
      minimumEdges
    });
    repairRoadGraphTopology(graph);
    const graphMs = duration(this.clock, graphStartedAt);
    const report = acquisitionReport({
      mode,
      diagnostics,
      graph,
      queryRadiusMeters: radiusMeters,
      retention: { type: 'radius', meters: retentionRadiusMeters },
      timings: {
        fetchMs,
        parseMs,
        graphMs,
        totalMs: duration(this.clock, totalStartedAt)
      }
    });
    const reportedGraph = attachReport(graph, report);
    if (recordAsLast) {
      this.lastAcquisitionReport = report;
      this.lastGraph = reportedGraph;
    }
    options.onPhase?.({ phase: 'ready', mode, report });
    return reportedGraph;
  }

  async loadInitialProgressive(location, {
    signal,
    onAttempt = null,
    onPhase = null,
    onPreview = null,
    previewDelayMs = ROAD_CONFIG.initialPreviewDelayMs
  } = {}) {
    const previewController = new AbortController();
    const abortPreview = () => previewController.abort();
    signal?.addEventListener('abort', abortPreview, { once: true });
    let fullSucceeded = false;
    let previewGraph = null;
    let previewDisplayed = false;
    let previewError = null;

    const fullPromise = this.loadAround(location, {
      signal,
      mode: 'initial',
      onAttempt: attempt => onAttempt?.({ ...attempt, acquisition: 'full' }),
      onPhase: phase => onPhase?.({ ...phase, acquisition: 'full' })
    }).then(graph => {
      fullSucceeded = true;
      return graph;
    });

    const previewPromise = (async () => {
      try {
        await wait(previewDelayMs, previewController.signal);
        const graph = await this.loadAround(location, {
          signal: previewController.signal,
          radiusMeters: ROAD_CONFIG.initialPreviewFetchRadiusMeters,
          retentionRadiusMeters: ROAD_CONFIG.initialPreviewRetentionRadiusMeters,
          minimumRawSegments: ROAD_CONFIG.initialPreviewMinimumRawSegments,
          mode: 'initial-preview',
          endpointOffset: 1,
          recordAsLast: false,
          onAttempt: attempt => onAttempt?.({ ...attempt, acquisition: 'preview' }),
          onPhase: phase => onPhase?.({ ...phase, acquisition: 'preview' })
        });
        previewGraph = graph;
        if (!fullSucceeded && typeof onPreview === 'function') {
          previewDisplayed = true;
          onPreview(graph);
        }
        return graph;
      } catch (error) {
        if (error?.name !== 'AbortError') previewError = error;
        return null;
      }
    })();

    try {
      try {
        const graph = await fullPromise;
        previewController.abort();
        await previewPromise;
        return { graph, source: 'full', previewShown: previewDisplayed, fullError: null, previewError };
      } catch (fullError) {
        const fallback = await previewPromise;
        if (fallback) {
          this.lastGraph = fallback;
          this.lastAcquisitionReport = fallback.acquisitionReport ?? null;
          return { graph: fallback, source: 'preview-fallback', previewShown: previewDisplayed, fullError, previewError: null };
        }
        throw fullError;
      }
    } finally {
      signal?.removeEventListener('abort', abortPreview);
      previewController.abort();
    }
  }

  async loadChunk({
    worldCenter,
    chunkCenter,
    chunkId,
    radiusMeters = ROAD_CONFIG.chunkFetchRadiusMeters,
    chunkSizeMeters = ROAD_CONFIG.chunkSizeMeters
  }, options = {}) {
    if (!worldCenter || !chunkCenter || !chunkId) throw new TypeError('worldCenter, chunkCenter and chunkId are required');
    const rawData = await this.overpassClient.fetchRoads(chunkCenter.lat, chunkCenter.lon, {
      signal: options.signal,
      radiusMeters,
      queryShape: 'bbox',
      onAttempt: options.onAttempt
    });
    const diagnostics = createRoadAcquisitionDiagnostics(rawData);
    const chunk = parseChunkId(chunkId);
    const baseBounds = chunkBounds(chunk, chunkSizeMeters);
    const padding = ROAD_CONFIG.chunkRetentionPaddingMeters;
    const clipBounds = {
      minX: baseBounds.minX - padding,
      minY: baseBounds.minY - padding,
      maxX: baseBounds.maxX + padding,
      maxY: baseBounds.maxY + padding
    };
    const rawSegments = parseOverpassSegments(rawData, worldCenter, {
      clipCenter: null,
      clipBounds,
      maxDistanceMeters: Infinity,
      minimumRawSegments: 0,
      diagnostics
    });
    if (rawSegments.length === 0) {
      const graph = attachGraphIndexes({
        nodes: [], edges: [], center: worldCenter, source: 'osm-chunk', roadSpecVersion: 4, chunkId
      });
      const report = acquisitionReport({
        mode: 'chunk', diagnostics, graph, queryRadiusMeters: radiusMeters,
        retention: { type: 'bounds', ...clipBounds }
      });
      this.lastAcquisitionReport = report;
      return attachReport(graph, report);
    }
    const graph = finalizeRoadGraph(buildRoadGraphFromSegments(rawSegments, worldCenter), {
      minimumNodes: 0,
      minimumEdges: 0
    });
    repairRoadGraphTopology(graph);
    graph.source = 'osm-chunk';
    graph.roadSpecVersion = 4;
    graph.chunkId = chunkId;
    for (const node of graph.nodes) node.chunkIds = [chunkId];
    for (const edge of graph.edges) edge.chunkIds = [chunkId];
    const report = acquisitionReport({
      mode: 'chunk', diagnostics, graph, queryRadiusMeters: radiusMeters,
      retention: { type: 'bounds', ...clipBounds }
    });
    this.lastAcquisitionReport = report;
    return attachReport(graph, report);
  }
}
