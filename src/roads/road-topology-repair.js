import { distance, stableId } from '../core/utilities.js';
import { pointToSegmentProjection, segmentAngle, segmentMidpoint } from './geometry.js';
import { attachGraphIndexes, graphElementsNearPoint } from './road-graph.js';
import { roadElevationKey, roadElevationKnown, sameRoadElevation } from './road-elevation.js';

const SOURCE_ID_MAX_GAP_METERS = 24;
const TERMINAL_PAIR_MAX_GAP_METERS = 6.5;
const TERMINAL_TO_NODE_MAX_GAP_METERS = 5.5;
const TERMINAL_TO_EDGE_MAX_GAP_METERS = 9;
const EDGE_INTERSECTION_SEARCH_METERS = 0.75;
const MIN_INTERIOR_SPLIT_METERS = 2.5;
const MIN_T_JUNCTION_ANGLE_RADIANS = 18 * Math.PI / 180;
const MAX_OUTWARD_ERROR_RADIANS = 70 * Math.PI / 180;

function activeEdge(edge) {
  return edge && !edge.routingDisabled;
}

function lineAngleDifference(first, second) {
  let difference = Math.abs(first - second) % Math.PI;
  if (difference > Math.PI / 2) difference = Math.PI - difference;
  return difference;
}


function edgeBounds(a, b, padding = 0) {
  return {
    minX: Math.min(a.x, b.x) - padding,
    minY: Math.min(a.y, b.y) - padding,
    maxX: Math.max(a.x, b.x) + padding,
    maxY: Math.max(a.y, b.y) + padding
  };
}

function boundsOverlap(first, second) {
  return first.maxX >= second.minX && first.minX <= second.maxX
    && first.maxY >= second.minY && first.minY <= second.maxY;
}


function repairBucketRange(bounds, cellSize) {
  return {
    minX: Math.floor(bounds.minX / cellSize),
    maxX: Math.floor(bounds.maxX / cellSize),
    minY: Math.floor(bounds.minY / cellSize),
    maxY: Math.floor(bounds.maxY / cellSize)
  };
}

function repairBucketKey(x, y) {
  return `${x},${y}`;
}

function createEdgeRepairBuckets(graph, edges, cellSize = 48) {
  const buckets = new Map();
  const boundsByEdgeId = new Map();
  for (const edge of edges) {
    const a = graph.nodeById.get(edge.a);
    const b = graph.nodeById.get(edge.b);
    if (!a || !b) continue;
    const bounds = edgeBounds(a, b, EDGE_INTERSECTION_SEARCH_METERS);
    boundsByEdgeId.set(edge.id, bounds);
    const range = repairBucketRange(bounds, cellSize);
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = repairBucketKey(x, y);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(edge);
      }
    }
  }
  return { buckets, boundsByEdgeId, cellSize };
}

function candidateRepairEdges(index, bounds) {
  const range = repairBucketRange(bounds, index.cellSize);
  const result = new Set();
  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      for (const edge of index.buckets.get(repairBucketKey(x, y)) ?? []) result.add(edge);
    }
  }
  return result;
}

function segmentIntersectionPoint(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-9) return null;
  const qmp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qmp.x * s.y - qmp.y * s.x) / denominator;
  const u = (qmp.x * r.y - qmp.y * r.x) / denominator;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { point: { x: a.x + t * r.x, y: a.y + t * r.y }, t, u };
}

function edgeSplitPointKey(point) {
  return `${Math.round(point.x * 10)}:${Math.round(point.y * 10)}`;
}

function vectorAngleDifference(a, b) {
  const lengthA = Math.hypot(a.x, a.y);
  const lengthB = Math.hypot(b.x, b.y);
  if (lengthA < 1e-6 || lengthB < 1e-6) return Math.PI;
  const cosine = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (lengthA * lengthB)));
  return Math.acos(cosine);
}

function incidentActiveEdges(graph, nodeId) {
  return (graph.adjacency.get(nodeId) ?? [])
    .map(connection => graph.edgeById.get(connection.edgeId))
    .filter(activeEdge);
}

function terminalOutwardVector(graph, node) {
  const connection = graph.adjacency.get(node.id)?.[0];
  const neighbor = connection ? graph.nodeById.get(connection.to) : null;
  return neighbor ? { x: node.x - neighbor.x, y: node.y - neighbor.y } : null;
}

