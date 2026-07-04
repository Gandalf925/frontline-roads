import { queryRequired, setVisible, escapeHtml } from './dom.js';
import {
  ROADSIDE_USE_DEFINITIONS, TACTICAL_MATERIAL_DEFINITIONS, TACTICAL_RECIPES, TACTICAL_WORKSHOP_BUILDING,
  ensureRoadsideSupplyState, roadsideSupplyPresentation, tacticalRecipeStatus
} from '../exploration/roadside-supplies.js';
import { RESOURCE_LABELS } from '../civilization/data.js';

function countText(count) {
  return count > 99 ? '99+' : String(count);
}

function text(i18n, key, params = {}, fallback = '') {
  return i18n?.message?.(key, params, fallback) ?? i18n?.copy?.(fallback) ?? fallback;
}

function copy(i18n, value = '') {
  return i18n?.copy?.(value) ?? value;
}

function separator(i18n) {
  return text(i18n, 'app.inlineSeparator', {}, '・');
}

function activeSummary(state, i18n = null) {
  const supplies = state.world?.roadsideSupplies?.active ?? [];
  if (!supplies.length) return text(i18n, 'roadside.summaryNone', {}, '周辺の道端物資なし');
  const resources = supplies.filter(item => item.kind === 'resource').length;
  const items = supplies.length - resources;
  return [
    text(i18n, 'roadside.summaryNearby', { count: supplies.length }, `周辺 ${supplies.length}`),
    resources ? text(i18n, 'roadside.summaryResources', { count: resources }, `資源 ${resources}`) : null,
    items ? text(i18n, 'roadside.summaryItems', { count: items }, `装備 ${items}`) : null
  ].filter(Boolean).join(' / ');
}

function bundleText(bundle = {}, i18n = null) {
  if (i18n?.bundleText) return i18n.bundleText(bundle);
  const values = Object.entries(bundle).filter(([, value]) => Number(value) > 0);
  return values.length ? values.map(([key, value]) => `${RESOURCE_LABELS[key] ?? key} ${value}`).join('・') : 'なし';
}

function materialText(materials = {}, i18n = null) {
  const values = Object.entries(materials).filter(([, value]) => Number(value) > 0);
  return values.length
    ? values.map(([key, value]) => `${copy(i18n, TACTICAL_MATERIAL_DEFINITIONS[key]?.name ?? key)} ${value}`).join(separator(i18n))
    : text(i18n, 'roadside.none', {}, 'なし');
}

function shortageText(resourceMissing = {}, materialMissing = {}, i18n = null) {
  const resources = Object.entries(resourceMissing)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => text(i18n, 'roadside.shortageEntry', { itemName: copy(i18n, RESOURCE_LABELS[key] ?? key), count: Math.floor(Number(value) || 0) }, `${RESOURCE_LABELS[key] ?? key} あと${Math.floor(Number(value) || 0)}`));
  const materials = Object.entries(materialMissing)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => text(i18n, 'roadside.shortageEntry', { itemName: copy(i18n, TACTICAL_MATERIAL_DEFINITIONS[key]?.name ?? key), count: Math.floor(Number(value) || 0) }, `${TACTICAL_MATERIAL_DEFINITIONS[key]?.name ?? key} あと${Math.floor(Number(value) || 0)}`));
  return [...resources, ...materials].join(separator(i18n));
}

function distanceText(state, point) {
  const player = state.player?.worldPosition;
  if (!player || !Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) return '';
  const dx = Number(point.x) - Number(player.x);
  const dy = Number(point.y) - Number(player.y);
  const meters = Math.round(Math.sqrt(dx * dx + dy * dy));
  return Number.isFinite(meters) ? `${meters}m` : '';
}

function tabButton(id, label, active) {
  return `<button type="button" data-ui-tab="${escapeHtml(id)}" class="${active === id ? 'active' : ''}">${escapeHtml(label)}</button>`;
}

