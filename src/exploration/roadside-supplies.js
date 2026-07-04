import { RESOURCE_LABELS, RESOURCE_KEYS, applyCivilizationEfficiencyBonusToBundle } from '../civilization/data.js';
import { addBundle, bundleText, consumeBundle, hasBundle, missingBundle } from '../civilization/inventory-system.js';
import { distance, distanceSquared, stableId, worldNow } from '../core/utilities.js';
import { chunkForWorldPoint, neighboringChunks } from '../roads/world-chunk-grid.js';
import { findFriendlyRoadPath } from '../combat/routing-system.js';
import { emergencyWithdrawFriendlySquadById, emergencyWithdrawFriendlySquadNear, boostFriendlySquadById, boostFriendlySquadsNear } from '../combat/friendly-force-system.js';
import { damageEnemy, enemyPosition } from '../combat/enemy-system.js';
import { destroyEnemyBase } from '../combat/enemy-base-system.js';
import { friendlySquadRuntimeDefinition, friendlySquadUnlocked } from '../combat/friendly-force-definitions.js';
import { activePlayerBases } from '../base/player-bases.js';
import { defenseWorldPosition } from '../combat/combat-geometry.js';

export const ROADSIDE_SUPPLY_VERSION = 2;
export const ROADSIDE_SUPPLY_COLLECT_RANGE_METERS = 35;
export const ROADSIDE_SUPPLY_LOCATION_MAX_AGE_MS = 60_000;
export const ROADSIDE_SUPPLY_MAX_ACCURACY_METERS = 100;
export const ROADSIDE_SUPPLY_REFRESH_SECONDS = 10;
export const ROADSIDE_SUPPLY_ACTIVE_LIMIT = 32;
export const ROADSIDE_SUPPLY_REFRESH_MOVE_METERS = 45;
export const ROADSIDE_SUPPLY_COLLECT_CHECK_SECONDS = 0.75;
export const ROADSIDE_MINE_CHECK_SECONDS = 0.75;

export const ROADSIDE_INVENTORY_KEYS = Object.freeze({
  assaultCall: 'assaultCall',
  skirmisherCall: 'skirmisherCall',
  siegeCall: 'siegeCall',
  sweepSignal: 'sweepSignal',
  breachCharge: 'breachCharge',
  roadMine: 'roadMine',
  lureSignal: 'lureSignal',
  marchBanner: 'marchBanner',
  smokeScreen: 'smokeScreen',
  directionalMine: 'directionalMine',
  armorBreakerMine: 'armorBreakerMine',
  remoteBarrage: 'remoteBarrage',
  airSupport: 'airSupport',
  areaSuppression: 'areaSuppression'
});

export const ROADSIDE_USE_DEFINITIONS = Object.freeze({
  assaultCall: Object.freeze({ name: '突撃出撃札', squadType: 'assault', targetKind: 'enemyBase', searchRangeMeters: 850 }),
  skirmisherCall: Object.freeze({ name: '遊撃出撃札', squadType: 'skirmisher', targetKind: 'enemy', searchRangeMeters: 650 }),
  siegeCall: Object.freeze({ name: '攻城出撃札', squadType: 'siege', targetKind: 'enemyBase', searchRangeMeters: 700 }),
  sweepSignal: Object.freeze({ name: '掃討信号弾', radiusMeters: 70 }),
  breachCharge: Object.freeze({ name: '破城爆薬', radiusMeters: 45 }),
  roadMine: Object.freeze({ name: '路上地雷', radiusMeters: 34, triggerRadiusMeters: 22, maxPlaced: 3, mineType: 'roadMine' }),
  lureSignal: Object.freeze({ name: '誘導信号弾', radiusMeters: 220, durationSeconds: 75 }),
  marchBanner: Object.freeze({ name: '行軍加速旗', radiusMeters: 120, durationSeconds: 120, speedMultiplier: 0.20 }),
  smokeScreen: Object.freeze({ name: '緊急撤退煙幕', radiusMeters: 120 }),
  directionalMine: Object.freeze({ name: '指向性地雷', radiusMeters: 28, triggerRadiusMeters: 18, maxPlaced: 5, mineType: 'directionalMine' }),
  armorBreakerMine: Object.freeze({ name: '重装破砕地雷', radiusMeters: 42, triggerRadiusMeters: 24, maxPlaced: 2, mineType: 'armorBreakerMine' }),
  remoteBarrage: Object.freeze({ name: '遠隔砲撃', radiusMeters: 95, baseDamageRatio: 0.32 }),
  airSupport: Object.freeze({ name: '航空支援', radiusMeters: 150, baseDamageRatio: 0.68 }),
  areaSuppression: Object.freeze({ name: '広域制圧支援', radiusMeters: 190, baseDamageRatio: 0.20 })
});

export const RESOURCE_TIERS = Object.freeze([
  Object.freeze({ minLevel: 0, rarity: 'common', supplies: [
    Object.freeze({ type: 'wood_crate', name: '木材箱', bundle: { wood: 28 } }),
    Object.freeze({ type: 'stone_sack', name: '石材袋', bundle: { stone: 24 } }),
    Object.freeze({ type: 'fiber_bundle', name: '繊維束', bundle: { fiber: 22 } })
  ] }),
  Object.freeze({ minLevel: 1, rarity: 'uncommon', supplies: [
    Object.freeze({ type: 'timber_box', name: '加工木材箱', bundle: { timber: 3 } }),
    Object.freeze({ type: 'rope_bundle', name: '縄束', bundle: { rope: 3 } }),
    Object.freeze({ type: 'cutstone_box', name: '切石箱', bundle: { cutStone: 3 } }),
    Object.freeze({ type: 'charcoal_bag', name: '木炭袋', bundle: { charcoal: 6 } })
  ] }),
  Object.freeze({ minLevel: 2, rarity: 'rare', supplies: [
    Object.freeze({ type: 'copper_ore_box', name: '銅鉱石箱', bundle: { copperOre: 4 } }),
    Object.freeze({ type: 'tin_ore_box', name: '錫鉱石箱', bundle: { tinOre: 3 } })
  ] }),
  Object.freeze({ minLevel: 3, rarity: 'rare', supplies: [
    Object.freeze({ type: 'iron_ore_box', name: '鉄鉱石箱', bundle: { ironOre: 3 } }),
    Object.freeze({ type: 'bronze_box', name: '青銅塊箱', bundle: { bronzeIngot: 1 } })
  ] }),
  Object.freeze({ minLevel: 4, rarity: 'epic', supplies: [Object.freeze({ type: 'wrought_iron_box', name: '鍛鉄箱', bundle: { wroughtIron: 1 } })] }),
  Object.freeze({ minLevel: 5, rarity: 'epic', supplies: [Object.freeze({ type: 'steel_box', name: '鋼材箱', bundle: { steel: 1 } })] }),
  Object.freeze({ minLevel: 6, rarity: 'epic', supplies: [Object.freeze({ type: 'mechanism_box', name: '機構部品箱', bundle: { mechanism: 1 } })] })
]);

const TACTICAL_SUPPLIES = Object.freeze([
  Object.freeze({ minLevel: 0, rollMin: 0.935, inventoryKey: 'assaultCall', name: '突撃出撃札', rarity: 'uncommon' }),
  Object.freeze({ minLevel: 1, rollMin: 0.956, inventoryKey: 'skirmisherCall', name: '遊撃出撃札', rarity: 'rare' }),
  Object.freeze({ minLevel: 1, rollMin: 0.968, inventoryKey: 'marchBanner', name: '行軍加速旗', rarity: 'rare' }),
  Object.freeze({ minLevel: 2, rollMin: 0.973, inventoryKey: 'sweepSignal', name: '掃討信号弾', rarity: 'rare' }),
  Object.freeze({ minLevel: 2, rollMin: 0.980, inventoryKey: 'roadMine', name: '路上地雷', rarity: 'rare' }),
  Object.freeze({ minLevel: 2, rollMin: 0.985, inventoryKey: 'siegeCall', name: '攻城出撃札', rarity: 'epic' }),
  Object.freeze({ minLevel: 3, rollMin: 0.990, inventoryKey: 'lureSignal', name: '誘導信号弾', rarity: 'epic' }),
  Object.freeze({ minLevel: 3, rollMin: 0.993, inventoryKey: 'smokeScreen', name: '緊急撤退煙幕', rarity: 'epic' }),
  Object.freeze({ minLevel: 3, rollMin: 0.996, inventoryKey: 'breachCharge', name: '破城爆薬', rarity: 'epic' })
]);


