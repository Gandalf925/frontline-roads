export const EXPLORATION_INTERACTION_RANGE_METERS = 0;

const DISABLED_PRESENTATION = Object.freeze({
  name: '廃止済み探索地点',
  duration: 0,
  icon: '',
  description: '探索ミッションは廃止済みです。現在は道端物資を利用します。',
  status: 'DISABLED'
});

export function explorationSitePresentation(_site) {
  return { ...DISABLED_PRESENTATION };
}

export function ensureExplorationState(state) {
  if (!state?.world) return [];
  state.world.explorationSites = [];
  state.world.exploredSiteChunks = [];
  return state.world.explorationSites;
}

export function reconcileExplorationSites(state) {
  return ensureExplorationState(state);
}

export class ExplorationSystem {
  constructor(_events) {}
  reconcile(state) { return ensureExplorationState(state); }
  beginInteraction(state, _siteId) {
    ensureExplorationState(state);
    return { ok: false, reasonKey: 'reason.exploration.deprecated', reason: '探索ミッションは廃止済みです。現在はITEMS画面の道端物資を利用してください。' };
  }
  update(state, _deltaSeconds = 0) {
    ensureExplorationState(state);
    return [];
  }
}
