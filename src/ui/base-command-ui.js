import { distance } from '../core/utilities.js';
import { activePlayerBases, baseLimitForCivilization, playerBaseSlotsUsed } from '../base/player-bases.js';
import {
  activeFieldBases,
  fieldBaseLimitForCivilization,
  fieldBaseSlotsUsed
} from '../base/field-bases.js';
import { enemyPosition } from '../combat/enemy-system.js';
import { defenseWorldPosition } from '../combat/combat-geometry.js';
import { bindDismissibleModal, escapeHtml, queryRequired, setVisible, uiViewState } from './dom.js';
import { bundleText } from '../civilization/inventory-system.js';
import { diagnoseFieldBaseNetwork } from '../base/field-base-system.js';
import { FRIENDLY_SQUAD_DEFINITIONS, friendlySquadCapacityForBase } from '../combat/friendly-force-system.js';
import { friendlySquadLevelBonus, friendlySquadLevelProgress } from '../combat/friendly-force-definitions.js';
import { fieldBaseBuildRange, majorBaseBuildRange } from '../base/construction-range.js';
import { basePressureProfile, basePressureUiText } from '../base/base-pressure.js';
import { regionControlSummaryText, regionLogisticsSummaryText } from '../base/region-control.js';
import { runtimeMessage } from '../i18n/catalog.js';

const BASE_STATUS_RADIUS_METERS = 300;
const FACILITY_RADIUS_METERS = 120;
function localizedLimit(value, i18n = null) {
  if (Number.isFinite(value)) return String(value);
  return messageValue(i18n, 'baseCommand.limitUnlimited', {}, '上限なし');
}

function tabButton(id, label, active) {
  return `<button type="button" data-ui-tab="${id}" class="${active === id ? 'active' : ''}">${label}</button>`;
}

function tabPanel(id, active, html) {
  return `<section class="uiTabPanel ${active === id ? 'active' : ''}" data-panel="${id}">${html}</section>`;
}

function i18nCopy(i18n, text = '') { return i18n?.copy?.(text) ?? String(text ?? ''); }
function i18nBundle(i18n, bundle = {}) { return i18n?.bundleText?.(bundle) ?? bundleText(bundle); }
function languageCode(i18n) { return i18n?.language ?? 'ja'; }
function messageValue(i18n, key, params = {}, fallback = '') {
  return runtimeMessage(languageCode(i18n), key, params, fallback);
}
function htmlMessage(i18n, key, params = {}, fallback = '') {
  return escapeHtml(messageValue(i18n, key, params, fallback));
}
function uiText(i18n, source = '', translations = {}) {
  const language = languageCode(i18n);
  if (language === 'ja') return String(source ?? '');
  return translations[language] ?? i18nCopy(i18n, source);
}

function baseKindName(kind, i18n = null) {
  const field = kind === 'field' || kind === 'FIELD';
  return messageValue(i18n, field ? 'baseCommand.kindField' : 'baseCommand.kindMajor', {}, field ? '簡易拠点' : '主要拠点');
}

function basePressureStageText(profile, i18n = null) {
  const stageKeys = [
    'baseCommand.pressureStageUnrecognized',
    'baseCommand.pressureStageScouting',
    'baseCommand.pressureStageMinor',
    'baseCommand.pressureStageExpanding',
    'baseCommand.pressureStageFull'
  ];
  const key = stageKeys[Math.max(0, Math.min(stageKeys.length - 1, Number(profile?.stage) || 0))];
  return messageValue(i18n, key, {}, profile?.stageLabel ?? '不明');
}

function localizedBasePressureText(profile, i18n = null) {
  if (!profile) return messageValue(i18n, 'baseCommand.pressureUnknown', {}, '敵圧 不明');
  if (profile.kind === 'PRIMARY') return messageValue(i18n, 'baseCommand.pressureFull', {}, '敵圧 本格');
  const percent = Math.round(profile.ratio * 100);
  const stage = basePressureStageText(profile, i18n);
  if (profile.mature) return messageValue(i18n, 'baseCommand.pressureStage', { stage, percent }, `敵圧 ${profile.stageLabel}・${percent}%`);
  const hours = Math.max(1, Math.ceil(profile.remainingMs / 3_600_000));
  return messageValue(i18n, 'baseCommand.pressureMaturing', { stage, percent, hours }, `敵圧 ${profile.stageLabel}・${percent}%・本格化まで約${hours}時間`);
}

