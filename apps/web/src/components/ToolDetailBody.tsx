import React from 'react';
import { useI18n } from '../lib/i18n';
import type { TranslationKey } from '../lib/translations';
import { cn } from '../lib/cn';
import type {
  StructuredToolDetail,
  ToolAgentStatusEntry,
  ToolFileChangeItem,
  ToolInputBlock,
  ToolOutputBlock,
  ToolParamItem,
  ToolStatusTone,
} from '../lib/tool-detail-format';

const STATUS_TRANSLATION_KEYS: Record<string, TranslationKey> = {
  Completed: 'Completed',
  Running: 'Running',
  Failed: 'Failed',
  'Timed out': 'Timed out',
  Cancelled: 'Cancelled',
  Closed: 'Closed',
};

export function translateToolStatusLabel(label: string, tr: (key: TranslationKey) => string): string {
  const key = STATUS_TRANSLATION_KEYS[label];
  return key ? tr(key) : label;
}

export function ToolDetailBody({
  parsed,
  compact = false,
}: {
  parsed: StructuredToolDetail;
  compact?: boolean | undefined;
}) {
  const { t: tr } = useI18n();
  const hasAnySection = Boolean(parsed.input || parsed.error || parsed.output);

  return (
    <div className={cn('tool-detail-structured', compact && 'tool-detail-structured--compact')}>
      {parsed.input ? (
        <section className="tool-detail-section">
          <div className="tool-detail-section-header">
            <span className="tool-detail-section-title">
              {parsed.input.kind === 'command' ? tr('Command') : tr('Parameters')}
            </span>
          </div>
          {renderInputBlock(parsed.input, tr)}
        </section>
      ) : null}

      {parsed.error ? (
        <section className="tool-detail-section tool-detail-section--error">
          <div className="tool-detail-section-header">
            <span className="tool-detail-section-title">{tr('Error')}</span>
          </div>
          <pre className="tool-detail-code tool-detail-code--error">{parsed.error}</pre>
        </section>
      ) : null}

      {parsed.output ? (
        <section className="tool-detail-section">
          <div className="tool-detail-section-header">
            <span className="tool-detail-section-title">
              {parsed.output.kind === 'agentStatus'
                ? tr('Sub-agent status')
                : parsed.output.kind === 'fileChanges' || parsed.output.kind === 'diff'
                  ? tr('File changes')
                  : tr('Output')}
            </span>
            {parsed.output.kind === 'terminal' && parsed.output.chunkId ? (
              <span className="tool-detail-section-meta">#{parsed.output.chunkId}</span>
            ) : null}
          </div>
          {renderOutputBlock(parsed.output, tr)}
        </section>
      ) : null}

      {!hasAnySection ? (
        <div className="tool-detail-empty">{tr('No output')}</div>
      ) : null}
    </div>
  );
}

function renderInputBlock(block: ToolInputBlock, tr: (key: TranslationKey) => string) {
  switch (block.kind) {
    case 'command':
      return (
        <div className="tool-detail-command-wrap">
          <div className="tool-detail-command-box">
            <span className="tool-detail-command-prompt" aria-hidden="true">$</span>
            <pre className="tool-detail-command-code">{block.command}</pre>
          </div>
          {block.meta.length > 0 ? renderParamGrid(block.meta) : null}
        </div>
      );
    case 'params':
      if (block.items.length === 0) {
        return <div className="tool-detail-empty">{tr('Empty parameters')}</div>;
      }
      return renderParamGrid(block.items);
    case 'json':
      return <pre className="tool-detail-code">{block.code}</pre>;
    case 'text':
      return <pre className="tool-detail-code">{block.text}</pre>;
  }
}

function renderOutputBlock(block: ToolOutputBlock, tr: (key: TranslationKey) => string) {
  switch (block.kind) {
    case 'terminal':
      return block.output.trim().length > 0 ? (
        <pre className="tool-detail-code tool-detail-code--terminal">{block.output}</pre>
      ) : (
        <div className="tool-detail-empty">{tr('No output')}</div>
      );
    case 'agentStatus':
      return (
        <div className="tool-detail-agent-list">
          {block.agents.map((agent) => renderAgentCard(agent, tr))}
        </div>
      );
    case 'fileChanges':
      return (
        <div className="tool-detail-file-list">
          {block.changes.map((change, idx) => renderFileChangeRow(change, idx))}
        </div>
      );
    case 'diff':
      return (
        <pre className="tool-detail-code tool-detail-code--diff">
          {block.lines.map((line, idx) => (
            <span key={idx} className={cn('tool-detail-diff-line', `is-${line.kind}`)}>
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      );
    case 'params':
      return block.items.length > 0 ? renderParamGrid(block.items) : <div className="tool-detail-empty">{tr('No output')}</div>;
    case 'json':
      return <pre className="tool-detail-code">{block.code}</pre>;
    case 'text':
      return <pre className="tool-detail-code">{block.text}</pre>;
  }
}

function renderParamGrid(items: ToolParamItem[]) {
  return (
    <div className="tool-detail-params">
      {items.map((item) => (
        <div key={item.key} className="tool-detail-param-row">
          <span className="tool-detail-param-key">{item.key}</span>
          <span className={cn('tool-detail-param-val', item.mono && 'is-mono')}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function renderAgentCard(agent: ToolAgentStatusEntry, tr: (key: TranslationKey) => string) {
  const shortId = agent.agentId.length > 22
    ? `${agent.agentId.slice(0, 8)}…${agent.agentId.slice(-6)}`
    : agent.agentId;
  return (
    <div key={agent.agentId} className="tool-detail-agent-card">
      <div className="tool-detail-agent-head">
        <code className="tool-detail-agent-id" title={agent.agentId}>{shortId}</code>
        <span className={cn('tool-detail-status-pill', `is-${agent.tone}`)}>
          <span className="tool-detail-status-dot" aria-hidden="true" />
          {translateToolStatusLabel(agent.state, tr)}
        </span>
      </div>
      {agent.summary ? (
        <div className="tool-detail-agent-summary">{agent.summary}</div>
      ) : null}
    </div>
  );
}

function renderFileChangeRow(change: ToolFileChangeItem, index: number) {
  const badgeText = change.kind === 'add' ? '+' : change.kind === 'delete' ? '−' : change.kind === 'update' ? '~' : '•';
  const tone: ToolStatusTone = change.kind === 'add' ? 'success' : change.kind === 'delete' ? 'error' : change.kind === 'update' ? 'running' : 'neutral';
  return (
    <div key={`${change.path}:${index}`} className="tool-detail-file-row">
      <span className={cn('tool-detail-file-badge', `is-${tone}`)} aria-hidden="true">{badgeText}</span>
      <code className="tool-detail-file-path">{change.path}</code>
    </div>
  );
}
