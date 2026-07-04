import { CIVILIZATIONS, MAX_CIVILIZATION_LEVEL } from '../civilization/data.js';
import { clamp } from '../core/utilities.js';
import { defenseWorldPosition } from '../combat/combat-geometry.js';
import { enemyPosition } from '../combat/enemy-system.js';
import { friendlySquadPosition } from '../combat/friendly-force-system.js';
import { friendlySquadDefinition } from '../combat/friendly-force-definitions.js';
import { RECOVERY_ITEM_STATUS, isRecoveryItemVisible, recoveryItemPoint } from '../exploration/recovery-system.js';
import { roadsideSupplyPoint } from '../exploration/roadside-supplies.js';
import { defenseRuntimeDefinition } from '../combat/definitions.js';
import { enemyRepresentativeBlipCount, enemyUnitCount } from '../combat/enemy-grouping.js';
import { sweepIntensity } from './radar-renderer.js';

const TAU = Math.PI * 2;

function glow(context, color, blur = 12, quality = 'full') {
  if (quality !== 'full') return;
  context.shadowColor = color;
  context.shadowBlur = blur;
}

function ring(context, point, radius, color, lineWidth = 1.5, alpha = 1, dashed = false) {
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  if (dashed) context.setLineDash([3, 3]);
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, TAU);
  context.stroke();
  context.restore();
}

function polygon(context, point, radius, sides, rotation, fill, stroke, lineWidth = 1.5) {
  context.beginPath();
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + index * TAU / sides;
    const x = point.x + Math.cos(angle) * radius;
    const y = point.y + Math.sin(angle) * radius;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = stroke;
  context.lineWidth = lineWidth;
  context.stroke();
}

function drawHealthBar(context, point, value, maximum, width = 24, offset = 12, quality = 'balanced') {
  const ratio = clamp(value / Math.max(1, maximum), 0, 1);
  context.save();
  context.fillStyle = 'rgba(0, 10, 10, 0.86)';
  context.fillRect(point.x - width / 2 - 1, point.y + offset - 1, width + 2, 4);
  context.fillStyle = ratio < 0.3 ? '#ff5268' : ratio < 0.65 ? '#ffc857' : '#65ffd0';
  if (quality === 'full') {
    context.shadowColor = context.fillStyle;
    context.shadowBlur = 5;
  }
  context.fillRect(point.x - width / 2, point.y + offset, width * ratio, 2);
  context.restore();
}

function drawTicks(context, point, radius, color) {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1.2;
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI / 2;
    const inner = radius + 2;
    const outer = radius + 6;
    context.beginPath();
    context.moveTo(point.x + Math.cos(angle) * inner, point.y + Math.sin(angle) * inner);
    context.lineTo(point.x + Math.cos(angle) * outer, point.y + Math.sin(angle) * outer);
    context.stroke();
  }
  context.restore();
}

function drawEnemyBase(context, point, timeMs, quality) {
  const pulse = 14 + Math.sin(timeMs * 0.004) * 2;
  context.save();
  glow(context, '#ff4965', 18, quality);
  polygon(context, point, 10, 4, Math.PI / 4, 'rgba(255,73,101,0.22)', '#ff4965', 1.7);
  ring(context, point, pulse, '#ff6b7d', 1, 0.65, true);
  drawTicks(context, point, 12, '#ff6b7d');
  context.fillStyle = '#ffb3bd';
  context.font = '700 8px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('◆', point.x, point.y + 0.5);
  context.restore();
}

function drawBarrier(context, point, angle, quality) {
  context.save();
  context.translate(point.x, point.y);
  context.rotate(angle);
  glow(context, '#ffc857', 9, quality);
  context.fillStyle = 'rgba(255,200,87,0.2)';
  context.strokeStyle = '#ffc857';
  context.lineWidth = 1.2;
  context.fillRect(-11, -4, 22, 8);
  context.strokeRect(-11, -4, 22, 8);
  context.beginPath();
  for (let x = -8; x <= 8; x += 4) {
    context.moveTo(x, -4);
    context.lineTo(x + 4, 4);
  }
  context.stroke();
  context.restore();
}


