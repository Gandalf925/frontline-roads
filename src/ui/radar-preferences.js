const STORAGE_KEY = 'frontline_roads_radar_preferences_v2';
const QUALITY_VALUES = ['minimal', 'balanced', 'full'];

function safeStorage(environment = globalThis) {
  try {
    const storage = environment.localStorage;
    const key = `${STORAGE_KEY}_probe`;
    storage?.setItem(key, '1');
    storage?.removeItem(key);
    return storage ?? null;
  } catch {
    return null;
  }
}

export function suggestedRadarQuality(environment = globalThis) {
  const navigatorValue = environment.navigator ?? {};
  const coarsePointer = environment.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const touchDevice = Number(navigatorValue.maxTouchPoints ?? 0) > 0;
  const memory = Number(navigatorValue.deviceMemory ?? 0);
  const cores = Number(navigatorValue.hardwareConcurrency ?? 0);
  if (coarsePointer || touchDevice || (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4)) return 'minimal';
  return 'balanced';
}

function defaultPreferences(environment = globalThis) {
  const reduced = environment.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const quality = suggestedRadarQuality(environment);
  return {
    quality,
    motion: !reduced,
  };
}

function normalize(value, environment = globalThis) {
  const defaults = defaultPreferences(environment);
  return {
    quality: QUALITY_VALUES.includes(value?.quality) ? value.quality : defaults.quality,
    motion: typeof value?.motion === 'boolean' ? value.motion : defaults.motion
  };
}

function next(values, current) {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length];
}

const QUALITY_MESSAGE_KEYS = Object.freeze({
  full: 'radar.qualityFull',
  balanced: 'radar.qualityBalanced',
  minimal: 'radar.qualityMinimal'
});

export class RadarPreferences {
  constructor({ onChange = null, storage = undefined, documentRef = globalThis.document, environment = globalThis, i18n = null } = {}) {
    this.onChange = onChange;
    this.environment = environment;
    this.i18n = i18n;
    this.storage = storage === undefined ? safeStorage(environment) : storage;
    this.document = documentRef;
    this.value = this.load();
    this.qualityButton = this.document?.querySelector('#radarQualityButton') ?? null;
    this.motionButton = this.document?.querySelector('#radarMotionButton') ?? null;
    this.qualityButton?.addEventListener('click', () => this.update({ quality: next(QUALITY_VALUES, this.value.quality) }));
    this.motionButton?.addEventListener('click', () => this.update({ motion: !this.value.motion }));
    this.apply();
  }

  load() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      return normalize(raw ? JSON.parse(raw) : null, this.environment);
    } catch {
      return defaultPreferences(this.environment);
    }
  }

  save() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.value)); } catch { /* visual settings remain session-only */ }
  }

  update(patch) {
    this.value = normalize({ ...this.value, ...patch }, this.environment);
    this.save();
    this.apply();
  }

  msg(key, params = {}, fallback = '') {
    return this.i18n?.message?.(key, params, fallback) ?? String(fallback || key);
  }

  qualityLabel() {
    const key = QUALITY_MESSAGE_KEYS[this.value.quality] ?? QUALITY_MESSAGE_KEYS.balanced;
    return this.msg(key, {}, this.value.quality === 'full' ? 'High detail' : this.value.quality === 'minimal' ? 'Power saving' : 'Standard');
  }

  refreshLocalization() {
    if (this.qualityButton) this.qualityButton.textContent = this.msg('radar.qualityButton', { quality: this.qualityLabel() }, 'Display quality: {quality}');
    if (this.motionButton) {
      this.motionButton.textContent = this.msg('radar.motionButton', { state: this.value.motion ? 'ON' : 'OFF' }, 'Animation: {state}');
      this.motionButton.setAttribute('aria-pressed', String(this.value.motion));
    }
  }

  apply() {
    const root = this.document?.documentElement;
    if (root) {
      root.dataset.radarQuality = this.value.quality;
      root.dataset.radarMotion = this.value.motion ? 'on' : 'off';
    }
    this.refreshLocalization();
    this.onChange?.({ ...this.value });
  }

  get() {
    return { ...this.value };
  }
}