function tabPanel(id, active, html) {
  return `<section class="uiTabPanel ${active === id ? 'active' : ''}" data-panel="${escapeHtml(id)}">${html}</section>`;
}

function rarityLabel(i18n, rarity) {
  if (rarity === 'legendary') return text(i18n, 'roadside.rarityLegendary', {}, 'Legendary');
  if (rarity === 'epic') return text(i18n, 'roadside.rarityEpic', {}, 'Epic');
  if (rarity === 'rare') return text(i18n, 'roadside.rarityRare', {}, 'Rare');
  if (rarity === 'uncommon') return text(i18n, 'roadside.rarityUncommon', {}, 'Uncommon');
  return text(i18n, 'roadside.rarityCommon', {}, 'Common');
}

function definitionName(i18n, definition, fallback = '') {
  return copy(i18n, definition?.name ?? fallback);
}

function itemUseLabel(i18n, key, definition = {}) {
  if (definition.squadType) return text(i18n, 'roadside.itemLabelDeployment', { range: definition.searchRangeMeters }, `${definition.searchRangeMeters}m以内の出撃先を選び、一時部隊を派遣`);
  if (key === 'sweepSignal') return text(i18n, 'roadside.itemLabelSweep', { radius: definition.radiusMeters }, `現在地${definition.radiusMeters}m以内の通常敵を掃討`);
  if (key === 'breachCharge') return text(i18n, 'roadside.itemLabelBreach', { radius: definition.radiusMeters }, `現在地${definition.radiusMeters}m以内の敵拠点1つを破壊`);
  if (['roadMine', 'directionalMine', 'armorBreakerMine'].includes(key)) return text(i18n, 'roadside.itemLabelMine', {}, '道路上に設置。時間制限なし・発動まで残存');
  if (key === 'lureSignal') return text(i18n, 'roadside.itemLabelLure', {}, '下の誘導先リストから地雷または防衛密集地点を指定');
  if (['remoteBarrage', 'airSupport', 'areaSuppression'].includes(key)) return text(i18n, 'roadside.itemLabelTargetOnly', {}, '敵部隊または敵拠点を選択すると下部操作に表示されます');
  if (key === 'marchBanner' || key === 'smokeScreen') return text(i18n, 'roadside.itemLabelSquadOnly', {}, '味方部隊を選択すると下部操作に表示されます');
  return text(i18n, 'roadside.itemLabelNoTarget', {}, '対象不要の消耗品');
}

function itemButtonText(i18n, mode, count) {
  const key = {
    deployment: 'roadside.buttonChooseDeployment',
    squad: 'roadside.buttonUseAfterSquad',
    target: 'roadside.buttonUseAfterTarget',
    lure: 'roadside.buttonChooseLure',
    instant: 'roadside.buttonUseNow'
  }[mode] ?? 'roadside.buttonUseNow';
  const fallback = {
    deployment: `出撃先を選ぶ ×${count}`,
    squad: `部隊選択後に使用 ×${count}`,
    target: `対象選択後に使用 ×${count}`,
    lure: `誘導先を選ぶ ×${count}`,
    instant: `すぐ使用 ×${count}`
  }[mode] ?? `すぐ使用 ×${count}`;
  return text(i18n, key, { count }, fallback);
}

export class RoadsideSuppliesUi {
  constructor({ store, roadsideSupplySystem, commandBus = null, notifications, persist, i18n = null }) {
    this.store = store;
    this.roadsideSupplySystem = roadsideSupplySystem;
    this.commandBus = commandBus;
    this.notifications = notifications;
    this.persist = persist;
    this.i18n = i18n;
    this.button = queryRequired('#suppliesButton');
    this.panel = queryRequired('#suppliesPanel');
    this.body = queryRequired('#suppliesBody');
    this.closeButton = queryRequired('#closeSupplies');
    this.lastPanelRenderAt = 0;
    this.activeTab = 'inventory';
    this.disclosureState = new Map();
    this.button.addEventListener('click', () => this.open());
    this.closeButton.addEventListener('click', () => this.close());
    this.panel.addEventListener('click', event => { if (event.target === this.panel) this.close(); });
    this.body.addEventListener('click', event => {
      const tabButton = event.target.closest('button[data-ui-tab]');
      if (!tabButton) return;
      this.activeTab = tabButton.dataset.uiTab || 'inventory';
      this.render();
    });
    this.body.addEventListener('toggle', event => this.handleDisclosureToggle(event), true);
  }

