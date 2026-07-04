import { enemyTotalPopulation } from '../combat/enemy-grouping.js';
import { distance } from '../core/utilities.js';
import { DEFENSE_DEFINITIONS, ENEMY_BASE_DEFINITIONS, ENEMY_DEFINITIONS, defenseRuntimeDefinition } from '../combat/definitions.js';
import { deploymentBases, ownedBaseById } from '../base/field-bases.js';
import { constructionRangeSummary } from '../base/construction-range.js';
import { basePressureProfile } from '../base/base-pressure.js';
import { defensePresentation, uniqueDefenseDescriptionParagraphs } from '../combat/defense-presentation.js';
import { surveyFacilityPresentation } from '../exploration/survey-system.js';
import { scaleEnemyDefinition } from '../combat/enemy-scaling.js';
import { enemyBehaviorForDefinition, waveDoctrineDefinition } from '../combat/enemy-personalities.js';
import { defenseWorldPosition } from '../combat/combat-geometry.js';
import { enemyPosition } from '../combat/enemy-system.js';
import { FRIENDLY_SQUAD_DEFINITIONS, FRIENDLY_SQUAD_ORDER, FRIENDLY_SQUAD_STATUS, friendlySquadPosition } from '../combat/friendly-force-system.js';
import { friendlySquadRuntimeDefinition, friendlySquadLevel, friendlySquadXpForNextLevel } from '../combat/friendly-force-definitions.js';
import { recoveryPresentation } from '../combat/friendly-recovery-system.js';
import { medicalCoverageForSquad } from '../combat/friendly-healing-system.js';
import {
  FRIENDLY_ORDER_MODE,
  buildDeploymentRouteOptions,
  buildFriendlyRouteOptions,
  commandStartNodeId,
  deploymentRouteSubject,
  friendlyRouteIndexAtPoint,
  nearestRoadNode,
  orderDestinationNodeId,
  validateRetreatDestination
} from '../combat/friendly-route-planner.js';
import { remainingRouteDistance } from '../rendering/threat-analysis.js';
import { bundleText } from '../civilization/inventory-system.js';
import { frontierPresentation } from '../exploration/frontier-system.js';
import { RECOVERY_COLLECTION_DURATION_SECONDS, RECOVERY_ITEM_STATUS, RECOVERY_RANGE_METERS, isRecoveryItemVisible, recoveryEligibility, recoveryItemPoint, recoveryItemPresentation, recoveryItemStatusPresentation } from '../exploration/recovery-system.js';
import { RESOURCE_LABELS } from '../civilization/data.js';
import { defenseUpgradeStatus } from '../civilization/defense-upgrade.js';
import { queryRequired, setVisible, uiViewState } from './dom.js';
import { ensureRoadsideSupplyState, ROADSIDE_USE_DEFINITIONS } from '../exploration/roadside-supplies.js';


const UI_CHROME_MESSAGE_KEYS = Object.freeze({
  'ROUTES': 'ui.chrome.routes', 'SELECT': 'ui.chrome.select', 'DIST': 'ui.chrome.dist', 'ETA': 'ui.chrome.eta', 'RISK': 'ui.chrome.risk', 'CONTACT': 'ui.chrome.contact', 'VIA': 'ui.chrome.via', 'STATUS': 'ui.chrome.status', 'READY': 'ui.chrome.ready', 'SITES': 'ui.chrome.sites', 'SOURCE': 'ui.chrome.source', 'TYPE': 'ui.chrome.type', 'RADIUS': 'ui.chrome.radius', 'TRIGGER': 'ui.chrome.trigger', 'NODE': 'ui.chrome.node', 'ENTRY': 'ui.chrome.entry', 'TIME': 'ui.chrome.time', 'LOOT': 'ui.chrome.loot', 'RECOVERY': 'ui.chrome.recovery', 'BASE': 'ui.chrome.base', 'HEAL': 'ui.chrome.heal', 'HP': 'ui.chrome.hp', 'LV': 'ui.chrome.lv', 'XP': 'ui.chrome.xp', 'NEXT': 'ui.chrome.next', 'MEN': 'ui.chrome.men', 'ROLE': 'ui.chrome.role', 'ORDER': 'ui.chrome.order', 'SPEED': 'ui.chrome.speed', 'ENEMY DPS': 'ui.chrome.enemyDps', 'BASE DPS': 'ui.chrome.baseDps', 'RANGE': 'ui.chrome.range', 'ORIGIN': 'ui.chrome.origin', 'TARGET': 'ui.chrome.target', 'LEVEL': 'ui.chrome.level', 'PERSONA': 'ui.chrome.persona', 'TACTIC': 'ui.chrome.tactic', 'ROUTE': 'ui.chrome.route', 'DETOUR': 'ui.chrome.detour', 'DAMAGE': 'ui.chrome.damage', 'OBJECTIVE': 'ui.chrome.objective', 'SIGNAL': 'ui.chrome.signal', 'THREAT': 'ui.chrome.threat', 'YOU': 'ui.chrome.you', 'WAVES': 'ui.chrome.waves', 'ATTACKERS': 'ui.chrome.attackers', 'PRESSURE': 'ui.chrome.pressure', 'EXPANDED': 'ui.chrome.expanded', 'REMAIN': 'ui.chrome.remain', 'COMM': 'ui.chrome.comm', 'LINK': 'ui.chrome.link', 'RESPONSE': 'ui.chrome.response', 'ROADS': 'ui.chrome.roads', 'RETRY': 'ui.chrome.retry', 'TIER': 'ui.chrome.tier', 'CIV': 'ui.chrome.civ', 'KILLS': 'ui.chrome.kills', 'COST': 'ui.chrome.cost', 'FROM': 'ui.chrome.from', 'UNIT': 'ui.chrome.unit', 'SLOT': 'ui.chrome.slot', 'TIMING': 'ui.chrome.timing', 'ARRIVAL': 'ui.chrome.arrival', 'NO GPS': 'ui.chrome.noGps', 'RECALC': 'ui.chrome.recalc', 'UNDER ATTACK': 'ui.chrome.underAttack', 'HOSTILE': 'ui.chrome.hostile', 'NONE': 'ui.chrome.none', 'AUTO': 'ui.chrome.auto', 'MAX': 'ui.chrome.max', 'DONE': 'ui.chrome.done', 'CARRIED': 'ui.chrome.carried', 'EN ROUTE': 'ui.chrome.enRoute', 'COLLECTED': 'ui.chrome.collected', 'COMMON': 'ui.chrome.common', 'RARE': 'ui.chrome.rare', 'EPIC': 'ui.chrome.epic', 'LEGENDARY': 'ui.chrome.legendary'
});


function unitProgressText(squad) {
  const level = friendlySquadLevel(squad);
  if (level >= 5) return { level, xpText: 'MAX', nextText: '最大' };
  const next = friendlySquadXpForNextLevel(level);
  const current = Math.floor(Number(squad?.unitXp) || 0);
  return { level, xpText: `${current}/${Number.isFinite(next) ? next : 'MAX'}`, nextText: Number.isFinite(next) ? String(Math.max(0, next - current)) : '最大' };
}

function squadRecoveryRemainingSeconds(recovery, squad) {
  const reorganization = Math.max(0, Number(recovery?.reorganizationRemaining) || 0);
  const profile = recovery?.profile;
  const healingRate = Math.max(0, Number(profile?.healRatioPerSecond) || 0);
  const targetHp = Math.max(Number(squad?.hp) || 0, Number(recovery?.targetHp) || 0);
  const healRemaining = healingRate > 0
    ? Math.max(0, targetHp - (Number(squad?.hp) || 0)) / Math.max(0.0001, (Number(squad?.maxHp) || 1) * healingRate)
    : 0;
  return Math.max(reorganization, healRemaining);
}

function enemyBaseAnchorPresentation(state, enemyBase) {
  const anchor = enemyBase?.frontlineAnchorBaseId ? ownedBaseById(state, enemyBase.frontlineAnchorBaseId, { includeDestroyed: false }) : null;
  if (!anchor) {
    return {
      targetKey: 'combat.panel.enemyBaseCoreTarget',
      targetFallback: '本拠地・周辺拠点',
      pressureKey: 'combat.panel.pressureFull',
      pressureFallback: '本格',
      riskKey: 'combat.panel.enemyBaseRiskCore',
      riskFallback: '放置すると本拠地または周辺施設へ侵攻します。'
    };
  }
  const kind = anchor.kind === 'FIELD' ? 'FIELD' : 'MAJOR';
  const profile = basePressureProfile(state, anchor, kind);
  return {
    target: anchor.name ?? (kind === 'FIELD' ? '簡易拠点' : '主要拠点'),
    pressure: `${profile.stageLabel} ${Math.round(profile.ratio * 100)}%`,
    riskKey: 'combat.panel.enemyBaseRiskAnchor',
    riskParams: { baseName: anchor.name ?? 'この拠点' },
    riskFallback: `放置すると${anchor.name ?? 'この拠点'}への攻撃が強まります。`
  };
}

function enemyBaseNextWaveState(state, enemyBase) {
  const now = Number(state.runtime?.worldTimeMs) || Date.now();
  const readyAt = Number(enemyBase?.frontlineFirstWaveReadyAt) || 0;
  if (readyAt > now) return { key: 'combat.panel.nextWaveMinutes', params: { minutes: Math.max(1, Math.ceil((readyAt - now) / 60000)) }, fallback: `約${Math.max(1, Math.ceil((readyAt - now) / 60000))}分` };
  if (Math.max(0, Math.floor(Number(enemyBase?.wavesSent) || 0)) <= 0) return { key: 'combat.panel.nextWaveReady', params: {}, fallback: '準備完了' };
  return { key: 'combat.panel.nextWavePeriodic', params: {}, fallback: '周期的に発生' };
}

export class CombatUi {
  constructor({ store, buildSystem, civilizationSystem, explorationSystem, recoverySystem, friendlyForceSystem, roadsideSupplySystem = null, commandBus = null, camera, renderer, notifications, persist = null, openDeployment = null, requestSurvey = null, i18n = null }) {
    this.store = store;
    this.buildSystem = buildSystem;
    this.civilizationSystem = civilizationSystem;
    this.recoverySystem = recoverySystem;
    this.friendlyForceSystem = friendlyForceSystem;
    this.roadsideSupplySystem = roadsideSupplySystem;
    this.commandBus = commandBus;
    this.persist = persist;
    this.openDeployment = openDeployment;
    this.requestSurvey = requestSurvey;
    this.camera = camera;
    this.renderer = renderer;
    this.notifications = notifications;
    this.i18n = i18n;
    this.selectedTool = 'select';
    this.selectedObject = null;
    this.buildCandidate = null;
    this.buildSites = [];
    this.buildPlacementSignature = '';
    this.buildContextSignature = '';
    this.toolAffordabilitySignature = '';
    this.toolLanguageSignature = '';
    this.orderPlanning = null;
    this.contextDisclosureKey = '';
    this.contextDisclosureOpen = false;
    this.pendingDefenseRemovalId = null;
    this.defensePanelMode = 'summary';
    this.defensePanelDefenseId = null;
    this.tools = queryRequired('#combatTools');
    this.cityHp = queryRequired('#cityHp');
    this.enemyCount = queryRequired('#enemyCount');
    this.civilizationLevel = queryRequired('#civilizationLevel');
    this.context = queryRequired('#contextPanel');
    this.contextTitle = queryRequired('#contextTitle');
    this.contextText = queryRequired('#contextText');
    this.contextActions = queryRequired('#contextActions');
    this.renderTools();
  }

  localize(text = '') { return this.i18n?.copy?.(text) ?? text; }

  msg(key, params = {}, fallback = '') { return this.i18n?.message?.(key, params, fallback) ?? this.localize(fallback || key); }

  messagePayload(key, params = {}, fallback = '') { return { key, params, text: fallback }; }

  panelMsg(key, params = {}, fallback = '') { return this.msg(key, params, fallback); }

  actionMsg(key, params = {}, fallback = '') { return this.msg(key, params, fallback); }

  itemMsg(key, params = {}, fallback = '') { return this.msg(key, params, fallback); }

  itemPayload(key, params = {}, fallback = '') { return this.messagePayload(key, params, fallback); }

  textValue(value) {
    if (value && typeof value === 'object' && typeof value.key === 'string') {
      return this.msg(value.key, value.params ?? {}, value.fallback ?? value.key);
    }
    const raw = String(value ?? '');
    const chromeKey = UI_CHROME_MESSAGE_KEYS[raw.trim().toUpperCase()];
    if (chromeKey) return this.msg(chromeKey, {}, raw);
    return this.localize(raw);
  }

  chromeText(text = '') {
    return this.textValue(String(text ?? ''));
  }

  defenseText(presentation, field) {
    const key = presentation?.[`${field}Key`];
    const fallback = presentation?.[field] ?? '';
    return key ? this.panelMsg(key, {}, fallback) : this.localize(fallback);
  }

  secondsText(value) {
    const seconds = Number(value).toFixed(Number(value) < 10 ? 1 : 0);
    return this.panelMsg('combat.panel.seconds', { seconds }, `${seconds}秒`);
  }

  showMessage(key, params = {}, fallback = '') { this.notifications.show(this.messagePayload(key, params, fallback)); }

  reasonPayload(resultOrReason, fallbackKey, fallbackText) {
    if (resultOrReason && typeof resultOrReason === 'object') {
      if (resultOrReason.reasonKey) return this.messagePayload(resultOrReason.reasonKey, resultOrReason.reasonParams ?? {}, resultOrReason.reason ?? fallbackText);
      if (typeof resultOrReason.key === 'string') return this.messagePayload(resultOrReason.key, resultOrReason.params ?? {}, resultOrReason.text ?? resultOrReason.fallback ?? fallbackText);
      return this.messagePayload(fallbackKey, {}, resultOrReason.reason ?? fallbackText);
    }
    return resultOrReason ? this.messagePayload(fallbackKey, {}, String(resultOrReason)) : this.messagePayload(fallbackKey, {}, fallbackText);
  }

