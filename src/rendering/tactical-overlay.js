import { distance } from '../core/utilities.js';
import { DEFENSE_DEFINITIONS, ENEMY_DEFINITIONS, defenseRuntimeDefinition } from '../combat/definitions.js';
import { defenseWorldPosition } from '../combat/combat-geometry.js';
import { enemyPosition } from '../combat/enemy-system.js';
import { remainingRouteDistance } from './threat-analysis.js';

const TAU = Math.PI * 2;

function bracket(context, point, radius, color, timeMs = 0) {
  const size = radius + 6 + Math.sin(timeMs * 0.006) * 1.2;
  const corner = Math.max(4, size * 0.35);
  context.save();
  context.strokeStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 9;
  context.lineWidth = 1.4;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = point.x + sx * size;
    const y = point.y + sy * size;
    context.beginPath();
    context.moveTo(x - sx * corner, y);
    context.lineTo(x, y);
    context.lineTo(x, y - sy * corner);
    context.stroke();
  }
  context.restore();
}

function drawCooldown(context, point, defense, definition) {
  const baseCooldown = Math.max(0.001, definition?.cooldown ?? 1);
  const ratio = Math.max(0, Math.min(1, 1 - (defense.cooldown ?? 0) / baseCooldown));
  const color = defense.disabledTimer > 0 ? '#ff5268' : '#65ffd0';
  context.save();
  context.strokeStyle = 'rgba(101,255,208,0.14)';
  context.lineWidth = 2.5;
  context.beginPath();
  context.arc(point.x, point.y, 14, -Math.PI / 2, Math.PI * 1.5);
  context.stroke();
  context.strokeStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 7;
  context.beginPath();
  context.arc(point.x, point.y, 14, -Math.PI / 2, -Math.PI / 2 + TAU * ratio);
  context.stroke();
  context.restore();
}

function nearestEnemyInRange(state, position, range, lockedEnemyId = null) {
  if (lockedEnemyId) {
    const locked = (state.combat.enemies ?? []).find(enemy => enemy.id === lockedEnemyId && enemy.hp > 0 && enemy.departDelay <= 0) ?? null;
    if (locked) {
      const lockedPosition = enemyPosition(state, locked);
      if (distance(position, lockedPosition) <= range + 8) return { enemy: locked, position: lockedPosition, locked: true };
    }
  }
  let target = null;
  let best = range;
  for (const enemy of state.combat.enemies ?? []) {
    if (enemy.hp <= 0 || enemy.departDelay > 0) continue;
    const targetPosition = enemyPosition(state, enemy);
    const gap = distance(position, targetPosition);
    if (gap < best) {
      best = gap;
      target = { enemy, position: targetPosition, locked: false };
    }
  }
  return target;
}

function defensePosition(state, defense) {
  const graph = state.world.roadGraph;
  return defenseWorldPosition(graph, defense);
}

function drawDefenseFocus(context, state, camera, defense, timeMs) {
  const world = defensePosition(state, defense);
  if (!world) return;
  const point = camera.worldToScreen(world);
  const definition = defenseRuntimeDefinition(defense) ?? DEFENSE_DEFINITIONS[defense.type];
  const color = defense.disabledTimer > 0 ? '#ff5268' : '#65d7ff';
  bracket(context, point, 12, color, timeMs);
  const effectRange = defense.type === 'survey' ? definition?.surveyRadius : definition?.range;
  if (defense.kind === 'tower' && effectRange) {
    context.save();
    context.strokeStyle = defense.disabledTimer > 0 ? 'rgba(255,82,104,0.4)' : defense.type === 'survey' ? 'rgba(255,209,102,0.40)' : 'rgba(101,215,255,0.34)';
    context.fillStyle = defense.disabledTimer > 0 ? 'rgba(255,82,104,0.025)' : defense.type === 'survey' ? 'rgba(255,209,102,0.018)' : 'rgba(101,215,255,0.025)';
    context.lineWidth = 1;
    context.setLineDash([5, 5]);
    context.beginPath();
    context.arc(point.x, point.y, Math.max(8, effectRange * camera.scale), 0, TAU);
    context.fill();
    context.stroke();
    context.restore();
    if (defense.type !== 'survey') drawCooldown(context, point, defense, definition);
    if (!['relay', 'survey'].includes(defense.type)) {
      const target = nearestEnemyInRange(state, world, definition.range, defense.currentTargetEnemyId);
      if (target) {
        const targetPoint = camera.worldToScreen(target.position);
        context.save();
        context.strokeStyle = 'rgba(101,215,255,0.62)';
        context.shadowColor = '#65d7ff';
        context.shadowBlur = 7;
        context.lineWidth = 1;
        context.setLineDash([2, 4]);
        context.beginPath();
        context.moveTo(point.x, point.y);
        context.lineTo(targetPoint.x, targetPoint.y);
        context.stroke();
        if (target.locked && defense.currentSplashRadius > 0) {
          context.setLineDash([4, 6]);
          context.globalAlpha = 0.42;
          context.beginPath();
          context.arc(targetPoint.x, targetPoint.y, Math.max(6, defense.currentSplashRadius * camera.scale), 0, TAU);
          context.stroke();
        }
        context.restore();
      }
    }
  }
}

function drawEnemyFocus(context, state, camera, enemy, timeMs) {
  const position = enemyPosition(state, enemy);
  const point = camera.worldToScreen(position);
  bracket(context, point, Math.max(8, (ENEMY_DEFINITIONS[enemy.type]?.radius ?? 5) + 4), '#ff7588', timeMs);
  const remaining = remainingRouteDistance(state, enemy);
  context.save();
  context.fillStyle = '#ffd7dd';
  context.font = '700 9px ui-monospace, monospace';
  context.textAlign = 'center';
  context.fillText(Number.isFinite(remaining) ? `${Math.round(remaining)}m` : 'NO ROUTE', point.x, point.y - 18);
  context.restore();
}

export function drawTacticalFocus(context, state, camera, focus = null, timeMs = 0) {
  if (!focus) return;
  if (focus.kind === 'enemy') {
    const enemy = state.combat.enemies.find(item => item.id === focus.id);
    if (enemy?.hp > 0) drawEnemyFocus(context, state, camera, enemy, timeMs);
    return;
  }
  if (focus.kind === 'defense') {
    const defense = state.combat.defenses.find(item => item.id === focus.id);
    if (defense) drawDefenseFocus(context, state, camera, defense, timeMs);
    return;
  }
  const graph = state.world.roadGraph;
  let world = null;
  let color = '#65ffd0';
  if (focus.kind === 'enemyBase') {
    const base = state.world.enemyBases.find(item => item.id === focus.id && item.alive && item.hp > 0);
    if (!base) return;
    world = graph.nodeById.get(base.nodeId);
    color = '#ff5268';
  } else if (focus.kind === 'city') {
    world = graph.nodeById.get(state.world.city.nodeId);
  } else if (focus.kind === 'roadsideMine') {
    world = (state.world.roadsideSupplies?.placedMines ?? []).find(item => item.id === focus.id);
    color = '#ffef79';
  }
  if (world) bracket(context, camera.worldToScreen(world), 17, color, timeMs);
}
