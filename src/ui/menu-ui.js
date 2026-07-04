import { bindDismissibleModal, queryRequired, setVisible, uiViewState } from './dom.js';
import { buildOperationGuidance, renderOperationGuidance } from './operation-guidance.js';
import { SUPPORTED_LANGUAGES, languageMeta, nextLanguageCode } from '../i18n/catalog.js';
import { FRIENDLY_SQUAD_DEFINITIONS } from '../combat/friendly-force-system.js';
import { friendlySquadLevelBonus, friendlySquadLevelProgress } from '../combat/friendly-force-definitions.js';


const BOOT_LANGUAGE_BADGES = Object.freeze({
  en: 'EN',
  zh: 'ZH',
  'zh-TW': 'TW',
  ko: 'KO',
  vi: 'VI',
  'pt-BR': 'PT',
  tr: 'TR',
  id: 'ID',
  ru: 'RU',
  'es-419': 'ES',
  ja: 'JA'
});

export function bootLanguageBadge(language) {
  const code = language?.code ?? language;
  return BOOT_LANGUAGE_BADGES[code] ?? String(code ?? 'EN').slice(0, 2).toUpperCase();
}

export class MenuUi {
  constructor({ store = null, onSave, onReset, notifications, i18n = null, onLanguageChange = null, onOperationAction = null, confirmImpl = globalThis.confirm?.bind(globalThis) }) {
    this.panel = queryRequired('#menuPanel');
    this.manualSave = queryRequired('#manualSave');
    this.store = store;
    this.i18n = i18n;
    this.onLanguageChange = onLanguageChange;
    this.notifications = notifications;
    this.onOperationAction = onOperationAction;
    this.opsPanel = this.panel.querySelector('#operationGuidanceContent');
    this.recordsPanel = this.panel.querySelector('#recordsContent');
    this.guidePanel = this.panel.querySelector('#menuGuideContent');
    this.languageButtons = this.panel.querySelector('#languageButtons');
    this.bootLanguageButtons = globalThis.document?.querySelector?.('#bootLanguageButtons') ?? null;
    this.confirmImpl = confirmImpl;
    this.activeTab = 'ops';
    queryRequired('#menuButton').addEventListener('click', () => { this.refreshOperations(true); this.renderLocalizedContent(); this.setTab(this.activeTab); setVisible(this.panel, true); });
    queryRequired('#closeMenu').addEventListener('click', () => setVisible(this.panel, false));
    bindDismissibleModal(this.panel, () => setVisible(this.panel, false));
    this.bootLanguageButtons?.addEventListener('click', event => {
      const toggleButton = event.target.closest('button[data-language-toggle]');
      if (toggleButton) this.toggleBootLanguage();
    });
    this.panel.addEventListener('click', event => {
      const operationButton = event.target.closest('button[data-operation-action]');
      if (operationButton) {
        this.handleOperationAction(operationButton);
        return;
      }
      const languageButton = event.target.closest('button[data-language-choice]');
      if (languageButton) {
        this.setLanguage(languageButton.dataset.languageChoice);
        return;
      }
      const button = event.target.closest('button[data-menu-tab]');
      if (button) this.setTab(button.dataset.menuTab || 'guide');
    });
    this.manualSave.addEventListener('click', () => {
      const saved = onSave();
      this.notify(saved ? 'menu.saved' : 'menu.saveFailed', {}, saved ? '現在の状態を保存しました。' : '保存できません。このタブを閉じると進行状況は失われます。');
    });
    queryRequired('#menuReset').addEventListener('click', () => {
      const confirmed = this.confirmImpl ? this.confirmImpl(this.msg('menu.resetConfirm', {}, 'ゲームの進行状況を完全に初期化します。元に戻せません。続行しますか？')) : false;
      if (confirmed) onReset();
    });
    this.renderLocalizedContent();
  }

  t(key, fallback = '') {
    return this.i18n?.t?.(key, fallback) ?? fallback;
  }

  msg(key, params = {}, fallback = '') {
    return this.i18n?.message?.(key, params, fallback) ?? this.t(key, fallback);
  }


  notify(key, params = {}, fallback = '') {
    this.notifications?.show?.({ key, params, text: fallback });
  }