function squadStatusText(squad, i18n = null) {
  const status = String(squad?.status ?? 'UNKNOWN');
  const table = {
    READY: ['baseCommand.squadStatusReady', '待機'],
    RECOVERING: ['baseCommand.squadStatusRecovering', '再編成'],
    OUTBOUND: ['baseCommand.squadStatusOutbound', '進軍'],
    RETURNING: ['baseCommand.squadStatusReturning', '帰還'],
    ENGAGED: ['baseCommand.squadStatusEngaged', '交戦'],
    ATTACKING_BASE: ['baseCommand.squadStatusAttackingBase', '拠点攻撃'],
    STRANDED: ['baseCommand.squadStatusStranded', '孤立'],
    HALTED: ['baseCommand.squadStatusHalted', '停止']
  };
  const [key, fallback] = table[status] ?? ['baseCommand.squadStatusActive', '活動中'];
  return messageValue(i18n, key, {}, fallback);
}

function squadProgressText(squad, i18n = null) {
  const progress = friendlySquadLevelProgress(squad);
  if (progress.maxed) return messageValue(i18n, 'baseCommand.squadProgressMax', { level: progress.level }, `Lv.${progress.level} MAX`);
  return messageValue(i18n, 'baseCommand.squadProgress', {
    level: progress.level,
    xp: progress.xp,
    next: progress.nextXp,
    remain: progress.remainingXp
  }, `Lv.${progress.level} XP ${progress.xp}/${progress.nextXp}・次まで${progress.remainingXp}`);
}

function squadBonusText(squad, i18n = null) {
  const progress = friendlySquadLevelProgress(squad);
  const bonus = friendlySquadLevelBonus(squad?.type, progress.level);
  return messageValue(i18n, 'baseCommand.squadBonusSummary', bonus, `HP +${bonus.hp}% / 攻撃 +${bonus.damage}% / 速度 +${bonus.speed}% / 被害 -${bonus.mitigation}%`);
}

function baseSquadRosterMarkup(state, base, i18n = null) {
  const squads = (state.combat?.friendlySquads ?? [])
    .filter(squad => squad.originBaseId === base.id && squad.hp > 0)
    .sort((a, b) => (b.unitLevel ?? 1) - (a.unitLevel ?? 1) || (b.unitXp ?? 0) - (a.unitXp ?? 0) || String(a.id).localeCompare(String(b.id)));
  const title = htmlMessage(i18n, 'baseCommand.squadRosterTitle', {}, '所属部隊の成長');
  if (!squads.length) {
    return `<div class="baseSquadRoster"><strong>${title}</strong><p class="sectionNote">${htmlMessage(i18n, 'baseCommand.noSquadRoster', {}, 'この拠点にはまだ部隊がありません。')}</p></div>`;
  }
  const rows = squads.slice(0, 3).map(squad => {
    const definition = FRIENDLY_SQUAD_DEFINITIONS[squad.type] ?? FRIENDLY_SQUAD_DEFINITIONS.assault;
    return `<div class="baseSquadRow"><span><b>${escapeHtml(i18nCopy(i18n, definition.name))}</b><small>${escapeHtml(squadStatusText(squad, i18n))} · HP ${Math.ceil(Number(squad.hp) || 0)}/${Math.ceil(Number(squad.maxHp) || 1)}</small></span><span><b>${escapeHtml(squadProgressText(squad, i18n))}</b><small>${escapeHtml(squadBonusText(squad, i18n))}</small></span></div>`;
  }).join('');
  const overflow = squads.length > 3
    ? `<p class="sectionNote">${htmlMessage(i18n, 'baseCommand.squadRosterOverflow', { count: squads.length - 3 }, `ほか${squads.length - 3}部隊`)}</p>`
    : '';
  return `<div class="baseSquadRoster"><strong>${title}</strong>${rows}${overflow}</div>`;
}

function localizedPlacementReason(i18n, reason = '') {
  if (reason && typeof reason === 'object') {
    if (reason.reasonKey) return messageValue(i18n, reason.reasonKey, reason.reasonParams ?? {}, reason.reason ?? '');
    if (reason.key) return messageValue(i18n, reason.key, reason.params ?? {}, reason.text ?? reason.fallback ?? '');
    reason = reason.reason ?? '';
  }
  const text = String(reason ?? '');
  if (!text) return '';
  return uiText(i18n, text);
}


function localizedDiagnosticGuidance(i18n, text = '') {
  const value = String(text ?? '');
  if (!value) return '';
  return uiText(i18n, value);
}


