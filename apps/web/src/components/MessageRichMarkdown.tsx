import React from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sourceLink } from '../lib/source-preview';

export default function MessageRichMarkdown({ text, components }: { text: string; components: Components }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    urlTransform={url => sourceLink(url, window.location.origin) ? url : defaultUrlTransform(url)}
    components={components}
  >{text}</ReactMarkdown>;
}
