import { worldNow } from '../core/utilities.js';
export const OPERATION_TEMPO_CONFIG = Object.freeze({
  standardWaveIntervalMultiplier: 2.75,
  frontlineWaveIntervalMultiplier: 2.60,
  offlineWaveIntervalMultiplier: 3.25,
  frontlineReactionDelaySeconds: 10 * 60,
  civilizationPressureRampSeconds: 12 * 60 * 60,
  noDefenseDamageMultiplier: 0.45,
  thinDefenseDamageMultiplier: 0.72,
  offlineHomeBaseDamageMultiplier: 0.45,
  lowHpLastStandMultiplier: 0.75,
  openingProtectionSeconds: 2 * 60 * 60,
  openingProtectionMinimumMultiplier: 0.25,
  warningRepeatSeconds: 30 * 60
});

const ACTIVE_WAVE_LIMIT_BY_CIVILIZATION = Object.freeze([2, 3, 4, 5, 7, 8, 10, 12]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function homeBaseAgeSeconds(state) {
  const now = worldNow(state);
  const createdAt = finiteNumber(state?.runtime?.createdAt, now);
  return Math.max(0, (now - createdAt) / 1000);
}

export function activeDefenseCount(state) {
  return (state?.combat?.defenses ?? []).filter(defense => defense.hp > 0).length;
}

export function civilizationPressureRampRatio(state) {
  const level = Math.max(0, Math.floor(finiteNumber(state?.civilization?.level, 0)));
  if (level <= 0) return 1;
  const now = worldNow(state);
  const graceUntil = finiteNumber(state?.civilization?.gracePeriodUntil, 0);
  if (graceUntil > now) return 0;
  const rampStart = graceUntil > 0
    ? graceUntil
    : finiteNumber(state?.civilization?.completedAt, now - OPERATION_TEMPO_CONFIG.civilizationPressureRampSeconds * 1000);
  const elapsed = Math.max(0, now - rampStart) / 1000;
  return Math.max(0, Math.min(1, elapsed / OPERATION_TEMPO_CONFIG.civilizationPressureRampSeconds));
}

export function operationWaveIntervalMultiplier(state, base = null) {
  const firstVisibleWavePending = Math.max(0, Math.floor(finiteNumber(base?.wavesSent, 0))) <= 0;
  let multiplier = firstVisibleWavePending && !base?.frontlineAnchorBaseId ? 1 : OPERATION_TEMPO_CONFIG.standardWaveIntervalMultiplier;
  if (base?.frontlineAnchorBaseId) multiplier = OPERATION_TEMPO_CONFIG.frontlineWaveIntervalMultiplier;
  if (state?.runtime?.offlineSimulation) multiplier *= OPERATION_TEMPO_CONFIG.offlineWaveIntervalMultiplier;
  const ramp = civilizationPressureRampRatio(state);
  if (ramp < 1 && !firstVisibleWavePending) multiplier *= 1 + (1 - ramp) * 0.70;
  return multiplier;
}

export function operationActiveWaveLimit(state) {
  const level = Math.max(0, Math.min(7, Math.floor(finiteNumber(state?.civilization?.level, 0))));
  const baseLimit = ACTIVE_WAVE_LIMIT_BY_CIVILIZATION[level] ?? ACTIVE_WAVE_LIMIT_BY_CIVILIZATION[0];
  return state?.runtime?.offlineSimulation ? Math.max(1, Math.floor(baseLimit * 0.55)) : baseLimit;
}

export function homeBaseDamageMultiplier(state) {
  const city = state?.world?.city ?? null;
  let multiplier = 1;

  const ageSeconds = homeBaseAgeSeconds(state);
  if (ageSeconds < OPERATION_TEMPO_CONFIG.openingProtectionSeconds) {
    const ratio = ageSeconds / OPERATION_TEMPO_CONFIG.openingProtectionSeconds;
    multiplier *= OPERATION_TEMPO_CONFIG.openingProtectionMinimumMultiplier
      + (1 - OPERATION_TEMPO_CONFIG.openingProtectionMinimumMultiplier) * ratio;
  }

  const defenses = activeDefenseCount(state);
  if (defenses <= 0) multiplier *= OPERATION_TEMPO_CONFIG.noDefenseDamageMultiplier;
  else if (defenses <= 2) multiplier *= OPERATION_TEMPO_CONFIG.thinDefenseDamageMultiplier;

  if (state?.runtime?.offlineSimulation) multiplier *= OPERATION_TEMPO_CONFIG.offlineHomeBaseDamageMultiplier;

  const maxHp = Math.max(1, finiteNumber(city?.maxHp, 100));
  const hpRatio = Math.max(0, finiteNumber(city?.hp, maxHp) / maxHp);
  if (hpRatio > 0 && hpRatio <= 0.25) multiplier *= OPERATION_TEMPO_CONFIG.lowHpLastStandMultiplier;

  return Math.max(0.05, Math.min(1, multiplier));
}

export function scaledHomeBaseDamage(state, rawDamage) {
  const damage = Math.max(0, finiteNumber(rawDamage, 0));
  if (damage <= 0) return 0;
  return damage * homeBaseDamageMultiplier(state);
}

export function applyHomeBaseDamage(state, rawDamage) {
  const damage = scaledHomeBaseDamage(state, rawDamage);
  if (damage <= 0 || !state?.world?.city) return 0;
  state.world.city.hp = Math.max(0, finiteNumber(state.world.city.hp, 0) - damage);
  return damage;
}

export function maybeEmitHomeBaseRiskWarnings(state, events = null) {
  if (!events || state?.runtime?.offlineSimulation || state?.runtime?.gameOver || !state?.world?.city) return;
  const now = worldNow(state);
  state.runtime ??= {};
  state.runtime.operationTempoWarnings ??= {};
  const warnings = state.runtime.operationTempoWarnings;
  const repeatMs = OPERATION_TEMPO_CONFIG.warningRepeatSeconds * 1000;
  const emitRepeatable = (key, messageKey, text) => {
    const previous = finiteNumber(warnings[key], 0);
    if (previous > 0 && now - previous < repeatMs) return;
    warnings[key] = now;
    events.emit('message', { key: messageKey, text });
  };

  if (activeDefenseCount(state) <= 0) {
    emitRepeatable('noDefense', 'operation.noDefense', '防衛設備がありません。敵部隊が本拠地に到達すると作戦終了になります。');
  }

  const maxHp = Math.max(1, finiteNumber(state.world.city.maxHp, 100));
  const hpRatio = Math.max(0, finiteNumber(state.world.city.hp, maxHp) / maxHp);
  if (hpRatio <= 0) return;
  if (hpRatio <= 0.10 && !warnings.hp10) {
    warnings.hp10 = now;
    events.emit('message', { key: 'operation.hp10', text: '本拠地HPが10%未満です。次の突破で作戦終了になる可能性があります。' });
  } else if (hpRatio <= 0.25 && !warnings.hp25) {
    warnings.hp25 = now;
    events.emit('message', { key: 'operation.hp25', text: '本拠地HPが25%未満です。防衛線が危険域です。' });
  } else if (hpRatio <= 0.50 && !warnings.hp50) {
    warnings.hp50 = now;
    events.emit('message', { key: 'operation.hp50', text: '本拠地HPが50%未満です。防衛設備の建設と修理を優先してください。' });
  }
}
