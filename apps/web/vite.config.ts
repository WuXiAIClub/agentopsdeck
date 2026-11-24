import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { fontScaleCss } from './src/lib/font-scale-css';
import { normalizeResourceOrigins } from './src/lib/resource-url';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), ''), ...process.env };
  const resourceOrigins = normalizeResourceOrigins([
    env.AOD_PUBLIC_BASE_URL ?? '',
    ...(env.AOD_WEB_RESOURCE_ORIGINS?.split(',') ?? []),
  ]);
  const allowedHosts = Array.from(new Set([
    ...(env.AOD_VITE_ALLOWED_HOSTS
      ?.split(',')
      .map((host) => host.trim())
      .filter(Boolean) ?? []),
  ]));

  return {
    define: { __AGENTOPSDECK_RESOURCE_ORIGINS__: JSON.stringify(resourceOrigins) },
    plugins: [react(), tailwindcss()],
    css: { postcss: { plugins: [fontScaleCss()] } },
    // Preserve distinct dependency licenses once per emitted chunk rather than
    // repeating the same legal notice for every imported icon module.
    esbuild: { legalComments: 'eof' },
    build: {
      manifest: true,
      rollupOptions: { output: { manualChunks(id, graph) {
        // Pure locale data has no runtime imports. Cache it independently of
        // transport/state code as the bilingual workspace vocabulary grows.
        if (id.endsWith('/apps/web/src/lib/translations.ts')) return 'workspace-locales';
        // Group only helpers reached through static imports from an entry.
        // Dynamic panels retain their own helpers automatically; adding a new
        // card must not silently make its code an initial download dependency.
        if (id.includes('/apps/web/src/lib/') || id.endsWith('/apps/web/src/api.ts')) {
          const seen = new Set<string>(), pending = [id];
          while (pending.length) {
            const next = pending.pop()!;
            if (seen.has(next)) continue;
            seen.add(next);
            const info = graph.getModuleInfo(next);
            if (info?.isEntry) return 'workspace-core';
            pending.push(...(info?.importers ?? []));
          }
        }
        if (!id.includes('/node_modules/')) return;
        // Separate stable runtime from optional editor engine/extensions. These
        // are cacheable module boundaries, not a larger warning threshold.
        if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) return 'react-runtime';
        if (/\/(?:prosemirror-[^/]+|orderedmap|rope-sequence|w3c-keyname)\//.test(id)) return 'notebook-engine';
        if (id.includes('/@tiptap/')) return 'notebook-extensions';
        if (/\/(?:react-markdown|remark-[^/]+|rehype-[^/]+|micromark[^/]*|mdast[^/]*|hast[^/]*|unist[^/]*|vfile[^/]*|unified)\//.test(id)) return 'markdown-renderer';
      } } },
    },
    server: {
      allowedHosts,
      proxy: {
        '/api': env.AOD_VITE_API_TARGET || 'http://127.0.0.1:8890',
      },
    },
    preview: {
      allowedHosts,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  };
});
