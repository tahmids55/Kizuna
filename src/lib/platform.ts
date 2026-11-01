import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';
import { isNative } from './api';

/* -------------------------------------------------------- overlay stack */

/** Open dialogs/sheets register here so the Android back button closes them first. */
const overlays: (() => void)[] = [];
export function pushOverlay(close: () => void) {
  overlays.push(close);
  return () => {
    const i = overlays.lastIndexOf(close);
    if (i >= 0) overlays.splice(i, 1);
  };
}
export function closeTopOverlay() {
  const close = overlays.at(-1);
  if (!close) return false;
  close();
  return true;
}

/* ------------------------------------------------------------ app state */

let appActive = true;
export const isAppActive = () => appActive && document.visibilityState === 'visible';

let navigateFn: (to: string) => void = () => {};
let initialized = false;

/**
 * Wire up native listeners exactly once. The router's navigate function changes on
 * every route change, so we only swap the reference — re-registering listeners
 * would make one back press fire several handlers.
 */
export async function initPlatform(navigate: (to: string) => void) {
  navigateFn = navigate;
  if (!isNative || initialized) return;
  initialized = true;
  document.documentElement.classList.add('native');
  App.addListener('appStateChange', ({ isActive }) => {
    appActive = isActive;
  });
  App.addListener('backButton', () => {
    if (closeTopOverlay()) return;
    const path = location.pathname;
    if (path !== '/chats' && path !== '/') navigateFn('/chats');
    else App.minimizeApp();
  });
  LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const to = e.notification.extra?.to;
    if (typeof to === 'string') navigateFn(to);
  });
  syncStatusBar();
}

export async function syncStatusBar() {
  if (!isNative) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  try {
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
    await StatusBar.setBackgroundColor({ color: dark ? '#121a1a' : '#ffffff' });
  } catch {
    /* not supported on this device */
  }
}

/* -------------------------------------------------------- notifications */

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export async function notificationPermission(): Promise<NotifyPermission> {
  if (isNative) {
    const p = await LocalNotifications.checkPermissions();
    return p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'default';
  }
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function requestNotifications(): Promise<NotifyPermission> {
  if (isNative) {
    const p = await LocalNotifications.requestPermissions();
    return p.display === 'granted' ? 'granted' : 'denied';
  }
  if (!('Notification' in window)) return 'unsupported';
  return Notification.requestPermission();
}

let seq = 1;
export async function notify(title: string, body: string, to: string) {
  if (localStorage.getItem('kizuna-notify') === 'off') return;
  if (isNative) {
    try {
      await LocalNotifications.schedule({ notifications: [{ id: seq++, title, body: body.slice(0, 200), extra: { to }, smallIcon: 'ic_stat_kizuna' }] });
    } catch {
      /* permission not granted */
    }
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body: body.slice(0, 200), icon: '/icon.svg', tag: to });
  n.onclick = () => {
    window.focus();
    navigateFn(to);
    n.close();
  };
}