export const TACTICAL_MATERIAL_KEYS = Object.freeze({
  reinforcedFuse: 'reinforcedFuse',
  guidanceBeacon: 'guidanceBeacon',
  denseFiber: 'denseFiber',
  compressedChargeCore: 'compressedChargeCore',
  precisionSight: 'precisionSight',
  tacticalRadio: 'tacticalRadio',
  airSupportCode: 'airSupportCode',
  areaSuppressionOrder: 'areaSuppressionOrder',
  strategicMarker: 'strategicMarker'
});

export const TACTICAL_MATERIAL_DEFINITIONS = Object.freeze({
  reinforcedFuse: Object.freeze({ name: '強化信管', rarity: 'rare' }),
  guidanceBeacon: Object.freeze({ name: '誘導ビーコン', rarity: 'rare' }),
  denseFiber: Object.freeze({ name: '高密度繊維束', rarity: 'rare' }),
  compressedChargeCore: Object.freeze({ name: '圧縮爆薬芯', rarity: 'epic' }),
  precisionSight: Object.freeze({ name: '精密照準器', rarity: 'epic' }),
  tacticalRadio: Object.freeze({ name: '戦術通信器', rarity: 'epic' }),
  airSupportCode: Object.freeze({ name: '航空支援コード', rarity: 'legendary' }),
  areaSuppressionOrder: Object.freeze({ name: '広域制圧指令', rarity: 'legendary' }),
  strategicMarker: Object.freeze({ name: '戦略爆撃標識', rarity: 'legendary' })
});

const TACTICAL_MATERIAL_SUPPLIES = Object.freeze([
  Object.freeze({ minLevel: 3, rollMin: 0.9750, materialKey: 'reinforcedFuse' }),
  Object.freeze({ minLevel: 3, rollMin: 0.9820, materialKey: 'guidanceBeacon' }),
  Object.freeze({ minLevel: 4, rollMin: 0.9880, materialKey: 'denseFiber' }),
  Object.freeze({ minLevel: 5, rollMin: 0.9920, materialKey: 'compressedChargeCore' }),
  Object.freeze({ minLevel: 5, rollMin: 0.9950, materialKey: 'precisionSight' }),
  Object.freeze({ minLevel: 6, rollMin: 0.9970, materialKey: 'tacticalRadio' }),
  Object.freeze({ minLevel: 7, rollMin: 0.9975, materialKey: 'airSupportCode' }),
  Object.freeze({ minLevel: 7, rollMin: 0.9982, materialKey: 'areaSuppressionOrder' }),
  Object.freeze({ minLevel: 7, rollMin: 0.9989, materialKey: 'strategicMarker' })
]);

export const TACTICAL_WORKSHOP_BUILDING = 'tacticalWorkshop';
export const TACTICAL_RECIPES = Object.freeze({
  roadMine: Object.freeze({ name: '路上地雷', level: 4, outputKey: 'roadMine', resources: { wroughtIron: 1, charcoal: 8, rope: 2 }, materials: { reinforcedFuse: 1 } }),
  lureSignal: Object.freeze({ name: '誘導信号弾', level: 4, outputKey: 'lureSignal', resources: { copperIngot: 2, charcoal: 6, rope: 2 }, materials: { guidanceBeacon: 1 } }),
  marchBanner: Object.freeze({ name: '行軍加速旗', level: 4, outputKey: 'marchBanner', resources: { timber: 8, rope: 6, bronzeIngot: 2 }, materials: { denseFiber: 1 } }),
  smokeScreen: Object.freeze({ name: '緊急撤退煙幕', level: 4, outputKey: 'smokeScreen', resources: { fiber: 60, charcoal: 10, rope: 4 }, materials: { denseFiber: 1 } }),
  directionalMine: Object.freeze({ name: '指向性地雷', level: 5, outputKey: 'directionalMine', resources: { steel: 4, wroughtIron: 4, charcoal: 18 }, materials: { reinforcedFuse: 1, compressedChargeCore: 1 } }),
  remoteBarrage: Object.freeze({ name: '遠隔砲撃', level: 5, outputKey: 'remoteBarrage', resources: { steel: 8, wroughtIron: 6, charcoal: 26 }, materials: { precisionSight: 1 } }),
  armorBreakerMine: Object.freeze({ name: '重装破砕地雷', level: 7, outputKey: 'armorBreakerMine', resources: { steel: 18, charcoal: 42, mechanism: 6 }, materials: { reinforcedFuse: 2, compressedChargeCore: 1 } }),
  areaSuppression: Object.freeze({ name: '広域制圧支援', level: 7, outputKey: 'areaSuppression', resources: { steel: 48, charcoal: 80, mechanism: 10 }, materials: { areaSuppressionOrder: 1, tacticalRadio: 1 } }),
  airSupport: Object.freeze({ name: '航空支援', level: 7, outputKey: 'airSupport', resources: { steel: 80, charcoal: 120, mechanism: 18 }, materials: { airSupportCode: 1, precisionSight: 1, strategicMarker: 1 } })
});

const RARITY_ORDER = Object.freeze({ common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 });
const DAY_MS = 86_400_000;

