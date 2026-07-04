import { stableId, worldNow } from '../core/utilities.js';

export const SIEGE_EVENT_CONFIG = Object.freeze({
  minimumIntervalSeconds: 40 * 60,
  variableIntervalSeconds: 20 * 60,
  warningLeadSeconds: 5 * 60,
  offlineResumeGuardSeconds: 10 * 60,
  rewardMultiplier: 2,
  progressKillBonus: 1,
  minimumRoutes: 2,
  maximumRoutes: 4
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function deterministicHash(text) {
  let hash = 2166136261;
  for (const character of String(text)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function intervalSecondsForIndex(state, index) {
  const seed = `${state?.runtime?.createdAt ?? 0}:siege:${Math.max(0, Math.floor(Number(index) || 0))}`;
  return SIEGE_EVENT_CONFIG.minimumIntervalSeconds
    + (deterministicHash(seed) % (SIEGE_EVENT_CONFIG.variableIntervalSeconds + 1));
}

export function siegeEventStartAt(state, index) {
  const createdAt = finiteNumber(state?.runtime?.createdAt, worldNow(state));
  const normalizedIndex = Math.max(0, Math.floor(Number(index) || 0));
  let startAt = createdAt + intervalSecondsForIndex(state, 0) * 1000;
  for (let current = 1; current <= normalizedIndex; current += 1) {
    startAt += intervalSecondsForIndex(state, current) * 1000;
  }
  return startAt;
}

export function siegeEventAtOrBefore(state, timeMs = worldNow(state)) {
  const createdAt = finiteNumber(state?.runtime?.createdAt, worldNow(state));
  const target = finiteNumber(timeMs, worldNow(state));
  let index = 0;
  let startAt = createdAt + intervalSecondsForIndex(state, 0) * 1000;
  if (target < startAt) return null;
  while (index < 20000) {
    const nextStartAt = startAt + intervalSecondsForIndex(state, index + 1) * 1000;
    if (target < nextStartAt) return { index, id: siegeEventId(state, index), startsAt: startAt, warningAt: startAt - SIEGE_EVENT_CONFIG.warningLeadSeconds * 1000 };
    index += 1;
    startAt = nextStartAt;
  }
  return { index, id: siegeEventId(state, index), startsAt: startAt, warningAt: startAt - SIEGE_EVENT_CONFIG.warningLeadSeconds * 1000 };
}

export function siegeEventId(state, index) {
  return stableId('siege', state?.runtime?.createdAt ?? 0, Math.max(0, Math.floor(Number(index) || 0)));
}

export function ensureSiegeEventState(state, { initializeToNow = true } = {}) {
  state.combat ??= {};
  const existed = Boolean(state.combat.siege);
  state.combat.siege ??= {};
  const siege = state.combat.siege;
  const now = worldNow(state);
  if (!Number.isFinite(Number(siege.lastProcessedIndex))) {
    const latestPast = initializeToNow ? siegeEventAtOrBefore(state, now) : null;
    siege.lastProcessedIndex = latestPast ? latestPast.index : -1;
  } else {
    siege.lastProcessedIndex = Math.max(-1, Math.floor(Number(siege.lastProcessedIndex)));
  }
  siege.warnedIndex = Number.isFinite(Number(siege.warnedIndex)) ? Math.floor(Number(siege.warnedIndex)) : -1;
  siege.activeEventId = siege.activeEventId ?? null;
  siege.activeWaveIds = Array.isArray(siege.activeWaveIds) ? siege.activeWaveIds.filter(Boolean).map(String) : [];
  siege.completedEventIds = Array.isArray(siege.completedEventIds) ? [...new Set(siege.completedEventIds.filter(Boolean).map(String))].slice(-12) : [];
  siege.offlineSkippedCount = Math.max(0, Math.floor(Number(siege.offlineSkippedCount) || 0));
  siege.lastOfflineSkippedAt = Math.max(0, Number(siege.lastOfflineSkippedAt) || 0);
  siege.resumeGuardUntil = Math.max(0, Number(siege.resumeGuardUntil) || 0);
  if (!existed) siege.createdAt = now;
  return siege;
}

export function nextSiegeEvent(state, fromMs = worldNow(state), { respectResumeGuard = true } = {}) {
  const siege = ensureSiegeEventState(state);
  const guardTarget = respectResumeGuard ? Math.max(finiteNumber(fromMs, worldNow(state)), finiteNumber(siege.resumeGuardUntil, 0)) : finiteNumber(fromMs, worldNow(state));
  let index = Math.max(0, siege.lastProcessedIndex + 1);
  let startsAt = siegeEventStartAt(state, index);
  while (startsAt <= guardTarget && index < 20000) {
    index += 1;
    startsAt = siegeEventStartAt(state, index);
  }
  return { index, id: siegeEventId(state, index), startsAt, warningAt: startsAt - SIEGE_EVENT_CONFIG.warningLeadSeconds * 1000 };
}


export function pendingSiegeEvent(state) {
  const siege = ensureSiegeEventState(state);
  const index = Math.max(0, siege.lastProcessedIndex + 1);
  const startsAt = siegeEventStartAt(state, index);
  return { index, id: siegeEventId(state, index), startsAt, warningAt: startsAt - SIEGE_EVENT_CONFIG.warningLeadSeconds * 1000 };
}

export function siegeEventCountdownSeconds(state, fromMs = worldNow(state)) {
  const event = nextSiegeEvent(state, fromMs);
  return Math.max(0, Math.ceil((event.startsAt - finiteNumber(fromMs, worldNow(state))) / 1000));
}

function activeSiegeBases(state, event) {
  const level = Math.max(0, Math.floor(Number(state?.civilization?.level) || 0));
  const desiredRoutes = Math.max(
    SIEGE_EVENT_CONFIG.minimumRoutes,
    Math.min(SIEGE_EVENT_CONFIG.maximumRoutes, 2 + Math.floor(level / 3))
  );
  return (state.world?.enemyBases ?? [])
    .filter(base => base?.alive && base.hp > 0)
    .map(base => ({ base, rank: deterministicHash(`${event.id}:${base.id}:${base.nodeId ?? ''}`) }))
    .sort((a, b) => a.rank - b.rank || String(a.base.id).localeCompare(String(b.base.id)))
    .slice(0, desiredRoutes)
    .map(entry => entry.base);
}

function markProcessedThrough(state, targetMs, reason = 'offline') {
  const siege = ensureSiegeEventState(state);
  const latest = siegeEventAtOrBefore(state, targetMs);
  if (!latest || latest.index <= siege.lastProcessedIndex) return 0;
  const skipped = latest.index - siege.lastProcessedIndex;
  siege.lastProcessedIndex = latest.index;
  if (reason === 'offline' || reason === 'resumeGuard') {
    siege.offlineSkippedCount += skipped;
    siege.lastOfflineSkippedAt = worldNow(state);
    siege.resumeGuardUntil = Math.max(siege.resumeGuardUntil, worldNow(state) + SIEGE_EVENT_CONFIG.offlineResumeGuardSeconds * 1000);
  }
  return skipped;
}

function emitMessage(events, key, params, fallback) {
  events?.emit?.('message', { key, params, text: fallback });
}

function completeActiveSiegeIfResolved(state, events = null) {
  const siege = ensureSiegeEventState(state);
  if (!siege.activeEventId) return false;
  const liveEnemies = (state.combat?.enemies ?? []).some(enemy => enemy.hp > 0 && enemy.siegeEventId === siege.activeEventId);
  const liveWaves = siege.activeWaveIds.some(waveId => Boolean(state.combat?.waves?.active?.[waveId]));
  if (liveEnemies || liveWaves) return false;
  if (!siege.completedEventIds.includes(siege.activeEventId)) {
    siege.completedEventIds.push(siege.activeEventId);
    siege.completedEventIds = siege.completedEventIds.slice(-12);
    emitMessage(events, 'siege.repulsed', { multiplier: SIEGE_EVENT_CONFIG.rewardMultiplier }, '包囲を撃退しました。包囲部隊からの報酬は2倍です。');
  }
  siege.activeEventId = null;
  siege.activeWaveIds = [];
  return true;
}

function triggerSiege(state, event, waveSystem, events = null) {
  const siege = ensureSiegeEventState(state);
  const bases = activeSiegeBases(state, event);
  let routes = 0;
  const waveIds = [];
  for (const base of bases) {
    const beforeIds = new Set(Object.keys(state.combat?.waves?.active ?? {}));
    const spawned = waveSystem.spawnWave(state, base, false, {
      siegeEventId: event.id,
      rewardMultiplier: SIEGE_EVENT_CONFIG.rewardMultiplier,
      progressKillBonus: SIEGE_EVENT_CONFIG.progressKillBonus
    });
    if (spawned <= 0) continue;
    routes += 1;
    for (const waveId of Object.keys(state.combat?.waves?.active ?? {})) {
      if (!beforeIds.has(waveId) && state.combat.waves.active[waveId]?.siegeEventId === event.id) waveIds.push(waveId);
    }
  }
  siege.lastProcessedIndex = Math.max(siege.lastProcessedIndex, event.index);
  siege.warnedIndex = Math.max(siege.warnedIndex, event.index);
  if (routes > 0) {
    siege.activeEventId = event.id;
    siege.activeWaveIds = waveIds;
    siege.lastStartedAt = worldNow(state);
    emitMessage(events, 'siege.started', { count: routes, multiplier: SIEGE_EVENT_CONFIG.rewardMultiplier }, `包囲が始まりました。${routes}方向から敵が進軍中です。`);
    events?.emit?.('combat:siege-started', { eventId: event.id, routes, waveIds });
  } else {
    siege.lastNoRouteAt = worldNow(state);
  }
  return { routes, waveIds };
}

export function updateSiegeEvents(state, deltaSeconds, waveSystem, events = null) {
  const siege = ensureSiegeEventState(state);
  completeActiveSiegeIfResolved(state, events);
  const now = worldNow(state);
  if (state?.runtime?.offlineSimulation) {
    markProcessedThrough(state, now, 'offline');
    return { ok: true, offlineSkipped: true };
  }
  if (siege.resumeGuardUntil > now) {
    markProcessedThrough(state, siege.resumeGuardUntil, 'resumeGuard');
    return { ok: true, resumeGuard: true };
  }
  const event = pendingSiegeEvent(state);
  if (now >= event.startsAt) return triggerSiege(state, event, waveSystem, events);
  if (now >= event.warningAt && siege.warnedIndex < event.index) {
    siege.warnedIndex = event.index;
    const minutes = Math.max(1, Math.ceil((event.startsAt - now) / 60000));
    emitMessage(events, 'siege.warning', { minutes }, `敵の集結を確認。約${minutes}分後に包囲が始まります。`);
    events?.emit?.('combat:siege-warning', { eventId: event.id, minutes });
  }
  return { ok: true, next: event };
}

export function offlineSiegeSummary(state) {
  const siege = ensureSiegeEventState(state);
  const next = nextSiegeEvent(state, worldNow(state));
  return Object.freeze({
    skippedCount: Math.max(0, Math.floor(Number(siege.offlineSkippedCount) || 0)),
    resumeGuardUntil: Math.max(0, Number(siege.resumeGuardUntil) || 0),
    nextStartsAt: next.startsAt,
    nextInSeconds: Math.max(0, Math.ceil((next.startsAt - worldNow(state)) / 1000))
  });
}