  localize(textValue = '') { return copy(this.i18n, textValue); }
  msg(key, params = {}, fallback = '') { return text(this.i18n, key, params, fallback); }

  messagePayload(key, params = {}, fallback = '') { return { key, params, text: fallback }; }

  handleDisclosureToggle(event) {
    const target = event?.target;
    if (!target?.matches?.('details[data-ui-disclosure]')) return;
    const key = target.dataset?.uiDisclosure;
    if (!key) return;
    this.disclosureState.set(key, Boolean(target.open));
  }

  disclosureOpen(key, fallback = false) {
    return this.disclosureState.has(key) ? Boolean(this.disclosureState.get(key)) : fallback;
  }

  open() {
    this.commandBus?.execute('roadside.refresh', {}, { validate: true });
    this.render();
    setVisible(this.panel, true);
  }

  close() { setVisible(this.panel, false); }

  reasonPayload(result, key, fallback) {
    if (result?.reasonKey) return this.messagePayload(result.reasonKey, result.reasonParams ?? {}, result.reason ?? fallback);
    if (result?.key) return this.messagePayload(result.key, result.params ?? {}, result.text ?? result.fallback ?? fallback);
    return this.messagePayload(key, {}, result?.reason ?? fallback);
  }

  reasonText(result, key, fallback) {
    const payload = this.reasonPayload(result, key, fallback);
    return payload && typeof payload === 'object' && payload.key ? this.msg(payload.key, payload.params ?? {}, payload.text ?? fallback) : String(payload ?? '');
  }

  showFailure(result, key, fallback) {
    this.notifications.show(this.reasonPayload(result, key, fallback));
  }

  executeCommand(type, payload = {}, { failureKey = 'roadside.useFailed', failureFallback = 'アイテムを使用できません。' } = {}) {
    const result = this.commandBus?.execute(type, payload) ?? { ok: false, reason: 'Command bus is unavailable.' };
    if (!result?.ok) this.showFailure(result, failureKey, failureFallback);
    else this.persist?.({ notify: false });
    this.render();
    return result;
  }

  useItem(key) {
    this.executeCommand('roadside.use', { key }, { failureKey: 'roadside.useFailed', failureFallback: 'アイテムを使用できません。' });
  }