function edgeMetadata(edge) {
  return {
    barrier: null,
    roadWidth: edge.roadWidth,
    lanes: edge.lanes,
    highway: edge.highway,
    name: edge.name,
    oneway: edge.oneway,
    layer: edge.layer,
    bridge: edge.bridge,
    tunnel: edge.tunnel,
    elevationKey: roadElevationKey(edge),
    sourceWayIds: [...(edge.sourceWayIds ?? [])],
    mergedSegmentIds: [...(edge.mergedSegmentIds ?? [edge.id])],
    chunkIds: [...(edge.chunkIds ?? [])],
    elevationKnown: roadElevationKnown(edge)
  };
}

function uniqueEdgeId(graph, ...parts) {
  let id = stableId(...parts);
  let sequence = 1;
  while (graph.edgeById?.has(id) || graph.edges.some(edge => edge.id === id)) id = `${stableId(...parts)}_${sequence++}`;
  return id;
}

function hasDirectConnection(graph, firstId, secondId) {
  return (graph.adjacency.get(firstId) ?? []).some(connection => connection.to === secondId);
}

function addConnectorEdge(graph, first, second, reason, template = null) {
  if (!first || !second || first.id === second.id || hasDirectConnection(graph, first.id, second.id)) return null;
  const length = Math.max(0.1, distance(first, second));
  const edge = {
    id: uniqueEdgeId(graph, 'topology-connector', reason, first.id, second.id),
    a: first.id,
    b: second.id,
    length,
    points: [{ x: first.x, y: first.y }, { x: second.x, y: second.y }],
    topologyRepair: reason,
    ...(template ? edgeMetadata(template) : {
      barrier: null,
      roadWidth: 3,
      lanes: 1,
      highway: 'service',
      name: '',
      oneway: false,
      layer: 0,
      bridge: false,
      tunnel: false,
      elevationKey: '0:0:0',
      sourceWayIds: [],
      mergedSegmentIds: [],
      chunkIds: []
    })
  };
  edge.angle = segmentAngle({ a: first, b: second });
  edge.mid = segmentMidpoint({ a: first, b: second });
  graph.edges.push(edge);
  return edge;
}

function connectSharedSourceNodes(graph, candidateNodeIds = null) {
  const bySource = new Map();
  for (const node of graph.nodes) {
    if (candidateNodeIds && !candidateNodeIds.has(node.id)) continue;
    for (const sourceId of node.sourceNodeIds ?? []) {
      const entries = bySource.get(String(sourceId)) ?? [];
      entries.push(node);
      bySource.set(String(sourceId), entries);
    }
  }
  if (candidateNodeIds) {
    for (const node of graph.nodes) {
      for (const sourceId of node.sourceNodeIds ?? []) {
        const entries = bySource.get(String(sourceId));
        if (entries && !entries.includes(node)) entries.push(node);
      }
    }
  }
  let added = 0;
  for (const nodes of bySource.values()) {
    if (nodes.length < 2) continue;
    const canonical = nodes[0];
    for (const node of nodes.slice(1)) {
      if (distance(canonical, node) > SOURCE_ID_MAX_GAP_METERS) continue;
      const template = incidentActiveEdges(graph, canonical.id)[0] ?? incidentActiveEdges(graph, node.id)[0] ?? null;
      if (addConnectorEdge(graph, canonical, node, 'shared-osm-node', template)) added += 1;
    }
  }
  return added;
}