function hashUnit(...parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function positiveHash(...parts) {
  return Math.floor(hashUnit(...parts) * 0xffffffff) >>> 0;
}

function dailyEpoch(nowMs) {
  return Math.floor((Number(nowMs) || Date.now()) / DAY_MS);
}

function finitePoint(point) {
  return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
}

function sanitizeBundle(bundle) {
  const result = {};
  for (const [key, amount] of Object.entries(bundle ?? {})) {
    if (!RESOURCE_KEYS.includes(key)) continue;
    const value = Math.max(0, Math.floor(Number(amount) || 0));
    if (value > 0) result[key] = value;
  }
  return result;
}

function inventoryDefaults() {
  return Object.fromEntries(Object.values(ROADSIDE_INVENTORY_KEYS).map(key => [key, 0]));
}

function materialDefaults() {
  return Object.fromEntries(Object.values(TACTICAL_MATERIAL_KEYS).map(key => [key, 0]));
}

export function ensureRoadsideSupplyState(state) {
  state.world.roadsideSupplies = state.world.roadsideSupplies && typeof state.world.roadsideSupplies === 'object'
    ? state.world.roadsideSupplies
    : {};
  const supplies = state.world.roadsideSupplies;
  supplies.version = ROADSIDE_SUPPLY_VERSION;
  supplies.collectedIds = Array.isArray(supplies.collectedIds) ? supplies.collectedIds.map(String).slice(-2400) : [];
  supplies.active = Array.isArray(supplies.active) ? supplies.active.filter(item => item && item.id).slice(0, ROADSIDE_SUPPLY_ACTIVE_LIMIT) : [];
  supplies.lastRefreshPoint = finitePoint(supplies.lastRefreshPoint) ? { x: Number(supplies.lastRefreshPoint.x), y: Number(supplies.lastRefreshPoint.y) } : null;
  supplies.placedMines = Array.isArray(supplies.placedMines) ? supplies.placedMines.filter(item => item && item.id && finitePoint(item)).slice(-24) : [];
  supplies.inventory = { ...inventoryDefaults(), ...(supplies.inventory && typeof supplies.inventory === 'object' ? supplies.inventory : {}) };
  for (const key of Object.values(ROADSIDE_INVENTORY_KEYS)) supplies.inventory[key] = Math.max(0, Math.floor(Number(supplies.inventory[key]) || 0));
  supplies.materials = { ...materialDefaults(), ...(supplies.materials && typeof supplies.materials === 'object' ? supplies.materials : {}) };
  for (const key of Object.values(TACTICAL_MATERIAL_KEYS)) supplies.materials[key] = Math.max(0, Math.floor(Number(supplies.materials[key]) || 0));
  const epoch = String(dailyEpoch(worldNow(state)));
  supplies.daily = supplies.daily && typeof supplies.daily === 'object' ? supplies.daily : {};
  if (String(supplies.daily.epoch ?? '') !== epoch) {
    supplies.daily = { epoch, collectedCount: 0, rareCollectedCount: 0, generatedAt: 0 };
  }
  supplies.daily.collectedCount = Math.max(0, Math.floor(Number(supplies.daily.collectedCount) || 0));
  supplies.daily.rareCollectedCount = Math.max(0, Math.floor(Number(supplies.daily.rareCollectedCount) || 0));
  supplies.nextRefreshAt = Math.max(0, Number(supplies.nextRefreshAt) || 0);
  supplies.nextCollectionCheckAt = Math.max(0, Number(supplies.nextCollectionCheckAt) || 0);
  supplies.nextMineCheckAt = Math.max(0, Number(supplies.nextMineCheckAt) || 0);
  return supplies;
}

export function roadsideSupplyPoint(_state, item) {
  if (finitePoint(item)) return { x: Number(item.x), y: Number(item.y) };
  return null;
}

export function roadsideSupplyPresentation(item) {
  if (!item) return { name: '補給物資', summary: '', kind: 'unknown' };
  if (item.kind === 'resource') {
    return { name: item.name ?? '資源箱', summary: bundleText(item.bundle ?? {}), kind: item.kind, rarity: item.rarity ?? 'common' };
  }
  if (item.kind === 'material') {
    const material = TACTICAL_MATERIAL_DEFINITIONS[item.materialKey] ?? null;
    return { name: item.name ?? material?.name ?? '戦術素材', summary: '戦術工房の製作素材', kind: item.kind, rarity: item.rarity ?? material?.rarity ?? 'rare' };
  }
  const use = ROADSIDE_USE_DEFINITIONS[item.inventoryKey] ?? null;
  return { name: item.name ?? use?.name ?? '現地装備', summary: '消耗品インベントリへ追加', kind: item.kind, rarity: item.rarity ?? 'uncommon' };
}

function locationEligibility(state, { strict = false } = {}) {
  const player = state.player?.worldPosition;
  if (!finitePoint(player)) return { ok: false, reasonKey: 'reason.location.currentRequired', reason: '現在地を取得してください。' };
  const updatedAt = Number(state.player?.locationUpdatedAt) || 0;
  const now = worldNow(state);
  if (!updatedAt || now - updatedAt > ROADSIDE_SUPPLY_LOCATION_MAX_AGE_MS) return { ok: false, reasonKey: 'reason.location.useStale', reason: '位置情報が古いため使用できません。現在地を再取得してください。' };
  const accuracy = Number(state.player?.locationAccuracy);
  const maxAccuracy = strict ? 70 : ROADSIDE_SUPPLY_MAX_ACCURACY_METERS;
  if (Number.isFinite(accuracy) && accuracy > maxAccuracy) return { ok: false, reasonKey: 'reason.location.accuracyLow', reason: '位置情報の精度が不足しています。' };
  return { ok: true, player };
}

function nearestNode(state, point) {
  let best = null;
  for (const node of state.world?.roadGraph?.nodes ?? []) {
    const d2 = distanceSquared(node, point);
    if (!best || d2 < best.d2) best = { node, d2 };
  }
  return best?.node ?? null;
}

function resourceDefinitionForRoll(level, roll, seedParts) {
  const tiers = RESOURCE_TIERS.filter(tier => level >= tier.minLevel);
  const highTierBias = Math.min(0.28, level * 0.035);
  let pool = tiers[0]?.supplies ?? [];
  let rarity = tiers[0]?.rarity ?? 'common';
  if (tiers.length > 1 && roll > 0.74 - highTierBias) {
    const unlocked = tiers.slice(1);
    const tier = unlocked[Math.min(unlocked.length - 1, Math.floor(hashUnit(...seedParts, 'tier') * unlocked.length))];
    pool = tier.supplies;
    rarity = tier.rarity;
  }
  const selected = pool[Math.min(pool.length - 1, Math.floor(hashUnit(...seedParts, 'resource') * pool.length))];
  return { ...selected, bundle: sanitizeBundle(selected.bundle), rarity };
}

function tacticalDefinitionForRoll(level, roll) {
  return [...TACTICAL_SUPPLIES]
    .filter(item => level >= item.minLevel && roll >= item.rollMin)
    .sort((a, b) => b.rollMin - a.rollMin)[0] ?? null;
}

function materialDefinitionForRoll(level, roll) {
  const materialSupply = [...TACTICAL_MATERIAL_SUPPLIES]
    .filter(item => level >= item.minLevel && roll >= item.rollMin)
    .sort((a, b) => b.rollMin - a.rollMin)[0] ?? null;
  if (!materialSupply) return null;
  const definition = TACTICAL_MATERIAL_DEFINITIONS[materialSupply.materialKey];
  return definition ? { ...materialSupply, ...definition } : null;
}

function supplyForEdge(state, edge, epoch, playerSeed) {
  if (!edge?.id || Number(edge.length) < 35) return null;
  const level = Math.max(0, Math.floor(Number(state.civilization?.level) || 0));
  const graph = state.world.roadGraph;
  const a = graph.nodeById?.get(edge.a);
  const b = graph.nodeById?.get(edge.b);
  if (!a || !b) return null;
  const edgeGeoKey = stableId(
    'roadside-edge',
    edge.id,
    edge.chunkIds?.join(',') ?? '',
    Math.round(a.x), Math.round(a.y),
    Math.round(b.x), Math.round(b.y)
  );
  const baseRoll = hashUnit('roadside', ROADSIDE_SUPPLY_VERSION, playerSeed, epoch, edgeGeoKey);
  const spawnThreshold = 0.78 - Math.min(0.10, level * 0.010);
  if (baseRoll < spawnThreshold) return null;
  const progress = 0.14 + hashUnit(edgeGeoKey, epoch, playerSeed, 'progress') * 0.72;
  const x = a.x + (b.x - a.x) * progress;
  const y = a.y + (b.y - a.y) * progress;
  const roll = hashUnit(edgeGeoKey, epoch, playerSeed, 'kind');
  const material = materialDefinitionForRoll(level, roll);
  const tactical = material ? null : tacticalDefinitionForRoll(level, roll);
  const idSeed = [edgeGeoKey, epoch, playerSeed, material?.materialKey ?? tactical?.inventoryKey ?? 'resource'];
  if (material) {
    return {
      id: stableId('roadside', ...idSeed),
      kind: 'material', type: material.materialKey, materialKey: material.materialKey,
      name: material.name, rarity: material.rarity, x, y, edgeId: edge.id, edgeProgress: progress
    };
  }
  if (tactical) {
    return {
      id: stableId('roadside', ...idSeed),
      kind: 'tactical', type: tactical.inventoryKey, inventoryKey: tactical.inventoryKey,
      name: tactical.name, rarity: tactical.rarity, x, y, edgeId: edge.id, edgeProgress: progress
    };
  }
  const resource = resourceDefinitionForRoll(level, roll, idSeed);
  return {
    id: stableId('roadside', ...idSeed),
    kind: 'resource', type: resource.type, name: resource.name, rarity: resource.rarity,
    bundle: resource.bundle, x, y, edgeId: edge.id, edgeProgress: progress
  };
}

function candidateEdgesNearPlayer(state, player) {
  const graph = state.world?.roadGraph;
  if (!graph?.edges?.length || !graph.nodeById) return [];
  const current = chunkForWorldPoint(player);
  const chunkIds = new Set(neighboringChunks(current, 2).map(chunk => chunk.id));
  const edges = [];
  for (const edge of graph.edges) {
    if (Array.isArray(edge.chunkIds) && !edge.chunkIds.some(id => chunkIds.has(String(id)))) continue;
    const a = graph.nodeById.get(edge.a);
    const b = graph.nodeById.get(edge.b);
    if (!a || !b) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (distanceSquared(mid, player) > 1300 * 1300) continue;
    edges.push(edge);
  }
  return edges;
}

function roadsideSector(item, player) {
  const angle = Math.atan2(Number(item.y) - Number(player.y), Number(item.x) - Number(player.x));
  return Math.floor((((angle + Math.PI) / (Math.PI * 2)) * 8) % 8);
}

function spacingForRoadsideItem(item, relaxed = false) {
  const rare = (RARITY_ORDER[item?.rarity] ?? 1) >= RARITY_ORDER.rare;
  if (relaxed) return rare ? 90 : 54;
  return rare ? 120 : 70;
}

function tooCloseToSelectedRoadsideItem(item, selected, relaxed = false) {
  const spacing = spacingForRoadsideItem(item, relaxed);
  const spacing2 = spacing * spacing;
  return selected.some(other => distanceSquared(item, other) < spacing2);
}

function selectDistributedRoadsideSupplies(candidates, player, limit = ROADSIDE_SUPPLY_ACTIVE_LIMIT) {
  const bands = [
    { min: 0, max: 260, limit: 6 },
    { min: 260, max: 680, limit: 12 },
    { min: 680, max: 1150, limit: Math.max(0, limit - 18) }
  ];
  const prepared = candidates.map(item => ({
    item,
    d2: distanceSquared(item, player),
    sector: roadsideSector(item, player),
    rarity: RARITY_ORDER[item.rarity] ?? 1
  })).sort((a, b) => a.d2 - b.d2 || b.rarity - a.rarity || a.item.id.localeCompare(b.item.id));
  const selected = [];
  const sectorCounts = new Map();
  const highValueLimit = Math.min(6, Math.max(2, Math.floor(limit * 0.18)));
  for (const entry of prepared
    .filter(item => item.rarity >= RARITY_ORDER.epic)
    .sort((a, b) => b.rarity - a.rarity || a.d2 - b.d2 || a.item.id.localeCompare(b.item.id))) {
    if (selected.length >= highValueLimit) break;
    const sectorCount = sectorCounts.get(entry.sector) ?? 0;
    if (sectorCount >= 2) continue;
    if (tooCloseToSelectedRoadsideItem(entry.item, selected, true)) continue;
    entry.selected = true;
    selected.push(entry.item);
    sectorCounts.set(entry.sector, sectorCount + 1);
  }
  const takeFromBand = (band, relaxed = false) => {
    let used = 0;
    const bandMin2 = band.min * band.min;
    const bandMax2 = band.max * band.max;
    const pool = prepared
      .filter(entry => !entry.selected && entry.d2 >= bandMin2 && entry.d2 < bandMax2)
      .sort((a, b) => (sectorCounts.get(a.sector) ?? 0) - (sectorCounts.get(b.sector) ?? 0)
        || a.d2 - b.d2
        || b.rarity - a.rarity
        || a.item.id.localeCompare(b.item.id));
    for (const entry of pool) {
      if (selected.length >= limit || used >= band.limit) break;
      const sectorCount = sectorCounts.get(entry.sector) ?? 0;
      if (!relaxed && sectorCount >= 5) continue;
      if (tooCloseToSelectedRoadsideItem(entry.item, selected, relaxed)) continue;
      entry.selected = true;
      selected.push(entry.item);
      sectorCounts.set(entry.sector, sectorCount + 1);
      used += 1;
    }
  };
  for (const band of bands) takeFromBand(band, false);
  for (const band of bands) {
    if (selected.length >= limit) break;
    takeFromBand({ ...band, limit: Math.max(0, band.limit - selected.length) + limit }, true);
  }
  if (selected.length < limit) {
    for (const entry of prepared) {
      if (selected.length >= limit) break;
      if (entry.selected) continue;
      entry.selected = true;
      selected.push(entry.item);
    }
  }
  return selected.slice(0, limit);
}

function needsRoadsideRefresh(supplies, player, nowMs, force) {
  if (force || !Array.isArray(supplies.active) || supplies.active.length === 0) return true;
  const last = supplies.lastRefreshPoint;
  const movedFar = !finitePoint(last) || distanceSquared(last, player) >= ROADSIDE_SUPPLY_REFRESH_MOVE_METERS ** 2;
  return movedFar || nowMs >= supplies.nextRefreshAt;
}

export function refreshRoadsideSupplies(state, force = false) {
  const supplies = ensureRoadsideSupplyState(state);
  const player = state.player?.worldPosition;
  const nowMs = worldNow(state);
  if (!finitePoint(player) || !state.world?.roadGraph?.nodeById) {
    supplies.active = [];
    supplies.lastRefreshPoint = null;
    supplies.nextRefreshAt = nowMs + ROADSIDE_SUPPLY_REFRESH_SECONDS * 1000;
    return supplies.active;
  }
  if (!needsRoadsideRefresh(supplies, player, nowMs, force)) return supplies.active;
  supplies.nextRefreshAt = nowMs + ROADSIDE_SUPPLY_REFRESH_SECONDS * 1000;
  supplies.lastRefreshPoint = { x: Number(player.x), y: Number(player.y) };
  const epoch = dailyEpoch(nowMs);
  const playerSeed = state.world?.homeBase?.id ?? `${Math.round(state.world.roadGraph.center?.lat ?? 0)}:${Math.round(state.world.roadGraph.center?.lon ?? 0)}`;
  const collected = new Set(supplies.collectedIds);
  const candidates = [];
  for (const edge of candidateEdgesNearPlayer(state, player)) {
    const item = supplyForEdge(state, edge, epoch, playerSeed);
    if (!item || collected.has(item.id)) continue;
    if (distanceSquared(item, player) > 1150 * 1150) continue;
    candidates.push(item);
  }
  supplies.active = selectDistributedRoadsideSupplies(candidates, player, ROADSIDE_SUPPLY_ACTIVE_LIMIT);
  supplies.daily.generatedAt = nowMs;
  return supplies.active;
}

function rememberCollected(supplies, item) {
  supplies.collectedIds.push(String(item.id));
  if (supplies.collectedIds.length > 2400) supplies.collectedIds = supplies.collectedIds.slice(-2000);
  supplies.daily.collectedCount += 1;
  if ((RARITY_ORDER[item.rarity] ?? 1) >= RARITY_ORDER.rare) supplies.daily.rareCollectedCount += 1;
  supplies.active = supplies.active.filter(value => value.id !== item.id);
}

export function collectRoadsideSupply(state, item, events = null) {
  const supplies = ensureRoadsideSupplyState(state);
  if (!item || supplies.collectedIds.includes(String(item.id))) return { ok: false, reasonKey: 'reason.roadside.alreadyCollected', reason: '既に回収済みです。' };
  rememberCollected(supplies, item);
  if (item.kind === 'resource') {
    const bundle = applyCivilizationEfficiencyBonusToBundle(sanitizeBundle(item.bundle), state.civilization?.level ?? 0);
    addBundle(state, bundle);
    events?.emit('exploration:roadside-supply-collected', { item, bundle });
    events?.emit('message', { key: 'roadside.notice.resourceCollected', params: { itemName: item.name ?? '資源箱', resourceText: { __resourceBundle: true, bundle } }, text: `${item.name ?? '資源箱'}を回収しました。資源：${bundleText(bundle)}。` });
    return { ok: true, item, bundle };
  }
  if (item.kind === 'material' && TACTICAL_MATERIAL_DEFINITIONS[item.materialKey]) {
    supplies.materials[item.materialKey] = (supplies.materials[item.materialKey] ?? 0) + 1;
    events?.emit('exploration:roadside-supply-collected', { item, materialKey: item.materialKey });
    events?.emit('message', { key: 'roadside.notice.materialCollected', params: { itemName: item.name ?? TACTICAL_MATERIAL_DEFINITIONS[item.materialKey].name }, text: `${item.name ?? TACTICAL_MATERIAL_DEFINITIONS[item.materialKey].name}を取得しました。戦術工房で使用できます。` });
    return { ok: true, item, materialKey: item.materialKey };
  }
  if (item.kind === 'tactical' && ROADSIDE_USE_DEFINITIONS[item.inventoryKey]) {
    supplies.inventory[item.inventoryKey] = (supplies.inventory[item.inventoryKey] ?? 0) + 1;
    events?.emit('exploration:roadside-supply-collected', { item, inventoryKey: item.inventoryKey });
    events?.emit('message', { key: 'roadside.notice.tacticalCollected', params: { itemName: item.name ?? ROADSIDE_USE_DEFINITIONS[item.inventoryKey].name }, text: `${item.name ?? ROADSIDE_USE_DEFINITIONS[item.inventoryKey].name}を取得しました。ITEMSから使用できます。` });
    return { ok: true, item, inventoryKey: item.inventoryKey };
  }
  return { ok: false, reasonKey: 'reason.roadside.unsupportedSupply', reason: '未対応の道端物資です。' };
}

export function collectNearbyRoadsideSupplies(state, events = null) {
  const eligibility = locationEligibility(state);
  if (!eligibility.ok) return [];
  const supplies = ensureRoadsideSupplyState(state);
  const collected = [];
  for (const item of [...(supplies.active ?? [])]) {
    if (distance(eligibility.player, item) > ROADSIDE_SUPPLY_COLLECT_RANGE_METERS) continue;
    const result = collectRoadsideSupply(state, item, events);
    if (result.ok) collected.push(result);
  }
  return collected;
}

function consumeInventory(state, key) {
  const supplies = ensureRoadsideSupplyState(state);
  if ((supplies.inventory[key] ?? 0) <= 0) return false;
  supplies.inventory[key] -= 1;
  return true;
}

function refundInventory(state, key) {
  const supplies = ensureRoadsideSupplyState(state);
  supplies.inventory[key] = (supplies.inventory[key] ?? 0) + 1;
}


function hasTacticalWorkshop(state) {
  return (state.civilization?.buildings ?? []).some(building => building.type === TACTICAL_WORKSHOP_BUILDING && building.hp > 0);
}

function missingMaterials(state, materials = {}) {
  const supplies = ensureRoadsideSupplyState(state);
  const missing = {};
  for (const [key, amount] of Object.entries(materials ?? {})) {
    const gap = Math.max(0, Math.floor(Number(amount) || 0) - Math.max(0, Math.floor(Number(supplies.materials?.[key]) || 0)));
    if (gap > 0) missing[key] = gap;
  }
  return missing;
}

function hasMaterials(state, materials = {}) {
  return Object.keys(missingMaterials(state, materials)).length === 0;
}

function consumeMaterials(state, materials = {}) {
  if (!hasMaterials(state, materials)) return false;
  const supplies = ensureRoadsideSupplyState(state);
  for (const [key, amount] of Object.entries(materials ?? {})) supplies.materials[key] -= Math.max(0, Math.floor(Number(amount) || 0));
  return true;
}

export function tacticalRecipeStatus(state, recipeKey) {
  const recipe = TACTICAL_RECIPES[recipeKey];
  if (!recipe) return { ok: false, reasonKey: 'reason.roadside.unknownRecipe', reason: '不明な製作です。' };
  if ((state.civilization?.level ?? 0) < recipe.level) return { ok: false, reasonKey: 'reason.civilization.unlockLevel', reasonParams: { level: recipe.level }, reason: `文明Lv.${recipe.level}で解禁されます。`, recipe };
  if (!hasTacticalWorkshop(state)) return { ok: false, reasonKey: 'reason.roadside.workshopRequired', reason: '戦術工房が必要です。', recipe };
  const resourceMissing = missingBundle(state, recipe.resources);
  const materialMissing = missingMaterials(state, recipe.materials);
  if (Object.keys(resourceMissing).length || Object.keys(materialMissing).length) {
    return { ok: false, reasonKey: 'reason.roadside.craftShortage', reason: '製作素材が不足しています。', recipe, resourceMissing, materialMissing };
  }
  return { ok: true, recipe, resourceMissing: {}, materialMissing: {} };
}

export function craftTacticalItem(state, recipeKey, events = null) {
  const status = tacticalRecipeStatus(state, recipeKey);
  if (!status.ok) return status;
  const recipe = status.recipe;
  if (!consumeBundle(state, recipe.resources) || !consumeMaterials(state, recipe.materials)) return { ok: false, reasonKey: 'reason.roadside.craftShortage', reason: '製作素材が不足しています。', recipe };
  const supplies = ensureRoadsideSupplyState(state);
  supplies.inventory[recipe.outputKey] = (supplies.inventory[recipe.outputKey] ?? 0) + 1;
  events?.emit('exploration:tactical-crafted', { recipeKey, itemKey: recipe.outputKey });
  events?.emit('message', { key: 'roadside.notice.tacticalCrafted', params: { recipeName: recipe.name }, text: `戦術工房で${recipe.name}を製作しました。` });
  return { ok: true, recipe, itemKey: recipe.outputKey };
}

export function useSweepSignal(state, events = null) {
  const eligibility = locationEligibility(state, { strict: true });
  if (!eligibility.ok) return eligibility;
  if (!consumeInventory(state, 'sweepSignal')) return { ok: false, reasonKey: 'reason.roadside.noSweepSignal', reason: '掃討信号弾を所持していません。' };
  const radius = ROADSIDE_USE_DEFINITIONS.sweepSignal.radiusMeters;
  let killed = 0;
  for (const enemy of state.combat?.enemies ?? []) {
    if (enemy.hp <= 0 || enemy.departDelay > 0) continue;
    if (distanceSquared(enemyPosition(state, enemy), eligibility.player) > radius * radius) continue;
    if (damageEnemy(state, enemy, enemy.maxHp * 20 + 9999, events)) killed += 1;
  }
  state.combat.enemies = (state.combat.enemies ?? []).filter(enemy => enemy.hp > 0);
  events?.emit('exploration:roadside-item-used', { itemKey: 'sweepSignal', killed });
  events?.emit('message', killed > 0 ? { key: 'roadside.notice.sweepSignalKilled', params: { radius, count: killed }, text: `掃討信号弾で周囲${radius}mの敵${killed}体を排除しました。` } : { key: 'roadside.notice.sweepSignalNoTarget', params: { radius }, text: `掃討信号弾を使用しましたが、周囲${radius}mに対象はいませんでした。` });
  return { ok: true, killed };
}

export function useBreachCharge(state, events = null) {
  const eligibility = locationEligibility(state, { strict: true });
  if (!eligibility.ok) return eligibility;
  if (!consumeInventory(state, 'breachCharge')) return { ok: false, reasonKey: 'reason.roadside.noBreachCharge', reason: '破城爆薬を所持していません。' };
  const radius = ROADSIDE_USE_DEFINITIONS.breachCharge.radiusMeters;
  const graph = state.world?.roadGraph;
  const candidates = (state.world?.enemyBases ?? [])
    .filter(base => base.alive && base.hp > 0)
    .map(base => ({ base, point: graph?.nodeById?.get(base.nodeId) ?? base }))
    .filter(entry => finitePoint(entry.point) && distanceSquared(entry.point, eligibility.player) <= radius * radius)
    .sort((a, b) => distanceSquared(a.point, eligibility.player) - distanceSquared(b.point, eligibility.player));
  const target = candidates[0]?.base ?? null;
  if (!target) {
    refundInventory(state, 'breachCharge');
    return { ok: false, reasonKey: 'reason.roadside.noDestroyableEnemyBaseNearby', reasonParams: { radius }, reason: `半径${radius}m以内に破壊可能な敵拠点がありません。` };
  }
  target.hp = 0;
  destroyEnemyBase(state, target, events, { roadsideItem: 'breachCharge' });
  events?.emit('exploration:roadside-item-used', { itemKey: 'breachCharge', baseId: target.id });
  events?.emit('message', { key: 'roadside.notice.breachChargeDestroyed', params: { targetName: target.name ?? '敵拠点' }, text: `破城爆薬で${target.name ?? '敵拠点'}を破壊しました。` });
  return { ok: true, base: target };
}

function deploymentTargetName(target, kind) {
  if (kind === 'enemyBase') return target?.name ?? '敵拠点';
  if (kind === 'enemy') return target?.name ?? ROADSIDE_USE_DEFINITIONS[target?.type]?.name ?? '敵部隊';
  return '対象';
}

export function roadsideDeploymentTargets(state, key) {
  const definition = ROADSIDE_USE_DEFINITIONS[key];
  if (!definition?.squadType) return [];
  const eligibility = locationEligibility(state, { strict: true });
  if (!eligibility.ok) return [];
  const originNode = nearestNode(state, eligibility.player);
  if (!originNode) return [];
  const graph = state.world?.roadGraph;
  const rangeMeters = Math.max(1, Number(definition.searchRangeMeters) || 1);
  const radius2 = rangeMeters * rangeMeters;
  const targetKind = definition.targetKind === 'enemy' ? 'enemy' : 'enemyBase';
  const entries = targetKind === 'enemy'
    ? (state.combat?.enemies ?? [])
      .filter(enemy => enemy.hp > 0 && enemy.departDelay <= 0)
      .map(enemy => ({ kind: 'enemy', id: enemy.id, object: enemy, point: enemyPosition(state, enemy), nodeId: enemy.nodeId, hp: enemy.hp, maxHp: enemy.maxHp, label: enemy.type ?? '敵部隊' }))
    : (state.world?.enemyBases ?? [])
      .filter(base => base.alive && base.hp > 0)
      .map(base => ({ kind: 'enemyBase', id: base.id, object: base, point: graph?.nodeById?.get(base.nodeId) ?? base, nodeId: base.nodeId, hp: base.hp, maxHp: base.maxHp, label: base.name ?? '敵拠点' }));
  const targets = [];
  for (const entry of entries) {
    if (!finitePoint(entry.point) || !entry.nodeId) continue;
    const distanceMeters = Math.round(Math.sqrt(distanceSquared(entry.point, eligibility.player)));
    if (distanceMeters > rangeMeters) continue;
    const path = findFriendlyRoadPath(state, originNode.id, entry.nodeId);
    targets.push({
      kind: entry.kind,
      id: entry.id,
      name: deploymentTargetName(entry.object, entry.kind),
      label: entry.label,
      nodeId: entry.nodeId,
      distanceMeters,
      routeMeters: path ? Math.round(path.cost ?? 0) : null,
      hp: Math.max(0, Math.round(Number(entry.hp) || 0)),
      maxHp: Math.max(1, Math.round(Number(entry.maxHp) || Number(entry.hp) || 1)),
      available: Boolean(path),
      route: path
    });
  }
  targets.sort((a, b) => Number(!a.available) - Number(!b.available) || a.distanceMeters - b.distanceMeters || String(a.id).localeCompare(String(b.id)));
  return targets;
}

function resolveDeploymentTarget(state, key, targetRequest = null) {
  const definition = ROADSIDE_USE_DEFINITIONS[key];
  const targets = roadsideDeploymentTargets(state, key);
  if (targetRequest?.id) {
    const requestedKind = targetRequest.kind ?? definition?.targetKind ?? 'enemyBase';
    return targets.find(target => target.kind === requestedKind && target.id === targetRequest.id) ?? null;
  }
  return targets.find(target => target.available) ?? targets[0] ?? null;
}

function temporaryActiveCount(state) {
  return (state.combat?.friendlySquads ?? []).filter(squad => squad.temporaryDeployment && squad.hp > 0 && !['RECOVERING', 'READY'].includes(squad.status)).length;
}

export function useLocalDeploymentCall(state, key, events = null, targetRequest = null) {
  const definition = ROADSIDE_USE_DEFINITIONS[key];
  if (!definition?.squadType) return { ok: false, reasonKey: 'reason.roadside.itemCannotDeploy', reason: 'このアイテムは現地出撃に対応していません。' };
  const eligibility = locationEligibility(state, { strict: true });
  if (!eligibility.ok) return eligibility;
  if (temporaryActiveCount(state) >= 1) return { ok: false, reasonKey: 'reason.roadside.temporarySquadActive', reason: '現地出撃中の一時部隊が残っています。任務完了後に使用してください。' };
  if (!friendlySquadUnlocked(state, definition.squadType)) return { ok: false, reasonKey: 'reason.roadside.itemLockedByCivilization', reasonParams: { itemName: definition.name }, reason: `${definition.name}は現在の文明レベルでは使用できません。` };

  const originNode = nearestNode(state, eligibility.player);
  if (!originNode) return { ok: false, reasonKey: 'reason.roadside.noNearbyRoadNode', reason: '現在地周辺の道路ノードが見つかりません。' };

  const selected = resolveDeploymentTarget(state, key, targetRequest);
  if (!selected) {
    return { ok: false, reasonKey: 'reason.roadside.noDeploymentTargetNearby', reasonParams: { range: definition.searchRangeMeters }, reason: `現在地から${definition.searchRangeMeters}m以内に出撃対象がありません。` };
  }
  if (!selected.available || !selected.route) {
    return { ok: false, reasonKey: 'reason.roadside.noRouteToTarget', reasonParams: { targetName: selected.name ?? '指定対象' }, reason: `${selected.name ?? '指定対象'}へ接続する道路経路がありません。` };
  }
  if (!consumeInventory(state, key)) return { ok: false, reasonKey: 'reason.roadside.itemNotOwned', reasonParams: { itemName: definition.name }, reason: `${definition.name}を所持していません。` };

  const targetNodeId = selected.nodeId;
  const path = selected.route;
  const target = definition.targetKind === 'enemy'
    ? (state.combat?.enemies ?? []).find(enemy => enemy.id === selected.id && enemy.hp > 0) ?? selected
    : (state.world?.enemyBases ?? []).find(base => base.id === selected.id && base.alive && base.hp > 0) ?? selected;
  const runtime = friendlySquadRuntimeDefinition(state, definition.squadType);
  const fallbackBase = activePlayerBases(state)[0] ?? state.world?.homeBase ?? null;
  const squadId = stableId('local_squad', key, originNode.id, selected.id, worldNow(state), positiveHash(key, selected.id));
  const squad = {
    id: squadId,
    type: runtime.type,
    members: runtime.members,
    hp: runtime.hp,
    maxHp: runtime.hp,
    originBaseId: fallbackBase?.id ?? 'local',
    deployedAt: worldNow(state),
    missionType: definition.targetKind === 'enemy' ? 'INTERCEPT' : 'ATTACK',
    targetBaseId: definition.targetKind === 'enemy' ? null : selected.id,
    missionTargetBaseId: definition.targetKind === 'enemy' ? null : selected.id,
    targetEnemyId: definition.targetKind === 'enemy' ? selected.id : null,
    targetRecoveryItemId: null,
    recoveryCollectionProgressSec: null,
    nodeId: originNode.id,
    path: { nodeIds: [...path.nodeIds], edgeIds: [...path.edgeIds], cost: path.cost, targetId: path.targetId ?? targetNodeId },
    pathIndex: 0,
    edgeId: path.edgeIds[0] ?? null,
    edgeProgress: 0,
    status: 'OUTBOUND',
    order: 'ADVANCE',
    commandDestinationNodeId: targetNodeId,
    travelHistoryNodeIds: [originNode.id],
    engagedEnemyId: null,
    combatCooldown: 0,
    departDelay: 0,
    formationId: null,
    formationTargetId: null,
    formationSpeed: null,
    formationSize: null,
    recoveryBaseId: fallbackBase?.id ?? null,
    recoveryStartedAt: null,
    reorganizationRemaining: 0,
    readyAt: null,
    temporaryDeployment: { itemKey: key, name: definition.name, targetKind: selected.kind, targetId: selected.id, createdAt: worldNow(state) }
  };
  state.combat.friendlySquads.push(squad);
  events?.emit('friendly:squad-deployed', { squad, origin: { nodeId: originNode.id, name: '現在地' }, target, cost: {}, temporary: true });
  events?.emit('message', { key: 'roadside.notice.temporarySquadDeployed', params: { itemName: definition.name, targetName: selected.name ?? '指定対象', squadName: runtime.name }, text: `${definition.name}を使用し、${selected.name ?? '指定対象'}へ${runtime.name}を一時出撃させました。` });
  return { ok: true, squad, target, selectedTarget: selected };
}


function mineDefinition(mineOrKey) {
  const key = typeof mineOrKey === 'string' ? mineOrKey : mineOrKey?.itemKey ?? mineOrKey?.mineType ?? 'roadMine';
  return ROADSIDE_USE_DEFINITIONS[key] ?? ROADSIDE_USE_DEFINITIONS.roadMine;
}

function mineLimitForState(state, key = 'roadMine') {
  const level = Math.max(0, Math.floor(Number(state.civilization?.level) || 0));
  const base = key === 'armorBreakerMine' ? 1 : key === 'directionalMine' ? 2 : level >= 6 ? 8 : level >= 4 ? 5 : 3;
  return base;
}

function placedMineLimitReached(state, key = 'roadMine') {
  const supplies = ensureRoadsideSupplyState(state);
  const count = (supplies.placedMines ?? []).filter(mine => (mine.itemKey ?? 'roadMine') === key).length;
  return count >= mineLimitForState(state, key);
}

function mineDamageForEnemy(mine, enemy, triggeredEnemy) {
  const key = mine.itemKey ?? 'roadMine';
  const guided = enemy?.roadsideLureMineId === mine.id || triggeredEnemy?.roadsideLureMineId === mine.id;
  const guidedBoost = guided ? 1.25 : 1;
  if (key === 'armorBreakerMine') return (enemy.maxHp * 1.85 + 260) * guidedBoost;
  if (key === 'directionalMine') return (enemy.maxHp * 1.15 + 140) * guidedBoost;
  return (enemy.maxHp * 0.85 + 80) * guidedBoost;
}

export function updateRoadsideMines(state, events = null) {
  const supplies = ensureRoadsideSupplyState(state);
  let detonated = 0;
  supplies.placedMines = (supplies.placedMines ?? []).filter(mine => {
    const definition = mineDefinition(mine);
    const triggerRadius2 = definition.triggerRadiusMeters ** 2;
    const triggeredEnemy = (state.combat?.enemies ?? []).find(enemy => enemy.hp > 0 && enemy.departDelay <= 0 && distanceSquared(enemyPosition(state, enemy), mine) <= triggerRadius2);
    if (!triggeredEnemy) return true;
    const guided = triggeredEnemy.roadsideLureMineId === mine.id;
    const radius = definition.radiusMeters * (guided ? 1.2 : 1);
    let hits = 0;
    for (const enemy of state.combat?.enemies ?? []) {
      if (enemy.hp <= 0 || enemy.departDelay > 0) continue;
      if (distanceSquared(enemyPosition(state, enemy), mine) > radius ** 2) continue;
      if (damageEnemy(state, enemy, mineDamageForEnemy(mine, enemy, triggeredEnemy), events)) hits += 1;
      if (enemy.roadsideLureMineId === mine.id) enemy.roadsideLureMineId = null;
    }
    state.combat.enemies = (state.combat.enemies ?? []).filter(enemy => enemy.hp > 0);
    detonated += 1;
    events?.emit('exploration:roadside-mine-detonated', { mineId: mine.id, itemKey: mine.itemKey ?? 'roadMine', hits, guided });
    events?.emit('message', { key: guided ? 'roadside.notice.mineTriggeredGuided' : 'roadside.notice.mineTriggered', params: { itemName: definition.name, count: hits }, text: `${definition.name}が起爆し、敵${hits}体に損害を与えました。${guided ? '誘導中の敵を巻き込み、威力が上がりました。' : ''}` });
    return false;
  });
  return { detonated };
}

export function useMineItem(state, key = 'roadMine', events = null) {
  const definition = mineDefinition(key);
  const eligibility = locationEligibility(state, { strict: true });
  if (!eligibility.ok) return eligibility;
  if (placedMineLimitReached(state, key)) return { ok: false, reasonKey: 'reason.roadside.mineLimitReached', reasonParams: { itemName: definition.name, limit: mineLimitForState(state, key) }, reason: `${definition.name}は同時に${mineLimitForState(state, key)}個までです。` };
  if (!consumeInventory(state, key)) return { ok: false, reasonKey: 'reason.roadside.itemNotOwned', reasonParams: { itemName: definition.name }, reason: `${definition.name}を所持していません。` };
  const originNode = nearestNode(state, eligibility.player);
  if (!originNode || distanceSquared(originNode, eligibility.player) > 70 * 70) {
    refundInventory(state, key);
    return { ok: false, reasonKey: 'reason.roadside.useNearRoad', reason: '道路上または道路付近で使用してください。' };
  }
  const supplies = ensureRoadsideSupplyState(state);
  const now = worldNow(state);
  const mine = { id: stableId('roadside-mine', key, originNode.id, now, positiveHash('mine', key, now)), itemKey: key, mineType: key, name: definition.name, x: originNode.x, y: originNode.y, nodeId: originNode.id, placedAt: now };
  supplies.placedMines.push(mine);
  events?.emit('exploration:roadside-item-used', { itemKey: key, mineId: mine.id });
  events?.emit('message', { key: 'roadside.notice.minePlaced', params: { itemName: definition.name }, text: `${definition.name}を道路に設置しました。発動するまで残ります。` });
  return { ok: true, mine };
}

export function useRoadMine(state, events = null) { return useMineItem(state, 'roadMine', events); }

export function removePlacedMine(state, mineId, events = null) {
  const supplies = ensureRoadsideSupplyState(state);
  const index = (supplies.placedMines ?? []).findIndex(mine => mine.id === mineId);
  if (index < 0) return { ok: false, reasonKey: 'reason.roadside.mineNotFound', reason: '設置済み地雷が見つかりません。' };
  const [mine] = supplies.placedMines.splice(index, 1);
  events?.emit('exploration:roadside-mine-removed', { mineId, itemKey: mine.itemKey ?? 'roadMine' });
  events?.emit('message', { key: 'roadside.notice.mineRemoved', params: { itemName: mine.name ?? mineDefinition(mine).name }, text: `${mine.name ?? mineDefinition(mine).name}を撤去しました。` });
  return { ok: true, mine };
}


function defenseClusterEligible(defense) {
  if (!defense || defense.hp <= 0) return false;
  return defense.isGate || ['gun', 'mortar', 'slow'].includes(defense.type);
}

function defenseClusterCandidates(state) {
  const graph = state.world?.roadGraph;
  if (!graph?.nodeById) return [];
  const defenses = (state.combat?.defenses ?? [])
    .filter(defenseClusterEligible)
    .map(defense => ({ defense, point: defenseWorldPosition(graph, defense) }))
    .filter(entry => finitePoint(entry.point));
  const candidates = [];
  const seen = new Set();
  for (const entry of defenses) {
    const nearby = defenses.filter(other => distanceSquared(other.point, entry.point) <= 120 * 120);
    if (nearby.length < 3) continue;
    const node = nearestNode(state, entry.point);
    if (!node) continue;
    const key = node.id;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      kind: 'defenseCluster',
      id: `defense-cluster:${node.id}`,
      nodeId: node.id,
      x: node.x,
      y: node.y,
      name: `防衛密集地点 ${nearby.length}基`,
      count: nearby.length,
      defenseIds: nearby.map(item => item.defense.id)
    });
  }
  candidates.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return candidates;
}

