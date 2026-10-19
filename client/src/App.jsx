import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs, fmtAmount, fmtDate } from './api.js';
import { Icon, Hl, Modal, Confirm, Field, Pager, DocRow, UploadDialog, DocDrawer, DeleteDocConfirm } from './ui.jsx';

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

export default function App() {
  const [route, go] = useRoute();
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const { data: meta } = useData('/api/meta', 0);
  const { data: facets } = useData('/api/facets', version);
  const [needPasscode, setNeedPasscode] = useState(false);
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
  if (!meta || !facets) return <div className="boot">Opening the desk…</div>;

  const { doc, ...params } = route.params;
  const ctx = {
    route: { ...route, params },
    go,
    meta,
    facets,
    version,
    bump,
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
          <div>
            <div className="kicker">Contract Desk</div>
            <h2>Enter passcode</h2>
          </div>
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
      <button className="rail-connect" onClick={() => setOpen(true)}>
        <Icon name="qr" /> Connect phone
      </button>
      {open && (
        <Modal title="Connect a phone" kicker="Scan with the phone's camera" onClose={() => (setOpen(false), setPair(null))}>
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

function Rail({ section, facets, meta }) {
  const n = (v) => v.toLocaleString();
  return (
    <aside className="rail">
      <a className="brand" href="#/">
        <span className="brand-mark" aria-hidden="true" />
        <span>
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
      </nav>
      {meta.lan && meta.onThisComputer && <ConnectPhone />}
      <div className="rail-stat">
        <span className="kicker">Documents filed</span>
        <span className="rail-big">{n(facets.counts.documents)}</span>
      </div>
      <div className="rail-foot">
        <span className="kicker">Data folder</span>
        <code title={meta.dataDir}>{meta.dataDir}</code>
        <span className="rail-local">{meta.lan ? '● Wi-Fi access on · passcode' : '● Local only · offline'}</span>
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
  const { sort, ...f } = filters;
  const filtered = Object.keys(f).length > 0;
  return (
    <a
      className="btn"
      href={`/api/export.xlsx${qs({ scope, ...f })}`}
      title={filtered ? 'Exports the records matching your current search and filters' : 'Exports every record'}
    >
      <Icon name="sheet" /> {label}
      <span className="btn-note">{filtered ? 'filtered' : 'all'}</span>
    </a>
  );
}

function PageHead({ kicker, title, count, children }) {
  return (
    <header className="page-head">
      <div>
        <div className="kicker">{kicker}</div>
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
      {items.map((c, i) => (
        <a className="tr" role="row" key={c.id} href={`#/contracts/${c.id}`} style={{ '--i': i }}>
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
      {items.map((n, i) => (
        <a className="tr" role="row" key={n.id} href={`#/nocs/${n.id}`} style={{ '--i': i }}>
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

function SearchPage({ route, go, meta, facets, version, openDoc, openParent }) {
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
  useEffect(() => inputRef.current?.focus(), []);

  const sections = [
    {
      key: 'documents',
      title: 'Documents',
      data: docs.data,
      page: 'dp',
      body: (d) => (
        <ul className="doc-list">
          {d.items.map((doc, i) => (
            <DocRow key={doc.id} doc={doc} q={q} i={i} showParent onOpenDoc={() => openDoc(doc.id)} onOpenParent={() => openParent(doc.parent)} />
          ))}
        </ul>
      ),
    },
    {
      key: 'contracts',
      title: 'Contracts',
      data: contracts.data,
      page: 'cp',
      body: (d) => <ContractTable items={d.items} q={q} />,
    },
    {
      key: 'nocs',
      title: 'NOCs',
      data: nocs.data,
      page: 'np',
      body: (d) => <NocTable items={d.items} q={q} />,
      hint: contractOnly ? 'NOCs have no project, firm or amount, so those filters hide them.' : null,
    },
  ];
  // Sections holding an exact identifier match float to the top.
  const exact = (s) => (q && s.data?.items.some((x) => x.rank === 0) ? 0 : 1);
  sections.sort((a, b) => exact(a) - exact(b));

  const nothingFiled = !facets.counts.contracts && !facets.counts.nocs;

  return (
    <div className="page page-search">
      <div className="search-hero">
        <label className="kicker" htmlFor="q">
          Find anything filed
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
          <span className="dim">Searches identifiers, names, filenames, Reference No. and tags. Exact identifier matches come first.</span>
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
          </div>
        </Empty>
      ) : (
        <div className="results">
          {(contracts.error || docs.error || nocs.error) && <p className="form-error">{contracts.error || docs.error || nocs.error}</p>}
          {sections.map((s) => (
            <section className="result-section" key={s.key}>
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
                <p className="none">{s.hint || (searching ? `No ${s.title} match.` : `No ${s.title} yet.`)}</p>
              )}
            </section>
          ))}
        </div>
      )}
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
    <Modal title={initial ? `Edit ${initial.contract_no}` : 'New contract'} kicker="Contract record" onClose={onClose}>
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
      <PageHead kicker="Register" title="Contracts" count={data?.total}>
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
            go(`/contracts/${c.id}`);
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
              This also deletes all {docs.length} attached document
              {docs.length > 1 ? 's' : ''} and permanently removes {docs.length > 1 ? 'their files' : 'its file'} from your data folder:
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

function DocGroup({ n, title, docs, onAdd, onOpenDoc, onDelete }) {
  return (
    <section className={`doc-group ${docs.length ? '' : 'is-empty'}`}>
      <header className="doc-group-head">
        {n && <span className="mono group-n">{n}</span>}
        <h3>{title}</h3>
        <span className="mono dim">{docs.length}</span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onAdd}>
          <Icon name="plus" size={14} /> Add
        </button>
      </header>
      {docs.length > 0 && (
        <ul className="doc-list">
          {docs.map((d, i) => (
            <DocRow key={d.id} doc={d} i={i} onOpenDoc={() => onOpenDoc(d.id)} onDelete={() => onDelete(d)} />
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
          <a href="#/contracts">← All contracts</a>
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
        ← Contracts
      </a>
      <header className="record-head">
        <div>
          <div className="kicker">Contract No.</div>
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

      <div className="groups">
        {meta.categories.map((cat, i) => (
          <DocGroup
            key={cat}
            n={String(i + 1).padStart(2, '0')}
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
    <Modal title={initial ? `Edit ${initial.indent_no}` : 'New NOC'} kicker="No-objection certificate" onClose={onClose}>
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
      <PageHead kicker="Register" title="NOCs" count={data?.total}>
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
            go(`/nocs/${n.id}`);
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
          <a href="#/nocs">← All NOCs</a>
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
        ← NOCs
      </a>
      <header className="record-head">
        <div>
          <div className="kicker">Indent No.</div>
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