function connectAlignedTerminalPairs(graph, candidateNodeIds = null) {
  const terminals = graph.terminalNodes.filter(node => !candidateNodeIds || candidateNodeIds.has(node.id));
  const terminalIds = new Set(graph.terminalNodes.map(node => node.id));
  const used = new Set();
  let added = 0;
  for (const node of terminals) {
    if (used.has(node.id)) continue;
    const incident = incidentActiveEdges(graph, node.id)[0];
    const outward = terminalOutwardVector(graph, node);
    if (!incident || !outward) continue;
    const nearby = graphElementsNearPoint(graph, node, TERMINAL_PAIR_MAX_GAP_METERS).nodes
      .filter(candidate => candidate.id !== node.id && terminalIds.has(candidate.id) && !used.has(candidate.id))
      .sort((left, right) => distance(node, left) - distance(node, right));
    for (const candidate of nearby) {
      const otherEdge = incidentActiveEdges(graph, candidate.id)[0];
      const otherOutward = terminalOutwardVector(graph, candidate);
      if (!otherEdge || !otherOutward || !roadElevationKnown(incident) || !roadElevationKnown(otherEdge) || !sameRoadElevation(incident, otherEdge)) continue;
      const gap = { x: candidate.x - node.x, y: candidate.y - node.y };
      if (vectorAngleDifference(outward, gap) > MAX_OUTWARD_ERROR_RADIANS) continue;
      if (vectorAngleDifference(otherOutward, { x: -gap.x, y: -gap.y }) > MAX_OUTWARD_ERROR_RADIANS) continue;
      if (addConnectorEdge(graph, node, candidate, 'aligned-terminal-gap', incident)) {
        added += 1;
        used.add(node.id);
        used.add(candidate.id);
      }
      break;
    }
  }
  return added;
}

function connectTerminalsToNearbyNodes(graph, candidateNodeIds = null) {
  const terminals = graph.terminalNodes.filter(node => !candidateNodeIds || candidateNodeIds.has(node.id));
  let added = 0;
  for (const terminal of terminals) {
    const incident = incidentActiveEdges(graph, terminal.id)[0];
    const outward = terminalOutwardVector(graph, terminal);
    if (!incident || !outward) continue;
    const terminalSources = new Set((terminal.sourceNodeIds ?? []).map(String));
    const nearby = graphElementsNearPoint(graph, terminal, TERMINAL_TO_NODE_MAX_GAP_METERS).nodes
      .filter(candidate => candidate.id !== terminal.id && (graph.adjacency.get(candidate.id)?.length ?? 0) >= 2)
      .sort((left, right) => distance(terminal, left) - distance(terminal, right));
    for (const candidate of nearby) {
      if (hasDirectConnection(graph, terminal.id, candidate.id)) break;
      if (!roadElevationKnown(incident) || candidate.elevationKnown === false) continue;
      const candidateEdges = incidentActiveEdges(graph, candidate.id).filter(edge => roadElevationKnown(edge) && sameRoadElevation(incident, edge));
      if (!candidateEdges.length) continue;
      const gapDistance = distance(terminal, candidate);
      const candidateSources = (candidate.sourceNodeIds ?? []).map(String);
      const sharesSource = candidateSources.some(sourceId => terminalSources.has(sourceId));
      // Distinct explicit OSM nodes can be separate carriageways. Only bridge a very
      // small metadata seam unless one endpoint is synthetic/clipped.
      if (!sharesSource && terminalSources.size > 0 && candidateSources.length > 0 && gapDistance > 2.5) continue;
      const gap = { x: candidate.x - terminal.x, y: candidate.y - terminal.y };
      if (vectorAngleDifference(outward, gap) > MAX_OUTWARD_ERROR_RADIANS) continue;
      if (addConnectorEdge(graph, terminal, candidate, 'terminal-to-near-node', incident)) added += 1;
      break;
    }
  }
  return added;
}

function terminalToEdgeRepairs(graph, candidateNodeIds = null) {
  const repairs = [];
  const terminals = graph.terminalNodes.filter(node => !candidateNodeIds || candidateNodeIds.has(node.id));
  for (const terminal of terminals) {
    const incident = incidentActiveEdges(graph, terminal.id)[0];
    const outward = terminalOutwardVector(graph, terminal);
    if (!incident || !outward) continue;
    let best = null;
    for (const edge of graphElementsNearPoint(graph, terminal, TERMINAL_TO_EDGE_MAX_GAP_METERS).edges) {
      if (!activeEdge(edge) || edge.id === incident.id || edge.a === terminal.id || edge.b === terminal.id) continue;
      if (!roadElevationKnown(incident) || !roadElevationKnown(edge) || !sameRoadElevation(incident, edge)) continue;
      const a = graph.nodeById.get(edge.a);
      const b = graph.nodeById.get(edge.b);
      if (!a || !b) continue;
      const projection = pointToSegmentProjection(terminal, a, b);
      if (projection.distance > TERMINAL_TO_EDGE_MAX_GAP_METERS) continue;
      const toProjection = { x: projection.point.x - terminal.x, y: projection.point.y - terminal.y };
      if (vectorAngleDifference(outward, toProjection) > MAX_OUTWARD_ERROR_RADIANS) continue;
      if (lineAngleDifference(incident.angle ?? segmentAngle({ a: graph.nodeById.get(incident.a), b: graph.nodeById.get(incident.b) }), edge.angle ?? segmentAngle({ a, b })) < MIN_T_JUNCTION_ANGLE_RADIANS) continue;
      const along = projection.t * edge.length;
      if (along < MIN_INTERIOR_SPLIT_METERS || edge.length - along < MIN_INTERIOR_SPLIT_METERS) continue;
      if (!best || projection.distance < best.projection.distance) best = { terminal, incident, edge, projection };
    }
    if (best) repairs.push(best);
  }
  return repairs;
}

