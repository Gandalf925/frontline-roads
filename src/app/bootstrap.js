import { APP_VERSION, LifecycleState, ROAD_CONFIG } from '../core/constants.js';

import { EventBus } from '../core/event-bus.js';
import { createInitialState } from '../core/state-schema.js';
import { StateStore } from '../core/state-store.js';
import { cloneRuntimeState } from '../core/runtime-state.js';
import { LifecycleController } from './lifecycle.js';
import { GeolocationService, AdaptiveLocationWatcher } from '../location/geolocation-service.js';
import { latLonToXY } from '../location/location-privacy.js';
import { OverpassClient } from '../roads/overpass-client.js';
import { RoadService } from '../roads/road-service.js';
import { RoadWorldManager } from '../roads/road-world-manager.js';
import { chunkForWorldPoint, chunkFullyInsideCircle, createRoadChunkState, ensureRoadChunkState, graphCoveredChunkIds, parseChunkId } from '../roads/world-chunk-grid.js';
import { normalizeRuntimeState } from '../core/state-normalizer.js';
import { BasePlacementService } from '../base/base-placement-service.js';
import { hasEstablishedHomeBase } from '../base/base-state.js';
import { SaveRepository } from '../persistence/save-repository.js';
import { RoadChunkCache } from '../persistence/road-chunk-cache.js';
import { Camera } from '../rendering/camera.js';
import { Renderer } from '../rendering/renderer.js';
import { MapInput } from '../ui/map-input.js';
import { BasePlacementScreen } from '../ui/base-placement-screen.js';
import { Notifications } from '../ui/notifications.js';
import { queryRequired, setVisible } from '../ui/dom.js';
import { initializeCombatState } from '../combat/combat-initializer.js';
import { CombatSystem } from '../combat/combat-system.js';
import { BuildSystem } from '../combat/build-system.js';
import { CombatUi } from '../ui/combat-ui.js';
import { CivilizationUi } from '../ui/civilization-ui.js';
import { DeploymentUi } from '../ui/deployment-ui.js';
import { RoadsideSuppliesUi } from '../ui/roadside-supplies-ui.js';
import { BaseCommandUi } from '../ui/base-command-ui.js';
import { MenuUi } from '../ui/menu-ui.js';
import { RadarPreferences } from '../ui/radar-preferences.js';
import { GameLoop } from './game-loop.js';
import { OfflineSimulator } from '../persistence/offline-simulator.js';
import { CivilizationSystem } from '../civilization/civilization-system.js';
import { RoadsideSupplySystem } from '../exploration/roadside-supplies.js';
import { RESOURCE_LABELS } from '../civilization/data.js';
import { TabCoordinator } from '../persistence/tab-coordinator.js';
import { registerPwa } from './pwa.js';
import { I18nController } from '../i18n/catalog.js';
import { GAME_OVER_SOURCE, isGameOverState, markHomeBaseDestroyed } from '../core/home-base-destruction.js';
import { CommandBus } from '../online/command-bus.js';

const LIFECYCLE_LABEL_KEYS = Object.freeze({
  [LifecycleState.BOOT]: 'static.lifecycleBoot',
  [LifecycleState.LOAD_SAVE]: 'static.lifecycleLoadSave',
  [LifecycleState.MIGRATION]: 'static.lifecycleMigration',
  [LifecycleState.LOCATION_REQUIRED]: 'static.lifecycleLocationRequired',
  [LifecycleState.ROAD_LOADING]: 'static.lifecycleRoadLoading',
  [LifecycleState.BASE_SELECTION]: 'static.lifecycleBaseSelection',
  [LifecycleState.INITIALIZING]: 'static.lifecycleInitializing',
  [LifecycleState.PLAYING]: 'static.lifecyclePlaying',
  [LifecycleState.PAUSED]: 'static.lifecyclePaused',
  [LifecycleState.ERROR]: 'static.lifecycleError',
  [LifecycleState.DESTROYED]: 'static.lifecycleDestroyed'
});


async function clearFrontlineRoadsCaches() {
  try {
    const cacheStorage = globalThis.caches;
    if (!cacheStorage?.keys) return false;
    const keys = await cacheStorage.keys();
    await Promise.all(keys
      .filter(key => String(key).startsWith('frontline-roads-'))
      .map(key => cacheStorage.delete(key)));
    return true;
  } catch {
    return false;
  }
}

