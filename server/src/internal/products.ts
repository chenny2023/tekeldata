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
  /**
   * 相关性词表（领域词）——去噪闸门。对"需求(demand)"类信号（含论坛/TG/广搜命中），
   * 标题/正文必须包含其中至少一个词才入库；品牌/竞品类精确命中不受此限。
   * 解决"论坛整页吞入 + 泛词命中"带来的无效信息。留空=不过滤。
   */
  relevance?: string[]
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
    // 真实定位(读自官网 2026-06)：「雇佣你的全球 AI 客服团队」。AI-native、无坐席费、按消息计费、
    // 在 Telegram 上管理。流程像招人：选行业模板(游戏/跨境电商/SaaS)→设目标边界→传知识库→
    // 生成有名字的 persona(VIP/订单/销售/多语种)→试岗演练→一段 script 嵌入上线。
    // 卖点：99% 自助解决率、24/7、+10% 销售转化、多语种、游戏场景原生(玩家/VIP/支付/活动)。
    pitch:
      'hirecx.ai —「雇佣你的全球 AI 客服团队」：像招人一样选行业模板(游戏/跨境电商/SaaS)、设目标与边界、上传知识库，几分钟生成有名字的客服 persona(VIP/订单/销售/多语种)，试岗演练后一段 script 嵌入即上线，日报与升级提醒在 Telegram 管理。AI-native、无坐席费、按消息计费（约 $0.001/条均价）；主打 99% 自助解决率、24/7、+10% 销售转化、游戏场景原生(玩家/VIP/支付/活动)。',
    reddit: {
      brand: ['hirecx.ai', 'hirecx'],
      // spec：HireCX = 竞品置换监听。种子=竞品 AI 客服产品名（命中后由分类器判定"是否在用+是否不满"）。
      // ⚠️ 待你补：区域性/iGaming 专属 AI 客服商，你最熟这个赛道。
      competitor: [
        'intercom fin', 'zendesk ai', 'sierra ai', 'decagon ai', 'ada cx', 'forethought ai',
        'tidio', 'chatbase', 'salesforce agentforce', 'gorgias ai', 'freshchat', 'crisp chat',
        'voiceflow', 'kustomer ai',
      ],
    // demand 种子撒大网（关键词源已无 vocab 闸门，分类器分桶 蠢/贵/接入/不懂博彩/想换 并排除噪音）。
    demand: [
      // 不满（蠢/答非所问）
      'AI chatbot wrong answers', 'support bot useless', 'chatbot cant understand', 'ai support dumb', 'chatbot frustrating',
      // 不满（贵）
      'intercom too expensive', 'zendesk ai pricing', 'ai support per resolution cost', 'customer support tool too expensive',
      // 不满（接入）
      'hard to integrate chatbot', 'bad chatbot api', 'chatbot onboarding painful',
      // 想换 / 选型
      'looking to switch ai support', 'best ai customer service', 'intercom alternative', 'zendesk alternative',
      'ai customer service tool', 'ai chatbot for website', 'live chat software recommendation',
      // 行业垂直（游戏/电商/SaaS）
      'ai customer service for igaming', 'ai support for online casino', 'ai chatbot for sportsbook',
      'customer support for shopify store', 'ai support for ecommerce', 'customer support for saas',
      'player support automation', 'multilingual customer support',
      // 不懂博彩场景
      'chatbot doesnt understand kyc', 'support bot bonus questions',
    ],
    },
    subreddits: ['ecommerce', 'shopify', 'dropship', 'SaaS', 'Entrepreneur', 'smallbusiness', 'CustomerService', 'startups'],
    // ownHandles 待补：填入 hirecx 自己的 X 账号名（不带 @）
    x: { competitorHandles: ['intercom', 'zendesk', 'ada_cx', 'decagon'], ownHandles: [] },
    // 去噪：只有真正讲"客服/支持/在线销售对话"的帖才算 hirecx 需求（行业垂直里筛出 CS 话题）
    relevance: [
      'customer service', 'customer support', 'customer experience', 'support ticket', 'support tickets',
      'live chat', 'livechat', 'chatbot', 'chat bot', 'help desk', 'helpdesk', 'support team', 'support agent',
      'support rep', 'cx ', 'ai agent', 'virtual agent', 'conversational ai', 'support automation', 'chat widget',
      'presales', 'pre-sales', 'after-sales', 'sales chat', 'respond to customers', 'handle inquiries',
      'support volume', 'support cost', 'answer customers', 'player support', 'support inbox', 'tickets',
    ],
  },
  {
    key: 'wonix',
    name: 'wonix.ai',
    url: 'https://wonix.ai',
    // 真实定位(读自官网 2026-06)：app 效果投放的 AI 创意 partner，"制胜创意靠方法不靠运气"。
    // 从优质参考广告提炼制胜规律→对话给创意策略→一键产出 5 种尺寸素材→性能数据回流迭代→
    // 沉淀每个项目私有的"制胜素材库"。受众=app 效果投手(gaming/iGaming/finance/订阅)。Meta 已上线，Google/TikTok 在路上。
    pitch:
      'wonix.ai 是面向 app 效果投放（gaming/iGaming/finance/订阅类）的 AI 创意 partner：从优质参考广告提炼制胜规律、用对话给创意策略、一键产出 5 种尺寸素材、性能数据回流持续迭代，并为每个项目沉淀私有的"制胜素材库"——"制胜创意靠方法不靠运气"。目前 Meta 已上线，Google/TikTok 在路上。',
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
    // 撒大网（分类器再分层/判 solvable）：关键词源已无 vocab 闸门，宽词换量，靠分类器精筛。
    demand: [
      // 创意/素材
      'casino ad creative', 'igaming ad creative', 'gambling ad creative', 'creatives not converting',
      'gambling ad fatigue', 'need casino creatives', 'ad creatives for casino',
      // 投放痛点
      'facebook ad account banned', 'gambling ad disapproved', 'scaling gambling ads', 'casino cpa too high',
      'igaming roas', 'casino offer not converting',
      // 媒体采买 / 联盟（宽网）
      'igaming media buyer', 'casino media buying', 'igaming affiliate', 'casino traffic', 'gambling ads',
      'spy gambling ads', 'casino marketing',
      // 俄语 CIS
      'крео гемблинг', 'крео казино', 'арбитраж гемблинг', 'залив на казино', 'крео не заходит', 'крео выгорел',
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
    // 仅保留实测可抓的(直连即通)。BHW 全系=Cloudflare 拦截页(0 帖、白耗额度)已移除；
    // affLIFT 需登录/挡爬也移除。FB-Killa 是主力(122 帖/页)。
    // 论坛 + 文章站（通用兜底解析器抓列表页链接）。均实测可直连抓到内容。
    forums: [
      { name: 'FB-Killa (CIS)', url: 'https://fb-killa.pro/forums/' },        // 论坛 122/页
      { name: 'AffiliateFix', url: 'https://affiliatefix.com/whats-new/posts/' }, // 论坛
      { name: 'AGD · casino-affiliate', url: 'https://www.affiliateguarddog.com/community/categories/casino-affiliate-forums.56/' }, // 论坛
      { name: 'CPALENTA (CIS)', url: 'https://cpalenta.ru/' },                // 文章站 ~67/页
      { name: 'TraffHub (CIS)', url: 'https://traffhub.media/' },            // 文章站，gambling 投放强相关
      { name: 'GPWA', url: 'https://www.gpwa.org/forum/' },                  // iGaming affiliate 行业
    ],
    // 论坛 firehose 过滤词：放宽到「广告素材 + 媒体采买痛点」语境（封号/CPA/ROAS/放量也算 wonix 痛点），
    // 仍排除纯赌场玩家闲聊。关键词源已不走此闸门，分类器做最终精筛。
    relevance: [
      // 创意/素材
      'creative', 'creatives', 'ad creative', 'ad copy', 'ugc', 'banner', 'video ad', 'thumbnail',
      'landing page', 'prelander', 'preland', 'cloak', 'cloaking', 'spy tool', 'adspy', 'ad fatigue', 'creo', 'ad design',
      // 媒体采买/投放痛点
      'media buy', 'media buyer', 'affiliate', 'arbitrage', 'traffic', 'offer', 'cpa', 'roas', 'ctr',
      'ad account', 'ad ban', 'banned', 'disapprove', 'scaling', 'facebook ads', 'fb ads', 'tiktok ads', 'google ads', 'keitaro', 'tracker', 'funnel',
      // 俄语
      'крео', 'креатив', 'креатива', 'баннер', 'связк', 'прелендинг', 'клоак', 'спай',
      'арбитраж', 'залив', 'офер', 'оффер', 'траф', 'бан', 'апрув', 'кампани',
    ],
  },
]

export const productByKey = (k: string) => PRODUCTS.find((p) => p.key === k)
