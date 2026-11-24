const PHONE_WIDTH_BREAKPOINT = 700;
const STANDALONE_IPAD_COMPACT_BREAKPOINT = 760;

export function shouldUseMobileShell(params: { width: number; userAgent: string; maxTouchPoints?: number; standalone?: boolean }) {
  const width = Number(params.width);
  const ua = params.userAgent || '';
  const touchPoints = params.maxTouchPoints ?? 0;
  const iPadUa = /iPad/i.test(ua);
  const iPadDesktopUa = /Macintosh/i.test(ua) && touchPoints > 1;
  const phoneUa = /iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) || /Android.+Mobile/i.test(ua);

  if (phoneUa) return true;
  if (iPadUa || iPadDesktopUa) {
    // Installed iPad PWAs can launch in Slide Over / compact Stage Manager
    // widths while still reporting an iPad desktop UA. At that size the
    // three-column desktop deck leaves the chat/composer cramped, so standalone
    // PWA uses the mobile list → chat flow only for compact tablet windows.
    return Boolean(params.standalone) && width < STANDALONE_IPAD_COMPACT_BREAKPOINT;
  }
  return width < PHONE_WIDTH_BREAKPOINT;
}
