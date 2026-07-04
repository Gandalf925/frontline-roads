import { CIVILIZATIONS, MAX_CIVILIZATION_LEVEL, RESOURCE_KEYS } from './data.js';
import { CIVILIZATION_ABILITIES } from './abilities.js';

export const CIVILIZATION_UNLOCK_TABLE = Object.freeze({
  1: Object.freeze({
    level: 1,
    abilityKeys: Object.freeze(['fieldBase']),
    civilizationUnlocks: Object.freeze(['storehouse1', 'carpentry', 'ropeworks', 'stonecutter', 'barrier1', 'single1', 'area1', 'slow1', 'repair1', 'survey1', 'medical1', 'fieldBarracks1']),
    coreResources: Object.freeze(['timber', 'rope', 'cutStone']),
    reward: Object.freeze({ timber: 8, rope: 4, cutStone: 8 })
  }),
  2: Object.freeze({
    level: 2,
    abilityKeys: Object.freeze(['coordinatedDispatch']),
    civilizationUnlocks: Object.freeze(['storehouse2', 'charcoalKiln', 'copperFurnace', 'tinFurnace', 'trialBronzeFurnace', 'barrier2', 'gate2', 'single2', 'area2', 'slow2', 'repair2', 'survey2', 'medical2', 'fieldBarracks2']),
    coreResources: Object.freeze(['charcoal', 'copperOre', 'tinOre']),
    reward: Object.freeze({ charcoal: 20, copperOre: 30, tinOre: 12 })
  }),
  3: Object.freeze({
    level: 3,
    abilityKeys: Object.freeze(['rallyAll']),
    civilizationUnlocks: Object.freeze(['storehouse3', 'bronzeWorkshop', 'bloomery', 'forge', 'barrier3', 'gate3', 'single3', 'area3', 'slow3', 'repair3', 'survey3', 'medical3', 'fieldBarracks3']),
    coreResources: Object.freeze(['bronzeIngot', 'ironOre']),
    reward: Object.freeze({ bronzeIngot: 8, ironOre: 24 })
  }),
  4: Object.freeze({
    level: 4,
    abilityKeys: Object.freeze(['autoRepairPatrol']),
    civilizationUnlocks: Object.freeze(['storehouse4', 'tacticalWorkshop', 'barrier4', 'gate4', 'single4', 'area4', 'slow4', 'repair4', 'survey4', 'medical4', 'fieldBarracks4']),
    coreResources: Object.freeze(['wroughtIron', 'charcoal']),
    reward: Object.freeze({ wroughtIron: 10, charcoal: 40 })
  }),
  5: Object.freeze({
    level: 5,
    abilityKeys: Object.freeze(['queuedDispatch']),
    civilizationUnlocks: Object.freeze(['steelStorehouse', 'steelworks', 'fortressDepot', 'barrier5', 'gate5', 'single5', 'area5', 'slow5', 'repair5', 'survey5', 'medical5', 'fieldBarracks5']),
    coreResources: Object.freeze(['steel', 'wroughtIron']),
    reward: Object.freeze({ steel: 8, wroughtIron: 20 })
  }),
  6: Object.freeze({
    level: 6,
    abilityKeys: Object.freeze(['fieldCoordinatedDispatch']),
    civilizationUnlocks: Object.freeze(['mechanismStorehouse', 'mechanismWorkshop', 'barrier6', 'gate6', 'single6', 'area6', 'slow6', 'repair6', 'survey6', 'medical6', 'fieldBarracks6']),
    coreResources: Object.freeze(['mechanism', 'steel']),
    reward: Object.freeze({ mechanism: 6, steel: 18 })
  }),
  7: Object.freeze({
    level: 7,
    abilityKeys: Object.freeze(['allOutAssault']),
    civilizationUnlocks: Object.freeze(['federalStorehouse', 'integratedWorks', 'barrier7', 'gate7', 'single7', 'area7', 'slow7', 'repair7', 'survey7', 'medical7', 'fieldBarracks7']),
    coreResources: Object.freeze(['mechanism', 'steel']),
    reward: Object.freeze({ mechanism: 12, steel: 36 })
  })
});

export function unlockTableForLevel(level) {
  const target = Math.max(1, Math.min(MAX_CIVILIZATION_LEVEL, Math.floor(Number(level) || 0)));
  return CIVILIZATION_UNLOCK_TABLE[target] ?? null;
}

export function nextUnlockTable(state) {
  const level = Math.max(0, Math.min(MAX_CIVILIZATION_LEVEL, Math.floor(Number(state?.civilization?.level) || 0)));
  if (level >= MAX_CIVILIZATION_LEVEL) return null;
  return unlockTableForLevel(level + 1);
}

export function abilityUnlocksForLevel(level) {
  const target = Math.max(1, Math.min(MAX_CIVILIZATION_LEVEL, Math.floor(Number(level) || 0)));
  return CIVILIZATION_ABILITIES.filter(ability => ability.level === target);
}

export function promotionRewardBundle(level) {
  const reward = unlockTableForLevel(level)?.reward ?? {};
  return Object.fromEntries(Object.entries(reward).filter(([key, amount]) => RESOURCE_KEYS.includes(key) && Math.floor(Number(amount) || 0) > 0));
}

export function ensurePromotionRewardClaims(state) {
  state.civilization ??= {};
  const source = state.civilization.promotionRewardsClaimed;
  const claims = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const level of Object.keys(CIVILIZATION_UNLOCK_TABLE)) {
      if (source[level] === true) claims[level] = true;
    }
  }
  state.civilization.promotionRewardsClaimed = claims;
  return claims;
}

export function hasPromotionRewardClaim(state, level) {
  const target = Math.max(1, Math.min(MAX_CIVILIZATION_LEVEL, Math.floor(Number(level) || 0)));
  return ensurePromotionRewardClaims(state)[target] === true;
}

export function markPromotionRewardClaimed(state, level) {
  const target = Math.max(1, Math.min(MAX_CIVILIZATION_LEVEL, Math.floor(Number(level) || 0)));
  const claims = ensurePromotionRewardClaims(state);
  claims[target] = true;
  return claims;
}

export function centralFacilityForLevel(level) {
  const target = Math.max(0, Math.min(MAX_CIVILIZATION_LEVEL, Math.floor(Number(level) || 0)));
  return CIVILIZATIONS[target]?.central ?? CIVILIZATIONS[0].central;
}
