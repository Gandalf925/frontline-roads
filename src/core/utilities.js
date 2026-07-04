export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const distanceSquared = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const distance = (a, b) => Math.sqrt(distanceSquared(a, b));
export const deepClone = value => value == null ? value : (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function formatMeters(meters) {
  return meters < 1000 ? `${Math.round(meters)}m` : `${(meters / 1000).toFixed(1)}km`;
}

export function stableId(prefix, ...parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}

export function worldNow(state) {
  // Deterministic simulation clock. World time is anchored once at state
  // creation and advanced only by simulation steps, so identical command logs
  // replay to identical timestamps on every client. Never mix wall-clock
  // timestamps into simulation state.
  return Number(state?.runtime?.worldTimeMs) || 0;
}
