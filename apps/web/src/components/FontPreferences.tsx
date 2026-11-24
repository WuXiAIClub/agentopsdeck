import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { recoveryScope, subscribeRecoveryScope } from '../api';
import { defaultFontPreferences, fontPreferenceKey, fontScales, fontScaleMinimum, fontScaleMax, snapFontScale, isFontScale, parseFontPreferences, type FontArea, type FontPreferences, type FontScale } from '../lib/font-preferences';
import { useI18n } from '../lib/i18n';

const Context = createContext({ value: defaultFontPreferences(), persistent: true, change: (_area: FontArea, _size: FontScale) => {} });
export function FontPreferencesProvider({ children }: { children: ReactNode }) {
  const scope = useSyncExternalStore(subscribeRecoveryScope, recoveryScope);
  const key = fontPreferenceKey(scope);
  const read = () => { try { return parseFontPreferences(key ? localStorage.getItem(key) : null); } catch { return defaultFontPreferences(); } };
  const [stored, setStored] = useState(() => ({ key, value: read(), persistent: true }));
  const value = stored.key === key ? stored.value : read();
  useLayoutEffect(() => {
    for (const area of ['sessions', 'chat', 'notebooks'] as const) document.documentElement.style.setProperty(`--agentopsdeck-${area}-font-scale`, String(value[area] / 100));
  }, [value.sessions, value.chat, value.notebooks]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === key || event.key === null) setStored({ key, value: read(), persistent: true }); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [key]);
  function change(area: FontArea, size: FontScale) {
    if (!isFontScale(size) || size < fontScaleMinimum(area)) return;
    const next: FontPreferences = { ...value, [area]: size };
    let persistent = Boolean(key);
    try { if (key) localStorage.setItem(key, JSON.stringify(next)); } catch { persistent = false; }
    setStored({ key, value: next, persistent });
  }
  return <Context.Provider value={{ value, change, persistent: stored.key !== key || stored.persistent }}>{children}</Context.Provider>;
}

export function FontPreferenceControls() {
  const { t } = useI18n();
  const { value, change, persistent } = useContext(Context);
  const scope = useSyncExternalStore(subscribeRecoveryScope, recoveryScope);
  const areas = { sessions: 'Session list', chat: 'Chat text', notebooks: 'Notebook text' } as const;
  return <section className="font-preferences" aria-label={t('Text size')}>
    <h3>{t('Text size')}</h3>
    <p>{t('Applies to all sessions. Saved for this user in this browser.')}</p>
    <p>{t('Preview while dragging; release to apply.')}</p>
    {(Object.keys(areas) as FontArea[]).map(area => <FontScaleControl key={`${scope}:${area}`} area={area} label={t(areas[area])} value={value[area]} onCommit={size => change(area, size)} />)}
    {!persistent && <p role="status">{t('Text size changed for this page. Browser storage is unavailable; it may reset after refresh.')}</p>}
  </section>;
}

// Keep pointer movement local: no localStorage writes, context broadcast or
// six-transcript reflow until release. Never feed snapped values into a drag.
function FontScaleControl({ area, label, value, onCommit }: { area: FontArea; label: string; value: FontScale; onCommit: (size: FontScale) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const dragging = useRef(false);
  const latest = useRef(value);
  useEffect(() => { if (!dragging.current) { latest.current = value; setDraft(value); } }, [value]);
  const sizes = { 80: 'Small', 90: 'Medium', 100: 'Default', 110: 'Large' } as const;
  function finish() {
    if (!dragging.current) return;
    dragging.current = false;
    const next = snapFontScale(latest.current, area);
    latest.current = next;
    setDraft(next);
    if (next !== value) onCommit(next);
  }
  function cancel() { dragging.current = false; latest.current = value; setDraft(value); }
  return <fieldset data-font-preference={area}>
    <legend>{label}<output>{draft}%</output></legend>
    <input name="fontpreferences-input-1" className="font-scale-slider" type="range" min={fontScaleMinimum(area)} max={fontScaleMax} step="1" value={draft} aria-label={label} aria-valuetext={`${draft}%`} list={`font-stops-${area}`}
      onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerUp={finish} onLostPointerCapture={finish} onBlur={finish} onPointerCancel={cancel}
      onChange={event => { const next = Number(event.target.value); latest.current = next; setDraft(next); if (!dragging.current) onCommit(next); }} />
    <datalist id={`font-stops-${area}`}>{fontScales.map(size => <option key={size} value={size} label={`${size}%`} />)}</datalist>
    <p className="font-scale-sample" style={{ fontSize: `${draft / 100}rem` }}>{t('Text size preview')}</p>
    <div>{fontScales.map(size => <label key={size}>
      <input type="radio" name={`font-size-${area}`} value={size} checked={draft === size} onChange={() => { cancel(); latest.current = size; setDraft(size); onCommit(size); }} />
      <span>{t(sizes[size])}<small>{size}%</small></span>
    </label>)}</div>
  </fieldset>;
}
