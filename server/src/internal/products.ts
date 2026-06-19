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
  /**
   * Telegram 公开频道用户名（不含 @），监听其近期消息作为需求/竞品信号。
   * 适合 wonix 这类"投手不在 Reddit、聚集在 TG 群/频道"的产品。留空=不监听。
   * 注意：只能读「公开频道」(t.me/s/<name> 可预览的)；私有群/普通 chat 读不到。
   */
  telegram?: string[]
  /**
   * 论坛帖子列表页（"最新/标签/板块"页 URL），抓其中的帖子标题+链接作为需求信号。
   * 通用解析器支持 XenForo(/threads/slug.123/) 与 vBulletin(showthread.php?t=123)；
   * 走住宅代理/解锁器过 Cloudflare。适合 iGaming 投手聚集的 BHW/AGD/AffiliateFix 等。
   */
  forums?: { name: string; url: string }[]
}

// 关键词可随时增删调优；竞品 X 账号名写错会自动 404 忽略，安全。各产品 ownHandles 待补真实账号。
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
    // AI 数字员工 / AI 客服团队：像招人一样为网站配置 AI 客服，API 打通后承担销售+售后，
    // 按 token 计费每条消息仅 $0.008。受众=网站主/电商/SaaS/客服与增长负责人。
    pitch:
      'hirecx.ai 是“AI 数字员工”平台：像招人一样为你的网站配置一支 AI 客服团队，打通 API 后可承接售前销售、售后支持等全流程，按 token 用量计费，每条消息仅 $0.008。',
    reddit: {
      brand: ['hirecx.ai', 'hirecx'],
      competitor: [
        'intercom fin',
        'zendesk ai',
        'sierra ai',
        'decagon ai',
        'ada cx',
        'forethought ai',
        'tidio',
        'chatbase',
        'salesforce agentforce',
      ],
      demand: [
        'AI customer service',
        'AI customer support',
        'AI chatbot for website',
        'AI support agent',
        'automate customer support',
        'best AI customer service tool',
        'customer service automation',
        'AI agent for sales',
        'replace live chat with AI',
        'chatbot for ecommerce support',
      ],
    },
    subreddits: ['CustomerService', 'CustomerSuccess', 'SaaS', 'ecommerce', 'startups', 'smallbusiness'],
    // ownHandles 待补：填入 hirecx 自己的 X 账号名（不带 @）
    x: { competitorHandles: ['intercom', 'zendesk', 'ada_cx', 'decagon'], ownHandles: [] },
  },
  {
    key: 'wonix',
    name: 'wonix.ai',
    url: 'https://wonix.ai',
    // 面向 iGaming 行业的广告投放创意工作流：帮投手/媒体采买产出更优广告素材实现投放增长。
    // 受众=iGaming 广告投手 / 联盟营销 / 绩效投放（performance / media buying）。
    pitch:
      'wonix.ai 是面向 iGaming 行业的广告投放创意工作流：帮投手快速产出更优质的广告素材（creative），提升投放转化与增长。',
    reddit: {
      brand: ['wonix.ai', 'wonix'],
      competitor: [
        'adcreative.ai',
        'creatopy',
        'foreplay creative',
        'madgicx',
        'pencil ai ads',
        'creatify ai',
        'smartly.io',
      ],
      demand: [
        'ad creative tool',
        'AI ad creatives',
        'generate ad creatives',
        'creative automation',
        'best tool for ad creatives',
        'scaling facebook ad creatives',
        'ad creative generator',
        'iGaming ad creative',
        'casino ad creatives',
        'media buying creative workflow',
      ],
    },
    // iGaming 投手 / 联盟营销 / 绩效投放聚集的 Reddit 社区（含玩家端痛点供反向选品）
    subreddits: ['Affiliatemarketing', 'PPC', 'FacebookAds', 'advertising', 'sportsbook', 'onlinegambling', 'gambling'],
    // ownHandles 待补：填入 wonix 自己的 X 账号名（不带 @）
    x: { competitorHandles: ['AdCreativeai', 'madgicx', 'creatopy', 'foreplay_co'], ownHandles: [] },
    // @iGaming_chat 是群/chat，t.me/s/ 多半抓不到（会优雅返回0）；真正公开「频道」可继续往这里加
    telegram: ['iGaming_chat'],
    // iGaming 投手浓度最高的公开论坛（XenForo/vBulletin，走住宅代理过 Cloudflare）。
    // FB-Killa = CIS 最大 арбитраж 论坛（实测可抓 122 帖，俄语意图词已加）。
    // vc.ru / CPALENTA 是文章站(非论坛结构)，需专门解析器，暂缓。
    forums: [
      { name: 'BHW · iGaming', url: 'https://www.blackhatworld.com/tags/igaming/' },
      { name: 'BHW · gambling', url: 'https://www.blackhatworld.com/tags/gambling/' },
      { name: 'BHW · media-buying', url: 'https://www.blackhatworld.com/forums/media-buying.175/' },
      { name: 'AGD · casino-affiliate', url: 'https://www.affiliateguarddog.com/community/categories/casino-affiliate-forums.56/' },
      { name: 'AffiliateFix', url: 'https://affiliatefix.com/whats-new/posts/' },
      { name: 'FB-Killa (CIS)', url: 'https://fb-killa.pro/forums/' },
    ],
  },
]

export const productByKey = (k: string) => PRODUCTS.find((p) => p.key === k)
