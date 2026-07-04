import { distance, formatMeters } from '../core/utilities.js';
import { evaluateProject } from '../civilization/progression-system.js';
import { CIVILIZATIONS, RESOURCE_LABELS, SETTLEMENT_BUILDINGS } from '../civilization/data.js';
import { ownedBaseById } from '../base/field-bases.js';
import { RECOVERY_ITEM_STATUS, isRecoveryItemVisible, recoveryItemPoint, recoveryItemPresentation } from '../exploration/recovery-system.js';
import { ROADSIDE_USE_DEFINITIONS, TACTICAL_RECIPES, TACTICAL_WORKSHOP_BUILDING, ensureRoadsideSupplyState } from '../exploration/roadside-supplies.js';
import { hasBundle, missingBundle } from '../civilization/inventory-system.js';
import { ENEMY_BASE_DEFINITIONS } from '../combat/definitions.js';
import { REGION_SIMULATION_MODE } from '../base/region-control.js';
import { nextSiegeEvent } from '../combat/siege-event.js';

const MAX_OPERATIONS = 4;
const MAX_WALK_TARGETS = 5;
const FIRST_GUIDE_SECONDS = 10 * 60;


function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function text(i18n, key, params = {}, fallback = '') {
  return i18n?.message?.(key, params, fallback) ?? i18n?.copy?.(fallback) ?? fallback;
}

function copy(i18n, value = '') {
  return i18n?.copy?.(value) ?? value;
}

function localizedResourceName(i18n, key) {
  return copy(i18n, RESOURCE_LABELS[key] ?? key);
}

function localizedName(i18n, value = '') {
  return copy(i18n, value);
}

function separator(i18n) {
  return text(i18n, 'app.inlineSeparator', {}, '・');
}

function joinParts(i18n, parts = []) {
  return parts.filter(Boolean).join(separator(i18n));
}

function enemyBasePoint(state, base) {
  if (finitePoint(base)) return base;
  return base?.nodeId ? state.world?.roadGraph?.nodeById?.get(base.nodeId) ?? null : null;
}

function activeBases(state) {
  return [
    ...(state.world?.playerBases ?? []),
    ...(state.world?.fieldBases ?? [])
  ].filter(base => base?.status === 'ESTABLISHED' && base.hp > 0);
}

function activePlayerBases(state) {
  return (state.world?.playerBases ?? []).filter(base => base?.status === 'ESTABLISHED' && base.hp > 0);
}

function operation(id, priority, title, detail, action = null, tag = '') {
  return { id, priority, title, detail, action, tag };
}

function action(label, key) {
  return { label, key };
}

function actionLabel(operationAction) {
  if (!operationAction) return '';
  if (typeof operationAction === 'string') return operationAction;
  return operationAction.label ?? '';
}

function actionKey(operationAction) {
  if (!operationAction) return '';
  if (typeof operationAction === 'string') return '';
  return operationAction.key ?? '';
}

function incompleteProjectOperations(state, i18n = null) {
  const evaluation = evaluateProject(state);
  if (evaluation.complete || !evaluation.project) return [];
  const civilization = CIVILIZATIONS[evaluation.project.targetLevel];
  const targetName = civilization?.name ?? text(i18n, 'operation.civilizationLevelName', { level: evaluation.project.targetLevel }, `文明Lv.${evaluation.project.targetLevel}`);
  const incomplete = evaluation.checks.filter(check => !check.complete);
  const resourceMissing = incomplete
    .filter(check => check.kind === 'resource')
    .slice(0, 3)
    .map(check => `${localizedResourceName(i18n, check.key)} ${Math.max(0, check.required - check.current)}`);
  const nonResource = incomplete.find(check => check.kind !== 'resource');
  const detailParts = [];
  if (resourceMissing.length) detailParts.push(text(i18n, 'operation.civMissingResources', { resourceText: resourceMissing.join(separator(i18n)) }, `不足: ${resourceMissing.join('・')}`));
  if (nonResource) detailParts.push(labelForProjectCheck(nonResource, i18n));
  return [operation(
    'civilization-next',
    80,
    text(i18n, 'operation.civAdvanceTitle', { targetName }, `${targetName}へ発展`),
    detailParts.join(' / ') || text(i18n, 'operation.civAdvanceDetailReady', {}, '条件を確認できます。'),
    action(text(i18n, 'operation.actionOpenCivilization', {}, 'CIVを開く'), 'open-civilization'),
    text(i18n, 'operation.tagCivilization', {}, '文明')
  )];
}