export function lureSignalTargets(state) {
  const supplies = ensureRoadsideSupplyState(state);
  const mines = (supplies.placedMines ?? []).map(mine => ({
    kind: 'mine', id: mine.id, nodeId: mine.nodeId, x: mine.x, y: mine.y,
    name: mine.name ?? mineDefinition(mine).name, itemKey: mine.itemKey ?? 'roadMine'
  }));
  return [...mines, ...defenseClusterCandidates(state)];
}

function lureTargetByRequest(state, target = null) {
  const targets = lureSignalTargets(state);
  if (target?.kind === 'mine') return targets.find(item => item.kind === 'mine' && item.id === target.id) ?? null;
  if (target?.kind === 'defenseCluster') return targets.find(item => item.kind === 'defenseCluster' && item.id === target.id) ?? null;
  if (target?.kind === 'defense') {
    const defense = (state.combat?.defenses ?? []).find(item => item.id === target.id);
    const point = defense ? defenseWorldPosition(state.world?.roadGraph, defense) : null;
    if (!finitePoint(point)) return null;
    return defenseClusterCandidates(state).find(item => distanceSquared(item, point) <= 120 * 120) ?? null;
  }
  return targets[0] ?? null;
}

function applyLureToTarget(state, target, events = null) {
  const definition = ROADSIDE_USE_DEFINITIONS.lureSignal;
  const node = state.world?.roadGraph?.nodeById?.get(target.nodeId);
  if (!node) return { ok: false, reasonKey: 'reason.roadside.lureNodeNotFound', reason: '誘導先の道路ノードが見つかりません。' };
  const now = worldNow(state);
  let affected = 0;
  for (const enemy of state.combat?.enemies ?? []) {
    if (enemy.hp <= 0 || enemy.departDelay > 0) continue;
    if (distanceSquared(enemyPosition(state, enemy), node) > definition.radiusMeters ** 2) continue;
    enemy.roadsideLureNodeId = node.id;
    enemy.roadsideLureUntil = now + definition.durationSeconds * 1000;
    enemy.roadsideLureMineId = target.kind === 'mine' ? target.id : null;
    enemy.targetDefenseId = null;
    enemy.targetFieldBaseId = null;
    enemy.targetPlayerBaseId = null;
    enemy.targetSquadId = null;
    enemy.path = null;
    enemy.edgeId = null;
    enemy.edgeProgress = 0;
    enemy.reroutePending = true;
    affected += 1;
  }
  events?.emit('exploration:roadside-item-used', { itemKey: 'lureSignal', affected, target });
  events?.emit('message', affected ? { key: 'roadside.notice.lureTargeted', params: { count: affected, targetName: target.name ?? '指定地点' }, text: `誘導信号弾で敵${affected}体を${target.name ?? '指定地点'}へ誘導しました。` } : { key: 'roadside.notice.lureNoTarget', params: {}, text: '誘導信号弾を使用しましたが、誘導先周辺に対象の敵はいませんでした。' });
  return { ok: true, affected, target };
}