  async setLanguage(language) {
    if (this.i18n?.setLanguageAsync) {
      await this.i18n.setLanguageAsync(language);
    } else {
      this.i18n?.setLanguage?.(language);
    }
    this.onLanguageChange?.(this.i18n?.language ?? language);
    this.renderLocalizedContent();
    this.setSaveAvailable(!this.manualSave.disabled);
    this.notify('language.changed', {}, '表示言語を変更しました。');
  }

  renderLocalizedContent({ applyDocument = false } = {}) {
    if (applyDocument) this.i18n?.apply?.(globalThis.document);
    this.renderGuide();
    this.renderRecordsTabLabel();
    if (this.activeTab === 'records') this.renderRecords(true);
    this.renderLanguageButtons();
  }

  renderGuide() {
    if (!this.guidePanel) return;
    const fragment = globalThis.document.createDocumentFragment();
    const entries = this.i18n?.guideEntries?.() ?? [];
    for (const [index, entry] of entries.entries()) {
      fragment.append(this.createGuideEntry(entry, index));
    }
    this.guidePanel.replaceChildren(fragment);
  }

  renderRecordsTabLabel() {
    const button = this.panel.querySelector('[data-menu-tab="records"]');
    if (button) button.textContent = this.msg('menu.recordsTab', {}, '戦績');
  }

  createMetricCard(labelKey, labelFallback, value, noteKey = '', noteParams = {}, noteFallback = '') {
    const card = globalThis.document.createElement('span');
    const label = globalThis.document.createElement('small');
    const strong = globalThis.document.createElement('b');
    label.textContent = this.msg(labelKey, {}, labelFallback);
    strong.textContent = String(value ?? 0);
    card.append(label, strong);
    if (noteKey || noteFallback) {
      const note = globalThis.document.createElement('em');
      note.textContent = this.msg(noteKey, noteParams, noteFallback);
      card.append(note);
    }
    return card;
  }

  squadStatusText(status) {
    const table = {
      READY: ['menu.recordsStatusReady', '待機'],
      RECOVERING: ['menu.recordsStatusRecovering', '再編成'],
      OUTBOUND: ['menu.recordsStatusOutbound', '進軍'],
      RETURNING: ['menu.recordsStatusReturning', '帰還'],
      ENGAGED: ['menu.recordsStatusEngaged', '交戦'],
      ATTACKING_BASE: ['menu.recordsStatusAttackingBase', '拠点攻撃'],
      STRANDED: ['menu.recordsStatusStranded', '孤立'],
      HALTED: ['menu.recordsStatusHalted', '停止']
    };
    const [key, fallback] = table[String(status ?? '')] ?? ['menu.recordsStatusActive', '活動中'];
    return this.msg(key, {}, fallback);
  }

  squadProgressText(squad) {
    const progress = friendlySquadLevelProgress(squad);
    if (progress.maxed) return this.msg('menu.recordsSquadProgressMax', { level: progress.level }, `Lv.${progress.level} MAX`);
    return this.msg('menu.recordsSquadProgress', {
      level: progress.level,
      xp: progress.xp,
      next: progress.nextXp,
      remain: progress.remainingXp
    }, `Lv.${progress.level} XP ${progress.xp}/${progress.nextXp}・次まで${progress.remainingXp}`);
  }

  squadBonusText(squad) {
    const progress = friendlySquadLevelProgress(squad);
    const bonus = friendlySquadLevelBonus(squad?.type, progress.level);
    return this.msg('menu.recordsSquadBonus', bonus, `HP +${bonus.hp}% / 攻撃 +${bonus.damage}% / 速度 +${bonus.speed}% / 被害 -${bonus.mitigation}%`);
  }

  createSquadRecordCard(squad) {
    const definition = FRIENDLY_SQUAD_DEFINITIONS[squad.type] ?? FRIENDLY_SQUAD_DEFINITIONS.assault;
    const card = globalThis.document.createElement('article');
    card.className = 'recordsSquadCard';
    const header = globalThis.document.createElement('header');
    const title = globalThis.document.createElement('strong');
    const status = globalThis.document.createElement('span');
    title.textContent = this.i18n?.copy?.(definition.name) ?? definition.name;
    status.textContent = this.squadStatusText(squad.status);
    header.append(title, status);
    const progressText = globalThis.document.createElement('p');
    progressText.textContent = this.squadProgressText(squad);
    const bar = globalThis.document.createElement('div');
    bar.className = 'squadProgressBar';
    const fill = globalThis.document.createElement('i');
    const progress = friendlySquadLevelProgress(squad);
    fill.style.width = `${Math.round(progress.progressRatio * 100)}%`;
    bar.append(fill);
    const bonus = globalThis.document.createElement('small');
    bonus.textContent = this.squadBonusText(squad);
    card.append(header, progressText, bar, bonus);
    return card;
  }

