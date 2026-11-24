import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './resource-cards.css';

// Session-owned controls use a layout-owned caption slot. Moving a pane never
// reparents its editor, creates a second controller, or duplicates commands.
const ToolbarTarget = createContext<HTMLSpanElement | null>(null);
const StatusTarget = createContext<HTMLSpanElement | null>(null);
const TitleTarget = createContext<HTMLSpanElement | null>(null);
export const usePaneToolbarTarget = () => useContext(ToolbarTarget);
export const usePaneTitleTarget = () => useContext(TitleTarget);
export function PaneToolbarScope({ children }: { children: (slot: ReactNode, statusSlot: ReactNode, titleSlot: ReactNode) => ReactNode }) {
  const [target, setTarget] = useState<HTMLSpanElement | null>(null);
  const [statusTarget, setStatusTarget] = useState<HTMLSpanElement | null>(null);
  const [titleTarget, setTitleTarget] = useState<HTMLSpanElement | null>(null);
  const actions = <span className="session-pane-custom-actions" ref={setTarget} />;
  return <ToolbarTarget.Provider value={target}><StatusTarget.Provider value={statusTarget}><TitleTarget.Provider value={titleTarget}>{children(actions, <span className="session-pane-status-actions" ref={setStatusTarget} />, <span className="session-pane-title-slot" ref={setTitleTarget} />)}</TitleTarget.Provider></StatusTarget.Provider></ToolbarTarget.Provider>;
}
export function PaneTitle({ children }: { children: ReactNode }) {
  const target = useContext(TitleTarget);
  return target ? createPortal(children, target) : null;
}
export function PaneStatusControls({ children }: { children: ReactNode }) {
  const target = useContext(StatusTarget);
  return target ? createPortal(children, target) : null;
}
export function PaneToolbar({ children }: { children: ReactNode }) {
  const target = useContext(ToolbarTarget);
  return target ? createPortal(children, target) : null;
}