function drawGate(context, point, angle, quality) {
  context.save();
  context.translate(point.x, point.y);
  context.rotate(angle);
  glow(context, '#ffd978', 11, quality);
  context.strokeStyle = '#ffd978';
  context.fillStyle = 'rgba(255,217,120,0.18)';
  context.lineWidth = 1.8;
  context.fillRect(-12, -6, 24, 12);
  context.strokeRect(-12, -6, 24, 12);
  context.beginPath();
  context.moveTo(-8, -6); context.lineTo(-8, 6);
  context.moveTo(8, -6); context.lineTo(8, 6);
  context.moveTo(0, -6); context.lineTo(0, 6);
  context.stroke();
  context.restore();
}

function defenseColor(type) {
  if (type === 'mortar') return '#ffbc73';
  if (type === 'relay') return '#68ffd4';
  if (type === 'survey') return '#ffd166';
  if (type === 'medical') return '#ff8fb3';
  if (type === 'fieldBarracks') return '#91f0b5';
  if (type === 'slow') return '#bb8cff';
  return '#65d7ff';
}

function drawDefense(context, point, type, quality, icon = '?') {
  const color = defenseColor(type);
  context.save();
  glow(context, color, 11, quality);
  ring(context, point, 9.5, color, 1.3, 0.72);
  context.fillStyle = color;
  context.font = '800 11px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(icon, point.x, point.y + 0.5);
  context.restore();
}

function drawEnemyBlip(context, point, radius, slowed, intensity, timeMs, quality = 'balanced') {
  const color = slowed ? '#bd86ff' : '#ff4e69';
  const pulse = radius + 2.5 + Math.sin(timeMs * 0.008 + point.x * 0.02) * 1.4;
  context.save();
  context.globalAlpha = 0.68 + intensity * 0.32;
  glow(context, color, 7 + intensity * 9, quality);
  context.fillStyle = color;
  context.beginPath();
  context.arc(point.x, point.y, Math.max(2.4, radius * 0.56), 0, TAU);
  context.fill();
  if (quality !== 'minimal') ring(context, point, pulse, color, 1, 0.24 + intensity * 0.46);
  context.restore();
}


function drawEnemyBlipBatch(context, entries, timeMs, quality) {
  if (!entries.length) return;
  const dense = entries.length > 180;
  const normal = [];
  const slowed = [];
  for (const entry of entries) (entry.enemy.slowTimer > 0 ? slowed : normal).push(entry);
  const pulseOffset = Math.sin(timeMs * 0.008) * 0.9;
  const drawGroup = (group, color) => {
    if (!group.length) return;
    context.save();
    context.globalAlpha = quality === 'minimal' ? 0.78 : 0.84;
    context.fillStyle = color;
    context.beginPath();
    for (const entry of group) {
      const radius = Math.max(2.2, (entry.enemy.radius ?? 5) * 0.52);
      context.moveTo(entry.point.x + radius, entry.point.y);
      context.arc(entry.point.x, entry.point.y, radius, 0, TAU);
    }
    context.fill();
    if (quality === 'balanced' && !dense) {
      context.globalAlpha = 0.28;
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.beginPath();
      for (const entry of group) {
        const radius = Math.max(4.4, (entry.enemy.radius ?? 5) + 2.1 + pulseOffset);
        context.moveTo(entry.point.x + radius, entry.point.y);
        context.arc(entry.point.x, entry.point.y, radius, 0, TAU);
      }
      context.stroke();
    }
    context.restore();
  };
  drawGroup(normal, '#ff4e69');
  drawGroup(slowed, '#bd86ff');
}