  openDeploymentTab(key = null) {
    this.activeTab = 'deployment';
    this.render();
    if (key) {
      const target = this.body.querySelector(`[data-deployment-section="${key}"]`);
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  useDeploymentTarget(key, kind, id) {
    this.executeCommand('roadside.useDeploymentTarget', { key, target: { kind, id } }, { failureKey: 'roadside.deployFailed', failureFallback: '一時部隊を出撃できません。' });
  }

  useLureTarget(kind, id) {
    this.executeCommand('roadside.useLureTarget', { target: { kind, id } }, { failureKey: 'roadside.lureFailed', failureFallback: '誘導信号を使用できません。' });
  }

  craft(recipeKey) {
    this.executeCommand('roadside.craft', { recipeKey }, { failureKey: 'roadside.craftFailed', failureFallback: '製作できません。' });
  }

  removeMine(mineId) {
    this.executeCommand('roadside.removeMine', { mineId }, { failureKey: 'roadside.removeMineFailed', failureFallback: '撤去できません。' });
  }

  update(view = this.store.uiSnapshot()) {
    const state = view ?? this.store.uiSnapshot();
    const supplies = ensureRoadsideSupplyState(state);
    const total = Object.values(supplies.inventory ?? {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    const materialTotal = Object.values(supplies.materials ?? {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    const combined = total + materialTotal;
    this.button.textContent = combined > 0 ? this.msg('roadside.buttonWithCount', { count: countText(combined) }, `ITEMS // 物資 ${countText(combined)}`) : this.msg('roadside.button', {}, 'ITEMS // 物資');
    this.button.title = activeSummary(state, this.i18n);
    if (!this.panel.hidden && Date.now() - this.lastPanelRenderAt >= 700) this.render(state);
  }

  render(snapshot = this.store.uiSnapshot()) {
    this.lastPanelRenderAt = Date.now();
    const state = snapshot ?? this.store.uiSnapshot();
    const supplies = ensureRoadsideSupplyState(state);
    const inventory = supplies.inventory ?? {};
    const active = supplies.active ?? [];
    const activeSorted = [...active].sort((a, b) => {
      const da = distanceText(state, a) || '99999m';
      const db = distanceText(state, b) || '99999m';
      return parseInt(da, 10) - parseInt(db, 10) || String(a.id).localeCompare(String(b.id));
    });
    const nearby = activeSorted.slice(0, 12).map(item => {
      const presentation = roadsideSupplyPresentation(item);
      const detail = item.kind === 'resource' ? bundleText(item.bundle, this.i18n) : this.localize(presentation.summary);
      const gap = distanceText(state, item);
      const rarity = rarityLabel(this.i18n, presentation.rarity ?? item.rarity ?? 'common');
      const meta = gap ? `${rarity}${separator(this.i18n)}${gap}` : rarity;
      return `<li><strong>${escapeHtml(this.localize(presentation.name))}<em>${escapeHtml(meta)}</em></strong><span>${escapeHtml(detail)}</span></li>`;
    }).join('') || `<li><span>${escapeHtml(this.msg('roadside.nearbyEmpty', {}, '現在地周辺に表示中の道端物資はありません。'))}</span></li>`;

    const deploymentKeys = Object.entries(ROADSIDE_USE_DEFINITIONS).filter(([, definition]) => definition.squadType).map(([key]) => key);
    const inventoryHtml = Object.entries(ROADSIDE_USE_DEFINITIONS).map(([key, definition]) => {
      const count = Math.max(0, Math.floor(Number(inventory[key]) || 0));
      const squadOnly = key === 'marchBanner' || key === 'smokeScreen';
      const targetOnly = ['remoteBarrage', 'airSupport', 'areaSuppression'].includes(key);
      const lureTargetOnly = key === 'lureSignal';
      const deploymentCall = Boolean(definition.squadType);
      const disabled = count <= 0 || squadOnly || targetOnly || lureTargetOnly || deploymentCall ? 'disabled' : '';
      const label = itemUseLabel(this.i18n, key, definition);
      const mode = deploymentCall ? 'deployment' : squadOnly ? 'squad' : targetOnly ? 'target' : lureTargetOnly ? 'lure' : 'instant';
      const buttonText = itemButtonText(this.i18n, mode, count);
      const action = deploymentCall
        ? `<button type="button" data-open-deployment="${escapeHtml(key)}" ${count <= 0 ? 'disabled' : ''}>${escapeHtml(buttonText)}</button>`
        : `<button type="button" data-use-roadside="${escapeHtml(key)}" ${disabled}>${escapeHtml(buttonText)}</button>`;
      return `<div class="supplyInventoryRow${squadOnly || targetOnly || lureTargetOnly || deploymentCall ? ' is-squad-only' : ''}"><div><strong>${escapeHtml(definitionName(this.i18n, definition, key))}</strong><span>${escapeHtml(label)}</span></div>${action}</div>`;
    }).join('');

    const deploymentHtml = deploymentKeys.map(key => {
      const definition = ROADSIDE_USE_DEFINITIONS[key];
      const count = Math.max(0, Math.floor(Number(inventory[key]) || 0));
      const targets = this.roadsideSupplySystem.deploymentTargets?.(state, key) ?? [];
      const targetRows = targets.slice(0, 8).map(target => {
        const hpPercent = Math.max(0, Math.min(100, Math.round(target.hp / Math.max(1, target.maxHp) * 100)));
        const route = target.routeMeters != null ? this.msg('roadside.routeMeters', { meters: target.routeMeters }, `経路 ${target.routeMeters}m`) : this.msg('roadside.noRoute', {}, '経路なし');
        const disabled = count <= 0 || !target.available ? 'disabled' : '';
        const availability = target.available ? '' : `${separator(this.i18n)}${this.msg('roadside.disconnected', {}, '接続不可')}`;
        return `<div class="supplyInventoryRow deploymentTargetRow"><div><strong>${escapeHtml(this.localize(target.name))}<em>${escapeHtml(`${target.distanceMeters}m${separator(this.i18n)}HP ${hpPercent}%`)}</em></strong><span>${escapeHtml(route + availability)}</span></div><button type="button" data-deploy-roadside="${escapeHtml(key)}" data-deploy-kind="${escapeHtml(target.kind)}" data-deploy-id="${escapeHtml(target.id)}" ${disabled}>${escapeHtml(this.msg('roadside.buttonDeployToTarget', { count }, `この対象へ出撃 ×${count}`))}</button></div>`;
      }).join('') || `<p class="emptyText">${escapeHtml(count > 0 ? this.msg('roadside.noDeploymentTargets', { range: definition.searchRangeMeters }, `現在地から${definition.searchRangeMeters}m以内に出撃可能な対象がありません。`) : this.msg('roadside.itemNotOwned', { itemName: definitionName(this.i18n, definition, key) }, `${definition.name}を所持していません。`))}</p>`;
      const squadNote = definition.squadType === 'skirmisher'
        ? this.msg('roadside.deploymentNoteSkirmisher', {}, '遊撃部隊が選択した敵部隊へ向かいます。')
        : this.msg('roadside.deploymentNoteGeneric', { targetLabel: definition.targetKind === 'enemyBase' ? this.msg('roadside.targetEnemyBase', {}, '選択した敵拠点') : this.msg('roadside.targetEnemySquad', {}, '選択した敵') }, `${definition.targetKind === 'enemyBase' ? '選択した敵拠点' : '選択した敵'}へ一時部隊を向かわせます。`);
      return `<section class="deploymentCallSection" data-deployment-section="${escapeHtml(key)}"><h3>${escapeHtml(definitionName(this.i18n, definition, key))}</h3><p class="sectionNote">${escapeHtml(`${squadNote} ${this.msg('roadside.deploymentSingleLimit', {}, '一時部隊は同時に1隊までです。')}`)}</p><div class="supplyInventoryList">${targetRows}</div></section>`;
    }).join('');

    const materialHtml = Object.entries(TACTICAL_MATERIAL_DEFINITIONS).map(([key, definition]) => {
      const count = Math.max(0, Math.floor(Number(supplies.materials?.[key]) || 0));
      if (count <= 0) return '';
      return `<div class="supplyInventoryRow is-material"><div><strong>${escapeHtml(definitionName(this.i18n, definition, key))}</strong><span>${escapeHtml(this.msg('roadside.materialRarity', { rarity: this.localize(definition.rarity) }, `${definition.rarity}素材`))}</span></div><em>×${count}</em></div>`;
    }).join('') || `<p class="emptyText">${escapeHtml(this.msg('roadside.materialsEmpty', {}, '戦術素材はまだありません。レア以上の道端物資から入手します。'))}</p>`;

    const lureTargets = this.roadsideSupplySystem.lureTargets?.(state) ?? [];
    const lureCount = Math.max(0, Math.floor(Number(inventory.lureSignal) || 0));
    const lureHtml = lureTargets.map(target => {
      const gap = distanceText(state, target);
      const kindText = target.kind === 'mine'
        ? this.msg('roadside.lureKindMine', { itemName: target.itemKey ? definitionName(this.i18n, ROADSIDE_USE_DEFINITIONS[target.itemKey], target.itemKey) : '' }, `設置済み地雷${target.itemKey ? `・${ROADSIDE_USE_DEFINITIONS[target.itemKey]?.name ?? target.itemKey}` : ''}`)
        : this.msg('roadside.lureKindDefenseCluster', { count: target.count ?? 0 }, `防衛密集地点・${target.count ?? 0}基`);
      const remove = target.kind === 'mine' ? `<button type="button" class="danger" data-remove-mine="${escapeHtml(target.id)}">${escapeHtml(this.msg('roadside.buttonRemove', {}, '撤去'))}</button>` : '';
      return `<div class="supplyInventoryRow lureTargetRow"><div><strong>${escapeHtml(this.localize(target.name))}<em>${escapeHtml(gap)}</em></strong><span>${escapeHtml(kindText)}</span></div><div class="rowActions"><button type="button" data-lure-kind="${escapeHtml(target.kind)}" data-lure-id="${escapeHtml(target.id)}" ${lureCount <= 0 ? 'disabled' : ''}>${escapeHtml(this.msg('roadside.buttonLureSignal', { count: lureCount }, `誘導信号 ×${lureCount}`))}</button>${remove}</div></div>`;
    }).join('') || `<p class="emptyText">${escapeHtml(this.msg('roadside.lureTargetsEmpty', {}, '誘導先になる設置済み地雷・防衛密集地点がありません。'))}</p>`;

    const workshopReady = (state.civilization?.buildings ?? []).some(building => building.type === TACTICAL_WORKSHOP_BUILDING && building.hp > 0);
    const recipes = Object.entries(TACTICAL_RECIPES).map(([key, recipe]) => {
      const status = tacticalRecipeStatus(state, key);
      const resourceCost = bundleText(recipe.resources, this.i18n);
      const materialCost = materialText(recipe.materials, this.i18n);
      const missing = shortageText(status.resourceMissing, status.materialMissing, this.i18n);
      const unlocked = (state.civilization?.level ?? 0) >= recipe.level;
      const ready = status.ok;
      const reason = ready
        ? this.msg('roadside.recipeReady', {}, '必要資源がそろっています。')
        : !unlocked
          ? this.msg('roadside.recipeLockedByCiv', { level: recipe.level }, `文明Lv.${recipe.level}で解禁されます。`)
          : !workshopReady
            ? this.msg('roadside.recipeNeedsWorkshop', {}, '戦術工房を建設すると製作できます。')
            : missing
              ? this.msg('roadside.recipeMissing', { missing }, `不足：${missing}`)
              : this.reasonText(status, 'roadside.craftFailed', '製作できません。');
      const html = `<div class="supplyInventoryRow tacticalRecipe${ready ? ' is-ready' : unlocked ? '' : ' is-locked'}"><div><strong>${escapeHtml(this.localize(recipe.name))}</strong><span>${escapeHtml(reason)}</span><small>${escapeHtml(this.msg('roadside.resourceCost', { cost: resourceCost }, `資材 ${resourceCost}`))}</small><small>${escapeHtml(this.msg('roadside.materialCost', { cost: materialCost }, `素材 ${materialCost}`))}</small></div><button type="button" data-craft-roadside="${escapeHtml(key)}" ${ready ? '' : 'disabled'}>${escapeHtml(this.msg('roadside.buttonCraft', {}, '製作'))}</button></div>`;
      return { key, ready, unlocked, html };
    });
    const craftableHtml = recipes.filter(recipe => recipe.ready).map(recipe => recipe.html).join('') || `<p class="emptyText">${escapeHtml(this.msg('roadside.craftableEmpty', {}, '現在すぐ製作できるアイテムはありません。'))}</p>`;
    const unavailableHtml = recipes.filter(recipe => !recipe.ready).map(recipe => recipe.html).join('') || `<p class="emptyText">${escapeHtml(this.msg('roadside.unavailableRecipesEmpty', {}, '未解禁または資源不足のレシピはありません。'))}</p>`;

    const activeTab = ['inventory', 'deployment', 'lure', 'workshop', 'materials', 'nearby'].includes(this.activeTab) ? this.activeTab : 'inventory';
    const inventoryTotal = Object.values(inventory).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    const materialTotal = Object.values(supplies.materials ?? {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    this.body.innerHTML = `
      <div class="uiTabBar" role="tablist" aria-label="${escapeHtml(this.msg('roadside.tabBarLabel', {}, 'アイテム画面の表示切替'))}">
        ${tabButton('inventory', this.msg('roadside.tabInventory', {}, '所持品'), activeTab)}
        ${tabButton('deployment', this.msg('roadside.tabDeployment', {}, '出撃'), activeTab)}
        ${tabButton('lure', this.msg('roadside.tabLure', {}, '誘導'), activeTab)}
        ${tabButton('workshop', this.msg('roadside.tabWorkshop', {}, '製作'), activeTab)}
        ${tabButton('materials', this.msg('roadside.tabMaterials', {}, '素材'), activeTab)}
        ${tabButton('nearby', this.msg('roadside.tabNearby', {}, '周辺'), activeTab)}
      </div>
      <section class="overviewHero suppliesHero">
        <div><small>${escapeHtml(this.msg('roadside.overviewConsumables', {}, '消耗品'))}</small><strong>${inventoryTotal}</strong><span>${escapeHtml(this.msg('roadside.overviewInventoryTotal', {}, '所持数合計'))}</span></div>
        <div><small>${escapeHtml(this.msg('roadside.overviewMaterials', {}, '戦術素材'))}</small><strong>${materialTotal}</strong><span>${escapeHtml(this.msg('roadside.overviewCraftingMaterials', {}, '製作用素材'))}</span></div>
        <div><small>${escapeHtml(this.msg('roadside.overviewNearby', {}, '周辺物資'))}</small><strong>${active.length}</strong><span>${escapeHtml(this.msg('roadside.overviewCollected', { count: supplies.daily?.collectedCount ?? 0 }, `取得済み ${supplies.daily?.collectedCount ?? 0}`))}</span></div>
      </section>
      ${tabPanel('inventory', activeTab, `<h2>${escapeHtml(this.msg('roadside.inventoryTitle', {}, '消耗品インベントリ'))}</h2><p class="sectionNote">${escapeHtml(this.msg('roadside.inventoryNote', {}, '出撃札は出撃タブで対象を選んでから使用します。使用すると一時部隊がその対象へ出撃します。'))}</p><div class="supplyInventoryList compactInventory">${inventoryHtml}</div>`)}
      ${tabPanel('deployment', activeTab, `<h2>${escapeHtml(this.msg('roadside.deploymentTitle', {}, '出撃札の出撃先'))}</h2><p class="sectionNote">${escapeHtml(this.msg('roadside.deploymentNote', {}, '突撃・遊撃・攻城の各出撃札は、ここで対象を選んで一時部隊を派遣します。対象ごとに距離・経路・HPを確認できます。'))}</p>${deploymentHtml}`)}
      ${tabPanel('lure', activeTab, `<h2>${escapeHtml(this.msg('roadside.lureTitle', {}, '誘導信号の誘導先'))}</h2><p class="sectionNote">${escapeHtml(this.msg('roadside.lureNote', {}, '設置済み地雷または防衛設備の密集地点へ、一定時間だけ敵の目標を寄せます。地雷へ誘導した敵が踏むと高い損害を与えます。'))}</p><div class="supplyInventoryList">${lureHtml}</div>`)}
      ${tabPanel('workshop', activeTab, `<h2>${escapeHtml(this.msg('roadside.workshopTitle', {}, '戦術工房'))}</h2><p class="sectionNote">${escapeHtml(workshopReady ? this.msg('roadside.workshopReadyNote', {}, '資源と戦術素材を使って、地雷・誘導信号・遠隔支援・出撃札を製作できます。') : this.msg('roadside.workshopLockedNote', {}, '文明Lv.4以降で戦術工房を建設すると、この画面で戦術アイテムを製作できます。'))}</p><h3>${escapeHtml(this.msg('roadside.craftableTitle', {}, '製作可能'))}</h3><div class="supplyInventoryList">${craftableHtml}</div><details class="completedRequirements workshopUnavailable" data-ui-disclosure="roadside.workshopUnavailable"${this.disclosureOpen('roadside.workshopUnavailable') ? ' open' : ''}><summary>${escapeHtml(this.msg('roadside.unavailableRecipesTitle', {}, '素材不足・未解禁レシピ'))}</summary><div class="supplyInventoryList">${unavailableHtml}</div></details>`)}
      ${tabPanel('materials', activeTab, `<h2>${escapeHtml(this.msg('roadside.materialsTitle', {}, '戦術素材'))}</h2><p class="sectionNote">${escapeHtml(this.msg('roadside.materialsNote', {}, 'レア以上の道端物資から入手し、戦術アイテムの製作に使います。'))}</p><div class="supplyInventoryList compactInventory">${materialHtml}</div>`)}
      ${tabPanel('nearby', activeTab, `<h2>${escapeHtml(this.msg('roadside.nearbyTitle', {}, '道端物資'))}</h2><p class="sectionNote">${escapeHtml(this.msg('roadside.nearbyNote', {}, '道路沿いの資源箱は近づくと自動回収します。保管上限を超える資源は取得されません。'))}</p><div class="supplyStatusGrid"><span><small>${escapeHtml(this.msg('roadside.statNearby', {}, '周辺'))}</small><strong>${active.length}</strong></span><span><small>${escapeHtml(this.msg('roadside.statCollected', {}, '取得済み'))}</small><strong>${supplies.daily?.collectedCount ?? 0}</strong></span><span><small>${escapeHtml(this.msg('roadside.statRareCollected', {}, 'レア取得'))}</small><strong>${supplies.daily?.rareCollectedCount ?? 0}</strong></span></div><ul class="supplyNearbyList">${nearby}</ul>`)}
    `;
    for (const button of this.body.querySelectorAll('[data-use-roadside]')) {
      if (button.disabled) continue;
      button.addEventListener('click', () => this.useItem(button.dataset.useRoadside));
    }
    for (const button of this.body.querySelectorAll('[data-open-deployment]')) {
      if (button.disabled) continue;
      button.addEventListener('click', () => this.openDeploymentTab(button.dataset.openDeployment));
    }
    for (const button of this.body.querySelectorAll('[data-deploy-roadside]')) {
      if (button.disabled) continue;
      button.addEventListener('click', () => this.useDeploymentTarget(button.dataset.deployRoadside, button.dataset.deployKind, button.dataset.deployId));
    }
    for (const button of this.body.querySelectorAll('[data-lure-kind]')) {
      if (button.disabled) continue;
      button.addEventListener('click', () => this.useLureTarget(button.dataset.lureKind, button.dataset.lureId));
    }
    for (const button of this.body.querySelectorAll('[data-craft-roadside]')) {
      if (button.disabled) continue;
      button.addEventListener('click', () => this.craft(button.dataset.craftRoadside));
    }
    for (const button of this.body.querySelectorAll('[data-remove-mine]')) {
      button.addEventListener('click', () => this.removeMine(button.dataset.removeMine));
    }
  }
}