  resultMessagePayload(result, fallbackKey = 'combat.panel.actionDone', fallbackText = '操作を実行しました。') {
    if (result?.messageKey) return this.messagePayload(result.messageKey, result.messageParams ?? {}, result.message ?? fallbackText);
    if (result?.key) return this.messagePayload(result.key, result.params ?? {}, result.text ?? result.fallback ?? fallbackText);
    return this.messagePayload(fallbackKey, {}, result?.message ?? fallbackText);
  }

  resultMessageText(result, fallbackKey = 'combat.panel.actionDone', fallbackText = '操作を実行しました。') {
    const payload = this.resultMessagePayload(result, fallbackKey, fallbackText);
    return this.msg(payload.key, payload.params ?? {}, payload.text ?? fallbackText);
  }

  reasonText(resultOrReason, fallbackKey = 'combat.panel.unavailable', fallbackText = '利用不可') {
    const payload = this.reasonPayload(resultOrReason, fallbackKey, fallbackText);
    return payload && typeof payload === 'object' && payload.key ? this.msg(payload.key, payload.params ?? {}, payload.text ?? fallbackText) : String(payload ?? '');
  }

  showReason(resultOrReason, fallbackKey, fallbackText) {
    this.notifications.show(this.reasonPayload(resultOrReason, fallbackKey, fallbackText));
  }

  orderModeLabel(mode) {
    if (mode === FRIENDLY_ORDER_MODE.DEPLOYMENT) return this.msg('combat.order.modeDeployment', {}, '派兵');
    if (mode === FRIENDLY_ORDER_MODE.RETREAT) return this.msg('combat.order.modeRetreat', {}, '後退');
    if (mode === FRIENDLY_ORDER_MODE.WITHDRAW) return this.msg('combat.order.modeWithdraw', {}, '撤退');
    return this.msg('combat.order.modeResume', {}, '進軍再開');
  }

  orderRouteLabel(route) {
    if (!route) return this.msg('combat.order.routeNone', {}, 'NONE');
    const id = String(route.id ?? '');
    if (id === 'shortest') return this.msg('combat.order.route.shortest', {}, '最短');
    if (id === 'safe') return this.msg('combat.order.route.safe', {}, '敵回避');
    if (id === 'support') return this.msg('combat.order.route.support', {}, '味方援護');
    const detour = id.match(/^detour-(\d+)$/);
    if (detour) return this.msg('combat.order.route.detour', { index: detour[1] }, `別経路${detour[1]}`);
    return this.msg('combat.order.route.unknown', {}, route.label ?? '選択経路');
  }

  shortLabel(text = '') { return this.i18n?.short?.(text) ?? this.localize(text); }

  compactBundle(bundle = {}) { return this.i18n?.compactBundleText?.(bundle) ?? bundleText(bundle); }

  clearObjectSelection({ hideContext = true } = {}) {
    if (this.orderPlanning) {
      const cancelled = this.orderPlanning;
      this.orderPlanning = null;
      this.renderer.setFriendlyOrderPlanning(null);
      cancelled.onCancel?.();
    }
    this.selectedObject = null;
    this.pendingDefenseRemovalId = null;
    this.defensePanelMode = 'summary';
    this.defensePanelDefenseId = null;
    this.renderer.setFocus(null);
    this.buildContextSignature = '';
    if (hideContext) setVisible(this.context, false);
  }

  handleEnemyBaseDestroyed(baseId) {
    if (this.selectedObject?.kind !== 'enemyBase' || this.selectedObject.id !== baseId) return;
    this.clearObjectSelection();
  }

  handleOwnedBaseRemoved({ cleanup = null } = {}) {
    if (!cleanup || !Number(cleanup.demobilizedSquads)) return;
    const state = uiViewState(this.store);
    if (this.selectedObject?.kind === 'friendlySquad' && !(state.combat?.friendlySquads ?? []).some(squad => squad.id === this.selectedObject.id && squad.hp > 0)) {
      this.clearObjectSelection();
      return;
    }
    if (this.orderPlanning?.squadId && !(state.combat?.friendlySquads ?? []).some(squad => squad.id === this.orderPlanning.squadId && squad.hp > 0)) {
      this.clearObjectSelection();
    }
  }

  contextDisclosureIdentity() {
    if (this.selectedTool !== 'select') return `build:${this.selectedTool}`;
    if (this.orderPlanning) return `order:${this.selectedObject?.id ?? 'none'}:${this.orderPlanning.mode ?? 'unknown'}`;
    if (this.selectedObject) return `${this.selectedObject.kind}:${this.selectedObject.id}`;
    return 'none';
  }

  affordabilitySignature(state) {
    return Object.keys(DEFENSE_DEFINITIONS)
      .map(type => `${type}:${this.buildSystem.canAfford(state, type) ? 1 : 0}`)
      .join('|');
  }

  renderTools(state = uiViewState(this.store)) {
    this.toolAffordabilitySignature = this.affordabilitySignature(state);
    this.toolLanguageSignature = this.i18n?.language ?? 'ja';
    this.tools.textContent = '';
    const entries = [['select', { name: this.msg('combat.panel.selectTool', {}, '選択'), icon: '☝', cost: null }], ...Object.entries(DEFENSE_DEFINITIONS)];
    for (const [type, definition] of entries) {
      const affordable = type === 'select' || this.buildSystem.canAfford(state, type);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `toolButton${type === this.selectedTool ? ' is-selected' : ''}${affordable ? '' : ' is-unaffordable'}`;
      button.dataset.tool = type;
      button.setAttribute?.('aria-pressed', String(type === this.selectedTool));
      const cost = definition.cost ? this.compactBundle(definition.cost) : '';
      const label = type === 'select' ? definition.name : this.shortLabel(definition.name);
      const icon = document.createElement('strong');
      icon.textContent = definition.icon ?? '';
      const labelNode = document.createElement('span');
      labelNode.textContent = label;
      button.append(icon, labelNode);
      if (cost) {
        const costNode = document.createElement('small');
        costNode.textContent = cost;
        button.appendChild(costNode);
      }
      button.addEventListener('click', () => this.selectTool(type));
      this.tools.appendChild(button);
    }
  }

  selectTool(type) {
    this.selectedTool = type === 'select' || DEFENSE_DEFINITIONS[type] ? type : 'select';
    this.buildCandidate = null;
    this.buildPlacementSignature = '';
    this.buildContextSignature = '';
    this.clearObjectSelection({ hideContext: this.selectedTool === 'select' });
    this.renderTools();

    if (this.selectedTool === 'select') {
      this.buildSites = [];
      this.renderer.setBuildPlacement(null);
      this.context.classList?.remove('is-build-mode', 'has-candidate', 'is-order-mode', 'is-defense-mode', 'is-defense-summary', 'is-defense-details', 'is-defense-upgrade', 'is-target-mode');
      this.showMessage('combat.selectToolReady', {}, '設備・敵拠点・部隊を選択できます。');
      return;
    }

    this.refreshBuildPlacement(true);
    this.renderContext();
    const presentation = defensePresentation(this.selectedTool);
    const role = this.defenseText(presentation, 'role') || this.panelMsg('combat.panel.buildRoleFallback', {}, '建設');
    this.showMessage('combat.panel.buildToolPrompt', { role }, `${role}：表示された有効地点を選択してください。`);
  }

  placementSignature(state) {
    if (this.selectedTool === 'select') return 'select';
    const definition = DEFENSE_DEFINITIONS[this.selectedTool];
    const affordabilityState = this.buildSystem.canAfford(state, this.selectedTool) ? 'affordable' : 'unaffordable';
    const occupiedState = state.combat.defenses
      .filter(defense => defense.kind === definition.kind)
      .map(defense => `${defense.id}:${defense.hp > 0 ? 1 : 0}`)
      .join(',');
    const graph = state.world.roadGraph;
    const topologyRevision = Math.max(1, Math.floor(Number(graph?.topologyRevision) || 1));
    const anchorState = this.buildSystem.getBuildAnchors(state)
      .map(anchor => `${anchor.id}:${anchor.point.x.toFixed(1)},${anchor.point.y.toFixed(1)}:${Number(anchor.range).toFixed(0)}`)
      .join(';');
    return [
      this.selectedTool,
      affordabilityState,
      occupiedState,
      topologyRevision,
      graph?.nodes?.length ?? 0,
      graph?.edges?.length ?? 0,
      anchorState
    ].join('|');
  }

  refreshBuildPlacement(force = false, state = uiViewState(this.store)) {
    if (this.selectedTool === 'select') {
      this.renderer.setBuildPlacement(null);
      return;
    }
    const signature = this.placementSignature(state);
    if (!force && signature === this.buildPlacementSignature) return;

    if (this.buildCandidate) {
      const validation = this.buildSystem.validateCandidate(state, this.buildCandidate, { checkResources: false });
      this.buildCandidate = validation.ok ? validation.candidate : null;
    }
    this.buildSites = this.buildSystem.listBuildSites(state, this.selectedTool);
    const buildStatus = this.buildSystem.getBuildStatus(state, this.selectedTool);
    const affordable = buildStatus.ok;
    this.renderer.setBuildPlacement({
      type: this.selectedTool,
      anchors: this.buildSystem.getBuildAnchors(state),
      sites: this.buildSites,
      candidate: this.buildCandidate,
      affordable
    });
    this.buildPlacementSignature = signature;
  }

