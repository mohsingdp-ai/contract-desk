import * as phone from './phone.js';

const { isPhone, request, upload } = phone;

export { isPhone };

export async function api(method, url, body) {
  if (isPhone) return request(method, url, body); // the phone has no server: its database worker answers
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (data?.login) window.dispatchEvent(new Event('passcode-required'));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// XHR instead of fetch so the upload dialog can show progress.
export function uploadFiles(url, files, meta, onProgress) {
  if (isPhone) return upload(url, files, meta, onProgress); // written straight to the phone's data folder
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    fd.append('meta', JSON.stringify(meta));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (data?.login) window.dispatchEvent(new Event('passcode-required'));
      xhr.status < 300 ? resolve(data) : reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: the server could not be reached'));
    xhr.send(fd);
  });
}

// Restore from a backup file: check it (answers what would be replaced), then apply or cancel. On the desktop the file
// streams to this computer's server; the phone reads it in pieces itself. signal: stop checking (the dialog was closed).
export async function checkRestore(file, signal) {
  if (isPhone) return phone.checkRestore(file, signal);
  const res = await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Restore failed (${res.status})`);
  return data;
}
export const applyRestore = () => (isPhone ? phone.applyRestore() : api('POST', '/api/restore/apply'));
export const cancelRestore = () => (isPhone ? phone.cancelRestore() : api('DELETE', '/api/restore').catch(() => {}));

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const fmtAmount = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtDate = (s) => new Date(s).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
export const fmtSize = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(1)} GB`;
// toLowerCase, not toLocaleLowerCase: the same tag must match on every device, whatever its language.
export const tagKey = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
// The optional trailing name is cosmetic: browsers' PDF viewers and new tabs show it as the title.
export const fileUrl = (id, download, name) =>
  `/api/documents/${id}/file${name ? `/${encodeURIComponent(name)}` : ''}${download ? '?download=1' : ''}`;