function defensePoint(state, defense) {
  return defenseWorldPosition(state.world.roadGraph, defense);
}


export function summarizePlayerBase(state, base) {
  const nearbyEnemies = (state.combat.enemies ?? []).filter(enemy => enemy.hp > 0 && distance(base, enemyPosition(state, enemy)) <= BASE_STATUS_RADIUS_METERS).length;
  const facilities = (state.combat.defenses ?? []).filter(defense => defense.hp > 0 && (() => {
    const point = defensePoint(state, defense);
    return point && distance(base, point) <= FACILITY_RADIUS_METERS;
  })()).length;
  const baseSquads = (state.combat.friendlySquads ?? []).filter(squad => squad.originBaseId === base.id && squad.hp > 0);
  const recoveringSquads = baseSquads.filter(squad => squad.status === 'RECOVERING').length;
  const readySquads = baseSquads.filter(squad => squad.status === 'READY').length;
  const activeSquads = baseSquads.length - recoveringSquads - readySquads;
  const squads = baseSquads.length;
  const squadCapacity = friendlySquadCapacityForBase(state, base);
  const recoveryItems = (state.world.recoveryItems ?? []).filter(item => item.status === 'AVAILABLE' && distance(base, state.world.roadGraph?.nodeById?.get(item.nodeId) ?? item) <= BASE_STATUS_RADIUS_METERS).length;
  return {
    nearbyEnemies,
    facilities,
    squads,
    squadCapacity,
    activeSquads,
    recoveringSquads,
    readySquads,
    recoveryItems,
    alert: base.status === 'DESTROYED' || base.hp <= 0
      ? 'DESTROYED'
      : nearbyEnemies > 0
        ? 'ENGAGED'
        : recoveryItems > 0
          ? 'RECOVERY'
          : 'STABLE'
  };
}

function baseAlertText(alert, i18n = null) {
  const key = {
    DESTROYED: 'baseCommand.alertDestroyed',
    ENGAGED: 'baseCommand.alertEngaged',
    RECOVERY: 'baseCommand.alertRecovery',
    STABLE: 'baseCommand.alertStable'
  }[alert] ?? 'baseCommand.alertStable';
  const fallback = {
    DESTROYED: '破壊',
    ENGAGED: '交戦警戒',
    RECOVERY: '回収物あり',
    STABLE: '安定'
  }[alert] ?? '安定';
  return messageValue(i18n, key, {}, fallback);
}

