import { useState } from 'react';
import { officialImage } from '../lib/media';

export function OfficialCover({ url, title }: { url?: string; title: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const safe = url ? officialImage(url) : null;
  return safe && failedUrl !== safe
    ? <img className="official-cover" src={safe} alt={`${title} 官方封面`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(safe)}/>
    : <span className="official-cover official-cover-fallback"><strong>{title}</strong><small>官方封面暂不可用</small></span>;
}