export function useLureSignal(state, events = null, target = null) {
  if (!consumeInventory(state, 'lureSignal')) return { ok: false, reasonKey: 'reason.roadside.noLureSignal', reason: '誘導信号弾を所持していません。' };
  let selectedTarget = lureTargetByRequest(state, target);
  if (!selectedTarget) {
    const eligibility = locationEligibility(state, { strict: true });
    if (!eligibility.ok) { refundInventory(state, 'lureSignal'); return eligibility; }
    const node = nearestNode(state, eligibility.player);
    if (!node) { refundInventory(state, 'lureSignal'); return { ok: false, reasonKey: 'reason.roadside.noNearbyRoadNode', reason: '現在地周辺の道路ノードが見つかりません。' }; }
    selectedTarget = { kind: 'node', id: node.id, nodeId: node.id, x: node.x, y: node.y, name: '現在地付近' };
  }
  const result = applyLureToTarget(state, selectedTarget, events);
  if (!result.ok) refundInventory(state, 'lureSignal');
  return result;
}


function strikeTargetPoint(state, target) {
  const graph = state.world?.roadGraph;
  if (target?.kind === 'enemy') {
    const enemy = (state.combat?.enemies ?? []).find(item => item.id === target.id && item.hp > 0);
    return enemy ? { point: enemyPosition(state, enemy), label: '敵部隊', targetObject: enemy } : null;
  }
  if (target?.kind === 'enemyBase') {
    const base = (state.world?.enemyBases ?? []).find(item => item.id === target.id && item.alive && item.hp > 0);
    const node = base ? graph?.nodeById?.get(base.nodeId) : null;
    return base && node ? { point: node, label: base.name ?? '敵拠点', targetObject: base } : null;
  }
  if (target?.nodeId && graph?.nodeById?.has(target.nodeId)) {
    const node = graph.nodeById.get(target.nodeId);
    return { point: node, label: target.name ?? '指定地点', targetObject: null };
  }
  return null;
}

