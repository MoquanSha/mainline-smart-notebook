// Shared by the desktop tunnel and the standalone relay deployment.
const POST_PATHS = new Set(['/api/home/rpc', '/api/home/batch', '/api/home/comment-image']);
const IMAGE_PATH = /^\/api\/home\/comment-images\/todo-image-\d+-[a-z0-9]+\.(?:jpg|png|webp)$/i;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

function allowedTarget(method, value) {
  if (typeof value !== 'string' || !value.startsWith('/api/home/') || /[\\#\r\n]/.test(value)) return null;
  let url;
  try { url = new URL(value, 'http://home.local'); } catch { return null; }
  if (url.pathname !== value.split('?')[0]) return null;
  if (method === 'POST' && POST_PATHS.has(url.pathname) && !url.search) return url.pathname;
  if (method !== 'GET') return null;
  if (url.pathname === '/api/home/ping' && !url.search) return url.pathname;
  const keys = [...url.searchParams.keys()];
  if (url.pathname === '/api/home/changes' && keys.length <= 1 && keys.every(key => key === 'since') &&
      String(url.searchParams.get('since') || '').length <= 200) return `${url.pathname}${url.search}`;
  if (IMAGE_PATH.test(url.pathname) && keys.length === 1 && keys[0] === 'token' && url.searchParams.get('token')) {
    return `${url.pathname}${url.search}`;
  }
  return null;
}

function scopedHeaders(headers, publicBaseUrl) {
  const result = {};
  const allowed = new Set(['authorization', 'content-type', 'x-file-name', 'x-request-id', 'x-mainline-scope', 'x-mainline-token']);
  for (const [name, value] of Object.entries(headers || {})) {
    if (allowed.has(name.toLowerCase()) && typeof value === 'string') result[name.toLowerCase()] = value;
  }
  if (publicBaseUrl) result['x-mainline-public-base'] = publicBaseUrl;
  return result;
}

module.exports = { allowedTarget, scopedHeaders, MAX_BODY_BYTES };
