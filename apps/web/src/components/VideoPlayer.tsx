import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { useI18n } from '../lib/i18n';
import { mediaUrl } from '../api';

type VideoPlayerProps = {
  src: string;
  title?: string;
  resumeKey?: string;
  className?: string;
  fill?: boolean;
  autoPlay?: boolean;
  inline?: boolean;
  onMediaLoad?: (() => void) | undefined;
};

export function VideoPlayer({ src: originalSrc, title, resumeKey, className, fill = false, autoPlay = false, inline = false, onMediaLoad }: VideoPlayerProps) {
  const src = mediaUrl(originalSrc);
  const { t } = useI18n();
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string>();
  const lastSavedSecond = useRef(-1);
  const video = useRef<HTMLVideoElement>(null);
  const Container = inline ? 'span' : 'div';

  useEffect(() => {
    setBuffering(false);
    setError(undefined);
    lastSavedSecond.current = -1;
    const element = video.current;
    // StrictMode replays setup after cleanup on the same DOM node.
    if (element && element.getAttribute('src') !== src) element.setAttribute('src', src);
    return () => {
      // Release decoder buffers and pending range requests when the card closes.
      if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
    };
  }, [src]);

  return <Container className={cn('relative block bg-black', fill && 'media-player-fill')}>
    <video
      ref={video}
      key={src}
      className={cn('aspect-video w-full bg-black', fill && 'media-player-video', className)}
      src={src}
      title={title}
      controls
      playsInline
      autoPlay={autoPlay}
      preload="metadata"
      onLoadedMetadata={(event) => {
        if (resumeKey) {
          try {
            const saved = Number(window.localStorage.getItem(resumeKey));
            if (Number.isFinite(saved) && saved > 5 && saved < event.currentTarget.duration - 10) event.currentTarget.currentTime = saved;
          } catch { /* Playback still works when browser storage is unavailable. */ }
        }
        onMediaLoad?.();
      }}
      onTimeUpdate={(event) => {
        if (!resumeKey) return;
        const second = Math.floor(event.currentTarget.currentTime);
        if (second > 0 && second !== lastSavedSecond.current && second % 5 === 0) {
          lastSavedSecond.current = second;
          try { window.localStorage.setItem(resumeKey, String(second)); } catch { /* Resume is optional. */ }
        }
      }}
      onEnded={() => {
        if (resumeKey) { try { window.localStorage.removeItem(resumeKey); } catch { /* Resume is optional. */ } }
      }}
      onWaiting={() => setBuffering(true)}
      onPlaying={() => setBuffering(false)}
      onCanPlay={() => setBuffering(false)}
      onError={() => {
        setBuffering(false);
        setError('This video codec is not supported by the browser, or the playback link expired. Refresh and try again.');
      }}
    />
    {buffering ? <Container className="pointer-events-none absolute inset-0 grid place-items-center bg-black/25"><span className="rounded-full bg-black/70 px-3 py-2 text-xs font-bold text-white">{t('Buffering…')}</span></Container> : null}
    {error ? <Container className="absolute inset-x-0 bottom-0 bg-red-950/90 px-3 py-2 text-xs font-semibold text-red-100">{t('This video codec is not supported by the browser, or the playback link expired. Refresh and try again.')}</Container> : null}
  </Container>;
}
