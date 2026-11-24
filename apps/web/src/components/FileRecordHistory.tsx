import React, { useState } from 'react';
import type { FileRecord } from '../lib/session-files';
import { useI18n } from '../lib/i18n';
import { FileChangeRecord } from './FileChangeRecord';

export function FileRecordHistory({ sessionKey, path, records, limited }: { sessionKey: string; path: string; records: FileRecord[]; limited: boolean }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState('');
  const current = records.find(record => record.messageId === selected) ?? records[0];
  if (!current) return null;
  return <section className="file-record-history" aria-label={t('File change history')}>
    <label>{t('File change history')}<select name="filerecordhistory-select-1" aria-label={t('Choose a recorded change')} value={current.messageId} onChange={event => setSelected(event.target.value)}>
      {records.map((record, index) => <option key={record.messageId} value={record.messageId}>{index + 1}. {new Date(record.createdAt).toLocaleString()} · {t(record.kind === 'added' ? 'Added' : record.kind === 'deleted' ? 'Deleted file' : 'Modified')}</option>)}
    </select></label>
    <p>{t(current.source === 'loaded' ? 'Evidence source: loaded tool result' : 'Evidence source: saved file index')}</p>
    <p>{t('Only available records are listed; gaps do not mean the file was unchanged.')}{limited ? ` ${t('Showing the latest 40 loaded records for this path.')}` : ''}</p>
    <FileChangeRecord key={`${sessionKey}:${path}:${current.messageId}`} sessionKey={sessionKey} messageId={current.messageId} path={path} time={current.createdAt} />
  </section>;
}