function damageEnemyBaseByStrike(state, base, ratio, events, itemKey) {
  if (!base?.alive || base.hp <= 0) return false;
  const damage = Math.max(1, Math.floor((base.maxHp ?? base.hp) * ratio));
  base.hp = Math.max(itemKey === 'airSupport' ? 1 : 0, base.hp - damage);
  if (base.hp <= 0) destroyEnemyBase(state, base, events, { roadsideItem: itemKey });
  return true;
}

export function useStrategicStrike(state, key, target, events = null) {
  const definition = ROADSIDE_USE_DEFINITIONS[key];
  if (!['remoteBarrage', 'airSupport', 'areaSuppression'].includes(key) || !definition) return { ok: false, reasonKey: 'reason.roadside.remoteUnsupported', reason: 'このアイテムは遠隔支援に対応していません。' };
  if (!consumeInventory(state, key)) return { ok: false, reasonKey: 'reason.roadside.itemNotOwned', reasonParams: { itemName: definition.name }, reason: `${definition.name}を所持していません。` };
  const targetInfo = strikeTargetPoint(state, target);
  if (!targetInfo?.point) { refundInventory(state, key); return { ok: false, reasonKey: 'reason.roadside.selectAttackTarget', reason: '攻撃対象を選択してください。' }; }
  const radius = definition.radiusMeters;
  let enemyHits = 0;
  for (const enemy of state.combat?.enemies ?? []) {
    if (enemy.hp <= 0 || enemy.departDelay > 0) continue;
    if (distanceSquared(enemyPosition(state, enemy), targetInfo.point) > radius ** 2) continue;
    const multiplier = key === 'airSupport' ? 3.6 : key === 'areaSuppression' ? 2.8 : 1.8;
    if (damageEnemy(state, enemy, enemy.maxHp * multiplier + (key === 'airSupport' ? 600 : 220), events)) enemyHits += 1;
  }
  state.combat.enemies = (state.combat.enemies ?? []).filter(enemy => enemy.hp > 0);
  let baseHits = 0;
  for (const base of state.world?.enemyBases ?? []) {
    if (!base.alive || base.hp <= 0) continue;
    const point = state.world?.roadGraph?.nodeById?.get(base.nodeId) ?? base;
    if (!finitePoint(point) || distanceSquared(point, targetInfo.point) > radius ** 2) continue;
    if (damageEnemyBaseByStrike(state, base, definition.baseDamageRatio, events, key)) baseHits += 1;
  }
  events?.emit('exploration:strategic-strike-used', { itemKey: key, target, enemyHits, baseHits });
  events?.emit('message', { key: 'roadside.notice.strategicStrikeExecuted', params: { itemName: definition.name, targetName: targetInfo.label, enemyCount: enemyHits, baseCount: baseHits }, text: `${definition.name}を${targetInfo.label}周辺へ実行しました。敵${enemyHits}体・敵拠点${baseHits}箇所に損害。` });
  return { ok: true, enemyHits, baseHits, target };
}


