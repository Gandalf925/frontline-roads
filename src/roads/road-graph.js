import { distance, stableId } from '../core/utilities.js';
import { clusterSegmentEndpoints } from './intersection-clustering.js';
import { segmentAngle, segmentMidpoint } from './geometry.js';
import { normalizeRoadElevation, roadElevationKey } from './road-elevation.js';

const GRAPH_SPATIAL_CELL_METERS = 400;
const MIN_EDGE_METERS = 1.5;
const MAX_EDGE_METERS = 320;

const reachabilityCache = new WeakMap();

function cellKey(x, y) {
  return `${x},${y}`;
}

function cellRange(bounds, cellSize) {
  return {
    minX: Math.floor(bounds.minX / cellSize),
    maxX: Math.floor(bounds.maxX / cellSize),
    minY: Math.floor(bounds.minY / cellSize),
    maxY: Math.floor(bounds.maxY / cellSize)
  };
}

function addToBuckets(buckets, value, range) {
  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      const key = cellKey(x, y);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(value);
    }
  }
}

function createSpatialIndex(graph, nodeById, cellSize = GRAPH_SPATIAL_CELL_METERS) {
  const nodeBuckets = new Map();
  const edgeBuckets = new Map();
  for (const node of graph.nodes) {
    const x = Math.floor(node.x / cellSize);
    const y = Math.floor(node.y / cellSize);
    const key = cellKey(x, y);
    if (!nodeBuckets.has(key)) nodeBuckets.set(key, []);
    nodeBuckets.get(key).push(node);
  }
  for (const edge of graph.edges) {
    if (edge.routingDisabled) continue;
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    if (!a || !b) continue;
    addToBuckets(edgeBuckets, edge, cellRange({
      minX: Math.min(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x),
      maxY: Math.max(a.y, b.y)
    }, cellSize));
  }
  return { cellSize, nodeBuckets, edgeBuckets };
}

function valuesInBounds(buckets, range) {
  const values = new Set();
  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      for (const value of buckets.get(cellKey(x, y)) ?? []) values.add(value);
    }
  }
  return [...values];
}


function topologyFingerprint(graph) {
  return [
    Math.max(1, Math.floor(Number(graph?.topologyRevision) || 1)),
    graph?.nodes?.length ?? 0,
    graph?.edges?.length ?? 0
  ].join(':');
}

export function reachableRoadNodeIds(graph, startNodeIds = []) {
  if (!graph?.nodeById || !graph?.adjacency) return new Set();
  const starts = [...new Set(startNodeIds.filter(nodeId => graph.nodeById.has(nodeId)))].sort();
  const startKey = starts.join('|');
  const fingerprint = topologyFingerprint(graph);
  const cached = reachabilityCache.get(graph);
  if (cached
    && cached.adjacency === graph.adjacency
    && cached.fingerprint === fingerprint
    && cached.startKey === startKey) {
    cached.hits += 1;
    return cached.reachable;
  }

  const reachable = new Set();
  const queue = [];
  for (const nodeId of starts) {
    reachable.add(nodeId);
    queue.push(nodeId);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    for (const connection of graph.adjacency.get(nodeId) ?? []) {
      if (reachable.has(connection.to) || !graph.nodeById.has(connection.to)) continue;
      reachable.add(connection.to);
      queue.push(connection.to);
    }
  }
  reachabilityCache.set(graph, {
    adjacency: graph.adjacency,
    fingerprint,
    startKey,
    reachable,
    computations: (cached?.computations ?? 0) + 1,
    hits: cached?.hits ?? 0
  });
  return reachable;
}

export function graphElementsInBounds(graph, bounds) {
  const index = graph?.spatialIndex;
  if (!index) return { nodes: graph?.nodes ?? [], edges: graph?.edges ?? [] };
  const range = cellRange(bounds, index.cellSize);
  return {
    nodes: valuesInBounds(index.nodeBuckets, range),
    edges: valuesInBounds(index.edgeBuckets, range)
  };
}

export function graphElementsNearPoint(graph, point, radius) {
  return graphElementsInBounds(graph, {
    minX: point.x - radius,
    minY: point.y - radius,
    maxX: point.x + radius,
    maxY: point.y + radius
  });
}

export function roadGraphBounds(graph) {
  if (graph?.bounds) return graph.bounds;
  const nodes = graph?.nodes ?? [];
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  return { minX, minY, maxX, maxY };
}

