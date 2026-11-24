import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownFile } from '../src/components/MarkdownFile';
import { LongTextReference } from '../src/components/LongTextReference';
import { LatestMessagesNotice } from '../src/components/LatestMessagesNotice';
import { useI18n } from '../src/lib/i18n';
import { editText } from '../src/components/ui/edit-text';
import { WorkspacePreferencesProvider, useWorkspacePreferences } from '../src/components/WorkspacePreferences';
import { OrganizedSessions, SessionOrganizationActions } from '../src/components/SessionOrganization';
import { BrowserSettings } from '../src/components/BrowserSettings';
import type { SessionSummary } from '@agentopsdeck/shared';
import '../src/styles.css';

const markdown = '# Safe report\n\n**Rich text**\n\n| File | Result |\n| --- | --- |\n| app.ts | passed |\n\n![Tracking pixel](https://invalid.example/pixel)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.previewExecuted = true</script>';
const sessions = ['alpha', 'beta', 'gamma'].map(sessionKey => ({ sessionKey, title: sessionKey })) as SessionSummary[];
function Organization() {
  const { value } = useWorkspacePreferences();
  const [selected, setSelected] = useState('alpha');
  return <section aria-label="Organization">
    <OrganizedSessions sessions={sessions}>{session => <button data-session={session.sessionKey} style={{ color: value.sessions[session.sessionKey]?.color }} onClick={() => setSelected(session.sessionKey)}>{session.title}</button>}</OrganizedSessions>
    <SessionOrganizationActions sessionKey={selected} />
    <output aria-label="Preferences snapshot">{JSON.stringify(value)}</output>
  </section>;
}
function Fixture() {
  const { t, locale, setLocale } = useI18n();
  const [text, setText] = useState('Draft 原文');
  const [name, setName] = useState('Original');
  const [loading, setLoading] = useState(true);
  return <main className="mx-auto max-w-3xl space-y-5 p-4">
    <label>Language <select value={locale} onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    <section aria-label="Markdown"><MarkdownFile text={markdown} /></section>
    <section aria-label="Composer"><LongTextReference text={text} editable><textarea aria-label="Message" value={text} onChange={event => setText(event.target.value)} className="w-full" /></LongTextReference></section>
    <button onClick={() => setText('文'.repeat(100000))}>Load 100k</button>
    <section aria-label="Read-only reference"><LongTextReference text={'Output '.repeat(1000)}><pre className="whitespace-pre-wrap">{'Output '.repeat(1000)}</pre></LongTextReference></section>
    <button onClick={() => editText({ title: t('Rename session'), initial: name, maxLength: 80, onSave: async value => { if (value === 'fail') throw new Error('Synthetic save failure'); setName(value); } })}>{t('Rename session')}</button>
    <output aria-label="Session name">{name}</output>
    <LatestMessagesNotice active={loading} />
    <button onClick={() => setLoading(!loading)}>Toggle loading</button>
    <WorkspacePreferencesProvider paused={false}><Organization /></WorkspacePreferencesProvider>
    <BrowserSettings />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
