import { distance, stableId } from '../core/utilities.js';
import { attachGraphIndexes, graphElementsInBounds } from './road-graph.js';
import { segmentAngle, segmentMidpoint } from './geometry.js';
import { normalizeRoadElevation, roadElevationKnown, sameRoadElevation } from './road-elevation.js';
import { repairRoadGraphTopology } from './road-topology-repair.js';

const COORDINATE_FALLBACK_METERS = 1.5;

function bucketKey(point, size) {
  return `${Math.floor(point.x / size)},${Math.floor(point.y / size)}`;
}

function candidateBuckets(point, size) {
  const x = Math.floor(point.x / size);
  const y = Math.floor(point.y / size);
  const result = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) result.push(`${x + dx},${y + dy}`);
  }
  return result;
}

function createNodeIndexes(nodes, size) {
  const buckets = new Map();
  const bySourceNodeId = new Map();
  for (const node of nodes) {
    const key = bucketKey(node, size);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(node);
    for (const sourceId of node.sourceNodeIds ?? []) {
      const values = bySourceNodeId.get(String(sourceId)) ?? [];
      values.push(node);
      bySourceNodeId.set(String(sourceId), values);
    }
  }
  return { buckets, bySourceNodeId };
}

function nodesShareElevation(first, second) {
  if (first.elevationKnown === false || second.elevationKnown === false) return false;
  const firstKeys = new Set(first.elevationKeys ?? []);
  const secondKeys = second.elevationKeys ?? [];
  if (!firstKeys.size || !secondKeys.length) return true;
  return secondKeys.some(key => firstKeys.has(key));
}

function nearestCoordinateNode(node, buckets, threshold) {
  let best = null;
  let bestDistance = threshold;
  for (const key of candidateBuckets(node, threshold)) {
    for (const candidate of buckets.get(key) ?? []) {
      if (!nodesShareElevation(node, candidate)) continue;
      const gap = distance(node, candidate);
      if (gap <= bestDistance) {
        best = candidate;
        bestDistance = gap;
      }
    }
  }
  return best;
}

function compatibleExistingNode(node, indexes) {
  const sourceIds = (node.sourceNodeIds ?? []).map(String);
  let exact = null;
  let exactDistance = Infinity;
  for (const sourceId of sourceIds) {
    for (const candidate of indexes.bySourceNodeId.get(sourceId) ?? []) {
      const gap = distance(node, candidate);
      if (gap < exactDistance) {
        exact = candidate;
        exactDistance = gap;
      }
    }
  }
  // OSM node identity is authoritative. A bridge/tunnel tag may change at the
  // shared portal node, so elevation metadata must not split the exact node.
  if (exact) return exact;

  const coordinate = nearestCoordinateNode(node, indexes.buckets, COORDINATE_FALLBACK_METERS);
  if (!coordinate) return null;
  const candidateSourceIds = coordinate.sourceNodeIds ?? [];
  // Different explicit OSM nodes may be parallel carriageways or grade-separated
  // geometry. Coordinate fallback is reserved for synthetic/clipped endpoints.
  if (sourceIds.length > 0 && candidateSourceIds.length > 0) return null;
  return coordinate;
}

function addNodeToIndexes(node, indexes, size) {
  const key = bucketKey(node, size);
  if (!indexes.buckets.has(key)) indexes.buckets.set(key, []);
  indexes.buckets.get(key).push(node);
  for (const sourceId of node.sourceNodeIds ?? []) {
    const values = indexes.bySourceNodeId.get(String(sourceId)) ?? [];
    if (!values.includes(node)) values.push(node);
    indexes.bySourceNodeId.set(String(sourceId), values);
  }
}

function mergeNodeMetadata(target, source, chunkId) {
  target.chunkIds = [...new Set([...(target.chunkIds ?? []), ...(source.chunkIds ?? []), ...(chunkId ? [chunkId] : [])])];
  target.sourceNodeIds = [...new Set([...(target.sourceNodeIds ?? []), ...(source.sourceNodeIds ?? [])].map(String))];
  target.elevationKeys = [...new Set([...(target.elevationKeys ?? []), ...(source.elevationKeys ?? [])].map(String))];
  target.elevationKnown = target.elevationKnown !== false && source.elevationKnown !== false;
  target.topologySynthetic = Boolean(target.topologySynthetic && source.topologySynthetic);
}