function labelForProjectCheck(check, i18n = null) {
  const current = Math.floor(check.current);
  const required = check.required;
  if (check.kind === 'building') return text(i18n, 'operation.projectBuildingRequirement', { current, required }, `施設条件 ${current}/${required}`);
  if (check.kind === 'artifact') return text(i18n, 'operation.projectArtifactRequirement', { current, required }, `回収物 ${current}/${required}`);
  if (check.kind === 'progress') {
    if (check.key === 'totalKills') return text(i18n, 'operation.projectKillsRequirement', { current, required }, `敵撃破 ${current}/${required}`);
    if (check.key === 'totalCampsCaptured') return text(i18n, 'operation.projectCampsRequirement', { current, required }, `敵拠点攻略 ${current}/${required}`);
    return text(i18n, 'operation.projectProgressRequirement', { current, required }, `進行条件 ${current}/${required}`);
  }
  return text(i18n, 'operation.projectGenericRequirement', { kind: check.kind, current, required }, `${check.kind} ${current}/${required}`);
}

function nearestEnemyBaseOperation(state, i18n = null) {
  const player = state.player?.worldPosition;
  const bases = (state.world?.enemyBases ?? [])
    .filter(base => base.alive && base.hp > 0)
    .map(base => ({ base, point: enemyBasePoint(state, base) }))
    .filter(entry => finitePoint(entry.point));
  if (!bases.length) return [];
  const reference = finitePoint(player) ? player : state.world?.homeBase;
  if (!finitePoint(reference)) return [];
  const nearest = bases.map(entry => ({ ...entry, meters: distance(reference, entry.point) })).sort((a, b) => a.meters - b.meters)[0];
  const baseName = localizedName(i18n, ENEMY_BASE_DEFINITIONS[nearest.base.type]?.name ?? '敵拠点');
  return [operation(
    'enemy-base-nearest',
    55,
    text(i18n, 'operation.enemyBaseNearestTitle', {}, '敵拠点を攻撃'),
    text(i18n, 'operation.enemyBaseNearestDetail', { enemyBaseName: baseName, distanceText: formatMeters(nearest.meters) }, `${baseName}・${formatMeters(nearest.meters)}・攻略後に回収物が出ます。`),
    action(text(i18n, 'operation.actionSelectMap', {}, 'マップで選択'), 'select-map'),
    text(i18n, 'operation.tagAssault', {}, '攻略')
  )];
}

function recoveryOperations(state, i18n = null) {
  const items = (state.world?.recoveryItems ?? []).filter(item => isRecoveryItemVisible(item));
  const available = items.find(item => item.status === RECOVERY_ITEM_STATUS.AVAILABLE);
  const reserved = items.find(item => item.status === RECOVERY_ITEM_STATUS.RESERVED);
  const carried = items.find(item => item.status === RECOVERY_ITEM_STATUS.CARRIED);
  const baseReady = activeBases(state).some(base => base.hp > 0);
  if (available) {
    const presentation = recoveryItemPresentation(available);
    const itemName = localizedName(i18n, presentation.name);
    const point = recoveryItemPoint(state, available);
    const player = state.player?.worldPosition;
    const distanceText = finitePoint(player) && finitePoint(point) ? formatMeters(distance(player, point)) : '';
    const status = baseReady
      ? text(i18n, 'operation.recoveryAvailableWithBase', {}, '回収部隊または現地回収が可能です。')
      : text(i18n, 'operation.recoveryAvailableNeedBase', {}, '出撃可能な拠点が必要です。');
    return [operation(
      'recovery-available',
      65,
      text(i18n, 'operation.recoveryAvailableTitle', {}, '回収物を確保'),
      text(i18n, 'operation.recoveryAvailableDetail', { itemName, distanceText, status }, `${itemName}${distanceText ? `・${distanceText}` : ''}・${status}`),
      action(text(i18n, 'operation.actionSelectRecovery', {}, '回収物を選択'), 'select-recovery'),
      text(i18n, 'operation.tagRecovery', {}, '回収')
    )];
  }
  if (reserved) {
    const itemName = localizedName(i18n, recoveryItemPresentation(reserved).name);
    return [operation('recovery-reserved', 40, text(i18n, 'operation.recoveryReservedTitle', {}, '回収部隊が移動中'), text(i18n, 'operation.recoveryReservedDetail', { itemName }, `${itemName}へ向かっています。到着まで表示は残ります。`), null, text(i18n, 'operation.tagRecovery', {}, '回収'))];
  }
  if (carried) {
    const itemName = localizedName(i18n, recoveryItemPresentation(carried).name);
    return [operation('recovery-carried', 42, text(i18n, 'operation.recoveryCarriedTitle', {}, '回収物を搬送中'), text(i18n, 'operation.recoveryCarriedDetail', { itemName }, `${itemName}を拠点へ持ち帰っています。`), null, text(i18n, 'operation.tagRecovery', {}, '回収'))];
  }
  return [];
}