export function useMarchBannerOnSquad(state, squadId, events = null) {
  if (!consumeInventory(state, 'marchBanner')) return { ok: false, reasonKey: 'reason.roadside.noMarchBanner', reason: '行軍加速旗を所持していません。' };
  const definition = ROADSIDE_USE_DEFINITIONS.marchBanner;
  const result = boostFriendlySquadById(state, squadId, definition.durationSeconds, definition.speedMultiplier, events);
  if (!result.ok) refundInventory(state, 'marchBanner');
  return result;
}

export function useSmokeScreenOnSquad(state, squadId, events = null) {
  if (!consumeInventory(state, 'smokeScreen')) return { ok: false, reasonKey: 'reason.roadside.noSmokeScreen', reason: '緊急撤退煙幕を所持していません。' };
  const result = emergencyWithdrawFriendlySquadById(state, squadId, events);
  if (!result.ok) refundInventory(state, 'smokeScreen');
  return result;
}

export function useMarchBanner(state, events = null) {
  const eligibility = locationEligibility(state, { strict: true });
  if (!eligibility.ok) return eligibility;
  if (!consumeInventory(state, 'marchBanner')) return { ok: false, reasonKey: 'reason.roadside.noMarchBanner', reason: '行軍加速旗を所持していません。' };
  const definition = ROADSIDE_USE_DEFINITIONS.marchBanner;
  const result = boostFriendlySquadsNear(state, eligibility.player, definition.radiusMeters, definition.durationSeconds, definition.speedMultiplier, events);
  if (!result.ok) refundInventory(state, 'marchBanner');
  return result;
}

