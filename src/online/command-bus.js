import { appendCommand, createCommandLog } from './command-log.js';
import { createDefaultCommandRegistry } from './commands.js';
import { worldNow } from '../core/utilities.js';

export const COMMAND_LOG_MAX_ENTRIES = 1000;

export function ensureRuntimeCommandLog(state, { maxEntries = COMMAND_LOG_MAX_ENTRIES } = {}) {
  state.runtime ??= {};
  const source = state.runtime.commandLog;
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
  const nextSeq = Math.max(
    Math.floor(Number(source?.nextSeq) || 0),
    commands.reduce((max, command) => Math.max(max, command.seq + 1), 1)
  );
  state.runtime.commandLog = {
    version: 1,
    nextSeq,
    commands: commands.slice(Math.max(0, commands.length - Math.max(1, maxEntries)))
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

  execute(type, payload = {}, { reason = null, emit = true, validate = true } = {}) {
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
