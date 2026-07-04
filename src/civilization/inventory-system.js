import {
  BASE_RESOURCES, CIVILIZATIONS, INITIAL_RESOURCES, ORE_RESOURCES,
  PROCESSED_RESOURCES, RESOURCE_KEYS, RESOURCE_LABELS, SETTLEMENT_BUILDINGS,
  emptyResourceBundle
} from './data.js';

const METALS = new Set(['copperIngot', 'tinIngot', 'bronzeIngot', 'ironBloom', 'wroughtIron', 'steel', 'mechanism']);

export function resourceCategory(key) {
  if (BASE_RESOURCES.includes(key)) return 'base';
  if (ORE_RESOURCES.includes(key)) return 'ore';
  if (METALS.has(key)) return 'metal';
  if (PROCESSED_RESOURCES.includes(key)) return 'processed';
  return null;
}

export function normalizeBundle(bundle = {}) {
  const normalized = {};
  for (const key of RESOURCE_KEYS) {
    const amount = Math.max(0, Math.floor(Number(bundle[key]) || 0));
    if (amount > 0) normalized[key] = amount;
  }
  return normalized;
}

export function bundleText(bundle = {}) {
  const values = Object.entries(normalizeBundle(bundle));
  return values.length ? values.map(([key, value]) => `${RESOURCE_LABELS[key] ?? key} ${value}`).join('・') : 'なし';
}

export function currentCivilization(state) {
  return CIVILIZATIONS[state.civilization?.level ?? 0] ?? CIVILIZATIONS[0];
}

export function ensureInventoryState(state, { initialize = false } = {}) {
  state.inventory ??= {};
  state.inventory.resources ??= {};
  const resources = emptyResourceBundle();
  for (const key of RESOURCE_KEYS) resources[key] = Math.max(0, Math.floor(Number(state.inventory.resources[key]) || 0));
  if (initialize && RESOURCE_KEYS.every(key => resources[key] === 0)) Object.assign(resources, INITIAL_RESOURCES);
  state.inventory.resources = resources;
  delete state.inventory.overflow;
  delete state.inventory.lastOverflowSweepAt;
  state.inventory.capacity ??= {};
  recalculateCapacity(state);
  return state.inventory;
}

export function recalculateCapacity(state) {
  const base = { ...(currentCivilization(state).capacity ?? CIVILIZATIONS[0].capacity) };
  const counts = new Map();
  for (const building of state.civilization?.buildings ?? []) {
    const definition = SETTLEMENT_BUILDINGS[building.type];
    if (!definition?.capacityBonus) continue;
    const count = counts.get(building.type) ?? 0;
    counts.set(building.type, count + 1);
    const multiplier = count === 0 ? 1 : 0.5;
    for (const [category, amount] of Object.entries(definition.capacityBonus)) {
      base[category] = (base[category] ?? 0) + Math.floor(amount * multiplier);
    }
  }
  state.inventory.capacity = base;
  for (const key of RESOURCE_KEYS) {
    const capacity = base[resourceCategory(key)] ?? 0;
    const stored = state.inventory.resources[key] ?? 0;
    if (stored > capacity) state.inventory.resources[key] = capacity;
  }
  return base;
}

export function hasBundle(state, bundle) {
  return Object.entries(normalizeBundle(bundle)).every(([key, amount]) => (state.inventory.resources[key] ?? 0) >= amount);
}

export function missingBundle(state, bundle) {
  const missing = {};
  for (const [key, amount] of Object.entries(normalizeBundle(bundle))) {
    const gap = amount - (state.inventory.resources[key] ?? 0);
    if (gap > 0) missing[key] = gap;
  }
  return missing;
}

export function consumeBundle(state, bundle) {
  const normalized = normalizeBundle(bundle);
  if (!hasBundle(state, normalized)) return false;
  for (const [key, amount] of Object.entries(normalized)) state.inventory.resources[key] -= amount;
  return true;
}

export function addBundle(state, bundle) {
  ensureInventoryState(state);
  const accepted = {};
  const rejected = {};
  for (const [key, amount] of Object.entries(normalizeBundle(bundle))) {
    const category = resourceCategory(key);
    const capacity = state.inventory.capacity[category] ?? 0;
    const current = state.inventory.resources[key] ?? 0;
    const acceptedAmount = Math.min(amount, Math.max(0, capacity - current));
    const rejectedAmount = amount - acceptedAmount;
    if (acceptedAmount > 0) {
      state.inventory.resources[key] = current + acceptedAmount;
      accepted[key] = acceptedAmount;
    }
    if (rejectedAmount > 0) rejected[key] = rejectedAmount;
  }
  return { accepted, rejected };
}

export class InventorySystem {
  update() {}
}
