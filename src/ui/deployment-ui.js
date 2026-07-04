import { deploymentBases, ownedBaseById } from '../base/field-bases.js';
import { ENEMY_BASE_DEFINITIONS, ENEMY_DEFINITIONS } from '../combat/definitions.js';
import {
  FRIENDLY_SQUAD_DEFINITIONS, FRIENDLY_SQUAD_TYPES, friendlySquadCapacityStatus,
  friendlyGlobalCommandStatus, friendlyCoordinatedDeploymentLimit, COORDINATED_DEPLOYMENT_TIMING
} from '../combat/friendly-force-system.js';
import { bundleText } from '../civilization/inventory-system.js';
import { RECOVERY_ITEM_STATUS, recoveryItemPresentation } from '../exploration/recovery-system.js';
import { friendlySquadLevelBonus, friendlySquadLevelProgress } from '../combat/friendly-force-definitions.js';
import { CIVILIZATION_ABILITY, hasCivilizationAbility, abilityUnlockLevel } from '../civilization/abilities.js';
import { bindDismissibleModal, escapeHtml, queryRequired, setVisible, uiViewState } from './dom.js';

const MISSION_KIND = Object.freeze({ ATTACK: 'ATTACK', INTERCEPT: 'INTERCEPT', RECOVERY: 'RECOVERY' });
const DEPLOYMENT_MODE = Object.freeze({ SINGLE: 'SINGLE', COORDINATED: 'COORDINATED' });

function isRecoveryType(type) {
  return FRIENDLY_SQUAD_DEFINITIONS[type]?.missionKind === MISSION_KIND.RECOVERY;
}

function shortestRecoveryRemainingForBase(state, baseId) {
  const values = (state.combat?.friendlySquads ?? [])
    .filter(squad => squad.originBaseId === baseId && squad.status === 'RECOVERING' && squad.hp > 0)
    .map(squad => Math.max(0, Number(squad.reorganizationRemaining) || 0))
    .filter(value => value > 0)
    .sort((a, b) => a - b);
  return values[0] ?? 0;
}

export class DeploymentUi {
  constructor({ store, friendlyForceSystem, commandBus = null, notifications, persist, beginRoutePlanning = null, i18n = null }) {
    this.store = store;
    this.system = friendlyForceSystem;
    this.commandBus = commandBus;
    this.notifications = notifications;
    this.persist = persist;
    this.beginRoutePlanning = beginRoutePlanning;
    this.i18n = i18n;
    this.panel = queryRequired('#deploymentPanel');
    this.title = queryRequired('#deploymentTitle');
    this.body = queryRequired('#deploymentBody');
    this.missionKind = MISSION_KIND.ATTACK;
    this.mode = DEPLOYMENT_MODE.SINGLE;
    this.squadType = 'assault';
    this.groupCounts = Object.create(null);
    this.coordinatedTimingMode = COORDINATED_DEPLOYMENT_TIMING.LEAD;
    this.coordinatedManualDelays = Object.create(null);
    this.originBaseId = null;
    this.targetId = null;
    this.targetKind = 'enemyBase';
    this.selectedRoutePlan = null;
    this.lastRenderAt = 0;
    queryRequired('#closeDeployment').addEventListener('click', () => this.close());
    bindDismissibleModal(this.panel, () => this.close());
    this.body.addEventListener('click', event => this.handleAction(event));
  }

  localize(text = '') { return this.i18n?.copy?.(text) ?? text; }

  msg(key, params = {}, fallback = '') { return this.i18n?.message?.(key, params, fallback) ?? this.localize(fallback || key); }

  messagePayload(key, params = {}, fallback = '') { return { key, params, text: fallback }; }

  html(text = '') { return escapeHtml(text); }

  htmlMsg(key, params = {}, fallback = '') { return this.html(this.msg(key, params, fallback)); }

  chromeMsg(key, fallback = '') { return this.msg(`ui.chrome.${key}`, {}, fallback); }

  htmlChrome(key, fallback = '') { return this.html(this.chromeMsg(key, fallback)); }

  bundleText(bundle = {}) { return this.i18n?.compactBundleText?.(bundle) ?? bundleText(bundle); }

  showMessage(key, params = {}, fallback = '') { this.notifications.show(this.messagePayload(key, params, fallback)); }

  reasonPayload(resultOrReason, fallbackKey, fallbackText) {
    if (resultOrReason && typeof resultOrReason === 'object') {
      if (resultOrReason.reasonKey) return this.messagePayload(resultOrReason.reasonKey, resultOrReason.reasonParams ?? {}, resultOrReason.reason ?? fallbackText);
      if (resultOrReason.key) return this.messagePayload(resultOrReason.key, resultOrReason.params ?? {}, resultOrReason.text ?? resultOrReason.fallback ?? fallbackText);
      return this.messagePayload(fallbackKey, {}, resultOrReason.reason ?? fallbackText);
    }
    return resultOrReason ? this.messagePayload(fallbackKey, {}, String(resultOrReason)) : this.messagePayload(fallbackKey, {}, fallbackText);
  }

  showReason(resultOrReason, fallbackKey, fallbackText) { this.notifications.show(this.reasonPayload(resultOrReason, fallbackKey, fallbackText)); }

  routeText(distance) {
    if (!Number.isFinite(distance)) return this.msg('deployment.routeNone', {}, '経路なし');
    if (distance < 1000) return `${Math.round(distance)}m`;
    return `${(distance / 1000).toFixed(1)}km`;
  }

  durationText(seconds) {
    if (!Number.isFinite(seconds)) return this.msg('deployment.durationUnknown', {}, '算出不能');
    const value = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    if (minutes && remainder) return this.msg('deployment.durationMinutesSeconds', { minutes, seconds: remainder }, `約${minutes}分${remainder}秒`);
    if (minutes) return this.msg('deployment.durationMinutes', { minutes }, `約${minutes}分`);
    return this.msg('deployment.durationSeconds', { seconds: remainder }, `約${remainder}秒`);
  }

