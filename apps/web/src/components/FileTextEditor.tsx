import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';

/** Native text editing preserves IME, undo and selection. Only visible gutter
 * lines render, so a newline-heavy preview cannot create thousands of nodes. */
export function FileTextEditor({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (value: string) => void }) {
  const { t } = useI18n(), input = useRef<HTMLTextAreaElement>(null);
  const [scroll, setScroll] = useState(0), [height, setHeight] = useState(400);
  const lineCount = useMemo(() => value.split('\n').length, [value]);
  useEffect(() => {
    const node = input.current; if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight)); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scroll / 22)), count = Math.max(0, Math.min(lineCount - first, Math.ceil(height / 22) + 2));
  return <div className="file-text-editor" data-readonly={readOnly}>
    <div className="file-text-gutter" aria-hidden="true"><pre style={{ transform: `translateY(${12 + first * 22 - scroll}px)` }}>{Array.from({ length: count }, (_, i) => first + i + 1).join('\n')}</pre></div>
    <textarea name="filetexteditor-textarea-1" ref={input} aria-label={t('File content')} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" value={value} readOnly={readOnly}
      onScroll={event => setScroll(event.currentTarget.scrollTop)} onChange={event => onChange(event.target.value)} />
  </div>;
}
