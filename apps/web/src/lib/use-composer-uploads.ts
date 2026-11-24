import { useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type SetStateAction } from 'react';
import type { SendMessageUpload } from '@agentopsdeck/shared';
import { recoveryScope } from '../api';
import { useI18n, translate } from './i18n';
import { clipboardImages } from './clipboard-images';

export function useComposerUploads(sessionKey: string, allowed: boolean, sending: boolean,
  setMedia: (value: SetStateAction<SendMessageUpload[]>) => void, error: (value: string | undefined) => void,
  convert: (files: File[]) => Promise<SendMessageUpload[]>, merge: (current: SendMessageUpload[], incoming: SendMessageUpload[]) => SendMessageUpload[]) {
  const { t } = useI18n(), scope = recoveryScope();
  const allowedRef = useRef(allowed);
  useLayoutEffect(() => { allowedRef.current = allowed; }, [allowed]);
  const operation = useMemo(() => ({ alive: true, pending: 0 }), [scope, sessionKey]);
  const [, render] = useState(0);
  useLayoutEffect(() => { operation.alive = true; return () => { operation.alive = false; }; }, [operation]);
  const valid = () => !!scope && operation.alive && recoveryScope() === scope;
  const add = async (files: File[]) => {
    if (!files.length || !valid()) return;
    if (sending) { error(t('Wait for the current send before adding attachments.')); return; }
    if (!allowed) { error(t('This Agent accepts text only. Remove attachments before sending.')); return; }
    operation.pending++; render(value => value + 1); error(undefined);
    try {
      const uploads = await convert(files);
      if (valid()) {
        if (!allowedRef.current) throw new Error('This Agent accepts text only. Remove attachments before sending.');
        setMedia(items => merge(items, uploads));
      }
    } catch (cause) { if (valid()) error(translate(cause instanceof Error ? cause.message : String(cause))); }
    finally { operation.pending--; if (valid()) render(value => value + 1); }
  };
  return { preparing: operation.pending > 0, isPreparing: () => operation.pending > 0, add,
    paste(event: ClipboardEvent<HTMLTextAreaElement>) {
      const files = clipboardImages(event.clipboardData);
      if (!files.length) return;
      event.preventDefault(); // Must happen synchronously, before any FileReader await.
      void add(files);
    },
  };
}
