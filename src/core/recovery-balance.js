export const RECOVERY_BALANCE = Object.freeze({
  defenseBreakthroughRegroupSeconds: 150,
  towerRepairCostMultiplier: 0.55
});

export function beginEnemyRegroup(state, seconds) {
  const now = Math.max(0, Number(state.runtime?.worldTimeMs) || 0);
  const until = now + Math.max(0, Number(seconds) || 0) * 1000;
  state.combat.enemyRegroupUntil = Math.max(Number(state.combat.enemyRegroupUntil) || 0, until);
  return state.combat.enemyRegroupUntil;
}

export function enemyRegroupActive(state) {
  return (Number(state.combat?.enemyRegroupUntil) || 0) > (Number(state.runtime?.worldTimeMs) || 0);
}