function regionControlOperations(state, i18n = null) {
  const profiles = Object.values(state.world?.regionProfiles ?? {});
  if (!profiles.length) return [];
  const critical = profiles
    .filter(profile => profile.enemyPressure >= 0.52 && profile.control < 0.58)
    .sort((a, b) => (b.enemyPressure - b.control) - (a.enemyPressure - a.control))[0];
  if (critical) {
    const base = activeBases(state).find(item => item.id === critical.anchorBaseId);
    const name = base?.name ?? text(i18n, 'operation.frontlineBaseName', {}, '前線拠点');
    const pressure = Math.round(critical.enemyPressure * 100);
    const control = Math.round(critical.control * 100);
    return [operation(
      'region-critical',
      82,
      text(i18n, 'region.operationCriticalTitle', { baseName: name }, `${name}の防衛を安定化`),
      text(i18n, 'region.operationCriticalDetail', { control, pressure }, `制圧 ${control}%・敵圧 ${pressure}%。周辺防衛と敵拠点攻略が必要です。`),
      action(text(i18n, 'operation.actionOpenBases', {}, 'BASESを開く'), 'open-bases'),
      text(i18n, 'operation.tagRegion', {}, '地域')
    )];
  }
  const secured = profiles
    .filter(profile => profile.simulationMode === REGION_SIMULATION_MODE.SECURED && profile.resourceYieldPerHour >= 20)
    .sort((a, b) => b.resourceYieldPerHour - a.resourceYieldPerHour)[0];
  if (secured) {
    const base = activeBases(state).find(item => item.id === secured.anchorBaseId);
    const name = base?.name ?? text(i18n, 'operation.securedBaseName', {}, '安定拠点');
    const control = Math.round(secured.control * 100);
    const yieldPerHour = Math.round(secured.resourceYieldPerHour);
    return [operation(
      'region-yield',
      36,
      text(i18n, 'region.operationYieldTitle', { baseName: name }, `${name}の補給圏が安定`),
      text(i18n, 'region.operationYieldDetail', { control, yieldPerHour }, `制圧 ${control}%・資材 +${yieldPerHour}/時。次の前線拡張に使えます。`),
      action(text(i18n, 'operation.actionOpenBases', {}, 'BASESを開く'), 'open-bases'),
      text(i18n, 'operation.tagSupply', {}, '補給')
    )];
  }
  return [];
}


function siegeOperations(state, i18n = null) {
  const next = nextSiegeEvent(state);
  const now = Number(state.runtime?.worldTimeMs) || 0;
  const seconds = Math.max(0, Math.ceil((next.startsAt - now) / 1000));
  if (seconds <= 0) return [];
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const priority = seconds <= 10 * 60 ? 86 : 34;
  return [operation(
    'siege-next',
    priority,
    text(i18n, 'operation.siegeNextTitle', {}, '次の包囲に備える'),
    text(i18n, 'operation.siegeNextDetail', { minutes }, `約${minutes}分後に敵の包囲が始まります。防衛線と帰還部隊を確認してください。`),
    action(text(i18n, 'operation.actionOpenBases', {}, 'BASESを開く'), 'open-bases'),
    text(i18n, 'operation.tagSiege', {}, '包囲')
  )];
}

