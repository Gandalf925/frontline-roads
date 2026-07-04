import { ALLOWED_TRANSITIONS, LifecycleState } from './constants.js';
import { AppError, ErrorCode } from './errors.js';
import { deepClone, worldNow } from './utilities.js';
import { cloneRuntimeState } from './runtime-state.js';
import { attachGraphIndexes } from '../roads/road-graph.js';
import { validateState } from './state-schema.js';


const TERMINAL_TRANSACTION_PREFIXES = Object.freeze([
  'save:',
  'game-over:',
  'tab:fresh-save-rehydrated'
]);

function isTerminalState(state) {
  return state?.lifecycle === LifecycleState.DESTROYED || Boolean(state?.runtime?.gameOver);
}

function canMutateTerminalState(reason) {
  return TERMINAL_TRANSACTION_PREFIXES.some(prefix => String(reason ?? '').startsWith(prefix));
}

function terminalResult() {
  return { ok: false, reasonKey: 'reason.gameOver.locked', reason: '作戦は終了しています。戦況確認または新規開始のみ実行できます。' };
}

function stateError(errors) {
  return new AppError(ErrorCode.INVALID_STATE, errors.join(', '), { recoverable: false });
}

export class StateStore {
  #state;
  #events;
  #cloneState;
  #uiGraphSource = null;
  #uiGraphSnapshot = null;

  constructor(initialState, eventBus, { cloneState = cloneRuntimeState } = {}) {
    const validation = validateState(initialState);
    if (!validation.valid) throw stateError(validation.errors);
    this.#cloneState = cloneState;
    this.#state = this.#cloneState(initialState);
    this.#events = eventBus;
  }

  snapshot() {
    return this.#cloneState(this.#state);
  }

  persistenceSnapshot() {
    return deepClone(this.#state);
  }

  uiSnapshot() {
    const graph = this.#state.world?.roadGraph ?? null;
    if (graph !== this.#uiGraphSource) {
      const graphSnapshot = graph ? attachGraphIndexes(deepClone(graph)) : null;
      this.#uiGraphSource = graph;
      this.#uiGraphSnapshot = graphSnapshot;
    }
    const world = this.#state.world ?? {};
    const snapshot = deepClone({
      ...this.#state,
      world: { ...world, roadGraph: null }
    });
    if (snapshot.world) snapshot.world.roadGraph = this.#uiGraphSnapshot;
    return snapshot;
  }

  read(selector) {
    const value = selector(this.#state);
    return value && typeof value === 'object' ? deepClone(value) : value;
  }

  renderView() {
    return this.#state;
  }

  transaction(mutator, reason = 'state:transaction', { emit = false, validate = true } = {}) {
    if (isTerminalState(this.#state) && !canMutateTerminalState(reason)) return terminalResult();
    return this.#events.transaction(() => {
      const draft = this.#cloneState(this.#state);
      const result = mutator(draft);
      if (result && typeof result.then === 'function') throw new TypeError('State transactions must be synchronous');
      draft.runtime.updatedAt = worldNow(draft) || draft.runtime.updatedAt || draft.runtime.createdAt || 0;
      if (validate) {
        const validation = validateState(draft);
        if (!validation.valid) throw stateError(validation.errors);
      }
      this.#state = draft;
      if (emit) this.#events.emit('state:changed', { reason, state: this.snapshot() });
      return result;
    });
  }

  advance(mutator, reason = 'state:advance', { emit = false, validate = false } = {}) {
    if (isTerminalState(this.#state) && !canMutateTerminalState(reason)) return undefined;
    const result = mutator(this.#state);
    this.#state.runtime.updatedAt = worldNow(this.#state) || this.#state.runtime.updatedAt || this.#state.runtime.createdAt || 0;
    if (validate) {
      const validation = validateState(this.#state);
      if (!validation.valid) throw stateError(validation.errors);
    }
    if (emit) this.#events.emit('state:changed', { reason, state: this.snapshot() });
    return result;
  }

  transition(nextLifecycle, metadata = null) {
    const current = this.#state.lifecycle;
    const allowed = ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(nextLifecycle)) {
      throw new AppError(
        ErrorCode.INVALID_TRANSITION,
        `Invalid lifecycle transition: ${current} -> ${nextLifecycle}`,
        { recoverable: false }
      );
    }
    this.transaction(draft => { draft.lifecycle = nextLifecycle; }, 'lifecycle:transition');
    this.#events.emit('lifecycle:changed', { previous: current, current: nextLifecycle, metadata });
  }

  replace(state, reason = 'state:replace') {
    const validation = validateState(state);
    if (!validation.valid) throw stateError(validation.errors);
    this.#state = this.#cloneState(state);
    this.#events.emit('state:changed', { reason, state: this.snapshot() });
  }

  setError(error) {
    this.transaction(draft => {
      draft.runtime.lastError = {
        code: error?.code ?? 'UNKNOWN',
        message: error?.message ?? String(error),
        details: error?.details ?? null,
        at: worldNow(draft) || draft.runtime.updatedAt || draft.runtime.createdAt || 0
      };
    }, 'error:set');
    if (this.#state.lifecycle !== LifecycleState.ERROR) this.transition(LifecycleState.ERROR, error);
  }
}
