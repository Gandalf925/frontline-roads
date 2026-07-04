export const APP_VERSION = '0.38.80-phase5-pages-runtime-hotfix';
export const SAVE_KEY = 'frontline_roads_refactor_v2';
export const SCHEMA_VERSION = 2;

export const LifecycleState = Object.freeze({
  BOOT: 'BOOT',
  LOAD_SAVE: 'LOAD_SAVE',
  MIGRATION: 'MIGRATION',
  LOCATION_REQUIRED: 'LOCATION_REQUIRED',
  ROAD_LOADING: 'ROAD_LOADING',
  BASE_SELECTION: 'BASE_SELECTION',
  INITIALIZING: 'INITIALIZING',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
  DESTROYED: 'DESTROYED'
});

export const ALLOWED_TRANSITIONS = Object.freeze({
  BOOT: ['LOAD_SAVE', 'DESTROYED'],
  LOAD_SAVE: ['MIGRATION', 'LOCATION_REQUIRED', 'PLAYING', 'ERROR', 'DESTROYED'],
  MIGRATION: ['LOCATION_REQUIRED', 'PLAYING', 'ERROR', 'DESTROYED'],
  LOCATION_REQUIRED: ['ROAD_LOADING', 'ERROR', 'DESTROYED'],
  ROAD_LOADING: ['BASE_SELECTION', 'LOCATION_REQUIRED', 'ERROR', 'DESTROYED'],
  BASE_SELECTION: ['INITIALIZING', 'LOCATION_REQUIRED', 'ERROR', 'DESTROYED'],
  INITIALIZING: ['PLAYING', 'ERROR', 'DESTROYED'],
  PLAYING: ['PAUSED', 'ERROR', 'DESTROYED'],
  PAUSED: ['PLAYING', 'ERROR', 'DESTROYED'],
  ERROR: ['LOCATION_REQUIRED', 'LOAD_SAVE', 'DESTROYED'],
  DESTROYED: []
});

export const ROAD_CONFIG = Object.freeze({
  selectionRadiusMeters: 1000,
  fetchRadiusMeters: 1500,
  initialRetentionRadiusMeters: 1250,
  initialPreviewDelayMs: 1200,
  initialPreviewFetchRadiusMeters: 1150,
  initialPreviewRetentionRadiusMeters: 1050,
  initialPreviewMinimumRawSegments: 14,
  initialBaseCoverageRadiusMeters: 1500,
  initialFallbackMinimumRawSegments: 8,
  initialFallbackMinimumIntegratedSegments: 6,
  initialOverpassTimeoutMs: 8000,
  minimumRoadSegments: 12,
  walkRefreshMeters: 80,
  chunkSizeMeters: 1000,
  chunkPreloadRadius: 1,
  chunkRetainRadius: 2,
  chunkFetchRadiusMeters: 850,
  chunkRetentionRadiusMeters: 780,
  chunkMinimumRawSegments: 8,
  chunkMinimumIntegratedSegments: 4,
  chunkRequestCooldownMs: 8000,
  chunkMaxParallelRequests: 2,
  chunkMaxPerTick: 2,
  chunkMaxPerMinute: 18,
  chunkCacheMaxEntries: 160,
  chunkCacheMaxBytes: 7_000_000,
  roadWorldSaveMaxLoadedChunks: 40,
  surveyChunkRadius: 2,
  surveyMaxChunksPerFacility: 3,
  surveyInitialDelayMs: 12_000,
  surveyCooldownMs: 20_000,
  surveyRetryCooldownMs: 45_000,
  surveyMaxIntegratedChunksPerTick: 2,
  surveyMaxRequestsPerMinute: 5,
  privacyGridMeters: 25,
  locationHighAccuracyMs: 6000,
  locationLowAccuracyMs: 45000,
  locationIdleAfterMs: 25000,
  locationMovementThresholdMeters: 25
});