function repairOperations(state, i18n = null) {
  const damaged = (state.combat?.defenses ?? [])
    .filter(defense => defense.hp > 0 && defense.maxHp > 0 && defense.hp < defense.maxHp * 0.72)
    .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
  if (!damaged.length) return [];
  return [operation(
    'repair-defense',
    46,
    text(i18n, 'operation.repairDefenseTitle', {}, '損傷施設を修理'),
    text(i18n, 'operation.repairDefenseDetail', { count: damaged.length, hp: Math.ceil(damaged[0].hp), maxHp: Math.ceil(damaged[0].maxHp) }, `要修理 ${damaged.length}基・最も損傷した施設 HP ${Math.ceil(damaged[0].hp)}/${Math.ceil(damaged[0].maxHp)}`),
    action(text(i18n, 'operation.actionSelectDefense', {}, '施設を選択'), 'select-defense'),
    text(i18n, 'operation.tagDefense', {}, '防衛')
  )];
}

function workshopOperations(state, i18n = null) {
  const hasWorkshop = (state.civilization?.buildings ?? []).some(building => building.type === TACTICAL_WORKSHOP_BUILDING && building.hp > 0);
  if (!hasWorkshop) return [];
  const craftable = Object.entries(TACTICAL_RECIPES ?? {})
    .filter(([key, recipe]) => (state.civilization?.level ?? 0) >= (recipe.level ?? 0) && hasBundle(state, recipe.cost ?? {}) && hasTacticalMaterials(state, recipe.materials ?? {}))
    .map(([key]) => localizedName(i18n, ROADSIDE_USE_DEFINITIONS[key]?.name ?? key))
    .slice(0, 3);
  if (!craftable.length) return [];
  return [operation(
    'tactical-workshop',
    38,
    text(i18n, 'operation.workshopCraftableTitle', {}, '戦術アイテムを製作可能'),
    craftable.join(separator(i18n)),
    action(text(i18n, 'operation.actionOpenItems', {}, 'ITEMSを開く'), 'open-items'),
    text(i18n, 'operation.tagCraft', {}, '製作')
  )];
}

function hasTacticalMaterials(state, required) {
  const inventory = ensureRoadsideSupplyState(state).materials ?? {};
  return Object.entries(required ?? {}).every(([key, amount]) => (inventory[key] ?? 0) >= amount);
}

function firstTenMinuteOperations(state, i18n = null) {
  const created = Number(state.runtime?.createdAt) || Number(state.runtime?.worldTimeMs) || Date.now();
  const now = Number(state.runtime?.worldTimeMs) || Date.now();
  if (now - created > FIRST_GUIDE_SECONDS * 1000) return [];
  const results = [];
  const defenses = (state.combat?.defenses ?? []).filter(defense => defense.hp > 0);
  const captures = Number(state.statistics?.campsCaptured) || Number(state.civilization?.progress?.campsCapturedByType?.raiderCamp) || 0;
  const level = Number(state.civilization?.level) || 0;
  if (!defenses.length) results.push(operation('first-defense', 95, text(i18n, 'operation.firstDefenseTitle', {}, 'まず防衛施設を置く'), text(i18n, 'operation.firstDefenseDetail', {}, '拠点周辺の道路へ投石台・丸太柵・蔓縄罠を配置します。'), action(text(i18n, 'operation.actionOpenBases', {}, 'BASESを開く'), 'open-bases'), text(i18n, 'operation.tagFirst', {}, '初回')));
  else if (captures <= 0) results.push(operation('first-attack-base', 90, text(i18n, 'operation.firstAttackBaseTitle', {}, '敵拠点を1つ攻略'), text(i18n, 'operation.firstAttackBaseDetail', {}, '文明発展には敵拠点の攻略と回収物の確保が必要です。'), action(text(i18n, 'operation.actionSelectEnemyBase', {}, '敵拠点を選択'), 'select-enemy-base'), text(i18n, 'operation.tagFirst', {}, '初回')));
  else if (level <= 0) results.push(operation('first-civ1', 88, text(i18n, 'operation.firstCivTitle', {}, '文明Lv.1へ発展'), text(i18n, 'operation.firstCivDetail', {}, 'CIVで不足資源を納入して発展を開始します。'), action(text(i18n, 'operation.actionOpenCivilization', {}, 'CIVを開く'), 'open-civilization'), text(i18n, 'operation.tagFirst', {}, '初回')));
  return results;
}

