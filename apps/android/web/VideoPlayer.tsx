import { useState } from 'react';

type VideoPlayerProps = {
  src: string;
  title?: string;
  resumeKey?: string;
  className?: string;
  fill?: boolean;
  autoPlay?: boolean;
  inline?: boolean;
  onMediaLoad?: () => void;
};

export function VideoPlayer({ src, title, className, inline = false }: VideoPlayerProps) {
  const [error, setError] = useState('');
  const Container = inline ? 'span' : 'div';
  const play = () => {
    const bridge = (window as any).AgentOpsDeckNative;
    if (!bridge) { setError('请更新 Android System WebView 后重试。'); return; }
    const url = new URL((window as any).__AGENTOPSDECK_RESOURCE_URL__?.(src) ?? src, location.href);
    if (url.origin !== location.origin || !['https:', 'http:'].includes(url.protocol)) {
      setError('外部视频请用浏览器打开，应用不会向外部地址发送登录信息。');
      return;
    }
    bridge.postMessage(JSON.stringify({ type: 'video.play', url: url.href, name: title || '视频' }));
  };
  return <Container className={`relative block bg-black text-white ${className || ''}`}>
    <button type="button" className="w-full px-4 py-8 text-center" onClick={play}>▶ 应用内播放</button>
    <span className="block px-3 pb-3 text-xs">原生播放器：边播边缓存，重复播放复用缓存并记住进度，无需保存到相册。</span>
    {error ? <span role="alert" className="block px-3 pb-3 text-xs text-red-300">{error}</span> : null}
  </Container>;
}
