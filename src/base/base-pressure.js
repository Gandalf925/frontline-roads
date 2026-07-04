import { worldNow } from '../core/utilities.js';
export const BASE_PRESSURE_RAMP_SECONDS_BY_CIVILIZATION = Object.freeze([
  20 * 60,
  30 * 60,
  90 * 60,
  6 * 60 * 60,
  12 * 60 * 60,
  18 * 60 * 60,
  24 * 60 * 60,
  48 * 60 * 60
]);

export const BASE_PRESSURE_STAGE_LABELS = Object.freeze(['未認識', '偵察', '小規模', '拡大中', '本格']);

const BASE_KIND_INITIAL_RATIO = Object.freeze({ FIELD: 0.18, MAJOR: 0.12, PRIMARY: 1 });
const BASE_KIND_NEW_TARGET_PENALTY_SECONDS = Object.freeze({ FIELD: 190, MAJOR: 240, PRIMARY: 0 });
const BASE_KIND_MIN_TARGET_CAP = Object.freeze({ FIELD: 1, MAJOR: 2, PRIMARY: 999 });
const BASE_KIND_MAX_TARGET_CAP_BONUS = Object.freeze({ FIELD: 4, MAJOR: 6, PRIMARY: 999 });

function clamp01(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }

function normalizedCivilizationLevel(state) {
  return Math.max(0, Math.min(7, Math.floor(Number(state?.civilization?.level) || 0)));
}

export function basePressureRampSecondsForState(state) {
  const level = normalizedCivilizationLevel(state);
  return BASE_PRESSURE_RAMP_SECONDS_BY_CIVILIZATION[level] ?? BASE_PRESSURE_RAMP_SECONDS_BY_CIVILIZATION.at(-1);
}

export function baseActiveSince(base) {
  return Math.max(
    0,
    Number(base?.rebuiltAt) || 0,
    Number(base?.establishedAt) || 0
  );
}

export function basePressureProfile(state, base, kind = base?.kind ?? 'MAJOR') {
  const normalizedKind = base?.primary ? 'PRIMARY' : String(kind || 'MAJOR').toUpperCase();
  const nowMs = worldNow(state);
  const activeSince = baseActiveSince(base);
  const rampSeconds = normalizedKind === 'PRIMARY' ? 0 : basePressureRampSecondsForState(state);
  const rampMs = rampSeconds * 1000;
  const rawRatio = activeSince <= 0 || rampMs <= 0 ? 1 : clamp01((nowMs - activeSince) / rampMs);
  const initialRatio = BASE_KIND_INITIAL_RATIO[normalizedKind] ?? BASE_KIND_INITIAL_RATIO.MAJOR;
  const pressureRatio = normalizedKind === 'PRIMARY'
    ? 1
    : clamp01(initialRatio + (1 - initialRatio) * rawRatio);
  const stage = pressureRatio >= 0.92 ? 4 : pressureRatio >= 0.66 ? 3 : pressureRatio >= 0.40 ? 2 : pressureRatio >= 0.20 ? 1 : 0;
  const targetPenaltySeconds = normalizedKind === 'PRIMARY'
    ? 0
    : Math.round((BASE_KIND_NEW_TARGET_PENALTY_SECONDS[normalizedKind] ?? 220) * (1 - rawRatio));
  const level = normalizedCivilizationLevel(state);
  const minCap = BASE_KIND_MIN_TARGET_CAP[normalizedKind] ?? 1;
  const maxCap = normalizedKind === 'PRIMARY'
    ? 999
    : minCap + level + (BASE_KIND_MAX_TARGET_CAP_BONUS[normalizedKind] ?? 5);
  const targetCap = normalizedKind === 'PRIMARY'
    ? 999
    : Math.max(minCap, Math.round(minCap + (maxCap - minCap) * pressureRatio));
  const remainingMs = Math.max(0, rampMs - Math.max(0, nowMs - activeSince));
  return Object.freeze({
    kind: normalizedKind,
    activeSince,
    rampSeconds,
    ratio: pressureRatio,
    rawRatio,
    stage,
    stageLabel: BASE_PRESSURE_STAGE_LABELS[stage] ?? BASE_PRESSURE_STAGE_LABELS.at(-1),
    targetPenaltySeconds,
    targetCap,
    remainingMs,
    mature: rawRatio >= 1
  });
}

export function basePressureLoadPenaltySeconds(profile, currentTargetCount) {
  if (!profile || profile.kind === 'PRIMARY') return 0;
  const count = Math.max(0, Math.floor(Number(currentTargetCount) || 0));
  const cap = Math.max(1, Math.floor(Number(profile.targetCap) || 1));
  if (count < cap) return 0;
  return 260 + (count - cap) * 90;
}

export function activeSettlementAttackCounts(state) {
  const counts = { city: 0, major: new Map(), field: new Map() };
  for (const enemy of state?.combat?.enemies ?? []) {
    if (!enemy || enemy.hp <= 0 || enemy.waveResolved) continue;
    if (enemy.targetPlayerBaseId) counts.major.set(enemy.targetPlayerBaseId, (counts.major.get(enemy.targetPlayerBaseId) ?? 0) + 1);
    else if (enemy.targetFieldBaseId) counts.field.set(enemy.targetFieldBaseId, (counts.field.get(enemy.targetFieldBaseId) ?? 0) + 1);
    else if (enemy.path?.targetId && state?.world?.city?.nodeId && enemy.path.targetId === state.world.city.nodeId) counts.city += 1;
  }
  return counts;
}

export function basePressureUiText(profile) {
  if (!profile) return '敵圧 不明';
  if (profile.kind === 'PRIMARY') return '敵圧 本格';
  const percent = Math.round(profile.ratio * 100);
  if (profile.mature) return `敵圧 ${profile.stageLabel}・${percent}%`;
  const hours = Math.ceil(profile.remainingMs / 3_600_000);
  return `敵圧 ${profile.stageLabel}・${percent}%・本格化まで約${Math.max(1, hours)}時間`;
}
