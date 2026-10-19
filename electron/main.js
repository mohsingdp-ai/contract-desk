// Desktop wrapper: starts the same local server in-process and shows it in an app window.
// Settings (data folder, phone access, start with computer) live in the OS app-data folder.
import { app, BrowserWindow, Menu, dialog, shell, clipboard, ipcMain } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CONTRACT_DESK_PORT || 4780);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(HERE, '..', 'build', 'icon.png');
const HIDDEN = !!process.env.CONTRACT_DESK_HIDDEN; // tests: no window
const TESTING = HIDDEN || !!process.env.CONTRACT_DESK_TEST; // tests: no first-run question, notices, firewall tip or relaunch
if (process.env.CONTRACT_DESK_USER_DATA) app.setPath('userData', process.env.CONTRACT_DESK_USER_DATA); // tests

// Dialogs attach to the window only while it is visible: on Wayland, attaching to a hidden window crashes.
const owner = (win) => (win?.isVisible() ? [win] : []);
const box = (win, opts) => dialog.showMessageBox(...owner(win), opts);

// ---------- settings ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {}
  return { dataDir: path.join(app.getPath('documents'), 'Contract Desk'), phoneAccess: false, ...saved };
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
// Easy to read out and type on a phone: no 0/O or 1/l look-alikes.
const newPasscode = () => [...randomBytes(8)].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

function restart() {
  if (!TESTING) app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : undefined);
  app.exit(0);
}

// ---------- data folder ----------

const DB_FILE = 'contracts.db';
const hasDb = (dir) => fs.existsSync(path.join(dir, DB_FILE));
function recordCounts(dir) {
  if (!hasDb(dir)) return null;
  try {
    const d = new DatabaseSync(path.join(dir, DB_FILE), { readOnly: true });
    const c = d.prepare('SELECT (SELECT count(*) FROM contracts) AS contracts, (SELECT count(*) FROM nocs) AS nocs, (SELECT count(*) FROM documents) AS documents').get();
    d.close();
    return c;
  } catch {
    return null;
  }
}
const hasRecords = (dir) => {
  const c = recordCounts(dir);
  return !!c && c.contracts + c.nocs + c.documents > 0;
};
const describe = (c) => `${c.contracts} contracts, ${c.nocs} NOCs, ${c.documents} documents`;
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.contract-desk-write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

