import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs, fmtAmount, fmtDate, isPhone, checkRestore, applyRestore, cancelRestore } from './api.js';
import { REMIND_AFTER_DAYS } from '../../core/backup.js';
import * as phone from './phone.js';
import * as phoneApp from './phone-app.js';
import { Icon, Hl, Modal, Confirm, Field, Pager, DocRow, UploadDialog, DocDrawer, DeleteDocConfirm, PhoneSpace } from './ui.jsx';

// ---------- hash routing: #/path?query ----------

function parseHash() {
  const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
  return {
    path,
    parts: path.split('/').filter(Boolean),
    params: Object.fromEntries(new URLSearchParams(query)),
  };
}

function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((path, params = {}, { replace } = {}) => {
    const url = `#${path}${qs(params)}`;
    if (replace) {
      history.replaceState(null, '', url);
      setRoute(parseHash());
    } else location.hash = url.slice(1);
  }, []);
  return [route, go];
}

// Fetch JSON for `url`, refetching whenever the url or `version` changes.
function useData(url, version, delay = 0) {
  const [state, setState] = useState({ data: null, error: '' });
  useEffect(() => {
    if (!url) return;
    let live = true;
    const t = setTimeout(() => {
      api('GET', url)
        .then((data) => live && setState({ data, error: '' }))
        .catch((e) => live && setState((s) => ({ data: s.data, error: e.message })));
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [url, version, delay]);
  return state;
}

const FILTER_KEYS = ['q', 'project', 'firm', 'currency', 'min', 'max', 'category', 'file_type', 'tag', 'sort'];
const pick = (params, keys = FILTER_KEYS) => Object.fromEntries(keys.filter((k) => params[k]).map((k) => [k, params[k]]));
const CONTRACT_ONLY = ['project', 'firm', 'currency', 'min', 'max'];

// ---------- app shell ----------

// Phone app with the lock on: the lock covers the desk instead of replacing it, so a half-filled form survives it.
export default function App() {
  const [locked, setLocked] = useState(() => isPhone && phoneApp.lockOn());
  useEffect(() => void (isPhone && phoneApp.watchLock(() => setLocked(true))), []);
  return (
    <>
      <Desk />
      {locked && <LockScreen onUnlock={() => setLocked(false)} />}
    </>
  );
}

function Desk() {
  const [route, go] = useRoute();
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const { data: meta } = useData('/api/meta', version); // categories can change while the app is open
  const { data: facets } = useData('/api/facets', version);
  const [needPasscode, setNeedPasscode] = useState(false);
  // After a backup, the last-backup time (and so the reminder) is read again. The desktop's backup is a download the page
  // can't follow: it counts once saved, so look again when the window is back from the save dialog, and shortly after.
  const onBackup = useCallback(() => {
    if (isPhone) return bump();
    window.addEventListener('focus', bump, { once: true });
    setTimeout(bump, 2000);
  }, [bump]);
  const [phoneStatus, setPhoneStatus] = useState(phone.status);
  useEffect(() => {
    if (!isPhone) return;
    const on = () => setPhoneStatus(phone.status);
    window.addEventListener('phone-status', on);
    phone.start();
    phoneApp.handleBackButton();
    return () => window.removeEventListener('phone-status', on);
  }, []);
  useEffect(() => {
    const on = () => setNeedPasscode(true);
    window.addEventListener('passcode-required', on);
    return () => window.removeEventListener('passcode-required', on);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        if (route.parts.length) go('/');
        setTimeout(() => document.querySelector('.search-hero input')?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route, go]);

  if (needPasscode) return <PasscodeScreen />;
  if (isPhone && phoneStatus.name !== 'ready') return <PhoneSetup status={phoneStatus} />;
  if (!meta || !facets) return <div className="boot">Opening the desk…</div>;

  const { doc, ...params } = route.params;
  const ctx = {
    route: { ...route, params },
    go,
    meta,
    facets,
    version,
    bump,
    onBackup,
    tagNames: facets.tags.map((t) => t.name),
    openDoc: (id) => go(route.path, { ...params, doc: id }),
    openParent: (p) => go(`/${p.type === 'contract' ? 'contracts' : 'nocs'}/${p.id}`),
  };
  const [section, id] = route.parts;

  return (
    <div className="shell">
      <Rail section={section} facets={facets} meta={meta} />
      <main className="main" key={route.path}>
        {!section && <SearchPage {...ctx} />}
        {section === 'contracts' && !id && <ContractsPage {...ctx} />}
        {section === 'contracts' && id && <ContractDetail {...ctx} id={id} />}
        {section === 'nocs' && !id && <NocsPage {...ctx} />}
        {section === 'nocs' && id && <NocDetail {...ctx} id={id} />}
        {section === 'categories' && <CategoriesPage {...ctx} />}
        {section === 'settings' && <SettingsPage {...ctx} />}
      </main>
      {doc && (
        <DocDrawer id={doc} meta={meta} tagSuggestions={ctx.tagNames} onClose={() => go(route.path, params)} onChanged={bump} onOpenParent={ctx.openParent} />
      )}
    </div>
  );
}

// Shown to devices on the Wi-Fi when access is on; this computer never sees it.
function PasscodeScreen() {
  const [code, setCode] = useState('');
  const [error, setError] = useState(() =>
    new URLSearchParams(location.search).get('pair') === 'failed'
      ? 'That QR code was already used or has expired. Show a new one on your computer, or enter the passcode.'
      : '',
  );
  useEffect(() => {
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api('POST', '/api/login', { passcode: code });
      location.reload();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="passcode">
      <form className="modal" onSubmit={submit}>
        <header className="modal-head">
          <h2>Enter passcode</h2>
        </header>
        <div className="modal-body">
          <Field label="Passcode" hint="Asked once per device. Set in the app's .env file on your computer.">
            <input type="password" autoComplete="current-password" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </Field>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button className="btn btn-primary">Unlock</button>
        </footer>
      </form>
    </div>
  );
}

// Shown at start and after a while in the background, until a fingerprint, face or the phone's PIN matches.
function LockScreen({ onUnlock }) {
  const [busy, setBusy] = useState(false);
  const tryUnlock = async () => {
    setBusy(true);
    if (await phoneApp.unlock()) onUnlock();
    else setBusy(false);
  };
  useEffect(() => void tryUnlock(), []);
  return (
    <div className="passcode lock-screen">
      <div className="modal">
        <header className="modal-head">
          <h2>Contract Desk is locked</h2>
        </header>
        <div className="modal-body">
          <p>Use your fingerprint, face or the phone’s PIN to open your records.</p>
        </div>
        <footer className="modal-foot">
          <button className="btn btn-primary" disabled={busy} onClick={tryUnlock}>
            Unlock
          </button>
        </footer>
      </div>
    </div>
  );
}

// Phone app: on/off switch for the lock. Turning it on asks for a fingerprint first, so it is known to work. Can't be
// turned on when the phone has no fingerprint, face or screen lock (the reason is shown); can always be turned off.
function LockSetting() {
  const [on, setOn] = useState(phoneApp.lockOn);
  const [why, setWhy] = useState(null);
  useEffect(() => void phoneApp.lockUnavailable().then(setWhy), []);
  const toggle = async (e) => {
    const want = e.target.checked;
    if (want && !(await phoneApp.unlock())) return;
    phoneApp.setLockOn(want);
    setOn(want);
  };
  return (
    <label className="phone-lock">
      <input type="checkbox" checked={on} disabled={why === null || (!on && !!why)} onChange={toggle} />
      Lock with fingerprint or face
      {why && <span className="dim">{why}</span>}
    </label>
  );
}

// Phone app: shown until the data folder is ready (first run, All files access turned off, or a WebView too old).
function PhoneSetup({ status }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (fn) => async () => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  if (status.name === 'starting') return <div className="boot">Opening the desk…</div>;
  if (status.name === 'webview')
    return (
      <div className="passcode">
        <div className="modal">
          <header className="modal-head">
            <h2>Update Android System WebView</h2>
          </header>
          <div className="modal-body">
            <p>This phone’s Android System WebView is too old for the Contract Desk database.</p>
            <p>Open the Play Store, search for “Android System WebView”, tap Update, then open Contract Desk again.</p>
          </div>
        </div>
      </div>
    );
  return (
    <div className="passcode">
      <div className="modal">
        <header className="modal-head">
          <h2>Where to keep your records</h2>
        </header>
        <div className="modal-body">
          <p>Contract Desk keeps your records in a folder on the phone, so they stay safe even if the app is removed. Allow ‘All files access’, or choose a folder.</p>
          {(error || status.message) && <p className="form-error">{error || status.message}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn" disabled={busy} onClick={run(phone.chooseFolder)}>
            Choose folder
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={run(phone.requestAccess)}>
            Allow All files access
          </button>
        </footer>
      </div>
    </div>
  );
}

// Shows a one-time QR code; scanning it on a phone on the same Wi-Fi unlocks the app there without the passcode.
function ConnectPhone() {
  const [open, setOpen] = useState(false);
  const [pair, setPair] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const newCode = () => {
    setError('');
    api('POST', '/api/pair')
      .then((p) => (setNow(Date.now()), setPair(p)))
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    if (!open) return;
    newCode();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0;
  return (
    <>
      <button className="rail-connect" onClick={() => setOpen(true)} aria-label="Connect phone">
        <Icon name="qr" /> <span className="rail-connect-label">Connect phone</span>
      </button>
      {open && (
        <Modal title="Connect a phone" onClose={() => (setOpen(false), setPair(null))}>
          <div className="modal-body pair">
            {error && <p className="form-error">{error}</p>}
            {pair && !pair.links.length && <p className="form-error">This computer has no Wi-Fi network address right now.</p>}
            {pair?.links.map((l) => (
              <figure key={l.url} className={`pair-code ${left ? '' : 'is-expired'}`}>
                <img src={`data:image/svg+xml;utf8,${encodeURIComponent(l.svg)}`} alt="QR code to connect a phone" />
                <figcaption className="mono">{l.url.replace(/\/pair\/.*/, '')}</figcaption>
              </figure>
            ))}
            {pair && (
              <p className="pair-note">
                {left ? (
                  <>
                    Works <strong>once</strong>, for the next <span className="mono">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</span>. The phone must be on the
                    same Wi-Fi and stays connected for 30 days.
                  </>
                ) : (
                  <strong>This code has expired.</strong>
                )}
              </p>
            )}
          </div>
          <footer className="modal-foot">
            <button className="btn" onClick={newCode}>
              New code
            </button>
            <button className="btn btn-primary" onClick={() => (setOpen(false), setPair(null))}>
              Done
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}

// Light/dark switch. Starts from the system setting; the choice is remembered on this device only.
// In the sidebar, and on Settings (the phone's top bar has no room for it); a flip in one updates the other.
const currentTheme = () => document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function ThemeSwitch({ inRail }) {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const on = () => setTheme(currentTheme());
    window.addEventListener('themechange', on);
    return () => window.removeEventListener('themechange', on);
  }, []);
  const next = theme === 'dark' ? 'light' : 'dark';
  const flip = () => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
    window.dispatchEvent(new Event('themechange'));
  };
  return (
    <button className={inRail ? 'rail-theme' : 'btn btn-sm'} onClick={flip} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      <Icon name={next === 'dark' ? 'moon' : 'sun'} />
      <span className={inRail ? 'rail-theme-label' : undefined}>{next === 'dark' ? 'Dark theme' : 'Light theme'}</span>
    </button>
  );
}

// ---------- backup and restore (format: core/backup.js) ----------

// Desktop: a download (the desktop app asks where to save it). Phone: built in pieces, saved to Downloads, then the share
// menu opens so it can go to Drive, email or a computer.
function BackupButton({ onBackup, className, label = 'Back up now' }) {
  const [busy, setBusy] = useState(null);
  const [saved, setSaved] = useState('');
  if (!isPhone)
    return (
      <a className={className} href="/api/backup" download onClick={onBackup}>
        {label}
      </a>
    );
  const run = async () => {
    setBusy(0);
    setSaved('');
    try {
      setSaved(await phone.backup(setBusy));
      onBackup();
    } catch (err) {
      alert(`The backup could not be made: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <button className={className} disabled={busy !== null} onClick={run}>
        {busy === null ? label : `Backing up… ${Math.round(busy * 100)}%`}
      </button>
      {saved && <span className="phone-space">Backup saved in Downloads as {saved}</span>}
    </>
  );
}

// Only on the computer running Contract Desk (or in the phone app): a restore replaces everything.
function RestoreButton({ meta, className, label = 'Restore…' }) {
  const [file, setFile] = useState(null);
  const pick = useRef();
  if (!isPhone && !meta.onThisComputer) return null;
  return (
    <>
      <button className={className} onClick={() => pick.current.click()}>
        {label}
      </button>
      <input ref={pick} type="file" accept=".tar,application/x-tar" hidden aria-label="Backup file" onChange={(e) => (setFile(e.target.files[0] || null), (e.target.value = ''))} />
      {file && <RestoreDialog file={file} onClose={() => setFile(null)} />}
    </>
  );
}

const countsLine = (c) => `${c.contracts.toLocaleString()} contracts, ${c.nocs.toLocaleString()} NOCs, ${c.documents.toLocaleString()} documents`;

// Checks the whole file first (nothing changes yet), then says what would be replaced and asks.
function RestoreDialog({ file, onClose }) {
  const [s, setS] = useState({ step: 'checking' });
  useEffect(() => {
    // Closing the dialog while checking stops the check; one that finishes anyway is cancelled (its copy removed).
    const stop = new AbortController();
    checkRestore(file, stop.signal).then(
      (r) => (stop.signal.aborted ? cancelRestore() : setS({ step: 'ready', ...r })),
      (err) => stop.signal.aborted || setS({ step: 'error', error: err.message }),
    );
    return () => stop.abort();
  }, [file]);
  const close = () => {
    if (s.step === 'applying') return;
    if (s.step === 'ready') cancelRestore();
    onClose();
  };
  const apply = async () => {
    setS((v) => ({ ...v, step: 'applying' }));
    try {
      await applyRestore();
      location.reload();
    } catch (err) {
      setS({ step: 'error', error: err.message });
    }
  };
  return (
    <Modal title="Restore from a backup" onClose={close} tone="danger">
      <div className="modal-body confirm-body">
        {s.step === 'checking' && <p>Checking every record and file in {file.name}…</p>}
        {s.step === 'error' && <p className="form-error">{s.error}</p>}
        {(s.step === 'ready' || s.step === 'applying') && (
          <>
            <p>
              <strong>Everything now in Contract Desk is replaced</strong> by this backup, made {fmtDate(s.made)} on {s.from === 'phone' ? 'a phone' : 'a computer'}.
              Records and files that are not in the backup are deleted.
            </p>
            <ul className="confirm-list">
              <li>
                Now: <span className="mono">{countsLine(s.now)}</span>
              </li>
              <li>
                After restoring: <span className="mono">{countsLine(s.backup)}</span>
              </li>
            </ul>
          </>
        )}
      </div>
      <footer className="modal-foot">
        <button className="btn" onClick={close} disabled={s.step === 'applying'} autoFocus>
          {s.step === 'error' ? 'Close' : 'Keep current records'}
        </button>
        {s.step !== 'error' && (
          <button className="btn btn-danger" onClick={apply} disabled={s.step !== 'ready'}>
            {s.step === 'applying' ? 'Restoring…' : 'Replace with backup'}
          </button>
        )}
      </footer>
    </Modal>
  );
}

// On the search page (the front door) when there are records and no backup in the last two weeks.
function BackupReminder({ meta, facets, onBackup }) {
  const { contracts, nocs, documents } = facets.counts;
  const days = meta.lastBackup ? Math.floor((Date.now() - Date.parse(meta.lastBackup)) / 864e5) : null;
  if (!(contracts + nocs + documents) || (days !== null && days < REMIND_AFTER_DAYS)) return null;
  return (
    <p className="backup-reminder" role="status">
      <span>
        {days === null ? 'No backup yet.' : `Last backup ${days} days ago.`} Keep a copy somewhere else, so your records survive a lost or broken{' '}
        {isPhone ? 'phone' : 'computer'}.
      </span>
      <BackupButton className="btn btn-sm" onBackup={onBackup} />
    </p>
  );
}

// Phone: switch the data folder with the system folder picker (decision-2), then reload the desk from it.
const changePhoneFolder = () => phone.chooseFolder().then((changed) => changed && location.reload(), (err) => alert(err.message));

function Rail({ section, facets, meta }) {
  const n = (v) => v.toLocaleString();
  return (
    <aside className="rail">
      <a className="brand" href="#/" aria-label="Contract Desk home">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-word">
          Contract
          <br />
          Desk
        </span>
      </a>
      <nav className="rail-nav">
        <a href="#/" className={!section ? 'is-active' : ''}>
          <span>Search</span>
          <kbd>/</kbd>
        </a>
        <a href="#/contracts" className={section === 'contracts' ? 'is-active' : ''}>
          <span>Contracts</span>
          <span className="count">{n(facets.counts.contracts)}</span>
        </a>
        <a href="#/nocs" className={section === 'nocs' ? 'is-active' : ''}>
          <span>NOCs</span>
          <span className="count">{n(facets.counts.nocs)}</span>
        </a>
        {/* Phones show only the gear: four labels don't fit the top bar. */}
        <a href="#/settings" className={`rail-settings ${section === 'settings' ? 'is-active' : ''}`} aria-label="Settings">
          <span>Settings</span>
          <Icon name="gear" />
        </a>
      </nav>
      {meta.lan && meta.onThisComputer && <ConnectPhone />}
      <a className={`rail-sub ${section === 'categories' ? 'is-active' : ''}`} href="#/categories">
        <Icon name="edit" /> Document categories
      </a>
      <ThemeSwitch inRail />
      <p className="rail-stat">
        <span className="mono">{n(facets.counts.documents)}</span> documents filed
      </p>
      <div className="rail-foot">
        <span className="rail-local">{meta.lan ? 'Wi-Fi access on · passcode' : 'Local only · offline'}</span>
      </div>
    </aside>
  );
}

// ---------- shared bits ----------

function FilterBar({ params, set, facets, meta, show }) {
  const sel = (key, label, options) =>
    show.includes(key) && (
      <label className="filter">
        <span>{label}</span>
        <select value={params[key] || ''} onChange={(e) => set({ [key]: e.target.value })}>
          <option value="">All</option>
          {options.map((o) =>
            Array.isArray(o) ? (
              <option key={o[0]} value={o[0]}>
                {o[1]}
              </option>
            ) : (
              <option key={o}>{o}</option>
            ),
          )}
        </select>
      </label>
    );
  const active = show.filter((k) => k !== 'q' && k !== 'sort' && params[k]);
  // Folded on phones so results start on the first screen; open on desktop or when a filter is set.
  const [open] = useState(() => active.length > 0 || window.matchMedia('(min-width: 821px)').matches);
  return (
    <details className="filters-wrap" open={open}>
      <summary className="filters-toggle">
        Filters
        {active.length > 0 && <span className="section-count">{active.length}</span>}
        <Icon name="chevron" size={14} />
      </summary>
      <div className="filters">
        {sel('project', 'Project', facets.projects)}
        {sel('firm', 'Firm', facets.firms)}
        {sel('category', 'Category', meta.categories)}
        {sel('file_type', 'File type', [
          ['pdf', 'PDF'],
          ['image', 'Image'],
          ['excel', 'Excel'],
        ])}
        {sel(
          'tag',
          'Tag',
          facets.tags.map((t) => [t.name, `${t.name} (${t.count})`]),
        )}
        {sel('currency', 'Currency', facets.currencies)}
        {show.includes('min') && (
          <label className="filter filter-range">
            <span>Amount</span>
            <span className="range">
              <input
                inputMode="decimal"
                placeholder="min"
                value={params.min || ''}
                onChange={(e) => set({ min: e.target.value })}
                aria-label="Minimum amount"
              />
              <span className="dim">–</span>
              <input
                inputMode="decimal"
                placeholder="max"
                value={params.max || ''}
                onChange={(e) => set({ max: e.target.value })}
                aria-label="Maximum amount"
              />
            </span>
          </label>
        )}
        {active.length > 0 && (
          <button className="btn-link" onClick={() => set(Object.fromEntries(active.map((k) => [k, ''])))}>
            Clear {active.length} filter{active.length > 1 ? 's' : ''}
          </button>
        )}
      </div>
    </details>
  );
}

function ExportLink({ scope, filters, label = 'Export to Excel' }) {
  const [busy, setBusy] = useState(false);
  const { sort, ...f } = filters;
  const filtered = Object.keys(f).length > 0;
  const title = filtered ? 'Exports the records matching your current search and filters' : 'Exports every record';
  const inner = (text) => (
    <>
      <Icon name="sheet" /> {text}
      <span className="btn-note">{filtered ? 'filtered' : 'all'}</span>
    </>
  );
  // The phone has no server to download from: the app builds the file, then opens it in the phone's spreadsheet app or
  // hands it to Android's share menu.
  if (isPhone) {
    const run = (how) => () => (setBusy(true), phone.exportExcel({ scope, ...f }, how).catch((err) => alert(err.message)).finally(() => setBusy(false)));
    return (
      <span className="page-actions">
        <button className="btn" title={`${title}, and opens it in a spreadsheet app`} disabled={busy} onClick={run('open')}>
          {inner('Open Excel')}
        </button>
        <button className="btn" title={`${title}, through Android's share menu`} aria-label="Share Excel export" disabled={busy} onClick={run('share')}>
          <Icon name="share" /> Share
        </button>
      </span>
    );
  }
  return (
    <a className="btn" href={`/api/export.xlsx${qs({ scope, ...f })}`} title={title}>
      {inner(label)}
    </a>
  );
}

function PageHead({ title, count, children }) {
  return (
    <header className="page-head">
      <div>
        <h1 className="display">
          {title}
          {count != null && <span className="display-count">{count.toLocaleString()}</span>}
        </h1>
      </div>
      <div className="page-actions">{children}</div>
    </header>
  );
}

function ContractTable({ items, q }) {
  return (
    <div className="table" role="table">
      <div className="tr th" role="row">
        <span>Contract No.</span>
        <span>Project</span>
        <span>Firm</span>
        <span className="num">Amount</span>
        <span className="num">Docs</span>
        <span>Updated</span>
      </div>
      {items.map((c) => (
        <a className="tr" role="row" key={c.id} href={`#/contracts/${c.id}`}>
          <span className="id-cell">
            <span className="ident">
              <Hl text={c.contract_no} q={q} />
            </span>
            {q && c.rank === 0 && <span className="stamp">Exact</span>}
          </span>
          <span className="clip">
            <Hl text={c.project_name} q={q} />
          </span>
          <span className="clip">
            <Hl text={c.firm_name} q={q} />
          </span>
          <span className="num mono">
            {fmtAmount(c.amount)} <span className="ccy">{c.currency}</span>
          </span>
          <span className="num mono">{c.doc_count}</span>
          <span className="mono dim">{fmtDate(c.updated_at)}</span>
        </a>
      ))}
    </div>
  );
}

function NocTable({ items, q }) {
  return (
    <div className="table table-noc" role="table">
      <div className="tr th" role="row">
        <span>Indent No.</span>
        <span>NOC Name</span>
        <span className="num">Docs</span>
        <span>Updated</span>
      </div>
      {items.map((n) => (
        <a className="tr" role="row" key={n.id} href={`#/nocs/${n.id}`}>
          <span className="id-cell">
            <span className="ident">
              <Hl text={n.indent_no} q={q} />
            </span>
            {q && n.rank === 0 && <span className="stamp">Exact</span>}
          </span>
          <span className="clip">
            <Hl text={n.noc_name} q={q} />
          </span>
          <span className="num mono">{n.doc_count}</span>
          <span className="mono dim">{fmtDate(n.updated_at)}</span>
        </a>
      ))}
    </div>
  );
}

function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

// ---------- search (front door) ----------

function SearchPage({ route, go, meta, facets, version, openDoc, openParent, onBackup }) {
  const { params } = route;
  const filters = pick(params);
  const set = (p) => go('/', { ...params, ...p, cp: '', np: '', dp: '' }, { replace: true });
  const base = qs(filters);
  const join = (page) => `${base}${base ? '&' : '?'}page_size=10&page=${page || 1}`;
  const contracts = useData(`/api/contracts${join(params.cp)}`, version, 120);
  const nocs = useData(`/api/nocs${join(params.np)}`, version, 120);
  const docs = useData(`/api/documents${join(params.dp)}`, version, 120);
  const q = params.q || '';
  const searching = Object.keys(filters).length > 0;
  const contractOnly = CONTRACT_ONLY.some((k) => params[k]);
  const inputRef = useRef();
  // Not on the phone app: the keyboard would cover half the screen on every launch.
  useEffect(() => void (!isPhone && inputRef.current?.focus()), []);

  const sections = [
    {
      key: 'documents',
      title: 'Documents',
      noun: 'documents',
      data: docs.data,
      page: 'dp',
      body: (d) => (
        <ul className="doc-list">
          {d.items.map((doc) => (
            <DocRow key={doc.id} doc={doc} q={q} showParent onOpenDoc={() => openDoc(doc.id)} onOpenParent={() => openParent(doc.parent)} />
          ))}
        </ul>
      ),
    },
    {
      key: 'contracts',
      title: 'Contracts',
      noun: 'contracts',
      data: contracts.data,
      page: 'cp',
      body: (d) => <ContractTable items={d.items} q={q} />,
    },
    {
      key: 'nocs',
      title: 'NOCs',
      noun: 'NOCs',
      data: nocs.data,
      page: 'np',
      body: (d) => <NocTable items={d.items} q={q} />,
      hint: contractOnly ? 'NOCs have no project, firm or amount, so those filters hide them.' : null,
    },
  ];
  // Sections holding an exact identifier match float to the top; empty sections sink to the bottom.
  const rankOf = (s) => (q && s.data?.items.some((x) => x.rank === 0) ? 0 : s.data && !s.data.total ? 2 : 1);
  sections.sort((a, b) => rankOf(a) - rankOf(b));
  const nothingFound = searching && sections.every((s) => s.data && !s.data.total);

  const nothingFiled = !facets.counts.contracts && !facets.counts.nocs;

  return (
    <div className="page page-search">
      <BackupReminder meta={meta} facets={facets} onBackup={onBackup} />
      {isPhone && <PhoneSpace warnOnly version={version} />}
      <div className="search-hero">
        <label className="sr-only" htmlFor="q">
          Search everything filed
        </label>
        <div className="search-box">
          <Icon name="search" size={26} />
          <input
            id="q"
            ref={inputRef}
            value={q}
            autoComplete="off"
            spellCheck="false"
            placeholder="Contract no., Ind-1, INV-2026-001, firm, tag…"
            onChange={(e) => set({ q: e.target.value })}
          />
          {q && (
            <button className="btn-icon" onClick={() => set({ q: '' })} aria-label="Clear search">
              <Icon name="x" size={18} />
            </button>
          )}
        </div>
        <FilterBar params={params} set={set} facets={facets} meta={meta} show={['project', 'firm', 'category', 'file_type', 'tag', 'currency', 'min']} />
        <div className="search-foot">
          <span className="dim search-help">Searches identifiers, names, filenames, Reference No. and tags. Exact identifier matches come first.</span>
          <ExportLink scope="all" filters={filters} />
        </div>
      </div>

      {nothingFiled ? (
        <Empty>
          <h2>The desk is empty.</h2>
          <p>Start by filing a contract or an NOC, then attach its documents.</p>
          <div className="row-gap">
            <a className="btn btn-primary" href="#/contracts?new=1">
              <Icon name="plus" /> New contract
            </a>
            <a className="btn" href="#/nocs?new=1">
              <Icon name="plus" /> New NOC
            </a>
            <RestoreButton meta={meta} className="btn" label="Restore a backup…" />
          </div>
        </Empty>
      ) : (
        <div className="results">
          {(contracts.error || docs.error || nocs.error) && <p className="form-error">{contracts.error || docs.error || nocs.error}</p>}
          {nothingFound && (
            <Empty>
              <h2>
                Nothing matches{q && <span className="empty-query"> “{q}”</span>}
              </h2>
              <p>Search looks at Contract No., Indent No., names, filenames, Reference No. and tags. Check the spelling or clear a filter.</p>
              <button className="btn" onClick={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))}>
                Clear search and filters
              </button>
            </Empty>
          )}
          {!nothingFound && sections.map((s) => (
            <section className={`result-section ${s.data && !s.data.total ? 'is-empty' : ''}`} key={s.key}>
              <header className="section-head">
                <h2 className="section-label">
                  {searching ? s.title : `Recent ${s.title}`}
                  {s.data && <span className="section-count">{s.data.total.toLocaleString()}</span>}
                </h2>
              </header>
              {!s.data ? (
                <div className="skeleton" />
              ) : s.data.total ? (
                <>
                  {s.body(s.data)}
                  <Pager data={s.data} onPage={(p) => go('/', { ...params, [s.page]: p }, { replace: true })} />
                </>
              ) : (
                <p className="none">{s.hint || (searching ? `No ${s.noun} match.` : `No ${s.noun} yet.`)}</p>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- settings ----------

function SettingsPage({ meta, version, onBackup }) {
  return (
    <div className="page">
      <PageHead title="Settings" />
      <div className="settings">
        <section className="setting">
          <h2 className="section-label">Data folder</h2>
          <div className="setting-body">
            <p>Your records and their files are kept here.</p>
            <code className="setting-path">{meta.dataDir}</code>
            {/* Only inside the desktop app (its preload adds window.desktop); never on phones or in a browser. */}
            {window.desktop && (
              <span className="row-gap">
                <button className="btn btn-sm" onClick={() => window.desktop.openDataFolder()}>
                  Open
                </button>
                <button className="btn btn-sm" onClick={() => window.desktop.chooseDataFolder()}>
                  Change…
                </button>
              </span>
            )}
            {isPhone && (
              <button className="btn btn-sm" onClick={changePhoneFolder}>
                Change folder…
              </button>
            )}
          </div>
        </section>
        {isPhone && (
          <section className="setting">
            <h2 className="section-label">Storage</h2>
            <div className="setting-body">
              <PhoneSpace version={version} />
            </div>
          </section>
        )}
        <section className="setting">
          <h2 className="section-label">Backup</h2>
          <div className="setting-body">
            <p>
              {meta.lastBackup ? `Last backup ${fmtDate(meta.lastBackup)}.` : 'Not backed up yet.'} A backup is one file with every record and document. Keep it somewhere
              else, so your records survive a lost or broken {isPhone ? 'phone' : 'computer'}.
            </p>
            <span className="row-gap">
              <BackupButton className="btn btn-sm" onBackup={onBackup} />
              <RestoreButton meta={meta} className="btn btn-sm" />
            </span>
            {!isPhone && !meta.onThisComputer && <p className="dim">Restore works only on the computer that runs Contract Desk.</p>}
          </div>
        </section>
        <section className="setting">
          <h2 className="section-label">Theme</h2>
          <div className="setting-body">
            <ThemeSwitch />
          </div>
        </section>
        {isPhone && (
          <section className="setting">
            <h2 className="section-label">Lock</h2>
            <div className="setting-body">
              <LockSetting />
            </div>
          </section>
        )}
        <section className="setting">
          <h2 className="section-label">Categories</h2>
          <div className="setting-body">
            <p>The document types every contract is filed by.</p>
            <a className="btn btn-sm" href="#/categories">
              <Icon name="edit" /> Document categories
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------- contracts ----------

const CURRENCIES = ['USD', 'EUR', 'GBP', 'PKR', 'CNY', 'AED', 'SAR', 'JPY', 'INR', 'TRY'];

function ContractForm({ initial, facets, onSaved, onClose }) {
  const [f, setF] = useState(
    initial || {
      contract_no: '',
      project_name: '',
      firm_name: '',
      amount: '',
      currency: 'USD',
    },
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bind = (k) => ({
    value: f[k],
    onChange: (e) => setF({ ...f, [k]: e.target.value }),
  });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSaved(await api(initial ? 'PUT' : 'POST', initial ? `/api/contracts/${initial.id}` : '/api/contracts', f));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={initial ? `Edit ${initial.contract_no}` : 'New contract'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <Field label="Contract No." span={2} hint="Must be unique.">
            <input className="mono input-ident" {...bind('contract_no')} required autoFocus />
          </Field>
          <Field label="Project Name" span={2}>
            <input list="dl-projects" {...bind('project_name')} />
          </Field>
          <Field label="Firm Name" span={2}>
            <input list="dl-firms" {...bind('firm_name')} />
          </Field>
          <Field label="Amount">
            <input className="mono" type="number" min="0" step="0.01" {...bind('amount')} required />
          </Field>
          <Field label="Currency">
            <input
              className="mono"
              list="dl-ccy"
              maxLength={3}
              {...bind('currency')}
              onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })}
              required
            />
          </Field>
          <datalist id="dl-projects">
            {facets.projects.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <datalist id="dl-firms">
            {facets.firms.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <datalist id="dl-ccy">
            {[...new Set([...facets.currencies, ...CURRENCIES])].map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {initial ? 'Save contract' : 'Create contract'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ContractsPage({ route, go, meta, facets, version, bump }) {
  const { params } = route;
  const filters = pick(params);
  const set = (p) => go('/contracts', { ...params, ...p, page: '' }, { replace: true });
  const { data, error } = useData(`/api/contracts${qs({ ...filters, page: params.page })}`, version, 120);
  return (
    <div className="page">
      <PageHead title="Contracts" count={data?.total}>
        <ExportLink scope="contracts" filters={filters} />
        <button className="btn btn-primary" onClick={() => go('/contracts', { ...params, new: 1 })}>
          <Icon name="plus" /> New contract
        </button>
      </PageHead>
      <div className="toolbar">
        <div className="search-inline">
          <Icon name="search" />
          <input
            value={params.q || ''}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Contract No., project or firm"
            aria-label="Search contracts"
          />
        </div>
        <label className="filter">
          <span>Sort</span>
          <select value={params.sort || 'recent'} onChange={(e) => set({ sort: e.target.value === 'recent' ? '' : e.target.value })}>
            <option value="recent">Recently updated</option>
            <option value="no">Contract No.</option>
            <option value="amount_desc">Amount, high → low</option>
            <option value="amount_asc">Amount, low → high</option>
          </select>
        </label>
      </div>
      <FilterBar params={params} set={set} facets={facets} meta={meta} show={['project', 'firm', 'currency', 'min', 'category', 'file_type', 'tag']} />
      {error && <p className="form-error">{error}</p>}
      {data &&
        (data.total ? (
          <>
            <ContractTable items={data.items} q={params.q} />
            <Pager data={data} onPage={(p) => go('/contracts', { ...params, page: p }, { replace: true })} />
          </>
        ) : (
          <Empty>
            <h2>{Object.keys(filters).length ? 'No contracts match.' : 'No contracts yet.'}</h2>
          </Empty>
        ))}
      {params.new && (
        <ContractForm
          facets={facets}
          onClose={() => go('/contracts', { ...params, new: '' }, { replace: true })}
          onSaved={(c) => {
            bump();
            go(`/contracts/${c.id}`, {}, { replace: true }); // the filled-in form is not a step to go back to
          }}
        />
      )}
    </div>
  );
}

function DeleteRecordConfirm({ kind, no, docs, onConfirm, onClose }) {
  return (
    <Confirm
      title={`Delete ${kind} ${no}?`}
      confirmLabel={`Delete ${kind}${docs.length ? ` and ${docs.length} document${docs.length > 1 ? 's' : ''}` : ''}`}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {docs.length ? (
        <>
          <p>
            <strong>
              {docs.length > 1
                ? `This also deletes all ${docs.length} attached documents and permanently removes their files from your data folder:`
                : 'This also deletes its attached document and permanently removes its file from your data folder:'}
            </strong>
          </p>
          <ul className="confirm-list">
            {docs.slice(0, 8).map((d) => (
              <li key={d.id}>
                <span>{d.display_name}</span> <span className="mono dim">{d.original_name}</span>
              </li>
            ))}
            {docs.length > 8 && <li className="dim">…and {docs.length - 8} more</li>}
          </ul>
        </>
      ) : (
        <p>It has no attached documents.</p>
      )}
      <p>This cannot be undone.</p>
    </Confirm>
  );
}

function DocGroup({ title, docs, onAdd, onOpenDoc, onDelete }) {
  return (
    <section className={`doc-group ${docs.length ? '' : 'is-empty'}`}>
      <header className="doc-group-head">
        <h3>{title}</h3>
        <span className="mono dim">{docs.length}</span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onAdd}>
          <Icon name="plus" size={14} /> Add
        </button>
      </header>
      {docs.length > 0 && (
        <ul className="doc-list">
          {docs.map((d) => (
            <DocRow key={d.id} doc={d} onOpenDoc={() => onOpenDoc(d.id)} onDelete={() => onDelete(d)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function useRecordPage(url, version) {
  const [modal, setModal] = useState(null);
  const { data, error } = useData(url, version);
  return { data, error, modal, setModal, close: () => setModal(null) };
}

function ContractDetail({ id, go, meta, facets, version, bump, openDoc, tagNames }) {
  const { data: c, error, modal, setModal, close } = useRecordPage(`/api/contracts/${id}`, version);
  if (error && !c)
    return (
      <div className="page">
        <Empty>
          <h2>{error}</h2>
          <a href="#/contracts">All contracts</a>
        </Empty>
      </div>
    );
  if (!c || String(c.id) !== String(id))
    return (
      <div className="page">
        <div className="skeleton tall" />
      </div>
    );
  const parent = { type: 'contract', id: c.id, no: c.contract_no };
  return (
    <div className="page">
      <a className="back" href="#/contracts">
        <Icon name="back" size={14} /> Contracts
      </a>
      <header className="record-head">
        <div>
          <h1 className="ident-xl">{c.contract_no}</h1>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setModal({ upload: '' })}>
            <Icon name="upload" /> Add documents
          </button>
          <button className="btn" onClick={() => setModal({ edit: true })}>
            <Icon name="edit" /> Edit
          </button>
          <button className="btn btn-ghost-danger" onClick={() => setModal({ del: true })}>
            <Icon name="trash" /> Delete
          </button>
        </div>
      </header>
      <dl className="manifest">
        <div className="cell cell-2">
          <dt>Project Name</dt>
          <dd>{c.project_name || <span className="dim">—</span>}</dd>
        </div>
        <div className="cell cell-2">
          <dt>Firm Name</dt>
          <dd>{c.firm_name || <span className="dim">—</span>}</dd>
        </div>
        <div className="cell cell-amount">
          <dt>Amount</dt>
          <dd className="mono">
            {fmtAmount(c.amount)} <span className="ccy">{c.currency}</span>
          </dd>
        </div>
        <div className="cell">
          <dt>Attachments</dt>
          <dd className="mono">{c.doc_count}</dd>
        </div>
        <div className="cell">
          <dt>Created</dt>
          <dd className="mono">{fmtDate(c.created_at)}</dd>
        </div>
        <div className="cell">
          <dt>Updated</dt>
          <dd className="mono">{fmtDate(c.updated_at)}</dd>
        </div>
      </dl>

      <div className="groups-head">
        <a className="btn-link" href="#/categories">
          Edit categories
        </a>
      </div>
      <div className="groups">
        {meta.categories.map((cat) => (
          <DocGroup
            key={cat}
            title={cat}
            docs={c.documents.filter((d) => d.category === cat)}
            onAdd={() => setModal({ upload: cat })}
            onOpenDoc={openDoc}
            onDelete={(d) => setModal({ delDoc: d })}
          />
        ))}
      </div>

      {modal?.edit && (
        <ContractForm
          initial={c}
          facets={facets}
          onClose={close}
          onSaved={() => {
            close();
            bump();
          }}
        />
      )}
      {modal?.upload != null && (
        <UploadDialog parent={parent} categories={meta.categories} initialCategory={modal.upload} tagSuggestions={tagNames} onDone={bump} onClose={close} />
      )}
      {modal?.del && (
        <DeleteRecordConfirm
          kind="contract"
          no={c.contract_no}
          docs={c.documents}
          onClose={close}
          onConfirm={async () => {
            await api('DELETE', `/api/contracts/${c.id}`);
            bump();
            go('/contracts');
          }}
        />
      )}
      {modal?.delDoc && <DeleteDocConfirm doc={modal.delDoc} onClose={close} onDeleted={bump} />}
    </div>
  );
}

// ---------- categories ----------

function CategoriesPage({ version, bump }) {
  const { data: cats, error } = useData('/api/categories', version);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState(null);
  const run = async (method, url, body) => {
    setMessage('');
    try {
      await api(method, url, body);
      bump();
      return true;
    } catch (err) {
      setMessage(err.message);
      return false;
    }
  };
  const add = async (e) => {
    e.preventDefault();
    if (await run('POST', '/api/categories', { name })) setName('');
  };
  return (
    <div className="page">
      <a className="back" href="#/contracts">
        <Icon name="back" size={14} /> Contracts
      </a>
      <PageHead title="Categories" count={cats?.length} />
      <p className="page-intro">
        The document types every contract is filed by. They appear in Add documents, on each contract, in filters and in the Excel export. Click a name to rename it: every
        document already filed under it follows.
      </p>
      {(message || error) && <p className="form-error">{message || error}</p>}
      {cats && (
        <ol className="cat-list">
          {cats.map((c, i) => (
            <CategoryRow key={c.id} cat={c} first={i === 0} last={i === cats.length - 1} only={cats.length === 1} run={run} onDelete={() => setDeleting(c)} />
          ))}
        </ol>
      )}
      <form className="cat-add" onSubmit={add}>
        <Field label="New category">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Insurance Certificate" />
        </Field>
        <button className="btn btn-primary" disabled={!name.trim()}>
          <Icon name="plus" /> Add category
        </button>
      </form>
      {deleting && <DeleteCategoryConfirm cat={deleting} cats={cats} onClose={() => setDeleting(null)} onDone={bump} />}
    </div>
  );
}

function CategoryRow({ cat, first, last, only, run, onDelete }) {
  const [name, setName] = useState(cat.name);
  useEffect(() => setName(cat.name), [cat.name]);
  const dirty = name.trim().replace(/\s+/g, ' ') !== cat.name;
  const save = (e) => {
    e.preventDefault();
    if (dirty) run('PATCH', `/api/categories/${cat.id}`, { name });
  };
  const move = (dir) => run('PATCH', `/api/categories/${cat.id}`, { move: dir });
  return (
    <li className="cat-row">
      <form className="cat-name" onSubmit={save}>
        <input aria-label={`Name of ${cat.name}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        {dirty && (
          <>
            <button className="btn btn-sm btn-primary">Save</button>
            <button type="button" className="btn btn-sm" onClick={() => setName(cat.name)}>
              Cancel
            </button>
          </>
        )}
      </form>
      <span className="cat-count mono">
        {cat.doc_count} document{cat.doc_count === 1 ? '' : 's'}
      </span>
      <div className="cat-actions">
        <button className="btn-icon" disabled={first} onClick={() => move('up')} aria-label={`Move ${cat.name} up`} title="Move up">
          <Icon name="chevronUp" />
        </button>
        <button className="btn-icon" disabled={last} onClick={() => move('down')} aria-label={`Move ${cat.name} down`} title="Move down">
          <Icon name="chevron" />
        </button>
        <button className="btn-icon btn-icon-danger" disabled={only} onClick={onDelete} aria-label={`Delete ${cat.name}`} title={only ? 'Keep at least one category' : 'Delete'}>
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}

// Documents are never deleted with their category: they move to another one first.
function DeleteCategoryConfirm({ cat, cats, onClose, onDone }) {
  const others = cats.filter((c) => c.id !== cat.id);
  const [target, setTarget] = useState(() => String((others.find((c) => c.name === 'Other Documents') || others[0]).id));
  const n = cat.doc_count;
  return (
    <Confirm
      title={`Delete “${cat.name}”?`}
      confirmLabel={n ? `Move ${n} and delete` : 'Delete category'}
      onClose={onClose}
      onConfirm={async () => {
        await api('DELETE', `/api/categories/${cat.id}${n ? `?move_to=${target}` : ''}`);
        onDone();
      }}
    >
      {n ? (
        <>
          <p>
            <strong>
              It has {n} document{n > 1 ? 's' : ''}. {n > 1 ? 'They are' : 'It is'} not deleted: choose where to move {n > 1 ? 'them' : 'it'}.
            </strong>
          </p>
          <Field label="Move documents to">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <p>No documents are filed under it.</p>
      )}
      <p>It disappears from every contract page and from Add documents.</p>
    </Confirm>
  );
}

// ---------- NOCs ----------

function NocForm({ initial, onSaved, onClose }) {
  const [f, setF] = useState(initial || { indent_no: '', noc_name: '' });
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      onSaved(await api(initial ? 'PUT' : 'POST', initial ? `/api/nocs/${initial.id}` : '/api/nocs', f));
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Modal title={initial ? `Edit ${initial.indent_no}` : 'New NOC'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <Field label="Indent No." span={2} hint="Unique, e.g. Ind-1">
            <input
              className="mono input-ident"
              value={f.indent_no}
              onChange={(e) => setF({ ...f, indent_no: e.target.value })}
              required
              autoFocus
              placeholder="Ind-1"
            />
          </Field>
          <Field label="NOC Name" span={2}>
            <input value={f.noc_name} onChange={(e) => setF({ ...f, noc_name: e.target.value })} required />
          </Field>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary">{initial ? 'Save NOC' : 'Create NOC'}</button>
        </footer>
      </form>
    </Modal>
  );
}

function NocsPage({ route, go, meta, facets, version, bump }) {
  const { params } = route;
  const filters = pick(params, ['q', 'file_type', 'tag', 'sort']);
  const set = (p) => go('/nocs', { ...params, ...p, page: '' }, { replace: true });
  const { data, error } = useData(`/api/nocs${qs({ ...filters, page: params.page })}`, version, 120);
  return (
    <div className="page">
      <PageHead title="NOCs" count={data?.total}>
        <ExportLink scope="nocs" filters={filters} />
        <button className="btn btn-primary" onClick={() => go('/nocs', { ...params, new: 1 })}>
          <Icon name="plus" /> New NOC
        </button>
      </PageHead>
      <div className="toolbar">
        <div className="search-inline">
          <Icon name="search" />
          <input value={params.q || ''} onChange={(e) => set({ q: e.target.value })} placeholder="Indent No. or NOC name" aria-label="Search NOCs" />
        </div>
        <label className="filter">
          <span>Sort</span>
          <select value={params.sort || 'recent'} onChange={(e) => set({ sort: e.target.value === 'recent' ? '' : e.target.value })}>
            <option value="recent">Recently updated</option>
            <option value="no">Indent No.</option>
          </select>
        </label>
      </div>
      <FilterBar params={params} set={set} facets={facets} meta={meta} show={['file_type', 'tag']} />
      {error && <p className="form-error">{error}</p>}
      {data &&
        (data.total ? (
          <>
            <NocTable items={data.items} q={params.q} />
            <Pager data={data} onPage={(p) => go('/nocs', { ...params, page: p }, { replace: true })} />
          </>
        ) : (
          <Empty>
            <h2>{Object.keys(filters).length ? 'No NOCs match.' : 'No NOCs yet.'}</h2>
          </Empty>
        ))}
      {params.new && (
        <NocForm
          onClose={() => go('/nocs', { ...params, new: '' }, { replace: true })}
          onSaved={(n) => {
            bump();
            go(`/nocs/${n.id}`, {}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function NocDetail({ id, go, version, bump, openDoc, tagNames, meta }) {
  const { data: n, error, modal, setModal, close } = useRecordPage(`/api/nocs/${id}`, version);
  if (error && !n)
    return (
      <div className="page">
        <Empty>
          <h2>{error}</h2>
          <a href="#/nocs">All NOCs</a>
        </Empty>
      </div>
    );
  if (!n || String(n.id) !== String(id))
    return (
      <div className="page">
        <div className="skeleton tall" />
      </div>
    );
  const parent = { type: 'noc', id: n.id, no: n.indent_no };
  return (
    <div className="page">
      <a className="back" href="#/nocs">
        <Icon name="back" size={14} /> NOCs
      </a>
      <header className="record-head">
        <div>
          <h1 className="ident-xl">{n.indent_no}</h1>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setModal({ upload: true })}>
            <Icon name="upload" /> Add documents
          </button>
          <button className="btn" onClick={() => setModal({ edit: true })}>
            <Icon name="edit" /> Edit
          </button>
          <button className="btn btn-ghost-danger" onClick={() => setModal({ del: true })}>
            <Icon name="trash" /> Delete
          </button>
        </div>
      </header>
      <dl className="manifest">
        <div className="cell cell-4">
          <dt>NOC Name</dt>
          <dd>{n.noc_name}</dd>
        </div>
        <div className="cell">
          <dt>Attachments</dt>
          <dd className="mono">{n.doc_count}</dd>
        </div>
        <div className="cell">
          <dt>Created</dt>
          <dd className="mono">{fmtDate(n.created_at)}</dd>
        </div>
        <div className="cell">
          <dt>Updated</dt>
          <dd className="mono">{fmtDate(n.updated_at)}</dd>
        </div>
      </dl>
      <div className="groups">
        <DocGroup
          title="Attachments"
          docs={n.documents}
          onAdd={() => setModal({ upload: true })}
          onOpenDoc={openDoc}
          onDelete={(d) => setModal({ delDoc: d })}
        />
      </div>
      {modal?.edit && (
        <NocForm
          initial={n}
          onClose={close}
          onSaved={() => {
            close();
            bump();
          }}
        />
      )}
      {modal?.upload && <UploadDialog parent={parent} categories={meta.categories} tagSuggestions={tagNames} onDone={bump} onClose={close} />}
      {modal?.del && (
        <DeleteRecordConfirm
          kind="NOC"
          no={n.indent_no}
          docs={n.documents}
          onClose={close}
          onConfirm={async () => {
            await api('DELETE', `/api/nocs/${n.id}`);
            bump();
            go('/nocs');
          }}
        />
      )}
      {modal?.delDoc && <DeleteDocConfirm doc={modal.delDoc} onClose={close} onDeleted={bump} />}
    </div>
  );
}