export function buildOperationGuidance(state, i18n = null) {
  const operations = [
    ...firstTenMinuteOperations(state, i18n),
    ...incompleteProjectOperations(state, i18n),
    ...recoveryOperations(state, i18n),
    ...nearestEnemyBaseOperation(state, i18n),
    ...regionControlOperations(state, i18n),
    ...siegeOperations(state, i18n),
    ...workshopOperations(state, i18n),
    ...repairOperations(state, i18n)
  ];
  const unique = [];
  const seen = new Set();
  for (const item of operations.sort((a, b) => b.priority - a.priority)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
    if (unique.length >= MAX_OPERATIONS) break;
  }
  return { operations: unique, walkTargets: buildWalkTargets(state, i18n) };
}

export function buildWalkTargets(state, i18n = null) {
  const player = state.player?.worldPosition;
  if (!finitePoint(player)) return [];
  const targets = [];
  for (const item of state.world?.roadsideSupplies?.active ?? []) {
    if (!finitePoint(item)) continue;
    const rarityRank = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }[item.rarity] ?? 0;
    if (rarityRank < 2 && item.kind !== 'tactical') continue;
    targets.push({
      id: `supply:${item.id}`,
      kind: text(i18n, 'operation.walkKindSupply', {}, '物資'),
      title: localizedName(i18n, item.name ?? text(i18n, 'roadside.genericSupplyName', {}, '道端物資')),
      detail: joinParts(i18n, [rarityLabel(item.rarity, i18n), formatMeters(distance(player, item))]),
      meters: distance(player, item),
      priority: 40 + rarityRank * 10
    });
  }
  for (const item of state.world?.recoveryItems ?? []) {
    if (!isRecoveryItemVisible(item)) continue;
    const point = recoveryItemPoint(state, item);
    if (!finitePoint(point)) continue;
    targets.push({
      id: `recovery:${item.id}`,
      kind: text(i18n, 'operation.walkKindRecovery', {}, '回収'),
      title: localizedName(i18n, recoveryItemPresentation(item).name),
      detail: joinParts(i18n, [statusText(item.status, i18n), formatMeters(distance(player, point))]),
      meters: distance(player, point),
      priority: 70
    });
  }
  for (const base of state.world?.enemyBases ?? []) {
    if (!base.alive || base.hp <= 0) continue;
    const point = enemyBasePoint(state, base);
    if (!finitePoint(point)) continue;
    const meters = distance(player, point);
    if (meters > 900) continue;
    targets.push({
      id: `enemyBase:${base.id}`,
      kind: text(i18n, 'operation.walkKindAssault', {}, '攻略'),
      title: localizedName(i18n, ENEMY_BASE_DEFINITIONS[base.type]?.name ?? '敵拠点'),
      detail: joinParts(i18n, [`HP ${Math.ceil(base.hp)}/${Math.ceil(base.maxHp)}`, formatMeters(meters)]),
      meters,
      priority: 55
    });
  }
  return targets.sort((a, b) => b.priority - a.priority || a.meters - b.meters).slice(0, MAX_WALK_TARGETS);
}

function rarityLabel(rarity, i18n = null) {
  if (rarity === 'legendary') return text(i18n, 'roadside.rarityLegendary', {}, 'Legendary');
  if (rarity === 'epic') return text(i18n, 'roadside.rarityEpic', {}, 'Epic');
  if (rarity === 'rare') return text(i18n, 'roadside.rarityRare', {}, 'Rare');
  if (rarity === 'uncommon') return text(i18n, 'roadside.rarityUncommon', {}, 'Uncommon');
  return text(i18n, 'roadside.rarityCommon', {}, 'Common');
}