class FrontlineRoadsApp {
  constructor() {
    this.events = new EventBus();
    this.saveRepository = new SaveRepository();
    this.store = new StateStore(createInitialState(), this.events, { cloneState: cloneRuntimeState });
    this.commandBus = new CommandBus({ store: this.store, events: this.events });
    this.lifecycle = new LifecycleController(this.store);
    this.geolocation = new GeolocationService();
    this.roadService = new RoadService(new OverpassClient({
      fetchImpl: globalThis.fetch
    }));
    this.roadChunkCache = new RoadChunkCache();
    this.camera = new Camera();
    this.i18n = new I18nController();
    this.i18nReady = this.i18n.ensureLanguage?.().catch(error => {
      console.warn('Runtime language chunk failed to load; continuing with English fallback.', error);
      return this.i18n.language;
    });
    this.i18n.apply(globalThis.document);
    this.renderer = new Renderer(queryRequired('#mapCanvas'), this.camera);
    this.renderer.setStateProvider(() => this.store.renderView());
    this.renderer.bindEvents(this.events);
    this.radarPreferences = new RadarPreferences({ i18n: this.i18n, onChange: preferences => this.renderer.setPreferences(preferences) });
    this.baseScreen = new BasePlacementScreen(globalThis.document, { i18n: this.i18n });
    this.notifications = new Notifications(queryRequired('#notification'), { i18n: this.i18n });
    this.combatSystem = new CombatSystem(this.events);
    this.civilizationSystem = new CivilizationSystem(this.events);
    this.roadsideSupplySystem = new RoadsideSupplySystem(this.events);
    this.offlineSimulator = new OfflineSimulator({
      combatSystem: new CombatSystem(null),
      civilizationSystem: new CivilizationSystem(null),
      maximumStepSeconds: 1
    });
    this.buildSystem = new BuildSystem(this.events);
    this.combatUi = new CombatUi({
      store: this.store,
      buildSystem: this.buildSystem,
      civilizationSystem: this.civilizationSystem,
      recoverySystem: this.combatSystem.recoverySystem,
      friendlyForceSystem: this.combatSystem.friendlyForceSystem,
      roadsideSupplySystem: this.roadsideSupplySystem,
      commandBus: this.commandBus,
      camera: this.camera,
      renderer: this.renderer,
      notifications: this.notifications,
      i18n: this.i18n,
      persist: () => this.persist(),
      openDeployment: target => {
        if (target?.kind === 'enemyBase') this.deploymentUi?.openForEnemyBase(target.id);
        if (target?.kind === 'enemy') this.deploymentUi?.openForEnemy(target.id);
        if (target?.kind === 'recoveryItem') this.deploymentUi?.openForRecoveryItem(target.id);
      },
      requestSurvey: defenseId => this.roadWorld?.requestSurvey(defenseId)
    });
    this.roadWorld = new RoadWorldManager({
      roadService: this.roadService,
      cache: this.roadChunkCache,
      store: this.store,
      renderer: this.renderer,
      onGraphChanged: () => {
        this.store.transaction(state => {
          this.combatSystem.frontierSystem.reconcile(state);
        }, 'world:graph-expanded');
        this.combatUi.refreshBuildPlacement(true);
        this.combatUi.update();
        this.applyLocalization({ fullDocument: false });
        if (this.store.read(state => state.lifecycle) === LifecycleState.PLAYING) this.persist({ notify: false });
      },
      onStatus: status => {
        if ((status.type === 'loaded' || status.type === 'error') && status.key) this.notifications.show(status, 4500);
      }
    });
    this.deploymentUi = new DeploymentUi({
      store: this.store,
      friendlyForceSystem: this.combatSystem.friendlyForceSystem,
      commandBus: this.commandBus,
      notifications: this.notifications,
      i18n: this.i18n,
      persist: () => this.persist(),
      beginRoutePlanning: options => this.combatUi.beginDeploymentRoutePlanning(options)
    });
    this.baseCommandUi = new BaseCommandUi({
      store: this.store,
      i18n: this.i18n,
      playerBaseSystem: this.civilizationSystem.playerBases,
      fieldBaseSystem: this.civilizationSystem.fieldBases,
      commandBus: this.commandBus,
      renderer: this.renderer,
      notifications: this.notifications,
      persist: () => this.persist()
    });
    this.civilizationUi = new CivilizationUi({
      store: this.store,
      i18n: this.i18n,
      civilizationSystem: this.civilizationSystem,
      commandBus: this.commandBus,
      notifications: this.notifications,
      persist: () => this.persist()
    });
    this.roadsideSuppliesUi = new RoadsideSuppliesUi({
      store: this.store,
      i18n: this.i18n,
      roadsideSupplySystem: this.roadsideSupplySystem,
      commandBus: this.commandBus,
      notifications: this.notifications,
      persist: options => this.persist(options)
    });
    this.menuUi = new MenuUi({
      store: this.store,
      onSave: () => this.persist(),
      onReset: () => this.reset(),
      notifications: this.notifications,
      i18n: this.i18n,
      onLanguageChange: () => this.refreshLocalizedUi(),
      onOperationAction: action => this.handleOperationGuidanceAction(action)
    });
    this.gameLoop = new GameLoop({
      store: this.store,
      combatSystem: this.combatSystem,
      civilizationSystem: this.civilizationSystem,
      roadsideSupplySystem: this.roadsideSupplySystem,
      renderer: this.renderer,
      saveRepository: this.saveRepository,
      onUiUpdate: () => {
        const view = this.store.uiSnapshot();
        this.combatUi.update(view);
        this.deploymentUi.update(view);
        this.baseCommandUi.update(view);
        this.civilizationUi.update(view);
        this.roadsideSuppliesUi.update(view);
        this.menuUi.update(view);
        this.applyLocalization({ fullDocument: false });
        this.roadWorld.considerSurveyFacilities();
      },
      onError: error => this.notifications.show(this.errorPayload(error, 'app.saveFailed'), 4500),
      onSaveDisabled: () => this.updateStorageUi(),
      getPerformanceProfile: () => this.renderer.getPerformanceProfile()
    });
    this.selection = null;
    this.basePlacement = null;
    this.roadLoadController = null;
    this.initialRoadExpansionPending = false;
    this.initialRoadFallback = false;
    this.baseConfirmationPending = false;
    this.startupGeneration = 0;
    this.stopLocationWatch = null;
    this.criticalSaveQueued = false;
    this.celebrationTimer = null;
    this.baseSummarySource = queryRequired('#baseSummary').textContent;
    this.offlineTextSource = '';
    this.gameOverDetailsSource = '';
    this.tabCoordinator = new TabCoordinator();
    this.tabCoordinator.start(primary => this.handlePrimaryChange(primary));
    this.mapInput = new MapInput(queryRequired('#mapCanvas'), this.camera, {
      onViewChanged: () => { this.renderer.invalidateStatic(); this.renderer.render(); },
      onTap: worldPoint => this.handleMapTap(worldPoint)
    });
    this.bindControls();
    this.bindEvents();
    this.updateStorageUi();
  }

  localize(text) {
    return this.i18n?.copy?.(text) ?? String(text ?? '');
  }

  message(key, params = {}, fallback = '') {
    return this.i18n?.message?.(key, params, fallback) ?? String(fallback || key || '');
  }

  messagePayload(key, params = {}, fallback = '') {
    return { key, params, text: fallback };
  }

  errorPayload(error, fallbackKey = 'app.actionUnavailable', fallback = '') {
    if (error?.messageKey) {
      return this.messagePayload(error.messageKey, error.messageParams ?? {}, error.fallback ?? error.message ?? fallback);
    }
    if (error?.code) return this.messagePayload(`error.${error.code}`, {}, error.message ?? fallback);
    return this.messagePayload(fallbackKey, {}, error?.message ?? fallback);
  }

  localizeStatus(text) {
    return this.i18n?.status?.(text) ?? this.localize(text);
  }

  localizePayload(payload, { status = false } = {}) {
    if (payload && typeof payload === 'object' && payload.key) return this.message(payload.key, payload.params ?? {}, payload.text ?? '');
    return status ? this.localizeStatus(payload) : this.localize(payload);
  }

  showNotificationMessage(key, params = {}, fallback = '', duration = 2600) {
    this.notifications.show(this.messagePayload(key, params, fallback), duration);
  }

  celebrationOverlay() {
    let overlay = globalThis.document?.querySelector?.('#civilizationCelebration');
    if (overlay) return overlay;
    overlay = globalThis.document?.createElement?.('div');
    if (!overlay) return null;
    overlay.id = 'civilizationCelebration';
    overlay.className = 'civilizationCelebration';
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('role', 'status');
    const card = globalThis.document.createElement('div');
    card.className = 'civilizationCelebrationCard';
    const eyebrow = globalThis.document.createElement('small');
    eyebrow.dataset.part = 'eyebrow';
    const title = globalThis.document.createElement('strong');
    title.dataset.part = 'title';
    const subtitle = globalThis.document.createElement('span');
    subtitle.dataset.part = 'subtitle';
    const reward = globalThis.document.createElement('em');
    reward.dataset.part = 'reward';
    card.append(eyebrow, title, subtitle, reward);
    overlay.append(card);
    globalThis.document.body?.appendChild?.(overlay);
    return overlay;
  }

  showCivilizationCelebration(payload = {}) {
    const level = Math.max(0, Number(payload?.level) || 0);
    const civilizationName = payload?.civilization?.name ?? '';
    const central = payload?.civilization?.central ?? '';
    const rewardBundle = payload?.reward?.accepted ?? {};
    const rewardText = Object.keys(rewardBundle).length ? this.i18n.bundleText(rewardBundle) : '';
    this.notifications.show(this.messagePayload('civilization.celebrationToast', { civilizationName, level }, `Advanced to ${civilizationName}.`), 3000);
    const overlay = this.celebrationOverlay();
    if (!overlay) return;
    overlay.querySelector('[data-part="eyebrow"]').textContent = this.message('civilization.celebrationEyebrow', { level }, `CIVILIZATION Lv.${level}`);
    overlay.querySelector('[data-part="title"]').textContent = this.message('civilization.celebrationTitle', { civilizationName }, `Advanced to ${civilizationName}`);
    overlay.querySelector('[data-part="subtitle"]').textContent = this.message('civilization.celebrationSubtitle', { central }, `Central facility: ${central}`);
    const reward = overlay.querySelector('[data-part="reward"]');
    reward.textContent = rewardText
      ? this.message('civilization.celebrationReward', { reward: rewardText }, `First-time reward: ${rewardText}`)
      : '';
    overlay.classList.remove('is-visible');
    void overlay.offsetWidth;
    overlay.classList.add('is-visible');
    clearTimeout(this.celebrationTimer);
    this.celebrationTimer = setTimeout(() => overlay.classList.remove('is-visible'), 3000);
  }

