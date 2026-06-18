// ─────────────────────────────────────────────────────────────────────────────
// 内部社媒情报工具 — 产品 / 关键词配置（团队内部使用）
//
// 这是你最常修改的文件。每个自有产品定义三类监听：
//   brand      — 我们自己的品牌词（看别人怎么议论我们）
//   competitor — 竞品词 / 竞品官方账号（盯竞品动向）
//   demand     — 用户需求/选型意图词（找到可以推荐我们产品的机会贴）
//
// Reddit  支持任意关键词搜索（search.rss，走住宅代理）——三类都能搜。
// X/Twitter 无 key 时无法做全站关键词搜索（X 已关闭），只能监听指定账号时间线；
//           所以 X 这里用 `handles`（竞品 + 自有官方号）。free-text 需求搜索见 README。
// Threads 二期（无公开 API，需住宅代理抓公开主页）。
//
// pitch 是给 AI 生成"推荐评论草稿"用的产品一句话卖点 + 落地链接。
// subreddits 限定 Reddit 搜索的社区（留空=全站搜），命中更精准、噪音更低。
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductConfig {
  /** 唯一 key，用于库表与 API 过滤 */
  key: string
  /** 展示名 */
  name: string
  /** 落地链接（写进 AI 草稿） */
  url: string
  /** 一句话卖点 — AI 写推荐评论时的"我们是谁/解决什么" */
  pitch: string
  /** Reddit 关键词，按类别分组 */
  reddit: {
    brand: string[]
    competitor: string[]
    demand: string[]
  }
  /** 限定搜索的子版块（不含 r/ 前缀）；留空数组=全站 */
  subreddits: string[]
  /** X/Twitter 监听的账号（不含 @）：竞品官方号 + 我们自己的号 */
  x: {
    competitorHandles: string[]
    ownHandles: string[]
  }
}

// ⚠️ 下方关键词为初始草稿，请按真实竞品/选型话术补全（尤其 wonix.ai / hirecx.ai）。
export const PRODUCTS: ProductConfig[] = [
  {
    key: 'wcoin',
    name: 'wcoin.casino',
    url: 'https://wcoin.casino',
    pitch:
      'wcoin.casino 是面向加密赌场的链上情报/偿付能力分析平台，帮玩家判断某家赌场是否安全、是否有足够储备金、是否还在正常运营。',
    reddit: {
      brand: ['wcoin.casino', 'wcoin casino'],
      competitor: ['casino.guru', 'askgamblers', 'casinoscores'],
      demand: [
        'is this casino safe',
        'is X casino legit',
        'casino solvency',
        'crypto casino reserves',
        'casino proof of reserves',
        'is stake safe',
        'casino exit scam',
      ],
    },
    subreddits: ['gambling', 'CryptoCurrency', 'sportsbook', 'problemgambling'],
    x: { competitorHandles: ['casinoguru'], ownHandles: [] },
  },
  {
    key: 'hirecx',
    name: 'hirecx.ai',
    url: 'https://hirecx.ai',
    pitch:
      'hirecx.ai 是 AI 招聘/候选人体验（candidate experience）工具，帮团队自动化筛选、沟通与面试流程，提升招聘效率与候选人满意度。',
    reddit: {
      brand: ['hirecx.ai', 'hirecx'],
      competitor: ['greenhouse ats', 'lever ats', 'paradox ai recruiting', 'hirevue'],
      demand: [
        'best ATS for startup',
        'recruiting automation tool',
        'candidate experience software',
        'AI recruiting tool',
        'screening candidates tool',
        'interview scheduling software',
      ],
    },
    subreddits: ['recruiting', 'humanresources', 'startups', 'AskHR', 'Entrepreneur'],
    x: { competitorHandles: [], ownHandles: [] },
  },
  {
    key: 'wonix',
    name: 'wonix.ai',
    url: 'https://wonix.ai',
    // TODO: 补全 wonix.ai 的真实定位、竞品与选型话术
    pitch: 'wonix.ai —（请在 products.ts 补全产品一句话卖点）。',
    reddit: {
      brand: ['wonix.ai', 'wonix'],
      competitor: [],
      demand: [],
    },
    subreddits: [],
    x: { competitorHandles: [], ownHandles: [] },
  },
]

export const productByKey = (k: string) => PRODUCTS.find((p) => p.key === k)
