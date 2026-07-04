const ROAD_GRAPH_FORMAT_V1 = 'frontline-road-graph-1';
const ROAD_GRAPH_FORMAT_V2 = 'frontline-road-graph-2';
const ROAD_GRAPH_FORMAT_V3 = 'frontline-road-graph-3';
const DEFAULT_ELEVATION_KEY = '0:0:0';

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rounded(value, precision = 10) {
  return Math.round(finiteNumber(value) * precision) / precision;
}

function stringIds(values) {
  return [...new Set((values ?? []).map(String).filter(Boolean))];
}

function elevationKey(value) {
  if (typeof value?.elevationKey === 'string' && value.elevationKey) return value.elevationKey;
  return `${Math.round(finiteNumber(value?.layer, 0))}:${value?.bridge ? 1 : 0}:${value?.tunnel ? 1 : 0}`;
}

function elevationFields(key) {
  const [layer = '0', bridge = '0', tunnel = '0'] = String(key || DEFAULT_ELEVATION_KEY).split(':');
  return {
    elevationKey: `${Math.round(finiteNumber(layer, 0))}:${bridge === '1' ? 1 : 0}:${tunnel === '1' ? 1 : 0}`,
    layer: Math.round(finiteNumber(layer, 0)),
    bridge: bridge === '1',
    tunnel: tunnel === '1'
  };
}

function trimOptionalTail(row) {
  while (row.length && (row.at(-1) == null || (Array.isArray(row.at(-1)) && row.at(-1).length === 0))) row.pop();
  return row;
}

function encodedNode(node) {
  const row = [node.id, rounded(node.x), rounded(node.y), stringIds(node.sourceNodeIds)];
  const keys = stringIds(node.elevationKeys).filter(key => key !== DEFAULT_ELEVATION_KEY);
  if (keys.length || node.topologySynthetic || node.elevationKnown === false) row[4] = keys;
  if (node.topologySynthetic || node.elevationKnown === false) row[5] = node.topologySynthetic ? 1 : 0;
  if (node.elevationKnown === false) row[6] = 0;
  return trimOptionalTail(row);
}

function topologyTail(edge) {
  const tail = [
    edge.routingDisabled ? 1 : 0,
    edge.parentEdgeId ?? null,
    stringIds(edge.ancestorEdgeIds),
    edge.topologyRepair ?? null,
    stringIds(edge.subdivisionEdgeIds)
  ];
  return trimOptionalTail(tail);
}

function encodedEdge(edge) {
  const row = [
    edge.id,
    edge.a,
    edge.b,
    rounded(edge.length),
    rounded(edge.roadWidth ?? 5),
    Math.max(1, Math.round(finiteNumber(edge.lanes, 1))),
    edge.highway ?? 'residential',
    edge.name ?? '',
    edge.oneway ? 1 : 0,
    stringIds(edge.sourceWayIds)
  ];
  const key = elevationKey(edge);
  const topology = topologyTail(edge);
  const encodedElevation = edge.elevationKnown === false ? '?' : key === DEFAULT_ELEVATION_KEY ? null : key;
  if (encodedElevation != null || topology.length) row[10] = encodedElevation;
  if (topology.length) row[11] = topology;
  return trimOptionalTail(row);
}

export function encodeRoadGraph(graph) {
  if (!graph?.nodes || !graph?.edges) return graph;
  return {
    format: ROAD_GRAPH_FORMAT_V3,
    center: graph.center ? { lat: graph.center.lat, lon: graph.center.lon } : null,
    source: graph.source ?? 'osm',
    roadSpecVersion: Number(graph.roadSpecVersion) || 1,
    topologyRevision: Math.max(1, Math.floor(Number(graph.topologyRevision) || 1)),
    nodes: graph.nodes.map(encodedNode),
    edges: graph.edges.map(encodedEdge)
  };
}

function decodeNode(row, hasSourceIdentity, hasTopology) {
  return {
    id: row[0],
    x: finiteNumber(row[1]),
    y: finiteNumber(row[2]),
    sourceNodeIds: hasSourceIdentity ? stringIds(row[3]) : [],
    elevationKeys: hasTopology ? stringIds(row[4]) : [],
    topologySynthetic: hasTopology ? Boolean(row[5]) : false,
    elevationKnown: hasTopology ? row[6] !== 0 : false
  };
}

function decodeLegacyV3Edge(row) {
  return {
    ...elevationFields(`${Math.round(finiteNumber(row[10], 0))}:${row[11] ? 1 : 0}:${row[12] ? 1 : 0}`),
    elevationKnown: true,
    routingDisabled: Boolean(row[13]),
    parentEdgeId: row[14] ?? null,
    ancestorEdgeIds: stringIds(row[15]),
    topologyRepair: row[16] ?? null,
    subdivisionEdgeIds: stringIds(row[17])
  };
}

function decodeCompactV3Edge(row) {
  const topology = Array.isArray(row[11]) ? row[11] : [];
  const unknown = row[10] === '?';
  return {
    ...elevationFields(!unknown && typeof row[10] === 'string' ? row[10] : DEFAULT_ELEVATION_KEY),
    elevationKnown: !unknown,
    routingDisabled: Boolean(topology[0]),
    parentEdgeId: topology[1] ?? null,
    ancestorEdgeIds: stringIds(topology[2]),
    topologyRepair: topology[3] ?? null,
    subdivisionEdgeIds: stringIds(topology[4])
  };
}

function decodeEdge(row, hasSourceIdentity, hasTopology) {
  const topology = !hasTopology
    ? { ...elevationFields(DEFAULT_ELEVATION_KEY), elevationKnown: false, routingDisabled: false, parentEdgeId: null, ancestorEdgeIds: [], topologyRepair: null, subdivisionEdgeIds: [] }
    : typeof row[10] === 'number' || row.length >= 18
      ? decodeLegacyV3Edge(row)
      : decodeCompactV3Edge(row);
  return {
    id: row[0],
    a: row[1],
    b: row[2],
    length: Math.max(0.1, finiteNumber(row[3], 0.1)),
    roadWidth: Math.max(1, finiteNumber(row[4], 5)),
    lanes: Math.max(1, Math.round(finiteNumber(row[5], 1))),
    highway: row[6] ?? 'residential',
    name: row[7] ?? '',
    oneway: Boolean(row[8]),
    sourceWayIds: hasSourceIdentity ? stringIds(row[9]) : [],
    ...topology
  };
}

export function decodeRoadGraph(value) {
  if (!value || ![ROAD_GRAPH_FORMAT_V1, ROAD_GRAPH_FORMAT_V2, ROAD_GRAPH_FORMAT_V3].includes(value.format)) return value;
  const hasSourceIdentity = value.format !== ROAD_GRAPH_FORMAT_V1;
  const hasTopology = value.format === ROAD_GRAPH_FORMAT_V3;
  return {
    center: value.center ? { lat: finiteNumber(value.center.lat), lon: finiteNumber(value.center.lon) } : null,
    source: value.source ?? 'osm',
    roadSpecVersion: Number(value.roadSpecVersion) || 1,
    topologyRevision: hasTopology ? Math.max(1, Math.floor(finiteNumber(value.topologyRevision, 1))) : 1,
    nodes: (value.nodes ?? []).map(row => decodeNode(row, hasSourceIdentity, hasTopology)),
    edges: (value.edges ?? []).map(row => decodeEdge(row, hasSourceIdentity, hasTopology))
  };
}