function drawFriendlySquad(context, point, status, type, timeMs, quality) {
  const definition = friendlySquadDefinition(type);
  const baseColors = { assault: '#65d7ff', skirmisher: '#62ffd2', siege: '#ffbd70', heavy: '#b9a4ff', expedition: '#f4f59a', retrieval: '#ffffff' };
  const baseColor = baseColors[definition.type] ?? '#65d7ff';
  const color = status === 'ENGAGED' || status === 'ATTACKING_BASE' ? '#fff3a1' : baseColor;
  const sides = definition.type === 'skirmisher' ? 3 : definition.type === 'heavy' ? 6 : definition.type === 'siege' ? 5 : definition.type === 'retrieval' ? 8 : 4;
  const pulse = 10 + Math.sin(timeMs * 0.006) * 1.2;
  context.save();
  glow(context, color, 13, quality);
  polygon(context, point, 6.5, sides, Math.PI / 4, 'rgba(101,215,255,0.2)', color, 1.5);
  ring(context, point, pulse, color, 1, 0.52, true);
  context.fillStyle = color;
  context.font = '800 7px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(({ assault: '◆', skirmisher: '△', siege: '⬟', heavy: '⬢', expedition: '◇', retrieval: '◎', engineer: '✚', artillery: '✦', command: '★' })[definition.type] ?? '◆', point.x, point.y + 0.5);
  context.restore();
}

function centralDisplay(state) {
  const level = Math.max(0, Math.min(MAX_CIVILIZATION_LEVEL, Math.floor(Number(state?.civilization?.level) || 0)));
  return { level, central: CIVILIZATIONS[level]?.central ?? CIVILIZATIONS[0].central };
}

function drawCity(context, point, timeMs, quality, display = { level: 0, central: '' }) {
  const pulse = 17 + Math.sin(timeMs * 0.0035) * 1.5;
  context.save();
  glow(context, '#8affdf', 18, quality);
  ring(context, point, pulse, '#8affdf', 1.4, 0.5, true);
  ring(context, point, 12.5, '#d5fff4', 2, 0.95);
  ring(context, point, 7.5, '#65ffd0', 1.2, 0.9);
  drawTicks(context, point, 13, '#9effe4');
  context.fillStyle = '#dffff7';
  context.font = '800 8px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const symbols = ['◎', '⌂', '▣', '⬟', '◆', '⬢', '✦', '★'];
  context.fillText(symbols[display.level] ?? '◎', point.x, point.y + 0.4);
  if (quality === 'full' && display.central) {
    context.font = '800 8px ui-monospace, monospace';
    context.fillStyle = '#e9fff8';
    context.shadowColor = 'rgba(101,255,208,0.65)';
    context.shadowBlur = 8;
    context.fillText(String(display.central).slice(0, 8), point.x, point.y - 20);
  }
  context.restore();
}


function drawFieldBase(context, point, active, timeMs, quality) {
  const color = active ? '#65d7ff' : '#7c8b91';
  const pulse = 11 + Math.sin(timeMs * 0.0038) * 1.1;
  context.save();
  glow(context, color, active ? 10 : 2, quality);
  polygon(context, point, 7, 4, Math.PI / 4, active ? 'rgba(101,215,255,0.14)' : 'rgba(100,112,118,0.16)', color, 1.3);
  ring(context, point, pulse, color, 1, active ? 0.42 : 0.24, true);
  context.fillStyle = color;
  context.font = '800 7px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(active ? '□' : '×', point.x, point.y + 0.4);
  context.restore();
}

function drawPlayerBase(context, point, timeMs, quality) {
  const pulse = 13 + Math.sin(timeMs * 0.0035) * 1.2;
  context.save();
  glow(context, '#65d7ff', 14, quality);
  polygon(context, point, 8.5, 6, Math.PI / 6, 'rgba(101,215,255,0.16)', '#65d7ff', 1.5);
  ring(context, point, pulse, '#65d7ff', 1, 0.45, true);
  context.fillStyle = '#d9f6ff';
  context.font = '800 7px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('⬢', point.x, point.y + 0.4);
  context.restore();
}


function visiblePoint(point, camera, margin = 28) {
  return point.x >= -margin && point.y >= -margin && point.x <= camera.viewportWidth + margin && point.y <= camera.viewportHeight + margin;
}

