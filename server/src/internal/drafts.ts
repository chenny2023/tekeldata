import { db } from '../db.ts'
import { generateContent, openrouterEnabled } from '../content/openrouter.ts'
import { productByKey } from './products.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 开场白 / 草稿生成（对齐 spec §2 的 draft_artifact）。按产品走不同逻辑：
//   wonix  → 创意疲劳点 teardown + 2-3 条定制素材角度 + 免费送样（产品即诱饵）。
//            spec：不可解(封号/支付/牌照, solvable=0)的信号不发免费样片 → 直接拒绝出销售草稿。
//   hirecx → 按不满桶(蠢/贵/接入/不懂博彩/想换)匹配的"置换证明"开场白。
//   wcoin  → 中立、有数据点的回帖，自然带出 wcoin（进内容队列，非销售）。
// 人工审核后再发；无 OPENROUTER_API_KEY 时返回提示。
// ─────────────────────────────────────────────────────────────────────────────

// 投放规范——若动作是私信(DM)则走 DM 模式（不过 AutoModerator，可更直接）；否则按平台。
function deliveryRules(platform: string, play: string): string {
  if (play === 'dm')
    return (
      'DELIVERY = a PRIVATE 1:1 DM (not a public comment — it will NOT be auto-moderated). You may be direct: ' +
      'name the product and include ONE link, plus a concrete, personalized offer. BUT open by referencing their ' +
      'specific post/problem, sound human and 1:1 (never a mass-DM template), keep it short, disclose who you are.'
    )
  if (platform === 'reddit')
    return (
      'PLATFORM = Reddit PUBLIC comment (auto-moderation removes promo + links). OUTPUT PURE, GENUINELY USEFUL ' +
      'HELP ONLY. Do NOT mention ANY product or brand name. Do NOT include ANY url or domain. No marketing ' +
      'language, no "DM me", no disclosure-pitch. It must read as a helpful, credible comment that stands entirely ' +
      'on its own — outreach happens separately via DM. Concise and human.'
    )
  if (platform === 'forum' || platform === 'telegram')
    return (
      'PLATFORM = ' + platform + ' (affiliate/industry community). Value-first. A single soft mention of the ' +
      'product by name is OK (a link only if such posts are clearly normal there), always secondary to the help, ' +
      'with an honest disclosure of affiliation. No spammy/marketing tone.'
    )
  // x / bluesky / threads
  return (
    'PLATFORM = ' + platform + '. You may mention the product name/handle once and may include the link if it ' +
    'reads naturally; still lead with value and avoid a spammy/ad tone.'
  )
}

function systemFor(productKey: string, painType: string, platform: string, play: string): string {
  const common =
    'Write the reply in the SAME LANGUAGE as the post (e.g. Russian post → Russian reply, Spanish → Spanish). ' +
    'You are NOT a spammer: only produce a reply if it is genuinely a fit; otherwise set relevant=false. ' +
    'Sound like a real, knowledgeable peer — concrete and specific, NO hype, NO emoji spam, NO "check out", ' +
    'NO superlatives, NO fake claims. ' + deliveryRules(platform, play) + ' Respond ONLY as JSON: ' +
    '{"relevant":true|false,"reason":"<one sentence>","comment":"<the reply draft or empty>"}'
  if (productKey === 'wonix')
    return (
      'You are a senior performance-creative strategist for wonix.ai — an AI creative PARTNER for app performance ' +
      'media buyers (gaming/iGaming/finance/subscription). wonix\'s method: extract winning patterns from top ' +
      'reference ads, advise creative strategy via chat, generate ready-to-launch assets in 5 sizes, feed ' +
      'performance data back to iterate, and build a private "winning library" per project. Ethos: "winning ' +
      'creative is method, not luck." Meta live; Google/TikTok coming. The poster is an affiliate / media buyer ' +
      'with a creative pain (pain: ' + (painType || 'unknown') + '). Write a short peer-to-peer reply that: (1) leads with a ' +
      'concrete, method-driven teardown of their exact pain (e.g. why a creative fatigues, what winning ads in ' +
      'their vertical share), (2) names 2-3 specific creative ANGLE concepts to test, (3) offers to run their ' +
      'offer/reference through wonix and share a couple of ready 5-size assets to test — product as the bait, no ' +
      'hard sell. The product is wonix.ai; mention it only as the delivery rules allow. ' + common
    )
  if (productKey === 'hirecx')
    return (
      'You are from hirecx.ai — "Hire your global AI support team". NOT a generic chatbot: users HIRE a team by ' +
      'picking an industry template (Gaming / cross-border E-commerce / SaaS), setting goals & boundaries, ' +
      'uploading their knowledge; it spins up named support personas (VIP / Order / Sales / multilingual), lets ' +
      'them run a TRIAL SHIFT before go-live, then goes live via one script tag and is MANAGED ON TELEGRAM ' +
      '(daily reports + escalation alerts). AI-native, NO seat fees, per-message pricing; gaming-native personas ' +
      'handle player support / VIP / payment / event / reward / complaint triage; 24/7, 99% resolution, +10% ' +
      'sales lift, multilingual. The poster is an operator / ops or support lead using or choosing an AI support ' +
      'tool and dissatisfied; bucket = "' + (painType || 'unknown') + '". Write a short DISPLACEMENT-PROOF reply matched to it: ' +
      'dumb / not_gambling_native → offer a free TRIAL SHIFT: throw their hardest KYC/payout/bonus questions at a ' +
      'gaming-template persona and compare side-by-side; ' +
      'expensive → contrast hirecx\'s no-seat-fees + per-message pricing (~$0.001/msg avg) vs per-seat/per-resolution models; ' +
      'integration → "one script tag, live in minutes, run a trial shift first, manage from Telegram"; ' +
      'want_switch → migration via industry template + a trial shift to de-risk. The product is hirecx.ai; mention ' +
      'it only as the delivery rules allow; speak the "hire a team / personas" language, not "buy a bot". ' + common
    )
  if (productKey === 'wcoingame')
    return (
      'You are a real crypto-gambling player sharing where you actually play. wcoingame.com is an established (2+ years) ' +
      'crypto "Live Sports & iGaming" platform — crypto deposits/withdrawals, sportsbook + casino (slots / live). ' +
      'The poster is a player looking for a crypto casino, unhappy with their current one, or asking for recommendations ' +
      '(pain: ' + (painType || 'unknown') + '). Write a short, genuine peer reply that (1) answers their actual question first ' +
      '(what to look for: withdrawal speed, provably fair, KYC limits, realistic bonus terms), and (2) shares your own ' +
      'experience, naturally mentioning wcoingame.com as one you have used — honest and balanced, NOT a hard sell or ad. ' +
      'NEVER reply to problem-gambling / addiction / self-exclusion posts → set relevant=false. The product is wcoingame.com; ' +
      'mention it only as the delivery rules allow. ' + common
    )
  return ( // wcoin — content queue
    'You are a knowledgeable, neutral iGaming/crypto-casino analyst. The poster asks about casino safety, ' +
    'rankings, comparisons, legitimacy or payouts. Write a genuinely neutral, helpful reply that offers a ' +
    'concrete data point or how-to and naturally mentions tekeldata.com as an on-chain solvency / data resource ' +
    '(NOT a hard sell — it should read as a useful pointer). The resource is tekeldata.com; mention it only as the ' +
    'delivery rules allow. ' + common
  )
}

