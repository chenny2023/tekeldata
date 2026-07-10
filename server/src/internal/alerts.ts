import { db } from '../db.ts'
import { webFetch } from '../net.ts'
import { productByKey } from './products.ts'
import { translateOne } from './translate.ts'

// ─────────────────────────────────────────────────────────────────────────────
// C. 黄金一小时提醒：出现高意图机会贴时，立刻通过 Telegram 提醒团队，
// 以便在帖子热度衰减前抢先回复。（团队要求：只发 TG，不发邮件）
//
// 触发阈值：intent ≥ SOCIAL_ALERT_INTENT（默认 0.7），kind=demand。
// 渠道：Telegram —— 配置 TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID（用自己的 bot 推送到群/私聊）。
// 去重：social_alert_sent 表，每条机会贴只提醒一次。未配置 TG 则只在库里登记不外发。
// ─────────────────────────────────────────────────────────────────────────────

// 自建表（幂等）——不能依赖 socialintel.ts 的建表先于本模块执行：socialintel 反过来
// import 本模块，其顶层 import 会先于自身 db.exec 跑，导致这里 prepare 时表还不存在。
db.exec(`CREATE TABLE IF NOT EXISTS social_alert_sent (
  signal_id TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL
)`)
const sent = db.prepare('INSERT OR IGNORE INTO social_alert_sent(signal_id, ts) VALUES(?, ?)')

export interface AlertSignal {
  id: string
  product: string
  platform: string
  kind: string
  title: string
  url: string
  intent: number
}

function threshold(): number {
  const t = Number(process.env.SOCIAL_ALERT_INTENT)
  return Number.isFinite(t) ? t : 0.7
}

async function pushTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID
  if (!token || !chat) return
  try {
    await webFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: false }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    console.warn('[social-intel] telegram alert failed:', (e as Error).message)
  }
}

const esc = (s: string) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

async function notify(s: AlertSignal): Promise<void> {
  const pname = productByKey(s.product)?.name || s.product
  const panel = (process.env.PUBLIC_BASE_URL || 'https://tekeldata.com') + '/internal/social'
  // 当场生成中文解读（best-effort，失败则只发原文）
  let zh = ''
  try { zh = (await translateOne(s.id)) || '' } catch { /* ignore */ }
  const zhTg = zh ? `\n🇨🇳 ${esc(zh)}` : ''

  // 高意图机会贴只走 Telegram，不再发邮件（团队要求）
  const tg =
    `🔥 <b>高意图机会贴</b> (intent ${s.intent.toFixed(2)})\n` +
    `产品：${esc(pname)} · 平台：${s.platform}\n` +
    `${esc(s.title.slice(0, 200))}` + zhTg + `\n` +
    `原贴：${esc(s.url)}\n面板：${panel}`
  await pushTelegram(tg)
}

/** 对一批新采集到的信号，挑出高意图 demand 贴去重后提醒。返回实际发出的条数。 */
export async function maybeAlert(signals: AlertSignal[]): Promise<number> {
  const th = threshold()
  const hot = signals.filter((s) => s.kind === 'demand' && (s.intent || 0) >= th)
  let fired = 0
  for (const s of hot) {
    const r = sent.run(s.id, Date.now())
    if (r.changes === 0) continue // already alerted
    await notify(s)
    fired++
  }
  if (fired) console.log(`[social-intel] 🔥 ${fired} high-intent alert(s) sent`)
  return fired
}