  showBaseLoadingMessage(key, params = {}, fallback = '') {
    this.baseScreen.showLoading(this.messagePayload(key, params, fallback));
  }

  showBaseErrorMessage(key, params = {}, fallback = '') {
    this.baseScreen.showError(this.messagePayload(key, params, fallback));
  }

  setBaseSummary(message) {
    this.baseSummarySource = message ?? '';
    queryRequired('#baseSummary').textContent = this.localizePayload(this.baseSummarySource, { status: true });
  }

  setBaseSummaryMessage(key, params = {}, fallback = '') {
    this.setBaseSummary(this.messagePayload(key, params, fallback));
  }

  setOfflineText(message) {
    this.offlineTextSource = message ?? '';
    queryRequired('#offlineText').textContent = this.localizePayload(this.offlineTextSource);
  }


  setLifecycleText(lifecycle = this.store?.read?.(state => state.lifecycle) ?? LifecycleState.BOOT) {
    const key = LIFECYCLE_LABEL_KEYS[lifecycle];
    const label = key ? this.i18n.t(key, lifecycle) : String(lifecycle ?? '');
    queryRequired('#lifecycleText').textContent = label;
  }

  applyLocalization({ fullDocument = false } = {}) {
    if (this.baseSummarySource) queryRequired('#baseSummary').textContent = this.localizePayload(this.baseSummarySource, { status: true });
    if (this.offlineTextSource) queryRequired('#offlineText').textContent = this.localizePayload(this.offlineTextSource);
    if (this.gameOverDetailsSource) queryRequired('#gameOverDetails').textContent = this.localizePayload(this.gameOverDetailsSource);
    this.radarPreferences?.refreshLocalization?.();
    this.baseScreen?.refreshLocalization?.();
    this.notifications?.refreshLocalization?.();
    if (fullDocument) this.i18n.apply(globalThis.document);
    this.setLifecycleText();
  }


  handleOperationGuidanceAction(action) {
    if (action === 'open-civilization') {
      this.civilizationUi.open();
      return true;
    }
    if (action === 'open-bases') {
      this.baseCommandUi.open();
      return true;
    }
    if (action === 'open-items') {
      this.roadsideSuppliesUi.open();
      return true;
    }
    if (action === 'select-map' || action === 'select-enemy-base' || action === 'select-defense' || action === 'select-recovery') {
      this.showNotificationMessage('app.menuClosedSelectTarget');
      return true;
    }
    this.showNotificationMessage('app.actionUnavailable');
    return true;
  }

  refreshLocalizedUi(view = null) {
    const snapshot = view ?? this.store.uiSnapshot?.() ?? this.store.snapshot?.();
    this.combatUi.update(snapshot);
    this.deploymentUi.update(snapshot);
    this.baseCommandUi.update(snapshot);
    this.civilizationUi.update(snapshot);
    this.roadsideSuppliesUi.update(snapshot);
    this.menuUi.update(snapshot);
    this.applyLocalization({ fullDocument: true });
  }

  updateStorageUi() {
    const available = this.saveRepository.isAvailable();
    this.menuUi.setSaveAvailable(available);
    const warning = queryRequired('#storageWarning');
    warning.textContent = available ? '' : this.i18n.message('app.saveUnavailableLoss');
    setVisible(warning, !available);
  }

  handleFatal(error) {
    console.error(error);
    document.body.dataset.fatal = 'true';
    try {
      const message = error?.message
        ? this.messagePayload('app.bootFailedWithError', { errorMessage: error.message }, `起動に失敗しました：${error.message}`)
        : this.messagePayload('app.bootFailedGeneric', {}, '起動に失敗しました。ページを再読み込みしてください。');
      this.baseScreen.showError(message);
      this.setLifecycleText(LifecycleState.ERROR);
    } catch {
      document.body.textContent = this.i18n.message('app.bootFailed');
    }
  }

