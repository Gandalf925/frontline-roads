import { APP_VERSION } from '../core/constants.js';

export async function registerPwa({
  navigatorRef = globalThis.navigator,
  locationRef = globalThis.location,
  globalRef = globalThis,
  moduleUrl = import.meta.url
} = {}) {
  const hostname = locationRef?.hostname ?? '';
  const protocol = locationRef?.protocol ?? '';
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  if (!navigatorRef?.serviceWorker?.register) return null;
  if (protocol !== 'https:' && !localHost) return null;
  try {
    if (globalRef.__FRONTLINE_SW_READY__?.then) return await globalRef.__FRONTLINE_SW_READY__;
    const appRoot = new URL('../../', moduleUrl);
    const workerUrl = new URL('sw.js', appRoot);
    const releaseVersion = globalRef.__FRONTLINE_RELEASE__?.version ?? APP_VERSION;
    workerUrl.searchParams.set('v', releaseVersion);
    const reloadKey = `frontline-sw-reload:${releaseVersion}`;
    navigatorRef.serviceWorker.addEventListener?.('controllerchange', () => {
      try {
        if (globalRef.sessionStorage?.getItem(reloadKey) === '1') return;
        globalRef.sessionStorage?.setItem(reloadKey, '1');
        locationRef.reload?.();
      } catch {
        locationRef.reload?.();
      }
    }, { once: true });
    const registration = await navigatorRef.serviceWorker.register(workerUrl.href, { scope: appRoot.href, updateViaCache: 'none' });
    await registration.update?.().catch?.(() => {});
    return registration;
  } catch (error) {
    console.warn('Service worker registration failed', error);
    return null;
  }
}