function splitEdgesAndConnect(graph, repairs) {
  const byEdge = new Map();
  for (const repair of repairs) {
    const list = byEdge.get(repair.edge.id) ?? [];
    if (!list.some(item => distance(item.projection.point, repair.projection.point) < 1.5)) list.push(repair);
    byEdge.set(repair.edge.id, list);
  }
  let splitEdges = 0;
  let connectors = 0;
  for (const [edgeId, list] of byEdge) {
    const edge = graph.edgeById.get(edgeId);
    if (!activeEdge(edge)) continue;
    const a = graph.nodeById.get(edge.a);
    const b = graph.nodeById.get(edge.b);
    if (!a || !b) continue;
    const sorted = [...list].sort((left, right) => left.projection.t - right.projection.t);
    const splitNodes = [];
    for (const repair of sorted) {
      const point = repair.projection.point;
      const node = {
        id: stableId('topology-junction', edge.id, Math.round(point.x * 10), Math.round(point.y * 10)),
        x: point.x,
        y: point.y,
        sourceNodeIds: [],
        elevationKeys: [roadElevationKey(edge)],
        topologySynthetic: true,
        elevationKnown: roadElevationKnown(edge),
        chunkIds: [...(edge.chunkIds ?? [])],
    elevationKnown: roadElevationKnown(edge)
      };
      let sequence = 1;
      while (graph.nodes.some(item => item.id === node.id)) node.id = `${stableId('topology-junction', edge.id, Math.round(point.x * 100), Math.round(point.y * 100))}_${sequence++}`;
      graph.nodes.push(node);
      splitNodes.push({ node, repair });
    }
    const chain = [a, ...splitNodes.map(item => item.node), b];
    edge.routingDisabled = true;
    edge.subdivisionEdgeIds = [];
    const ancestors = [...new Set([...(edge.ancestorEdgeIds ?? []), edge.id])];
    for (let index = 0; index < chain.length - 1; index += 1) {
      const from = chain[index];
      const to = chain[index + 1];
      const child = {
        id: uniqueEdgeId(graph, 'split-edge', edge.id, index, from.id, to.id),
        a: from.id,
        b: to.id,
        length: Math.max(0.1, distance(from, to)),
        points: [{ x: from.x, y: from.y }, { x: to.x, y: to.y }],
        parentEdgeId: edge.id,
        ancestorEdgeIds: ancestors,
        topologyRepair: 'terminal-to-road',
        ...edgeMetadata(edge)
      };
      child.angle = segmentAngle({ a: from, b: to });
      child.mid = segmentMidpoint({ a: from, b: to });
      graph.edges.push(child);
      edge.subdivisionEdgeIds.push(child.id);
      splitEdges += 1;
    }
    for (const { node, repair } of splitNodes) {
      if (addConnectorEdge(graph, repair.terminal, node, 'terminal-to-road', repair.incident)) connectors += 1;
    }
  }
  return { splitEdges, connectors };
}