  renderRecords(force = false) {
    if (!this.recordsPanel || !this.store) return;
    const now = Date.now();
    if (!force && this.lastRecordsRefreshAt && now - this.lastRecordsRefreshAt < 1500) return;
    this.lastRecordsRefreshAt = now;
    const state = uiViewState(this.store);
    if (!state) {
      const empty = globalThis.document.createElement('p');
      empty.className = 'emptyText';
      empty.textContent = this.msg('menu.recordsUnavailable', {}, '戦績を取得できません。');
      this.recordsPanel.replaceChildren(empty);
      return;
    }
    const statistics = state.statistics ?? {};
    const squads = [...(state.combat?.friendlySquads ?? [])].filter(squad => squad.hp > 0);
    const bestLevel = squads.reduce((best, squad) => Math.max(best, friendlySquadLevelProgress(squad).level), 0);
    const totalXp = squads.reduce((sum, squad) => sum + friendlySquadLevelProgress(squad).xp, 0);
    const fragment = globalThis.document.createDocumentFragment();
    const title = globalThis.document.createElement('h2');
    title.textContent = this.msg('menu.recordsTitle', {}, '戦績');
    const note = globalThis.document.createElement('p');
    note.className = 'sectionNote';
    note.textContent = this.msg('menu.recordsNote', {}, 'オンライン版のランキングに接続しやすいよう、現在の戦績と部隊成長をここへ集約します。');
    const metrics = globalThis.document.createElement('div');
    metrics.className = 'contextMetricGrid recordsMetricGrid';
    metrics.append(
      this.createMetricCard('menu.recordsKills', '撃破', Math.floor(Number(statistics.kills) || 0)),
      this.createMetricCard('menu.recordsCampsCaptured', '拠点攻略', Math.floor(Number(statistics.campsCaptured) || 0)),
      this.createMetricCard('menu.recordsProductionRuns', '生産完了', Math.floor(Number(statistics.productionRuns) || 0)),
      this.createMetricCard('menu.recordsSquads', '所属部隊', squads.length),
      this.createMetricCard('menu.recordsBestLevel', '最高部隊Lv', bestLevel || '—'),
      this.createMetricCard('menu.recordsTotalXp', '累計部隊XP', totalXp)
    );
    const squadTitle = globalThis.document.createElement('h3');
    squadTitle.textContent = this.msg('menu.recordsSquadTitle', {}, '部隊成長');
    const squadGrid = globalThis.document.createElement('div');
    squadGrid.className = 'recordsSquadGrid';
    const sortedSquads = squads.sort((a, b) => friendlySquadLevelProgress(b).level - friendlySquadLevelProgress(a).level || friendlySquadLevelProgress(b).xp - friendlySquadLevelProgress(a).xp || String(a.id).localeCompare(String(b.id)));
    if (!sortedSquads.length) {
      const empty = globalThis.document.createElement('p');
      empty.className = 'emptyText';
      empty.textContent = this.msg('menu.recordsSquadsEmpty', {}, 'まだ戦績を持つ部隊がありません。');
      squadGrid.append(empty);
    } else {
      for (const squad of sortedSquads) squadGrid.append(this.createSquadRecordCard(squad));
    }
    fragment.append(title, note, metrics, squadTitle, squadGrid);
    this.recordsPanel.replaceChildren(fragment);
  }

  createGuideEntry(entry, index = 0) {
    const details = globalThis.document.createElement('details');
    if (index === 0) details.open = true;
    const summary = globalThis.document.createElement('summary');
    summary.textContent = entry?.title ?? '';
    const body = globalThis.document.createElement('p');
    body.textContent = entry?.body ?? '';
    details.append(summary, body);
    return details;
  }

