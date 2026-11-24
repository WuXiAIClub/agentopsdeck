import React, { useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../lib/i18n';

export const isMarkdownFile = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

/** Phrasing-only output is valid even when a source card is inside a chat paragraph.
 * No raw HTML, remote images, recursive source fetches or active content in reports. */
export function MarkdownFile({ text, raw, limited = false }: { text: string; raw?: React.ReactNode; limited?: boolean }) {
  const [mode, setMode] = useState<'preview' | 'raw'>('preview');
  const { t } = useI18n();
  return <span className="markdown-file">
    <span className="preview-mode-switch" role="group" aria-label={t('Markdown preview')}>
      {(['preview', 'raw'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{t(value === 'preview' ? 'Preview' : 'Raw')}</button>)}
    </span>
    {mode === 'raw' ? raw ?? <span className="markdown-file-raw">{text}</span> : <span className={`markdown-file-content${limited ? ' is-limited' : ''}`} tabIndex={0}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => /^https?:\/\/|^mailto:|^#/i.test(url) ? defaultUrlTransform(url) : ''} components={{
        p: ({ children }) => <span className="md-paragraph">{children}</span>,
        h1: ({ children }) => <span role="heading" aria-level={1} className="md-heading md-h1">{children}</span>,
        h2: ({ children }) => <span role="heading" aria-level={2} className="md-heading md-h2">{children}</span>,
        h3: ({ children }) => <span role="heading" aria-level={3} className="md-heading">{children}</span>,
        h4: ({ children }) => <span role="heading" aria-level={4} className="md-heading">{children}</span>,
        h5: ({ children }) => <span role="heading" aria-level={5} className="md-heading">{children}</span>,
        h6: ({ children }) => <span role="heading" aria-level={6} className="md-heading">{children}</span>,
        ul: ({ children }) => <span role="list" className="md-list">{children}</span>,
        ol: ({ children }) => <span role="list" className="md-list md-ordered">{children}</span>,
        li: ({ children }) => <span role="listitem" className="md-listitem">{children}</span>,
        pre: ({ children }) => <span className="md-pre">{children}</span>,
        blockquote: ({ children }) => <span className="md-quote">{children}</span>,
        hr: () => <span role="separator" className="md-rule" />,
        table: ({ children }) => <span role="table" className="md-table">{children}</span>,
        thead: ({ children }) => <span role="rowgroup">{children}</span>,
        tbody: ({ children }) => <span role="rowgroup">{children}</span>,
        tr: ({ children }) => <span role="row" className="md-row">{children}</span>,
        th: ({ children }) => <span role="columnheader" className="md-cell">{children}</span>,
        td: ({ children }) => <span role="cell" className="md-cell">{children}</span>,
        img: ({ alt }) => <span className="md-image-label">[ {alt || t('Image')} ]</span>,
        a: ({ children, href }) => href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
      }}>{text}</ReactMarkdown>
    </span>}
  </span>;
}