  nearestObject(state, point, tolerance, afterObject = null) {
    const graph = state.world.roadGraph;
    const candidates = [];
    for (const item of state.world.recoveryItems ?? []) {
      if (!isRecoveryItemVisible(item) || item.status === RECOVERY_ITEM_STATUS.CARRIED) continue;
      const itemPosition = recoveryItemPoint(state, item);
      candidates.push({ kind: 'recoveryItem', id: item.id, point: itemPosition, distance: distance(point, itemPosition), priority: item.status === RECOVERY_ITEM_STATUS.RESERVED ? 1 : 0 });
    }
    for (const mine of state.world.roadsideSupplies?.placedMines ?? []) {
      if (Number.isFinite(Number(mine.x)) && Number.isFinite(Number(mine.y))) {
        candidates.push({ kind: 'roadsideMine', id: mine.id, point: { x: Number(mine.x), y: Number(mine.y) }, distance: distance(point, mine), priority: -1 });
      }
    }
    for (const source of state.world.frontierSources ?? []) {
      if (source.status === 'CLEARED') continue;
      const node = graph.nodeById.get(source.entryNodeId);
      if (node) candidates.push({ kind: 'frontier', id: source.id, point: node, distance: distance(point, node) });
    }
    for (const base of state.world.enemyBases) {
      if (!base.alive) continue;
      const node = graph.nodeById.get(base.nodeId);
      if (node) candidates.push({ kind: 'enemyBase', id: base.id, point: node, distance: distance(point, node) });
    }
    for (const defense of state.combat.defenses) {
      const position = defenseWorldPosition(graph, defense);
      if (position) candidates.push({
        kind: 'defense',
        id: defense.id,
        point: position,
        distance: distance(point, position),
        priority: 0
      });
    }
    for (const enemy of state.combat.enemies) {
      if (enemy.hp <= 0 || enemy.departDelay > 0) continue;
      const position = enemyPosition(state, enemy);
      candidates.push({ kind: 'enemy', id: enemy.id, point: position, distance: distance(point, position) });
    }
    for (const squad of state.combat.friendlySquads ?? []) {
      if (squad.hp <= 0 || [FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(squad.status)) continue;
      const position = friendlySquadPosition(state, squad);
      candidates.push({ kind: 'friendlySquad', id: squad.id, point: position, distance: distance(point, position) });
    }
    const city = graph.nodeById.get(state.world.city.nodeId);
    if (city) candidates.push({ kind: 'city', id: 'city', point: city, distance: distance(point, city) });
    candidates.sort((a, b) => a.distance - b.distance || (a.priority ?? 0) - (b.priority ?? 0));
    const nearby = candidates.filter(candidate => candidate.distance <= tolerance);
    if (afterObject && nearby.length > 1) {
      const selectedIndex = nearby.findIndex(candidate => candidate.kind === afterObject.kind && candidate.id === afterObject.id);
      if (selectedIndex >= 0) return nearby[(selectedIndex + 1) % nearby.length];
    }
    return nearby[0] ?? null;
  }

  selectedFriendlySquad(state = uiViewState(this.store)) {
    if (this.selectedObject?.kind !== 'friendlySquad') return null;
    return (state.combat.friendlySquads ?? []).find(squad => squad.id === this.selectedObject.id && squad.hp > 0) ?? null;
  }

  updateOrderPlanningOverlay() {
    this.renderer.setFriendlyOrderPlanning(this.orderPlanning ? {
      squadId: this.orderPlanning.squadId ?? null,
      originNodeId: this.orderPlanning.originNodeId ?? null,
      squadType: this.orderPlanning.squadType ?? null,
      mode: this.orderPlanning.mode,
      destinationNodeId: this.orderPlanning.destinationNodeId,
      waypointNodeIds: [...this.orderPlanning.waypointNodeIds],
      routes: this.orderPlanning.routes,
      selectedRouteIndex: this.orderPlanning.selectedRouteIndex,
    } : null);
  }

  planningSubject(state = uiViewState(this.store)) {
    if (!this.orderPlanning) return null;
    if (this.orderPlanning.mode === FRIENDLY_ORDER_MODE.DEPLOYMENT) {
      const originNodeId = this.orderPlanning.originNodeId;
      return state.world.roadGraph.nodeById.has(originNodeId)
        ? deploymentRouteSubject(this.orderPlanning.squadType, originNodeId)
        : null;
    }
    return (state.combat.friendlySquads ?? []).find(item => item.id === this.orderPlanning.squadId && item.hp > 0) ?? null;
  }

  rebuildOrderRoutes(state = uiViewState(this.store)) {
    if (!this.orderPlanning) return;
    const subject = this.planningSubject(state);
    if (!subject) { this.cancelOrderPlanning(); return; }
    const deployment = this.orderPlanning.mode === FRIENDLY_ORDER_MODE.DEPLOYMENT;
    this.orderPlanning.startNodeId = deployment
      ? this.orderPlanning.originNodeId
      : commandStartNodeId(state, subject);
    this.orderPlanning.routes = this.orderPlanning.destinationNodeId
      ? deployment
        ? buildDeploymentRouteOptions(state, this.orderPlanning.squadType, this.orderPlanning.originNodeId, this.orderPlanning.destinationNodeId, this.orderPlanning.waypointNodeIds)
        : buildFriendlyRouteOptions(state, subject, this.orderPlanning.destinationNodeId, this.orderPlanning.waypointNodeIds)
      : [];
    this.orderPlanning.selectedRouteIndex = Math.min(
      this.orderPlanning.selectedRouteIndex,
      Math.max(0, this.orderPlanning.routes.length - 1)
    );
    this.updateOrderPlanningOverlay();
  }

  beginDeploymentRoutePlanning({ originNodeId, squadType, destinationNodeId, targetLabel = '敵拠点', confirmLabel = null, onConfirm = null, onCancel = null }) {
    const state = uiViewState(this.store);
    if (!state.world.roadGraph.nodeById.has(originNodeId) || !state.world.roadGraph.nodeById.has(destinationNodeId)) {
      this.showMessage('combat.routeEndpointsMissing', {}, '派兵経路の始点または目的地が道路上にありません。');
      return false;
    }
    this.selectedTool = 'select';
    this.buildCandidate = null;
    this.buildSites = [];
    this.selectedObject = null;
    this.renderer.setBuildPlacement(null);
    this.renderer.setFocus(null);
    this.buildContextSignature = '';
    this.renderTools();
    this.orderPlanning = {
      mode: FRIENDLY_ORDER_MODE.DEPLOYMENT,
      squadId: null,
      originNodeId,
      squadType,
      destinationNodeId,
      targetLabel,
      waypointNodeIds: [],
      routes: [],
      selectedRouteIndex: 0,
      confirmLabel,
      onConfirm,
      onCancel
    };
    this.rebuildOrderRoutes(state);
    this.renderContext(state);
    this.showMessage('combat.deploymentRoutePrompt', {}, '派兵経路を選択してください。MAP上で最大2か所の経由地点を追加できます。');
    return true;
  }

  beginOrderPlanning(mode) {
    const state = uiViewState(this.store);
    const squad = this.selectedFriendlySquad(state);
    if (!squad) return;
    const destinationNodeId = orderDestinationNodeId(state, squad, mode);
    if (mode !== FRIENDLY_ORDER_MODE.RETREAT && !destinationNodeId) {
      this.showMessage(mode === FRIENDLY_ORDER_MODE.RESUME ? 'combat.resumeTargetLost' : 'combat.withdrawRouteUnavailable', {}, mode === FRIENDLY_ORDER_MODE.RESUME ? '元の攻撃目標は既に失われています。' : '出撃元へ戻る経路を設定できません。');
      return;
    }
    this.selectedTool = 'select';
    this.buildCandidate = null;
    this.buildSites = [];
    this.renderer.setBuildPlacement(null);
    this.renderTools();
    this.orderPlanning = {
      mode,
      squadId: squad.id,
      destinationNodeId,
      waypointNodeIds: [],
      routes: [],
      selectedRouteIndex: 0
    };
    this.rebuildOrderRoutes();
    this.renderContext();
    this.showMessage(mode === FRIENDLY_ORDER_MODE.RETREAT
      ? 'combat.retreatRoutePrompt'
      : 'combat.orderRoutePrompt', {}, mode === FRIENDLY_ORDER_MODE.RETREAT
        ? 'MAP上で後退地点を選択してください。続けて最大2か所の経由地点を追加できます。'
        : '表示された経路を選ぶか、MAP上で最大2か所の経由地点を追加してください。');
  }

  handleOrderPlanningTap(worldPoint) {
    const state = uiViewState(this.store);
    const squad = this.planningSubject(state);
    if (!this.orderPlanning || !squad) return;
    if (this.orderPlanning.destinationNodeId && this.orderPlanning.routes.length) {
      const routeIndex = friendlyRouteIndexAtPoint(state, squad, this.orderPlanning.routes, worldPoint, 12 / this.camera.scale);
      if (routeIndex >= 0) {
        this.selectOrderRoute(routeIndex);
        this.showMessage('combat.routeSelected', { routeLabel: this.orderRouteLabel(this.orderPlanning.routes[routeIndex]) }, `${this.orderPlanning.routes[routeIndex].label}ルートを選択しました。`);
        return;
      }
    }
    const nearest = nearestRoadNode(state, worldPoint, 28 / this.camera.scale);
    if (!nearest) { this.showMessage('combat.selectRoadJunctionOrRoute', {}, '道路上の交差点または経路線を選択してください。'); return; }
    const nodeId = nearest.node.id;
    if (this.orderPlanning.mode === FRIENDLY_ORDER_MODE.RETREAT && !this.orderPlanning.destinationNodeId) {
      const validation = validateRetreatDestination(state, squad, nodeId);
      if (!validation.ok) {
        this.showMessage(validation.reasonKey ?? 'combat.order.invalidRetreatDestination', validation.reasonParams ?? {}, validation.reason ?? '後退地点を選択できません。');
        return;
      }
      this.orderPlanning.destinationNodeId = nodeId;
      this.orderPlanning.waypointNodeIds = [];
      this.orderPlanning.selectedRouteIndex = 0;
      this.rebuildOrderRoutes();
      this.renderContext();
      return;
    }
    const startNodeId = this.orderPlanning.mode === FRIENDLY_ORDER_MODE.DEPLOYMENT
      ? this.orderPlanning.originNodeId
      : commandStartNodeId(state, squad);
    if (nodeId === this.orderPlanning.destinationNodeId || nodeId === startNodeId) {
      this.showMessage('combat.selectDifferentWaypoint', {}, '目的地または現在の進路先とは別の交差点を選択してください。');
      return;
    }
    if (this.orderPlanning.waypointNodeIds.includes(nodeId)) {
      this.showMessage('combat.waypointAlreadySelected', {}, 'その経由地点は既に選択されています。');
      return;
    }
    if (this.orderPlanning.waypointNodeIds.length >= 2) {
      this.showMessage('combat.waypointLimit', {}, '経由地点は最大2か所です。');
      return;
    }
    this.orderPlanning.waypointNodeIds.push(nodeId);
    this.orderPlanning.selectedRouteIndex = 0;
    this.rebuildOrderRoutes();
    this.renderContext();
  }

  cancelOrderPlanning() {
    const cancelled = this.orderPlanning;
    this.orderPlanning = null;
    this.updateOrderPlanningOverlay();
    cancelled?.onCancel?.();
    this.renderContext();
  }

  removeLastWaypoint() {
    if (!this.orderPlanning?.waypointNodeIds.length) return;
    this.orderPlanning.waypointNodeIds.pop();
    this.orderPlanning.selectedRouteIndex = 0;
    this.rebuildOrderRoutes();
    this.renderContext();
  }

  resetRetreatDestination() {
    if (!this.orderPlanning || this.orderPlanning.mode !== FRIENDLY_ORDER_MODE.RETREAT) return;
    this.orderPlanning.destinationNodeId = null;
    this.orderPlanning.waypointNodeIds = [];
    this.orderPlanning.routes = [];
    this.orderPlanning.selectedRouteIndex = 0;
    this.updateOrderPlanningOverlay();
    this.renderContext();
  }

  selectOrderRoute(index) {
    if (!this.orderPlanning || !this.orderPlanning.routes[index]) return;
    this.orderPlanning.selectedRouteIndex = index;
    this.updateOrderPlanningOverlay();
    this.renderContext();
  }

  confirmOrderPlanning() {
    if (!this.orderPlanning) return;
    const priorIndex = this.orderPlanning.selectedRouteIndex;
    this.rebuildOrderRoutes();
    this.orderPlanning.selectedRouteIndex = Math.min(priorIndex, Math.max(0, this.orderPlanning.routes.length - 1));
    const route = this.orderPlanning.routes[this.orderPlanning.selectedRouteIndex];
    if (!route) { this.showMessage('combat.noExecutableRoute', {}, '実行可能な道路経路がありません。'); return; }
    if (this.orderPlanning.mode === FRIENDLY_ORDER_MODE.DEPLOYMENT) {
      const completed = this.orderPlanning;
      this.orderPlanning = null;
      this.updateOrderPlanningOverlay();
      completed.onConfirm?.({
        route: { ...route, path: { ...route.path, nodeIds: [...route.path.nodeIds], edgeIds: [...route.path.edgeIds] } },
        waypointNodeIds: [...completed.waypointNodeIds]
      });
      this.showMessage('combat.deploymentRouteConfirmed', { routeLabel: this.orderRouteLabel(route) }, `${route.label}ルートで派兵を確定しました。`);
      this.renderContext();
      return;
    }
    const currentState = uiViewState(this.store);
    const currentSquad = (currentState.combat.friendlySquads ?? []).find(item => item.id === this.orderPlanning.squadId);
    const order = this.orderPlanning.mode === FRIENDLY_ORDER_MODE.RETREAT
      ? FRIENDLY_SQUAD_ORDER.RETREAT
      : this.orderPlanning.mode === FRIENDLY_ORDER_MODE.WITHDRAW
        ? FRIENDLY_SQUAD_ORDER.WITHDRAW
        : currentSquad?.heldOrder === FRIENDLY_SQUAD_ORDER.RETREAT
          ? FRIENDLY_SQUAD_ORDER.RETREAT
          : FRIENDLY_SQUAD_ORDER.ADVANCE;
    const result = this.commandBus?.execute('friendly.routeOrder', {
      squadId: this.orderPlanning.squadId,
      order,
      path: route.path,
      destinationNodeId: this.orderPlanning.destinationNodeId
    }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    if (!result?.ok) { this.showReason(result, 'combat.orderFailed', '命令を実行できません。'); return; }
    this.orderPlanning = null;
    this.updateOrderPlanningOverlay();
    this.persist?.();
    this.showMessage(order === FRIENDLY_SQUAD_ORDER.RETREAT ? 'combat.retreatStarted' : order === FRIENDLY_SQUAD_ORDER.WITHDRAW ? 'combat.withdrawStarted' : 'combat.resumeStarted', {}, order === FRIENDLY_SQUAD_ORDER.RETREAT ? '後退を開始しました。' : order === FRIENDLY_SQUAD_ORDER.WITHDRAW ? '撤退を開始しました。' : '選択ルートで進軍を再開しました。');
    this.renderContext();
  }

  holdSelectedSquad() {
    const squad = this.selectedFriendlySquad();
    if (!squad) return;
    const result = this.commandBus?.execute('friendly.hold', { squadId: squad.id }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    this.notifications.show(result?.ok ? this.msg('combat.squadHeld', {}, '部隊を停止させました。') : this.reasonPayload(result, 'combat.holdFailed', '停止できません。'));
    if (result?.ok) this.persist?.();
    this.renderContext();
  }

  useRoadsideItemOnSelectedSquad(itemKey) {
    const squad = this.selectedFriendlySquad();
    if (!squad) { this.notifications.show(this.itemPayload('combat.item.selectSquadRequired', {}, '味方部隊を選択してください。')); return; }
    if (!this.roadsideSupplySystem?.useOnSquad) { this.notifications.show(this.itemPayload('combat.item.squadUseUnavailable', {}, '部隊用アイテムを使用できません。')); return; }
    const result = this.commandBus?.execute('roadside.useOnSquad', { key: itemKey, squadId: squad.id }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    this.notifications.show(result?.ok ? this.itemPayload('combat.item.squadUsed', {}, '部隊用アイテムを使用しました。') : this.reasonPayload(result, 'combat.item.squadUseFailed', 'アイテムを使用できません。'));
    if (result?.ok) this.persist?.();
    this.renderContext();
    this.renderer.render?.();
  }


  useLureSignalOnTarget(target) {
    if (!this.roadsideSupplySystem?.useLureTarget) { this.notifications.show(this.itemPayload('combat.item.lureUnavailable', {}, '誘導信号を使用できません。')); return; }
    const result = this.commandBus?.execute('roadside.useLureTarget', { target }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    this.notifications.show(result?.ok ? this.itemPayload('combat.item.lureUsed', {}, '誘導信号を使用しました。') : this.reasonPayload(result, 'combat.item.lureUnavailable', '誘導信号を使用できません。'));
    if (result?.ok) this.persist?.();
    this.renderContext();
    this.renderer.render?.();
  }

  useStrategicItemOnTarget(itemKey, target) {
    if (!this.roadsideSupplySystem?.useOnTarget) { this.notifications.show(this.itemPayload('combat.item.remoteSupportUnavailable', {}, '遠隔支援を使用できません。')); return; }
    const result = this.commandBus?.execute('roadside.useOnTarget', { key: itemKey, target }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    this.notifications.show(result?.ok ? this.itemPayload('combat.item.remoteSupportExecuted', { itemName: ROADSIDE_USE_DEFINITIONS[itemKey]?.name ?? '遠隔支援' }, `${ROADSIDE_USE_DEFINITIONS[itemKey]?.name ?? '遠隔支援'}を実行しました。`) : this.reasonPayload(result, 'combat.item.remoteSupportUnavailable', '遠隔支援を使用できません。'));
    if (result?.ok) this.persist?.();
    this.renderContext();
    this.renderer.render?.();
  }

  removeSelectedMine(mineId) {
    const result = this.commandBus?.execute('roadside.removeMine', { mineId }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    this.notifications.show(result?.ok ? this.itemPayload('combat.item.mineRemoved', {}, '地雷を撤去しました。') : this.reasonPayload(result, 'combat.item.mineRemoveFailed', '撤去できません。'));
    if (result?.ok) { this.persist?.(); this.clearObjectSelection(); }
    else this.renderContext();
    this.renderer.render?.();
  }

  appendSelectedSquadItemActions(state, squad) {
    if (!this.roadsideSupplySystem?.useOnSquad || !squad || squad.hp <= 0) return;
    if ([FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(squad.status)) return;
    const inventory = ensureRoadsideSupplyState(state).inventory ?? {};
    const marchCount = Math.max(0, Math.floor(Number(inventory.marchBanner) || 0));
    const smokeCount = Math.max(0, Math.floor(Number(inventory.smokeScreen) || 0));
    if (marchCount > 0) {
      const march = this.action(this.itemMsg('combat.item.marchBannerWithCount', { count: marchCount }, `行軍加速旗 ×${marchCount}`), () => this.useRoadsideItemOnSelectedSquad('marchBanner'), 'primary');
      march.title = this.itemMsg('combat.item.marchBannerTitle', {}, '選択中の部隊だけを一時加速します。現在地は参照しません。');
    }
    if (smokeCount > 0) {
      const smoke = this.action(this.itemMsg('combat.item.smokeScreenWithCount', { count: smokeCount }, `緊急撤退煙幕 ×${smokeCount}`), () => this.useRoadsideItemOnSelectedSquad('smokeScreen'), 'danger');
      smoke.title = this.itemMsg('combat.item.smokeScreenTitle', {}, '選択中の通常部隊を出撃元へ緊急撤退させます。現在地は参照しません。');
      smoke.disabled = Boolean(squad.temporaryDeployment) || [FRIENDLY_SQUAD_ORDER.RETURN, FRIENDLY_SQUAD_ORDER.WITHDRAW].includes(squad.order);
    }
  }


  appendStrategicItemActions(state, target) {
    if (!this.roadsideSupplySystem?.useOnTarget) return;
    const inventory = ensureRoadsideSupplyState(state).inventory ?? {};
    for (const key of ['remoteBarrage', 'areaSuppression', 'airSupport']) {
      const count = Math.max(0, Math.floor(Number(inventory[key]) || 0));
      if (count <= 0) continue;
      const definition = ROADSIDE_USE_DEFINITIONS[key];
      const action = this.action(this.itemMsg('combat.item.strategicWithCount', { itemName: definition.name, count }, `${definition.name} ×${count}`), () => this.useStrategicItemOnTarget(key, target), key === 'airSupport' ? 'danger' : 'primary');
      action.title = this.itemMsg('combat.item.strategicTitle', {}, '選択中の発見済み対象周辺へ遠隔支援を実行します。現在地は参照しません。');
    }
  }

  appendDefenseLureAction(state, defense) {
    if (!this.roadsideSupplySystem?.useLureTarget) return;
    const inventory = ensureRoadsideSupplyState(state).inventory ?? {};
    const lureCount = Math.max(0, Math.floor(Number(inventory.lureSignal) || 0));
    if (lureCount <= 0) return;
    const targets = this.roadsideSupplySystem.lureTargets?.(state) ?? [];
    const cluster = targets.find(target => target.kind === 'defenseCluster' && (target.defenseIds ?? []).includes(defense.id));
    if (!cluster) return;
    const lure = this.action(this.actionMsg('combat.panel.lureSignalCount', { count: lureCount }, `誘導信号 ×${lureCount}`), () => this.useLureSignalOnTarget({ kind: 'defenseCluster', id: cluster.id }), 'primary');
    lure.title = this.itemMsg('combat.item.lureDefenseClusterTitle', {}, '周辺敵をこの防衛密集地点へ誘導します。');
  }

  renderOrderPlanningContext(state, squad) {
    this.context.classList?.add('is-order-mode');
    const plan = this.orderPlanning;
    const selectedRoute = plan.routes[plan.selectedRouteIndex] ?? null;
    const modeLabel = this.orderModeLabel(plan.mode);
    const selectedRouteLabel = selectedRoute ? this.orderRouteLabel(selectedRoute) : this.msg('combat.order.routeNone', {}, 'NONE');
    const instruction = !plan.destinationNodeId
      ? this.panelMsg('combat.order.selectRetreatPointInstruction', {}, 'MAP上で後退先の交差点を選択してください。敵基地へ近づく地点は後退先にできません。')
      : selectedRoute
        ? this.panelMsg('combat.order.reviewRouteInstruction', { modeLabel }, `${modeLabel}ルートを確認してください。MAPタップで最大2か所の経由地点を追加できます。`)
        : this.panelMsg('combat.order.unreachableInstruction', {}, '選択地点へ到達できる道路経路がありません。目的地または経由地点を変更してください。');
    this.contextTitle.textContent = plan.mode === FRIENDLY_ORDER_MODE.DEPLOYMENT
      ? this.panelMsg('combat.order.titleDeployment', { targetLabel: plan.targetLabel ?? this.msg('combat.order.targetFallback', {}, '目標') }, `DEPLOY ROUTE // ${plan.targetLabel ?? '目標'}`)
      : this.panelMsg('combat.order.titleAlly', { modeLabel }, `ALLY ORDER // ${modeLabel}`);
    this.setContextContent(instruction, [
      ['ROUTES', String(plan.routes.length)],
      ['SELECT', selectedRouteLabel],
      ['DIST', selectedRoute ? `${Math.round(selectedRoute.physicalDistance)}m` : '--'],
      ['ETA', selectedRoute ? this.msg('combat.order.etaMinutes', { minutes: Math.max(1, Math.ceil(selectedRoute.etaSeconds / 60)) }, `${Math.max(1, Math.ceil(selectedRoute.etaSeconds / 60))}分`) : '--'],
      ['RISK', selectedRoute ? this.msg(`combat.order.risk.${selectedRoute.risk === '低' ? 'low' : selectedRoute.risk === '中' ? 'medium' : selectedRoute.risk === '高' ? 'high' : 'unknown'}`, {}, selectedRoute.risk ?? '--') : '--'],
      ['CONTACT', selectedRoute ? String(selectedRoute.enemyContacts) : '--'],
      ['VIA', `${plan.waypointNodeIds.length}/2`]
    ], [
      plan.mode === FRIENDLY_ORDER_MODE.WITHDRAW
        ? this.panelMsg('combat.order.withdrawWarning', {}, '撤退を確定すると現在の攻撃任務は破棄され、再開できません。')
        : this.panelMsg('combat.order.undiscoveredWarning', {}, '未発見の敵は危険度計算に含まれません。'),
      plan.mode === FRIENDLY_ORDER_MODE.DEPLOYMENT
        ? this.panelMsg('combat.order.deploymentFirstEdgeNote', {}, '派兵確定後、部隊は表示中の最初の道路区間から選択経路を進みます。')
        : squad.edgeId && squad.edgeProgress > 0
          ? this.panelMsg('combat.order.midEdgeReverseNote', {}, '道路途中でも撤退・帰還先が後方の場合は現在区間上で即時反転します。前方ルートが短い場合だけ次の交差点へ進みます。')
          : this.panelMsg('combat.order.immediateRouteNote', {}, '命令確定後、選択ルートへ直ちに移行します。')
    ]);
    plan.routes.forEach((route, index) => this.action(
      this.panelMsg(index === plan.selectedRouteIndex ? 'combat.order.routeButtonSelected' : 'combat.order.routeButton', { index: index + 1, routeLabel: this.orderRouteLabel(route) }, `${index + 1}. ${route.label}${index === plan.selectedRouteIndex ? ' ✓' : ''}`),
      () => this.selectOrderRoute(index),
      index === plan.selectedRouteIndex ? 'primary' : ''
    ));
    if (plan.waypointNodeIds.length) this.action(this.actionMsg('combat.order.removeLastWaypoint', {}, '最後の経由地点を取消'), () => this.removeLastWaypoint());
    if (plan.mode === FRIENDLY_ORDER_MODE.RETREAT && plan.destinationNodeId) this.action(this.actionMsg('combat.order.reselectRetreatPoint', {}, '後退地点を選び直す'), () => this.resetRetreatDestination());
    const confirmText = plan.mode === FRIENDLY_ORDER_MODE.DEPLOYMENT
      ? (plan.confirmLabel ?? this.actionMsg('combat.order.confirmDeployment', {}, 'この経路で派兵'))
      : this.actionMsg('combat.order.confirmMode', { modeLabel }, `${modeLabel}を確定`);
    const confirm = this.action(confirmText, () => this.confirmOrderPlanning(), 'primary');
    confirm.disabled = !selectedRoute;
    this.action(this.actionMsg('combat.order.cancel', {}, '命令を取消'), () => this.cancelOrderPlanning());
    setVisible(this.context, true);
  }

  handleMapTap(worldPoint) {
    if (this.orderPlanning) {
      this.handleOrderPlanningTap(worldPoint);
      return;
    }
    if (this.selectedTool === 'select') {
      const state = uiViewState(this.store);
      const nextObject = this.nearestObject(state, worldPoint, 24 / this.camera.scale, this.selectedObject);
      const sameObject = nextObject
        && this.selectedObject
        && nextObject.kind === this.selectedObject.kind
        && nextObject.id === this.selectedObject.id;
      if (sameObject || !nextObject) {
        this.clearObjectSelection();
        return;
      }
      this.pendingDefenseRemovalId = null;
      this.defensePanelMode = 'summary';
      this.defensePanelDefenseId = null;
      this.selectedObject = nextObject;
      this.renderer.setFocus({ kind: nextObject.kind, id: nextObject.id });
      this.renderContext();
      return;
    }

    const state = uiViewState(this.store);
    const result = this.buildSystem.previewAt(state, this.selectedTool, worldPoint, 24 / this.camera.scale);
    if (!result.ok) {
      this.buildCandidate = null;
      this.refreshBuildPlacement(true);
      this.renderContext();
      this.notifications.show(this.reasonPayload(result, 'combat.panel.buildInvalidPosition', 'この位置には設置できません。'));
      return;
    }
    this.buildCandidate = result.candidate;
    this.refreshBuildPlacement(true);
    this.renderContext();
    this.showMessage('combat.panel.buildCandidateSelected', {}, '設置候補を選択しました。範囲と効果を確認して建設を確定してください。');
  }

  confirmBuildCandidate() {
    if (!this.buildCandidate || this.selectedTool === 'select') return;
    const state = uiViewState(this.store);
    const validation = this.buildSystem.validateCandidate(state, this.buildCandidate, { checkResources: true });
    if (!validation.ok) {
      this.notifications.show(this.reasonPayload(validation, 'combat.panel.buildFailed', '建設できません。'));
      this.refreshBuildPlacement(true);
      this.renderContext();
      return;
    }

    const result = this.commandBus?.execute('defense.build', {
      defenseType: validation.candidate.type,
      nodeId: validation.candidate.nodeId
    }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    if (!result?.ok) {
      this.notifications.show(this.reasonPayload(result, 'combat.panel.buildFailed', '建設できません。'));
      this.refreshBuildPlacement(true);
      this.renderContext();
      return;
    }

    this.persist?.();
    this.showMessage('combat.panel.defenseBuilt', { facilityName: this.localize(DEFENSE_DEFINITIONS[this.selectedTool].name) }, `${DEFENSE_DEFINITIONS[this.selectedTool].name}を設置しました。`);
    this.buildCandidate = null;
    this.buildPlacementSignature = '';
    this.buildContextSignature = '';
    this.renderTools();
    this.refreshBuildPlacement(true);
    this.renderContext();
  }

  cancelBuildCandidate() {
    this.buildCandidate = null;
    this.buildContextSignature = '';
    this.refreshBuildPlacement(true);
    this.renderContext();
  }

  appendContextMetrics(metrics = []) {
    if (!metrics.length) return null;
    const grid = document.createElement('div');
    grid.className = 'contextMetricGrid';
    for (const [label, value] of metrics) {
      const item = document.createElement('span');
      const key = document.createElement('small');
      const data = document.createElement('b');
      key.textContent = this.textValue(label);
      data.textContent = this.textValue(value);
      item.append(key, data);
      grid.appendChild(item);
    }
    this.contextText.appendChild(grid);
    return grid;
  }

  setContextMetrics(metrics = []) {
    this.contextText.textContent = '';
    this.appendContextMetrics(metrics);
  }

  setDefensePanelMode(mode, defenseId) {
    this.defensePanelMode = mode;
    this.defensePanelDefenseId = defenseId;
    this.pendingDefenseRemovalId = null;
    this.renderContext();
  }

  setDefenseDetails(presentation, notes = []) {
    this.contextText.textContent = '';
    const copy = document.createElement('div');
    copy.className = 'defenseDetailCopy';
    const localizedPresentation = presentation ? {
      summary: this.defenseText(presentation, 'summary'),
      effect: this.defenseText(presentation, 'effect'),
      placement: this.defenseText(presentation, 'placement')
    } : null;
    uniqueDefenseDescriptionParagraphs(localizedPresentation, notes)
      .forEach((text, index) => {
        const paragraph = document.createElement('p');
        paragraph.className = index === 0 ? 'contextSummary' : 'contextDetail';
        paragraph.textContent = text;
        copy.appendChild(paragraph);
      });
    this.contextText.appendChild(copy);
  }

  setContextContent(summary, metrics = [], details = []) {
    this.contextText.textContent = '';
    this.appendContextMetrics(metrics);

    const explanation = [summary, ...details]
      .filter(detailText => typeof detailText === 'string' && detailText.trim().length);
    if (!explanation.length) return;
    const disclosureKey = this.contextDisclosureIdentity();
    if (this.contextDisclosureKey !== disclosureKey) {
      this.contextDisclosureKey = disclosureKey;
      this.contextDisclosureOpen = false;
    }
    const disclosure = document.createElement('details');
    disclosure.className = 'contextDisclosure';
    disclosure.open = this.contextDisclosureOpen;
    disclosure.addEventListener('toggle', () => {
      if (this.contextDisclosureKey === disclosureKey) this.contextDisclosureOpen = Boolean(disclosure.open);
    });
    const toggle = document.createElement('summary');
    toggle.textContent = this.panelMsg('combat.panel.showDetails', {}, '説明を表示');
    disclosure.appendChild(toggle);
    explanation.forEach((detailText, index) => {
      const detail = document.createElement('p');
      detail.className = index === 0 ? 'contextSummary' : 'contextDetail';
      detail.textContent = this.localize(detailText);
      disclosure.appendChild(detail);
    });
    this.contextText.appendChild(disclosure);
  }

  appendDefenseUpgradePreview(state, defense, status) {
    const block = document.createElement('div');
    block.className = `defenseUpgradePreview ${status.ok ? 'is-ready' : status.atMax ? 'is-max' : 'is-locked'}`;
    const heading = document.createElement('div');
    heading.className = 'defenseUpgradeHeading';
    const label = document.createElement('small');
    label.textContent = status.atMax ? this.panelMsg('combat.panel.upgradeComplete', {}, 'UPGRADE COMPLETE') : this.panelMsg('combat.panel.nextTier', { tier: status.nextTier }, `NEXT // TIER ${status.nextTier}`);
    const name = document.createElement('strong');
    name.textContent = status.atMax ? this.panelMsg('combat.panel.maxTierReached', {}, '最高Tierへ到達') : this.localize(status.nextDefinition?.name ?? this.panelMsg('combat.panel.upgradeUnknown', {}, '強化先不明'));
    heading.append(label, name);
    block.appendChild(heading);

    if (status.atMax) {
      const note = document.createElement('p');
      note.textContent = this.panelMsg('combat.panel.finalFacilityTier', {}, 'この設備は現在の最終形です。');
      block.appendChild(note);
      this.contextText.appendChild(block);
      return;
    }

    const current = defenseRuntimeDefinition(defense);
    const next = defenseRuntimeDefinition({ ...defense, tier: status.nextTier, maxHp: status.nextMaxHp, line: status.line });
    const rows = [];
    const add = (labelKey, fallbackLabel, before, after) => {
      if (String(before) !== String(after)) rows.push([this.panelMsg(labelKey, {}, fallbackLabel), `${before} → ${after}`]);
    };
    const secondsValue = value => this.secondsText(value);
    const healSpeed = value => this.panelMsg('combat.panel.healSpeedPercentPerSecond', { percent: (value * 100).toFixed(1) }, `${(value * 100).toFixed(1)}%/秒`);
    add('combat.panel.deltaHp', 'HP', defense.maxHp, status.nextMaxHp);
    if (defense.kind !== 'barrier') add('combat.panel.deltaRange', '射程', `${current.range}m`, `${next.range}m`);
    if (defense.type === 'gun') {
      add('combat.panel.deltaDamage', '威力', current.damage, next.damage);
      add('combat.panel.deltaReload', '再装填', secondsValue(current.cooldown), secondsValue(next.cooldown));
    } else if (defense.type === 'mortar') {
      add('combat.panel.deltaImpactDamage', '中心威力', current.damage, next.damage);
      add('combat.panel.deltaReload', '再装填', secondsValue(current.cooldown), secondsValue(next.cooldown));
      add('combat.panel.deltaBlastRadius', '爆発半径', `${current.blastRadius}m`, `${next.blastRadius}m`);
      add('combat.panel.deltaMaxTargets', '最大命中', current.maxTargets, next.maxTargets);
      add('combat.panel.deltaSplashDamage', '周辺威力', `${Math.round(current.splashMultiplier * 100)}%`, `${Math.round(next.splashMultiplier * 100)}%`);
    } else if (defense.type === 'slow') {
      add('combat.panel.deltaSlowRate', '減速率', `${Math.round(current.slow * 100)}%`, `${Math.round(next.slow * 100)}%`);
      add('combat.panel.deltaSlowDuration', '効果時間', secondsValue(current.slowSeconds), secondsValue(next.slowSeconds));
      add('combat.panel.deltaMaxTargets', '最大対象', current.maxTargets, next.maxTargets);
      add('combat.panel.deltaCooldown', '再発動', secondsValue(current.cooldown), secondsValue(next.cooldown));
    } else if (defense.type === 'relay') {
      add('combat.panel.deltaTowerRepair', '塔修復', current.repairTower, next.repairTower);
      add('combat.panel.deltaWallRepair', '壁修復', current.repairBarrier, next.repairBarrier);
      add('combat.panel.deltaCooldown', '再作動', secondsValue(current.cooldown), secondsValue(next.cooldown));
    } else if (defense.type === 'medical') {
      add('combat.panel.deltaMedicalRange', '回復範囲', `${current.range}m`, `${next.range}m`);
      add('combat.panel.deltaHealSpeed', '回復速度', healSpeed(current.recoveryRate), healSpeed(next.recoveryRate));
    } else if (defense.type === 'survey') {
      add('combat.panel.deltaMapRadius', 'MAP半径', `${current.surveyRadius}m`, `${next.surveyRadius}m`);
      add('combat.panel.deltaScanInterval', '区域取得', secondsValue(current.scanInterval), secondsValue(next.scanInterval));
    }

    const grid = document.createElement('div');
    grid.className = 'defenseUpgradeDeltaGrid';
    for (const [keyText, valueText] of rows) {
      const item = document.createElement('span');
      const key = document.createElement('small');
      const value = document.createElement('b');
      key.textContent = this.textValue(keyText);
      value.textContent = this.localize(valueText);
      item.append(key, value);
      grid.appendChild(item);
    }
    if (rows.length) block.appendChild(grid);

    const cost = document.createElement('p');
    cost.className = 'defenseUpgradeCost';
    cost.textContent = this.panelMsg('combat.panel.upgradeCost', { resourceText: { __resourceBundle: true, bundle: status.cost } }, `強化費用：${bundleText(status.cost)}`);
    block.appendChild(cost);
    if (!status.ok) {
      const reason = document.createElement('p');
      reason.className = 'defenseUpgradeReason';
      reason.textContent = this.reasonText(status, 'combat.panel.upgradeUnavailable', status.reason ?? '強化できません。');
      block.appendChild(reason);
    }
    this.contextText.appendChild(block);
  }

  action(label, handler, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = this.localize(label);
    button.className = className;
    button.addEventListener('click', handler);
    this.contextActions.appendChild(button);
    return button;
  }

  commandAction(type, payload = {}) {
    const result = this.commandBus?.execute(type, payload) ?? { ok: false, reason: 'Command bus is unavailable.' };
    if (result?.ok) this.persist?.();
    this.notifications.show(result?.ok ? this.resultMessagePayload(result, 'combat.panel.actionDone', '操作を実行しました。') : this.reasonPayload(result, 'combat.panel.actionUnavailable', '操作できません。'));
    this.renderContext();
    this.renderer.render();
    return result;
  }

  requestDefenseRemoval(defenseId) {
    if (this.pendingDefenseRemovalId !== defenseId) {
      this.pendingDefenseRemovalId = defenseId;
      this.showMessage('combat.panel.removalConfirmWarning', {}, '撤去すると設備は消失し、資源は返還されません。もう一度ボタンを押すと確定します。');
      this.renderContext();
      return;
    }

    const result = this.commandBus?.execute('defense.remove', { defenseId }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    this.pendingDefenseRemovalId = null;
    if (!result?.ok) {
      this.notifications.show(this.reasonPayload(result, 'combat.panel.removeDefenseFailed', '設備を撤去できません。'));
      this.renderContext();
      return;
    }

    this.clearObjectSelection();
    this.renderTools();
    this.renderer.render();
    this.persist?.();
    this.notifications.show(this.resultMessagePayload(result, 'combat.panel.defenseRemoved', '設備を撤去しました。'));
  }

  cancelDefenseRemoval() {
    this.pendingDefenseRemovalId = null;
    this.renderContext();
  }


  buildCandidateSignature() {
    const candidate = this.buildCandidate;
    if (!candidate) return 'none';
    return [
      candidate.kind ?? '',
      candidate.nodeId ?? '',
      candidate.edgeId ?? '',
      candidate.barrierSectionId ?? '',
      Number(candidate.point?.x).toFixed(1),
      Number(candidate.point?.y).toFixed(1),
      candidate.anchorId ?? '',
      candidate.anchorKind ?? ''
    ].join(':');
  }

  buildContextRenderSignature(state, buildStatus) {
    const inventory = state.civilization?.inventory ?? {};
    const resourceState = Object.keys(RESOURCE_LABELS)
      .sort()
      .map(key => `${key}:${Math.floor(Number(inventory[key]) || 0)}`)
      .join(',');
    return [
      this.selectedTool,
      this.i18n?.language ?? 'ja',
      state.civilization?.level ?? 0,
      buildStatus.ok ? 1 : 0,
      buildStatus.reasonKey ?? buildStatus.reason ?? '',
      this.buildSites.length,
      this.buildCandidateSignature(),
      resourceState
    ].join('|');
  }

  renderBuildContext(state = uiViewState(this.store)) {
    const definition = DEFENSE_DEFINITIONS[this.selectedTool];
    const presentation = defensePresentation(this.selectedTool, definition);
    if (!definition || !presentation) {
      this.selectTool('select');
      return;
    }
    const buildStatus = this.buildSystem.getBuildStatus(state, this.selectedTool);
    const affordable = buildStatus.ok;
    const renderSignature = this.buildContextRenderSignature(state, buildStatus);
    if (!this.context.hidden && renderSignature === this.buildContextSignature) return;
    this.buildContextSignature = renderSignature;
    this.context.classList?.add('is-build-mode');
    this.context.classList?.toggle('has-candidate', Boolean(this.buildCandidate));
    this.contextActions.textContent = '';
    const facilityName = this.localize(definition.name);
    const role = this.defenseText(presentation, 'role');
    this.contextTitle.textContent = this.panelMsg('combat.panel.buildTitle', { facilityName, role }, `BUILD // ${facilityName} // ${role}`);
    const instruction = !buildStatus.ok && buildStatus.requiredCivilizationLevel
      ? buildStatus.reason
      : this.buildCandidate
      ? this.panelMsg('combat.panel.buildCandidateInstruction', {}, '白い照準が現在の設置候補です。効果範囲と費用を確認して確定してください。')
      : this.buildSites.length
        ? this.panelMsg('combat.panel.buildSelectSiteInstruction', {}, '緑色で表示された有効地点から設置位置を選択してください。')
        : this.panelMsg('combat.panel.buildNoSitesInstruction', {}, '現在の建設可能範囲内に空いている設置地点がありません。');
    const anchors = this.buildSystem.getBuildAnchors(state);
    const ranges = constructionRangeSummary(state.civilization?.level);
    const metrics = [
      ...presentation.metrics,
      ['STATUS', affordable ? 'READY' : buildStatus.reason ? this.reasonText(buildStatus, 'combat.panel.unavailable', '利用不可') : this.panelMsg('combat.panel.unavailable', {}, '利用不可')],
      ['SITES', String(this.buildSites.length)],
      ...(this.buildCandidate ? [['SOURCE', this.buildCandidate.anchorLabel ? this.localize(this.buildCandidate.anchorLabel) : this.panelMsg('combat.panel.recalculated', {}, '再計算')]] : [])
    ];
    this.setContextContent(instruction, metrics, [
      this.defenseText(presentation, 'summary'),
      this.defenseText(presentation, 'effect'),
      this.defenseText(presentation, 'placement'),
      this.panelMsg('combat.panel.buildInitialTierDetail', { initialTier: definition.initialTier ?? 0 }, `新設時はTier ${definition.initialTier ?? 0}です。文明レベル上昇後、既設設備を選択して資源を支払い個別に強化できます。`),
      this.selectedTool === 'survey'
        ? this.panelMsg('combat.panel.buildSurveyRangeDetail', { major: ranges.major, field: ranges.field }, `測量施設は主要拠点・簡易拠点ごとに1基までです。設置範囲は主要拠点${ranges.major}m、簡易拠点${ranges.field}mです。遠隔取得で追加されるのは道路形状です。敵基地・道端物資・現地イベントの正確な位置は、実際に現地へ移動した後に表示されます。`)
        : this.panelMsg('combat.panel.buildRangeDetail', { level: ranges.level, major: ranges.major, field: ranges.field, player: ranges.player, expedition: ranges.expedition }, `文明Lv.${ranges.level}の建設範囲は主要拠点${ranges.major}m、簡易拠点${ranges.field}m、現在地${ranges.player}m、出撃中の遠征部隊${ranges.expedition}mです。設置済み施設は新たな建設基準点になりません。移動先の道路は周辺区域の取得完了後に建設へ利用できます。`)
    ]);
    if (this.buildCandidate) {
      const confirm = this.action(affordable ? this.actionMsg('combat.panel.buildConfirm', {}, '建設を確定') : buildStatus.requiredCivilizationLevel ? this.actionMsg('combat.panel.buildCivLocked', {}, '文明未解禁') : this.actionMsg('combat.panel.buildResourceShortage', {}, '資源不足'), () => this.confirmBuildCandidate(), 'primary');
      confirm.disabled = !affordable;
      this.action(this.actionMsg('combat.panel.buildCancelCandidate', {}, '候補を解除'), () => this.cancelBuildCandidate());
    }
    this.action(this.actionMsg('combat.panel.buildBackToSelect', {}, '選択モードへ戻る'), () => this.selectTool('select'));
    setVisible(this.context, true);
  }

  renderContext(state = uiViewState(this.store)) {
    if (this.selectedTool !== 'select') {
      this.renderBuildContext(state);
      return;
    }
    this.context.classList?.remove('is-build-mode', 'has-candidate', 'is-order-mode', 'is-defense-mode', 'is-defense-summary', 'is-defense-details', 'is-defense-upgrade', 'is-target-mode');
    this.contextActions.textContent = '';
    if (this.orderPlanning) {
      const squad = this.planningSubject(state);
      if (!squad) { this.cancelOrderPlanning(); return; }
      this.renderOrderPlanningContext(state, squad);
      return;
    }
    if (!this.selectedObject) {
      setVisible(this.context, false);
      return;
    }
    const selected = this.selectedObject;
    if (selected.kind === 'recoveryItem') {
      const item = (state.world.recoveryItems ?? []).find(value => value.id === selected.id && isRecoveryItemVisible(value));
      if (!item) { this.clearObjectSelection(); return; }
      const presentation = recoveryItemPresentation(item);
      const statusPresentation = recoveryItemStatusPresentation(item);
      const itemPosition = recoveryItemPoint(state, item);
      const gap = state.player.worldPosition ? distance(state.player.worldPosition, itemPosition) : Infinity;
      const collection = state.world.recoveryCollection?.itemId === item.id ? state.world.recoveryCollection : null;
      const available = item.status === RECOVERY_ITEM_STATUS.AVAILABLE;
      const eligibility = available ? recoveryEligibility(state, item) : { ok: false, reason: statusPresentation.detail };
      const progress = Math.min(RECOVERY_COLLECTION_DURATION_SECONDS, collection?.progressSec ?? 0);
      this.contextTitle.textContent = this.panelMsg('combat.panel.recoveryTitle', { itemName: presentation.name }, `RECOVERY // ${presentation.name}`);
      const statusLabel = collection ? this.panelMsg('combat.panel.recoveryCollecting', {}, '現地回収中') : this.localize(statusPresentation.label);
      this.setContextContent(
        available
          ? this.panelMsg('combat.panel.recoveryAvailableSummary', { sourceName: presentation.sourceName }, `${presentation.sourceName}の破壊地点に残された特殊回収物です。現地へ移動するか、回収部隊を派遣して回収できます。`)
          : this.panelMsg('combat.panel.recoveryUnavailableSummary', { sourceName: presentation.sourceName, statusDetail: statusPresentation.detail }, `${presentation.sourceName}の破壊地点に残された特殊回収物です。${statusPresentation.detail}`),
        [['DIST', Number.isFinite(gap) ? `${Math.round(gap)}m` : 'NO GPS'], ['ENTRY', `${RECOVERY_RANGE_METERS}m`], ['STATUS', statusLabel], ['TIME', collection ? `${progress.toFixed(1)}/${RECOVERY_COLLECTION_DURATION_SECONDS}s` : available ? `${RECOVERY_COLLECTION_DURATION_SECONDS}s` : '--'], ['SOURCE', presentation.sourceName], ['LOOT', presentation.lootText]],
        [presentation.description, collection ? this.panelMsg('combat.panel.recoveryStayInRange', {}, '回収完了まで範囲内に留まってください。') : available ? (eligibility.ok ? this.panelMsg('combat.panel.recoveryRecorded', {}, '回収後は文明発展の実績として記録されます。') : this.reasonText(eligibility, 'combat.panel.recoveryUnavailable', '回収できません。')) : statusPresentation.detail]
      );
      this.context.classList?.add('is-target-mode');
      const collect = this.action(collection ? this.actionMsg('combat.panel.collectingButton', { seconds: Math.floor(progress), totalSeconds: RECOVERY_COLLECTION_DURATION_SECONDS }, `回収中 ${Math.floor(progress)}/${RECOVERY_COLLECTION_DURATION_SECONDS}秒`) : this.actionMsg('combat.panel.collectOnSite', {}, '現地で回収'), () => this.commandAction('recovery.beginCollection', { itemId: item.id }), 'primary');
      collect.disabled = Boolean(collection) || !available || !eligibility.ok;
      const retrievalPreview = available && this.friendlyForceSystem
        ? deploymentBases(state, 'retrieval')
          .map(base => this.friendlyForceSystem.previewDeployment(state, base.id, item.id, 'retrieval', 'recoveryItem'))
          .find(result => result.ok)
        : null;
      const retrievalReason = available && !retrievalPreview && this.friendlyForceSystem
        ? deploymentBases(state, 'retrieval')
          .map(base => this.friendlyForceSystem.previewDeployment(state, base.id, item.id, 'retrieval', 'recoveryItem'))
          .find(result => result.reason || result.reasonKey) ?? this.panelMsg('combat.panel.noRecoveryDispatchBase', {}, '回収部隊を派遣できる拠点がありません。')
        : statusPresentation.shortLabel;
      const dispatch = this.action(available ? this.actionMsg('combat.panel.dispatchRecoverySquad', {}, '回収部隊を派遣') : statusPresentation.shortLabel, () => this.openDeployment?.({ kind: 'recoveryItem', id: item.id }));
      dispatch.disabled = !available || Boolean(collection) || typeof this.openDeployment !== 'function' || !retrievalPreview;
      dispatch.title = dispatch.disabled ? this.localize(retrievalReason) : this.panelMsg('combat.panel.dispatchRecoveryTitle', {}, '回収部隊を派遣します。');
      if (available && !retrievalPreview && this.contextText) { const note = document.createElement('p'); note.className = 'sectionNote'; note.textContent = this.localize(retrievalReason); this.contextText.appendChild(note); }
    } else if (selected.kind === 'roadsideMine') {
      const mine = (state.world.roadsideSupplies?.placedMines ?? []).find(item => item.id === selected.id);
      if (!mine) { this.clearObjectSelection(); return; }
      const definition = ROADSIDE_USE_DEFINITIONS[mine.itemKey ?? 'roadMine'] ?? ROADSIDE_USE_DEFINITIONS.roadMine;
      const inventory = ensureRoadsideSupplyState(state).inventory ?? {};
      const lureCount = Math.max(0, Math.floor(Number(inventory.lureSignal) || 0));
      this.contextTitle.textContent = this.panelMsg('combat.panel.mineTitle', { mineName: mine.name ?? definition.name }, `MINE // ${mine.name ?? definition.name}`);
      this.setContextContent(this.panelMsg('combat.panel.mineSummary', {}, '設置済み地雷です。時間制限はなく、敵が通過するまで残ります。誘導信号弾で敵をこの地点へ誘導できます。'), [
        ['TYPE', definition.name],
        ['RADIUS', `${definition.radiusMeters}m`],
        ['TRIGGER', `${definition.triggerRadiusMeters}m`],
        ['NODE', mine.nodeId ?? '--']
      ], [this.panelMsg('combat.panel.mineLureDetail', {}, '誘導中の敵が踏んだ場合、爆発半径と威力が上昇します。')]);
      const lure = this.action(this.actionMsg('combat.panel.lureSignalCount', { count: lureCount }, `誘導信号 ×${lureCount}`), () => this.useLureSignalOnTarget({ kind: 'mine', id: mine.id }), 'primary');
      lure.disabled = lureCount <= 0;
      this.action(this.actionMsg('combat.panel.removeMine', {}, '地雷を撤去'), () => this.removeSelectedMine(mine.id), 'danger');
    } else if (selected.kind === 'friendlySquad') {
      const squad = (state.combat.friendlySquads ?? []).find(item => item.id === selected.id);
      if (!squad || squad.hp <= 0) { this.clearObjectSelection(); return; }
      const definition = friendlySquadRuntimeDefinition(state, squad.type, squad);
      const remaining = remainingRouteDistance(state, squad);
      const origin = ownedBaseById(state, squad.originBaseId, { includeDestroyed: true });
      const target = state.world.enemyBases.find(base => base.id === squad.targetBaseId);
      const interceptTarget = state.combat.enemies.find(enemy => enemy.id === squad.targetEnemyId && enemy.hp > 0);
      const recoveryItem = (state.world.recoveryItems ?? []).find(item => item.id === squad.targetRecoveryItemId);
      const recoveryTargetName = recoveryItem ? recoveryItemPresentation(recoveryItem).name : null;
      this.contextTitle.textContent = this.panelMsg('combat.panel.allyTitle', { unitName: definition.name }, `ALLY // ${definition.name}`);
      const orderLabel = ({ ADVANCE: this.panelMsg('combat.panel.orderAdvance', {}, '進軍'), HOLD: this.panelMsg('combat.panel.orderHold', {}, '停止'), RETREAT: this.panelMsg('combat.panel.orderRetreat', {}, '後退'), WITHDRAW: this.panelMsg('combat.panel.orderWithdraw', {}, '撤退'), RETURN: this.panelMsg('combat.panel.orderReturn', {}, '帰還') })[squad.order] ?? squad.order;
      const progress = unitProgressText(squad);
      const special = definition.type === 'skirmisher'
        ? this.panelMsg('combat.panel.allySpecialSkirmisher', { lightMultiplier: definition.lightTargetMultiplier, armoredMultiplier: definition.armoredTargetMultiplier }, `軽装敵への攻撃 ×${definition.lightTargetMultiplier}・重装敵 ×${definition.armoredTargetMultiplier}`)
        : definition.type === 'heavy'
          ? this.panelMsg('combat.panel.allySpecialHeavy', { range: definition.guardRange, sharePercent: Math.round(definition.guardShare * 100) }, `${definition.guardRange}m以内の味方損害を${Math.round(definition.guardShare * 100)}%肩代わり`)
          : definition.type === 'expedition'
            ? this.panelMsg('combat.panel.allySpecialExpedition', { seconds: definition.recoveryDelaySeconds, hp: definition.nonCombatRecoveryPerSecond, range: 120 }, `非戦闘${definition.recoveryDelaySeconds}秒後から毎秒${definition.nonCombatRecoveryPerSecond}HP回復・周囲120mを建設圏化`)
            : definition.type === 'siege'
              ? this.panelMsg('combat.panel.allySpecialSiege', {}, '敵基地への攻撃に特化し、通常敵への火力は低い')
              : definition.type === 'engineer'
                ? this.panelMsg('combat.panel.allySpecialEngineer', { range: definition.repairRange, hp: definition.repairAmount }, `周囲${definition.repairRange}mの設備を最大${definition.repairAmount}HP手動修復・敵施設への攻撃に強い`)
                : definition.type === 'artillery'
                  ? this.panelMsg('combat.panel.allySpecialArtillery', { range: definition.engagementRange, radius: definition.splashRadius, maxTargets: definition.maxSplashTargets }, `射程${definition.engagementRange}m・半径${definition.splashRadius}mへ最大${definition.maxSplashTargets}体を範囲攻撃`)
                  : definition.type === 'command'
                    ? this.panelMsg('combat.panel.allySpecialCommand', { range: definition.auraRange, attackPercent: Math.round(definition.commandAura * 100), speedPercent: Math.round(definition.speedAura * 100) }, `周囲${definition.auraRange}mの味方へ攻撃+${Math.round(definition.commandAura * 100)}%・移動+${Math.round(definition.speedAura * 100)}%`)
                    : definition.type === 'retrieval'
                      ? this.panelMsg('combat.panel.allySpecialRetrieval', { seconds: definition.collectionSeconds }, `現地で${definition.collectionSeconds}秒停止して回収。戦闘力と耐久は非常に低い`)
                      : this.panelMsg('combat.panel.allySpecialStandard', {}, '通常敵と敵基地の両方へ対応する標準部隊');
      if ([FRIENDLY_SQUAD_STATUS.RECOVERING, FRIENDLY_SQUAD_STATUS.READY].includes(squad.status)) {
        const recovery = recoveryPresentation(state, squad);
        const recoveryBase = ownedBaseById(state, squad.recoveryBaseId ?? squad.originBaseId, { includeDestroyed: true });
        const medical = medicalCoverageForSquad(state, squad);
        const recoveryRemaining = squadRecoveryRemainingSeconds(recovery, squad);
        this.setContextContent(
          squad.status === FRIENDLY_SQUAD_STATUS.READY
            ? recovery.baseHealing
              ? this.panelMsg('combat.panel.allyReadyMajor', {}, '主要拠点で補給・回復・再編成が完了し、再出撃命令を待っています。')
              : this.panelMsg('combat.panel.allyReadyField', {}, '簡易拠点で再編成が完了し、再出撃命令を待っています。前線でのHP回復には回復施設を利用します。')
            : recovery.baseHealing
              ? this.panelMsg('combat.panel.allyRecoveringMajor', {}, '主要拠点へ帰還し、補給による回復と再編成を行っています。')
              : this.panelMsg('combat.panel.allyRecoveringField', {}, '簡易拠点へ帰還し、再編成を行っています。HP回復には回復施設の範囲内での待機が必要です。'),
          [
            ['HP', `${Math.ceil(squad.hp)}/${squad.maxHp}`],
            ['LV', `Lv.${progress.level}`],
            ['XP', progress.xpText],
            ['NEXT', progress.nextText],
            ['STATUS', squad.status],
            ['BASE', recoveryBase?.name ?? this.panelMsg('combat.panel.unknown', {}, '不明')],
            ['RECOVERY', squad.status === FRIENDLY_SQUAD_STATUS.READY ? this.panelMsg('combat.panel.recoveryComplete', {}, '完了') : this.panelMsg('combat.panel.seconds', { seconds: Math.ceil(recoveryRemaining) }, `${Math.ceil(recoveryRemaining)}秒`)],
            ['HEAL', recovery.baseHealing ? this.panelMsg('combat.panel.majorBaseSupply', {}, '主要拠点補給') : medical ? `${this.localize(medical.definition.name)} ${Math.round(medical.distance)}m` : this.panelMsg('combat.panel.outOfRange', {}, '範囲外')]
          ],
          [special, recovery.baseHealing
            ? this.panelMsg('combat.panel.allyMajorHealingDetail', {}, '主要拠点では帰還部隊へ基礎補給を行います。回復施設は拠点外でも範囲内の全味方部隊を同時に回復します。')
            : this.panelMsg('combat.panel.allyFieldHealingDetail', {}, '簡易拠点には自動回復機能がありません。回復施設の射程内へ配置してください。')]
        );
      } else {
        this.setContextContent(
          squad.order === FRIENDLY_SQUAD_ORDER.HOLD
            ? this.panelMsg('combat.panel.allyHoldingSummary', { description: definition.description }, `指定地点で停止中です。${definition.description}`)
            : squad.order === FRIENDLY_SQUAD_ORDER.RETREAT
              ? this.panelMsg('combat.panel.allyRetreatingSummary', { description: definition.description }, `選択した道路ルートで後退中です。${definition.description}`)
              : squad.order === FRIENDLY_SQUAD_ORDER.WITHDRAW
                ? this.panelMsg('combat.panel.allyWithdrawingSummary', { description: definition.description }, `現在の任務を破棄し、出撃元へ撤退中です。${definition.description}`)
                : squad.missionType === 'RECOVERY' && recoveryItem?.status === RECOVERY_ITEM_STATUS.CARRIED
                  ? this.panelMsg('combat.panel.allyCarryingRecoverySummary', { description: definition.description }, `特殊アイテムを確保し、出撃元へ輸送中です。${definition.description}`)
                  : squad.missionType === 'RECOVERY' && recoveryItem
                    ? this.panelMsg('combat.panel.allyMovingToRecoverySummary', { description: definition.description }, `特殊アイテムの回収地点へ進行中です。${definition.description}`)
                    : squad.missionType === 'INTERCEPT' && interceptTarget
                      ? this.panelMsg('combat.panel.allyInterceptingSummary', { description: definition.description }, `指定した敵部隊を追跡・迎撃中です。${definition.description}`)
                      : squad.targetBaseId
                        ? this.panelMsg('combat.panel.allyAdvancingBaseSummary', { description: definition.description }, `敵基地へ進軍中です。${definition.description}`)
                        : this.panelMsg('combat.panel.allyReturningSummary', { description: definition.description }, `任務を終えて出撃元へ帰還中です。${definition.description}`),
          [
            ['HP', `${Math.ceil(squad.hp)}/${squad.maxHp}`],
            ['LV', `Lv.${progress.level}`],
            ['XP', progress.xpText],
            ['NEXT', progress.nextText],
            ['MEN', String(Math.max(1, Math.ceil((squad.hp / squad.maxHp) * definition.members)))],
            ['ROLE', definition.role],
            ['STATUS', squad.status],
            ['ORDER', orderLabel],
            ['SPEED', `${definition.speed}m/s`],
            ['ENEMY DPS', String(definition.enemyDps)],
            ['BASE DPS', String(definition.baseDps)],
            ['RANGE', Number.isFinite(remaining) ? `${Math.round(remaining)}m` : 'RECALC'],
            ['ORIGIN', origin?.name ?? this.panelMsg('combat.panel.unknown', {}, '不明')],
            ['TARGET', recoveryItem?.status === RECOVERY_ITEM_STATUS.CARRIED
              ? this.panelMsg('combat.panel.targetCarryToOrigin', {}, '出撃元へ輸送')
              : recoveryTargetName
                ?? (interceptTarget ? ENEMY_DEFINITIONS[interceptTarget.type]?.name ?? this.panelMsg('combat.panel.enemySquad', {}, '敵部隊') : null)
                ?? (target ? ENEMY_BASE_DEFINITIONS[target.type]?.name ?? this.panelMsg('combat.panel.enemyBase', {}, '敵拠点') : squad.order === FRIENDLY_SQUAD_ORDER.WITHDRAW ? this.panelMsg('combat.panel.origin', {}, '出撃元') : this.panelMsg('combat.panel.returning', {}, '帰還'))]
          ],
          [special]
        );
        if (![FRIENDLY_SQUAD_ORDER.RETURN, FRIENDLY_SQUAD_ORDER.WITHDRAW].includes(squad.order)) {
          if (squad.order !== FRIENDLY_SQUAD_ORDER.HOLD) this.action(this.actionMsg('combat.panel.actionHold', {}, '停止'), () => this.holdSelectedSquad());
          if (squad.order === FRIENDLY_SQUAD_ORDER.HOLD && ((squad.missionTargetBaseId ?? squad.targetBaseId ?? squad.targetEnemyId ?? squad.targetRecoveryItemId) || squad.heldDestinationNodeId)) this.action(this.actionMsg('combat.panel.actionResume', {}, '移動再開'), () => this.beginOrderPlanning(FRIENDLY_ORDER_MODE.RESUME), 'primary');
          if (squad.type === 'engineer') this.action(this.actionMsg('combat.panel.actionRepairNearby', {}, '周辺設備を修復'), () => this.commandAction('friendly.engineerRepairNearby', { squadId: squad.id }), 'primary');
          this.appendSelectedSquadItemActions(state, squad);
          this.action(this.actionMsg('combat.panel.actionRetreat', {}, '後退'), () => this.beginOrderPlanning(FRIENDLY_ORDER_MODE.RETREAT));
          this.action(this.actionMsg('combat.panel.actionWithdraw', {}, '撤退'), () => this.beginOrderPlanning(FRIENDLY_ORDER_MODE.WITHDRAW), 'danger');
        }
      }
    } else if (selected.kind === 'enemy') {
      const enemy = state.combat.enemies.find(item => item.id === selected.id);
      if (!enemy || enemy.hp <= 0) { this.clearObjectSelection(); return; }
      const definition = scaleEnemyDefinition(ENEMY_DEFINITIONS[enemy.type] ?? ENEMY_DEFINITIONS.infantry, enemy.level ?? 1);
      const behavior = enemyBehaviorForDefinition(definition, enemy.doctrineKey);
      const doctrine = waveDoctrineDefinition(enemy.doctrineKey);
      const remaining = remainingRouteDistance(state, enemy);
      const targetDefense = enemy.targetDefenseId
        ? state.combat.defenses.find(defense => defense.id === enemy.targetDefenseId && defense.hp > 0)
        : null;
      const targetFieldBase = enemy.targetFieldBaseId ? ownedBaseById(state, enemy.targetFieldBaseId) : null;
      const targetPlayerBase = enemy.targetPlayerBaseId ? ownedBaseById(state, enemy.targetPlayerBaseId) : null;
      const targetSquad = enemy.targetSquadId
        ? (state.combat.friendlySquads ?? []).find(squad => squad.id === enemy.targetSquadId && squad.hp > 0)
        : null;
      const targetName = targetDefense
        ? defenseRuntimeDefinition(targetDefense).name ?? this.panelMsg('combat.panel.defenseFacility', {}, '防衛施設')
        : targetSquad
          ? FRIENDLY_SQUAD_DEFINITIONS[targetSquad.type]?.name ?? this.panelMsg('combat.panel.allySquad', {}, '味方部隊')
          : targetPlayerBase?.name ?? targetFieldBase?.name ?? (enemy.targetPlayerBaseId ? this.panelMsg('combat.panel.majorBase', {}, '主要拠点') : enemy.targetFieldBaseId ? this.panelMsg('combat.panel.fieldBase', {}, '簡易拠点') : this.panelMsg('combat.panel.city', {}, '都市'));
      const summary = targetDefense
        ? this.panelMsg('combat.panel.enemyTargetsDefense', { targetName }, `${targetName}を優先目標として進行中です。目標喪失時は性格に従って再経路を選択します。`)
        : targetSquad
          ? this.panelMsg('combat.panel.enemyTargetsSquad', { targetName }, `${targetName}を追跡中です。部隊が移動すると次の道路節点で追跡経路を更新します。`)
          : enemy.targetPlayerBaseId || enemy.targetFieldBaseId
            ? this.panelMsg('combat.panel.enemyRaidingBase', { targetName }, `${targetName}への襲撃を優先しています。都市へ直行する敵とは異なる防衛線が必要です。`)
            : this.panelMsg('combat.panel.enemyAdvancingCity', {}, '都市へ進行中です。経路は敵の性格と波の作戦に応じて選択されます。');
      const routeMode = ({ FLANK: this.panelMsg('combat.panel.routeFlank', {}, '側面迂回'), EVASIVE: this.panelMsg('combat.panel.routeEvasive', {}, '危険回避'), BREACH: this.panelMsg('combat.panel.routeBreach', {}, '正面突破'), SABOTAGE: this.panelMsg('combat.panel.routeSabotage', {}, '施設潜入'), RAID: this.panelMsg('combat.panel.routeRaid', {}, '拠点襲撃'), HUNT: this.panelMsg('combat.panel.routeHunt', {}, '部隊追跡'), SUPPORT: this.panelMsg('combat.panel.routeSupport', {}, '支援同行'), GUARD: this.panelMsg('combat.panel.routeGuard', {}, '護衛進軍'), COMMAND: this.panelMsg('combat.panel.routeCommand', {}, '指揮進軍'), DIRECT: this.panelMsg('combat.panel.routeDirect', {}, '最短進軍') })[enemy.path?.routeMode ?? behavior.routeMode] ?? definition.routeLabel ?? this.panelMsg('combat.panel.routeAdaptive', {}, '状況判断');
      const detour = Number(enemy.path?.detourPercent) > 0 ? `+${enemy.path.detourPercent}%` : '—';
      this.contextTitle.textContent = this.panelMsg('combat.panel.enemyTitle', { enemyName: definition.name }, `TARGET // ${definition.name}`);
      this.setContextContent(summary, [
        ['LEVEL', `Lv.${enemy.level ?? 1}`],
        ['HP', `${Math.ceil(enemy.hp)}/${enemy.maxHp}`],
        ['RANGE', Number.isFinite(remaining) ? `${Math.round(remaining)}m` : 'RECALC'],
        ['PERSONA', behavior.personalityLabel],
        ['TACTIC', doctrine.label],
        ['ROUTE', routeMode],
        ['DETOUR', detour],
        ['DAMAGE', String(definition.cityDamage)],
        ['OBJECTIVE', targetName]
      ], [behavior.description, this.panelMsg('combat.panel.enemyBaseObjective', { objective: definition.objectiveLabel ?? this.panelMsg('combat.panel.city', {}, '都市') }, `基本目標：${definition.objectiveLabel ?? '都市'}`)]);
      const intercept = this.action(this.actionMsg('combat.panel.dispatchToEnemy', {}, 'この敵部隊へ派兵'), () => this.openDeployment?.({ kind: 'enemy', id: enemy.id }), 'primary');
      intercept.disabled = enemy.departDelay > 0 || typeof this.openDeployment !== 'function';
      this.appendStrategicItemActions(state, { kind: 'enemy', id: enemy.id });
    } else if (selected.kind === 'frontier') {
      const source = (state.world.frontierSources ?? []).find(item => item.id === selected.id);
      if (!source || source.status === 'CLEARED') { this.clearObjectSelection(); return; }
      const presentation = frontierPresentation(source);
      const entry = state.world.roadGraph.nodeById.get(source.entryNodeId);
      const sourceDistance = entry ? distance(entry, source.point) : Infinity;
      const playerDistance = state.player.worldPosition ? distance(state.player.worldPosition, source.point) : Infinity;
      this.contextTitle.textContent = this.panelMsg('combat.panel.frontierTitle', { title: presentation.title }, `FRONTIER // ${presentation.title}`);
      this.setContextContent(
        presentation.stage === 'DISTANT'
          ? this.panelMsg('combat.panel.frontierDistantSummary', {}, '道路網の外側から断続的な敵性反応を検出しています。実際にこの方向へ移動すると情報精度が上がります。')
          : this.panelMsg('combat.panel.frontierLocatedSummary', {}, '敵性反応の方向と規模が絞り込まれています。道路を探索して発生源を特定してください。'),
        [
          ['SIGNAL', presentation.stage],
          ['THREAT', `T${presentation.threat}`],
          ['TYPE', presentation.profileLabel],
          ['SOURCE', Number.isFinite(sourceDistance) ? this.panelMsg('combat.panel.distanceAhead', { meters: Math.round(sourceDistance) }, `約${Math.round(sourceDistance)}m先`) : this.panelMsg('combat.panel.unknown', {}, '不明')],
          ['YOU', Number.isFinite(playerDistance) ? `${Math.round(playerDistance)}m` : 'NO GPS'],
          ['WAVES', String(source.wavesSent ?? 0)]
        ],
        [this.panelMsg('combat.panel.frontierDetail', {}, '未確認地域から敵部隊が侵入します。発生源は同じ世界座標に固定され、道路を探索して近づいても遠ざかりません。')]
      );
    } else if (selected.kind === 'enemyBase') {
      const base = state.world.enemyBases.find(item => item.id === selected.id && item.alive);
      if (!base?.alive) { this.clearObjectSelection(); return; }
      const definition = ENEMY_BASE_DEFINITIONS[base.type];
      this.contextTitle.textContent = this.localize(definition.name);
      const attackers = (state.combat.friendlySquads ?? []).filter(squad => squad.targetBaseId === base.id).length;
      this.context.classList?.add('is-target-mode');
      const anchor = enemyBaseAnchorPresentation(state, base);
      this.setContextContent(
        this.panelMsg('combat.panel.enemyBaseSummary', {}, '選択中の敵拠点です。攻撃部隊は道路上を移動し、この拠点へ到達後に攻撃を開始します。'),
        [
          ['HP', `${Math.ceil(base.hp)}/${base.maxHp}`],
          ['LEVEL', `Lv.${base.level ?? 1}`],
          ['TARGET', anchor.targetKey ? this.panelMsg(anchor.targetKey, anchor.targetParams ?? {}, anchor.targetFallback) : anchor.target],
          ['NEXT', (() => { const nextWave = enemyBaseNextWaveState(state, base); return this.panelMsg(nextWave.key, nextWave.params, nextWave.fallback); })()],
          ['PRESSURE', anchor.pressureKey ? this.panelMsg(anchor.pressureKey, anchor.pressureParams ?? {}, anchor.pressureFallback) : anchor.pressure],
          ['ATTACKERS', String(attackers)],
          ['STATUS', attackers ? 'UNDER ATTACK' : 'HOSTILE']
        ],
        [this.panelMsg(anchor.riskKey, anchor.riskParams ?? {}, anchor.riskFallback), this.panelMsg('combat.panel.enemyBaseLootDetail', {}, '破壊すると特殊回収物と資源備蓄が現地に残ります。')]
      );
      const deploy = this.action(attackers ? this.actionMsg('combat.panel.dispatchAdditionalSquad', {}, '追加部隊を派兵') : this.actionMsg('combat.panel.dispatchToEnemyBase', {}, 'この敵拠点へ派兵'), () => this.openDeployment?.({ kind: 'enemyBase', id: base.id }), 'primary');
      deploy.disabled = typeof this.openDeployment !== 'function';
      this.appendStrategicItemActions(state, { kind: 'enemyBase', id: base.id });
    } else if (selected.kind === 'defense') {
      this.context.classList?.add('is-defense-mode');
      const defense = state.combat.defenses.find(item => item.id === selected.id);
      if (!defense) { this.clearObjectSelection(); return; }
      if (this.defensePanelDefenseId !== defense.id) {
        this.defensePanelDefenseId = defense.id;
        this.defensePanelMode = 'summary';
        this.pendingDefenseRemovalId = null;
      }
      const runtime = defenseRuntimeDefinition(defense);
      const presentation = defensePresentation(defense.isGate ? 'gate' : defense.type, runtime);
      const survey = defense.type === 'survey' ? surveyFacilityPresentation(state, defense) : null;
      const operatingStatus = defense.disabledTimer > 0
          ? this.panelMsg('combat.panel.statusDisabledSeconds', { seconds: defense.disabledTimer.toFixed(1) }, `停止 ${defense.disabledTimer.toFixed(1)}秒`)
          : survey
            ? survey.statusLabel
            : defense.cooldown > 0 ? this.panelMsg('combat.panel.statusReloadingSeconds', { seconds: defense.cooldown.toFixed(1) }, `再装填 ${defense.cooldown.toFixed(1)}秒`) : defense.isGate ? this.panelMsg('combat.panel.statusClosed', {}, '封鎖中') : this.panelMsg('combat.panel.statusOperating', {}, '稼働');
      const upgrade = defenseUpgradeStatus(state, defense);
      const surveyMetrics = survey ? [
        ['NEXT', this.panelMsg('combat.panel.seconds', { seconds: survey.nextScanSeconds }, `${survey.nextScanSeconds}秒`)],
        ['EXPANDED', this.panelMsg('combat.panel.zoneCount', { count: survey.completedCount }, `${survey.completedCount}区域`)],
        ['REMAIN', String(survey.remainingChunks)],
        ['COMM', survey.lastConnectionAt > 0 ? this.panelMsg('combat.panel.commSuccess', {}, '成功') : survey.lastTransport === 'CACHE' ? this.panelMsg('combat.panel.commCache', {}, 'キャッシュ') : this.panelMsg('combat.panel.commNoSuccess', {}, '未成功')],
        ['LINK', survey.lastEndpoint ? `${survey.lastEndpoint} ${{ SANDBOX_JSONP: '隔離JSONP', GET: 'GET', POST: 'POST', CACHE: 'キャッシュ' }[survey.lastTransport] ?? survey.lastTransport ?? ''}`.trim() : this.panelMsg('combat.panel.commNoSuccess', {}, '未成功')],
        ...(survey.lastConnectionAt > 0 ? [['RESPONSE', `${survey.lastResponseElements}件`]] : []),
        ...(survey.lastSuccessAt > 0 ? [['ROADS', String(survey.lastRoadCount)]] : []),
        ...(survey.errorCount > 0 ? [['RETRY', String(survey.errorCount)]] : [])
      ] : [];
      const notes = presentation ? [this.panelMsg('combat.panel.upgradeKeepsDamageRatio', {}, '強化しても損傷率は維持され、全回復はしません。')] : [];
      if (survey) {
        notes.push(this.panelMsg('combat.panel.surveyFieldVisitDetail', {}, '遠隔測量済み区域へプレイヤーが実際に入ると、現地イベントや敵発生源の正確な情報が解禁されます。'));
        if (survey.lastConnectionAt <= 0) notes.push(this.panelMsg('combat.panel.surveyNoConnectionDetail', {}, 'この施設にはまだ道路サーバーとの通信成功記録がありません。COMMが未成功のままなら「今すぐ測量」で再試行してください。'));
        else if (survey.lastSuccessAt <= 0) notes.push(this.panelMsg('combat.panel.surveyConnectionNoRoadsDetail', {}, '道路サーバーとの通信は成功していますが、道路の解析・統合はまだ完了していません。'));
        if (survey.lastError) notes.push(this.panelMsg('combat.panel.surveyLastError', { stage: survey.lastErrorStage === 'PROCESSING' ? this.panelMsg('combat.panel.surveyStageProcessing', {}, '道路処理') : this.panelMsg('combat.panel.surveyStageCommunication', {}, '通信'), errorMessage: survey.lastError }, `直近の${survey.lastErrorStage === 'PROCESSING' ? '道路処理' : '通信'}失敗：${survey.lastError}`));
      }

      this.context.classList?.add(`is-defense-${this.defensePanelMode}`);
      if (this.defensePanelMode === 'details') {
        this.contextTitle.textContent = this.panelMsg('combat.panel.defenseDetailTitle', { facilityName: runtime.name }, `DETAIL // ${runtime.name}`);
        this.setDefenseDetails(presentation, notes);
        this.action(this.actionMsg('combat.panel.actionBackToFacility', {}, '施設情報へ戻る'), () => this.setDefensePanelMode('summary', defense.id), 'primary');
      } else if (this.defensePanelMode === 'upgrade') {
        this.contextTitle.textContent = this.panelMsg('combat.panel.defenseUpgradeTitle', { facilityName: runtime.name }, `UPGRADE // ${runtime.name}`);
        this.contextText.textContent = '';
        this.appendDefenseUpgradePreview(state, defense, upgrade);
        this.action(this.actionMsg('combat.panel.actionBack', {}, '戻る'), () => this.setDefensePanelMode('summary', defense.id));
        const confirmUpgrade = this.action(upgrade.atMax ? this.actionMsg('combat.panel.actionMaxTier', {}, '最高Tier') : upgrade.ok ? this.actionMsg('combat.panel.actionConfirmUpgrade', {}, '強化を確定') : this.actionMsg('combat.panel.actionUpgradeLocked', {}, '強化条件を満たしていません'), () => {
          this.defensePanelMode = 'summary';
          this.commandAction('defense.upgrade', { defenseId: defense.id });
        }, 'primary');
        confirmUpgrade.disabled = !upgrade.ok;
      } else {
        this.contextTitle.textContent = this.panelMsg('combat.panel.defenseSummaryTitle', { facilityName: runtime.name, tier: defense.tier ?? 0 }, `${runtime.name} // Tier ${defense.tier ?? 0}`);
        this.setContextMetrics([
          ['HP', `${Math.ceil(defense.hp)}/${defense.maxHp}`],
          ['STATUS', operatingStatus],
          ['TIER', String(defense.tier ?? 0)],
          ...(presentation?.metrics ?? []).filter(([label]) => label !== 'HP'),
          ...surveyMetrics
        ]);
        this.action(this.actionMsg('combat.panel.actionDetails', {}, '説明'), () => this.setDefensePanelMode('details', defense.id));
        const repair = this.action(defense.hp >= defense.maxHp ? this.actionMsg('combat.panel.actionRepairNotNeeded', {}, '修理不要') : this.actionMsg('combat.panel.actionRepair', {}, '修理'), () => this.commandAction('defense.repair', { defenseId: defense.id }));
        repair.disabled = defense.hp >= defense.maxHp;
        this.appendDefenseLureAction(state, defense);
        if (survey) {
          const surveyBusy = ['QUEUED', 'LOADING'].includes(survey.status);
          const surveyComplete = survey.status === 'COMPLETE' && survey.remainingChunks <= 0;
          const scan = this.action(
            surveyBusy ? this.actionMsg('combat.panel.actionSurveyBusy', {}, '測量通信中') : surveyComplete ? this.actionMsg('combat.panel.actionSurveyComplete', {}, '範囲内取得完了') : this.actionMsg('combat.panel.actionSurveyNow', {}, '今すぐ測量'),
            () => {
              const result = this.requestSurvey?.(defense.id) ?? { ok: false, reasonKey: 'combat.panel.surveyStartFailed', reason: '測量通信を開始できません。' };
              this.notifications.show(result.ok ? this.resultMessagePayload(result, 'combat.panel.surveyStarted', '道路測量を開始しました。') : this.reasonPayload(result, 'combat.panel.surveyStartFailed', '道路測量を開始できません。'));
              if (result.ok) this.persist?.();
              this.renderContext();
            },
            'primary'
          );
          scan.disabled = defense.hp <= 0 || defense.disabledTimer > 0 || surveyBusy || surveyComplete || typeof this.requestSurvey !== 'function';
        }
        const upgradeButton = this.action(upgrade.atMax ? this.actionMsg('combat.panel.actionMaxTier', {}, '最高Tier') : this.actionMsg('combat.panel.actionUpgrade', {}, '強化'), () => this.setDefensePanelMode('upgrade', defense.id), 'primary');
        upgradeButton.disabled = upgrade.atMax;
        if (defense.kind === 'barrier' && !defense.isGate) {
          const gate = this.action((state.civilization.level ?? 0) >= 2 ? this.actionMsg('combat.panel.actionConvertGate', {}, '門へ変換') : this.actionMsg('combat.panel.actionGateLocked', {}, '門は文明Lv.2で解禁'), () => this.commandAction('defense.convertGate', { defenseId: defense.id }));
          gate.disabled = (state.civilization.level ?? 0) < 2 || defense.hp <= 0;
        }
        const removalPending = this.pendingDefenseRemovalId === defense.id;
        this.action(
          removalPending ? this.actionMsg('combat.panel.actionConfirmRemoval', {}, '撤去を確定（資源返還なし）') : this.actionMsg('combat.panel.actionRemove', {}, '撤去'),
          () => this.requestDefenseRemoval(defense.id),
          'danger'
        );
        if (removalPending) this.action(this.actionMsg('combat.panel.actionCancelRemoval', {}, '撤去を中止'), () => this.cancelDefenseRemoval());
      }
    } else {
      this.contextTitle.textContent = this.panelMsg('combat.panel.city', {}, '都市');
      this.setContextContent(this.panelMsg('combat.panel.citySummary', {}, '防衛対象となる中枢都市です。'), [['HP', `${Math.ceil(state.world.city.hp)}/${state.world.city.maxHp}`], ['CIV', String(state.civilization.level)], ['KILLS', String(state.statistics.kills ?? 0)]]);
    }
    setVisible(this.context, true);
  }

  update(state = uiViewState(this.store)) {
    this.cityHp.textContent = `${Math.ceil(state.world.city?.hp ?? 0)}/${Math.ceil(state.world.city?.maxHp ?? 0)}`;
    this.enemyCount.textContent = enemyTotalPopulation(state);
    this.civilizationLevel.textContent = state.civilization.level;
    const affordability = this.affordabilitySignature(state);
    const languageSignature = this.i18n?.language ?? 'ja';
    if (affordability !== this.toolAffordabilitySignature || languageSignature !== this.toolLanguageSignature) this.renderTools(state);
    if (this.selectedTool !== 'select') this.refreshBuildPlacement(false, state);
    if (this.orderPlanning) {
      const subject = this.planningSubject(state);
      const startNodeId = subject
        ? this.orderPlanning.mode === FRIENDLY_ORDER_MODE.DEPLOYMENT
          ? this.orderPlanning.originNodeId
          : commandStartNodeId(state, subject)
        : null;
      if (!subject) this.cancelOrderPlanning();
      else if (startNodeId !== this.orderPlanning.startNodeId) this.rebuildOrderRoutes(state);
    }
    if (!this.context.hidden) this.renderContext(state);
  }
}
