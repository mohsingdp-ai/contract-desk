export async function api(method, url, body) {
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

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const fmtAmount = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtDate = (s) => new Date(s).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
export const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
export const tagKey = (s) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export const fileUrl = (id, download) => `/api/documents/${id}/file${download ? '?download=1' : ''}`;