export function buildRoadGraphFromSegments(segments, center) {
  const clustered = clusterSegmentEndpoints(segments, center);
  const edges = [];
  const edgeKeys = new Set();

  for (const segment of segments) {
    const a = clustered.nodeByRoot.get(clustered.find(segment.pointA));
    const b = clustered.nodeByRoot.get(clustered.find(segment.pointB));
    if (!a || !b || a.id === b.id) continue;
    const length = distance(a, b);
    if (length < MIN_EDGE_METERS || length > MAX_EDGE_METERS) continue;
    const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const wayId = String(segment.wayId ?? segment.id);
    const edgeKey = `${pair}|${wayId}`;
    if (edgeKeys.has(edgeKey)) continue;
    edgeKeys.add(edgeKey);

    const edge = {
      id: stableId('edge', pair, wayId, segment.id),
      a: a.id,
      b: b.id,
      length,
      points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
      barrier: null,
      roadWidth: segment.roadWidth,
      lanes: segment.lanes,
      highway: segment.highway,
      name: segment.name,
      oneway: segment.oneway,
      layer: segment.layer,
      bridge: segment.bridge,
      tunnel: segment.tunnel,
      elevationKey: roadElevationKey(segment),
      elevationKnown: true,
      sourceWayIds: [wayId],
      mergedSegmentIds: [...(segment.mergedSegmentIds ?? [segment.id])]
    };
    edge.angle = segmentAngle({ a, b });
    edge.mid = segmentMidpoint({ a, b });
    edges.push(edge);
  }

  return attachGraphIndexes({ nodes: clustered.nodes, edges, center, source: 'osm', roadSpecVersion: 4, topologyRevision: 1 });
}

export function attachGraphIndexes(graph) {
  graph.topologyRevision = Math.max(1, Math.floor(Number(graph.topologyRevision) || 1));
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const edgeById = new Map();
  const adjacency = new Map(graph.nodes.map(node => [node.id, []]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of graph.nodes) {
    node.sourceNodeIds = [...new Set((node.sourceNodeIds ?? []).map(String))];
    node.elevationKeys = [...new Set((node.elevationKeys ?? []).map(String))];
    node.elevationKnown = node.elevationKnown !== false;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const descendantEdgeIdsByAncestor = new Map();
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    if (a && b) {
      edge.points ??= [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
      edge.angle ??= segmentAngle({ a, b });
      edge.mid ??= segmentMidpoint({ a, b });
    }
    edge.mergedSegmentIds ??= [edge.id];
    edge.sourceWayIds = [...new Set((edge.sourceWayIds ?? []).map(String))];
    edge.ancestorEdgeIds = [...new Set((edge.ancestorEdgeIds ?? []).map(String))];
    normalizeRoadElevation(edge);
    edgeById.set(edge.id, edge);
    if (edge.routingDisabled) continue;
    adjacency.get(edge.a)?.push({ to: edge.b, edgeId: edge.id, length: edge.length });
    adjacency.get(edge.b)?.push({ to: edge.a, edgeId: edge.id, length: edge.length });
    for (const ancestorId of edge.ancestorEdgeIds) {
      if (!descendantEdgeIdsByAncestor.has(ancestorId)) descendantEdgeIdsByAncestor.set(ancestorId, new Set());
      descendantEdgeIdsByAncestor.get(ancestorId).add(edge.id);
    }
  }
  const spatialIndex = createSpatialIndex(graph, nodeById);
  const terminalNodes = graph.nodes.filter(node => (adjacency.get(node.id)?.length ?? 0) === 1);
  const bounds = graph.nodes.length > 0 ? { minX, minY, maxX, maxY } : null;
  Object.defineProperties(graph, {
    nodeById: { value: nodeById, enumerable: false, writable: true, configurable: true },
    edgeById: { value: edgeById, enumerable: false, writable: true, configurable: true },
    adjacency: { value: adjacency, enumerable: false, writable: true, configurable: true },
    spatialIndex: { value: spatialIndex, enumerable: false, writable: true, configurable: true },
    terminalNodes: { value: terminalNodes, enumerable: false, writable: true, configurable: true },
    bounds: { value: bounds, enumerable: false, writable: true, configurable: true },
    descendantEdgeIdsByAncestor: { value: descendantEdgeIdsByAncestor, enumerable: false, writable: true, configurable: true }
  });
  return graph;
}
