// Deterministic first-party command mocks for UI tests; never used by the app.
export async function installRankingMock(page) {
  await page.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__?.invoke;
    if (!original) return;
    window.__rankingReleases = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (!['official_rankings', 'official_ranking_categories'].includes(command)) return original(command, args);
      window.__calls ??= [];
      window.__calls.push({ command, args });
      if (command === 'official_ranking_categories') {
        if (window.__rankCatalogFail) throw Error('模拟分类读取失败');
        return { male: [{ id: '257', name: '玄幻脑洞' }, { id: '8', name: '科幻末世' }], female: [{ id: '24', name: '快穿' }, { id: '8', name: '科幻末世' }] };
      }
      const total = 35;
      const books = Array.from({ length: Math.min(10, total - args.offset) }, (_, i) => {
        const rank = args.offset + i + 1;
        const original = args.gender === 1 && args.mold === 2 && args.category === '257';
        return { id: original && rank === 1 ? '7143038691944959011' : original && rank === 2 ? '6982529841564224526' : `8${args.gender}${args.mold}${args.category.padStart(5, '0')}${String(rank).padStart(4, '0')}`,
          rank, title: original && rank === 1 ? '十日终焉' : original && rank === 2 ? '我在精神病院学斩神' : `${args.gender === 1 ? '男频' : '女频'}-${args.category}-${args.mold}-${rank}`,
          author: '测试作者', category: args.category === '257' ? '玄幻脑洞' : args.category === '24' ? '快穿' : '科幻末世', score: '', readCount: '120000', wordCount: '200000', status: '连载中',
          description: '仅用于界面回归的模拟榜单数据。', coverUrl: 'https://p3-reading-sign.fqnovelpic.com/test.image', metadataMissing: false };
      });
      const result = { books, total, hasMore: args.offset + books.length < total, nextOffset: args.offset + books.length,
        version: window.__rankVersionOverride ?? (args.version || '1792086600'), fetchedAt: Date.now(), warning: '',
        sourceUrl: `https://fanqienovel.com/rank/${args.gender}_${args.mold}_${args.category}` };
      if (window.__rankHold) await new Promise(release => window.__rankingReleases.push({ args, release }));
      if (window.__rankFail || window.__rankFailOffset === args.offset) throw Error('模拟榜单网络故障');
      return result;
    };
  });
}