function baseCard(state, base, { selected, label, field = false, rebuild = null, rebuildKind = null, dismantle = null, dismantleKind = null, i18n = null }) {
  const status = summarizePlayerBase(state, base);
  const destroyed = base.status === 'DESTROYED' || base.hp <= 0;
  const pressure = basePressureProfile(state, base, field ? 'FIELD' : base.primary ? 'PRIMARY' : 'MAJOR');
  const m = (key, params = {}, fallback = '') => messageValue(i18n, key, params, fallback);
  const h = (key, params = {}, fallback = '') => htmlMessage(i18n, key, params, fallback);
  const baseName = escapeHtml(i18nCopy(i18n, base.name));
  const baseId = escapeHtml(base.id);
  const targetCap = pressure.kind === 'PRIMARY' ? localizedLimit(Infinity, i18n) : pressure.targetCap;
  const fieldRange = fieldBaseBuildRange(state.civilization?.level);
  const fieldRangeNote = field
    ? `<p class="sectionNote">${h('baseCommand.fieldRangeNote', { range: fieldRange }, `建設範囲${fieldRange}m。突撃／遊撃／回収部隊を派兵できます。`)}</p>`
    : '';
  const pressureNotice = h('baseCommand.pressureNotice', {
    pressure: localizedBasePressureText(pressure, i18n),
    targetCap
  }, `${basePressureUiText(pressure)}・同時標的上限 ${targetCap}`);
  const squadNotice = h('baseCommand.squadNotice', {
    active: status.activeSquads,
    recovering: status.recoveringSquads,
    ready: status.readySquads
  }, `派兵中 ${status.activeSquads}・回復中 ${status.recoveringSquads}・再出撃待機 ${status.readySquads}`);
  const regionNotice = escapeHtml(regionControlSummaryText(state, base, i18n));
  const logisticsNotice = escapeHtml(regionLogisticsSummaryText(state, base, i18n));
  const recoveryNotice = status.recoveryItems
    ? `<p class="baseRecoveryNotice">${h('baseCommand.recoveryNotice', { count: status.recoveryItems }, `周辺に未回収アイテム ${status.recoveryItems}`)}</p>`
    : '';
  const squadRoster = baseSquadRosterMarkup(state, base, i18n);
  const focusLabel = h('baseCommand.focusMap', {}, 'この拠点をMAP表示');
  const rebuildHtml = destroyed && rebuildKind ? (() => {
    const kind = baseKindName(rebuildKind, i18n);
    const button = h('baseCommand.rebuildOnSite', { kind }, `現地で${kind}を再建`);
    const reason = rebuild?.ok
      ? h('baseCommand.rebuildReady', {}, '現在地から再建できます。')
      : escapeHtml(localizedPlacementReason(i18n, rebuild ?? m('baseCommand.rebuildMoveOnSite', {}, '現地へ移動してください。')));
    return `<button class="secondary wideButton" data-action="rebuild-${rebuildKind}-base" data-base-id="${baseId}" ${rebuild?.ok ? '' : 'disabled'}>${button}</button><p class="sectionNote">${h('baseCommand.cost', {}, '費用')} ${escapeHtml(i18nBundle(i18n, rebuild?.cost))} · ${reason}</p>`;
  })() : '';
  const dismantleHtml = dismantleKind ? (() => {
    const kind = baseKindName(dismantleKind, i18n);
    const button = h('baseCommand.dismantle', { kind }, `${kind}を撤去`);
    const reason = dismantle?.ok
      ? h('baseCommand.dismantleNotice', {}, '撤去すると拠点枠を空け、この拠点に所属・待機中の部隊は解散します。対象中の敵は残存拠点へ再割当します。')
      : escapeHtml(localizedPlacementReason(i18n, dismantle ?? m('baseCommand.dismantleUnavailable', {}, '撤去できません。')));
    return `<button class="secondary wideButton danger" data-action="dismantle-${dismantleKind}-base" data-base-id="${baseId}" ${dismantle?.ok ? '' : 'disabled'}>${button}</button><p class="sectionNote">${reason}</p>`;
  })() : '';
  return `<article class="baseCommandCard ${selected ? 'selected' : ''} ${destroyed ? 'destroyed' : ''}">
    <header><div><small>${escapeHtml(label)}</small><strong>${baseName}</strong></div><span data-alert="${destroyed || status.nearbyEnemies > 0 ? 'danger' : 'clear'}">${escapeHtml(baseAlertText(status.alert, i18n))}</span></header>
    <div class="contextMetricGrid"><span><small>HP</small><b>${Math.ceil(base.hp)}/${base.maxHp}</b></span><span><small>ENEMY</small><b>${status.nearbyEnemies}</b></span><span><small>DEF</small><b>${status.facilities}</b></span><span><small>SQUAD</small><b>${status.squads}/${status.squadCapacity}</b></span><span><small>PRESS</small><b>${Math.round(pressure.ratio * 100)}%</b></span></div>
    ${fieldRangeNote}
    <p class="basePressureNotice">${pressureNotice}</p>
    <p class="basePressureNotice">${regionNotice}</p>
    <p class="baseSquadNotice">${logisticsNotice}</p>
    <p class="baseSquadNotice">${squadNotice}</p>
    ${squadRoster}
    ${recoveryNotice}
    <button class="primary wideButton" data-action="focus-base" data-base-id="${baseId}" data-base-kind="${field ? 'field' : 'major'}">${focusLabel}</button>
    ${rebuildHtml}
    ${dismantleHtml}
  </article>`;
}


export class BaseCommandUi {
  constructor({ store, playerBaseSystem, fieldBaseSystem = null, commandBus = null, renderer, notifications, persist, i18n = null }) {
    this.store = store;
    this.system = playerBaseSystem;
    this.fieldSystem = fieldBaseSystem;
    this.commandBus = commandBus;
    this.renderer = renderer;
    this.notifications = notifications;
    this.persist = persist;
    this.i18n = i18n;
    this.panel = queryRequired('#baseCommandPanel');
    this.body = queryRequired('#baseCommandBody');
    this.summary = queryRequired('#baseSummary');
    this.focusedBaseId = null;
    this.focusedBaseKind = 'major';
    this.lastRenderAt = 0;
    this.activeTab = 'overview';
    queryRequired('#baseCommandButton').addEventListener('click', () => this.open());
    queryRequired('#closeBaseCommand').addEventListener('click', () => this.close());
    bindDismissibleModal(this.panel, () => this.close());
    this.body.addEventListener('click', event => this.handleAction(event));
  }

