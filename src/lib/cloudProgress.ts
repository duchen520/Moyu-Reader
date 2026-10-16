/** Official progress timestamps can be returned in seconds or milliseconds. */
export function cloudTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '记录时间未返回';
  const milliseconds = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return '记录时间无效';
  return `记录时间：${new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)}`;
}
