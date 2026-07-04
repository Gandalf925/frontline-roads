export const CIVILIZATION_ABILITY = Object.freeze({
  FIELD_BASE: 'fieldBase',
  COORDINATED_DISPATCH: 'coordinatedDispatch',
  RALLY_ALL: 'rallyAll',
  AUTO_REPAIR_PATROL: 'autoRepairPatrol',
  QUEUED_DISPATCH: 'queuedDispatch',
  FIELD_COORDINATED_DISPATCH: 'fieldCoordinatedDispatch',
  ALL_OUT_ASSAULT: 'allOutAssault'
});

export const CIVILIZATION_ABILITIES = Object.freeze([
  Object.freeze({ level: 1, key: CIVILIZATION_ABILITY.FIELD_BASE, command: null, titleKey: 'ability.fieldBase.title', descriptionKey: 'ability.fieldBase.description' }),
  Object.freeze({ level: 2, key: CIVILIZATION_ABILITY.COORDINATED_DISPATCH, command: 'friendly.coordinatedDispatch', titleKey: 'ability.coordinatedDispatch.title', descriptionKey: 'ability.coordinatedDispatch.description' }),
  Object.freeze({ level: 3, key: CIVILIZATION_ABILITY.RALLY_ALL, command: 'friendly.rallyAll', titleKey: 'ability.rallyAll.title', descriptionKey: 'ability.rallyAll.description' }),
  Object.freeze({ level: 4, key: CIVILIZATION_ABILITY.AUTO_REPAIR_PATROL, command: 'friendly.autoRepairPatrol', titleKey: 'ability.autoRepairPatrol.title', descriptionKey: 'ability.autoRepairPatrol.description' }),
  Object.freeze({ level: 5, key: CIVILIZATION_ABILITY.QUEUED_DISPATCH, command: 'friendly.queueDispatch', titleKey: 'ability.queuedDispatch.title', descriptionKey: 'ability.queuedDispatch.description' }),
  Object.freeze({ level: 6, key: CIVILIZATION_ABILITY.FIELD_COORDINATED_DISPATCH, command: 'friendly.coordinatedDispatch', titleKey: 'ability.fieldCoordinatedDispatch.title', descriptionKey: 'ability.fieldCoordinatedDispatch.description' }),
  Object.freeze({ level: 7, key: CIVILIZATION_ABILITY.ALL_OUT_ASSAULT, command: 'friendly.allOutAssault', titleKey: 'ability.allOutAssault.title', descriptionKey: 'ability.allOutAssault.description' })
]);

export function civilizationLevel(state) {
  return Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
}

export function abilityDefinition(abilityKey) {
  return CIVILIZATION_ABILITIES.find(ability => ability.key === abilityKey) ?? null;
}

export function abilityUnlockLevel(abilityKey) {
  return abilityDefinition(abilityKey)?.level ?? Infinity;
}

export function hasCivilizationAbility(state, abilityKey) {
  return civilizationLevel(state) >= abilityUnlockLevel(abilityKey);
}

export function requireCivilizationAbility(state, abilityKey) {
  const ability = abilityDefinition(abilityKey);
  if (!ability) return { ok: false, reasonKey: 'reason.ability.unknown', reasonParams: { abilityKey: String(abilityKey ?? '') }, reason: '不明な文明能力です。' };
  if (hasCivilizationAbility(state, abilityKey)) return { ok: true, ability };
  return {
    ok: false,
    ability,
    reasonKey: 'reason.ability.locked',
    reasonParams: { level: ability.level, abilityKey: ability.key },
    reason: `この能力は文明Lv.${ability.level}で解禁されます。`
  };
}

export function ensureCivilizationAbilityState(state) {
  state.civilization ??= {};
  state.civilization.abilities ??= {};
  state.civilization.abilities.allOutAssaultReadyAt = Math.max(0, Number(state.civilization.abilities.allOutAssaultReadyAt) || 0);
  return state.civilization.abilities;
}
