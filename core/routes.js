// The app's JSON routes and the shared rule each one calls. The desktop server registers them with Express;
// the phone's database worker answers the same requests without HTTP (callRoute), so both stay in step.
import { errorReply } from './rules.js';

// Each entry: [method, path, handler(rules, params, query, body), status on success]
export const ROUTES = [
  ['GET', '/api/categories', (r) => r.listCategories()],
  ['POST', '/api/categories', (r, p, q, b) => r.addCategory(b?.name), 201],
  ['PATCH', '/api/categories/:id', (r, p, q, b) => r.updateCategory(p.id, b)],
  ['DELETE', '/api/categories/:id', (r, p, q) => r.deleteCategory(p.id, q.move_to)],

  ['GET', '/api/facets', (r) => r.facets()],

  ['GET', '/api/contracts', (r, p, q) => r.listContracts(q)],
  ['POST', '/api/contracts', (r, p, q, b) => r.createContract(b), 201],
  ['GET', '/api/contracts/:id', (r, p) => r.getContract(p.id)],
  ['PUT', '/api/contracts/:id', (r, p, q, b) => r.updateContract(p.id, b)],
  ['DELETE', '/api/contracts/:id', (r, p) => r.deleteContract(p.id)],

  ['GET', '/api/nocs', (r, p, q) => r.listNocs(q)],
  ['POST', '/api/nocs', (r, p, q, b) => r.createNoc(b), 201],
  ['GET', '/api/nocs/:id', (r, p) => r.getNoc(p.id)],
  ['PUT', '/api/nocs/:id', (r, p, q, b) => r.updateNoc(p.id, b)],
  ['DELETE', '/api/nocs/:id', (r, p) => r.deleteNoc(p.id)],

  ['GET', '/api/documents', (r, p, q) => r.listDocuments(q)],
  ['GET', '/api/documents/:id', (r, p) => r.getDocument(p.id)],
  ['PATCH', '/api/documents/:id', (r, p, q, b) => r.updateDocument(p.id, b)],
  ['DELETE', '/api/documents/:id', (r, p) => r.deleteDocument(p.id)],
];

const compiled = ROUTES.map(([method, path, handler, status = 200]) => ({
  method,
  re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`),
  handler,
  status,
}));

// Runs a request against the rules without a web server: { status, data } or { status, error }.
export function callRoute(rules, method, url, body) {
  const u = new URL(url, 'http://app');
  for (const r of compiled) {
    const m = r.method === method && u.pathname.match(r.re);
    if (!m) continue;
    try {
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      return { status: r.status, data: r.handler(rules, params, Object.fromEntries(u.searchParams), body) };
    } catch (err) {
      const { status, message } = errorReply(err);
      return { status, error: message };
    }
  }
  return { status: 404, error: 'Not found' };
}
