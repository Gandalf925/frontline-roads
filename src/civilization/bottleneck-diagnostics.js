import { CIVILIZATION_PROJECTS, PRODUCTION_RECIPES, RESOURCE_KEYS } from './data.js';
import { evaluateProject, projectContributionReserve, safeProjectContributionAmount } from './progression-system.js';

export const RESOURCE_ROUTE_HINTS = Object.freeze({
  wood: Object.freeze({ roadsideTier: 'base', enemyType: 'basicCamp' }),
  stone: Object.freeze({ roadsideTier: 'base', enemyType: 'basicCamp' }),
  fiber: Object.freeze({ roadsideTier: 'base', enemyType: 'raiderCamp' }),
  timber: Object.freeze({ roadsideTier: 'processed', enemyType: 'basicCamp' }),
  rope: Object.freeze({ roadsideTier: 'processed', enemyType: 'raiderCamp' }),
  cutStone: Object.freeze({ roadsideTier: 'processed', enemyType: 'stoneCamp' }),
  charcoal: Object.freeze({ roadsideTier: 'processed', enemyType: 'kilnCamp' }),
  copperOre: Object.freeze({ roadsideTier: 'ore', enemyType: 'copperCamp' }),
  tinOre: Object.freeze({ roadsideTier: 'ore', enemyType: 'tinCamp' }),
  ironOre: Object.freeze({ roadsideTier: 'ore', enemyType: 'ironCamp' }),
  copperIngot: Object.freeze({ roadsideTier: 'metal', enemyType: 'copperCamp' }),
  tinIngot: Object.freeze({ roadsideTier: 'metal', enemyType: 'tinCamp' }),
  bronzeIngot: Object.freeze({ roadsideTier: 'metal', enemyType: 'bronzeCamp' }),
  ironBloom: Object.freeze({ roadsideTier: 'metal', enemyType: 'ironCamp' }),
  wroughtIron: Object.freeze({ roadsideTier: 'metal', enemyType: 'ironCamp' }),
  steel: Object.freeze({ roadsideTier: 'metal', enemyType: 'steelCamp' }),
  mechanism: Object.freeze({ roadsideTier: 'metal', enemyType: 'machineWorks' })
});

export function productionRecipesForResource(resourceKey) {
  if (!RESOURCE_KEYS.includes(resourceKey)) return [];
  return Object.entries(PRODUCTION_RECIPES)
    .filter(([, recipe]) => Number(recipe?.output?.[resourceKey]) > 0)
    .map(([key, recipe]) => ({ key, recipe }));
}

export function acquisitionGuideForResource(resourceKey) {
  const hint = RESOURCE_ROUTE_HINTS[resourceKey] ?? Object.freeze({ roadsideTier: 'base', enemyType: 'basicCamp' });
  return {
    resourceKey,
    roadsideTier: hint.roadsideTier,
    enemyType: hint.enemyType,
    recipes: productionRecipesForResource(resourceKey)
  };
}

function projectContributionChecks(state) {
  const evaluation = evaluateProject(state);
  const project = evaluation.project;
  if (!project) return [];
  const definition = CIVILIZATION_PROJECTS[project.targetLevel];
  return Object.entries(definition?.contributions ?? {}).map(([key, required]) => {
    const contributed = Math.max(0, Number(project.contributions?.[key]) || 0);
    const remaining = Math.max(0, Number(required) - contributed);
    const inventory = Math.max(0, Math.floor(Number(state.inventory?.resources?.[key]) || 0));
    const safeAmount = safeProjectContributionAmount(state, key);
    const reserve = projectContributionReserve(state, key);
    const shortage = Math.max(0, remaining - inventory);
    return {
      kind: 'resource',
      key,
      required: Number(required) || 0,
      contributed,
      remaining,
      inventory,
      safeAmount,
      reserve,
      shortage,
      complete: remaining <= 0,
      guide: acquisitionGuideForResource(key)
    };
  });
}

export function projectResourceBottlenecks(state, { limit = 3 } = {}) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (max <= 0) return [];
  return projectContributionChecks(state)
    .filter(check => !check.complete)
    .sort((a, b) => {
      const aScore = a.shortage > 0 ? a.shortage : Math.max(0, a.remaining - a.safeAmount) * 0.5;
      const bScore = b.shortage > 0 ? b.shortage : Math.max(0, b.remaining - b.safeAmount) * 0.5;
      if (bScore !== aScore) return bScore - aScore;
      if (b.remaining !== a.remaining) return b.remaining - a.remaining;
      return RESOURCE_KEYS.indexOf(a.key) - RESOURCE_KEYS.indexOf(b.key);
    })
    .slice(0, max);
}

export function hasProjectResourceBottlenecks(state) {
  return projectResourceBottlenecks(state, { limit: 1 }).length > 0;
}