function statusText(status, i18n = null) {
  if (status === RECOVERY_ITEM_STATUS.RESERVED) return text(i18n, 'operation.recoveryStatusReserved', {}, '回収部隊移動中');
  if (status === RECOVERY_ITEM_STATUS.CARRIED) return text(i18n, 'operation.recoveryStatusCarried', {}, '搬送中');
  if (status === RECOVERY_ITEM_STATUS.COLLECTED) return text(i18n, 'operation.recoveryStatusCollected', {}, '回収済み');
  return text(i18n, 'operation.recoveryStatusAvailable', {}, '未回収');
}

function createTextNode(documentRef, tagName, className, content = '') {
  const node = documentRef.createElement(tagName);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}

function createOperationCard(documentRef, item) {
  const article = documentRef.createElement('article');
  article.className = 'opsCard';
  const content = documentRef.createElement('div');
  content.append(
    createTextNode(documentRef, 'span', '', item.tag ?? ''),
    createTextNode(documentRef, 'strong', '', item.title ?? ''),
    createTextNode(documentRef, 'small', '', item.detail ?? '')
  );
  article.append(content);
  const key = actionKey(item.action);
  if (key) {
    const button = createTextNode(documentRef, 'button', 'opsActionButton', actionLabel(item.action));
    button.type = 'button';
    button.dataset.operationAction = key;
    button.dataset.operationId = item.id ?? '';
    article.append(button);
  }
  return article;
}

function createWalkTargetCard(documentRef, item) {
  const article = documentRef.createElement('article');
  article.className = 'walkTargetCard';
  article.append(
    createTextNode(documentRef, 'span', '', item.kind ?? ''),
    createTextNode(documentRef, 'strong', '', item.title ?? ''),
    createTextNode(documentRef, 'small', '', item.detail ?? '')
  );
  return article;
}

function createOperationGrid(documentRef, operations, i18n) {
  const grid = documentRef.createElement('div');
  grid.className = 'opsGrid';
  if (operations.length) {
    for (const item of operations) grid.append(createOperationCard(documentRef, item));
  } else {
    grid.append(createTextNode(documentRef, 'p', 'emptyText', text(i18n, 'operation.noUrgentOps', {}, '現在は緊急の作戦目標はありません。周辺の敵・物資・文明条件を確認してください。')));
  }
  return grid;
}

function createWalkTargetGrid(documentRef, walkTargets, i18n) {
  const grid = documentRef.createElement('div');
  grid.className = 'walkTargetGrid';
  if (walkTargets.length) {
    for (const item of walkTargets) grid.append(createWalkTargetCard(documentRef, item));
  } else {
    grid.append(createTextNode(documentRef, 'p', 'emptyText', text(i18n, 'operation.noWalkTargets', {}, '現在地周辺に優先表示する徒歩目標はありません。')));
  }
  return grid;
}

function createOperationSection(documentRef, i18n, operations) {
  const section = documentRef.createElement('section');
  section.className = 'opsSummary';
  section.append(
    createTextNode(documentRef, 'h2', '', text(i18n, 'operation.nextOpsHeading', {}, 'NEXT OPS // 次の行動')),
    createTextNode(documentRef, 'p', 'sectionNote', text(i18n, 'operation.nextOpsNote', {}, '現在の状況から、次に有効な行動を優先順に表示します。')),
    createOperationGrid(documentRef, operations, i18n)
  );
  return section;
}

function createWalkTargetSection(documentRef, i18n, walkTargets) {
  const section = documentRef.createElement('section');
  section.className = 'opsSummary';
  section.append(
    createTextNode(documentRef, 'h2', '', text(i18n, 'operation.walkTargetsHeading', {}, 'WALK TARGETS // 近くの目標')),
    createWalkTargetGrid(documentRef, walkTargets, i18n)
  );
  return section;
}

export function renderOperationGuidance(guidance, i18n = null, documentRef = globalThis.document) {
  const fragment = documentRef.createDocumentFragment();
  const operations = guidance?.operations ?? [];
  const walkTargets = guidance?.walkTargets ?? [];
  fragment.append(
    createOperationSection(documentRef, i18n, operations),
    createWalkTargetSection(documentRef, i18n, walkTargets)
  );
  return fragment;
}
