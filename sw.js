'use strict';
const CACHE_PREFIX = 'frontline-roads-';
const RELEASE_VERSION = '0.38.79';
const CACHE_NAME = `${CACHE_PREFIX}v0-38-79-phase5-command-log-replay-hardening`;
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './src/app/bootstrap.js',
  './src/app/game-loop.js',
  './src/app/performance-profile.js',
  './src/app/lifecycle.js',
  './src/app/pwa.js',
  './src/base/base-graph.js',
  './src/base/base-placement-service.js',
  './src/base/base-state.js',
  './src/base/base-pressure.js',
  './src/base/base-removal.js',
  './src/base/region-control.js',
  './src/base/construction-range.js',
  './src/base/field-bases.js',
  './src/base/field-base-system.js',
  './src/base/player-bases.js',
  './src/base/player-base-system.js',
  './src/civilization/abilities.js',
  './src/civilization/bottleneck-diagnostics.js',
  './src/civilization/daily-missions.js',
  './src/civilization/civilization-system.js',
  './src/civilization/data.js',
  './src/civilization/defense-upgrade.js',
  './src/civilization/inventory-system.js',
  './src/civilization/production-system.js',
  './src/civilization/progression-system.js',
  './src/civilization/repair-cost.js',
  './src/civilization/settlement-system.js',
  './src/civilization/unlock-table.js',
  './src/combat/build-system.js',
  './src/combat/build-site-planner.js',
  './src/combat/combat-geometry.js',
  './src/combat/combat-initializer.js',
  './src/combat/combat-system.js',
  './src/combat/combat-spatial-index.js',
  './src/combat/defense-lifecycle.js',
  './src/combat/defense-system.js',
  './src/combat/defense-presentation.js',
  './src/combat/definitions.js',
  './src/combat/enemy-system.js',
  './src/combat/enemy-grouping.js',
  './src/combat/enemy-scaling.js',
  './src/combat/operation-tempo.js',
  './src/combat/enemy-base-system.js',
  './src/combat/enemy-base-placement.js',
  './src/combat/enemy-personalities.js',
  './src/combat/friendly-force-definitions.js',
  './src/combat/friendly-healing-system.js',
  './src/combat/friendly-recovery-system.js',
  './src/combat/friendly-force-system.js',
  './src/combat/friendly-route-planner.js',
  './src/combat/road-unit-position.js',
  './src/combat/region-activity.js',
  './src/combat/siege-event.js',
  './src/combat/routing-system.js',
  './src/combat/wave-system.js',
  './src/core/constants.js',
  './src/core/errors.js',
  './src/core/recovery-balance.js',
  './src/core/home-base-destruction.js',
  './src/core/event-bus.js',
  './src/core/state-schema.js',
  './src/core/state-store.js',
  './src/core/runtime-state.js',
  './src/core/state-normalizer.js',
  './src/core/utilities.js',
  './src/i18n/catalog.js',
  './src/i18n/runtime-messages.generated.js',
  './src/i18n/runtime-messages.en.generated.js',
  './src/i18n/runtime-messages.zh.generated.js',
  './src/i18n/runtime-messages.zh-TW.generated.js',
  './src/i18n/runtime-messages.ko.generated.js',
  './src/i18n/runtime-messages.vi.generated.js',
  './src/i18n/runtime-messages.pt-BR.generated.js',
  './src/i18n/runtime-messages.tr.generated.js',
  './src/i18n/runtime-messages.id.generated.js',
  './src/i18n/runtime-messages.ru.generated.js',
  './src/i18n/runtime-messages.es-419.generated.js',
  './src/i18n/runtime-messages.ja.generated.js',
  './src/online/command-log.js',
  './src/online/command-bus.js',
  './src/online/commands.js',
  './src/exploration/frontier-system.js',
  './src/exploration/exploration-system.js',
  './src/exploration/recovery-system.js',
  './src/exploration/roadside-supplies.js',
  './src/exploration/survey-system.js',
  './src/location/geolocation-service.js',
  './src/location/location-privacy.js',
  './src/persistence/legacy-save-migration.js',
  './src/persistence/offline-fill-policy.js',
  './src/persistence/offline-simulator.js',
  './src/persistence/road-chunk-cache.js',
  './src/persistence/road-graph-codec.js',
  './src/persistence/save-body-store.js',
  './src/persistence/save-repository.js',
  './src/persistence/storage-access.js',
  './src/persistence/tab-coordinator.js',
  './src/rendering/camera.js',
  './src/rendering/build-placement-overlay.js',
  './src/rendering/combat-renderer.js',
  './src/rendering/frontier-renderer.js',
  './src/rendering/friendly-order-overlay.js',
  './src/rendering/combat-effects.js',
  './src/rendering/renderer.js',
  './src/rendering/radar-renderer.js',
  './src/rendering/threat-analysis.js',
  './src/rendering/tactical-overlay.js',
  './src/rendering/road-renderer.js',
  './src/roads/geometry.js',
  './src/roads/graph-merge.js',
  './src/roads/graph-cleanup.js',
  './src/roads/intersection-clustering.js',
  './src/roads/overpass-client.js',
  './src/roads/sandbox-jsonp-transport.js',
  './src/roads/road-constants.js',
  './src/roads/road-filter.js',
  './src/roads/road-elevation.js',
  './src/roads/road-graph.js',
  './src/roads/road-parser.js',
  './src/roads/road-service.js',
  './src/roads/road-topology-repair.js',
  './src/roads/road-world-manager.js',
  './src/roads/world-chunk-grid.js',
  './src/styles/app.css',
  './src/ui/base-placement-screen.js',
  './src/ui/base-command-ui.js',
  './src/ui/civilization-ui.js',
  './src/ui/combat-ui.js',
  './src/ui/deployment-ui.js',
  './src/ui/dom.js',
  './src/ui/map-input.js',
  './src/ui/menu-ui.js',
  './src/ui/notifications.js',
  './src/ui/operation-guidance.js',
  './src/ui/radar-preferences.js',
  './src/ui/roadside-supplies-ui.js'
];

