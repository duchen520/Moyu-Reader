export const CURRENT_VERSION = '0.5.21';

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseTitle?: string;
  releaseNotes?: string;
  publishedAt?: string;
  downloadUrl?: string;
  installerUrl?: string;
  error?: string;
}

function version(value: string) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.exec(value);
  if (!match || match[4]?.split('.').some(s => /^\d+$/.test(s) && s.length > 1 && s.startsWith('0'))) throw Error('更新版本号格式无效');
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') };
}

export function compareSemver(current: string, latest: string): number {
  const c = version(current), l = version(latest);
  for (let i = 0; i < 3; i++) {
    if (l.core[i] !== c.core[i]) return l.core[i] > c.core[i] ? 1 : -1;
  }
  if (!l.pre || !c.pre) return l.pre ? -1 : c.pre ? 1 : 0;
  for (let i = 0; i < Math.max(l.pre.length, c.pre.length); i++) {
    const a = c.pre[i], b = l.pre[i];
    if (a === b) continue;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    if (an && bn) return BigInt(b) > BigInt(a) ? 1 : -1;
    if (an !== bn) return bn ? -1 : 1;
    return b > a ? 1 : -1;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = CURRENT_VERSION;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {

    const response = await fetch('https://api.github.com/repos/duchen520/Moyu-Reader/releases/latest', {
      headers: {
        Accept: 'application/vnd.github.v3+json',
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      throw Error('更新仓库暂未提供可用发布版本，请稍后重试');
    }

    if (!response.ok) {
      throw new Error(`检查更新失败 (HTTP ${response.status})`);
    }

    const data = await response.json();
    if (!data || typeof data.tag_name !== 'string') throw Error('更新服务返回了无效的版本资料');
    const latestVersion = (data.tag_name || '').replace(/^v/i, '');
    const hasUpdate = !data.draft && !data.prerelease && !version(latestVersion).pre && compareSemver(currentVersion, latestVersion) > 0;

    let installerUrl: string | undefined;
    if (Array.isArray(data.assets)) {
      const assets = data.assets.filter((a: { name?: string; browser_download_url?: string } | null) =>
        a && typeof a.name === 'string' && typeof a.browser_download_url === 'string');
      const asset = assets.find((a: { name: string }) => /-setup\.exe$/i.test(a.name) && /x64/i.test(a.name));
      if (asset?.browser_download_url) {
        installerUrl = asset.browser_download_url;
      }
    }

    return {
      hasUpdate,
      currentVersion,
      latestVersion,
      releaseTitle: data.name || `v${latestVersion}`,
      releaseNotes: data.body || '',
      publishedAt: data.published_at ? new Date(data.published_at).toLocaleDateString() : undefined,
      downloadUrl: data.html_url || 'https://github.com/duchen520/Moyu-Reader/releases',
      installerUrl,
    };
  } catch (err) {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
