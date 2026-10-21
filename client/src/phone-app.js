// Phone app (Android) only: the back button and the optional fingerprint / face lock. Like phone.js, native calls go
// straight to the plugins by their bridge names: App (@capacitor/app) and BiometricAuthNative
// (@aparajita/capacitor-biometric-auth, which falls back to the phone's PIN / pattern).
const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;

// Back button: closes an open dialog or document first, then goes back through screens; only Search exits the app.
// Dialogs and the document drawer already close on Escape, so the button sends one.
export function handleBackButton() {
  cap.nativeCallback('App', 'addListener', { eventName: 'backButton' }, ({ canGoBack }) => {
    const home = (location.hash.slice(1).split('?')[0] || '/') === '/';
    if (document.querySelector('.lock-screen')) cap.nativePromise('App', 'exitApp');
    else if (document.querySelector('.scrim, .drawer-scrim')) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    else if (!home) canGoBack ? backThroughScreens(location.hash) : location.replace('#/');
    else cap.nativePromise('App', 'exitApp');
  });
}
// Skips history entries that would only re-open a closed dialog or document (?new=, ?doc=) or repeat this screen
// (closing a dialog leaves one).
function backThroughScreens(from) {
  const skip = () => (location.hash === from || /[?&](new|doc)=/.test(location.hash)) && backThroughScreens(from);
  window.addEventListener('popstate', skip, { once: true });
  history.back();
}

// ---------- lock ----------

const KEY = 'contract-desk-lock';
const AWAY = 3 * 60 * 1000; // locks again after this long in the background
// ponytail: the switch lives in this WebView's localStorage, so a force-stop right after turning it on can forget it
// (decision-2 gotcha); it then just stays off, which never locks anyone out. Move it into the database if that matters.
export function lockOn() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
export function setLockOn(on) {
  try {
    on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY);
  } catch {}
}

// Why this phone can't lock the app, or '' when it can (a fingerprint, face, or at least a screen lock PIN is set).
export async function lockUnavailable() {
  try {
    const b = await cap.nativePromise('BiometricAuthNative', 'checkBiometry');
    return b.isAvailable || b.deviceIsSecure ? '' : 'Set a screen lock (PIN, pattern, fingerprint or face) in the phone’s Settings first.';
  } catch {
    return 'This phone can’t check a fingerprint or face.';
  }
}

// True when unlocked. Never locks the owner out of their records: if the phone has no way left to check (fingerprints
// and screen lock removed), it lets them in.
export async function unlock() {
  if (await lockUnavailable()) return true;
  try {
    await cap.nativePromise('BiometricAuthNative', 'internalAuthenticate', {
      reason: 'Unlock your records',
      androidTitle: 'Contract Desk',
      allowDeviceCredential: true, // the phone's PIN / pattern always works too
    });
    return true;
  } catch {
    return false;
  }
}

// Calls onLock when the app comes back after a while in the background and the lock is on.
export function watchLock(onLock) {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (lockOn() && Date.now() - hiddenAt > AWAY) onLock();
  });
}