  bindControls() {
    queryRequired('#confirmBase').addEventListener('click', () => this.confirmBase());
    queryRequired('#retryLocation').addEventListener('click', () => this.startNewGame());
    queryRequired('#zoomIn').addEventListener('click', () => {
      this.camera.zoomAt(1.25, { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 });
      this.renderer.render();
    });
    queryRequired('#zoomOut').addEventListener('click', () => {
      this.camera.zoomAt(0.8, { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 });
      this.renderer.render();
    });
    queryRequired('#recenter').addEventListener('click', () => this.recenterMap());
    queryRequired('#gameZoomIn').addEventListener('click', () => {
      this.camera.zoomAt(1.25, { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 });
      this.renderer.render();
    });
    queryRequired('#gameZoomOut').addEventListener('click', () => {
      this.camera.zoomAt(0.8, { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 });
      this.renderer.render();
    });
    queryRequired('#focusSelectedBase').addEventListener('click', () => {
      if (!this.baseCommandUi.focusCurrentBase()) this.showNotificationMessage('app.noDisplayableBases');
    });
    queryRequired('#focusPlayer').addEventListener('click', () => this.recenterMap());
    queryRequired('#offlineClose').addEventListener('click', () => setVisible(queryRequired('#offlineSummary'), false));
    queryRequired('#gameOverReview').addEventListener('click', () => {
      setVisible(queryRequired('#gameOverOverlay'), false);
      this.showGameOverReviewBanner(true);
    });
    queryRequired('#gameOverReopen').addEventListener('click', () => this.showGameOverOverlay());
    queryRequired('#gameOverNewRun').addEventListener('click', () => this.confirmGameOverReset());
    queryRequired('#gameOverBannerNewRun').addEventListener('click', () => this.confirmGameOverReset());
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange().catch(error => this.handleFatal(error)));
  }


  confirmGameOverReset() {
    if (globalThis.confirm?.(this.i18n.t('static.gameOverResetConfirm', 'Start a new operation?'))) this.reset();
  }

  showGameOverReviewBanner(visible = true) {
    const banner = queryRequired('#gameOverReviewBanner');
    setVisible(banner, Boolean(visible) && isGameOverState(this.store.renderView()));
    this.applyLocalization({ fullDocument: false });
  }

  bindEvents() {
    this.events.on('message', payload => {
      if (payload?.key) {
        this.notifications.show({ key: payload.key, params: payload.params ?? {}, text: payload.text ?? payload.fallback ?? '' }, 2600);
        return;
      }
      if (payload?.text) this.notifications.show({ text: payload.text }, 2600, { localized: true });
    });
    this.events.on('lifecycle:changed', ({ current }) => {
      document.documentElement.dataset.lifecycle = current;
      this.setLifecycleText(current);
    });
    this.events.on('civilization:level-up', payload => {
      this.civilizationUi.render();
      this.baseCommandUi.render();
      this.applyLocalization({ fullDocument: false });
      this.showCivilizationCelebration(payload);
    });
    this.events.on('combat:defense-destroyed', () => this.queueCriticalSave());
    this.events.on('combat:enemy-base-destroyed', ({ baseId }) => { this.combatUi?.handleEnemyBaseDestroyed?.(baseId); this.queueCriticalSave(); });
    this.events.on('base:player-dismantled', payload => { this.combatUi?.handleOwnedBaseRemoved?.(payload); this.queueCriticalSave(); });
    this.events.on('base:field-dismantled', payload => { this.combatUi?.handleOwnedBaseRemoved?.(payload); this.queueCriticalSave(); });
    this.events.on('civilization:building-destroyed', () => this.queueCriticalSave());
    this.events.on('game:home-base-destroyed', payload => this.handleHomeBaseDestroyed(payload));
  }

  queueCriticalSave() {
    if (this.criticalSaveQueued) return;
    this.criticalSaveQueued = true;
    const schedule = globalThis.queueMicrotask ?? (callback => Promise.resolve().then(callback));
    schedule(() => {
      this.criticalSaveQueued = false;
    this.celebrationTimer = null;
      this.persist({ notify: false });
    });
  }

  async start() {
    await this.i18nReady;
    this.i18n.apply(globalThis.document);
    queryRequired('#versionText').textContent = APP_VERSION;
    this.lifecycle.boot();
    const loadWarning = this.saveRepository.consumeWarning();
    const saved = await this.saveRepository.loadAsync();
    if (saved && hasEstablishedHomeBase(saved) && saved.world.roadGraph) {
      const handled = await this.restoreSavedGame(saved, loadWarning);
      if (handled) return;
    }
    this.lifecycle.requireLocation();
    await this.startNewGame();
    const warning = loadWarning ?? this.saveRepository.consumeWarning();
    if (warning) this.notifications.show(warning, 6500);
  }

  restoreValidatedSave(saved) {
    saved.lifecycle = LifecycleState.LOAD_SAVE;
    this.store.replace(saved, 'save:loaded');
    this.store.transaction(draft => normalizeRuntimeState(draft), 'save:rehydrated', { validate: true });
  }

  resetAfterInvalidSave() {
    this.saveRepository.quarantineCurrent(this.messagePayload('app.invalidSaveQuarantinedWithBackup', {}, '保存データを復元できなかったため、新しいゲームとして開始します。破損データは無効化しました。'));
    this.store.replace(createInitialState(), 'save:recovery-reset');
    this.lifecycle = new LifecycleController(this.store);
    this.lifecycle.boot();
    this.showNotificationMessage('app.invalidSaveRecovered', {}, '保存データを復元できなかったため、新しいゲームとして開始します。', 6500);
  }

  async restoreSavedGame(saved, loadWarning = null) {
    const savedDestroyed = saved?.lifecycle === LifecycleState.DESTROYED || Boolean(saved?.runtime?.gameOver) || Number(saved?.world?.city?.hp ?? 1) <= 0;
    try {
      this.restoreValidatedSave(saved);
    } catch (error) {
      console.error('Save validation failed', error);
      this.resetAfterInvalidSave();
      return false;
    }

    try {
      await this.roadWorld.restoreCachedChunks();
    } catch (error) {
      console.warn('Optional road cache restore failed', error);
      this.showNotificationMessage('app.roadCacheRestoreFailed', {}, '道路キャッシュを復元できませんでした。保存済みの進行データで続行します。', 5000);
    }

    if (savedDestroyed) {
      this.store.transaction(draft => {
        markHomeBaseDestroyed(draft, { source: GAME_OVER_SOURCE.RESTORE });
      }, 'game-over:restore', { validate: true });
      this.restoreEstablishedGameUi({ fitGraph: false, centerOnBase: true });
      this.showGameOverOverlay({ source: GAME_OVER_SOURCE.RESTORE });
      if (this.tabCoordinator.isPrimary()) this.persist({ notify: false });
      if (loadWarning) this.notifications.show(loadWarning, 6500);
      return true;
    }

    let offlineSummary = null;
    if (this.tabCoordinator.isPrimary()) {
      const beforeOffline = this.store.snapshot();
      const lastSavedAt = this.store.read(state => state.runtime.lastSavedAt || Date.now());
      const elapsedSeconds = Math.max(0, (Date.now() - lastSavedAt) / 1000);
      try {
        this.store.transaction(draft => {
          offlineSummary = this.offlineSimulator.simulate(draft, elapsedSeconds);
        }, 'offline:simulated', { validate: true });
      } catch (error) {
        console.error('Offline simulation failed', error);
        this.store.replace(beforeOffline, 'offline:rollback');
        this.showNotificationMessage('app.offlineSimulationFailed', {}, '不在中の進行計算を適用できませんでした。保存時点から再開します。', 6000);
      }
    }

    if (this.store.read(state => state.lifecycle) === LifecycleState.DESTROYED || this.store.read(state => Boolean(state.runtime?.gameOver))) {
      this.restoreEstablishedGameUi({ fitGraph: false, centerOnBase: true });
      this.showGameOverOverlay({ source: GAME_OVER_SOURCE.OFFLINE, summary: offlineSummary });
      if (this.tabCoordinator.isPrimary()) this.persist({ notify: false });
      if (loadWarning) this.notifications.show(loadWarning, 6500);
      return true;
    }

    try {
      this.store.transition(LifecycleState.PLAYING);
      if (this.tabCoordinator.isPrimary()) this.persist({ notify: false });
      this.openSavedGame();
      this.showOfflineSummary(offlineSummary);
      if (loadWarning) this.notifications.show(loadWarning, 6500);
      return true;
    } catch (error) {
      console.error('Saved game UI startup failed', error);
      this.handleFatal(error);
      return true;
    }
  }


  installInitialRoadGraph(graph, currentLocation, { roadsPending = false, preserveView = false } = {}) {
    const previousSelectionPoint = this.selection?.point ? { ...this.selection.point } : null;
    this.store.transaction(draft => {
      draft.world.roadGraph = graph;
      const integratedChunkIds = graphCoveredChunkIds(graph);
      const retentionRadiusMeters = Number(graph.acquisitionReport?.retention?.meters)
        || ROAD_CONFIG.initialRetentionRadiusMeters;
      const loadedChunkIds = integratedChunkIds.filter(id => chunkFullyInsideCircle(
        parseChunkId(id),
        { x: 0, y: 0 },
        retentionRadiusMeters
      ));
      const refreshChunkIds = integratedChunkIds.filter(id => !loadedChunkIds.includes(id));
      const playerPoint = latLonToXY(currentLocation.lat, currentLocation.lon, graph.center);
      const observedChunkId = chunkForWorldPoint(playerPoint).id;
      draft.world.roadChunks = createRoadChunkState({
        initialLoadedChunkIds: loadedChunkIds,
        initialIntegratedChunkIds: integratedChunkIds,
        initialRefreshChunkIds: refreshChunkIds,
        initialObservedChunkIds: loadedChunkIds.includes(observedChunkId) ? [observedChunkId] : []
      });
    }, roadsPending ? 'roads:preview-loaded' : 'roads:loaded');

    this.basePlacement = new BasePlacementService(graph, currentLocation);
    this.renderer.setGraph(graph);
    this.renderer.setHomeBase(null);
    if (!preserveView) this.renderer.fitGraph();
    this.selection = previousSelectionPoint
      ? this.basePlacement.findNearestRoad(previousSelectionPoint, 80)
      : null;
    this.renderer.setSelection(this.selection);
    this.initialRoadExpansionPending = roadsPending;
    const lifecycle = this.store.read(state => state.lifecycle);
    if (lifecycle === LifecycleState.ROAD_LOADING) this.lifecycle.startBaseSelection();
    this.baseScreen.showSelection(this.selection, { roadsPending });
    this.renderer.render();
  }

  async startNewGame() {
    if (!this.tabCoordinator.isPrimary()) {
      this.showBaseErrorMessage('app.secondaryTabStartBlocked', {}, '別のタブがゲーム進行を担当しています。そちらを閉じると、このタブで開始できます。');
      return;
    }
    const generation = ++this.startupGeneration;
    this.roadLoadController?.abort();
    this.roadLoadController = new AbortController();
    this.initialRoadExpansionPending = false;
    this.initialRoadFallback = false;
    this.baseConfirmationPending = false;
    this.selection = null;
    this.renderer.setSelection(null);
    this.showBaseLoadingMessage('app.locationLoading', {}, '位置情報を取得しています…');

    try {
      const lifecycle = this.store.read(state => state.lifecycle);
      if ([LifecycleState.ERROR, LifecycleState.ROAD_LOADING, LifecycleState.BASE_SELECTION].includes(lifecycle)) {
        this.store.transition(LifecycleState.LOCATION_REQUIRED);
      }
      const currentLocation = await this.geolocation.getCurrentPosition();
      if (generation !== this.startupGeneration) return;
      this.store.transaction(draft => {
        draft.player.currentPosition = { lat: currentLocation.lat, lon: currentLocation.lon };
        draft.player.locationAccuracy = currentLocation.accuracy;
        draft.player.locationUpdatedAt = currentLocation.timestamp ?? Date.now();
        draft.runtime.lastError = null;
      }, 'location:resolved');
      this.lifecycle.startRoadLoading();
      this.showBaseLoadingMessage('app.initialRoadLoading', {}, '現在地周辺の道路を取得しています…');

      const result = await this.roadService.loadInitialProgressive(currentLocation, {
        signal: this.roadLoadController.signal,
        onAttempt: ({ index, total, transport, attempt, totalAttempts, acquisition }) => {
          if (generation !== this.startupGeneration) return;
          if (this.initialRoadExpansionPending) {
            this.baseScreen.showSelection(this.selection, { roadsPending: true });
            return;
          }
          const key = acquisition === 'preview' ? 'app.roadFetchProgressPreview' : 'app.roadFetchProgressFull';
          const fallback = `${acquisition === 'preview' ? '中心部道路' : '全道路'}を道路サーバーから取得しています… ${transport} (${index}/${total}, 試行 ${attempt}/${totalAttempts})`;
          this.showBaseLoadingMessage(key, { transport, index, total, attempt, totalAttempts }, fallback);
        },
        onPhase: ({ phase, acquisition }) => {
          if (generation !== this.startupGeneration || this.initialRoadExpansionPending) return;
          if (phase === 'parse') {
            const key = acquisition === 'preview' ? 'app.roadParsePreview' : 'app.roadParseFull';
            this.showBaseLoadingMessage(key, {}, `${acquisition === 'preview' ? '中心部' : '周辺'}道路を解析しています…`);
          }
          if (phase === 'graph') this.showBaseLoadingMessage('app.roadGraphBuilding', {}, '道路地図を構築しています…');
        },
        onPreview: graph => {
          if (generation !== this.startupGeneration) return;
          this.installInitialRoadGraph(graph, currentLocation, { roadsPending: true });
        }
      });
      if (generation !== this.startupGeneration) return;

      if (result.source === 'preview-fallback' && result.previewShown) {
        this.initialRoadExpansionPending = false;
        this.initialRoadFallback = true;
        this.baseScreen.showSelection(this.selection, { roadsPending: false });
        this.showNotificationMessage('app.previewFallbackReady', {}, '中心部の道路で開始できます。開始地点を選んで拠点を確定してください。周辺道路は移動や測量施設で追加されます。', 6500);
      } else {
        this.initialRoadFallback = false;
        this.installInitialRoadGraph(result.graph, currentLocation, {
          roadsPending: false,
          preserveView: result.previewShown
        });
      }
    } catch (error) {
      if (generation !== this.startupGeneration || error?.name === 'AbortError') return;
      this.initialRoadExpansionPending = false;
      this.store.setError(error);
      const errorMessage = error?.message ?? this.message('app.initializationFailed', {}, 'Initialization failed.');
      const fallbackMessage = error?.details
        ? this.message('app.initializationFailedWithDetails', { errorMessage, details: error.details }, `${errorMessage}\nDetails: ${error.details}`)
        : errorMessage;
      this.showBaseErrorMessage(
        error?.details ? 'app.initializationFailedWithDetails' : 'app.initializationFailedWithMessage',
        { errorMessage, details: error?.details ?? '' },
        fallbackMessage
      );
    }
  }

  handleMapTap(worldPoint) {
    const lifecycle = this.store.read(state => state.lifecycle);
    if (lifecycle === LifecycleState.PLAYING) {
      this.combatUi.handleMapTap(worldPoint);
      return;
    }
    if (lifecycle === LifecycleState.DESTROYED && this.store.read(state => Boolean(state.runtime?.gameOver))) {
      this.combatUi.selectTool?.('select');
      this.combatUi.handleMapTap(worldPoint);
      return;
    }
    if (lifecycle !== LifecycleState.BASE_SELECTION || !this.basePlacement) return;
    const tolerance = 24 / this.camera.scale;
    const selection = this.basePlacement.findNearestRoad(worldPoint, tolerance);
    this.selection = selection;
    this.renderer.setSelection(selection);
    this.renderer.render();
    this.baseScreen.showSelection(selection, { roadsPending: this.initialRoadExpansionPending });
  }

  async confirmBase() {
    if (!this.tabCoordinator.isPrimary()) {
      this.showNotificationMessage('app.tabProgressOwner', {}, '別のタブがゲーム進行を担当しています。');
      return;
    }
    if (this.baseConfirmationPending) return;
    if (this.initialRoadExpansionPending) {
      this.showNotificationMessage('app.initialRoadExpansionPending', {}, '周辺道路を確認しています。完了後に拠点を確定できます。');
      return;
    }
    if (!this.selection?.valid || !this.basePlacement) return;

    this.baseConfirmationPending = true;
    try {
      if (this.initialRoadFallback) {
        const selectedPoint = { ...this.selection.point };
        this.showBaseLoadingMessage('app.selectedRoadCoverageLoading', {}, '選択地点周辺の道路を確認しています…');
        const coverage = await this.roadWorld.ensureAreaAroundPoint(selectedPoint, {
          radiusMeters: ROAD_CONFIG.initialBaseCoverageRadiusMeters,
          observe: true,
          reason: 'initial-base-coverage'
        });
        if (!coverage.ok) {
          this.baseScreen.showSelection(this.selection, { roadsPending: false });
          this.showNotificationMessage('app.selectedRoadCoverageFailed', {}, '選択地点周辺の道路を取得できませんでした。通信状態を確認して、もう一度確定してください。', 6500);
          return;
        }
        const latest = this.store.snapshot();
        this.basePlacement = new BasePlacementService(latest.world.roadGraph, latest.player.currentPosition);
        this.selection = this.basePlacement.findNearestRoad(selectedPoint, 80);
        this.renderer.setSelection(this.selection);
        this.renderer.render();
        if (!this.selection?.valid) {
          this.baseScreen.showSelection(this.selection, { roadsPending: false });
          this.showNotificationMessage('app.selectedRoadInvalidAfterUpdate', {}, '道路更新後に選択地点を確認できませんでした。道路を選び直してください。', 6500);
          return;
        }
        this.initialRoadFallback = false;
      }

      this.lifecycle.startInitialization();
      const establishedAt = this.store.read(state => state.runtime?.worldTimeMs || state.runtime?.createdAt || 0);
      const { graph, homeBase } = this.basePlacement.establishHomeBase(this.selection, establishedAt);
      this.store.transaction(draft => {
        draft.world.roadGraph = graph;
        draft.world.roadChunks = ensureRoadChunkState(draft.world);
        draft.world.homeBase = homeBase;
        initializeCombatState(draft);
      }, 'base:established');
      this.lifecycle.startPlaying();
      this.persist({ notify: false });
      this.renderer.setGraph(graph);
      this.renderer.setSelection(null);
      this.renderer.setHomeBase(homeBase);
      this.renderer.render();
      this.baseScreen.hide();
      setVisible(queryRequired('#playingHud'), true);
      this.setBaseSummaryMessage('app.baseEstablishedSummary', { meters: Math.round(homeBase.selectedDistanceMeters) }, `拠点設置完了：初回現在地から約${Math.round(homeBase.selectedDistanceMeters)}m`);
      this.combatUi.update();
      this.baseCommandUi.update();
      this.civilizationUi.updateSummary();
      this.roadsideSuppliesUi.update();
      this.applyLocalization({ fullDocument: false });
      this.startRuntime();
      this.showNotificationMessage('app.basePlacedOpening', {}, '拠点を設置しました。まず投石台を2基建て、敵拠点へ部隊を派兵してください。', 7000);
    } catch (error) {
      this.store.setError(error);
      this.showBaseErrorMessage('app.basePlacementFailedWithMessage', { errorMessage: error?.message ?? this.message('app.basePlacementFailed', {}, '拠点の設置に失敗しました。') }, error?.message ?? '拠点の設置に失敗しました。');
    } finally {
      this.baseConfirmationPending = false;
    }
  }

  restoreEstablishedGameUi({ fitGraph = false, centerOnBase = false } = {}) {
    const state = this.store.snapshot();
    if (!hasEstablishedHomeBase(state) || !state.world.roadGraph) return false;
    this.renderer.setGraph(state.world.roadGraph);
    this.renderer.setHomeBase(state.world.homeBase);
    if (fitGraph) this.renderer.fitGraph();
    else if (centerOnBase && state.world.homeBase) {
      this.camera.x = state.world.homeBase.x;
      this.camera.y = state.world.homeBase.y;
      this.camera.scale = Math.max(this.camera.scale, 0.9);
      this.renderer.invalidateStatic();
    }
    this.baseScreen.hide();
    setVisible(queryRequired('#playingHud'), true);
    this.setBaseSummaryMessage('app.savedBaseSummary', { meters: Math.round(state.world.homeBase.selectedDistanceMeters ?? 0) }, `保存済み拠点：初回現在地から約${Math.round(state.world.homeBase.selectedDistanceMeters ?? 0)}m`);
    this.combatUi.update();
    this.baseCommandUi.update();
    this.civilizationUi.updateSummary();
    this.roadsideSuppliesUi.update();
    this.applyLocalization({ fullDocument: false });
    this.renderer.render();
    return true;
  }

  openSavedGame() {
    this.restoreEstablishedGameUi({ fitGraph: false, centerOnBase: true });
    if (!isGameOverState(this.store.renderView())) this.startRuntime();
  }

  recenterMap() {
    const lifecycle = this.store.read(state => state.lifecycle);
    const player = this.store.read(state => state.player.worldPosition);
    if (lifecycle === LifecycleState.PLAYING && player) {
      this.renderer.centerOn(player);
      return;
    }
    this.renderer.fitGraph();
  }

  startLocationTracking() {
    this.stopLocationWatch?.();
    this.locationWatcher ??= new AdaptiveLocationWatcher(this.geolocation);
    this.stopLocationWatch = this.locationWatcher.start(locationValue => {
      if (isGameOverState(this.store.renderView())) return;
      const state = this.store.renderView();
      const worldPoint = latLonToXY(locationValue.lat, locationValue.lon, state.world.roadGraph.center);
      this.store.advance(draft => {
        draft.player.currentPosition = { lat: locationValue.lat, lon: locationValue.lon };
        draft.player.locationAccuracy = locationValue.accuracy;
        draft.player.locationUpdatedAt = locationValue.timestamp ?? Date.now();
        draft.player.worldPosition = worldPoint;
      }, 'location:watch');
      this.renderer.render();
      this.roadWorld.considerLocation(worldPoint);
      this.store.advance(draft => { this.roadsideSupplySystem.refresh(draft, true); }, 'roadside:location-refresh');
    }, error => this.showNotificationMessage('app.locationTrackingError', { errorMessage: error.message }, `位置追跡：${error.message}`));
  }

  formatDuration(seconds = 0) {
    const totalMinutes = Math.max(0, Math.round(Number(seconds) / 60));
    if (totalMinutes < 60) return this.message('app.durationMinutes', { minutes: totalMinutes }, `${totalMinutes}分`);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0
      ? this.message('app.durationHoursMinutes', { hours, minutes }, `${hours}時間${minutes}分`)
      : this.message('app.durationHours', { hours }, `${hours}時間`);
  }

  gameOverStatRows(gameOver) {
    const record = gameOver ?? this.store.read(state => state.runtime?.gameOver) ?? {};
    return [
      [this.i18n.t('static.gameOverSurvival', 'Survival'), this.localize(this.formatDuration(record.survivalSeconds ?? 0))],
      [this.i18n.t('static.gameOverCiv', 'Civilization'), `${this.i18n.t('static.civLevel', 'Civ Lv.')} ${record.civilizationLevel ?? 0}`],
      [this.i18n.t('static.gameOverKills', 'Enemies defeated'), String(record.kills ?? 0)],
      [this.i18n.t('static.gameOverCamps', 'Enemy bases destroyed'), String(record.campsCaptured ?? 0)],
      [this.i18n.t('static.gameOverDefenses', 'Defenses remaining'), String(record.defensesBuilt ?? 0)],
      [this.i18n.t('static.gameOverReason', 'Cause'), this.i18n.t('static.gameOverReasonDirect', 'Enemy forces reached the home base')]
    ];
  }

  renderGameOverStats(container, rows) {
    container.textContent = '';
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      const labelNode = document.createElement('span');
      const valueNode = document.createElement('strong');
      labelNode.textContent = label;
      valueNode.textContent = value;
      row.append(labelNode, valueNode);
      container.appendChild(row);
    }
  }

  showGameOverOverlay({ source = null, summary = null } = {}) {
    const overlay = queryRequired('#gameOverOverlay');
    const title = queryRequired('#gameOverTitle');
    const message = queryRequired('#gameOverMessage');
    const details = queryRequired('#gameOverDetails');
    const stats = queryRequired('#gameOverStats');
    const state = this.store.snapshot();
    const gameOver = state.runtime?.gameOver ?? summary?.gameOver ?? null;
    const offline = source === GAME_OVER_SOURCE.OFFLINE || gameOver?.source === GAME_OVER_SOURCE.OFFLINE;
    title.textContent = this.i18n.t(offline ? 'static.gameOverOfflineTitle' : 'static.gameOverTitle', 'Home Base Destroyed');
    message.textContent = this.i18n.t(offline ? 'static.gameOverOfflineMessage' : 'static.gameOverMessage', 'The defensive line has collapsed. Operations can no longer continue.');
    const detailParts = [];
    if (offline && summary) {
      detailParts.push(this.message('app.offlineProgressDetail', { duration: this.formatDuration(summary.simulatedSeconds ?? 0) }, `不在中の進行：${this.formatDuration(summary.simulatedSeconds ?? 0)}`));
      detailParts.push(this.message('app.cityDamage', { amount: summary.cityDamage ?? 0 }, `都市被害 ${summary.cityDamage ?? 0}`));
    }
    this.gameOverDetailsSource = detailParts.join(this.message('app.inlineSeparator', {}, '・'));
    details.textContent = this.localizePayload(this.gameOverDetailsSource);
    setVisible(details, Boolean(this.gameOverDetailsSource));
    this.renderGameOverStats(stats, this.gameOverStatRows(gameOver));
    document.documentElement.dataset.lifecycle = LifecycleState.DESTROYED;
    this.setLifecycleText(LifecycleState.DESTROYED);
    setVisible(queryRequired('#offlineSummary'), false);
    setVisible(queryRequired('#gameOverReviewBanner'), false);
    setVisible(overlay, true);
    this.applyLocalization({ fullDocument: false });
  }

  handleHomeBaseDestroyed(payload = {}) {
    this.gameLoop.stop({ save: false });
    this.stopLocationWatch?.();
    this.stopLocationWatch = null;
    this.restoreEstablishedGameUi();
    this.showGameOverOverlay({ source: payload?.gameOver?.source });
    this.persist({ notify: false });
  }

  showOfflineSummary(summary) {
    const element = queryRequired('#offlineSummary');
    if (!summary) {
      this.offlineTextSource = '';
      this.gameOverDetailsSource = '';
      setVisible(element, false);
      return;
    }
    const minutes = Math.round(summary.simulatedSeconds / 60);
    const resourceBundle = Object.fromEntries(Object.entries(summary.resources ?? {}).filter(([, value]) => Number(value) !== 0));
    const parts = [
      this.message('app.offlineMinutesProgress', { minutes }, `${minutes}分進行`),
      this.message('app.kills', { count: summary.kills }, `撃破 ${summary.kills}`),
      this.message('app.cityDamage', { amount: summary.cityDamage }, `都市被害 ${summary.cityDamage}`)
    ];
    if (Object.keys(resourceBundle).length) {
      parts.push(this.message('app.offlineResources', { resourceText: { __resourceBundle: true, bundle: resourceBundle } }, Object.entries(resourceBundle).map(([key, value]) => `${RESOURCE_LABELS[key] ?? key} ${value > 0 ? '+' : ''}${value}`).join('・')));
    }
    if (summary.productionCompleted > 0) parts.push(this.message('app.offlineProductionCompleted', { count: summary.productionCompleted }, `生産完了 ${summary.productionCompleted}`));
    if (summary.completedReorganizations > 0) parts.push(this.message('app.offlineReorganizationsCompleted', { count: summary.completedReorganizations }, `再編成完了 ${summary.completedReorganizations}`));
    if (summary.roadsideRefillReady) parts.push(this.message('app.offlineRoadsideReady', {}, '路傍物資 更新準備完了'));
    if ((summary.siege?.skippedCount ?? 0) > 0) parts.push(this.message('siege.offlineSkipped', { count: summary.siege.skippedCount }, `不在中の包囲を${summary.siege.skippedCount}件スキップ`));
    if (Number(summary.siege?.nextInSeconds) > 0) parts.push(this.message('siege.nextSummary', { duration: this.formatDuration(summary.siege.nextInSeconds) }, `次の包囲まで ${this.formatDuration(summary.siege.nextInSeconds)}`));
    if (summary.defensesLost > 0) parts.push(this.message('app.defensesLost', { count: summary.defensesLost }, `防衛設備損失 ${summary.defensesLost}`));
    if (summary.buildingsLost > 0) parts.push(this.message('app.buildingsLost', { count: summary.buildingsLost }, `集落施設損失 ${summary.buildingsLost}`));
    if (summary.civilizationAdvanced > 0) parts.push(this.message('app.civilizationAdvanced', { count: summary.civilizationAdvanced }, `文明 +${summary.civilizationAdvanced}`));
    const fillHours = Math.round((summary.fill?.production?.maxSeconds ?? 21600) / 3600);
    if (summary.fill?.production?.capped) parts.push(this.message('app.offlineFillCapped', { hours: fillHours }, `生産・路傍・再編成は約${fillHours}時間で満充填`));
    if (summary.capped) parts.push(this.message('app.offlineCapped', {}, '長時間分は上限適用'));
    this.setOfflineText(parts.join(this.message('app.inlineSeparator', {}, '・')));
    setVisible(element, true);
    this.applyLocalization({ fullDocument: false });
  }

  persist({ notify = true, sync = false } = {}) {
    if (!this.tabCoordinator.isPrimary() || !this.saveRepository.isAvailable()) {
      this.updateStorageUi();
      return false;
    }
    const snapshot = this.store.persistenceSnapshot();
    if (sync || typeof this.saveRepository.saveDetachedStateAsync !== 'function') {
      try {
        const savedAt = this.saveRepository.saveDetachedState(snapshot);
        this.store.transaction(state => { state.runtime.lastSavedAt = savedAt; }, 'save:timestamp');
        this.updateStorageUi();
        return true;
      } catch (error) {
        this.updateStorageUi();
        if (notify) this.notifications.show(this.errorPayload(error, 'app.saveFailed'), 4500);
        return false;
      }
    }
    return this.saveRepository.saveDetachedStateAsync(snapshot)
      .then(savedAt => {
        if (savedAt) this.store.transaction(state => { state.runtime.lastSavedAt = savedAt; }, 'save:timestamp');
        this.updateStorageUi();
        return true;
      })
      .catch(error => {
        this.updateStorageUi();
        if (notify) this.notifications.show(this.errorPayload(error, 'app.saveFailed'), 4500);
        return false;
      });
  }

  startRuntime() {
    if (isGameOverState(this.store.renderView())) {
      this.gameLoop.stop({ save: false });
      this.stopLocationWatch?.();
      this.showGameOverOverlay();
      return;
    }
    if (!this.tabCoordinator.isPrimary()) {
      if (this.store.read(state => state.lifecycle) === LifecycleState.PLAYING) {
        this.lifecycle.pause();
        this.store.transaction(state => { state.runtime.pauseReason = 'tab'; }, 'runtime:pause-tab');
      }
      this.showNotificationMessage('app.readOnlySecondaryTab', {}, '別のタブが進行を担当しています。このタブは閲覧専用です。');
      return;
    }
    if (document.hidden) {
      if (this.store.read(state => state.lifecycle) === LifecycleState.PLAYING) {
        this.lifecycle.pause();
        this.store.transaction(state => { state.runtime.pauseReason = 'visibility'; }, 'runtime:pause-visibility');
      }
      return;
    }
    this.startLocationTracking();
    this.gameLoop.start();
  }

  pauseRuntime(reason, { save = true, syncSave = false } = {}) {
    const lifecycle = this.store.read(state => state.lifecycle);
    if (lifecycle === LifecycleState.PLAYING) this.lifecycle.pause();
    this.store.transaction(state => { state.runtime.pauseReason = reason; }, `runtime:pause-${reason}`);
    this.gameLoop.stop({ save: save && this.tabCoordinator.isPrimary(), syncSave });
    this.stopLocationWatch?.();
    this.stopLocationWatch = null;
    this.criticalSaveQueued = false;
    this.celebrationTimer = null;
    if (save && syncSave && this.tabCoordinator.isPrimary()) this.persist({ notify: false, sync: true });
  }

  async refreshFromSavedStateForTakeover() {
    const saved = await this.saveRepository.loadAsync();
    if (!saved || !hasEstablishedHomeBase(saved) || !saved.world.roadGraph) return false;
    saved.lifecycle = LifecycleState.PAUSED;
    saved.runtime.pauseReason = 'tab';
    this.store.replace(saved, 'tab:fresh-save-loaded');
    this.store.transaction(state => {
      normalizeRuntimeState(state);
    }, 'tab:fresh-save-rehydrated', { validate: true });
    this.restoreEstablishedGameUi();
    return true;
  }

  async resumeRuntime(reason) {
    let lifecycle = this.store.read(state => state.lifecycle);
    let pauseReason = this.store.read(state => state.runtime.pauseReason);
    if (lifecycle !== LifecycleState.PAUSED || pauseReason !== reason || document.hidden || !this.tabCoordinator.isPrimary()) return false;
    if (reason === 'tab') {
      await this.refreshFromSavedStateForTakeover();
      lifecycle = this.store.read(state => state.lifecycle);
      pauseReason = this.store.read(state => state.runtime.pauseReason);
      if (lifecycle !== LifecycleState.PAUSED || pauseReason !== 'tab') return false;
    }
    const lastSavedAt = this.store.read(state => state.runtime.lastSavedAt || Date.now());
    const elapsed = Math.max(0, (Date.now() - lastSavedAt) / 1000);
    let summary = null;
    this.store.transaction(state => {
      summary = this.offlineSimulator.simulate(state, elapsed);
      state.runtime.pauseReason = null;
    }, `runtime:resume-${reason}`);
    if (this.store.read(state => state.lifecycle) === LifecycleState.DESTROYED || this.store.read(state => Boolean(state.runtime?.gameOver))) {
      this.restoreEstablishedGameUi();
      this.persist({ notify: false });
      this.showGameOverOverlay({ source: GAME_OVER_SOURCE.OFFLINE, summary });
      return true;
    }
    this.lifecycle.resume();
    this.restoreEstablishedGameUi();
    this.persist({ notify: false });
    this.showOfflineSummary(summary);
    this.startLocationTracking();
    this.gameLoop.start();
    return true;
  }

  handlePrimaryChange(primary) {
    const lifecycle = this.store.read(state => state.lifecycle);
    if (!primary && lifecycle === LifecycleState.PLAYING) {
      this.pauseRuntime('tab', { save: false });
      this.showNotificationMessage('app.primaryTabTakenOver', {}, '別のタブが進行を引き継ぎました。');
      return;
    }
    if (primary && [LifecycleState.LOCATION_REQUIRED, LifecycleState.ERROR].includes(lifecycle) && !this.store.read(state => state.world.homeBase)) {
      this.startNewGame();
      return;
    }
    if (primary && lifecycle === LifecycleState.PAUSED) {
      const reason = this.store.read(state => state.runtime.pauseReason);
      this.resumeRuntime(reason).then(resumed => {
        if (resumed) this.showNotificationMessage('app.primaryTabResumed', {}, 'このタブで進行を再開しました。');
      }).catch(error => this.handleFatal(error));
    }
  }

  async handleVisibilityChange() {
    const lifecycle = this.store.read(state => state.lifecycle);
    if (![LifecycleState.PLAYING, LifecycleState.PAUSED].includes(lifecycle)) return;
    if (document.hidden) {
      if (lifecycle === LifecycleState.PLAYING) this.pauseRuntime('visibility', { save: true, syncSave: true });
      else this.persist({ notify: false });
      return;
    }
    this.tabCoordinator.refresh();
    if (!await this.resumeRuntime('visibility') && this.store.read(state => state.lifecycle) === LifecycleState.PLAYING) {
      this.restoreEstablishedGameUi();
      this.startRuntime();
    }
  }

  handlePageHide() {
    const lifecycle = this.store.read(state => state.lifecycle);
    if (lifecycle === LifecycleState.PLAYING) this.pauseRuntime('visibility', { save: true, syncSave: true });
    else if (lifecycle === LifecycleState.PAUSED || lifecycle === LifecycleState.DESTROYED) this.persist({ notify: false, sync: true });
  }

  async handlePageShow() {
    this.tabCoordinator.refresh();
    let lifecycle = this.store.read(state => state.lifecycle);
    if (lifecycle === LifecycleState.DESTROYED) {
      this.restoreEstablishedGameUi();
      this.showGameOverOverlay();
      return true;
    }
    if (![LifecycleState.PLAYING, LifecycleState.PAUSED].includes(lifecycle)) {
      const saved = await this.saveRepository.loadAsync();
      if (saved && hasEstablishedHomeBase(saved) && saved.world.roadGraph) {
        await this.restoreSavedGame(saved, this.saveRepository.consumeWarning());
        return true;
      }
      return false;
    }
    this.restoreEstablishedGameUi();
    if (lifecycle === LifecycleState.PAUSED) {
      const reason = this.store.read(state => state.runtime.pauseReason);
      return this.resumeRuntime(reason);
    }
    this.startRuntime();
    return true;
  }

  async reset() {
    this.gameLoop.stop({ save: false });
    this.stopLocationWatch?.();
    this.tabCoordinator.release();
    this.startupGeneration += 1;
    this.roadLoadController?.abort();
    this.initialRoadExpansionPending = false;
    this.roadWorld.abort();
    await this.roadWorld.clearAllWorlds?.();
    await this.roadWorld.clearCurrentWorld();
    await clearFrontlineRoadsCaches();
    const cleared = await this.saveRepository.clearAsync();
    if (!cleared && this.saveRepository.isAvailable()) {
      this.showNotificationMessage('app.resetSaveFailed', {}, '保存データを初期化できませんでした。');
      return false;
    }
    location.reload();
    return true;
  }

  destroy() {
    this.gameLoop.stop({ save: this.tabCoordinator.isPrimary() });
    this.stopLocationWatch?.();
    this.tabCoordinator.release();
    this.startupGeneration += 1;
    this.roadLoadController?.abort();
    this.initialRoadExpansionPending = false;
    this.baseScreen.destroy();
    this.mapInput.destroy();
    this.roadWorld.destroy();
    this.renderer.destroy();
    this.events.clear();
  }
}

let app = null;
let startup = null;

try {
  app = new FrontlineRoadsApp();
  startup = app.start();
  startup.then(() => {
    globalThis.__FRONTLINE_BOOT_COMPLETE__?.();
    return registerPwa();
  }).catch(error => {
    globalThis.__FRONTLINE_BOOT_COMPLETE__?.();
    app?.handleFatal(error);
  });
} catch (error) {
  globalThis.__FRONTLINE_BOOT_COMPLETE__?.();
  console.error(error);
}

globalThis.addEventListener('error', event => {
  if (event?.error) app?.handleFatal(event.error);
});
globalThis.addEventListener('unhandledrejection', event => app?.handleFatal(event.reason));
globalThis.addEventListener?.('pagehide', () => app?.handlePageHide());
document.addEventListener('freeze', () => app?.handlePageHide());
globalThis.addEventListener('pageshow', event => {
  if (!event.persisted && !document.wasDiscarded) return;
  startup?.then(() => app?.handlePageShow()).catch(error => app?.handleFatal(error));
});
