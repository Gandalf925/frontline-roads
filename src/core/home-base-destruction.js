import { LifecycleState } from './constants.js';
import { worldNow } from './utilities.js';

export const GAME_OVER_REASON = Object.freeze({
  HOME_BASE_DESTROYED: 'HOME_BASE_DESTROYED'
});

export const GAME_OVER_SOURCE = Object.freeze({
  COMBAT: 'combat',
  OFFLINE: 'offline',
  RESTORE: 'restore'
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function isGameOverState(state) {
  return state?.lifecycle === LifecycleState.DESTROYED || Boolean(state?.runtime?.gameOver);
}

export function createHomeBaseDestroyedRecord(state, { source = GAME_OVER_SOURCE.COMBAT, occurredAt = null, finalDamage = 0 } = {}) {
  const worldTimeMs = worldNow(state);
  const resolvedOccurredAt = finiteNumber(occurredAt, worldTimeMs);
  const createdAt = finiteNumber(state?.runtime?.createdAt, worldTimeMs);
  return {
    reason: GAME_OVER_REASON.HOME_BASE_DESTROYED,
    source,
    occurredAt: resolvedOccurredAt,
    worldTimeMs,
    survivalSeconds: Math.max(0, Math.round((worldTimeMs - createdAt) / 1000)),
    civilizationLevel: Math.max(0, Math.floor(finiteNumber(state?.civilization?.level, 0))),
    kills: Math.max(0, Math.floor(finiteNumber(state?.statistics?.kills, 0))),
    campsCaptured: Math.max(0, Math.floor(finiteNumber(state?.statistics?.campsCaptured, 0))),
    defensesBuilt: Math.max(0, Math.floor((state?.combat?.defenses ?? []).length)),
    finalHp: Math.max(0, finiteNumber(state?.world?.city?.hp, 0)),
    finalDamage: Math.max(0, finiteNumber(finalDamage, 0))
  };
}

function resolvedDestroyedAt(state, occurredAt = null) {
  return finiteNumber(occurredAt, worldNow(state));
}

export function markHomeBaseDestroyed(state, options = {}) {
  if (!state?.world?.city) return null;
  if (state.runtime?.gameOver?.reason === GAME_OVER_REASON.HOME_BASE_DESTROYED) {
    state.lifecycle = LifecycleState.DESTROYED;
    state.world.city.hp = Math.max(0, finiteNumber(state.world.city.hp, 0));
    const existingPrimary = (state.world.playerBases ?? []).find(base => base.primary);
    if (existingPrimary) { existingPrimary.hp = 0; existingPrimary.status = 'DESTROYED'; }
    return state.runtime.gameOver;
  }
  state.world.city.hp = 0;
  const primary = (state.world.playerBases ?? []).find(base => base.primary);
  if (primary) {
    primary.hp = 0;
    primary.status = 'DESTROYED';
    primary.destroyedAt = resolvedDestroyedAt(state, options.occurredAt);
  }
  if (state.combat) {
    state.combat.cityRecoveryCooldown = 0;
    if (state.combat.waves?.active) state.combat.waves.active = {};
  }
  state.lifecycle = LifecycleState.DESTROYED;
  state.runtime ??= {};
  state.runtime.gameOver = createHomeBaseDestroyedRecord(state, { finalDamage: options.finalDamage, source: options.source, occurredAt: options.occurredAt });
  state.runtime.pauseReason = null;
  return state.runtime.gameOver;
}
