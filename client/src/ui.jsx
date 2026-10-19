import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, uploadFiles, fmtDate, fmtSize, tagKey, fileUrl } from './api.js';

const ICONS = {
  search: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm5.3-2.2L21 21',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  download: 'M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4',
  x: 'M6 6l12 12M18 6 6 18',
  open: 'M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  arrow: 'M5 12h14m0 0-6-6m6 6-6 6',
  sheet: 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 18h2v2M18 18h2v2h-2z',
};

export function Icon({ name, size = 16 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function TypeGlyph({ type }) {
  return <span className={`glyph glyph-${type}`}>{{ pdf: 'PDF', image: 'IMG', excel: 'XLS' }[type]}</span>;
}

// Wraps every case-insensitive occurrence of `q` in <mark>.
export function Hl({ text, q }) {
  if (!q || !text) return text || null;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out = [];
  let i = 0;
  for (let j = lower.indexOf(needle); j !== -1; j = lower.indexOf(needle, i)) {
    out.push(text.slice(i, j), <mark key={j}>{text.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
  }
  out.push(text.slice(i));
  return out;
}

export function Modal({ title, kicker, onClose, children, wide, tone }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Portal to <body> so no animated/transformed ancestor can become the dialog's positioning frame.
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''} ${tone === 'danger' ? 'modal-danger' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div>
            {kicker && <div className="kicker">{kicker}</div>}
            <h2>{title}</h2>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ title, children, confirmLabel = 'Delete', onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} kicker="Confirm permanent deletion" onClose={onClose} tone="danger">
      <div className="modal-body confirm-body">{children}</div>
      {error && <p className="form-error">{error}</p>}
      <footer className="modal-foot">
        <button className="btn" onClick={onClose} autoFocus>
          Keep it
        </button>
        <button className="btn btn-danger" onClick={go} disabled={busy}>
          <Icon name="trash" /> {busy ? 'Deleting…' : confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}

// `group` for composite controls (tag chips + input): a <label> would forward clicks on its text to the first chip's remove button.
export function Field({ label, hint, children, span, group }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className="field" style={span ? { gridColumn: `span ${span}` } : undefined} role={group ? 'group' : undefined} aria-label={group ? label : undefined}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </Tag>
  );
}

// Chips + free-text input. Suggestions come from existing tags through a native <datalist>.
export function TagInput({ value, onChange, suggestions = [], id }) {
  const [text, setText] = useState('');
  const add = (raw) => {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name && !value.some((t) => tagKey(t) === tagKey(name))) {
      const existing = suggestions.find((s) => tagKey(s) === tagKey(name));
      onChange([...value, existing || name]);
    }
    setText('');
  };
  const listId = `tags-${id}`;
  return (
    <div className="tag-input">
      {value.map((t) => (
        <span className="tag" key={tagKey(t)}>
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}>
            ×
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={text}
        aria-label="Add tag"
        placeholder={value.length ? '' : 'Add tags…'}
        onChange={(e) => {
          const v = e.target.value;
          // Picking a datalist option fires a plain change with the full value.
          if (suggestions.includes(v)) add(v);
          else if (v.endsWith(',')) add(v.slice(0, -1));
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !value.some((t) => tagKey(t) === tagKey(s)))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}

export function Pager({ data, onPage }) {
  if (!data || data.pages <= 1) return null;
  const from = (data.page - 1) * data.pageSize + 1;
  return (
    <nav className="pager" aria-label="Pages">
      <button className="btn btn-sm" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>
        ← Prev
      </button>
      <span className="mono">
        {from}–{Math.min(data.total, from + data.pageSize - 1)} of {data.total}
      </span>
      <button className="btn btn-sm" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>
        Next →
      </button>
    </nav>
  );
}

export function ParentLink({ parent, onOpen }) {
  return (
    <button className="parent-link" onClick={onOpen} title={`Open ${parent.type === 'contract' ? 'contract' : 'NOC'} ${parent.no}`}>
      {/* explicit spaces keep the text readable for screen readers and copy/paste; flex layout ignores them */}
      <span className="parent-kind">{parent.type === 'contract' ? 'Contract' : 'NOC'}</span>{' '}
      <span className="mono">{parent.no}</span>{' '}
      {parent.name && <span className="parent-name">{parent.name}</span>}
      <Icon name="arrow" size={13} />
    </button>
  );
}

export function DocRow({ doc, q, showParent, onOpenDoc, onOpenParent, onDelete, i = 0 }) {
  return (
    <li className="doc-row" style={{ '--i': i }}>
      <TypeGlyph type={doc.file_type} />
      <div className="doc-main">
        <button className="doc-name" onClick={onOpenDoc}>
          <Hl text={doc.display_name} q={q} />
          {q && doc.rank === 0 && <span className="stamp">Exact</span>}
        </button>
        <div className="doc-sub">
          <span className="mono dim">
            <Hl text={doc.original_name} q={q} />
          </span>
          {showParent && doc.category && <span className="dim">· {doc.category}</span>}
        </div>
        {showParent && <ParentLink parent={doc.parent} onOpen={onOpenParent} />}
      </div>
      <div className="doc-meta">
        {doc.reference_no && (
          <span className="ref" title="Reference No.">
            <span className="ref-label">Ref</span>
            <Hl text={doc.reference_no} q={q} />
          </span>
        )}
        {doc.tags.map((t) => (
          <span className="tag tag-static" key={t}>
            <Hl text={t} q={q} />
          </span>
        ))}
      </div>
      <div className="doc-facts mono dim">
        <span>{fmtSize(doc.size_bytes)}</span>
        <span>{fmtDate(doc.uploaded_at)}</span>
      </div>
      <div className="doc-actions">
        <button className="btn-icon" onClick={onOpenDoc} title={doc.file_type === 'excel' ? 'Details' : 'Preview'} aria-label="Open">
          <Icon name={doc.file_type === 'excel' ? 'sheet' : 'search'} />
        </button>
        <a className="btn-icon" href={fileUrl(doc.id, true)} title="Download" aria-label="Download">
          <Icon name="download" />
        </a>
        {onDelete && (
          <button className="btn-icon btn-icon-danger" onClick={onDelete} title="Delete" aria-label="Delete">
            <Icon name="trash" />
          </button>
        )}
      </div>
    </li>
  );
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.xlsx,.xlsm,.xls,.csv';
const stem = (name) => name.replace(/\.[^.]+$/, '');

export function UploadDialog({ parent, categories, initialCategory, tagSuggestions, onDone, onClose }) {
  const isContract = parent.type === 'contract';
  const [rows, setRows] = useState([]);
  const [allCategory, setAllCategory] = useState(initialCategory || '');
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const input = useRef();

  const addFiles = (list) => {
    const files = [...list];
    setRows((r) => [
      ...r,
      ...files.map((file) => ({ key: Math.random(), file, display_name: stem(file.name), category: allCategory, reference_no: '', tags: [] })),
    ]);
  };
  const patch = (key, p) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const submit = async () => {
    setError('');
    if (!rows.length) return setError('Add at least one file.');
    if (isContract && rows.some((r) => !r.category)) return setError('Pick a category for every file.');
    setProgress(0);
    try {
      await uploadFiles(
        `/api/${isContract ? 'contracts' : 'nocs'}/${parent.id}/documents`,
        rows.map((r) => r.file),
        rows.map(({ display_name, category, reference_no, tags }) => ({ display_name, category, reference_no, tags })),
        setProgress,
      );
      onDone();
      onClose();
    } catch (err) {
      setError(`${err.message}. Nothing was saved — fix it and try again.`);
      setProgress(null);
    }
  };

  return (
    <Modal title={`Add documents to ${parent.no}`} kicker={isContract ? 'Contract upload' : 'NOC upload'} onClose={onClose} wide>
      <div className="modal-body">
        <div
          className={`dropzone ${drag ? 'is-drag' : ''}`}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => input.current.click()}
        >
          <Icon name="upload" size={22} />
          <div>
            <span className="only-mouse">
              <strong>Drop files here</strong> or click to choose
            </span>
            <strong className="only-touch">Tap to choose files</strong>
            <div className="dim">PDF, images (PNG, JPG, GIF, WebP, BMP) and Excel (XLSX, XLS, CSV). Several at once.</div>
          </div>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
        </div>

        {rows.length > 0 && (
          <>
            {isContract && (
              <div className="apply-all">
                <span className="field-label">Set every file to</span>
                <select
                  value={allCategory}
                  onChange={(e) => {
                    setAllCategory(e.target.value);
                    setRows((r) => r.map((x) => ({ ...x, category: e.target.value })));
                  }}
                >
                  <option value="">Choose category…</option>
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
            <ol className="stage">
              {rows.map((r, i) => (
                <li key={r.key} className="stage-row">
                  <div className="stage-file">
                    <span className="mono stage-n">{String(i + 1).padStart(2, '0')}</span>
                    <span className="mono dim stage-orig" title={r.file.name}>
                      {r.file.name}
                    </span>
                    <span className="mono dim">{fmtSize(r.file.size)}</span>
                    <button className="btn-icon" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))} aria-label={`Remove ${r.file.name}`}>
                      <Icon name="x" />
                    </button>
                  </div>
                  <div className="stage-fields">
                    <Field label="Display name">
                      <input value={r.display_name} onChange={(e) => patch(r.key, { display_name: e.target.value })} />
                    </Field>
                    {isContract && (
                      <Field label="Category">
                        <select value={r.category} onChange={(e) => patch(r.key, { category: e.target.value })} className={!r.category ? 'is-missing' : ''}>
                          <option value="">Choose…</option>
                          {categories.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </Field>
                    )}
                    <Field label="Reference No." hint="Optional, e.g. invoice no.">
                      <input className="mono" value={r.reference_no} onChange={(e) => patch(r.key, { reference_no: e.target.value })} placeholder="INV-…" />
                    </Field>
                    <Field label="Tags" group>
                      <TagInput id={r.key} value={r.tags} onChange={(tags) => patch(r.key, { tags })} suggestions={tagSuggestions} />
                    </Field>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
      <footer className="modal-foot">
        {progress != null && (
          <div className="progress" aria-label="Upload progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={progress != null}>
          <Icon name="upload" /> {progress != null ? `Uploading ${Math.round(progress * 100)}%` : `Upload ${rows.length || ''} file${rows.length === 1 ? '' : 's'}`}
        </button>
      </footer>
    </Modal>
  );
}

// Phone/tablet browsers either can't render a PDF in an iframe (Android) or show only its first page (iOS).
const inlinePdf = !window.matchMedia('(hover: none) and (pointer: coarse)').matches;

export function DocDrawer({ id, meta, tagSuggestions, onClose, onChanged, onOpenParent }) {
  const [doc, setDoc] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setDoc(null);
    api('GET', `/api/documents/${id}`)
      .then((d) => {
        setDoc(d);
        setForm({ display_name: d.display_name, category: d.category, reference_no: d.reference_no || '', tags: d.tags });
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !confirm && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirm]);

  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const d = await api('PATCH', `/api/documents/${id}`, form);
      setDoc(d);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" aria-label="Document">
        <header className="drawer-head">
          {doc ? <ParentLink parent={doc.parent} onOpen={() => onOpenParent(doc.parent)} /> : <span />}
          <button className="btn-icon" onClick={onClose} aria-label="Close document">
            <Icon name="x" size={18} />
          </button>
        </header>
        {!doc && !error && <div className="drawer-loading">Loading…</div>}
        {error && !doc && <p className="form-error">{error}</p>}
        {doc && (
          <>
            <div className="drawer-title">
              <TypeGlyph type={doc.file_type} />
              <h2>{doc.display_name}</h2>
            </div>
            <div className="preview">
              {doc.file_type === 'pdf' &&
                (inlinePdf ? (
                  <iframe title={doc.display_name} src={fileUrl(doc.id)} />
                ) : (
                  <div className="preview-excel preview-pdf">
                    <Icon name="open" size={36} />
                    <p>Phones can't show PDFs inside a page.</p>
                    <a className="btn btn-primary" href={fileUrl(doc.id)} target="_blank" rel="noreferrer">
                      <Icon name="open" /> Open PDF
                    </a>
                  </div>
                ))}
              {doc.file_type === 'image' && <img src={fileUrl(doc.id)} alt={doc.display_name} />}
              {doc.file_type === 'excel' && (
                <div className="preview-excel">
                  <Icon name="sheet" size={40} />
                  <p>Spreadsheets have no in-app preview.</p>
                  <a className="btn btn-primary" href={fileUrl(doc.id, true)}>
                    <Icon name="download" /> Download {doc.original_name.split('.').pop().toUpperCase()}
                  </a>
                </div>
              )}
            </div>
            <div className="drawer-actions">
              <a className="btn" href={fileUrl(doc.id, true)}>
                <Icon name="download" /> Download
              </a>
              {(doc.file_type === 'image' || (doc.file_type === 'pdf' && inlinePdf)) && (
                <a className="btn" href={fileUrl(doc.id)} target="_blank" rel="noreferrer">
                  <Icon name="open" /> Open in new tab
                </a>
              )}
              <span className="spacer" />
              <button className="btn btn-ghost-danger" onClick={() => setConfirm(true)}>
                <Icon name="trash" /> Delete
              </button>
            </div>

            <form className="drawer-form" onSubmit={save}>
              <h3 className="section-label">Details</h3>
              <Field label="Display name" hint="Renaming never moves the stored file.">
                <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required />
              </Field>
              {doc.parent.type === 'contract' && (
                <Field label="Category">
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    {meta.categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Reference No.">
                <input className="mono" value={form.reference_no} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} placeholder="Optional" />
              </Field>
              <Field label="Tags" group>
                <TagInput id="drawer" value={form.tags} onChange={(tags) => setForm({ ...form, tags })} suggestions={tagSuggestions} />
              </Field>
              {error && <p className="form-error">{error}</p>}
              <button className="btn btn-primary" type="submit">
                {saved ? 'Saved ✓' : 'Save changes'}
              </button>
            </form>

            <dl className="facts">
              <dt>Document ID</dt>
              <dd className="mono">{doc.id}</dd>
              <dt>Original file</dt>
              <dd className="mono">{doc.original_name}</dd>
              <dt>Type · Size</dt>
              <dd className="mono">
                {doc.mime_type} · {fmtSize(doc.size_bytes)}
              </dd>
              <dt>Uploaded</dt>
              <dd className="mono">{new Date(doc.uploaded_at).toLocaleString()}</dd>
              <dt>Stored at</dt>
              <dd className="mono path">
                {meta.dataDir}/{doc.file_path}
              </dd>
            </dl>
          </>
        )}
      </aside>
      {confirm && (
        <DeleteDocConfirm
          doc={doc}
          onClose={() => setConfirm(false)}
          onDeleted={() => {
            onChanged();
            onClose();
          }}
        />
      )}
    </div>
  );
}

export function DeleteDocConfirm({ doc, onClose, onDeleted }) {
  return (
    <Confirm
      title={`Delete “${doc.display_name}”?`}
      onClose={onClose}
      onConfirm={async () => {
        await api('DELETE', `/api/documents/${doc.id}`);
        onDeleted();
      }}
    >
      <p>
        This removes the document record and its stored file <span className="mono">{doc.original_name}</span> from your data folder.
      </p>
      <p>This cannot be undone.</p>
    </Confirm>
  );
}