// 程序化清洗。strict(Reddit 公开评论)：剥掉 URL + 自有域名 + 品牌词（公开评论里零产品）。
// 非 strict（私信/论坛/X 等允许带链接）：只规整空白，保留链接与品牌。
function sanitize(text: string, strict: boolean): string {
  let t = text
  if (strict) {
    t = t.replace(/\bhttps?:\/\/\S+/gi, '').replace(/\bwww\.\S+/gi, '')
    t = t.replace(/\b(?:hirecx|wonix)\.ai\b/gi, '').replace(/\bwcoin\.casino\b/gi, '').replace(/\bwcoingame\.com\b/gi, '')
    t = t.replace(/\bwcoingame\b/gi, '').replace(/\b(?:hirecx|wonix|wcoin)\b/gi, '')
    t = t.replace(/\(\s*(?:disclosure|disclaimer)[^)]*\)/gi, '') // 去掉 "(disclosure: ...)" 残留
  }
  return t
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function generateDraft(signalId: string): Promise<{ ok: boolean; message: string; draftId?: number }> {
  const sig = db.prepare('SELECT * FROM social_intel WHERE id = ?').get(signalId) as any
  if (!sig) return { ok: false, message: 'signal not found' }
  const product = productByKey(sig.product)
  if (!product) return { ok: false, message: `unknown product ${sig.product}` }
  if (!openrouterEnabled()) return { ok: false, message: 'OPENROUTER_API_KEY 未配置，无法自动生成草稿（可人工撰写）' }

  // Shopify/App Store 评论无法回复 → 只作竞品情报分析，不生成回复草稿
  if (sig.platform === 'shopify' || sig.platform === 'appstore') {
    return { ok: false, message: '竞品评论源（无法回复），仅作竞品情报/分析，不生成草稿' }
  }
  // spec：wonix 不可解信号（封号/支付/牌照）只记录，不发免费样片
  if (sig.product === 'wonix' && sig.solvable === 0) {
    db.prepare("UPDATE social_intel SET status='reviewed' WHERE id=?").run(signalId)
    return { ok: false, message: '不可解信号（封号/支付/牌照），按 spec 仅记录、不外发样片' }
  }

  // Reddit 公开评论（非私信）= 纯价值，连产品 URL 都不喂给模型，降低它写进去的诱惑
  const redditPublic = sig.platform === 'reddit' && sig.reco_play !== 'dm'
  const user = `Our product:
- Name: ${product.name}
${redditPublic ? '' : `- URL: ${product.url}\n`}- What it is: ${product.pitch}

The social-media post (platform: ${sig.platform}, actor: ${sig.actor_type || '?'}, tier: ${sig.intent_tier || '?'}, pain: ${sig.pain_type || '?'}):
- Title: ${sig.title}
- Body: ${sig.body || '(none)'}
- Author: ${sig.author || '(unknown)'}${redditPublic ? '' : `\n- URL: ${sig.url}`}`

  const res = await generateContent(systemFor(sig.product, sig.pain_type, sig.platform, sig.reco_play), user)
  if (!res) return { ok: false, message: 'AI 生成失败（OpenRouter 无响应）' }
  const d = res.data as { relevant?: boolean; reason?: string; comment?: string }
  const relevant = !!d.relevant
  // 程序化兜底清洗：公开评论(尤其 Reddit)强制剥掉 URL / 自有域名 / 品牌词，模型漏写也清掉
  const comment = sanitize((d.comment || '').trim(), redditPublic)
  const reason = (d.reason || '').trim()

  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO social_drafts(signal_id, product, draft, rationale, model, status, created_ts, updated_ts)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(signalId, sig.product, relevant ? comment : '', reason, res.model, relevant ? 'pending' : 'dismissed', now, now)
  db.prepare("UPDATE social_intel SET status='reviewed' WHERE id=?").run(signalId)

  return {
    ok: true,
    draftId: Number(info.lastInsertRowid),
    message: relevant ? '已生成开场白草稿（待审核）' : `AI 判定不相关，已跳过：${reason}`,
  }
}