  baseKindLabel(base) {
    return base?.kind === 'FIELD'
      ? this.msg('deployment.baseKindField', {}, '簡易拠点')
      : this.msg('deployment.baseKindMajor', {}, '主要拠点');
  }

  baseKindAccessText(item) {
    return item?.allowedBaseKinds?.includes?.('FIELD')
      ? this.msg('deployment.baseAccessMajorField', {}, '主要・簡易')
      : this.msg('deployment.baseAccessMajorOnly', {}, '主要のみ');
  }

  squadLevelText(squad) {
    if (!squad) return this.msg('deployment.squadNewShort', {}, '新規 Lv.1');
    const progress = friendlySquadLevelProgress(squad);
    if (progress.maxed) return this.msg('deployment.squadLevelMax', { level: progress.level }, `Lv.${progress.level} MAX`);
    return this.msg('deployment.squadLevelXp', { level: progress.level, xp: progress.xp, next: progress.nextXp }, `Lv.${progress.level} XP ${progress.xp}/${progress.nextXp}`);
  }

  squadLevelBonusText(type, squad = null) {
    const progress = friendlySquadLevelProgress(squad ?? { unitLevel: 1, unitXp: 0 });
    const bonus = friendlySquadLevelBonus(type, progress.level);
    return this.msg('deployment.squadBonusSummary', bonus, `Lv補正 HP +${bonus.hp}% / 攻撃 +${bonus.damage}% / 速度 +${bonus.speed}% / 被害 -${bonus.mitigation}%`);
  }

  bestSquadForType(state, baseId, type) {
    return (state.combat?.friendlySquads ?? [])
      .filter(squad => squad.originBaseId === baseId && squad.type === type && squad.hp > 0)
      .sort((a, b) => (b.status === 'READY') - (a.status === 'READY') || (b.unitLevel ?? 1) - (a.unitLevel ?? 1) || (b.unitXp ?? 0) - (a.unitXp ?? 0))[0] ?? null;
  }

  baseSquadLevelSummary(state, baseId, type) {
    if (!baseId) return this.msg('deployment.levelAfterOrigin', {}, '出撃元選択後にLv/XPを表示');
    const squads = (state.combat?.friendlySquads ?? [])
      .filter(squad => squad.originBaseId === baseId && squad.type === type && squad.hp > 0)
      .sort((a, b) => (b.status === 'READY') - (a.status === 'READY') || (b.unitLevel ?? 1) - (a.unitLevel ?? 1) || (b.unitXp ?? 0) - (a.unitXp ?? 0));
    if (!squads.length) return this.msg('deployment.newFormationSummary', {}, '新規編成 Lv.1 XP 0/80');
    const ready = squads.find(squad => squad.status === 'READY');
    const recovering = squads.find(squad => squad.status === 'RECOVERING');
    const active = squads.find(squad => !['READY', 'RECOVERING'].includes(squad.status));
    if (ready) return this.msg('deployment.readyLevelSummary', { levelText: this.squadLevelText(ready) }, `待機 ${this.squadLevelText(ready)}`);
    if (recovering) return this.msg('deployment.recoveringLevelSummary', { levelText: this.squadLevelText(recovering), duration: this.durationText(recovering.reorganizationRemaining) }, `回復中 ${this.squadLevelText(recovering)}・残り ${this.durationText(recovering.reorganizationRemaining)}`);
    return this.msg('deployment.activeLevelSummary', { levelText: this.squadLevelText(active ?? squads[0]) }, `運用中 ${this.squadLevelText(active ?? squads[0])}`);
  }

  openForEnemyBase(targetId) {
    this.missionKind = MISSION_KIND.ATTACK;
    this.targetKind = 'enemyBase';
    this.selectedRoutePlan = null;
    this.mode = DEPLOYMENT_MODE.SINGLE;
    if (isRecoveryType(this.squadType)) this.squadType = 'assault';
    this.resetGroupSelection();
    return this.openTarget(targetId);
  }

  openForEnemy(targetId) {
    this.missionKind = MISSION_KIND.INTERCEPT;
    this.targetKind = 'enemy';
    this.mode = DEPLOYMENT_MODE.SINGLE;
    if (isRecoveryType(this.squadType)) this.squadType = 'assault';
    this.groupCounts = Object.create(null);
    return this.openTarget(targetId);
  }

  openForRecoveryItem(targetId) {
    this.missionKind = MISSION_KIND.RECOVERY;
    this.targetKind = 'recoveryItem';
    this.mode = DEPLOYMENT_MODE.SINGLE;
    this.squadType = 'retrieval';
    this.groupCounts = Object.create(null);
    return this.openTarget(targetId);
  }

  openTarget(targetId) {
    this.targetId = targetId;
    this.selectedRoutePlan = null;
    this.originBaseId = null;
    const state = uiViewState(this.store);
    this.normalizeSelection(state);
    if (!this.currentTarget(state)) {
      const key = this.missionKind === MISSION_KIND.RECOVERY
        ? 'deployment.targetUnavailableRecovery'
        : this.missionKind === MISSION_KIND.INTERCEPT
          ? 'deployment.targetUnavailableEnemy'
          : 'deployment.targetUnavailableEnemyBase';
      const fallback = this.missionKind === MISSION_KIND.RECOVERY
        ? 'この回収物は現在派遣対象にできません。'
        : this.missionKind === MISSION_KIND.INTERCEPT
          ? 'この敵部隊は現在迎撃対象にできません。'
          : 'この敵拠点は現在攻撃対象にできません。';
      this.showMessage(key, {}, fallback);
      return false;
    }
    this.render(state);
    setVisible(this.panel, true);
    return true;
  }