const NETWORK_TIMEOUT_MS = 4500;

function fetchWithTimeout(request, timeoutMs = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function cacheResponse(request, response) {
  if (response?.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

function canonicalRequest(request) {
  const url = new URL(request.url);
  const requestedVersion = url.searchParams.get('v');
  if (requestedVersion && requestedVersion !== RELEASE_VERSION) return null;
  url.search = '';
  return new Request(url.href, { method: 'GET', headers: request.headers, mode: request.mode, credentials: request.credentials, redirect: request.redirect });
}

async function serveApplicationAsset(request) {
  // Cache-first without background revalidation: application assets are
  // immutable within a release (the cache name embeds the release version and
  // install pre-caches the full shell), so re-fetching on every hit only
  // wasted bandwidth. Updates arrive through a new release cache.
  const cache = await caches.open(CACHE_NAME);
  const direct = await cache.match(request);
  const canonical = direct ? null : canonicalRequest(request);
  const cached = direct ?? (canonical ? await cache.match(canonical) : null);
  if (cached) return cached;
  try {
    return await cacheResponse(request, await fetchWithTimeout(request));
  } catch {
    return Response.error();
  }
}

async function serveNavigation(request) {
  const url = new URL(request.url);
  const refreshRequested = url.searchParams.get('refresh');
  try {
    const fetchRequest = refreshRequested ? new Request(request, { cache: 'reload' }) : request;
    return await cacheResponse(request, await fetchWithTimeout(fetchRequest));
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match('./index.html') ?? Response.error();
  }
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(serveNavigation(event.request));
    return;
  }
  event.respondWith(serveApplicationAsset(event.request));
});