function collectEdgeIntersectionRepairs(graph, candidateNodeIds = null) {
  const repairsByEdge = new Map();
  const candidateSet = candidateNodeIds ? new Set(candidateNodeIds) : null;
  const allActiveEdges = graph.edges.filter(edge => activeEdge(edge) && roadElevationKnown(edge));
  const candidateEdges = candidateSet
    ? allActiveEdges.filter(edge => candidateSet.has(edge.a) || candidateSet.has(edge.b))
    : allActiveEdges;
  const repairIndex = createEdgeRepairBuckets(graph, allActiveEdges);
  const seenPairs = new Set();
  for (const edge of candidateEdges) {
    const a = graph.nodeById.get(edge.a);
    const b = graph.nodeById.get(edge.b);
    const search = repairIndex.boundsByEdgeId.get(edge.id);
    if (!a || !b || !search) continue;
    for (const other of candidateRepairEdges(repairIndex, search)) {
      if (!activeEdge(other) || other.id === edge.id || !roadElevationKnown(other) || !sameRoadElevation(edge, other)) continue;
      if (edge.a === other.a || edge.a === other.b || edge.b === other.a || edge.b === other.b) continue;
      const pairKey = edge.id < other.id ? `${edge.id}|${other.id}` : `${other.id}|${edge.id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const c = graph.nodeById.get(other.a);
      const d = graph.nodeById.get(other.b);
      if (!c || !d) continue;
      if (!boundsOverlap(search, repairIndex.boundsByEdgeId.get(other.id) ?? edgeBounds(c, d, EDGE_INTERSECTION_SEARCH_METERS))) continue;
      const angleGap = lineAngleDifference(edge.angle ?? segmentAngle({ a, b }), other.angle ?? segmentAngle({ a: c, b: d }));
      if (angleGap < MIN_T_JUNCTION_ANGLE_RADIANS) continue;
      const intersection = segmentIntersectionPoint(a, b, c, d);
      if (!intersection) continue;
      const edgeLength = edge.length ?? distance(a, b);
      const otherLength = other.length ?? distance(c, d);
      const edgeAlong = intersection.t * edgeLength;
      const otherAlong = intersection.u * otherLength;
      if (edgeAlong < MIN_INTERIOR_SPLIT_METERS || edgeLength - edgeAlong < MIN_INTERIOR_SPLIT_METERS) continue;
      if (otherAlong < MIN_INTERIOR_SPLIT_METERS || otherLength - otherAlong < MIN_INTERIOR_SPLIT_METERS) continue;
      const nodeId = stableId('topology-crossing', edgeSplitPointKey(intersection.point), roadElevationKey(edge));
      const entry = {
        point: intersection.point,
        nodeId,
        template: edge,
        reason: 'edge-crossing'
      };
      const otherEntry = {
        point: intersection.point,
        nodeId,
        template: other,
        reason: 'edge-crossing'
      };
      if (!repairsByEdge.has(edge.id)) repairsByEdge.set(edge.id, []);
      if (!repairsByEdge.has(other.id)) repairsByEdge.set(other.id, []);
      repairsByEdge.get(edge.id).push(entry);
      repairsByEdge.get(other.id).push(otherEntry);
    }
  }
  return repairsByEdge;
}

function splitEdgesAtSyntheticNodes(graph, repairsByEdge) {
  if (!repairsByEdge.size) return { splitEdges: 0, createdNodes: 0 };
  const nodeByKey = new Map();
  let createdNodes = 0;
  let splitEdges = 0;
  for (const [edgeId, entries] of repairsByEdge) {
    const edge = graph.edgeById.get(edgeId);
    if (!activeEdge(edge)) continue;
    const a = graph.nodeById.get(edge.a);
    const b = graph.nodeById.get(edge.b);
    if (!a || !b) continue;
    const uniqueEntries = [];
    for (const entry of entries) {
      if (uniqueEntries.some(item => distance(item.point, entry.point) < 1.5)) continue;
      uniqueEntries.push(entry);
    }
    const sorted = uniqueEntries
      .map(entry => ({ ...entry, projection: pointToSegmentProjection(entry.point, a, b) }))
      .filter(entry => {
        const length = edge.length ?? distance(a, b);
        const along = entry.projection.t * length;
        return entry.projection.distance <= EDGE_INTERSECTION_SEARCH_METERS
          && along >= MIN_INTERIOR_SPLIT_METERS
          && length - along >= MIN_INTERIOR_SPLIT_METERS;
      })
      .sort((left, right) => left.projection.t - right.projection.t);
    if (!sorted.length) continue;

    const splitNodes = [];
    for (const entry of sorted) {
      const key = `${entry.nodeId}:${edgeSplitPointKey(entry.projection.point)}`;
      let node = nodeByKey.get(key);
      if (!node) {
        node = {
          id: entry.nodeId,
          x: entry.projection.point.x,
          y: entry.projection.point.y,
          sourceNodeIds: [],
          elevationKeys: [roadElevationKey(edge)],
          topologySynthetic: true,
          elevationKnown: roadElevationKnown(edge),
          chunkIds: [...(edge.chunkIds ?? [])]
        };
        let sequence = 1;
        while (graph.nodes.some(item => item.id === node.id)) node.id = `${entry.nodeId}_${sequence++}`;
        graph.nodes.push(node);
        nodeByKey.set(key, node);
        createdNodes += 1;
      } else {
        node.chunkIds = [...new Set([...(node.chunkIds ?? []), ...(edge.chunkIds ?? [])])];
        node.elevationKeys = [...new Set([...(node.elevationKeys ?? []), roadElevationKey(edge)])];
      }
      splitNodes.push(node);
    }

    const chain = [a, ...splitNodes, b];
    edge.routingDisabled = true;
    edge.subdivisionEdgeIds = [];
    const ancestors = [...new Set([...(edge.ancestorEdgeIds ?? []), edge.id])];
    for (let index = 0; index < chain.length - 1; index += 1) {
      const from = chain[index];
      const to = chain[index + 1];
      if (from.id === to.id) continue;
      const child = {
        id: uniqueEdgeId(graph, 'split-edge', edge.id, index, from.id, to.id),
        a: from.id,
        b: to.id,
        length: Math.max(0.1, distance(from, to)),
        points: [{ x: from.x, y: from.y }, { x: to.x, y: to.y }],
        parentEdgeId: edge.id,
        ancestorEdgeIds: ancestors,
        topologyRepair: 'edge-crossing',
        ...edgeMetadata(edge)
      };
      child.angle = segmentAngle({ a: from, b: to });
      child.mid = segmentMidpoint({ a: from, b: to });
      graph.edges.push(child);
      edge.subdivisionEdgeIds.push(child.id);
      splitEdges += 1;
    }
  }
  return { splitEdges, createdNodes };
}

export function repairRoadGraphTopology(graph, { candidateNodeIds = null } = {}) {
  if (!graph?.nodes || !graph?.edges) return { changed: false, sourceConnectors: 0, terminalConnectors: 0, splitEdges: 0 };
  attachGraphIndexes(graph);
  const candidates = candidateNodeIds ? new Set(candidateNodeIds) : null;
  let sourceConnectors = connectSharedSourceNodes(graph, candidates);
  if (sourceConnectors) attachGraphIndexes(graph);
  let terminalConnectors = connectAlignedTerminalPairs(graph, candidates);
  if (terminalConnectors) attachGraphIndexes(graph);
  const nodeConnectors = connectTerminalsToNearbyNodes(graph, candidates);
  terminalConnectors += nodeConnectors;
  if (nodeConnectors) attachGraphIndexes(graph);
  const repairs = terminalToEdgeRepairs(graph, candidates);
  const split = splitEdgesAndConnect(graph, repairs);
  if (split.splitEdges || split.connectors) attachGraphIndexes(graph);
  const crossingRepairs = collectEdgeIntersectionRepairs(graph, candidates);
  const crossingSplit = splitEdgesAtSyntheticNodes(graph, crossingRepairs);
  const changed = sourceConnectors > 0
    || terminalConnectors > 0
    || split.splitEdges > 0
    || split.connectors > 0
    || crossingSplit.splitEdges > 0
    || crossingSplit.createdNodes > 0;
  if (changed) {
    graph.topologyRevision = Math.max(1, Math.floor(Number(graph.topologyRevision) || 1)) + 1;
    attachGraphIndexes(graph);
  }
  return {
    changed,
    sourceConnectors,
    terminalConnectors: terminalConnectors + split.connectors,
    splitEdges: split.splitEdges + crossingSplit.splitEdges,
    edgeIntersectionNodes: crossingSplit.createdNodes
  };
}
