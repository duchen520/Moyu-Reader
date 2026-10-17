import { useEffect, useRef, useState } from 'react';
import { officialImage } from '../lib/media';
import { cachedCover, coverCacheAvailable } from '../lib/coverCache';

export function OfficialCover({ url, title, bookId }: { url?: string; title: string; bookId?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [near, setNear] = useState<string | null>(null);
  const [image, setImage] = useState<{ url: string; src: string; cached: boolean } | null>(null);
  const placeholder = useRef<HTMLSpanElement>(null);
  const safe = url ? officialImage(url) : null;
  const native = coverCacheAvailable();
  // Curated discovery entries only carry book IDs. Resolve their cover through
  // current official metadata instead of requiring a hardcoded CDN address.
  const identity = safe ? `${bookId ?? ''}:${safe}` : native && /^\d{5,24}$/.test(bookId ?? '') ? `book:${bookId}` : null;
  useEffect(() => {
    if (!native || !identity || !placeholder.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setNear(identity); observer.disconnect(); }
    }, { rootMargin: '240px' });
    observer.observe(placeholder.current);
    return () => observer.disconnect();
  }, [identity, native]);
  useEffect(() => {
    if (!native || !identity || near !== identity) return;
    let cancelled = false;
    cachedCover(safe ?? '', bookId).then(result => {
      if (!cancelled) setImage({ url: identity, src: result.dataUrl, cached: result.cached });
    }).catch(() => { if (!cancelled) setFailedUrl(identity); });
    return () => { cancelled = true; };
  }, [safe, identity, near, native, bookId]);
  if (identity && failedUrl !== identity) {
    if (!native && safe) return <img className="official-cover" src={safe} alt={`${title} 官方封面`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(identity)}/>;
    if (image?.url === identity) return <img className="official-cover" src={image.src} alt={`${title} 官方封面`} data-cover-source={image.cached ? 'disk' : 'network'} decoding="async" onError={() => setFailedUrl(identity)}/>;
    return <span ref={placeholder} className="official-cover official-cover-loading" role="img" aria-label={`${title} 封面加载中`}><small>封面加载中</small></span>;
  }
  return <span className="official-cover official-cover-fallback"><strong>{title}</strong><small>官方封面暂不可用</small></span>;
}