// Ask for a folder and decide what to do with it. Returns settings changes, or null when nothing changes.
async function chooseDataFolder(win, s, { firstRun = false } = {}) {
  const pick = await dialog.showOpenDialog(...owner(win), {
    title: 'Choose where Contract Desk keeps your records',
    defaultPath: s.dataDir,
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (pick.canceled || !pick.filePaths[0]) return null;
  const dir = path.resolve(pick.filePaths[0]);
  if (dir === path.resolve(s.dataDir)) return null;
  if (!writable(dir)) {
    await box(win, { type: 'error', message: 'Contract Desk can’t save in that folder', detail: `${dir}\n\nChoose a folder you’re allowed to write to.` });
    return null;
  }
  const current = !firstRun && hasRecords(s.dataDir) ? recordCounts(s.dataDir) : null;
  if (hasRecords(dir)) {
    const { response } = await box(win, {
      type: 'question',
      message: 'Open the records in this folder?',
      detail: `${dir}\nalready holds Contract Desk records (${describe(recordCounts(dir))}). Contract Desk will use them from now on.` + (current ? `\n\nYour current records stay where they are, in:\n${s.dataDir}` : '') + '\n\nContract Desk restarts.',
      buttons: ['Open these records', 'Cancel'],
      cancelId: 1,
    });
    return response === 0 ? { dataDir: dir } : null;
  }
  if (current) {
    const { response } = await box(win, {
      type: 'question',
      message: 'Bring your records along?',
      detail: `Move your records (${describe(current)}) and their files to:\n${dir}\n\nThey are copied and checked before Contract Desk switches. The old folder is left as it is until you delete it.\n\nContract Desk restarts.`,
      buttons: ['Move my records there', 'Start empty there', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return null;
    return response === 0 ? { dataDir: dir, moveFrom: s.dataDir } : { dataDir: dir };
  }
  return { dataDir: dir };
}

// Runs before the server opens the database: copy, verify, and only then switch. On any problem keep the old folder.
function finishPendingMove(s) {
  if (!s.moveFrom) return null;
  const from = s.moveFrom;
  const to = s.dataDir;
  delete s.moveFrom;
  const destDb = path.join(to, DB_FILE);
  const copied = [];
  try {
    if (hasDb(to)) throw new Error(`${to} already has a Contract Desk database`);
    fs.mkdirSync(to, { recursive: true });
    const src = new DatabaseSync(path.join(from, DB_FILE));
    src.exec(`VACUUM INTO '${destDb.replaceAll("'", "''")}'`); // one consistent copy, including anything still in the WAL
    copied.push(destDb);
    const stored = src.prepare('SELECT file_path FROM documents').all();
    src.close();
    // Copy only the app's own files: records' attachments and the phone-session key.
    for (const rel of [...stored.map((r) => r.file_path), 'session.key']) {
      const a = path.join(from, rel);
      const b = path.join(to, rel);
      if (!fs.existsSync(a)) continue;
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
      copied.push(b);
      if (fs.statSync(a).size !== fs.statSync(b).size) throw new Error(`Copy of ${rel} is incomplete`);
    }
    const check = new DatabaseSync(destDb, { readOnly: true });
    const ok = check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' && check.prepare('SELECT count(*) AS n FROM documents').get().n === stored.length;
    check.close();
    if (!ok) throw new Error('The copied database did not match the original');
    saveSettings(s);
    return { ok: true, from, to, documents: stored.length };
  } catch (err) {
    for (const f of copied) fs.rmSync(f, { force: true });
    s.dataDir = from;
    saveSettings(s);
    return { ok: false, from, to, error: err.message };
  }
}

// ---------- start with the computer ----------

// Windows has a built-in login-item API; Linux uses an XDG autostart entry pointing at the AppImage.
const autostartFile = () => path.join(app.getPath('appData'), 'autostart', 'contract-desk.desktop');
function getOpenAtLogin() {
  return process.platform === 'linux' ? fs.existsSync(autostartFile()) : app.getLoginItemSettings().openAtLogin;
}
function setOpenAtLogin(on) {
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: on });
  if (!on) return fs.rmSync(autostartFile(), { force: true });
  const exec = process.env.APPIMAGE || `${process.execPath} ${app.getAppPath()}`;
  fs.mkdirSync(path.dirname(autostartFile()), { recursive: true });
  fs.writeFileSync(autostartFile(), `[Desktop Entry]\nType=Application\nName=Contract Desk\nExec="${exec}"\nX-GNOME-Autostart-enabled=true\n`);
}

// ---------- Linux firewall ----------

// ufw silently drops phone connections unless the port is allowed; its config files are world-readable.
function ufwBlocksPort() {
  if (process.platform !== 'linux') return false;
  try {
    const on = /^ENABLED=yes/m.test(fs.readFileSync('/etc/ufw/ufw.conf', 'utf8'));
    return on && !new RegExp(`--dport ${PORT}\\b`).test(fs.readFileSync('/etc/ufw/user.rules', 'utf8'));
  } catch {
    return false;
  }
}
async function showFirewallHelp(win, lan) {
  // Allow only this computer's own network (e.g. 192.168.1.0/24), not the whole internet.
  const subnet = lan[0] ? lan[0].replace(/\.\d+$/, '.0/24') : '192.168.0.0/16';
  const cmd = `sudo ufw allow from ${subnet} to any port ${PORT} proto tcp`;
  const { response } = await dialog.showMessageBox(...owner(win), {
    type: 'info',
    title: 'Allow phones through the firewall',
    message: 'Your firewall is blocking phones',
    detail: `Open a terminal and run this once (it asks for your password):\n\n${cmd}\n\nIt only allows devices on your home network.`,
    buttons: ['Copy command', 'Close'],
    defaultId: 0,
  });
  if (response === 0) clipboard.writeText(cmd);
}

// ---------- menu ----------

function buildMenu(win, s, lan) {
  const phoneItems = s.phoneAccess
    ? [
        { label: 'Phone access is on', enabled: false },
        { label: `Address: ${lan[0] ? `http://${lan[0]}:${PORT}` : 'no Wi-Fi network found'}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Show passcode…',
          click: async () => {
            const { response } = await dialog.showMessageBox(...owner(win), {
              type: 'info',
              title: 'Phone passcode',
              message: s.passcode,
              detail: 'Easier: use "Connect phone" in the sidebar and scan the QR code.\nA passcode is only needed if you type the address on the phone yourself.',
              buttons: ['Copy', 'Close'],
            });
            if (response === 0) clipboard.writeText(s.passcode);
          },
        },
        ...(process.platform === 'linux' ? [{ label: 'Firewall help…', click: () => showFirewallHelp(win, lan) }] : []),
        {
          label: 'Change passcode (logs out all phones)',
          click: async () => {
            const { response } = await dialog.showMessageBox(...owner(win), {
              type: 'warning',
              message: 'Make a new passcode?',
              detail: 'Every connected phone will need to scan a new QR code or enter the new passcode. Contract Desk restarts.',
              buttons: ['New passcode', 'Cancel'],
              cancelId: 1,
            });
            if (response === 0) saveSettings({ ...s, passcode: newPasscode() }), restart();
          },
        },
        { type: 'separator' },
        {
          label: 'Turn phone access off',
          click: () => (saveSettings({ ...s, phoneAccess: false }), restart()),
        },
      ]
    : [
        {
          label: 'Turn phone access on…',
          click: async () => {
            const { response } = await dialog.showMessageBox(...owner(win), {
              type: 'question',
              message: 'Let phones on your Wi-Fi open Contract Desk?',
              detail:
                'Phones connect by scanning a QR code (the "Connect phone" button in the sidebar), or with a passcode.\n\n' +
                'Phones can reach it while Contract Desk is open on this computer (minimized is fine).' +
                (process.platform === 'win32' ? '\n\nWindows may ask to allow Contract Desk on private networks: click Allow.' : '') +
                '\n\nContract Desk restarts to turn this on.',
              buttons: ['Turn on', 'Cancel'],
              cancelId: 1,
            });
            if (response === 0) saveSettings({ ...s, phoneAccess: true, passcode: s.passcode || newPasscode() }), restart();
          },
        },
      ];

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Open data folder', click: () => shell.openPath(s.dataDir) },
          { label: 'Change data folder…', click: () => changeDataFolder(win, s) },
          { type: 'separator' },
          {
            label: 'Start when the computer starts',
            type: 'checkbox',
            checked: getOpenAtLogin(),
            click: (item) => setOpenAtLogin(item.checked),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { label: 'Phone', submenu: phoneItems },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
    ]),
  );
}

async function changeDataFolder(win, s) {
  const change = await chooseDataFolder(win, s);
  if (change) saveSettings({ ...s, ...change }), restart();
}

// ---------- start ----------

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let win;
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    const firstRun = !fs.existsSync(settingsFile());
    const s = loadSettings();
    if (firstRun && !TESTING) {
      const { response } = await box(null, {
        type: 'question',
        title: 'Contract Desk',
        message: 'Where should Contract Desk keep your records?',
        detail: `Your contracts, NOCs and their files are saved in one folder.\n\nSuggested: ${s.dataDir}\n\nYou can change this later from the sidebar or File → Change data folder.`,
        buttons: ['Use the suggested folder', 'Choose another folder…'],
        defaultId: 0,
      });
      if (response === 1) Object.assign(s, (await chooseDataFolder(null, s, { firstRun: true })) || {});
    }
    if (firstRun) saveSettings(s);
    const moved = finishPendingMove(s);
    if (s.phoneAccess && !s.passcode) {
      s.passcode = newPasscode();
      saveSettings(s);
    }
    process.env.DATA_DIR = s.dataDir;
    process.env.PORT = String(PORT);
    process.env.LAN_PASSCODE = s.phoneAccess ? s.passcode : '';

    let lan = [];
    try {
      ({ lanAddresses: lan } = await (await import('../server/index.js')).ready);
    } catch (err) {
      dialog.showErrorBox(
        'Contract Desk could not start',
        err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use: another copy of Contract Desk, or another program, is running. Close it and try again.` : String(err.stack || err),
      );
      return app.exit(1);
    }

    win = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 380,
      minHeight: 500,
      title: 'Contract Desk',
      icon: ICON,
      backgroundColor: '#17160f',
      show: !HIDDEN,
      webPreferences: { plugins: true, preload: path.join(HERE, 'preload.cjs') }, // plugins: built-in PDF viewer for previews
    });
    const origin = `http://127.0.0.1:${PORT}/`;
    // The window only ever shows this app; anything else opens in the system browser.
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(origin)) e.preventDefault(), shell.openExternal(url);
    });
    ipcMain.handle('data-folder:open', (e) => e.sender === win.webContents && shell.openPath(s.dataDir));
    ipcMain.handle('data-folder:choose', (e) => e.sender === win.webContents && changeDataFolder(win, s));
    // "Open in new tab" and other new windows go to the system browser (same local address, no passcode).
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`http://127.0.0.1:${PORT}/`)) shell.openExternal(url);
      return { action: 'deny' };
    });
    buildMenu(win, s, lan);
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    if (moved && !TESTING)
      await box(win, moved.ok
        ? { type: 'info', message: 'Your records have moved', detail: `Now saved in:\n${moved.to}\n\nThe old folder was left as it was:\n${moved.from}\nDelete it once you’ve checked everything is here.` }
        : { type: 'error', message: 'Your records could not be moved', detail: `${moved.error}\n\nNothing was changed: Contract Desk is still using\n${moved.from}` });
    if (s.phoneAccess && ufwBlocksPort() && !TESTING) showFirewallHelp(win, lan);
  });
}
