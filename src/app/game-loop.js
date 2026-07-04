import { performanceProfile } from './performance-profile.js';
import { LifecycleState } from '../core/constants.js';

export class GameLoop {
  constructor({ store, combatSystem, civilizationSystem = null, roadsideSupplySystem = null, renderer, saveRepository, onUiUpdate, onError, onSaveDisabled, getPerformanceProfile = null }) {
    this.store = store;
    this.combatSystem = combatSystem;
    this.civilizationSystem = civilizationSystem;
    this.roadsideSupplySystem = roadsideSupplySystem;
    this.renderer = renderer;
    this.saveRepository = saveRepository;
    this.onUiUpdate = onUiUpdate;
    this.onError = onError;
    this.onSaveDisabled = onSaveDisabled;
    this.getPerformanceProfile = getPerformanceProfile ?? (() => performanceProfile('balanced'));
    this.running = false;
    this.frameId = null;
    this.lastTime = 0;
    this.renderAccumulator = 0;
    this.simulationAccumulator = 0;
    this.civilizationAccumulator = 0;
    this.uiClock = 0;
    this.saveClock = 0;
    this.autoSaveDisabled = !saveRepository.isAvailable();
    this.saveTask = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.renderAccumulator = 0;
    this.frameId = requestAnimationFrame(time => this.frame(time));
  }

  trySave({ sync = false } = {}) {
    if (this.autoSaveDisabled || !this.saveRepository.isAvailable()) return false;
    try {
      const snapshot = this.store.persistenceSnapshot();
      if (sync || typeof this.saveRepository.saveDetachedStateAsync !== 'function') {
        const savedAt = this.saveRepository.saveDetachedState(snapshot);
        this.store.transaction(state => { state.runtime.lastSavedAt = savedAt; }, 'save:timestamp');
        return true;
      }
      this.saveRepository.saveDetachedStateAsync(snapshot)
        .then(savedAt => {
          if (savedAt) this.store.transaction(state => { state.runtime.lastSavedAt = savedAt; }, 'save:timestamp');
        })
        .catch(error => {
          this.autoSaveDisabled = true;
          this.onSaveDisabled?.(error);
          this.onError?.(error);
        });
      return true;
    } catch (error) {
      this.autoSaveDisabled = true;
      this.onSaveDisabled?.(error);
      this.onError?.(error);
      return false;
    }
  }


  scheduleSave() {
    if (this.saveTask || this.autoSaveDisabled) return;
    const run = () => {
      this.saveTask = null;
      if (this.running) this.trySave();
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      this.saveTask = { type: 'idle', id: globalThis.requestIdleCallback(run, { timeout: 2000 }) };
    } else {
      this.saveTask = { type: 'timeout', id: globalThis.setTimeout?.(run, 0) };
    }
  }

  cancelScheduledSave() {
    if (!this.saveTask) return;
    if (this.saveTask.type === 'idle') globalThis.cancelIdleCallback?.(this.saveTask.id);
    else globalThis.clearTimeout?.(this.saveTask.id);
    this.saveTask = null;
  }

  updateSimulation(deltaSeconds, profile) {
    this.simulationAccumulator += deltaSeconds;
    const simulationStep = 1 / profile.simulationHz;
    const steps = Math.min(profile.maxCatchUpSteps, Math.floor(this.simulationAccumulator / simulationStep));
    if (steps <= 0) return false;
    this.simulationAccumulator -= steps * simulationStep;
    // Clamp the residual accumulator: after a long requestAnimationFrame gap
    // (tab throttling that never fired visibilitychange, severe jank) the
    // remainder would otherwise force max catch-up steps every frame and the
    // game would fast-forward for a long stretch. Large real-time gaps are the
    // offline simulator's job, not the frame loop's.
    if (this.simulationAccumulator > simulationStep) this.simulationAccumulator = simulationStep;

    this.store.advance(state => {
      for (let index = 0; index < steps; index += 1) {
        state.runtime.worldTimeMs = (state.runtime.worldTimeMs ?? Date.now()) + simulationStep * 1000;
        this.combatSystem.update(state, simulationStep);
        if (state.lifecycle === LifecycleState.DESTROYED || state.runtime?.gameOver) break;
        this.roadsideSupplySystem?.update(state, simulationStep);
        this.civilizationAccumulator += simulationStep;
        const civilizationStep = 1 / profile.civilizationHz;
        if (this.civilizationSystem && this.civilizationAccumulator + 1e-9 >= civilizationStep) {
          this.civilizationSystem.update(state, this.civilizationAccumulator);
          this.civilizationAccumulator = 0;
        }
      }
      state.runtime.performance.frames += 1;
      state.runtime.performance.lastFrameMs = deltaSeconds * 1000;
      if (deltaSeconds > 0.05) state.runtime.performance.slowFrames += 1;
    }, 'game:tick');
    return true;
  }

  frame(time) {
    if (!this.running) return;
    const deltaSeconds = Math.max(0, (time - this.lastTime) / 1000);
    this.lastTime = time;
    const profile = this.getPerformanceProfile();
    this.updateSimulation(deltaSeconds, profile);
    if (!this.running) return;

    this.renderAccumulator += deltaSeconds;
    const renderStep = 1 / profile.renderHz;
    if (this.renderAccumulator + 1e-9 >= renderStep) {
      this.renderAccumulator = Math.max(0, this.renderAccumulator - renderStep);
      if (this.renderAccumulator >= renderStep) this.renderAccumulator %= renderStep;
      this.renderer.render(time);
    }

    this.uiClock += deltaSeconds;
    this.saveClock += deltaSeconds;
    if (this.uiClock >= 1 / profile.uiHz) {
      this.uiClock = 0;
      this.onUiUpdate?.();
    }
    if (this.saveClock >= 15) {
      this.saveClock = 0;
      this.scheduleSave();
    }
    this.frameId = requestAnimationFrame(next => this.frame(next));
  }

  stop({ save = true, syncSave = false } = {}) {
    if (!this.running) return;
    this.running = false;
    if (this.frameId != null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.cancelScheduledSave();
    if (save) this.trySave({ sync: syncSave });
  }
}
