/** The composed async write/control package owns only these exact HTTP routes.
 * Unknown suffixes and shared capability routes retain the normal middleware. */
export function sessionNotebookWriteRoute(method: string, path: string): boolean {
  const root = '/api/hub/v1/(?:shared/[^/]+/)?sessions/[^/]+/notebook';
  if (method === 'PUT') return new RegExp(`^${root}(?:/archive)?$`).test(path);
  if (method === 'POST' && new RegExp(`^${root}/moves$`).test(path)) return true;
  if (['GET', 'HEAD'].includes(method) && new RegExp(`^${root}/moves/[^/]+$`).test(path)) return true;
  const owner = '/api/hub/v1/sessions/[^/]+/notebook/capabilities';
  return (['GET', 'HEAD', 'POST'].includes(method) && new RegExp(`^${owner}$`).test(path))
    || (method === 'DELETE' && new RegExp(`^${owner}/[^/]+$`).test(path));
}