  close() {
    setVisible(this.panel, false);
  }

  update(state = uiViewState(this.store)) {
    if (!this.panel.hidden && Date.now() - this.lastRenderAt >= 1000) {
      if (!this.currentTarget(state)) {
        this.close();
        return;
      }
      this.render(state);
    }
  }

  availableTypes() {
    return FRIENDLY_SQUAD_TYPES.filter(type => this.missionKind === MISSION_KIND.RECOVERY ? isRecoveryType(type) : !isRecoveryType(type));
  }

  unlockedAttackTypes(state = uiViewState(this.store)) {
    return this.availableTypes().filter(type => (state.civilization?.level ?? 0) >= FRIENDLY_SQUAD_DEFINITIONS[type].unlockLevel);
  }

  currentTarget(state = uiViewState(this.store)) {
    if (this.missionKind === MISSION_KIND.RECOVERY) {
      return (state.world.recoveryItems ?? []).find(item => item.id === this.targetId && item.status === RECOVERY_ITEM_STATUS.AVAILABLE) ?? null;
    }
    if (this.missionKind === MISSION_KIND.INTERCEPT) {
      return state.combat.enemies.find(enemy => enemy.id === this.targetId && enemy.hp > 0 && enemy.departDelay <= 0) ?? null;
    }
    return state.world.enemyBases.find(base => base.id === this.targetId && base.alive && base.hp > 0) ?? null;
  }

  resetGroupSelection() {
    const state = uiViewState(this.store);
    const types = this.unlockedAttackTypes(state);
    this.groupCounts = Object.create(null);
    const first = types.includes('assault') ? 'assault' : types[0];
    if (first) this.groupCounts[first] = 2;
  }

  groupSquadTypes() {
    return this.availableTypes().flatMap(type => Array.from({ length: Math.max(0, Math.floor(this.groupCounts[type] ?? 0)) }, () => type));
  }

  coordinatedOptions() {
    return { timingMode: this.coordinatedTimingMode, manualDelays: this.coordinatedManualDelays, routeOverride: this.selectedRoutePlan?.route?.path ?? null };
  }

  manualDelayFor(type) {
    return Math.max(0, Math.min(180, Math.floor(Number(this.coordinatedManualDelays[type]) || 0)));
  }

  normalizeSelection(state = uiViewState(this.store)) {
    const previousType = this.squadType;
    const previousOriginBaseId = this.originBaseId;
    const availableTypes = this.availableTypes();
    const selectedDefinition = FRIENDLY_SQUAD_DEFINITIONS[this.squadType];
    if (!availableTypes.includes(this.squadType) || !selectedDefinition || (state.civilization?.level ?? 0) < selectedDefinition.unlockLevel) {
      this.squadType = availableTypes.find(type => (state.civilization?.level ?? 0) >= FRIENDLY_SQUAD_DEFINITIONS[type].unlockLevel) ?? availableTypes[0] ?? 'assault';
    }
    const bases = deploymentBases(state, this.squadType);
    if (!bases.some(base => base.id === this.originBaseId)) this.originBaseId = bases[0]?.id ?? null;
    if (previousType !== this.squadType || previousOriginBaseId !== this.originBaseId) this.selectedRoutePlan = null;
    for (const type of Object.keys(this.groupCounts)) {
      if (!availableTypes.includes(type) || (state.civilization?.level ?? 0) < FRIENDLY_SQUAD_DEFINITIONS[type].unlockLevel) delete this.groupCounts[type];
    }
  }

  dispatchCurrent(routeOverride = this.selectedRoutePlan?.route?.path ?? null) {
    const result = this.commandBus?.execute('friendly.dispatch', {
      originBaseId: this.originBaseId,
      targetId: this.targetId,
      squadType: this.squadType,
      targetKind: this.targetKind,
      routeOverride
    }) ?? { ok: false, reason: 'Command bus is unavailable.' };
    if (!result?.ok) {
      this.showReason(result, 'deployment.dispatchFailed', '派兵できません。');
      return result ?? { ok: false };
    }
    const unitName = this.localize(FRIENDLY_SQUAD_DEFINITIONS[this.squadType]?.name ?? '部隊');
    this.showMessage('deployment.dispatched', { unitName }, `${unitName}を派兵しました。`);
    this.persist?.();
    this.close();
    return result;
  }

  handleAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, baseId, squadType } = button.dataset;
    if (action === 'deployment-mode') {
      this.mode = button.dataset.mode === DEPLOYMENT_MODE.COORDINATED ? DEPLOYMENT_MODE.COORDINATED : DEPLOYMENT_MODE.SINGLE;
      this.selectedRoutePlan = null;
      if (this.mode === DEPLOYMENT_MODE.COORDINATED && !hasCivilizationAbility(uiViewState(this.store), CIVILIZATION_ABILITY.COORDINATED_DISPATCH)) {
      this.showMessage('deployment.coordinatedLockedByCiv', { level: abilityUnlockLevel(CIVILIZATION_ABILITY.COORDINATED_DISPATCH) }, `連携出撃は文明Lv.${abilityUnlockLevel(CIVILIZATION_ABILITY.COORDINATED_DISPATCH)}で解禁されます。`);
      this.mode = DEPLOYMENT_MODE.SINGLE;
    }
    if (this.mode === DEPLOYMENT_MODE.COORDINATED && this.groupSquadTypes().length === 0) this.resetGroupSelection();
    }
    if (action === 'select-unit' && squadType) {
      const state = uiViewState(this.store);
      const definition = FRIENDLY_SQUAD_DEFINITIONS[squadType];
      if (!definition || !this.availableTypes().includes(squadType) || (state.civilization?.level ?? 0) < definition.unlockLevel) return;
      this.squadType = squadType;
      this.originBaseId = null;
      this.selectedRoutePlan = null;
    }
    if (action === 'group-add' && squadType) {
      const total = this.groupSquadTypes().length;
      const maximum = friendlyCoordinatedDeploymentLimit(uiViewState(this.store));
      if (total < maximum) this.groupCounts[squadType] = (this.groupCounts[squadType] ?? 0) + 1;
    }
    if (action === 'group-remove' && squadType) {
      this.groupCounts[squadType] = Math.max(0, (this.groupCounts[squadType] ?? 0) - 1);
    }
    if (action === 'select-origin') { this.originBaseId = baseId; this.selectedRoutePlan = null; }
    if (action === 'plan-route') {
      const state = uiViewState(this.store);
      const origin = ownedBaseById(state, this.originBaseId);
      const target = this.currentTarget(state);
      const preview = this.originBaseId
        ? this.system.previewDeployment(state, this.originBaseId, this.targetId, this.squadType, this.targetKind, this.selectedRoutePlan?.route?.path ?? null)
        : { ok: false, reason: this.msg('deployment.selectOriginRequired', {}, '出撃元を選択してください。') };
      const blockedByPreview = !preview.ok && preview.reasonKey !== 'reason.deployment.routeInvalidated' && !String(preview.reason ?? '').includes('選択した派兵経路');
      if (blockedByPreview) {
        this.showReason(preview, 'deployment.routePlanningBlocked', '派兵条件を満たしていないため、経路指定できません。');
      } else if (!origin || !target?.nodeId || typeof this.beginRoutePlanning !== 'function') {
        this.showMessage('deployment.routePlanningUnavailable', {}, '派兵経路を指定できません。出撃元と目標を確認してください。');
      } else {
        const targetLabel = this.missionKind === MISSION_KIND.RECOVERY
          ? recoveryItemPresentation(target).name
          : this.missionKind === MISSION_KIND.INTERCEPT
            ? ENEMY_DEFINITIONS[target.type]?.name ?? this.msg('deployment.enemySquadFallback', {}, '敵部隊')
            : ENEMY_BASE_DEFINITIONS[target.type]?.name ?? this.msg('deployment.enemyBaseFallback', {}, '敵拠点');
        const opened = this.beginRoutePlanning({
          originNodeId: origin.nodeId,
          squadType: this.squadType,
          destinationNodeId: target.nodeId,
          targetLabel: this.localize(targetLabel),
          confirmLabel: this.missionKind === MISSION_KIND.RECOVERY
            ? this.msg('deployment.confirmRecoveryRoute', {}, 'この経路で回収部隊を派遣')
            : this.msg('deployment.confirmDispatchRoute', {}, 'この経路で派兵'),
          onConfirm: plan => {
            const result = this.dispatchCurrent(plan?.route?.path ?? null);
            if (!result?.ok) {
              this.selectedRoutePlan = plan;
              this.render();
              setVisible(this.panel, true);
            }
          },
          onCancel: () => {
            this.render();
            setVisible(this.panel, true);
          }
        });
        if (opened) { this.close(); return; }
      }
    }
    if (action === 'dispatch') {
      const result = this.dispatchCurrent(this.selectedRoutePlan?.route?.path ?? null);
      if (result?.ok) return;
    }
    if (action === 'coord-timing') {
      const mode = button.dataset.mode;
      this.coordinatedTimingMode = Object.values(COORDINATED_DEPLOYMENT_TIMING).includes(mode) ? mode : COORDINATED_DEPLOYMENT_TIMING.LEAD;
    }
    if (action === 'delay-minus' && squadType) {
      this.coordinatedTimingMode = COORDINATED_DEPLOYMENT_TIMING.MANUAL;
      this.coordinatedManualDelays[squadType] = Math.max(0, this.manualDelayFor(squadType) - 5);
    }
    if (action === 'delay-plus' && squadType) {
      this.coordinatedTimingMode = COORDINATED_DEPLOYMENT_TIMING.MANUAL;
      this.coordinatedManualDelays[squadType] = Math.min(180, this.manualDelayFor(squadType) + 5);
    }
    if (action === 'plan-coordinated-route') {
      const state = uiViewState(this.store);
      const squadTypes = this.groupSquadTypes();
      const target = this.currentTarget(state);
      const preview = this.system.previewCoordinatedDeployment(state, this.targetId, squadTypes, this.coordinatedOptions());
      const fallbackPreview = preview.origin ? preview : this.system.previewCoordinatedDeployment(state, this.targetId, squadTypes, { ...this.coordinatedOptions(), routeOverride: null });
      const origin = fallbackPreview.origin;
      if (squadTypes.length < 2) {
        this.showMessage('deployment.coordinatedNeedsTwo', {}, '連携出撃には2部隊以上を選択してください。');
      } else if (!origin || !target?.nodeId || typeof this.beginRoutePlanning !== 'function') {
        this.showReason(fallbackPreview, 'deployment.coordinatedRouteUnavailable', '連携出撃の共通経路を指定できません。');
      } else {
        const targetLabel = ENEMY_BASE_DEFINITIONS[target.type]?.name ?? this.msg('deployment.enemyBaseFallback', {}, '敵拠点');
        const opened = this.beginRoutePlanning({
          originNodeId: origin.nodeId,
          squadType: squadTypes[0] ?? 'assault',
          destinationNodeId: target.nodeId,
          targetLabel: this.localize(targetLabel),
          confirmLabel: this.msg('deployment.confirmCoordinatedRoute', {}, 'この経路を連携出撃に採用'),
          onConfirm: plan => {
            this.selectedRoutePlan = plan;
            this.render();
            setVisible(this.panel, true);
          },
          onCancel: () => {
            this.render();
            setVisible(this.panel, true);
          }
        });
        if (opened) { this.close(); return; }
      }
    }
    if (action === 'dispatch-group') {
      const squadTypes = this.groupSquadTypes();
      const result = this.commandBus?.execute('friendly.coordinatedDispatch', {
        targetId: this.targetId,
        squadTypes,
        options: this.coordinatedOptions()
      }) ?? { ok: false, reason: 'Command bus is unavailable.' };
      if (!result?.ok) this.showReason(result, 'deployment.coordinatedDispatchFailed', '連携出撃できません。');
      else {
        this.showMessage('deployment.coordinatedDispatched', { count: result.squads.length }, `${result.squads.length}部隊が同じルートで連携出撃しました。`);
        this.persist?.();
        this.close();
        return;
      }
    }
    this.normalizeSelection();
    this.render();
  }

  targetMarkup(target) {
    if (this.missionKind === MISSION_KIND.RECOVERY) {
      const presentation = recoveryItemPresentation(target);
      return `<div class="deploymentTargetSummary recoveryTarget"><span>${this.htmlChrome('recoveryTarget', 'RECOVERY TARGET')}</span><strong>${this.html(this.localize(presentation.name))}</strong><small>${this.htmlMsg('deployment.recoveryTargetNote', { sourceName: this.localize(presentation.sourceName) }, '{sourceName}跡地・確保後は拠点への帰還が必要')}</small></div>`;
    }
    if (this.missionKind === MISSION_KIND.INTERCEPT) {
      const definition = ENEMY_DEFINITIONS[target.type];
      return `<div class="deploymentTargetSummary hostile"><span>${this.htmlChrome('interceptTarget', 'INTERCEPT TARGET')}</span><strong>${this.html(this.localize(definition?.name ?? '敵部隊'))}</strong><small>${this.htmlMsg('deployment.interceptTargetNote', { hp: Math.ceil(target.hp), maxHp: target.maxHp, level: target.level ?? 1 }, 'HP {hp}/{maxHp}・Lv.{level}・移動目標を追跡')}</small></div>`;
    }
    const definition = ENEMY_BASE_DEFINITIONS[target.type];
    return `<div class="deploymentTargetSummary hostile"><span>${this.htmlChrome('attackTarget', 'ATTACK TARGET')}</span><strong>${this.html(this.localize(definition?.name ?? '敵拠点'))}</strong><small>${this.htmlMsg('deployment.attackTargetNote', { hp: Math.ceil(target.hp), maxHp: target.maxHp, level: target.level ?? 1 }, 'HP {hp}/{maxHp}・Lv.{level}')}</small></div>`;
  }

  modeMarkup() {
    if (this.missionKind !== MISSION_KIND.ATTACK) return '';
    const state = uiViewState(this.store);
    const coordinatedUnlocked = hasCivilizationAbility(state, CIVILIZATION_ABILITY.COORDINATED_DISPATCH);
    const coordinatedLabel = coordinatedUnlocked
      ? this.msg('deployment.modeCoordinated', {}, '連携出撃')
      : this.msg('deployment.modeCoordinatedLocked', { level: abilityUnlockLevel(CIVILIZATION_ABILITY.COORDINATED_DISPATCH) }, `連携出撃 Lv.${abilityUnlockLevel(CIVILIZATION_ABILITY.COORDINATED_DISPATCH)}`);
    return `<div class="deploymentModeSwitch" role="group" aria-label="${this.htmlMsg('deployment.modeAria', {}, '派兵方式')}"><button data-action="deployment-mode" data-mode="${DEPLOYMENT_MODE.SINGLE}" class="${this.mode === DEPLOYMENT_MODE.SINGLE ? 'selected' : ''}">${this.htmlMsg('deployment.modeSingle', {}, '単独出撃')}</button><button data-action="deployment-mode" data-mode="${DEPLOYMENT_MODE.COORDINATED}" class="${this.mode === DEPLOYMENT_MODE.COORDINATED ? 'selected' : ''}" ${coordinatedUnlocked ? '' : 'disabled'}>${this.html(coordinatedLabel)}</button></div>`;
  }

  unitCardsMarkup(state) {
    const civilizationLevel = state.civilization?.level ?? 0;
    return this.availableTypes().map(type => {
      const item = FRIENDLY_SQUAD_DEFINITIONS[type];
      const unlocked = civilizationLevel >= item.unlockLevel;
      const selected = type === this.squadType;
      const baseText = this.baseKindAccessText(item);
      const lockedText = this.msg('deployment.unlockAtCiv', { level: item.unlockLevel }, `文明Lv.${item.unlockLevel}で解禁`);
      const levelSummary = unlocked ? this.baseSquadLevelSummary(state, this.originBaseId, type) : lockedText;
      const bonusText = unlocked ? this.squadLevelBonusText(type, this.bestSquadForType(state, this.originBaseId, type)) : '';
      return `<button class="deploymentCard unitCard ${selected ? 'selected' : ''}" data-action="select-unit" data-squad-type="${this.html(type)}" ${unlocked ? '' : 'disabled'}><strong>${this.html(this.localize(item.name))}</strong><span>${this.html(this.localize(item.role))}・${this.html(baseText)}</span><small>${this.html(unlocked ? this.localize(item.description) : lockedText)}</small><small>${this.html(levelSummary)}</small>${bonusText ? `<small>${this.html(bonusText)}</small>` : ''}</button>`;
    }).join('');
  }

  groupCardsMarkup(state) {
    const total = this.groupSquadTypes().length;
    const maximum = friendlyCoordinatedDeploymentLimit(state);
    return this.availableTypes().map(type => {
      const item = FRIENDLY_SQUAD_DEFINITIONS[type];
      const unlocked = (state.civilization?.level ?? 0) >= item.unlockLevel;
      const count = this.groupCounts[type] ?? 0;
      const baseText = this.baseKindAccessText(item);
      const lockedText = this.msg('deployment.unlockAtCiv', { level: item.unlockLevel }, `文明Lv.${item.unlockLevel}で解禁`);
      return `<article class="deploymentCard coordinatedUnitCard ${count ? 'selected' : ''} ${unlocked ? '' : 'locked'}"><div><strong>${this.html(this.localize(item.name))}</strong><span>${this.html(this.localize(item.role))}・${this.html(baseText)}</span><small>${this.html(unlocked ? this.localize(item.description) : lockedText)}</small></div><div class="squadCountControl"><button data-action="group-remove" data-squad-type="${this.html(type)}" ${!unlocked || count <= 0 ? 'disabled' : ''}>−</button><b>${count}</b><button data-action="group-add" data-squad-type="${this.html(type)}" ${!unlocked || total >= maximum ? 'disabled' : ''}>＋</button></div></article>`;
    }).join('');
  }

  singleDeploymentMarkup(state) {
    const definition = FRIENDLY_SQUAD_DEFINITIONS[this.squadType] ?? FRIENDLY_SQUAD_DEFINITIONS.assault;
    const bases = deploymentBases(state, this.squadType);
    const recoveryMission = this.missionKind === MISSION_KIND.RECOVERY;
    const preview = this.originBaseId
      ? this.system.previewDeployment(state, this.originBaseId, this.targetId, this.squadType, this.targetKind, this.selectedRoutePlan?.route?.path ?? null)
      : { ok: false, reason: this.msg('deployment.selectOriginRequired', {}, '出撃元を選択してください。') };
    const originCards = bases.map(base => {
      const capacity = friendlySquadCapacityStatus(state, base);
      const baseSquads = (state.combat?.friendlySquads ?? []).filter(squad => squad.originBaseId === base.id && squad.hp > 0);
      const highestLevel = baseSquads.reduce((best, squad) => Math.max(best, Math.floor(Number(squad.unitLevel) || 1)), 1);
      const recoveryRemaining = shortestRecoveryRemainingForBase(state, base.id);
      const statusParts = [
        this.msg('deployment.capacitySlots', { assigned: capacity.assigned, capacity: capacity.capacity }, `部隊枠 ${capacity.assigned}/${capacity.capacity}`),
        this.msg('deployment.activeCount', { count: capacity.active }, `派兵中 ${capacity.active}`),
        capacity.recovering ? this.msg('deployment.recoveringCount', { count: capacity.recovering, duration: recoveryRemaining ? this.durationText(recoveryRemaining) : '' }, `回復 ${capacity.recovering}${recoveryRemaining ? ` 最短${this.durationText(recoveryRemaining)}` : ''}`) : null,
        capacity.ready ? this.msg('deployment.readyCount', { count: capacity.ready }, `待機 ${capacity.ready}`) : null,
        baseSquads.length ? this.msg('deployment.highestLevel', { level: highestLevel }, `最高Lv.${highestLevel}`) : this.msg('deployment.newLevelOne', {}, '新規Lv.1')
      ].filter(Boolean).join(' · ');
      return `<button class="deploymentCard ${base.id === this.originBaseId ? 'selected' : ''}" data-action="select-origin" data-base-id="${this.html(base.id)}"><strong>${this.html(base.name)}</strong><span>${this.html(this.baseKindLabel(base))} · HP ${Math.ceil(base.hp)}/${base.maxHp}</span><small>${this.html(statusParts)}</small></button>`;
    }).join('') || `<p class="emptyText">${this.htmlMsg('deployment.noOriginBases', { unitName: this.localize(definition.name) }, '{unitName}を出撃できる拠点がありません。')}</p>`;
    const origin = ownedBaseById(state, this.originBaseId, { includeDestroyed: true });
    const globalCommand = friendlyGlobalCommandStatus(state);
    const selectedRoute = this.selectedRoutePlan?.route ?? null;
    const fixedTarget = this.missionKind !== MISSION_KIND.INTERCEPT;
    const routePlannerBlockedByPreview = !preview.ok && preview.reasonKey !== 'reason.deployment.routeInvalidated' && !String(preview.reason ?? '').includes('選択した派兵経路');
    const routePlannerAvailable = Boolean(origin && preview.path && fixedTarget && typeof this.beginRoutePlanning === 'function' && !routePlannerBlockedByPreview);
    const routeSummary = selectedRoute
      ? this.msg('deployment.selectedRouteSummary', { routeLabel: this.localize(selectedRoute.label), distance: this.routeText(selectedRoute.physicalDistance), risk: selectedRoute.risk, waypoints: this.selectedRoutePlan.waypointNodeIds.length }, '{routeLabel}・{distance}・危険度 {risk}・経由 {waypoints}/2')
      : this.msg('deployment.autoRouteSummary', {}, '自動最短経路。必要なら出撃前に地図上で経路を指定できます。');
    const previewNote = preview.ok
      ? preview.reuseReadySquad
        ? this.msg('deployment.reuseReadyNote', {}, '再編成済みの同じ部隊を、現在HPのまま追加費用なしで再出撃させます。')
        : preview.replaceReadySquad
          ? this.msg('deployment.replaceReadyNote', {}, '待機中の別部隊を解散し、新しい部隊を編成します。')
          : this.localize(definition.description)
      : this.localize(preview.reason);
    const dispatchLabel = preview.reuseReadySquad
      ? this.msg('deployment.buttonRedeploy', { unitName: this.localize(definition.name) }, '{unitName}を再出撃')
      : preview.replaceReadySquad
        ? this.msg('deployment.buttonReform', { unitName: this.localize(definition.name) }, '{unitName}へ再編成')
        : recoveryMission
          ? this.msg('deployment.buttonDispatchRecovery', { unitName: this.localize(definition.name) }, '{unitName}を派遣')
          : this.missionKind === MISSION_KIND.INTERCEPT
            ? this.msg('deployment.buttonDispatchEnemy', { unitName: this.localize(definition.name) }, 'この敵部隊へ{unitName}を派兵')
            : this.msg('deployment.buttonDispatchEnemyBase', { unitName: this.localize(definition.name) }, 'この敵拠点へ{unitName}を派兵');
    return `<section><h2>${this.htmlMsg('deployment.unitTypeHeading', {}, '部隊種類')} <small>${this.htmlMsg('deployment.globalCommandSmall', { assigned: globalCommand.assigned, capacity: globalCommand.capacity }, '全体指揮 {assigned}/{capacity}')}</small></h2><div class="deploymentGrid deploymentUnitGrid">${this.unitCardsMarkup(state)}</div></section>
      <section><h2>${this.htmlMsg('deployment.originHeading', {}, '出撃元')}</h2><div class="deploymentGrid">${originCards}</div></section>
      <section class="deploymentOrder"><h2>${this.htmlMsg('deployment.confirmHeading', {}, '派兵確認')}</h2>
        <div class="contextMetricGrid"><span><small>${this.htmlChrome('from', 'FROM')}</small><strong>${this.html(origin?.name ?? this.msg('deployment.unselected', {}, '未選択'))}</strong></span><span><small>${this.htmlChrome('unit', 'UNIT')}</small><strong>${this.html(this.localize(definition.name))}</strong></span><span><small>${this.htmlChrome('route', 'ROUTE')}</small><strong>${this.html(selectedRoute?.label ? this.localize(selectedRoute.label) : this.chromeMsg('auto', 'AUTO'))} ${this.html(this.routeText(preview.routeDistance))}</strong></span><span><small>${this.htmlChrome('slot', 'SLOT')}</small><strong>${preview.capacity ? `${preview.assignedSquads ?? 0}/${preview.capacity}` : '—'}</strong></span><span><small>${this.htmlChrome('cost', 'COST')}</small><strong>${this.html(preview.reuseReadySquad ? this.msg('deployment.costNone', {}, '不要') : this.bundleText(definition.cost))}</strong></span></div>
        <p class="sectionNote">${this.html(routeSummary)}</p>
        <button class="wideButton" data-action="plan-route" ${routePlannerAvailable ? '' : 'disabled'}>${this.htmlMsg(selectedRoute ? 'deployment.buttonChangeRoute' : 'deployment.buttonPlanRoute', {}, selectedRoute ? '派兵経路を変更' : '地図で派兵経路を指定')}</button>
        <p class="sectionNote">${this.html(previewNote)}</p>
        <button class="primary wideButton" data-action="dispatch" ${preview.ok ? '' : 'disabled'}>${this.html(dispatchLabel)}</button>
      </section>`;
  }

  timingControlsMarkup() {
    const options = [
      [COORDINATED_DEPLOYMENT_TIMING.LEAD, this.msg('deployment.timingLead', {}, '先導'), this.msg('deployment.timingLeadTitle', {}, '遊撃を先に出し、攻城を後方に置きます。')],
      [COORDINATED_DEPLOYMENT_TIMING.SYNCHRONIZED, this.msg('deployment.timingSynchronized', {}, '同時到着'), this.msg('deployment.timingSynchronizedTitle', {}, '遅い部隊を先に出し、到着時刻を寄せます。')],
      [COORDINATED_DEPLOYMENT_TIMING.MANUAL, this.msg('deployment.timingManual', {}, '手動'), this.msg('deployment.timingManualTitle', {}, '部隊種類ごとの遅延を指定します。')]
    ];
    return `<div class="deploymentModeSwitch deploymentTimingSwitch" role="group" aria-label="${this.htmlMsg('deployment.timingAria', {}, '連携出撃タイミング')}">${options.map(([mode, label, title]) => `<button data-action="coord-timing" data-mode="${mode}" class="${this.coordinatedTimingMode === mode ? 'selected' : ''}" title="${this.html(title)}">${this.html(label)}</button>`).join('')}</div>`;
  }

  manualDelayControlsMarkup() {
    if (this.coordinatedTimingMode !== COORDINATED_DEPLOYMENT_TIMING.MANUAL) return '';
    return `<div class="formationAssignments manualDelayList">${this.availableTypes().filter(type => (this.groupCounts[type] ?? 0) > 0).map(type => {
      const definition = FRIENDLY_SQUAD_DEFINITIONS[type];
      return `<div><strong>${this.html(this.localize(definition.name))}</strong><span class="squadCountControl"><button data-action="delay-minus" data-squad-type="${this.html(type)}">−5</button><b>${this.htmlMsg('deployment.delaySeconds', { seconds: this.manualDelayFor(type) }, '{seconds}秒')}</b><button data-action="delay-plus" data-squad-type="${this.html(type)}">＋5</button></span></div>`;
    }).join('')}</div>`;
  }

  coordinatedDeploymentMarkup(state) {
    const squadTypes = this.groupSquadTypes();
    const maximum = friendlyCoordinatedDeploymentLimit(state);
    const globalCommand = friendlyGlobalCommandStatus(state);
    const preview = this.system.previewCoordinatedDeployment(state, this.targetId, squadTypes, this.coordinatedOptions());
    const selectedRoute = this.selectedRoutePlan?.route ?? null;
    const routePlannerAvailable = Boolean(squadTypes.length >= 2 && preview.origin && this.currentTarget(state)?.nodeId && typeof this.beginRoutePlanning === 'function');
    const routeLabel = selectedRoute
      ? this.msg('deployment.selectedRouteSummary', { routeLabel: this.localize(selectedRoute.label), distance: this.routeText(selectedRoute.physicalDistance), risk: selectedRoute.risk, waypoints: this.selectedRoutePlan.waypointNodeIds.length }, '{routeLabel}・{distance}・危険度 {risk}・経由 {waypoints}/2')
      : preview.commonRouteDistance ? this.msg('deployment.autoCommonRoute', { distance: this.routeText(preview.commonRouteDistance) }, '自動共通・{distance}') : this.msg('deployment.undecided', {}, '未決定');
    const assignments = (preview.assignments ?? []).map(assignment => `<li><strong>${this.html(this.localize(assignment.definition.name))}</strong><span>${this.html(this.msg('deployment.assignmentSummary', { role: this.localize(assignment.formationRole ?? this.msg('deployment.mainForce', {}, '本隊')), originName: assignment.origin.name, distance: this.routeText(assignment.routeDistance), delay: this.durationText(assignment.departDelay) }, '{role}・{originName}・共通{distance}・待機 {delay}'))}</span></li>`).join('');
    const previewNote = preview.ok
      ? selectedRoute
        ? this.msg('deployment.selectedCommonRouteNote', {}, '選択した共通経路で全連携部隊が進軍します。タイミングだけを変更しても経路は維持されます。')
        : this.msg('deployment.autoCommonRouteNote', {}, '自動共通経路で出撃できます。必要ならMAPで経由地点を指定してから連携出撃してください。')
      : this.localize(preview.reason);
    return `<section><h2>${this.htmlMsg('deployment.coordinatedFormationHeading', {}, '連携編成')} <small>${this.htmlMsg('deployment.coordinatedCountSmall', { count: squadTypes.length, maximum, assigned: globalCommand.assigned, capacity: globalCommand.capacity }, '{count}/{maximum}部隊・全体指揮 {assigned}/{capacity}')}</small></h2><p class="sectionNote">${this.htmlMsg('deployment.coordinatedIntro', {}, '連携出撃は、同じ拠点から同じルートで進軍します。出撃前にMAP上で共通経路を指定できます。')}</p><div class="deploymentGrid coordinatedUnitGrid">${this.groupCardsMarkup(state)}</div></section>
      <section class="deploymentOrder coordinatedOrder"><h2>${this.htmlMsg('deployment.marchMethodHeading', {}, '進軍方式')}</h2>
        <div class="contextMetricGrid"><span><small>${this.htmlChrome('route', 'ROUTE')}</small><strong>${this.html(routeLabel)}</strong></span><span><small>${this.htmlChrome('origin', 'ORIGIN')}</small><strong>${this.html(preview.origin?.name ?? '—')}</strong></span><span><small>${this.htmlChrome('timing', 'TIMING')}</small><strong>${this.html(this.localize(preview.timingLabel ?? this.msg('deployment.timingLead', {}, '先導')))}</strong></span><span><small>${this.htmlChrome('arrival', 'ARRIVAL')}</small><strong>${this.html(this.durationText(preview.estimatedArrivalSeconds))}</strong></span></div>
        <button class="wideButton" data-action="plan-coordinated-route" ${routePlannerAvailable ? '' : 'disabled'}>${this.htmlMsg(selectedRoute ? 'deployment.buttonChangeCoordinatedRoute' : 'deployment.buttonPlanCoordinatedRoute', {}, selectedRoute ? '連携経路を変更' : 'MAPで連携経路を指定')}</button>
        ${this.timingControlsMarkup()}
        ${this.manualDelayControlsMarkup()}
        ${assignments ? `<ol class="formationAssignments">${assignments}</ol>` : ''}
        <p class="sectionNote">${this.html(previewNote)}</p>
        <div class="contextMetricGrid"><span><small>${this.htmlChrome('unit', 'SQUADS')}</small><strong>${squadTypes.length}</strong></span><span><small>${this.htmlChrome('cost', 'COST')}</small><strong>${this.html(this.bundleText(preview.cost ?? {}))}</strong></span></div>
        <button class="primary wideButton" data-action="dispatch-group" ${preview.ok ? '' : 'disabled'}>${this.htmlMsg('deployment.buttonCoordinatedDispatch', { count: squadTypes.length }, '{count}部隊で連携出撃')}</button>
      </section>`;
  }

  render(state = uiViewState(this.store)) {
    this.lastRenderAt = Date.now();
    this.normalizeSelection(state);
    const target = this.currentTarget(state);
    if (!target) return;
    const recoveryMission = this.missionKind === MISSION_KIND.RECOVERY;
    const interceptMission = this.missionKind === MISSION_KIND.INTERCEPT;
    if (recoveryMission || interceptMission || !hasCivilizationAbility(state, CIVILIZATION_ABILITY.COORDINATED_DISPATCH)) this.mode = DEPLOYMENT_MODE.SINGLE;
    this.title.textContent = recoveryMission
      ? this.msg('deployment.titleRecovery', {}, '選択回収物への派遣')
      : interceptMission
        ? this.msg('deployment.titleIntercept', {}, '選択敵部隊への迎撃派兵')
        : this.msg('deployment.titleAttack', {}, '選択敵拠点への派兵');
    const content = this.mode === DEPLOYMENT_MODE.COORDINATED && !recoveryMission && !interceptMission
      ? this.coordinatedDeploymentMarkup(state)
      : this.singleDeploymentMarkup(state);
    this.body.innerHTML = `<section class="deploymentTargetSection"><h2>${this.htmlMsg('deployment.targetHeading', {}, '選択中の目標')}</h2>${this.targetMarkup(target)}</section>${this.modeMarkup()}${content}`;
  }
}
