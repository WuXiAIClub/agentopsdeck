import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import { NotebookPopover } from './NotebookPopover';
import { notebookTask, toggleNotebookTask } from '../lib/notebook-presentation';
import { useI18n } from '../lib/i18n';

export function NotebookMarkdown({ text, disabled, onChange }: { text: string; disabled: boolean; onChange: (text: string) => void }) {
  const { t } = useI18n();
  const content = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [outline, setOutline] = useState<{ element: HTMLElement; title: string; level: number }[] | null>(null);
  const [minimapItems, setMinimapItems] = useState<{ element: HTMLElement; title: string; level: number }[]>([]);
  useEffect(() => setOutline(null), [text]);
  const readHeadings = () => {
    const headings = content.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6');
    return Array.from(headings ?? []).slice(0, 200).map(element => ({ element, title: (element.textContent ?? '').slice(0, 160), level: Number(element.tagName[1]) }));
  };
  const scrollToElement = (element: HTMLElement) => {
    setOutline(null);
    const container = content.current;
    if (!container?.contains(element)) return;
    container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    element.tabIndex = -1; element.focus({ preventScroll: true });
  };
  return <div className="notebook-preview">
    <div className="notebook-preview-navigation">
      <button ref={trigger} className="notebook-outline-trigger" type="button" aria-label={t('Notebook contents')} title={t('Notebook contents')} aria-expanded={outline !== null}
        onClick={() => {
          if (outline !== null) { setOutline(null); return; }
          // Read the rendered headings only when requested: fenced code and HTML are not headings.
          setOutline(readHeadings());
        }}><ListTree size={15} /></button>
    </div>
    {outline !== null && <NotebookPopover anchor={trigger} onClose={() => setOutline(null)} className="notebook-outline" label={t('Notebook contents')}>
      {!outline.length && <p>{t('Add headings to navigate this notebook.')}</p>}
      {outline.map((item, index) => <button type="button" key={index} style={{ paddingInlineStart: `${item.level * 8}px` }} onClick={() => scrollToElement(item.element)}>{item.title || t('Heading')}</button>)}
      {outline.length === 200 && <p>{t('Showing the first 200 headings.')}</p>}
    </NotebookPopover>}
    <aside className="notebook-hover-minimap" aria-label={t('Quick outline minimap')} onMouseEnter={() => setMinimapItems(readHeadings())} onFocus={() => setMinimapItems(readHeadings())}>
      <div className="notebook-hover-minimap-rail" aria-hidden="true"><span style={{ width: '16px' }} /><span style={{ width: '11px' }} /><span style={{ width: '14px' }} /></div>
      <div className="notebook-hover-minimap-panel">
        {!minimapItems.length && <small>{t('Add headings to navigate this notebook.')}</small>}
        {minimapItems.map((item, index) => <button type="button" key={index} style={{ paddingInlineStart: `${Math.min(item.level, 6) * 6}px` }} onClick={() => scrollToElement(item.element)}>{item.title || t('Heading')}</button>)}
      </div>
    </aside>
    <div className="notebook-markdown" ref={content}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    // No external image requests/tracking from a private notebook.
    img: ({ alt }) => <span>{alt}</span>,
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
    input: () => null,
    li: ({ node, children, ...props }) => {
      const offset = node?.position?.start.offset;
      const task = notebookTask(text, offset);
      return <li {...props}>{task && <input name="notebookmarkdown-input-1" type="checkbox" aria-label={t('Toggle task')} checked={task.checked} disabled={disabled}
        onChange={event => onChange(toggleNotebookTask(text, offset!, event.target.checked))} />}{children}</li>;
    },
  }}>{text}</ReactMarkdown>{!text && <p>{t('Empty note')}</p>}</div></div>;
}