function visibleWorldBounds(camera, marginPixels = 36) {
  const scale = Math.max(0.001, camera.scale);
  const margin = marginPixels / scale;
  const halfWidth = camera.viewportWidth / (2 * scale);
  const halfHeight = camera.viewportHeight / (2 * scale);
  return {
    minX: camera.x - halfWidth - margin,
    minY: camera.y - halfHeight - margin,
    maxX: camera.x + halfWidth + margin,
    maxY: camera.y + halfHeight + margin
  };
}

function pointInWorldBounds(point, bounds) {
  return point
    && point.x >= bounds.minX
    && point.y >= bounds.minY
    && point.x <= bounds.maxX
    && point.y <= bounds.maxY;
}


function deterministicUnitOffset(id, index, count) {
  let hash = 2166136261;
  const text = `${id}:${index}:${count}`;
  for (const character of text) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const normalized = (hash >>> 0) / 4294967295;
  return normalized - 0.5;
}

function representativeEnemyPositions(enemy, position, edge, normal, tangent, quality) {
  const count = enemyUnitCount(enemy);
  const blips = enemyRepresentativeBlipCount(enemy, quality);
  if (blips <= 1 || !edge || !normal || !tangent) return [position];
  const length = Math.max(1, Number(edge.length) || 1);
  const spread = Math.min(34, Math.max(6, 4.5 + Math.sqrt(count) * 4.2));
  const laneSpread = Math.min(13, Math.max(3.5, 2.8 + Math.sqrt(count) * 1.15));
  const centeredIndex = (blips - 1) / 2;
  const positions = [];
  const a = Number(enemy.edgeProgress) || 0;
  const startProgress = Math.max(0, Math.min(length, a - spread * 0.45));
  for (let index = 0; index < blips; index += 1) {
    const t = blips === 1 ? 0.5 : index / (blips - 1);
    const progress = Math.max(0, Math.min(length, startProgress + t * spread));
    const alongDelta = progress - a;
    const lane = (index - centeredIndex) * Math.min(2.4, laneSpread / Math.max(1, blips - 1)) + deterministicUnitOffset(enemy.id, index, count) * 2.2;
    positions.push({
      x: position.x + tangent.x * alongDelta + normal.x * lane,
      y: position.y + tangent.y * alongDelta + normal.y * lane
    });
  }
  return positions;
}

function sampledEntries(entries, limit) {
  if (!Number.isFinite(limit) || entries.length <= limit) return entries;
  const sampled = [];
  const step = entries.length / limit;
  for (let index = 0; index < limit; index += 1) sampled.push(entries[Math.floor(index * step)]);
  return sampled;
}

function enemyDrawLimit(quality) {
  if (quality === 'full') return Infinity;
  if (quality === 'balanced') return 420;
  return 180;
}

function shouldDrawHealth(value, maximum, quality) {
  const ratio = value / Math.max(1, maximum);
  if (quality === 'full') return ratio < 1;
  if (quality === 'balanced') return ratio < 0.8;
  return ratio < 0.5;
}



function roadsideColor(item) {
  if (item?.kind === 'resource') return '#8dff99';
  if (item?.inventoryKey === 'sweepSignal') return '#ffef79';
  if (item?.inventoryKey === 'breachCharge') return '#ff8c5f';
  if (item?.inventoryKey === 'siegeCall') return '#ffbd70';
  if (item?.inventoryKey === 'skirmisherCall') return '#62ffd2';
  return '#65d7ff';
}

