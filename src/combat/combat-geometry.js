export function edgeMidpoint(graph, edgeId) {
  const edge = graph.edgeById.get(edgeId);
  if (!edge) return null;
  const a = graph.nodeById.get(edge.a);
  const b = graph.nodeById.get(edge.b);
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
}

export function barrierEdgeProgress(graph, defense) {
  const edge = graph?.edgeById?.get(defense?.edgeId);
  if (!edge) return 0;
  const stored = Number(defense?.edgeProgress);
  return Number.isFinite(stored) ? Math.max(0, Math.min(edge.length, stored)) : edge.length / 2;
}

export function defenseWorldPosition(graph, defense) {
  if (!graph || !defense) return null;
  if (defense.kind !== 'barrier') return graph.nodeById.get(defense.nodeId) ?? null;
  if (defense.placementPoint && Number.isFinite(defense.placementPoint.x) && Number.isFinite(defense.placementPoint.y)) {
    return { x: defense.placementPoint.x, y: defense.placementPoint.y };
  }
  const edge = graph.edgeById.get(defense.edgeId);
  const a = edge && graph.nodeById.get(edge.a);
  const b = edge && graph.nodeById.get(edge.b);
  if (!edge || !a || !b) return null;
  const t = barrierEdgeProgress(graph, defense) / Math.max(0.001, edge.length);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