export function useSmokeScreen(state, events = null) {
  const eligibility = locationEligibility(state, { strict: true });
  if (!eligibility.ok) return eligibility;
  if (!consumeInventory(state, 'smokeScreen')) return { ok: false, reasonKey: 'reason.roadside.noSmokeScreen', reason: '緊急撤退煙幕を所持していません。' };
  const definition = ROADSIDE_USE_DEFINITIONS.smokeScreen;
  const result = emergencyWithdrawFriendlySquadNear(state, eligibility.player, definition.radiusMeters, events);
  if (!result.ok) refundInventory(state, 'smokeScreen');
  return result;
}

export class RoadsideSupplySystem {
  constructor(events = null) { this.events = events; }
  update(state, _deltaSeconds = 0) {
    if (state?.lifecycle === 'DESTROYED' || state?.runtime?.gameOver) return [];
    const supplies = ensureRoadsideSupplyState(state);
    const now = worldNow(state);
    refreshRoadsideSupplies(state);
    let collected = [];
    if (now >= supplies.nextCollectionCheckAt) {
      supplies.nextCollectionCheckAt = now + ROADSIDE_SUPPLY_COLLECT_CHECK_SECONDS * 1000;
      collected = collectNearbyRoadsideSupplies(state, this.events);
    }
    if ((supplies.placedMines?.length ?? 0) > 0 && now >= supplies.nextMineCheckAt) {
      supplies.nextMineCheckAt = now + ROADSIDE_MINE_CHECK_SECONDS * 1000;
      updateRoadsideMines(state, this.events);
    }
    return collected;
  }
  refresh(state, force = true) {
    if (state?.lifecycle === 'DESTROYED' || state?.runtime?.gameOver) return ensureRoadsideSupplyState(state);
    return refreshRoadsideSupplies(state, force);
  }
  deploymentTargets(state, key) { return roadsideDeploymentTargets(state, key); }
  useDeploymentTarget(state, key, target) { return useLocalDeploymentCall(state, key, this.events, target); }
  use(state, key) {
    if (key === 'sweepSignal') return useSweepSignal(state, this.events);
    if (key === 'breachCharge') return useBreachCharge(state, this.events);
    if (['roadMine', 'directionalMine', 'armorBreakerMine'].includes(key)) return useMineItem(state, key, this.events);
    if (key === 'lureSignal') return useLureSignal(state, this.events);
    if (key === 'marchBanner') return useMarchBanner(state, this.events);
    if (key === 'smokeScreen') return useSmokeScreen(state, this.events);
    return useLocalDeploymentCall(state, key, this.events);
  }
  useLureTarget(state, target) { return useLureSignal(state, this.events, target); }
  useOnTarget(state, key, target) { return useStrategicStrike(state, key, target, this.events); }
  removeMine(state, mineId) { return removePlacedMine(state, mineId, this.events); }
  craft(state, recipeKey) { return craftTacticalItem(state, recipeKey, this.events); }
  lureTargets(state) { return lureSignalTargets(state); }
  useOnSquad(state, key, squadId) {
    if (key === 'marchBanner') return useMarchBannerOnSquad(state, squadId, this.events);
    if (key === 'smokeScreen') return useSmokeScreenOnSquad(state, squadId, this.events);
    return { ok: false, reasonKey: 'reason.roadside.squadItemUnsupported', reason: 'このアイテムは選択部隊への使用に対応していません。' };
  }
}
