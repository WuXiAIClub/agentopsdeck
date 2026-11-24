import { useEffect, useMemo, useRef, useState } from 'react';
import { validWebsiteActions, validWebsiteActionReceipt, websiteBase64Bytes, type WebsiteAction, type WebsiteActionReceipt } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';

/** Explicit operator-defined actions, never submitted by the embedded website.
 * Reload/unmount never replays writes; only the user can read a receipt. */
export default function WorkspaceWebsiteActions({ scope, connectionId, serviceId }: { scope: string; connectionId: string; serviceId: string }) {
  const { t } = useI18n();
  const controller = useRef<AbortController | undefined>(undefined);
  const [actions, setActions] = useState<WebsiteAction[]>([]), [selected, setSelected] = useState('');
  const [body, setBody] = useState(''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(true);
  const [error, setError] = useState(false), [access, setAccess] = useState('');
  const [receipt, setReceipt] = useState<WebsiteActionReceipt>();
  const [filename, setFilename] = useState('');
  const [cookieSession, setCookieSession] = useState(false), [inputError, setInputError] = useState(false);
  const previous = useRef('');
  const handle = useRef(''), download = useRef<{ url: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const closeHandle = () => {
    const id = handle.current; handle.current = '';
    if (id && recoveryScope() === scope) void api.websiteActionClose(connectionId, id).catch(() => {});
  };
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    if (recoveryScope() === scope) void api.websiteActions(connectionId, serviceId, current.signal).then(result => {
      if (!validWebsiteActions(result)) throw Error('Invalid actions');
      if (!current.signal.aborted && recoveryScope() === scope) { setActions(result.actions); setCookieSession(result.session === true); setError(false); }
    }).catch(() => { if (!current.signal.aborted && recoveryScope() === scope) setError(true); })
      .finally(() => { if (!current.signal.aborted && recoveryScope() === scope) setBusy(false); });
    return () => { current.abort(); closeHandle(); if (download.current) { URL.revokeObjectURL(download.current.url); clearTimeout(download.current.timer); download.current = undefined; } };
  }, [scope, connectionId, serviceId]);
  const valid = () => controller.current && !controller.current.signal.aborted && recoveryScope() === scope;
  const action = actions.find(a => a.id === selected);
  const size = useMemo(() => action?.contentType === 'application/octet-stream' ? websiteBase64Bytes(body) ?? Infinity : new TextEncoder().encode(body).length, [action?.contentType, body]);
  const lock = useRef(false);
  const readFile = async (file?: File) => {
    if (!valid() || !action || lock.current) return;
    setBody(''); setFilename(''); setConsent(false); setInputError(false);
    if (!file) return;
    if (file.size > action.maxBytes) { setInputError(true); return; }
    lock.current = true; setBusy(true); setError(false);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let text = ''; for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
      if (valid()) { setBody(btoa(text)); setFilename(file.name); }
    } catch { if (valid()) setError(true); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const saveFile = () => {
    if (!valid() || !receipt?.file) return;
    if (download.current) { URL.revokeObjectURL(download.current.url); clearTimeout(download.current.timer); }
    const bytes = Uint8Array.from(atob(receipt.file.base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = receipt.file.filename; anchor.click();
    download.current = { url, timer: setTimeout(() => { URL.revokeObjectURL(url); download.current = undefined; }, 30000) };
  };
  const submit = async () => {
    if (!valid() || !action || !consent || size > action.maxBytes || action.contentType === 'application/octet-stream' && !filename || lock.current || access || receipt) return;
    lock.current = true; setBusy(true); setError(false);
    let sent = false;
    try {
      const lease = await api.websiteActionOpen(connectionId, serviceId, action.id, controller.current!.signal, previous.current || undefined) as { accessId?: unknown };
      if (!lease || typeof lease.accessId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(lease.accessId)) throw Error('Invalid lease');
      if (!valid()) { if (recoveryScope() === scope) void api.websiteActionClose(connectionId, lease.accessId).catch(() => {}); return; }
      handle.current = lease.accessId;
      previous.current = '';
      setAccess(lease.accessId); setReceipt({ state: 'pending' }); sent = true;
      const result = await api.websiteActionExecute(connectionId, lease.accessId, body, controller.current!.signal);
      if (!validWebsiteActionReceipt(result)) throw Error('Invalid receipt');
      if (valid()) { setReceipt(result); setBody(''); }
    } catch { if (valid()) { if (sent) setReceipt({ state: 'unknown' }); else setError(true); } }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const recover = async () => {
    if (!valid() || !access || lock.current) return;
    lock.current = true; setBusy(true); setError(false);
    try {
      const result = await api.websiteActionReceipt(connectionId, access, controller.current!.signal);
      if (!validWebsiteActionReceipt(result)) throw Error('Invalid receipt');
      if (valid()) setReceipt(result);
    } catch { if (valid()) setError(true); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  if (recoveryScope() !== scope) return null;
  return <div className="workspace-website-actions" role="region" aria-label={t('Controlled website actions')}>
    <p>{t('Configured operations can change this website. No Hub credentials are forwarded. No automatic retry.')}</p>
    {cookieSession && <p>{t('Configured website cookies stay in a private 5-minute session, separate from Hub login.')}
      {handle.current && !busy && <button type="button" onClick={() => { closeHandle(); previous.current = ''; setAccess(''); setReceipt(undefined); setConsent(false); setBody(''); setFilename(''); }}>{t('End website session')}</button>}</p>}
    {!receipt && <><label>{t('Website operation')}<select name="workspacewebsiteactions-select-1" disabled={busy} value={selected} onChange={event => { setSelected(event.target.value); setConsent(false); setBody(''); setFilename(''); setInputError(false); setError(false); }}>
      <option value="">{t('Choose an operation')}</option>{actions.map(a => <option key={a.id} value={a.id}>{a.label} · {a.method}</option>)}
    </select></label>
    {action && <>{action.download ? <p>{t('Download attachment')} · {action.download.filename} · ≤ {action.download.maxBytes.toLocaleString()} {t('bytes')}</p>
      : action.contentType === 'application/octet-stream' ? <label>{t('Upload file')}<input name="workspacewebsiteactions-input-2" key={selected} type="file" disabled={busy} aria-label={t('Upload file')} onChange={event => void readFile(event.target.files?.[0])} />{filename && <small>{filename}</small>}</label>
      : <label>{action.contentType}<textarea name="workspacewebsiteactions-textarea-3" aria-label={t('Operation body')} value={body} disabled={busy} maxLength={65536} onChange={e => setBody(e.target.value)} /></label>}
      {!action.download && <small>{size.toLocaleString()} / {action.maxBytes.toLocaleString()} {t('bytes')}</small>}
      <label><input name="workspacewebsiteactions-input-4" type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />{t('Allow this operation once')}</label>
      <button type="button" disabled={busy || !consent || size > action.maxBytes || action.contentType === 'application/octet-stream' && !filename} onClick={() => void submit()}>{t('Execute once')}</button></>}
    {!busy && !error && !actions.length && <p>{t('No operations configured for this website.')}</p>}</>}
    {receipt && <><p role="status">{receipt.state === 'completed' ? `${t('Website responded')} · HTTP ${receipt.status}` : receipt.state === 'pending' ? t('Operation pending. Check the receipt; do not resend.') : t('Operation result unknown. Check the website before starting another operation.')}</p>
      {receipt.state === 'completed' && (receipt.file ? <button type="button" onClick={saveFile}>{t('Download attachment')} · {receipt.file.filename}</button> : <pre>{receipt.text}</pre>)}
      {receipt.state !== 'completed' && <button type="button" disabled={busy} onClick={() => void recover()}>{t('Check operation receipt')}</button>}
      {receipt.state === 'completed' && <button type="button" disabled={busy} onClick={() => { if (cookieSession) previous.current = handle.current; else closeHandle(); setReceipt(undefined); setAccess(''); setConsent(false); setBody(''); setFilename(''); }}>{t('Prepare another operation')}</button>}</>}
    {inputError && <p role="alert">{t('File exceeds this operation’s upload limit.')}</p>}
    {error && <p role="alert">{t('Operation unavailable. Requires an explicit action policy and websites:act. Uncertain operations are never resent.')}</p>}
    <small>{t('Receipts expire within 5 minutes and are not kept after closing this panel. Closing cannot undo an operation.')}</small>
  </div>;
}
