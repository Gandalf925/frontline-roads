import { worldNow } from '../core/utilities.js';

// ---------------------------------------------------------------------------
// Command log foundation for the planned online mode.
//
// Online play records every player intent as a small serializable command
// (eventually a BSV transaction). Every client owns the same simulation code,
// replays the same commands at the same world-time offsets, and must arrive at
// the identical state. This module provides:
//   - CommandRegistry: command type -> executor(state, payload, events)
//   - a serializable, ordered command log
//   - replayCommands(): drive any simulation `advance` callback and apply
//     commands at their recorded world times
//   - gameplayStateHash(): canonical hash of gameplay-relevant state used to
//     verify that two runs (or two clients) agree
// ---------------------------------------------------------------------------

export class CommandRegistry {
  #executors = new Map();

  register(type, executor) {
    if (typeof type !== 'string' || !type) throw new Error('command type must be a non-empty string');
    if (typeof executor !== 'function') throw new Error(`executor for ${type} must be a function`);
    if (this.#executors.has(type)) throw new Error(`command type already registered: ${type}`);
    this.#executors.set(type, executor);
    return this;
  }

  has(type) {
    return this.#executors.has(type);
  }

  types() {
    return [...this.#executors.keys()].sort();
  }

  execute(state, command, events = null) {
    const executor = this.#executors.get(command?.type);
    if (!executor) return { ok: false, reasonKey: 'reason.command.unknownType', reasonParams: { type: String(command?.type ?? '') }, reason: `未知のコマンド種別です: ${command?.type}` };
    return executor(state, command.payload ?? {}, events) ?? { ok: true };
  }
}

export function createCommandLog() {
  return { version: 1, nextSeq: 1, commands: [] };
}

export function appendCommand(log, { type, payload = {} }, atMs) {
  const command = {
    seq: log.nextSeq,
    atMs: Math.max(0, Math.floor(Number(atMs) || 0)),
    type: String(type),
    payload: JSON.parse(JSON.stringify(payload ?? {}))
  };
  log.nextSeq += 1;
  log.commands.push(command);
  return command;
}

export function serializeCommandLog(log) {
  return JSON.stringify({ version: log.version ?? 1, nextSeq: log.nextSeq, commands: log.commands });
}

export function deserializeCommandLog(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.commands)) throw new Error('invalid command log: commands missing');
  const commands = parsed.commands.map(command => ({
    seq: Math.floor(Number(command.seq)),
    atMs: Math.max(0, Math.floor(Number(command.atMs) || 0)),
    type: String(command.type),
    payload: command.payload ?? {}
  }));
  for (const command of commands) {
    if (!Number.isFinite(command.seq) || !command.type) throw new Error('invalid command entry');
  }
  return { version: parsed.version ?? 1, nextSeq: Number(parsed.nextSeq) || commands.length + 1, commands };
}

function commandOrder(left, right) {
  return left.atMs - right.atMs || left.seq - right.seq;
}

export function replayCommands({ state, registry, commands, advance, events = null, stepSeconds = 0.05 }) {
  // `advance(state, seconds)` must drive the simulation exactly the way live
  // play does (fixed steps). Commands are applied once world time reaches
  // their recorded timestamp; ordering ties are broken by sequence number so
  // every client applies them identically.
  const ordered = [...commands].sort(commandOrder);
  const results = [];
  for (const command of ordered) {
    let guard = 0;
    while (worldNow(state) < command.atMs && guard < 10_000_000) {
      const remainingSeconds = (command.atMs - worldNow(state)) / 1000;
      advance(state, Math.min(stepSeconds, remainingSeconds));
      guard += 1;
    }
    results.push({ command, result: registry.execute(state, command, events) });
  }
  return results;
}

// --- canonical gameplay hash ----------------------------------------------

const HASH_INCLUDED_TOP_LEVEL = Object.freeze([
  'schemaVersion',
  'lifecycle',
  'combat',
  'civilization',
  'inventory',
  'statistics',
  'progression'
]);

const HASH_INCLUDED_WORLD = Object.freeze([
  'homeBase',
  'playerBases',
  'fieldBases',
  'city',
  'enemyBases',
  'baseRespawns',
  'frontierSources',
  'explorationSites',
  'recoveryItems',
  'recoveryCollection',
  'regionProfiles',
  'roadsideSupplies'
]);

function canonicalize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [String(key), canonicalize(entry)])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  }
  if (value instanceof Set) {
    return [...value].map(canonicalize).map(entry => JSON.stringify(entry)).sort();
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return String(value);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function gameplayStateProjection(state) {
  // Gameplay-relevant state only: excludes the road graph (static per
  // scenario and shared out-of-band), wall-clock runtime bookkeeping
  // (lastSavedAt, pausedAt, performance counters), and per-client presentation
  // state - none of which may influence simulation outcomes.
  const projection = {};
  for (const key of HASH_INCLUDED_TOP_LEVEL) projection[key] = canonicalize(state?.[key]);
  const world = {};
  for (const key of HASH_INCLUDED_WORLD) world[key] = canonicalize(state?.world?.[key]);
  projection.world = world;
  projection.worldTimeMs = Math.floor(Number(state?.runtime?.worldTimeMs) || 0);
  return projection;
}

export function gameplayStateHash(state) {
  return fnv1a(JSON.stringify(gameplayStateProjection(state)));
}