  localize(text = '') { return this.i18n?.copy?.(text) ?? text; }

  msg(key, params = {}, fallback = '') { return messageValue(this.i18n, key, params, fallback); }

  messagePayload(key, params = {}, fallback = '') { return { key, params, text: fallback }; }

  htmlMsg(key, params = {}, fallback = '') { return htmlMessage(this.i18n, key, params, fallback); }

  notify(key, params = {}, fallback = '') { this.notifications.show(this.messagePayload(key, params, fallback)); }

  reasonPayload(result, key, fallback = '') {
    if (result?.reasonKey) return this.messagePayload(result.reasonKey, result.reasonParams ?? {}, result.reason ?? fallback);
    if (result?.key) return this.messagePayload(result.key, result.params ?? {}, result.text ?? result.fallback ?? fallback);
    return this.messagePayload(key, {}, result?.reason ?? fallback);
  }

  notifyFailure(result, key, fallback = '') { this.notifications.show(this.reasonPayload(result, key, fallback)); }

  availableBases(state) {
    return [...(state.world?.playerBases ?? []), ...(state.world?.fieldBases ?? [])];
  }

  open() {
    const state = uiViewState(this.store);
    const bases = this.availableBases(state);
    if (!bases.some(base => base.id === this.focusedBaseId)) {
      this.focusedBaseId = bases[0]?.id ?? null;
      this.focusedBaseKind = 'major';
    }
    this.render(state);
    setVisible(this.panel, true);
  }

  close() { setVisible(this.panel, false); }

  selectedBase(state = uiViewState(this.store)) {
    const bases = this.availableBases(state);
    return bases.find(base => base.id === this.focusedBaseId) ?? bases[0] ?? null;
  }

  focusCurrentBase(state = uiViewState(this.store)) {
    const base = this.selectedBase(state);
    if (!base) return false;
    this.focusedBaseId = base.id;
    this.focusedBaseKind = base.kind === 'FIELD' ? 'field' : 'major';
    this.renderer.centerOn(base, 0.9);
    this.updateSummary(state);
    return true;
  }

  update(state = uiViewState(this.store)) {
    this.updateSummary(state);
    if (!this.panel.hidden && Date.now() - this.lastRenderAt >= 1000) this.render(state);
  }

  updateSummary(state = uiViewState(this.store)) {
    const major = activePlayerBases(state);
    const majorSlots = playerBaseSlotsUsed(state);
    const field = state.world?.fieldBases ?? [];
    const focused = [...major, ...field].find(base => base.id === this.focusedBaseId);
    const damagedDefenses = (state.combat?.defenses ?? []).filter(defense => defense.hp > 0 && defense.hp < defense.maxHp).length;
    const damagedBuildings = (state.civilization?.buildings ?? []).filter(building => building.hp > 0 && building.hp < building.maxHp).length;
    const repairCount = damagedDefenses + damagedBuildings;
    const majorLimit = localizedLimit(baseLimitForCivilization(state.civilization?.level), this.i18n);
    const fieldLimit = localizedLimit(fieldBaseLimitForCivilization(state.civilization?.level), this.i18n);
    const focusedName = focused ? i18nCopy(this.i18n, focused.name) : '';
    const separator = this.msg('baseCommand.inlineSeparator', {}, '・');
    const summaryParts = [
      this.msg('baseCommand.summaryMajor', { majorActive: major.length, majorSlots, majorLimit }, `主要 ${major.length}稼働・${majorSlots}/${majorLimit}`),
      this.msg('baseCommand.summaryField', { fieldSlots: fieldBaseSlotsUsed(state), fieldLimit }, `簡易 ${fieldBaseSlotsUsed(state)}/${fieldLimit}`)
    ];
    if (repairCount) summaryParts.push(this.msg('baseCommand.summaryRepairs', { repairCount }, `要修理 ${repairCount}`));
    if (focused) summaryParts.push(this.msg('baseCommand.summaryFocused', { focusedName }, `表示 ${focusedName}`));
    this.summary.textContent = summaryParts.join(separator);
    this.summary.classList?.toggle('has-repairs', repairCount > 0);
  }