function drawRoadsideSupply(context, point, item, timeMs, quality) {
  const color = roadsideColor(item);
  const pulse = 10 + Math.sin(timeMs * 0.0055 + point.x * 0.01) * 1.4;
  context.save();
  glow(context, color, item?.rarity === 'epic' ? 18 : 12, quality);
  const sides = item?.kind === 'resource' ? 4 : item?.inventoryKey === 'breachCharge' ? 6 : 3;
  polygon(context, point, 5.8, sides, Math.PI / 4, 'rgba(101,255,208,0.16)', color, 1.35);
  if (quality !== 'minimal') ring(context, point, pulse, color, 1, item?.rarity === 'epic' ? 0.66 : 0.45, true);
  context.fillStyle = color;
  context.font = '800 7px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(item?.kind === 'resource' ? '◇' : '◈', point.x, point.y + 0.5);
  context.restore();
}

function drawRecoveryItem(context, point, timeMs, quality, status = RECOVERY_ITEM_STATUS.AVAILABLE) {
  const pulse = 11 + Math.sin(timeMs * 0.005) * 1.5;
  const palette = status === RECOVERY_ITEM_STATUS.RESERVED
    ? { color: '#6ee7ff', fill: 'rgba(110,231,255,0.18)', text: '…', glow: 12, dashed: true }
    : status === RECOVERY_ITEM_STATUS.CARRIED
      ? { color: '#65ffd0', fill: 'rgba(101,255,208,0.18)', text: '→', glow: 10, dashed: false }
      : { color: '#ffd166', fill: 'rgba(255,209,102,0.2)', text: '◇', glow: 16, dashed: true };
  context.save();
  glow(context, palette.color, palette.glow, quality);
  polygon(context, point, 6, 4, Math.PI / 4, palette.fill, palette.color, 1.5);
  ring(context, point, pulse, palette.color, 1, status === RECOVERY_ITEM_STATUS.RESERVED ? 0.72 : 0.55, palette.dashed);
  context.fillStyle = status === RECOVERY_ITEM_STATUS.RESERVED ? '#d8fbff' : status === RECOVERY_ITEM_STATUS.CARRIED ? '#d8fff4' : '#fff1bf';
  context.font = '800 7px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(palette.text, point.x, point.y + 0.5);
  context.restore();
}

function recoveryItemDisplayPoint(state, item) {
  if (item?.status === RECOVERY_ITEM_STATUS.CARRIED && item.assignedSquadId) {
    const carrier = (state.combat?.friendlySquads ?? []).find(squad => squad.id === item.assignedSquadId && squad.hp > 0);
    if (carrier) return friendlySquadPosition(state, carrier);
  }
  return recoveryItemPoint(state, item);
}

function drawPlayer(context, point, quality) {
  context.save();
  glow(context, '#f1fff9', 12, quality);
  polygon(context, point, 6.5, 3, -Math.PI / 2, 'rgba(241,255,249,0.18)', '#f1fff9', 1.5);
  ring(context, point, 10, '#65ffd0', 1, 0.5);
  context.restore();
}

