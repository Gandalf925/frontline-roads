import { AppError, ErrorCode } from '../core/errors.js';

function keyedError(code, messageKey, fallback, options = {}) {
  return new AppError(code, fallback, { ...options, messageKey, fallback });
}

function mapGeolocationError(error) {
  switch (error?.code) {
    case 1: return keyedError(ErrorCode.GEOLOCATION_DENIED, 'error.geolocationDenied', '位置情報の利用が許可されていません。ブラウザ設定から許可してください。');
    case 2: return keyedError(ErrorCode.GEOLOCATION_UNAVAILABLE, 'error.geolocationUnavailable', '現在地を取得できませんでした。屋外または窓際で再試行してください。');
    case 3: return keyedError(ErrorCode.GEOLOCATION_TIMEOUT, 'error.geolocationTimeout', '位置情報の取得がタイムアウトしました。');
    default: return keyedError(ErrorCode.GEOLOCATION_UNAVAILABLE, 'error.geolocationFailed', '位置情報の取得に失敗しました。');
  }
}

function normalizedPosition(position) {
  return {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: position.timestamp
  };
}

export class GeolocationService {
  constructor(geolocation = globalThis.navigator?.geolocation) {
    this.geolocation = geolocation;
  }

  async getCurrentPosition(options = {}) {
    if (!this.geolocation) throw keyedError(ErrorCode.GEOLOCATION_UNSUPPORTED, 'error.geolocationUnsupported', 'このブラウザは位置情報に対応していません。', { recoverable: false });
    const settings = { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000, ...options };
    return new Promise((resolve, reject) => {
      this.geolocation.getCurrentPosition(
        position => resolve(normalizedPosition(position)),
        error => reject(mapGeolocationError(error)),
        settings
      );
    });
  }

  watchPosition(onPosition, onError = null, options = {}) {
    if (!this.geolocation) return () => {};
    const settings = { enableHighAccuracy: true, timeout: 25000, maximumAge: 10000, ...options };
    const watchId = this.geolocation.watchPosition(
      position => onPosition(normalizedPosition(position)),
      error => onError?.(mapGeolocationError(error)),
      settings
    );
    return () => this.geolocation.clearWatch(watchId);
  }
}

const EARTH_RADIUS_METERS = 6371000;

function haversineMeters(a, b) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const ADAPTIVE_WATCH_DEFAULTS = Object.freeze({
  idleAfterMs: 120000,
  movementThresholdMeters: 15,
  highAccuracyOptions: Object.freeze({ enableHighAccuracy: true, timeout: 25000, maximumAge: 10000 }),
  lowAccuracyOptions: Object.freeze({ enableHighAccuracy: false, timeout: 30000, maximumAge: 30000 })
});

export class AdaptiveLocationWatcher {
  // Battery-aware wrapper around GeolocationService.watchPosition(). While the
  // player keeps moving, the GPS runs at high accuracy. After idleAfterMs
  // without significant movement the watch restarts at low accuracy with a
  // longer maximumAge; the first fix that shows movement again switches the
  // watch back to high accuracy.
  constructor(service, { now = () => Date.now(), ...options } = {}) {
    this.service = service;
    this.now = now;
    this.options = { ...ADAPTIVE_WATCH_DEFAULTS, ...options };
    this.stopCurrent = null;
    this.mode = 'high';
    this.lastPosition = null;
    this.lastMovementAt = null;
    this.active = false;
  }

  start(onPosition, onError = null) {
    this.stop();
    this.active = true;
    this.lastPosition = null;
    this.lastMovementAt = this.now();
    this.onPosition = onPosition;
    this.onError = onError;
    this.beginWatch('high');
    return () => this.stop();
  }

  beginWatch(mode) {
    if (!this.active) return;
    this.stopCurrent?.();
    this.mode = mode;
    const options = mode === 'high' ? this.options.highAccuracyOptions : this.options.lowAccuracyOptions;
    this.stopCurrent = this.service.watchPosition(
      position => this.handlePosition(position),
      error => this.onError?.(error),
      options
    );
  }

  handlePosition(position) {
    if (!this.active) return;
    const timestamp = this.now();
    const moved = this.lastPosition
      ? haversineMeters(this.lastPosition, position) >= this.options.movementThresholdMeters
      : false;
    if (moved || !this.lastPosition) {
      this.lastMovementAt = timestamp;
      this.lastPosition = { lat: position.lat, lon: position.lon };
    }
    if (this.mode === 'high' && !moved && timestamp - this.lastMovementAt >= this.options.idleAfterMs) {
      this.beginWatch('low');
    } else if (this.mode === 'low' && moved) {
      this.beginWatch('high');
    }
    this.onPosition?.(position);
  }

  stop() {
    this.active = false;
    this.stopCurrent?.();
    this.stopCurrent = null;
  }
}