  handleAction(event) {
    const tabButton = event.target.closest('button[data-ui-tab]');
    if (tabButton?.dataset?.uiTab) {
      this.activeTab = tabButton.dataset.uiTab || 'overview';
      this.render();
      return;
    }
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, baseId, baseKind } = button.dataset;
    if (action === 'focus-base') {
      const state = uiViewState(this.store);
      const pool = baseKind === 'field' ? (state.world?.fieldBases ?? []) : (state.world?.playerBases ?? []);
      const base = pool.find(value => value.id === baseId);
      if (!base) return;
      this.focusedBaseId = base.id;
      this.focusedBaseKind = baseKind ?? 'major';
      this.focusCurrentBase(state);
      this.close();
      return;
    }
    if (action === 'establish-base') {
      const result = this.commandBus?.execute('base.establishMajor') ?? { ok: false, reason: 'Command bus is unavailable.' };
      if (!result?.ok) this.notifyFailure(result, 'baseCommand.establishMajorFailed', '拠点を設置できません。');
      else {
        this.focusedBaseId = result.base.id;
        this.focusedBaseKind = 'major';
        this.renderer.invalidateStatic();
        this.renderer.render();
        this.notify('baseCommand.established', { baseName: result.base.name }, `${result.base.name}を設置しました。`);
        this.persist?.();
      }
      this.render();
      return;
    }
    if (action === 'establish-field-base') {
      if (!this.fieldSystem) return;
      const result = this.commandBus?.execute('base.establishField') ?? { ok: false, reason: 'Command bus is unavailable.' };
      if (!result?.ok) this.notifyFailure(result, 'baseCommand.establishFieldFailed', '簡易拠点を設置できません。');
      else {
        this.focusedBaseId = result.base.id;
        this.focusedBaseKind = 'field';
        this.renderer.invalidateStatic();
        this.renderer.render();
        this.notify('baseCommand.established', { baseName: result.base.name }, `${result.base.name}を設置しました。`);
        this.persist?.();
      }
      this.render();
      return;
    }
    if (action === 'rebuild-major-base') {
      const result = this.commandBus?.execute('base.rebuildMajor', { baseId }) ?? { ok: false, reason: 'Command bus is unavailable.' };
      if (!result?.ok) this.notifyFailure(result, 'baseCommand.rebuildMajorFailed', '主要拠点を再建できません。');
      else {
        this.renderer.invalidateStatic();
        this.renderer.render();
        this.notify('baseCommand.rebuilt', { baseName: result.base.name }, `${result.base.name}を再建しました。`);
        this.persist?.();
      }
      this.render();
      return;
    }
    if (action === 'rebuild-field-base') {
      if (!this.fieldSystem) return;
      const result = this.commandBus?.execute('base.rebuildField', { baseId }) ?? { ok: false, reason: 'Command bus is unavailable.' };
      if (!result?.ok) this.notifyFailure(result, 'baseCommand.rebuildFieldFailed', '簡易拠点を再建できません。');
      else {
        this.renderer.invalidateStatic();
        this.renderer.render();
        this.notify('baseCommand.rebuilt', { baseName: result.base.name }, `${result.base.name}を再建しました。`);
        this.persist?.();
      }
      this.render();
      return;
    }
    if (action === 'dismantle-major-base') {
      const result = this.commandBus?.execute('base.dismantleMajor', { baseId }) ?? { ok: false, reason: 'Command bus is unavailable.' };
      if (!result?.ok) this.notifyFailure(result, 'baseCommand.dismantleMajorFailed', '主要拠点を撤去できません。');
      else {
        const state = uiViewState(this.store);
        this.focusedBaseId = (state.world?.playerBases ?? [])[0]?.id ?? (state.world?.fieldBases ?? [])[0]?.id ?? null;
        this.focusedBaseKind = 'major';
        this.renderer.invalidateStatic();
        this.renderer.render();
        this.notify('baseCommand.dismantled', { baseName: result.base.name }, `${result.base.name}を撤去しました。`);
        this.persist?.();
      }
      this.render();
      return;
    }
    if (action === 'dismantle-field-base') {
      if (!this.fieldSystem) return;
      const result = this.commandBus?.execute('base.dismantleField', { baseId }) ?? { ok: false, reason: 'Command bus is unavailable.' };
      if (!result?.ok) this.notifyFailure(result, 'baseCommand.dismantleFieldFailed', '簡易拠点を撤去できません。');
      else {
        const state = uiViewState(this.store);
        this.focusedBaseId = (state.world?.playerBases ?? [])[0]?.id ?? (state.world?.fieldBases ?? [])[0]?.id ?? null;
        this.focusedBaseKind = 'major';
        this.renderer.invalidateStatic();
        this.renderer.render();
        this.notify('baseCommand.dismantled', { baseName: result.base.name }, `${result.base.name}を撤去しました。`);
        this.persist?.();
      }
      this.render();
    }
  }

  render(state = uiViewState(this.store)) {
    this.lastRenderAt = Date.now();
    const h = (key, params = {}, fallback = '') => this.htmlMsg(key, params, fallback);
    const majorBases = state.world?.playerBases ?? [];
    const fieldBases = state.world?.fieldBases ?? [];
    const majorLimit = baseLimitForCivilization(state.civilization?.level);
    const fieldLimit = fieldBaseLimitForCivilization(state.civilization?.level);
    const all = [...majorBases, ...fieldBases];
    if (!all.some(base => base.id === this.focusedBaseId)) this.focusedBaseId = majorBases[0]?.id ?? fieldBases[0]?.id ?? null;

    const majorPlacement = this.system.previewCurrentLocation(state);
    const fieldPlacement = this.fieldSystem?.previewCurrentLocation(state) ?? { ok: false, reason: this.msg('baseCommand.fieldSystemUnavailable', {}, '簡易拠点システムを利用できません。') };
    const fieldDiagnostic = diagnoseFieldBaseNetwork(state, Math.min(3, fieldLimit));
    const majorCards = majorBases.map((base, index) => baseCard(state, base, {
      selected: base.id === this.focusedBaseId,
      label: index === 0 ? 'PRIMARY' : `MAJOR ${String(index + 1).padStart(2, '0')}`,
      rebuild: base.status === 'DESTROYED' ? this.system.previewRebuild(state, base.id) : null,
      rebuildKind: base.primary ? null : 'major',
      dismantle: this.system.previewDismantle(state, base.id),
      dismantleKind: base.primary ? null : 'major',
      i18n: this.i18n
    })).join('') || `<p class="emptyText">${h('baseCommand.emptyMajor', {}, '稼働中の主要拠点がありません。')}</p>`;
    const fieldCards = fieldBases.map((base, index) => baseCard(state, base, {
      selected: base.id === this.focusedBaseId,
      label: `FIELD ${String(index + 1).padStart(2, '0')}`,
      field: true,
      rebuild: base.status === 'DESTROYED' ? this.fieldSystem?.previewRebuild(state, base.id) : null,
      rebuildKind: 'field',
      dismantle: this.fieldSystem?.previewDismantle(state, base.id),
      dismantleKind: 'field',
      i18n: this.i18n
    })).join('') || `<p class="emptyText">${h('baseCommand.emptyField', {}, '簡易拠点はまだありません。')}</p>`;

    const active = ['overview', 'major', 'field', 'build'].includes(this.activeTab) ? this.activeTab : 'overview';
    const majorLimitText = localizedLimit(majorLimit, this.i18n);
    const fieldLimitText = localizedLimit(fieldLimit, this.i18n);
    const majorSlotsPerBase = friendlySquadCapacityForBase(state, { kind: 'MAJOR' });
    const fieldSlotsPerBase = friendlySquadCapacityForBase(state, { kind: 'FIELD' });
    const buildMajorCost = escapeHtml(i18nBundle(this.i18n, majorPlacement.cost));
    const buildFieldCost = escapeHtml(i18nBundle(this.i18n, fieldPlacement.cost));
    const majorDistance = Math.round(majorPlacement.distanceToRoad ?? 0);
    const fieldDistance = Math.round(fieldPlacement.distanceToRoad ?? 0);
    const majorBuildStatus = majorPlacement.ok
      ? h('baseCommand.buildAvailable', { distance: majorDistance }, `設置可能・道路まで約${majorDistance}m`)
      : escapeHtml(localizedPlacementReason(this.i18n, majorPlacement.reason));
    const fieldBuildStatus = fieldPlacement.ok
      ? h('baseCommand.buildAvailable', { distance: fieldDistance }, `設置可能・道路まで約${fieldDistance}m`)
      : escapeHtml(localizedPlacementReason(this.i18n, fieldPlacement.reason));
    const fieldDiagnosticTitle = h('baseCommand.fieldDiagnosticTitle', {
      active: fieldDiagnostic.active,
      required: fieldDiagnostic.required
    }, `道路網診断：${fieldDiagnostic.active}/${fieldDiagnostic.required}基稼働`);
    const fieldDiagnosticDetail = h('baseCommand.fieldDiagnosticDetail', {
      confirmedAdditional: fieldDiagnostic.confirmedAdditional,
      destroyed: fieldDiagnostic.destroyed
    }, `追加候補 ${fieldDiagnostic.confirmedAdditional}基・破壊済み ${fieldDiagnostic.destroyed}基`);
    const majorRange = majorBaseBuildRange(state.civilization?.level);

    this.body.innerHTML = `<div class="uiTabBar" role="tablist" aria-label="${h('baseCommand.tabAria', {}, '拠点画面の表示切替')}">
        ${tabButton('overview', h('baseCommand.tabOverview', {}, '概要'), active)}
        ${tabButton('major', h('baseCommand.tabMajor', {}, '主要'), active)}
        ${tabButton('field', h('baseCommand.tabField', {}, '簡易'), active)}
        ${tabButton('build', h('baseCommand.tabBuild', {}, '建設'), active)}
      </div>
      <section class="overviewHero baseHero">
        <div><small>${h('baseCommand.majorBasesLabel', {}, '主要拠点')}</small><strong>${majorBases.length}/${escapeHtml(majorLimitText)}</strong><span>${h('baseCommand.squadSlotsEach', { count: majorSlotsPerBase }, `各 ${majorSlotsPerBase}部隊枠`)}</span></div>
        <div><small>${h('baseCommand.simpleBasesLabel', {}, '簡易拠点')}</small><strong>${fieldBaseSlotsUsed(state)}/${escapeHtml(fieldLimitText)}</strong><span>${h('baseCommand.squadSlotsEach', { count: fieldSlotsPerBase }, `各 ${fieldSlotsPerBase}部隊枠`)}</span></div>
        <div><small>${h('baseCommand.civilizationLabel', {}, '文明')}</small><strong>Lv.${state.civilization.level}</strong><span>${h('baseCommand.growthNote', {}, '発展で拠点・部隊枠が増加')}</span></div>
      </section>
      ${tabPanel('overview', active, `<h2>${h('baseCommand.overviewTitle', {}, '拠点概要')}</h2><div class="baseCommandGrid compactBaseGrid">${majorCards}${fieldCards}</div>`)}
      ${tabPanel('major', active, `<h2>${h('baseCommand.majorTitle', {}, '主要拠点')}</h2><p class="sectionNote">${h('baseCommand.majorNote', {}, 'すべての部隊を派兵できる中核拠点です。主要拠点は最低1つを残し、それ以外は撤去できます。')}</p><div class="baseCommandGrid">${majorCards}</div>`)}
      ${tabPanel('field', active, `<h2>${h('baseCommand.fieldTitle', {}, '簡易拠点')}</h2><p class="sectionNote">${h('baseCommand.fieldNote', {}, '突撃部隊・遊撃部隊・回収部隊の前線運用に使います。不要な簡易拠点は撤去できます。')}</p><div class="baseCommandGrid">${fieldCards}</div>`)}
      ${tabPanel('build', active, `<h2>${h('baseCommand.buildMajorTitle', {}, '現在地に主要拠点')}</h2><div class="baseEstablishSection"><p class="sectionNote">${h('baseCommand.majorBuildRangeNote', { range: majorRange }, `建設範囲${majorRange}m。すべての部隊を派兵できます。`)}</p><button class="primary wideButton" data-action="establish-base" ${majorPlacement.ok ? '' : 'disabled'}>${h('baseCommand.placeMajor', {}, '現在地に主要拠点を設置')}</button><p class="sectionNote">${h('baseCommand.cost', {}, '費用')} ${buildMajorCost} · ${majorBuildStatus}</p></div><h2>${h('baseCommand.buildSimpleTitle', {}, '現在地に簡易拠点')}</h2><div class="baseEstablishSection"><p class="sectionNote">${h('baseCommand.fieldUnlockNote', {}, '文明Lv.1で解禁。取得済み道路の交差点から100m以内で設置できます。')}</p><div class="fieldBaseDiagnostic ${fieldDiagnostic.sufficient ? 'is-sufficient' : 'is-insufficient'}"><strong>${fieldDiagnosticTitle}</strong><span>${fieldDiagnosticDetail}</span><small>${escapeHtml(localizedDiagnosticGuidance(this.i18n, fieldDiagnostic.guidance))}</small></div><button class="primary wideButton" data-action="establish-field-base" ${fieldPlacement.ok ? '' : 'disabled'}>${h('baseCommand.placeField', {}, '現在地に簡易拠点を設置')}</button><p class="sectionNote">${h('baseCommand.cost', {}, '費用')} ${buildFieldCost} · ${fieldBuildStatus}</p></div>`)}
    `;
    this.i18n?.localizeElement?.(this.body);
    this.updateSummary(state);
  }


}