  currentLanguage() {
    return languageMeta(this.i18n?.language ?? 'en');
  }

  nextBootLanguage() {
    return nextLanguageCode(this.i18n?.language ?? this.currentLanguage().code);
  }

  toggleBootLanguage() {
    this.setLanguage(this.nextBootLanguage());
  }

  createLanguageButton(language, currentCode) {
    const button = globalThis.document.createElement('button');
    const active = language.code === currentCode;
    const visible = `${language.flag ?? ''} ${language.label}`.trim();
    button.type = 'button';
    button.dataset.languageChoice = language.code;
    button.dataset.i18nRaw = 'true';
    button.setAttribute('aria-label', language.nativeName);
    button.setAttribute('title', language.nativeName);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.classList.toggle('active', active);
    button.textContent = visible;
    return button;
  }

  createBootLanguageButton() {
    const current = this.currentLanguage();
    const next = languageMeta(this.nextBootLanguage());
    const label = this.msg('language.toggleButtonLabel', {}, '言語を切り替え');
    const title = `${this.msg('language.toggleButtonTitle', {}, 'English / 中文 / 한국어 / Tiếng Việt / 日本語')} · ${current.nativeName} → ${next.nativeName}`;
    const badge = bootLanguageBadge(current);
    const button = globalThis.document.createElement('button');
    button.type = 'button';
    button.dataset.languageToggle = 'next';
    button.dataset.currentLanguage = current.code;
    button.dataset.nextLanguage = next.code;
    button.dataset.languageBadge = badge;
    button.setAttribute('aria-label', `${label}: ${current.nativeName}`);
    button.setAttribute('title', title);
    button.classList.add('active');
    button.textContent = badge;
    return button;
  }

  renderLanguageButtons() {
    if (this.languageButtons) {
      const current = this.currentLanguage().code;
      const fragment = globalThis.document.createDocumentFragment();
      for (const language of SUPPORTED_LANGUAGES) {
        fragment.append(this.createLanguageButton(language, current));
      }
      this.languageButtons.replaceChildren(fragment);
    }
    if (this.bootLanguageButtons) {
      this.bootLanguageButtons.replaceChildren(this.createBootLanguageButton());
    }
  }

  setTab(tab) {
    this.activeTab = tab;
    if (tab === 'ops') this.refreshOperations(true);
    if (tab === 'records') this.renderRecords(true);
    if (tab === 'guide' || tab === 'display' || tab === 'system') this.renderLocalizedContent();
    for (const button of this.panel.querySelectorAll('[data-menu-tab]')) {
      button.classList.toggle('active', button.dataset.menuTab === tab);
    }
    for (const panel of this.panel.querySelectorAll('[data-menu-panel]')) {
      panel.classList.toggle('active', panel.dataset.menuPanel === tab);
    }
  }


  handleOperationAction(button) {
    const action = button?.dataset?.operationAction ?? '';
    if (!action) return;
    const context = {
      action,
      operationId: button.dataset.operationId ?? '',
      label: button.textContent ?? ''
    };
    const result = this.onOperationAction?.(action, context);
    if (result !== false) setVisible(this.panel, false);
  }

  refreshOperations(force = false) {
    if (!this.opsPanel || !this.store) return;
    const now = Date.now();
    if (!force && this.lastOpsRefreshAt && now - this.lastOpsRefreshAt < 1200) return;
    this.lastOpsRefreshAt = now;
    const state = uiViewState(this.store);
    if (state) {
      this.opsPanel.replaceChildren(renderOperationGuidance(buildOperationGuidance(state, this.i18n), this.i18n));
      return;
    }
    const empty = globalThis.document.createElement('p');
    empty.className = 'emptyText';
    empty.textContent = this.msg('menu.opsUnavailable', {}, '作戦目標を取得できません。');
    this.opsPanel.replaceChildren(empty);
  }

  update() {
    if (!this.panel.hidden && this.activeTab === 'ops') this.refreshOperations(false);
    if (!this.panel.hidden && this.activeTab === 'records') this.renderRecords(false);
  }

  setSaveAvailable(available) {
    this.manualSave.disabled = !available;
    this.manualSave.textContent = available ? this.msg('menu.saveReady', {}, '現在の状態を保存') : this.msg('menu.saveUnavailable', {}, '保存できません');
  }
}
