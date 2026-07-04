import { ROAD_CONFIG } from '../core/constants.js';
import { formatMeters } from '../core/utilities.js';
import { queryRequired, setVisible } from './dom.js';

function viewportSize(documentRef) {
  const root = documentRef.documentElement;
  return {
    width: Math.max(1, globalThis.innerWidth || root.clientWidth || 1),
    height: Math.max(1, globalThis.innerHeight || root.clientHeight || 1)
  };
}

export class BasePlacementScreen {
  constructor(root = document, { i18n = null } = {}) {
    this.overlay = queryRequired('#basePlacementOverlay', root);
    this.mapViewport = queryRequired('#baseMapViewport', root);
    this.status = queryRequired('#basePlacementStatus', root);
    this.confirmButton = queryRequired('#confirmBase', root);
    this.retryButton = queryRequired('#retryLocation', root);
    this.zoomInButton = queryRequired('#zoomIn', root);
    this.zoomOutButton = queryRequired('#zoomOut', root);
    this.recenterButton = queryRequired('#recenter', root);
    this.i18n = i18n;
    this.statusSource = this.status.textContent;
    this.document = this.overlay.ownerDocument;
    this.documentRoot = this.document.documentElement;
    this.syncFrame = null;
    this.boundSyncViewport = () => this.scheduleViewportSync();
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(this.boundSyncViewport)
      : null;
    this.resizeObserver?.observe(this.mapViewport);
    globalThis.addEventListener?.('resize', this.boundSyncViewport);
    globalThis.addEventListener?.('orientationchange', this.boundSyncViewport);
    this.refreshLocalization();
    this.scheduleViewportSync();
  }

  scheduleViewportSync() {
    if (this.syncFrame != null) return;
    const schedule = globalThis.requestAnimationFrame
      ? callback => globalThis.requestAnimationFrame(callback)
      : callback => setTimeout(callback, 0);
    this.syncFrame = schedule(() => {
      this.syncFrame = null;
      this.syncViewportClip();
    });
  }

  syncViewportClip() {
    const rect = this.mapViewport.getBoundingClientRect();
    const viewport = viewportSize(this.document);
    const top = Math.max(0, Math.round(rect.top));
    const right = Math.max(0, Math.round(viewport.width - rect.right));
    const bottom = Math.max(0, Math.round(viewport.height - rect.bottom));
    const left = Math.max(0, Math.round(rect.left));
    this.documentRoot.style.setProperty('--base-map-top', `${top}px`);
    this.documentRoot.style.setProperty('--base-map-right', `${right}px`);
    this.documentRoot.style.setProperty('--base-map-bottom', `${bottom}px`);
    this.documentRoot.style.setProperty('--base-map-left', `${left}px`);
  }

  localize(text) {
    return this.i18n?.copy?.(text) ?? String(text ?? '');
  }

  localizeStatus(message) {
    if (message && typeof message === 'object' && message.key) {
      return this.i18n?.message?.(message.key, message.params ?? {}, message.text ?? '') ?? String(message.text ?? message.key);
    }
    return this.localize(message);
  }

  setStatus(message) {
    this.statusSource = message ?? '';
    this.status.textContent = this.localizeStatus(this.statusSource);
  }

  refreshLocalization() {
    if (this.statusSource) this.status.textContent = this.localizeStatus(this.statusSource);
  }

  showLoading(message) {
    setVisible(this.overlay, true);
    this.setStatus(message);
    this.confirmButton.disabled = true;
    this.scheduleViewportSync();
  }

  showSelection(selection, { roadsPending = false } = {}) {
    this.scheduleViewportSync();
    if (!selection) {
      const radiusKm = ROAD_CONFIG.selectionRadiusMeters / 1000;
      this.setStatus(roadsPending
        ? { key: 'basePlacement.previewRoadsShown', params: { radiusKm }, text: `中心部の道路を先行表示しました。${radiusKm}km以内の道路を選びながら、周辺道路の取得を待てます。` }
        : { key: 'basePlacement.selectRoadPrompt', params: { radiusKm }, text: `現在地から${radiusKm}km以内の道路をタップしてください。` });
      this.confirmButton.disabled = true;
      return;
    }
    if (!selection.valid) {
      this.setStatus({
        key: 'basePlacement.tooFar',
        params: { distanceText: formatMeters(selection.distanceFromOrigin), radiusKm: 1 },
        text: `${formatMeters(selection.distanceFromOrigin)}離れています。1km以内の道路を選択してください。`
      });
      this.confirmButton.disabled = true;
      return;
    }
    const distanceText = formatMeters(selection.distanceFromOrigin);
    this.setStatus(roadsPending
      ? { key: 'basePlacement.selectingPending', params: { distanceText }, text: `${distanceText}先の道路を選択中です。周辺道路の取得が完了すると確定できます。` }
      : { key: 'basePlacement.selectingReady', params: { distanceText }, text: `${distanceText}先の道路を選択中です。確定すると、その道路を中心に即時開始します。` });
    this.confirmButton.disabled = roadsPending;
  }

  hide() {
    setVisible(this.overlay, false);
  }

  showError(message) {
    setVisible(this.overlay, true);
    this.setStatus(message);
    this.confirmButton.disabled = true;
    this.scheduleViewportSync();
  }

  destroy() {
    this.resizeObserver?.disconnect();
    globalThis.removeEventListener?.('resize', this.boundSyncViewport);
    globalThis.removeEventListener?.('orientationchange', this.boundSyncViewport);
    if (this.syncFrame != null) {
      if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(this.syncFrame);
      else clearTimeout(this.syncFrame);
      this.syncFrame = null;
    }
  }
}
