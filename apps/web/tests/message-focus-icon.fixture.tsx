import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Maximize2 } from 'lucide-react';
import { MessageFocusIcon } from '../src/components/ui/message-focus-icon';

const root = createRoot(document.getElementById('root')!);
export function render(size: number, color: string) {
  flushSync(() => root.render(<div><Maximize2 size={size} color={color} /><MessageFocusIcon size={size} color={color} /></div>));
}
export function unmount() { root.unmount(); }
