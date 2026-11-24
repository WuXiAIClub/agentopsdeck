export function createResourceRouter(currentOrigin, publicOrigin, lanOrigins) {
  return value => {
    if (typeof value !== 'string') return value;
    try {
      const current = new URL(currentOrigin).origin;
      const fallback = new URL(publicOrigin).origin;
      if (!lanOrigins.includes(current) && current !== fallback) return value;
      if (!/^https?:\/\//i.test(value) || /\\|%(?:2e|2f|5c)/i.test(value.split(/[?#]/, 1)[0])) return value;
      const rawPath = value.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
      if (rawPath.split('/').some(part => part === '.' || part === '..')) return value;
      const url = new URL(value);
      if (url.username || url.password || (!lanOrigins.includes(url.origin) && url.origin !== fallback)) return value;
      const path = url.pathname;
      const allowed = /^\/api\/media\/inbound\/[\w.-]+$/.test(path)
        || /^\/api\/artifacts\/[a-f0-9]+$/i.test(path)
        || /^\/api\/files\/(?:gateway|agents\/[^/?#]+)\/download$/.test(path)
        || /^\/api\/hub\/v1\/(?:sessions\/[^/?#]+|shared\/[^/?#]+\/sessions\/[^/?#]+)\/messages\/[^/?#]+\/media\/[a-f0-9]{64}$/.test(path);
      if (!allowed) return value;
      return current + path + url.search + url.hash;
    } catch { return value; }
  };
}

export function installResourceRouting(window, document, publicOrigin, lanOrigins) {
  const route = createResourceRouter(window.location.origin, publicOrigin, lanOrigins);
  window.__AGENTOPSDECK_RESOURCE_URL__ = route;
  const selector = 'a[href],img[src],video[src],video[poster],audio[src],source[src]';
  const rewrite = element => {
    const attributes = element.tagName === 'A' ? ['href'] : element.tagName === 'VIDEO' ? ['src', 'poster'] : ['src'];
    for (const attribute of attributes) {
      const original = element.getAttribute(attribute);
      const selected = route(original);
      if (selected !== original) element.setAttribute(attribute, selected);
    }
  };
  const scan = node => {
    if (node.nodeType !== 1) return;
    if (node.matches(selector)) rewrite(node);
    node.querySelectorAll(selector).forEach(rewrite);
  };
  scan(document.documentElement);
  new window.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.matches(selector)) rewrite(record.target);
      } else record.addedNodes.forEach(scan);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'src', 'poster'] });
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[href]');
    if (anchor) rewrite(anchor);
  }, true);
}
