import { appendCommand, createCommandLog } from './command-log.js';
import { createDefaultCommandRegistry } from './commands.js';
import { worldNow } from '../core/utilities.js';

export const COMMAND_LOG_MAX_ENTRIES = 1000;

function commandLogNextSeq(commands = [], fallback = 1) {
  return Math.max(
    Math.floor(Number(fallback) || 0),
    commands.reduce((max, command) => Math.max(max, Math.max(1, Math.floor(Number(command?.seq) || 0)) + 1), 1)
  );
}

export function ensureRuntimeCommandLog(state, { maxEntries = COMMAND_LOG_MAX_ENTRIES } = {}) {
  state.runtime ??= {};
  const cap = Math.max(1, Math.floor(Number(maxEntries) || COMMAND_LOG_MAX_ENTRIES));
  const source = state.runtime.commandLog;

  // Hot path: current saves already hold normalized command entries. Do not
  // deep-clone the entire log on every UI command; that scales linearly with
  // play history and causes visible input lag during build/upgrade actions.
  if (source && source.version === 1 && Array.isArray(source.commands)) {
    source.nextSeq = commandLogNextSeq(source.commands, source.nextSeq);
    if (source.commands.length > cap) source.commands.splice(0, source.commands.length - cap);
    state.runtime.commandLog = source;
    return source;
  }

  const commands = Array.isArray(source?.commands)
    ? source.commands
        .filter(command => command && typeof command.type === 'string')
        .map(command => ({
          seq: Math.max(1, Math.floor(Number(command.seq) || 0)),
          atMs: Math.max(0, Math.floor(Number(command.atMs) || 0)),
          type: String(command.type),
          payload: JSON.parse(JSON.stringify(command.payload ?? {}))
        }))
        .filter(command => command.seq > 0)
    : [];
  state.runtime.commandLog = {
    version: 1,
    nextSeq: commandLogNextSeq(commands, source?.nextSeq),
    commands: commands.slice(Math.max(0, commands.length - cap))
  };
  return state.runtime.commandLog;
}

function trimCommandLog(log, maxEntries) {
  const cap = Math.max(1, Math.floor(Number(maxEntries) || COMMAND_LOG_MAX_ENTRIES));
  if (log.commands.length > cap) log.commands.splice(0, log.commands.length - cap);
  return log;
}

export class CommandBus {
  constructor({ store, registry = createDefaultCommandRegistry(), events = null, maxEntries = COMMAND_LOG_MAX_ENTRIES } = {}) {
    if (!store) throw new Error('CommandBus requires a StateStore');
    this.store = store;
    this.registry = registry;
    this.events = events;
    this.maxEntries = maxEntries;
  }

  has(type) {
    return this.registry.has(type);
  }

  types() {
    return this.registry.types();
  }

  execute(type, payload = {}, { reason = null, emit = false, validate = true } = {}) {
    let result;
    let recorded = null;
    const commandType = String(type ?? '');
    if (!commandType || !this.registry.has(commandType)) {
      return { ok: false, reasonKey: 'reason.command.unknownType', reasonParams: { type: commandType }, reason: `Unknown command type: ${commandType}` };
    }

    this.store.transaction(state => {
      result = this.registry.execute(state, { type: commandType, payload }, this.events);
      if (result?.ok) {
        const log = ensureRuntimeCommandLog(state, { maxEntries: this.maxEntries });
        recorded = appendCommand(log, { type: commandType, payload }, worldNow(state));
        trimCommandLog(log, this.maxEntries);
      }
      return result;
    }, reason ?? `command:${commandType}`, { emit, validate });

    if (result?.ok && recorded) return { ...result, command: recorded };
    return result ?? { ok: false };
  }

  logSnapshot() {
    return this.store.read(state => state.runtime?.commandLog ?? createCommandLog());
  }
}

export function createEmptyRuntimeCommandLog() {
  return createCommandLog();
}