export function drawCombatState(context, state, camera, radar = {}) {
  if (!state?.world?.city || !state.world.roadGraph?.nodeById) return;
  const graph = state.world.roadGraph;
  const timeMs = radar.timeMs ?? 0;
  const quality = radar.preferences?.quality ?? 'balanced';
  const worldBounds = visibleWorldBounds(camera);

  for (const base of state.world.enemyBases ?? []) {
    if (!base.alive) continue;
    const node = graph.nodeById.get(base.nodeId);
    if (!node) continue;
    const point = camera.worldToScreen(node);
    if (visiblePoint(point, camera)) {
      drawEnemyBase(context, point, timeMs, quality);
      if (shouldDrawHealth(base.hp, base.maxHp, quality)) drawHealthBar(context, point, base.hp, base.maxHp, 26, 15, quality);
    }
  }



  for (const defense of state.combat.defenses ?? []) {
    const runtime = defenseRuntimeDefinition(defense);
    if (defense.hp <= 0) continue;
    if (defense.kind === 'barrier') {
      const middle = defenseWorldPosition(graph, defense);
      if (!middle) continue;
      const point = camera.worldToScreen(middle);
      const edge = graph.edgeById.get(defense.edgeId);
      const a = edge && graph.nodeById.get(edge.a);
      const b = edge && graph.nodeById.get(edge.b);
      if (!a || !b || !visiblePoint(point, camera)) continue;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (defense.isGate) drawGate(context, point, angle, quality);
      else drawBarrier(context, point, angle, quality);
      if (shouldDrawHealth(defense.hp, defense.maxHp, quality)) drawHealthBar(context, point, defense.hp, defense.maxHp, 22, 9, quality);
      continue;
    }
    const node = graph.nodeById.get(defense.nodeId);
    if (!node) continue;
    const point = camera.worldToScreen(node);
    if (!visiblePoint(point, camera)) continue;
    drawDefense(context, point, defense.type, quality, runtime.icon ?? '?');
    if (shouldDrawHealth(defense.hp, defense.maxHp, quality)) drawHealthBar(context, point, defense.hp, defense.maxHp, 20, 11, quality);
  }

  for (const item of state.world.recoveryItems ?? []) {
    if (!isRecoveryItemVisible(item)) continue;
    const itemPosition = recoveryItemDisplayPoint(state, item);
    const point = camera.worldToScreen(itemPosition);
    if (visiblePoint(point, camera, 24)) drawRecoveryItem(context, point, timeMs, quality, item.status);
  }

  for (const mine of state.world.roadsideSupplies?.placedMines ?? []) {
    const point = camera.worldToScreen(mine);
    if (visiblePoint(point, camera, 24)) drawRoadsideSupply(context, point, { kind: 'tactical', inventoryKey: mine.itemKey ?? 'roadMine', rarity: mine.itemKey === 'armorBreakerMine' ? 'legendary' : mine.itemKey === 'directionalMine' ? 'epic' : 'rare' }, timeMs, quality);
  }

  for (const supply of state.world.roadsideSupplies?.active ?? []) {
    const supplyPosition = roadsideSupplyPoint(state, supply);
    if (!supplyPosition) continue;
    const point = camera.worldToScreen(supplyPosition);
    if (visiblePoint(point, camera, 24)) drawRoadsideSupply(context, point, supply, timeMs, quality);
  }

  for (const squad of state.combat.friendlySquads ?? []) {
    if (squad.hp <= 0 || ['RECOVERING', 'READY'].includes(squad.status)) continue;
    const point = camera.worldToScreen(friendlySquadPosition(state, squad));
    if (!visiblePoint(point, camera, 24)) continue;
    drawFriendlySquad(context, point, squad.status, squad.type, timeMs, quality);
    if (shouldDrawHealth(squad.hp, squad.maxHp, quality)) drawHealthBar(context, point, squad.hp, squad.maxHp, 22, 10, quality);
  }

  const edgeEnemyIndices = new Map();
  const edgeNormals = new Map();
  const edgeTangents = new Map();
  const visibleEnemies = [];
  for (const enemy of state.combat.enemies ?? []) {
    if (enemy.hp <= 0 || enemy.departDelay > 0) continue;
    const position = enemyPosition(state, enemy);
    if (!pointInWorldBounds(position, worldBounds)) continue;
    let edge = null;
    let normal = null;
    if (enemy.edgeId) {
      edge = graph.edgeById.get(enemy.edgeId) ?? null;
      if (edge) {
        normal = edgeNormals.get(edge.id);
        let tangent = edgeTangents.get(edge.id);
        if (!normal || !tangent) {
          const a = graph.nodeById.get(edge.a);
          const b = graph.nodeById.get(edge.b);
          if (a && b) {
            const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
            tangent = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
            edgeNormals.set(edge.id, normal);
            edgeTangents.set(edge.id, tangent);
          }
        }
      }
    }
    const baseIndex = edgeEnemyIndices.get(enemy.edgeId ?? enemy.id) ?? 0;
    edgeEnemyIndices.set(enemy.edgeId ?? enemy.id, baseIndex + 1);
    const cohortLane = normal ? ((baseIndex % 5) - 2) * 1.8 : 0;
    const basePosition = normal ? { x: position.x + normal.x * cohortLane, y: position.y + normal.y * cohortLane } : position;
    const tangent = enemy.edgeId ? edgeTangents.get(enemy.edgeId) : null;
    for (const renderPosition of representativeEnemyPositions(enemy, basePosition, edge, normal, tangent, quality)) {
      const point = camera.worldToScreen(renderPosition);
      if (visiblePoint(point, camera, 20)) visibleEnemies.push({ enemy, point });
    }
  }
  const drawnEnemies = sampledEntries(visibleEnemies, enemyDrawLimit(quality));

  if (quality === 'full') {
    for (const entry of drawnEnemies) {
      const intensity = radar.center ? sweepIntensity(entry.point, radar.center, radar.sweepAngle ?? 0) : 0;
      drawEnemyBlip(context, entry.point, entry.enemy.radius ?? 5, entry.enemy.slowTimer > 0, intensity, timeMs, quality);
    }
  } else {
    drawEnemyBlipBatch(context, drawnEnemies, timeMs, quality);
  }

  if (quality === 'full') {
    for (const entry of drawnEnemies) {
      if (shouldDrawHealth(entry.enemy.hp, entry.enemy.maxHp, quality)) {
        drawHealthBar(context, entry.point, entry.enemy.hp, entry.enemy.maxHp, 16, 8, quality);
      }
    }
  } else if (quality === 'balanced') {
    const healthLimit = visibleEnemies.length > 180 ? 12 : 20;
    const damaged = [];
    for (const entry of drawnEnemies) {
      if (!shouldDrawHealth(entry.enemy.hp, entry.enemy.maxHp, quality)) continue;
      const ratio = entry.enemy.hp / Math.max(1, entry.enemy.maxHp);
      let insertAt = damaged.findIndex(item => ratio < item.ratio);
      if (insertAt < 0) insertAt = damaged.length;
      if (insertAt < healthLimit) damaged.splice(insertAt, 0, { entry, ratio });
      if (damaged.length > healthLimit) damaged.pop();
    }
    for (const item of damaged) {
      const entry = item.entry;
      drawHealthBar(context, entry.point, entry.enemy.hp, entry.enemy.maxHp, 16, 8, quality);
    }
  }

  for (const base of state.world.playerBases ?? []) {
    if (base.primary) continue;
    const node = graph.nodeById.get(base.nodeId) ?? base;
    const point = camera.worldToScreen(node);
    if (!visiblePoint(point, camera, 32)) continue;
    const active = base.status === 'ESTABLISHED' && base.hp > 0;
    if (active) drawPlayerBase(context, point, timeMs, quality);
    else drawFieldBase(context, point, false, timeMs, quality);
    if (active && shouldDrawHealth(base.hp, base.maxHp, quality)) drawHealthBar(context, point, base.hp, base.maxHp, 24, 14, quality);
  }

  for (const base of state.world.fieldBases ?? []) {
    const node = graph.nodeById.get(base.nodeId) ?? base;
    const point = camera.worldToScreen(node);
    if (!visiblePoint(point, camera, 28)) continue;
    const active = base.status === 'ESTABLISHED' && base.hp > 0;
    drawFieldBase(context, point, active, timeMs, quality);
    if (active && shouldDrawHealth(base.hp, base.maxHp, quality)) drawHealthBar(context, point, base.hp, base.maxHp, 20, 12, quality);
  }

  const cityNode = graph.nodeById.get(state.world.city.nodeId);
  if (cityNode) {
    const point = camera.worldToScreen(cityNode);
    if (visiblePoint(point, camera, 40)) {
      drawCity(context, point, timeMs, quality, centralDisplay(state));
      if (shouldDrawHealth(state.world.city.hp, state.world.city.maxHp, quality)) drawHealthBar(context, point, state.world.city.hp, state.world.city.maxHp, 30, 17, quality);
    }
  }

  if (state.player.worldPosition) { const point = camera.worldToScreen(state.player.worldPosition); if (visiblePoint(point, camera)) drawPlayer(context, point, quality); }
}
