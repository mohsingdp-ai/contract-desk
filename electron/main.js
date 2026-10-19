// Desktop wrapper: starts the same local server in-process and shows it in an app window.
// Settings (data folder, phone access, start with computer) live in the OS app-data folder.
import { app, BrowserWindow, Menu, dialog, shell, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CONTRACT_DESK_PORT || 4780);
const ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
if (process.env.CONTRACT_DESK_USER_DATA) app.setPath('userData', process.env.CONTRACT_DESK_USER_DATA); // tests

// Dialogs attach to the window only while it is visible: on Wayland, attaching to a hidden window crashes.
const owner = (win) => (win?.isVisible() ? [win] : []);

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
  app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : undefined);
  app.exit(0);
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
          {
            label: 'Change data folder…',
            click: async () => {
              const pick = await dialog.showOpenDialog(...owner(win), { title: 'Choose the data folder', defaultPath: s.dataDir, properties: ['openDirectory', 'createDirectory'] });
              if (pick.canceled || pick.filePaths[0] === s.dataDir) return;
              const { response } = await dialog.showMessageBox(...owner(win), {
                type: 'warning',
                message: 'Use this folder from now on?',
                detail: `${pick.filePaths[0]}\n\nNothing is moved. Your current records stay in:\n${s.dataDir}\nTo bring them along, close Contract Desk and copy everything from the old folder into the new one first.\n\nContract Desk restarts.`,
                buttons: ['Use this folder', 'Cancel'],
                cancelId: 1,
              });
              if (response === 0) saveSettings({ ...s, dataDir: pick.filePaths[0] }), restart();
            },
          },
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
    const s = loadSettings();
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
      show: !process.env.CONTRACT_DESK_HIDDEN, // tests
      webPreferences: { plugins: true }, // built-in PDF viewer for previews
    });
    // "Open in new tab" and other new windows go to the system browser (same local address, no passcode).
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`http://127.0.0.1:${PORT}/`)) shell.openExternal(url);
      return { action: 'deny' };
    });
    buildMenu(win, s, lan);
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    if (s.phoneAccess && ufwBlocksPort() && !process.env.CONTRACT_DESK_HIDDEN) showFirewallHelp(win, lan);
  });
}
