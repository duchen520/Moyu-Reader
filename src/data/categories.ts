export interface GenreInfo {
  id: string;
  name: string;
  tag: string;
  desc: string;
  color: string;
  sampleBooks: {
    id: string;
    title: string;
    author: string;
    score: string;
    description: string;
    status: '连载中' | '已完结';
    tags: string[];
    coverStyle: number;
  }[];
}

export const HOT_KEYWORDS = [
  '十日终焉',
  '斩神',
  '异兽迷城',
  '我不是戏神',
  '九星霸体诀',
  '万古第一神',
  '开局地摊卖大力',
  '诡舍',
  '悬疑脑洞',
  '都市高武',
  '剑道无敌',
  '末日求生',
  '无限流',
];

export const GENRES: GenreInfo[] = [
  {
    id: 'all',
    name: '全部分类',
    tag: '全部',
    desc: '海量全网正版书库随心探索',
    color: '#6366f1',
    sampleBooks: [],
  },
  {
    id: 'urban',
    name: '都市生活 / 异能',
    tag: '都市',
    desc: '都市高武、神秘复苏、神豪逆袭、热血都市',
    color: '#3b82f6',
    sampleBooks: [
      {
        id: '6982529841564224526',
        title: '我在精神病院学斩神',
        author: '三九音域',
        score: '9.8',
        description: '大夏境内，神明禁行！少年手持黑缎，在迷雾笼罩的世界里守护万家灯火。',
        status: '已完结',
        tags: ['都市高武', '守夜人', '热血神作'],
        coverStyle: 1,
      },
      {
        id: '7081535608648109069',
        title: '异兽迷城',
        author: '彭湃',
        score: '9.7',
        description: '温馨和谐的家庭背后，竟然全员披着人皮的异兽！高智商博弈与悬疑杀局。',
        status: '连载中',
        tags: ['都市异能', '心理博弈', '克苏鲁'],
        coverStyle: 2,
      },
    ],
  },
  {
    id: 'suspense',
    name: '悬疑惊悚 / 脑洞',
    tag: '悬疑',
    desc: '无限流博弈、中式民俗、本格推理、诡异天道',
    color: '#8b5cf6',
    sampleBooks: [
      {
        id: '7143038691944959011',
        title: '十日终焉',
        author: '杀虫队队员',
        score: '9.8',
        description: '生肖密室、死亡博弈、记忆轮回，齐夏率领众人在绝望之中寻找生机。',
        status: '已完结',
        tags: ['无限流', '智斗神作', '逻辑闭环'],
        coverStyle: 0,
      },
      {
        id: '7256784068786785336',
        title: '诡舍',
        author: '夜来风雨声丶',
        score: '9.5',
        description: '推开诡舍大门，在一次次危机四伏的规则怪谈与智斗副本中探寻真相。',
        status: '已完结',
        tags: ['纯正悬疑', '硬核解密', '智斗惊悚'],
        coverStyle: 3,
      },
    ],
  },
  {
    id: 'fantasy',
    name: '玄幻奇幻 / 仙侠',
    tag: '玄幻',
    desc: '剑开天门、诸天万界、逆天改命、热血升级',
    color: '#ec4899',
    sampleBooks: [
      {
        id: '6837522590550985735',
        title: '万古第一神',
        author: '风青阳',
        score: '9.6',
        description: '执掌太古第一混沌巨兽，一人统领十方纪元神魔，逆天破劫！',
        status: '连载中',
        tags: ['伴生兽', '杀伐果断', '热血大玄幻'],
        coverStyle: 4,
      },
      {
        id: '6569998018232192008',
        title: '九星霸体诀',
        author: '平凡魔术师',
        score: '9.6',
        description: '借九星霸体之力，炼无双神丹，踏破九天诸界！',
        status: '连载中',
        tags: ['丹武双修', '打脸逆袭', '热血修仙'],
        coverStyle: 1,
      },
    ],
  },
  {
    id: 'comedy',
    name: '轻松搞笑 / 脑洞',
    tag: '脑洞',
    desc: '系统流爽文、反套路、幽默下饭、搞笑逆袭',
    color: '#f59e0b',
    sampleBooks: [
      {
        id: '6838480082219043843',
        title: '开局地摊卖大力',
        author: '弈青锋',
        score: '9.5',
        description: '江南绑定最强地摊系统，笑点层出不穷，解压满分的欢快神作。',
        status: '已完结',
        tags: ['搞笑轻松', '系统流', '爽文'],
        coverStyle: 2,
      },
    ],
  },
];
