(() => {
  function createRouter(currentOrigin, publicOrigin, localOrigins) {
    const trusted = [publicOrigin, ...localOrigins];
    return value => {
      if (typeof value !== 'string' || !trusted.includes(currentOrigin)) return value;
      try {
        if (!/^https?:\/\//i.test(value) || /\\|%(?:2e|2f|5c)/i.test(value.split(/[?#]/, 1)[0])) return value;
        const rawPath = value.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
        if (rawPath.split('/').some(part => part === '.' || part === '..')) return value;
        const address = new URL(value);
        if (address.username || address.password || !trusted.includes(address.origin)) return value;
        const path = address.pathname;
        const allowed = /^\/api\/media\/inbound\/[A-Za-z0-9_.-]+$/.test(path)
          || /^\/api\/artifacts\/[a-f0-9]+$/i.test(path)
          || /^\/api\/files\/(?:gateway|agents\/[^/?#]+)\/download$/.test(path)
          || /^\/api\/hub\/v1\/(?:sessions\/[^/?#]+|shared\/[^/?#]+\/sessions\/[^/?#]+)\/messages\/[^/?#]+\/media\/[a-f0-9]{64}$/.test(path);
        return allowed ? currentOrigin + path + address.search + address.hash : value;
      } catch { return value; }
    };
  }

  function install(settings) {
    if (location.origin !== settings.currentOrigin || window !== window.top) return;
    const route = createRouter(settings.currentOrigin, settings.publicOrigin, settings.localOrigins);
    window.__AGENTOPSDECK_RESOURCE_URL__ = route;
    const attributes = { A: ['href'], IMG: ['src'], VIDEO: ['src', 'poster'], AUDIO: ['src'], SOURCE: ['src'] };
    const selector = 'a[href],img[src],video[src],video[poster],audio[src],source[src]';
    const nativeSetAttribute = Element.prototype.setAttribute;
    const rewrite = element => {
      for (const attribute of attributes[element.tagName] ?? []) {
        const original = element.getAttribute(attribute);
        const selected = route(original);
        if (selected !== original) nativeSetAttribute.call(element, attribute, selected);
      }
    };
    const scan = node => {
      if (node.nodeType !== 1) return;
      if (node.matches(selector)) rewrite(node);
      node.querySelectorAll(selector).forEach(rewrite);
    };
    Element.prototype.setAttribute = function(name, value) {
      const selected = attributes[this.tagName]?.includes(String(name).toLowerCase()) ? route(value) : value;
      return nativeSetAttribute.call(this, name, selected);
    };
    const setters = [[HTMLAnchorElement, 'href'], [HTMLImageElement, 'src'], [HTMLMediaElement, 'src'],
      [HTMLSourceElement, 'src'], [HTMLVideoElement, 'poster']];
    for (const [type, attribute] of setters) {
      const descriptor = Object.getOwnPropertyDescriptor(type.prototype, attribute);
      if (!descriptor?.set || !descriptor.configurable) continue;
      Object.defineProperty(type.prototype, attribute, {
        ...descriptor, set(value) { descriptor.set.call(this, route(value)); }
      });
    }
    const nativeFetch = window.fetch;
    window.fetch = function(input, options) {
      const method = (options?.method ?? 'GET').toUpperCase();
      if (['GET', 'HEAD'].includes(method) && !options?.headers &&
          (typeof input === 'string' || input instanceof URL)) {
        return nativeFetch.call(this, route(String(input)), options);
      }
      return nativeFetch.call(this, input, options);
    };
    scan(document.documentElement ?? document);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') rewrite(record.target);
        else record.addedNodes.forEach(scan);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'src', 'poster'] });
    document.addEventListener('click', event => {
      const anchor = event.target.closest?.('a[href]');
      if (anchor) rewrite(anchor);
    }, true);
  }

  globalThis.AgentOpsDeckResources = Object.freeze({ createRouter, install });
})();