function uniqueNodeId(node, used) {
  let id = node.id || stableId('node', Math.round(node.x * 10), Math.round(node.y * 10));
  let sequence = 1;
  while (used.has(id)) id = `${stableId('node', Math.round(node.x * 100), Math.round(node.y * 100))}_${sequence++}`;
  used.add(id);
  return id;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function mergeEdgeMetadata(target, source) {
  target.roadWidth = Math.max(Number(target.roadWidth) || 0, Number(source.roadWidth) || 0);
  target.lanes = Math.max(Number(target.lanes) || 1, Number(source.lanes) || 1);
  if (!target.name && source.name) target.name = source.name;
  if (!target.highway && source.highway) target.highway = source.highway;
  target.oneway = Boolean(target.oneway && source.oneway);
  target.chunkIds = [...new Set([...(target.chunkIds ?? []), ...(source.chunkIds ?? [])])];
  target.sourceWayIds = [...new Set([...(target.sourceWayIds ?? []), ...(source.sourceWayIds ?? [])].map(String))];
  target.mergedSegmentIds = [...new Set([...(target.mergedSegmentIds ?? []), ...(source.mergedSegmentIds ?? [source.id])])];
  target.ancestorEdgeIds = [...new Set([...(target.ancestorEdgeIds ?? []), ...(source.ancestorEdgeIds ?? [])].map(String))];
  target.elevationKnown = roadElevationKnown(target) && roadElevationKnown(source);
  normalizeRoadElevation(target);
}

function matchingEdge(candidates, sourceEdge) {
  const active = candidates.filter(candidate => !candidate.routingDisabled && sameRoadElevation(candidate, sourceEdge));
  const sourceWays = new Set((sourceEdge.sourceWayIds ?? []).map(String));
  if (sourceWays.size > 0) {
    const exact = active.find(candidate => (candidate.sourceWayIds ?? []).some(id => sourceWays.has(String(id))));
    if (exact) return exact;
  }
  return active.find(candidate =>
    (candidate.sourceWayIds?.length ?? 0) === 0
    && String(candidate.name ?? '') === String(sourceEdge.name ?? '')
    && String(candidate.highway ?? '') === String(sourceEdge.highway ?? '')
  ) ?? null;
}

export function mergeRoadGraphs(baseGraph, incomingGraph, { chunkId = null, rebuildIndexes = true } = {}) {
  if (!baseGraph?.nodes || !baseGraph?.edges) throw new TypeError('baseGraph is required');
  attachGraphIndexes(baseGraph);
  if (!incomingGraph?.nodes || !incomingGraph?.edges) {
    if (rebuildIndexes) attachGraphIndexes(baseGraph);
    return { graph: baseGraph, addedNodes: 0, addedEdges: 0, mergedEdges: 0, repairedConnections: 0, splitEdges: 0 };
  }

  attachGraphIndexes(incomingGraph);
  const incomingTerminalIds = new Set((incomingGraph.terminalNodes ?? []).map(node => node.id));
  const baseTerminalIds = new Set((baseGraph.terminalNodes ?? []).map(node => node.id));
  const usedNodeIds = new Set(baseGraph.nodes.map(node => node.id));
  const indexes = createNodeIndexes(baseGraph.nodes, COORDINATE_FALLBACK_METERS);
  const nodeMap = new Map();
  const affectedNodeIds = new Set();
  let addedNodes = 0;

  for (const sourceNode of incomingGraph.nodes) {
    const existing = compatibleExistingNode(sourceNode, indexes);
    if (existing) {
      nodeMap.set(sourceNode.id, existing.id);
      mergeNodeMetadata(existing, sourceNode, chunkId);
      addNodeToIndexes(existing, indexes, COORDINATE_FALLBACK_METERS);
      if (incomingTerminalIds.has(sourceNode.id)) affectedNodeIds.add(existing.id);
      continue;
    }
    const node = {
      ...sourceNode,
      id: uniqueNodeId(sourceNode, usedNodeIds),
      sourceNodeIds: [...new Set((sourceNode.sourceNodeIds ?? []).map(String))],
      elevationKeys: [...new Set((sourceNode.elevationKeys ?? []).map(String))],
      elevationKnown: sourceNode.elevationKnown !== false,
      chunkIds: [...new Set([...(sourceNode.chunkIds ?? []), ...(chunkId ? [chunkId] : [])])]
    };
    baseGraph.nodes.push(node);
    addNodeToIndexes(node, indexes, COORDINATE_FALLBACK_METERS);
    nodeMap.set(sourceNode.id, node.id);
    if (incomingTerminalIds.has(sourceNode.id)) affectedNodeIds.add(node.id);
    addedNodes += 1;
  }

  const nodeById = new Map(baseGraph.nodes.map(node => [node.id, node]));
  const edgesByPair = new Map();
  for (const edge of baseGraph.edges) {
    const pair = pairKey(edge.a, edge.b);
    if (!edgesByPair.has(pair)) edgesByPair.set(pair, []);
    edgesByPair.get(pair).push(edge);
  }
  const usedEdgeIds = new Set(baseGraph.edges.map(edge => edge.id));
  let addedEdges = 0;
  let mergedEdges = 0;

  for (const sourceEdge of incomingGraph.edges) {
    if (sourceEdge.routingDisabled) continue;
    const a = nodeMap.get(sourceEdge.a);
    const b = nodeMap.get(sourceEdge.b);
    if (!a || !b || a === b) continue;
    const pair = pairKey(a, b);
    const edgeChunkIds = [...new Set([...(sourceEdge.chunkIds ?? []), ...(chunkId ? [chunkId] : [])])];
    const normalizedSource = normalizeRoadElevation({
      ...sourceEdge,
      routingDisabled: false,
      chunkIds: edgeChunkIds,
      sourceWayIds: [...new Set((sourceEdge.sourceWayIds ?? []).map(String))],
      ancestorEdgeIds: [...new Set((sourceEdge.ancestorEdgeIds ?? []).map(String))]
    });
    const candidates = edgesByPair.get(pair) ?? [];
    const existing = matchingEdge(candidates, normalizedSource);
    if (existing) {
      mergeEdgeMetadata(existing, normalizedSource);
      mergedEdges += 1;
      continue;
    }
    const nodeA = nodeById.get(a);
    const nodeB = nodeById.get(b);
    if (!nodeA || !nodeB) continue;
    const seamMargin = 6;
    for (const candidate of graphElementsInBounds(baseGraph, {
      minX: Math.min(nodeA.x, nodeB.x) - seamMargin,
      minY: Math.min(nodeA.y, nodeB.y) - seamMargin,
      maxX: Math.max(nodeA.x, nodeB.x) + seamMargin,
      maxY: Math.max(nodeA.y, nodeB.y) + seamMargin
    }).nodes) {
      if (baseTerminalIds.has(candidate.id)) affectedNodeIds.add(candidate.id);
    }
    let id = sourceEdge.id || stableId('edge', pair, ...(normalizedSource.sourceWayIds ?? []));
    let sequence = 1;
    while (usedEdgeIds.has(id)) id = `${stableId('edge', pair, sourceEdge.id)}_${sequence++}`;
    usedEdgeIds.add(id);
    const edge = {
      ...normalizedSource,
      id,
      a,
      b,
      length: distance(nodeA, nodeB),
      points: [{ x: nodeA.x, y: nodeA.y }, { x: nodeB.x, y: nodeB.y }],
      mid: segmentMidpoint({ a: nodeA, b: nodeB }),
      angle: segmentAngle({ a: nodeA, b: nodeB }),
      mergedSegmentIds: [...(sourceEdge.mergedSegmentIds ?? [sourceEdge.id])]
    };
    baseGraph.edges.push(edge);
    if (!edgesByPair.has(pair)) edgesByPair.set(pair, []);
    edgesByPair.get(pair).push(edge);
    if (incomingTerminalIds.has(sourceEdge.a)) affectedNodeIds.add(a);
    if (incomingTerminalIds.has(sourceEdge.b)) affectedNodeIds.add(b);
    addedEdges += 1;
  }

  baseGraph.roadSpecVersion = Math.max(Number(baseGraph.roadSpecVersion) || 1, 4);
  if (addedNodes > 0 || addedEdges > 0) {
    baseGraph.topologyRevision = Math.max(1, Math.floor(Number(baseGraph.topologyRevision) || 1)) + 1;
  }
  const pending = baseGraph.pendingTopologyRepairNodeIds instanceof Set
    ? baseGraph.pendingTopologyRepairNodeIds
    : new Set();
  for (const nodeId of affectedNodeIds) pending.add(nodeId);
  if (!rebuildIndexes) {
    Object.defineProperty(baseGraph, 'pendingTopologyRepairNodeIds', {
      value: pending,
      enumerable: false,
      writable: true,
      configurable: true
    });
    return { graph: baseGraph, addedNodes, addedEdges, mergedEdges, repairedConnections: 0, splitEdges: 0 };
  }
  delete baseGraph.pendingTopologyRepairNodeIds;
  attachGraphIndexes(baseGraph);
  const topology = repairRoadGraphTopology(baseGraph, { candidateNodeIds: pending });
  return {
    graph: baseGraph,
    addedNodes,
    addedEdges,
    mergedEdges,
    repairedConnections: topology.sourceConnectors + topology.terminalConnectors,
    splitEdges: topology.splitEdges
  };
}
