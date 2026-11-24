import React, { useEffect, useRef, useState } from 'react';
import { LONG_MESSAGE_PREVIEW_CHARS } from '@agentopsdeck/shared';
import { useI18n } from '../lib/i18n';

/** A view of the original text, never a replacement payload or uploaded file. */
export function LongTextReference({ text, children, editable = false }: { text: string; children: React.ReactNode; editable?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const long = text.length > LONG_MESSAGE_PREVIEW_CHARS;
  useEffect(() => { if (!long) setExpanded(false); }, [long]);
  const visible = !long || expanded;
  // Keep the editable textarea mounted at the same position across the threshold:
  // typing/pasting must not lose focus, selection or an IME composition.
  // Collapse only on an explicit action. Collapsing on blur shifts buttons under
  // the pointer between pointerdown and click and can silently swallow Send.
  return <div className={long ? 'long-text-reference' : 'min-w-0 w-full'}>
    {long && <button type="button" className="long-text-reference-toggle" aria-expanded={visible} onClick={() => {
      setExpanded(!visible);
      if (!visible && editable) requestAnimationFrame(() => {
        const textarea = content.current?.querySelector('textarea');
        if (textarea) { textarea.focus(); textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`; }
      });
    }}>
      <span aria-hidden="true">≡</span><span>{t('Text reference')} · {text.length.toLocaleString()} {t('characters')}</span>
      <span>{t(visible ? 'Collapse' : editable ? 'View / edit' : 'View full text')}</span>
    </button>}
    <div ref={content} hidden={!visible} onFocusCapture={() => { if (editable) setExpanded(true); }}>{editable || visible ? children : null}</div>
    {!visible && <p className="long-text-reference-excerpt">{text.slice(0, 160)}…</p>}
  </div>;
}
