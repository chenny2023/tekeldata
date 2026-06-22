// Whale Growth — 内部增长情报面板（单文件 HTML）。团队验证码登录（验证码发到管理员邮箱）。
// 纯原生 JS + 事件委托（data-act），无构建步骤。数据接口走团队会话 token（见 wgauth.ts）。
export const PANEL_HTML = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Whale Growth</title>
<style>
  :root{
    --bg:#070a10;--panel:#121826;--panel2:#161d2e;--line:#222c40;
    --fg:#e8eef6;--mut:#8a98ad;--dim:#5b6b86;
    --acc:#5b8cff;--acc2:#7c5bff;--good:#23c882;--bad:#ff5b6e;--warn:#ffb24a;
    --grad:linear-gradient(135deg,#5b8cff,#7c5bff);
  }
  *{box-sizing:border-box}
  ::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#1f2940;border-radius:8px}
  body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#10203f33,transparent),var(--bg);
    color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
  .mut{color:var(--mut)}.dim{color:var(--dim)}.tabnum{font-variant-numeric:tabular-nums}.right{margin-left:auto}

  header{display:flex;align-items:center;gap:14px;padding:12px 22px;border-bottom:1px solid var(--line);
    position:sticky;top:0;z-index:20;background:rgba(7,10,16,.82);backdrop-filter:blur(12px)}
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;letter-spacing:.2px}
  .logo{width:26px;height:26px;border-radius:8px;background:var(--grad);display:grid;place-items:center;font-size:14px;box-shadow:0 4px 14px #5b8cff44}
  .nav{display:flex;gap:4px;margin-left:8px;background:var(--panel);border:1px solid var(--line);padding:4px;border-radius:12px}
  .nav button{background:transparent;border:0;color:var(--mut);padding:7px 14px;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600;transition:.15s}
  .nav button:hover{color:var(--fg)}
  .nav button.on{color:#fff;background:var(--grad);box-shadow:0 4px 12px #5b8cff33}
  .spacer{margin-left:auto}
  .btn{background:var(--panel2);border:1px solid var(--line);color:var(--fg);padding:8px 13px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;transition:.15s;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{border-color:var(--acc);box-shadow:0 0 0 3px #5b8cff1f}
  .btn:disabled{opacity:.5;cursor:default;box-shadow:none}
  .btn.sm{padding:5px 10px;font-size:12px;border-radius:8px}
  .btn.pri{background:var(--grad);border-color:transparent;box-shadow:0 4px 14px #5b8cff33}
  .btn.good{background:#0f3326;border-color:#1c6e4d;color:#5ff0b0}
  .btn.bad{background:#3a1620;border-color:#7a2435;color:#ff9aa8}
  .btn.ghost{background:transparent}

  main{padding:20px 22px 60px;max-width:1180px;margin:0 auto}
  .lead{color:var(--mut);font-size:13px;margin:0 0 16px}

  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin-bottom:18px}
  .kpi{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:14px 16px;position:relative;overflow:hidden}
  .kpi .k-ic{position:absolute;right:12px;top:12px;font-size:18px;opacity:.5}
  .kpi .k-lbl{color:var(--mut);font-size:12px;font-weight:600}
  .kpi .k-val{font-size:26px;font-weight:800;margin-top:4px;letter-spacing:-.5px}
  .kpi .k-sub{font-size:11px;color:var(--dim);margin-top:2px}
  .kpi.accent{border-color:#2a3a63;background:linear-gradient(180deg,#16213d,var(--panel))}

  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:820px){.grid2{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
  .panel h3{margin:0 0 12px;font-size:13px;font-weight:700;color:var(--fg);display:flex;align-items:center;gap:8px}
  .panel h3 .tag{font-size:11px;color:var(--dim);font-weight:600;margin-left:auto}

  .barrow{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12px}
  .barrow .lab{width:108px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 0 auto}
  .bartrack{flex:1;height:8px;background:#0c1220;border-radius:6px;overflow:hidden}
  .barfill{height:100%;border-radius:6px;background:var(--grad)}
  .barrow .num{width:40px;text-align:right;color:var(--fg);font-weight:700}

  .spark{display:flex;align-items:flex-end;gap:4px;height:96px;padding-top:6px}
  .spark .col{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;justify-content:flex-end}
  .spark .col i{width:72%;min-height:3px;background:var(--grad);border-radius:4px 4px 0 0;display:block}
  .spark .col span{font-size:10px;color:var(--dim)}

  .tbl{width:100%;border-collapse:collapse;font-size:12.5px}
  .tbl th{text-align:left;color:var(--dim);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.4px}
  .tbl td{padding:8px;border-bottom:1px solid #1a2336;vertical-align:middle}
  .tbl tr:last-child td{border-bottom:0}
  .tbl tr:hover td{background:#0e1626}

  .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px;background:var(--panel);border:1px solid var(--line);padding:10px 12px;border-radius:12px;position:sticky;top:62px;z-index:10}
  select,input,textarea{background:#0c1220;border:1px solid var(--line);color:var(--fg);padding:8px 10px;border-radius:9px;font-size:13px;font-family:inherit;outline:none}
  select:focus,input:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3px #5b8cff1f}
  input.search{flex:1;min-width:160px}
  label.fld{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--mut);font-weight:600}

  .card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:12px;transition:.15s}
  .card:hover{border-color:#2c3a5a}
  .crow{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
  .pill{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut);font-weight:600;white-space:nowrap}
  .pill.demand{color:#ffd479;border-color:#5c4a1f;background:#21190a}
  .pill.competitor{color:#ff9c7a;border-color:#5c2f1f;background:#22120c}
  .pill.brand{color:#7ab8ff;border-color:#1f3a5c;background:#0c1726}
  .pill.plat{color:#b9a7ff;border-color:#352a5c;background:#150f26}
  .pill.prod{color:#9fe7c6;border-color:#1c5240;background:#0c2018}
  .sent{font-weight:700}.sent.pos{color:var(--good)}.sent.neg{color:var(--bad)}.sent.neu{color:var(--dim)}
  .title{font-weight:700;margin:9px 0 4px;font-size:14.5px;line-height:1.4}
  .body{color:var(--mut);font-size:13px;max-height:4.6em;overflow:hidden}
  .meter{display:inline-flex;align-items:center;gap:7px}
  .meter .mt{width:64px;height:7px;background:#0c1220;border-radius:5px;overflow:hidden}
  .meter .mf{height:100%;border-radius:5px}
  .meter b{font-size:11px;font-variant-numeric:tabular-nums}
  textarea.draft{width:100%;min-height:92px;margin-top:10px;line-height:1.5;resize:vertical}
  .rationale{font-size:12px;color:var(--warn);background:#1c1708;border:1px solid #463615;border-radius:8px;padding:6px 9px;margin-top:8px}
  .zh{font-size:13px;color:#bfe3ff;background:#0c1726;border:1px solid #1f3a5c;border-radius:8px;padding:7px 10px;margin-top:8px;line-height:1.5}

  .login{max-width:360px;margin:9vh auto;text-align:center;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:34px 30px}
  .login .logo{width:46px;height:46px;font-size:22px;margin:0 auto 14px;border-radius:13px}
  .login h1{font-size:19px;margin:0 0 4px}.login input{width:100%;margin:8px 0;text-align:center;font-size:15px;letter-spacing:1px}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--panel2);border:1px solid var(--acc);
    padding:11px 18px;border-radius:11px;opacity:0;transition:.25s;z-index:50;box-shadow:0 10px 30px #0008;font-weight:600;font-size:13px}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .empty{color:var(--mut);text-align:center;padding:54px 20px;border:1px dashed var(--line);border-radius:14px;background:var(--panel)}
  .empty .big{font-size:30px;margin-bottom:8px}
  .skel{height:120px;border-radius:14px;background:linear-gradient(90deg,#0e1422,#141d30,#0e1422);background-size:200% 100%;animation:sh 1.2s infinite;margin-bottom:12px}
  @keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
</style></head>
<body>
<div id="app"></div>
<div class="toast" id="toast"></div>
<script>
const TOKEN_KEY='wg_token'
let token=localStorage.getItem(TOKEN_KEY)||''
let tab='overview', products=[]
let filters={product:'',kind:'',platform:'',minIntent:'0',sort:'intent',status:'',q:'',tier:''}
let aDays=7
const $=s=>document.querySelector(s)
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const ago=ts=>{if(!ts)return '';const m=(Date.now()-ts)/60000;if(m<1)return '刚刚';if(m<60)return Math.round(m)+'分钟前';if(m<1440)return Math.round(m/60)+'小时前';return Math.round(m/1440)+'天前'}
const pname=k=>(products.find(p=>p.key===k)||{}).name||k
// ── i18n（中英文切换，给海外同事用）─────────────────────────────────────────────
// 渲染层全是中文模板；切到 en 时用 MutationObserver 在每次 DOM 变更后翻译，多策略且不破坏中文数据。
let lang=localStorage.getItem('wg_lang')||'zh'
const EN={
'系统从 X 关键词搜索中自动沉淀粉丝≥1000 的作者，再用 AI 筛出领域契合、靠谱(非薅羊毛/机器人)的 KOL。X 采集运行几小时后这里会陆续出现；也可切到「全部候选」看未筛选的原始库。Threads 需 ScrapeCreators 有额度。':'The system harvests X authors with ≥1000 followers, then AI picks niche-fit, credible KOLs (no giveaway/bot accounts). They appear a few hours after X collection runs; switch to “All candidates” for the raw pool. Threads needs ScrapeCreators credits.',
'公开评论：纯价值、不提产品、不带链接（系统已自动剥离），目的是建立信誉，转化走私信。用养过 karma 的号、别重复同一段文案、别发太频。':'Public comment: pure value, no product, no links (auto-stripped) — build credibility; convert via DM. Use an aged-karma account, don’t reuse copy, don’t post too often.',
'改了某产品的关键词/相关性后，可清掉它的旧数据，让采集器按新配置干净重采（仅删该产品，其他产品不动）。':'After changing a product’s keywords/relevance, you can purge its old data so the collector re-collects cleanly under the new config (only that product is deleted, others untouched).',
'采集健康诊断：每平台 总数/近24h/dropped/最后采集，一眼看出哪个源死了':'Collection health: per-platform total / last-24h / dropped / last-run — spot a dead source at a glance',
'竞品被用户吐槽什么 → 反哺我们把产品和服务做得更好（参考分析，不针对这些内容做评论）。':'What users complain about competitors → feeds back into improving our product & service (reference only — we don’t reply to these).',
'把反复出现的用户需求，聚类成可以写文章/落地页去抢排名的选题。这是把社媒需求转成"24h 自动获客"的复利打法。':'Cluster recurring user demand into article/landing-page topics to rank for — turning social demand into a compounding “24/7 auto customer acquisition” play.',
'审核 AI 起草的开场白 → 批准/改/丢 → 用真实账号发（不自动发）。销售与内容两条队列分开，按 spec 各走各的动作。':'Review AI-drafted openers → approve/edit/drop → post from a real account (never auto-posted). Sales and content queues are separate, each per spec.',
'临时有新的情报方向？在这里填关键词即时采集，勾选保存后会被纳入定时轮询。结果进入"信号"页（按产品标签过滤）。':'New intel direction? Enter keywords here to collect now; tick save to add it to scheduled polling. Results land in Signals (filter by product).',
'采集器每 ~2 分钟抓一条查询，刚部署需等几分钟；也可点右上角"手动采集"，或放宽筛选条件。':'The collector fetches one query every ~2 min; after a fresh deploy wait a few minutes, or click “Collect now” top-right, or loosen the filters.',
'还没有洞察。选产品点"生成产品改进洞察"，AI 会把竞品被吐槽的点综合成改进建议。':'No insights yet. Pick a product and click “Generate improvement insights” — AI synthesizes competitor complaints into suggestions.',
'选一个产品点"AI 归纳选题"，会从该产品近期需求贴里聚类出可排名/可转化的内容选题。':'Pick a product and click “Cluster topics” to derive rankable/convertible content topics from its recent demand posts.',
'去"信号"/"竞品痛点"页对高意图信号点"生成开场白"。':'Go to Signals / Competitor pain and click “Generate opener” on a high-intent signal.',
'还没有抑制规则。在「信号」页点"🚫 信号不符"会自动学习：同一作者被标≥2次→以后自动丢；被标内容也作为反例，让分类器丢弃同类。（"忽略"只是跳过，不记录）':'No suppression rules yet. On Signals, “🚫 Signal mismatch” auto-learns: an author flagged ≥2× is dropped thereafter; flagged content also becomes a negative example. (“Skip” just skips, not recorded.)',
'✉️ 走私信(DM)：不过 AutoModerator，可带链接+具体报价；但要像 1:1 真人、开头点出对方的帖子，别像群发模板。':'✉️ Use DM: bypasses AutoModerator, may include a link + concrete offer; but sound 1:1 and human, open by referencing their post, not a mass template.',
'⚠️ Reddit 公开评论：纯价值、不提产品、不带链接（系统已自动剥离），目的是建立信誉，转化走私信。用养过 karma 的号、别重复同一段文案、别发太频。':'⚠️ Reddit public comment: pure value, no product, no links (auto-stripped) — build credibility, convert via DM. Use an aged-karma account, don’t reuse copy, don’t post too often.',
'暂无竞品吐槽。补全竞品词/竞品 app、多采集几轮后这里会有料。':'No competitor complaints yet. Add competitor terms/apps and collect a few more rounds.',
'点下方按钮，验证码会发送到管理员邮箱，向管理员索取验证码即可登录。':'Click below — a code is sent to the admin mailbox; ask the admin for it to sign in.',
'竞品动向 · 用户需求 · 推荐机会，一屏掌握。':'Competitor moves · user demand · outreach opportunities — all in one view.',
'竞品洞察分析（供产品/服务改进参考，非外联）':'Competitor insight analysis (for product/service improvement, not outreach)',
'限定子版块（可选，逗号分隔，仅Reddit）':'Limit subreddits (optional, comma-separated, Reddit only)',
'还没有自定义需求。用上面的表单新建。':'No custom queries yet. Create one with the form above.',
'内容不准确/不相关，记录后不再采集类似':'Inaccurate/irrelevant — record it and stop collecting similar',
'已记录为信号不符，后续同类不再采集':'Recorded as signal-mismatch; similar content won’t be collected',
'保存为定时需求（随调度持续轮询）':'Save as a scheduled query (kept polling by the scheduler)',
'已触发采集…结果稍后刷新可见':'Collection triggered… refresh later to see results',
'可信分(受众质量)0-100':'Credibility (audience quality) 0-100',
'只读 · 仅供分析，不回复':'Read-only · analysis only, no reply',
'请填写查询词（至少2字符）':'Enter a query (at least 2 characters)',
'验证码已发送到管理员邮箱':'Code sent to the admin mailbox',
'未处理 · 一键生成草稿':'Unhandled · one-click draft',
'审核 AI 起草的开场白':'Review AI-drafted openers',
'数据维护：清空并重新采集':'Maintenance: purge & re-collect',
'团队内部 · 增长情报':'Internal · Growth Intel',
'条数 · 环比上一周期':'count · vs last period',
'暂无未处理的高意图机会':'No unhandled high-intent opportunities',
'搜索标题/正文/作者…':'Search title/body/author…',
'仅跳过这条，不记录学习':'Skip this one only, no learning recorded',
'已起草开场白（可改）：':'Drafted opener (editable):',
'信号不符 / 抑制规则':'Signal mismatch / suppression rules',
'验证码发到管理员邮箱':'code sent to admin mailbox',
'，向管理员索取后输入：':', ask the admin then enter:',
'暂无符合条件的信号。':'No matching signals.',
'卡片：原帖(带链接)':'card: original post (with link)',
'启用中的随主调度轮询':'active ones polled by the main scheduler',
'自动积累 · 可解除':'auto-accumulated · removable',
'后台也在自动回填）':'(also auto-backfilled in the background)',
'重新发送 / 返回':'Resend / Back',
'启用(key已读)':'Enabled (key read)',
'全部候选(含低分)':'All candidates (incl. low score)',
'暂无潜在合作对象。':'No potential partners yet.',
'例如：AI招聘选型':'e.g. AI hiring selection',
'查询词 / X账号':'Query / X handle',
'没有待审核草稿。':'No drafts to review.',
'已跳过（不记录）':'Skipped (not recorded)',
'潜在合作 KOL':'Potential partners (KOL)',
'不合适，移出推荐':'Not a fit — remove from recommendations',
'已生成合作 DM':'Collaboration DM generated',
'生成产品改进洞察':'Generate improvement insights',
'各竞品被吐槽排行':'Competitors ranked by complaints',
'目标+可发送动作':'target + sendable action',
'通用 / 自定义':'Generic / Custom',
'已保存的采集需求':'Saved collection queries',
'重对齐关键词后用':'use after realigning keywords',
'不可解·仅记录':'Unsolvable · record only',
'发送验证码登录':'Send code to sign in',
'概览 / 分析':'Overview / Analytics',
'可推荐自有产品':'can recommend our products',
'最高意图机会贴':'Top high-intent opportunities',
'对方未开放私信':'DMs not open',
'生成合作 DM':'Generate collaboration DM',
'为产品生成选题':'Generate topics for product',
'已复制到剪贴板':'Copied to clipboard',
'清空该产品数据':'Purge this product’s data',
'生成中文解读':'Generate Chinese gloss',
'请输入验证码':'Enter the code',
'等待人工发布':'awaiting manual posting',
'各产品信号量':'Signals per product',
'高意图机会词':'High-intent opportunity terms',
'竞品讨论热度':'Competitor discussion heat',
'近 14 天':'Last 14 days','近 30 天':'Last 30 days','近 7 天':'Last 7 days',
'已起草/批准':'Drafted/Approved',
'生成推荐草稿':'Generate draft',
'已标记已联系':'Marked as contacted',
'产品改进洞察':'Product improvement insights',
'痛点类型分布':'Pain-type distribution',
'原始吐槽证据':'Raw complaint evidence',
'还没有选题。':'No topics yet.',
'已起草开场白':'Opener drafted',
'暂无销售草稿':'No sales drafts',
'暂无内容草稿':'No content drafts',
'批准/改/丢':'Approve/Edit/Drop',
'新建采集需求':'New collection query',
'关键词搜索）':'keyword search)',
'账号时间线）':'account timeline)',
'需≥2生效)':'needs ≥2 to apply)',
'开发验证码':'Dev code',
'自定义采集':'Custom',
'新采集信号':'newly collected',
'需求/机会':'Demand/Opportunity',
'竞品相关贴':'competitor posts',
'按平均意图':'by avg intent',
'已生成草稿':'Draft generated',
'仅靠谱推荐':'Credible picks only',
'已移出推荐':'Removed from recommendations',
'竞品被吐槽':'Competitor complaints',
'竞品/来源':'Competitor/Source',
'去原贴回复':'Reply on original',
'生成开场白':'Generate opener',
'已标记发布':'Marked posted',
'已解除抑制':'Suppression removed',
'需要登录':'Sign-in required',
'公开回帖':'Public reply',
'发送中…':'Sending…',
'发送失败':'Send failed',
'验证中…':'Verifying…',
'验证失败':'Verification failed',
'位验证码':'-digit code',
'潜在合作':'Partners',
'竞品洞察':'Competitor insight',
'选题建议':'Topics',
'手动采集':'Collect now',
'加载失败':'Load failed',
'暂无数据':'No data',
'全部历史':'all-time',
'竞品讨论':'Competitor talk',
'待审草稿':'Pending drafts',
'采集趋势':'Collection trend',
'情绪分布':'Sentiment',
'平台分布':'Platform mix',
'平均情绪':'Avg sentiment',
'生成草稿':'Draft',
'采集健康':'Collection health',
'近24h':'last 24h',
'最后采集':'Last run',
'全部产品':'All products',
'全部分层':'All tiers',
'全部类别':'All kinds',
'全部平台':'All platforms',
'全部状态':'All statuses',
'信号不符':'Signal mismatch',
'意图优先':'Intent first',
'最新优先':'Newest first',
'查看原贴':'View original',
'赌场达人':'Casino influencer',
'不可私信':'No DM',
'代表帖：':'Top post: ',
'全部候选':'All candidates',
'生成失败':'Generation failed',
'竞品排行':'Competitor ranking',
'分析中…':'Analyzing…',
'归纳选题':'Cluster topics',
'归纳中…':'Clustering…',
'销售队列':'Sales queue',
'内容队列':'Content queue',
'中立回帖':'neutral reply',
'内容日历':'content calendar',
'竞品痛点':'Competitor pain',
'归属产品':'Product',
'立即采集':'Collect now',
'忽略次数':'Flags',
'确定清空':'Confirm purge of',
'清空中…':'Purging…',
'采集中…':'Collecting…',
'已保存）':'saved)',
'分钟前':'m ago',
'小时前':'h ago',
'运营商':'Operator',
'总信号':'Total signals',
'关键词':'Keyword',
'竞品词':'Competitor term',
'已清理':'Cleaned',
'未处理':'Unhandled',
'已跳过':'Skipped',
'客服圈':'Support',
'已联系':'Contacted',
'不合适':'Not a fit',
'候选库':'Pool',
'已认证':'Verified',
'契合：':'Fit: ',
'已入围':'Shortlisted',
'已生成':'Generated',
'条洞察':' insight(s)',
'失败：':'Failed: ',
'个选题':' topic(s)',
'已发送':'Sent',
'已通过':'Approved',
'已弃用':'Dismissed',
'备注名':'Label',
'已清空':'Purged',
'已删除':'Deleted',
'刚刚':'just now',
'天前':'d ago',
'正面':'Pos','负面':'Neg','中性':'Neutral',
'需求':'Demand','竞品':'Competitor','品牌':'Brand',
'联盟':'Affiliate','投手':'Media buyer','玩家':'Player','行业':'Industry','噪音':'Noise',
'私信':'DM','诊断':'Diagnostic','内容':'Content','丢弃':'Discard','可解':'Solvable',
'登录':'Sign in','概览':'Overview','信号':'Signals','草稿':'Drafts','退出':'Logout',
'暂无':'None','意图':'Intent','条数':'Count','情绪':'Sentiment','环比':'WoW','从未':'never',
'平台':'Platform','总数':'Total','评论':'reviews','论坛':'Forum','应用':'Apply','忽略':'Skip',
'完成':'Done','币圈':'Crypto','其它':'Other','候选':'Candidate','入围':'Shortlisted',
'信用':'Cred','推荐':'Recommended','认证':'Verified','关注':'Following','发文':'Posts',
'主页':'Profile','原帖':'Original','未知':'unknown','批准':'Approve',
'复制':'Copy','类别':'Kind','未跑':'never run','停用':'Disable','启用':'Enable',
'上次':'Last','解除':'Remove','类型':'Type','对象':'Target',
'新增':'added','失败':'Failed',
'🔥 热':'🔥 Hot','🌤 温':'🌤 Warm','❄ 冷':'❄ Cold',
'✅是':'✅Yes','❌否':'❌No',
'高':'High','中':'Med','低':'Low',
'条证据':' evidence','条需求支撑':' demand signals',
'💡 对我们的启示：':'💡 Implication for us: ','⚠️ 竞品短板：':'⚠️ Competitor gap: ','❓ 用户在问：':'❓ Users ask: ','✍️ 切入角度：':'✍️ Angle: ',
'近24h=0(红) 说明该源没采进来 · 待分类积压':'last-24h=0 (red) = source collected nothing · unclassified backlog',
'X启用(key已读):':'X enabled (key read):','正常':'OK',
}
const _ek=Object.keys(EN).filter(k=>EN[k]!==''&&k.length>=2).sort((a,b)=>b.length-a.length)
const PREFIX=['💡 对我们的启示：','⚠️ 竞品短板：','❓ 用户在问：','✍️ 切入角度：','代表帖：','近24h=0(红) 说明该源没采进来 · 待分类积压']
const han=s=>/[一-鿿]/.test(s||'')
function L(str){if(lang!=='en'||!str)return str;const tr=str.trim();if(EN[tr])return str.replace(tr,EN[tr]);let s=str;for(const k of _ek)if(s.indexOf(k)>=0)s=s.split(k).join(EN[k]);return s}
function _node(n){const v=n.nodeValue;if(!v||!han(v))return;const tr=v.trim();if(!tr)return
  if(EN[tr]){n.nodeValue=v.replace(tr,EN[tr]);return}
  const m=tr.match(/^([^一-鿿]*)([一-鿿].*)$/);if(m&&EN[m[2]]){n.nodeValue=v.replace(m[2],EN[m[2]]);return}
  for(const p of PREFIX)if(tr.indexOf(p)===0){n.nodeValue=v.replace(p,EN[p]||p);return}
  if(tr.length<=22&&!(n.parentElement&&n.parentElement.closest('.title,.body,.zh,.rationale,textarea'))){let s=v;for(const k of _ek)if(s.indexOf(k)>=0)s=s.split(k).join(EN[k]);n.nodeValue=s}
}
function applyLang(){if(lang!=='en')return;const r=$('#app');if(!r)return
  const w=document.createTreeWalker(r,NodeFilter.SHOW_TEXT,null);const ns=[];while(w.nextNode())ns.push(w.currentNode)
  ns.forEach(_node)
  r.querySelectorAll('[placeholder]').forEach(e=>{if(han(e.placeholder))e.placeholder=L(e.placeholder)})
  r.querySelectorAll('[title]').forEach(e=>{if(han(e.title))e.title=L(e.title)})}
let _obs
function startObs(){const app=$('#app');if(!app||_obs)return
  _obs=new MutationObserver(()=>{if(lang!=='en')return;_obs.disconnect();try{applyLang()}finally{_obs.observe(app,{childList:true,subtree:true,characterData:true})}})
  _obs.observe(app,{childList:true,subtree:true,characterData:true})}

function toast(m){const t=$('#toast');t.textContent=L(m);t.classList.add('show');clearTimeout(window._tt);window._tt=setTimeout(()=>t.classList.remove('show'),2600)}

async function api(path,opts={}){
  const r=await fetch(path,{...opts,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,...(opts.headers||{})}})
  if(r.status===403){token='';localStorage.removeItem(TOKEN_KEY);render();throw new Error('需要登录')}
  return r.json()
}
const intColor=v=>v>=0.7?'#ff5c5c':v>=0.45?'#ffb24a':v>=0.25?'#ffd479':'#5b6b86'
function meter(v){v=v||0;return '<span class="meter"><span class="mt"><span class="mf" style="width:'+Math.round(v*100)+'%;background:'+intColor(v)+'"></span></span><b style="color:'+intColor(v)+'">'+v.toFixed(2)+'</b></span>'}
function sentChip(v){v=v||0;const c=v>0.15?'pos':v<-0.15?'neg':'neu';const lab=v>0.15?'正面':v<-0.15?'负面':'中性';return '<span class="sent '+c+'">'+lab+' '+v.toFixed(2)+'</span>'}
function kindPill(k){const m={demand:'需求',competitor:'竞品',brand:'品牌'};return '<span class="pill '+k+'">'+(m[k]||k)+'</span>'}
function zhBlock(s){return '<div class="zh" id="zh-'+s.id+'">'+(s.zh?('🇨🇳 '+esc(s.zh)):'<button class="btn sm ghost" data-act="tr" data-id="'+s.id+'">🇨🇳 生成中文解读</button> <span class="dim" style="font-size:12px">（后台也在自动回填）</span>')+'</div>'}
// spec 分类标签
const ACTOR={operator:'运营商',affiliate:'联盟',media_buyer:'投手',player:'玩家',industry:'行业',noise:'噪音'}
const TIERL={hot:'🔥 热',warm:'🌤 温',cold:'❄ 冷'}
const PLAYL={dm:'私信',public_reply:'公开回帖',diagnostic:'诊断',content:'内容',discard:'丢弃'}
function tierPill(t){if(!t)return '';const c=t==='hot'?'#ff5c5c':t==='warm'?'#ffb24a':'#5fb0ff';return '<span class="pill" style="color:'+c+';border-color:'+c+'55;background:'+c+'14">'+(TIERL[t]||t)+'</span>'}
function metaPills(s){let h='';if(s.actor_type&&s.actor_type!=='noise')h+='<span class="pill">'+esc(ACTOR[s.actor_type]||s.actor_type)+'</span>';if(s.pain_type&&s.pain_type!=='none')h+='<span class="pill demand">'+esc(s.pain_type)+'</span>';if(s.solvable===1)h+='<span class="pill" style="color:#5ff0b0;border-color:#1c5240">可解</span>';else if(s.solvable===0)h+='<span class="pill" style="color:#ff9aa8;border-color:#7a2435">不可解·仅记录</span>';if(s.reco_play&&s.reco_play!=='discard')h+='<span class="pill plat">▶ '+esc(PLAYL[s.reco_play]||s.reco_play)+'</span>';return h}

// ── 事件委托 ───────────────────────────────────────────────────────────────
const H={}
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el)return;const a=el.dataset.act;if(H[a]){e.preventDefault();H[a](el.dataset.id,el)}})
H.go=k=>{tab=k;render()}
H.logout=()=>{token='';localStorage.removeItem(TOKEN_KEY);render()}
H.run=async()=>{toast('已触发采集…结果稍后刷新可见');await api('/api/internal/social/run',{method:'POST'})}
H.lang=()=>{lang=lang==='zh'?'en':'zh';localStorage.setItem('wg_lang',lang);document.documentElement.lang=lang;render()}

// ── 登录（Whale Growth 团队验证码：点登录→验证码发到管理员邮箱→输入即可进）──────
let codeSentTo=''
H.reqcode=async(_,btn)=>{if(btn){btn.textContent='发送中…';btn.disabled=true}const r=await fetch('/api/internal/auth/send-code',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const j=await r.json();if(j.sent){codeSentTo=j.to||'';if(j.devCode)toast('开发验证码: '+j.devCode);else toast('验证码已发送到管理员邮箱');render(true)}else{toast(j.error||'发送失败');if(btn){btn.textContent='发送验证码登录';btn.disabled=false}}}
H.verify=async(_,btn)=>{const code=$('#code').value.trim();if(!code)return toast('请输入验证码');if(btn){btn.textContent='验证中…';btn.disabled=true}const r=await fetch('/api/internal/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});const j=await r.json();if(j.token){token=j.token;localStorage.setItem(TOKEN_KEY,token);render()}else{toast(j.error||'验证失败');if(btn){btn.textContent='登录';btn.disabled=false}}}
H.backlogin=()=>render(false)
function loginView(step){
  $('#app').innerHTML='<div class="login"><div class="logo">🐳</div><h1>Whale Growth</h1><p class="mut">团队内部 · 增长情报</p>'+
   (step
     ?'<p class="mut" style="font-size:13px;margin:-4px 0 12px">验证码已发送到管理员邮箱 <b>'+esc(codeSentTo)+'</b>，向管理员索取后输入：</p>'+
       '<input id="code" placeholder="6 位验证码" autofocus inputmode="numeric" maxlength="6"><button class="btn pri" data-act="verify" style="width:100%;justify-content:center">登录</button>'+
       '<button class="btn ghost sm" data-act="backlogin" style="width:100%;justify-content:center;margin-top:8px">重新发送 / 返回</button>'
     :'<p class="mut" style="font-size:13px;margin:-4px 0 14px">点下方按钮，验证码会发送到管理员邮箱，向管理员索取验证码即可登录。</p>'+
       '<button class="btn pri" data-act="reqcode" style="width:100%;justify-content:center">发送验证码登录</button>')+'</div>'
}

function shell(inner){
  const nav=[['overview','概览'],['signals','信号'],['kol','潜在合作'],['painradar','竞品洞察'],['topics','选题建议'],['drafts','草稿'],['custom','自定义采集']]
    .map(t=>'<button class="'+(tab===t[0]?'on':'')+'" data-act="go" data-id="'+t[0]+'">'+t[1]+'</button>').join('')
  return '<header><div class="brand"><div class="logo">🐳</div>Whale Growth</div>'+
    '<div class="nav">'+nav+'</div><div class="spacer"></div>'+
    '<button class="btn ghost sm" data-act="run">⟳ 手动采集</button>'+
    '<button class="btn ghost sm" data-act="lang" title="中文 / English">🌐 '+(lang==='en'?'中文':'EN')+'</button>'+
    '<button class="btn ghost sm" data-act="logout">退出</button></header><main>'+inner+'</main>'
}
function skeleton(){$('#app').innerHTML=shell('<div class="skel"></div><div class="skel"></div><div class="skel"></div>')}

async function render(loginStep){
  if(!token){loginView(loginStep);return}
  if(!products.length){try{const p=await api('/api/internal/social/products');products=p.products||[]}catch(e){return}}
  skeleton()
  try{
    if(tab==='overview')await renderOverview()
    else if(tab==='signals')await renderSignals()
    else if(tab==='kol')await renderKol()
    else if(tab==='painradar')await renderPainRadar()
    else if(tab==='topics')await renderTopics()
    else if(tab==='drafts')await renderDrafts()
    else await renderCustom()
  }catch(e){$('#app').innerHTML=shell('<div class="empty"><div class="big">⚠️</div>'+esc(e.message||'加载失败')+'</div>')}
}

// ── 概览 / 分析 ─────────────────────────────────────────────────────────────
function bars(rows,labFn){const max=Math.max(1,...rows.map(r=>r.n));return rows.map(r=>
  '<div class="barrow"><span class="lab" title="'+esc(labFn(r))+'">'+esc(labFn(r))+'</span>'+
  '<span class="bartrack"><span class="barfill" style="width:'+Math.round(r.n/max*100)+'%"></span></span>'+
  '<span class="num tabnum">'+r.n+'</span></div>').join('')||'<div class="dim" style="font-size:12px">暂无数据</div>'}

async function renderOverview(){
  const a=await api('/api/internal/social/analytics?days='+aDays)
  const st=await api('/api/internal/social/stats')
  const s=a.sentiment||{pos:0,neg:0,neu:0};const stot=(s.pos||0)+(s.neg||0)+(s.neu||0)||1
  const demandN=(a.byKind.find(k=>k.kind==='demand')||{}).n||0
  const compN=(a.byKind.find(k=>k.kind==='competitor')||{}).n||0
  const kpis='<div class="kpis">'+
    '<div class="kpi accent"><span class="k-ic">📈</span><div class="k-lbl">总信号</div><div class="k-val tabnum">'+st.total+'</div><div class="k-sub">全部历史</div></div>'+
    '<div class="kpi"><span class="k-ic">🕐</span><div class="k-lbl">近 '+aDays+' 天</div><div class="k-val tabnum">'+a.byProduct.reduce((x,r)=>x+r.n,0)+'</div><div class="k-sub">新采集信号</div></div>'+
    '<div class="kpi"><span class="k-ic">🎯</span><div class="k-lbl">需求/机会</div><div class="k-val tabnum">'+demandN+'</div><div class="k-sub">可推荐自有产品</div></div>'+
    '<div class="kpi"><span class="k-ic">⚔️</span><div class="k-lbl">竞品讨论</div><div class="k-val tabnum">'+compN+'</div><div class="k-sub">竞品相关贴</div></div>'+
    '<div class="kpi"><span class="k-ic">✍️</span><div class="k-lbl">待审草稿</div><div class="k-val tabnum">'+st.pendingDrafts+'</div><div class="k-sub">等待人工发布</div></div></div>'

  const tmax=Math.max(1,...a.trend.map(t=>t.n))
  const spark='<div class="panel"><h3>📅 采集趋势<span class="tag">近 '+aDays+' 天</span></h3><div class="spark">'+
    (a.trend.length?a.trend.map(t=>'<div class="col"><i style="height:'+Math.round(t.n/tmax*72)+'px" title="'+t.n+'"></i><span>'+t.d.slice(5)+'</span></div>').join(''):'<div class="dim">暂无</div>')+'</div></div>'

  const pct=n=>Math.round(n/stot*100)
  const sentBar='<div class="panel"><h3>😊 情绪分布</h3>'+
    '<div style="display:flex;height:14px;border-radius:7px;overflow:hidden;margin-bottom:8px">'+
    '<span style="width:'+pct(s.pos)+'%;background:var(--good)"></span>'+
    '<span style="width:'+pct(s.neu)+'%;background:#33405c"></span>'+
    '<span style="width:'+pct(s.neg)+'%;background:var(--bad)"></span></div>'+
    '<div class="crow" style="font-size:12px"><span class="sent pos">● 正面 '+(s.pos||0)+'</span>'+
    '<span class="dim">● 中性 '+(s.neu||0)+'</span><span class="sent neg right">● 负面 '+(s.neg||0)+'</span></div></div>'

  const prodBars='<div class="panel"><h3>📦 各产品信号量</h3>'+bars(a.byProduct,r=>pname(r.product))+'</div>'
  const platBars='<div class="panel"><h3>🌐 平台分布</h3>'+bars(a.byPlatform,r=>r.platform)+'</div>'

  const demandTbl='<div class="panel"><h3>🎯 高意图机会词<span class="tag">按平均意图</span></h3><table class="tbl"><tr><th>关键词</th><th>意图</th><th>条数</th><th>情绪</th></tr>'+
    (a.topDemand.length?a.topDemand.map(d=>'<tr><td>'+esc(d.query)+'</td><td>'+meter(d.avg_intent)+'</td><td class="tabnum">'+d.n+'</td><td>'+sentChip(d.avg_sent)+'</td></tr>').join(''):'<tr><td colspan="4" class="dim">暂无</td></tr>')+'</table></div>'

  const arrow=d=>{const x=d||0;if(x>0)return '<span style="color:#ff7a59;font-weight:700">▲'+x+'</span>';if(x<0)return '<span style="color:#5fb0ff;font-weight:700">▼'+(-x)+'</span>';return '<span class="dim">—</span>'}
  const compTbl='<div class="panel"><h3>⚔️ 竞品讨论热度<span class="tag">条数 · 环比上一周期</span></h3><table class="tbl"><tr><th>竞品词</th><th>条数</th><th>环比</th><th>平均情绪</th></tr>'+
    (a.topCompetitor.length?a.topCompetitor.map(d=>'<tr><td>'+esc(d.query)+'</td><td class="tabnum">'+d.n+'</td><td class="tabnum">'+arrow(d.delta)+'</td><td>'+sentChip(d.avg_sent)+'</td></tr>').join(''):'<tr><td colspan="4" class="dim">暂无</td></tr>')+'</table></div>'

  const opp='<div class="panel"><h3>🔥 最高意图机会贴<span class="tag">未处理 · 一键生成草稿</span></h3>'+
    (a.topOpportunities.length?a.topOpportunities.map(o=>
      '<div class="crow" style="padding:8px 0;border-bottom:1px solid #1a2336">'+meter(o.intent)+
      '<span class="pill plat">'+o.platform+'</span><span class="pill prod">'+esc(pname(o.product))+'</span>'+
      '<a href="'+esc(o.url)+'" target="_blank" style="flex:1;min-width:200px;color:var(--fg)">'+esc((o.title||'').slice(0,90))+'</a>'+
      '<button class="btn sm pri" data-act="mkdraft" data-id="'+o.id+'">生成草稿</button></div>').join(''):'<div class="dim" style="font-size:12px">暂无未处理的高意图机会</div>')+'</div>'

  // 🩺 采集健康诊断：每平台 总数/近24h/dropped/最后采集，一眼看出哪个源死了
  const hrows=(st.health||[]).map(h=>'<tr><td>'+esc(h.platform)+'</td><td class="tabnum">'+h.total+'</td><td class="tabnum" style="color:'+(h.last24h>0?'#5ff0b0':'#ff5b6e')+'">'+h.last24h+'</td><td class="tabnum dim">'+(h.dropped||0)+'</td><td class="dim" style="font-size:11px">'+(h.last_ts?ago(h.last_ts):'从未')+'</td></tr>').join('')
  const health='<div class="panel"><h3>🩺 采集健康<span class="tag">近24h=0(红) 说明该源没采进来 · 待分类积压 '+(st.unclassified||0)+'</span></h3>'+
    '<div class="rationale" style="margin:0 0 10px">🐦 '+esc(st.twDiag||'')+'　|　X启用(key已读): '+(st.xEnabled?'✅是':'❌否')+(typeof st.scCredits==='number'&&st.scCredits>=0?'　|　🧵 Threads credits: '+(st.scCredits<150?'<b style="color:var(--bad)">'+st.scCredits+' (low)</b>':st.scCredits):'')+'</div>'+
    '<table class="tbl"><tr><th>平台</th><th>总数</th><th>近24h</th><th>已清理</th><th>最后采集</th></tr>'+
    (hrows||'<tr><td colspan="5" class="dim">暂无</td></tr>')+'</table></div>'

  const head='<div class="crow" style="margin-bottom:14px"><p class="lead" style="margin:0">竞品动向 · 用户需求 · 推荐机会，一屏掌握。</p>'+
    '<select class="right" id="a-days"><option value="7"'+(aDays===7?' selected':'')+'>近 7 天</option><option value="14"'+(aDays===14?' selected':'')+'>近 14 天</option><option value="30"'+(aDays===30?' selected':'')+'>近 30 天</option></select></div>'

  $('#app').innerHTML=shell(head+kpis+health+'<div class="grid2">'+spark+sentBar+'</div><div class="grid2">'+prodBars+platBars+'</div>'+opp+'<div class="grid2">'+demandTbl+compTbl+'</div>')
  $('#a-days').onchange=e=>{aDays=Number(e.target.value);render()}
}

// ── 信号 ────────────────────────────────────────────────────────────────────
function toolbar(){
  const opt=(v,l,sel)=>'<option value="'+v+'"'+(sel===v?' selected':'')+'>'+l+'</option>'
  return '<div class="toolbar">'+
   '<input class="search" id="f-q" placeholder="🔎 搜索标题/正文/作者…" value="'+esc(filters.q)+'">'+
   '<select id="f-product">'+opt('','全部产品',filters.product)+products.map(p=>opt(p.key,p.name,filters.product)).join('')+'</select>'+
   '<select id="f-tier">'+['|全部分层','hot|🔥 热','warm|🌤 温','cold|❄ 冷'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.tier)}).join('')+'</select>'+
   '<select id="f-kind">'+['|全部类别','demand|需求/机会','competitor|竞品','brand|品牌'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.kind)}).join('')+'</select>'+
   '<select id="f-platform">'+['|全部平台','reddit|Reddit','bluesky|Bluesky','hn|Hacker News','x|X','threads|Threads','shopify|Shopify评论','appstore|App Store','telegram|Telegram','forum|论坛'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.platform)}).join('')+'</select>'+
   '<select id="f-intent">'+['0|意图≥0','0.25|意图≥0.25','0.45|意图≥0.45','0.7|意图≥0.7'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.minIntent)}).join('')+'</select>'+
   '<select id="f-status">'+['|全部状态','new|未处理','reviewed|已起草/批准','ignored|已跳过','mismatch|信号不符'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.status)}).join('')+'</select>'+
   '<select id="f-sort">'+['intent|意图优先','ts|最新优先'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.sort)}).join('')+'</select>'+
   '<button class="btn sm pri" id="f-apply">应用</button></div>'
}
function bindToolbar(){
  const sync=()=>{filters={product:$('#f-product').value,kind:$('#f-kind').value,platform:$('#f-platform').value,minIntent:$('#f-intent').value,status:$('#f-status').value,sort:$('#f-sort').value,q:$('#f-q').value,tier:$('#f-tier').value};renderSignals()}
  ;['f-product','f-kind','f-platform','f-intent','f-status','f-sort','f-tier'].forEach(id=>$('#'+id).onchange=sync)
  $('#f-apply').onclick=sync
  $('#f-q').onkeydown=e=>{if(e.key==='Enter')sync()}
}
async function renderSignals(){
  const qs=new URLSearchParams({product:filters.product,kind:filters.kind,platform:filters.platform,minIntent:filters.minIntent,status:filters.status,sort:filters.sort,q:filters.q,tier:filters.tier,limit:'100'}).toString()
  const {signals}=await api('/api/internal/social/signals?'+qs)
  const cards=signals.length?signals.map(s=>
    '<div class="card"><div class="crow">'+tierPill(s.intent_tier)+kindPill(s.kind)+metaPills(s)+
    '<span class="pill plat">'+s.platform+'</span>'+
    '<span class="pill prod">'+esc(pname(s.product))+'</span>'+meter(s.intent)+sentChip(s.sentiment)+
    (s.status==='reviewed'?'<span class="pill" style="color:var(--good);border-color:#1c5240">已生成草稿</span>':'')+
    '<span class="right dim" style="font-size:12px">'+ago(s.ts)+' · '+esc(s.author||'')+' · "'+esc(s.query||'')+'"</span></div>'+
    '<div class="title">'+esc(s.title)+'</div>'+
    '<div class="body">'+esc((s.body||'').slice(0,360))+'</div>'+
    zhBlock(s)+
    '<div class="crow" style="margin-top:10px"><a href="'+esc(s.url)+'" target="_blank">查看原贴 ↗</a>'+
    '<button class="btn sm pri right" data-act="mkdraft" data-id="'+s.id+'">生成推荐草稿</button>'+
    '<button class="btn sm ghost" data-act="mismatch" data-id="'+s.id+'" title="内容不准确/不相关，记录后不再采集类似">🚫 信号不符</button>'+
    '<button class="btn sm ghost" data-act="ignore" data-id="'+s.id+'" title="仅跳过这条，不记录学习">忽略</button></div></div>').join('')
    :'<div class="empty"><div class="big">🛰️</div>暂无符合条件的信号。<br><span class="mut">采集器每 ~2 分钟抓一条查询，刚部署需等几分钟；也可点右上角"手动采集"，或放宽筛选条件。</span></div>'
  $('#app').innerHTML=shell(toolbar()+cards)
  bindToolbar()
}
H.mkdraft=async(id,btn)=>{if(btn){btn.textContent='生成中…';btn.disabled=true}const r=await api('/api/internal/social/draft',{method:'POST',body:JSON.stringify({signalId:id})});toast(r.message||'完成');if(r.ok&&r.draftId){tab='drafts';render()}else if(btn){btn.textContent='生成推荐草稿';btn.disabled=false}}
H.ignore=async id=>{await api('/api/internal/social/signal/'+id+'/status',{method:'POST',body:JSON.stringify({status:'ignored'})});toast('已跳过（不记录）');renderSignals()}
H.mismatch=async id=>{await api('/api/internal/social/signal/'+id+'/status',{method:'POST',body:JSON.stringify({status:'mismatch'})});toast('已记录为信号不符，后续同类不再采集');renderSignals()}

// ── 潜在合作 KOL ─────────────────────────────────────────────────────────────
let kolF={product:'',platform:'',status:'',all:''}
const ROLEL={media_buyer:'投手',affiliate:'联盟',casino_influencer:'赌场达人',operator:'运营商',cx:'客服圈',crypto:'币圈',industry:'行业',other:'其它'}
const KSTAT={candidate:'候选',shortlisted:'入围',contacted:'已联系',rejected:'不合适'}
const fmtN=n=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n||0)
function credPill(v){v=v||0;const c=v>=70?'#5ff0b0':v>=50?'#ffd479':'#ffb24a';return '<span class="pill" style="color:'+c+';border-color:'+c+'55;background:'+c+'14" title="可信分(受众质量)0-100">信用 '+v+'</span>'}
async function renderKol(){
  const opt=(v,l,sel)=>'<option value="'+v+'"'+(sel===v?' selected':'')+'>'+l+'</option>'
  const qs=new URLSearchParams({product:kolF.product,platform:kolF.platform,status:kolF.status,all:kolF.all}).toString()
  const {items,stats}=await api('/api/internal/social/kols?'+qs)
  const bar='<div class="toolbar">'+
    '<select id="k-product">'+opt('','全部产品',kolF.product)+products.map(p=>opt(p.key,p.name,kolF.product)).join('')+'</select>'+
    '<select id="k-platform">'+['|全部平台','x|X','threads|Threads'].map(o=>{const[v,l]=o.split('|');return opt(v,l,kolF.platform)}).join('')+'</select>'+
    '<select id="k-status">'+['|全部状态','candidate|候选','shortlisted|入围','contacted|已联系','rejected|不合适'].map(o=>{const[v,l]=o.split('|');return opt(v,l,kolF.status)}).join('')+'</select>'+
    '<select id="k-all">'+['|仅靠谱推荐','1|全部候选(含低分)'].map(o=>{const[v,l]=o.split('|');return opt(v,l,kolF.all)}).join('')+'</select>'+
    '<button class="btn sm pri" id="k-apply">应用</button>'+
    '<span class="right dim" style="font-size:12px">推荐 <b style="color:var(--good)">'+stats.recommended+'</b> · 候选库 '+stats.total+' · 已联系 '+stats.contacted+'</span></div>'
  const cards=items.length?items.map(k=>{
    const verified=k.verified?'<span class="pill" style="color:#5fb0ff;border-color:#5fb0ff55" title="已认证">✔ 认证</span>':''
    const dm=k.can_dm?'':'<span class="pill" style="color:#ff9aa8;border-color:#7a2435" title="对方未开放私信">🔒 不可私信</span>'
    const fitp=k.fit_product?'<span class="pill prod">契合：'+esc(pname(k.fit_product))+'</span>':''
    return '<div class="card"><div class="crow">'+
      '<span class="pill plat">'+esc(k.platform)+'</span>'+
      '<span class="pill" style="color:#cdd6f4">@'+esc(k.handle)+'</span>'+
      (k.name?'<span class="dim" style="font-size:13px">'+esc(k.name)+'</span>':'')+
      verified+credPill(k.cred_score)+
      '<span class="pill">👥 '+fmtN(k.followers)+'</span>'+
      (k.fit_role?'<span class="pill demand">'+(ROLEL[k.fit_role]||esc(k.fit_role))+'</span>':'')+fitp+dm+
      '<span class="pill" style="opacity:.8">'+(KSTAT[k.status]||k.status)+'</span>'+
      '<span class="right dim" style="font-size:12px">关注 '+fmtN(k.following)+' · 发文 '+fmtN(k.statuses)+'</span></div>'+
      (k.bio?'<div class="body">'+esc(k.bio)+'</div>':'')+
      (k.fit_reason?'<div class="zh">🎯 '+esc(k.fit_reason)+'</div>':'')+
      (k.sample_text?'<div class="dim" style="font-size:12px;margin-top:6px">代表帖：'+esc(k.sample_text.slice(0,160))+(k.sample_url?' <a href="'+esc(k.sample_url)+'" target="_blank">↗</a>':'')+'</div>':'')+
      (k.dm_draft?'<div class="zh" id="dm-'+esc(k.id)+'" style="white-space:pre-wrap;border-left:2px solid var(--accent);padding-left:8px;margin-top:8px">✉️ '+esc(k.dm_draft)+'</div>':'<div id="dm-'+esc(k.id)+'"></div>')+
      '<div class="crow" style="margin-top:10px"><a href="'+esc(k.profile_url)+'" target="_blank">主页 ↗</a>'+
      '<button class="btn sm pri right" data-act="koldm" data-id="'+esc(k.id)+'">✉️ 生成合作 DM</button>'+
      '<button class="btn sm ghost" data-act="kshort" data-id="'+esc(k.id)+'" title="加入入围">⭐ 入围</button>'+
      '<button class="btn sm ghost" data-act="kcontact" data-id="'+esc(k.id)+'" title="标记已联系">✅ 已联系</button>'+
      '<button class="btn sm ghost" data-act="kreject" data-id="'+esc(k.id)+'" title="不合适，移出推荐">🚫 不合适</button></div></div>'
  }).join('')
  :'<div class="empty"><div class="big">🤝</div>暂无潜在合作对象。<br><span class="mut">系统从 X 关键词搜索中自动沉淀粉丝≥1000 的作者，再用 AI 筛出领域契合、靠谱(非薅羊毛/机器人)的 KOL。X 采集运行几小时后这里会陆续出现；也可切到「全部候选」看未筛选的原始库。Threads 需 ScrapeCreators 有额度。</span></div>'
  $('#app').innerHTML=shell(bar+cards)
  ;['k-product','k-platform','k-status','k-all'].forEach(id=>$('#'+id).onchange=()=>{kolF={product:$('#k-product').value,platform:$('#k-platform').value,status:$('#k-status').value,all:$('#k-all').value};renderKol()})
  $('#k-apply').onclick=()=>{kolF={product:$('#k-product').value,platform:$('#k-platform').value,status:$('#k-status').value,all:$('#k-all').value};renderKol()}
}
H.koldm=async(id,btn)=>{if(btn){btn.textContent='生成中…';btn.disabled=true}const r=await api('/api/internal/social/kol/'+encodeURIComponent(id)+'/dm',{method:'POST'});if(r.ok&&r.draft){const box=$('#dm-'+id);if(box)box.innerHTML='✉️ '+esc(r.draft);box.style.cssText='white-space:pre-wrap;border-left:2px solid var(--accent);padding-left:8px;margin-top:8px';toast('已生成合作 DM')}else toast(r.error||r.message||'生成失败');if(btn){btn.textContent='✉️ 生成合作 DM';btn.disabled=false}}
H.kshort=async id=>{await api('/api/internal/social/kol/'+encodeURIComponent(id)+'/status',{method:'POST',body:JSON.stringify({status:'shortlisted'})});toast('已入围');renderKol()}
H.kcontact=async id=>{await api('/api/internal/social/kol/'+encodeURIComponent(id)+'/status',{method:'POST',body:JSON.stringify({status:'contacted'})});toast('已标记已联系');renderKol()}
H.kreject=async id=>{await api('/api/internal/social/kol/'+encodeURIComponent(id)+'/status',{method:'POST',body:JSON.stringify({status:'rejected'})});toast('已移出推荐');renderKol()}
H.tr=async(id,btn)=>{if(btn){btn.textContent='生成中…';btn.disabled=true}const r=await api('/api/internal/social/translate',{method:'POST',body:JSON.stringify({signalId:id})});const box=$('#zh-'+id);if(r.ok&&box){box.innerHTML='🇨🇳 '+esc(r.zh)}else{toast(r.error||'生成失败');if(btn){btn.textContent='🇨🇳 生成中文解读';btn.disabled=false}}}

// ── 竞品洞察分析（供产品/服务改进参考，非外联）──────────────────────────────
let prFilter=''
const SEV={high:'<span class="pill" style="color:#ff5c5c;border-color:#5c1f1f;background:#22120c">高</span>',med:'<span class="pill" style="color:#ffb24a;border-color:#5c4a1f;background:#21190a">中</span>',low:'<span class="pill" style="color:#5fb0ff;border-color:#1f3a5c">低</span>'}
async function renderPainRadar(){
  const qs=prFilter?('?product='+prFilter):''
  const a=await api('/api/internal/social/painanalysis'+qs)
  const ins=await api('/api/internal/social/insights'+qs)
  const opt=(v,l,sel)=>'<option value="'+v+'"'+(sel===v?' selected':'')+'>'+l+'</option>'
  const bar='<div class="toolbar"><label class="fld" style="flex-direction:row;align-items:center;gap:8px">产品<select id="pr-product">'+products.map(p=>opt(p.key,p.name,prFilter||(products[0]&&products[0].key))).join('')+'</select></label>'+
    '<button class="btn pri" id="pr-gen">✨ 生成产品改进洞察</button>'+
    '<select id="pr-filter" class="right">'+opt('','全部产品',prFilter)+products.map(p=>opt(p.key,p.name,prFilter)).join('')+'</select></div>'

  // ① AI 产品改进洞察
  const il=(ins.insights||[])
  const insCards=il.length?il.map(x=>
    '<div class="card"><div class="crow">'+(SEV[x.severity]||'')+'<span class="pill prod">'+esc(pname(x.product))+'</span>'+
    '<span class="right dim" style="font-size:11px">'+(x.evidence_count||0)+' 条证据 · '+esc(x.model||'')+'</span></div>'+
    '<div class="title">'+esc(x.theme)+'</div>'+
    (x.gap?'<div class="mut" style="font-size:13px">⚠️ 竞品短板：'+esc(x.gap)+'</div>':'')+
    (x.implication?'<div class="zh" style="color:#9fe7c6;border-color:#1c5240;background:#0c2018">💡 对我们的启示：'+esc(x.implication)+'</div>':'')+'</div>').join('')
    :'<div class="empty" style="padding:26px"><div class="big">🧭</div>还没有洞察。选产品点"生成产品改进洞察"，AI 会把竞品被吐槽的点综合成改进建议。</div>'
  const insPanel='<div class="panel" style="background:transparent;border:0;padding:0"><h3 style="font-size:14px">🧭 产品改进洞察<span class="tag">竞品被吐槽 → 我们该改进/规避</span></h3>'+insCards+'</div>'

  // ② 痛点类型分布 + ③ 竞品排行
  const pmax=Math.max(1,...a.byPain.map(x=>x.n))
  const painBars='<div class="panel"><h3>📊 痛点类型分布</h3>'+(a.byPain.length?a.byPain.map(x=>
    '<div class="barrow"><span class="lab" title="'+esc(x.pain)+'">'+esc(x.pain)+'</span><span class="bartrack"><span class="barfill" style="width:'+Math.round(x.n/pmax*100)+'%;background:linear-gradient(90deg,#ff7a59,#ff5c5c)"></span></span><span class="num tabnum">'+x.n+'</span></div>').join(''):'<div class="dim">暂无</div>')+'</div>'
  const compTbl='<div class="panel"><h3>⚔️ 各竞品被吐槽排行</h3><table class="tbl"><tr><th>竞品/来源</th><th>平台</th><th>条数</th><th>平均情绪</th></tr>'+
    (a.byCompetitor.length?a.byCompetitor.map(c=>'<tr><td>'+esc(c.query||'')+'</td><td><span class="pill plat">'+c.platform+'</span></td><td class="tabnum">'+c.n+'</td><td>'+sentChip(c.avg_sent)+'</td></tr>').join(''):'<tr><td colspan="4" class="dim">暂无</td></tr>')+'</table></div>'

  // ④ 原始吐槽证据（只读，不针对其回复）
  const ev=(a.complaints||[])
  const evRows=ev.length?ev.map(s=>
    '<div class="card" style="padding:10px 14px"><div class="crow"><span class="pill competitor">'+esc(s.query||'')+'</span><span class="pill plat">'+s.platform+'</span>'+(s.pain_type&&s.pain_type!=='none'?'<span class="pill demand">'+esc(s.pain_type)+'</span>':'')+sentChip(s.sentiment)+'<a href="'+esc(s.url)+'" target="_blank" class="right">原帖 ↗</a></div>'+
    '<div style="font-size:13px;margin-top:6px">'+esc((s.title||'').slice(0,200))+'</div>'+(s.zh?'<div class="zh" style="margin-top:6px">🇨🇳 '+esc(s.zh)+'</div>':'')+'</div>').join('')
    :'<div class="empty">暂无竞品吐槽。补全竞品词/竞品 app、多采集几轮后这里会有料。</div>'
  const evPanel='<div class="panel" style="background:transparent;border:0;padding:0"><h3 style="font-size:14px">🧾 原始吐槽证据<span class="tag">只读 · 仅供分析，不回复</span></h3>'+evRows+'</div>'

  $('#app').innerHTML=shell('<p class="lead">竞品被用户吐槽什么 → 反哺我们把产品和服务做得更好（参考分析，不针对这些内容做评论）。</p>'+bar+insPanel+'<div class="grid2">'+painBars+compTbl+'</div>'+evPanel)
  $('#pr-filter').onchange=e=>{prFilter=e.target.value;renderPainRadar()}
  $('#pr-gen').onclick=async()=>{const product=$('#pr-product').value;const b=$('#pr-gen');b.textContent='AI 分析中…';b.disabled=true;const r=await api('/api/internal/social/insights',{method:'POST',body:JSON.stringify({product})});toast(r.ok?('已生成 '+(r.added||0)+' 条洞察'):('失败：'+(r.error||'')));prFilter=product;renderPainRadar()}
}

// ── 选题建议 ────────────────────────────────────────────────────────────────
let tpFilter=''
async function renderTopics(){
  const qs=tpFilter?('?product='+tpFilter):''
  const {topics}=await api('/api/internal/social/topics'+qs)
  const opt=(v,l,sel)=>'<option value="'+v+'"'+(sel===v?' selected':'')+'>'+l+'</option>'
  const bar='<div class="toolbar"><label class="fld" style="flex-direction:row;align-items:center;gap:8px">为产品生成选题<select id="tp-product">'+products.map(p=>opt(p.key,p.name,tpFilter||products[0]&&products[0].key)).join('')+'</select></label>'+
    '<button class="btn pri" id="tp-go">✨ AI 归纳选题</button>'+
    '<select id="tp-filter" class="right">'+opt('','全部产品',tpFilter)+products.map(p=>opt(p.key,p.name,tpFilter)).join('')+'</select></div>'
  const cards=topics.length?topics.map(t=>
    '<div class="card"><div class="crow"><span class="pill prod">'+esc(pname(t.product))+'</span>'+
    (t.keyword?'<span class="pill" style="color:#7ab8ff;border-color:#1f3a5c">🔑 '+esc(t.keyword)+'</span>':'')+
    '<span class="right dim" style="font-size:11px">'+(t.demand_count||0)+' 条需求支撑 · '+esc(t.model||'')+'</span></div>'+
    '<div class="title">'+esc(t.topic)+'</div>'+
    (t.question?'<div class="mut" style="font-size:13px">❓ 用户在问：'+esc(t.question)+'</div>':'')+
    (t.angle?'<div class="rationale">✍️ 切入角度：'+esc(t.angle)+'</div>':'')+'</div>').join('')
    :'<div class="empty"><div class="big">💡</div>还没有选题。<br><span class="mut">选一个产品点"AI 归纳选题"，会从该产品近期需求贴里聚类出可排名/可转化的内容选题。</span></div>'
  $('#app').innerHTML=shell('<p class="lead">把反复出现的用户需求，聚类成可以写文章/落地页去抢排名的选题。这是把社媒需求转成"24h 自动获客"的复利打法。</p>'+bar+cards)
  $('#tp-go').onclick=topicsGo
  $('#tp-filter').onchange=e=>{tpFilter=e.target.value;renderTopics()}
}
async function topicsGo(){
  const product=$('#tp-product').value
  const b=$('#tp-go');b.textContent='AI 归纳中…';b.disabled=true
  const r=await api('/api/internal/social/topics',{method:'POST',body:JSON.stringify({product})})
  toast(r.ok?('已生成 '+(r.added||0)+' 个选题'):('失败：'+(r.error||'未知')))
  tpFilter=product;renderTopics()
}

// ── 草稿 ────────────────────────────────────────────────────────────────────
function draftCard(d){
  // spec 卡片：原帖(带链接) → 标签(actor/intent/pain) → 已起草开场白 → [批准][改][丢]
  return '<div class="card"><div class="crow">'+tierPill(d.intent_tier)+metaPills(d)+
    '<span class="pill plat">'+d.platform+'</span><span class="pill prod">'+esc(pname(d.product))+'</span>'+meter(d.intent)+
    '<span class="right dim" style="font-size:11px">'+esc(d.model||'')+'</span></div>'+
    '<div class="title">'+esc(d.post_title)+'</div>'+
    (d.post_zh?'<div class="zh">🇨🇳 '+esc(d.post_zh)+'</div>':'')+
    (d.rationale?'<div class="rationale">💡 '+esc(d.rationale)+'</div>':'')+
    '<div class="dim" style="font-size:11px;margin-top:8px">✍️ 已起草开场白（可改）：</div>'+
    (d.reco_play==='dm'?'<div class="rationale" style="color:#9fe7c6;border-color:#1c5240;background:#0c2018">✉️ 走私信(DM)：不过 AutoModerator，可带链接+具体报价；但要像 1:1 真人、开头点出对方的帖子，别像群发模板。</div>':d.platform==='reddit'?'<div class="rationale" style="color:#ff9c7a;border-color:#5c2f1f;background:#22120c">⚠️ Reddit 公开评论：纯价值、不提产品、不带链接（系统已自动剥离），目的是建立信誉，转化走私信。用养过 karma 的号、别重复同一段文案、别发太频。</div>':'')+
    '<textarea class="draft" id="dft-'+d.id+'">'+esc(d.draft)+'</textarea>'+
    '<div class="crow" style="margin-top:10px"><a href="'+esc(d.post_url)+'" target="_blank">去原贴回复 ↗</a>'+
    '<button class="btn sm right" data-act="copy" data-id="'+d.id+'">📋 复制</button>'+
    '<button class="btn sm good" data-act="dstat" data-id="'+d.id+':posted">✓ 已发送</button>'+
    '<button class="btn sm" data-act="dstat" data-id="'+d.id+':approved">批准</button>'+
    '<button class="btn sm bad" data-act="dstat" data-id="'+d.id+':dismissed">丢弃</button></div></div>'
}
async function renderDrafts(){
  const {drafts}=await api('/api/internal/social/drafts?status=pending')
  const sales=drafts.filter(d=>d.product==='wonix'||d.product==='hirecx')
  const content=drafts.filter(d=>d.product==='wcoin')
  const sec=(title,sub,arr,emptyMsg)=>'<div class="panel" style="background:transparent;border:0;padding:0;margin-bottom:18px">'+
    '<h3 style="font-size:14px">'+title+'<span class="tag">'+sub+'</span></h3>'+
    (arr.length?arr.map(draftCard).join(''):'<div class="empty" style="padding:28px">'+emptyMsg+'</div>')+'</div>'
  const body= (drafts.length
    ? sec('🎯 销售队列','Wonix + HireCX · 目标+可发送动作',sales,'暂无销售草稿')+
      sec('📝 内容队列','wcoin · 中立回帖 → 内容日历',content,'暂无内容草稿')
    : '<div class="empty"><div class="big">✍️</div>没有待审核草稿。<br><span class="mut">去"信号"/"竞品痛点"页对高意图信号点"生成开场白"。</span></div>')
  $('#app').innerHTML=shell('<p class="lead">审核 AI 起草的开场白 → 批准/改/丢 → 用真实账号发（不自动发）。销售与内容两条队列分开，按 spec 各走各的动作。</p>'+body)
}
H.copy=id=>{const t=$('#dft-'+id);t.select();navigator.clipboard.writeText(t.value);toast('已复制到剪贴板')}
H.dstat=async raw=>{const i=raw.indexOf(':');const id=raw.slice(0,i),status=raw.slice(i+1);const draft=$('#dft-'+id).value;await api('/api/internal/social/draft/'+id+'/status',{method:'POST',body:JSON.stringify({status,draft})});toast({posted:'已标记发布',approved:'已通过',dismissed:'已弃用'}[status]);renderDrafts()}

// ── 自定义采集 ──────────────────────────────────────────────────────────────
async function renderCustom(){
  const {items}=await api('/api/internal/social/custom')
  const sup=await api('/api/internal/social/suppress')
  const opt=(v,l)=>'<option value="'+v+'">'+l+'</option>'
  const form='<div class="panel"><h3>➕ 新建采集需求</h3>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">'+
    '<label class="fld">备注名<input id="c-label" placeholder="例如：AI招聘选型"></label>'+
    '<label class="fld">归属产品<select id="c-product"><option value="custom">通用 / 自定义</option>'+products.map(p=>opt(p.key,p.name)).join('')+'</select></label>'+
    '<label class="fld">类别<select id="c-kind">'+opt('demand','需求/机会')+opt('competitor','竞品')+opt('brand','品牌')+'</select></label>'+
    '<label class="fld">平台<select id="c-platform">'+opt('reddit','Reddit（关键词搜索）')+opt('x','X（账号时间线）')+'</select></label>'+
    '<label class="fld" style="grid-column:span 2">查询词 / X账号<input id="c-query" placeholder="Reddit填关键词；X填账号名(不带@)"></label>'+
    '<label class="fld" style="grid-column:span 3">限定子版块（可选，逗号分隔，仅Reddit）<input id="c-subs" placeholder="recruiting, humanresources"></label>'+
    '</div>'+
    '<div class="crow" style="margin-top:12px"><label class="crow" style="font-size:13px;gap:6px;cursor:pointer"><input type="checkbox" id="c-save" checked style="width:auto"> 保存为定时需求（随调度持续轮询）</label>'+
    '<button class="btn pri right" id="c-go">🚀 立即采集</button></div></div>'

  const rows=items.length?items.map(it=>
    '<tr><td>'+(it.active?'<span class="sent pos">●</span>':'<span class="dim">○</span>')+'</td>'+
    '<td><b>'+esc(it.label||it.query)+'</b><div class="dim" style="font-size:11px">'+esc(it.query)+(it.subreddits?' · r/'+esc(it.subreddits):'')+'</div></td>'+
    '<td>'+kindPill(it.kind)+'</td><td><span class="pill plat">'+it.platform+'</span></td>'+
    '<td><span class="pill prod">'+esc(pname(it.product))+'</span></td>'+
    '<td class="dim" style="font-size:11px">'+(it.last_run_ts?ago(it.last_run_ts):'未跑')+'</td>'+
    '<td class="right" style="white-space:nowrap"><button class="btn sm" data-act="crun" data-id="'+it.id+'">▶ 跑</button> '+
    '<button class="btn sm ghost" data-act="ctoggle" data-id="'+it.id+'">'+(it.active?'停用':'启用')+'</button> '+
    '<button class="btn sm bad" data-act="cdel" data-id="'+it.id+'">删</button></td></tr>').join('')
    :'<tr><td colspan="7" class="dim" style="text-align:center;padding:24px">还没有自定义需求。用上面的表单新建。</td></tr>'
  const list='<div class="panel"><h3>📌 已保存的采集需求<span class="tag">启用中的随主调度轮询</span></h3>'+
    '<table class="tbl"><tr><th></th><th>需求</th><th>类别</th><th>平台</th><th>产品</th><th>上次</th><th></th></tr>'+rows+'</table></div>'

  const opt2=(v,l)=>'<option value="'+v+'">'+l+'</option>'
  const maint='<div class="panel"><h3>🧹 数据维护：清空并重新采集<span class="tag">重对齐关键词后用</span></h3>'+
    '<p class="mut" style="font-size:13px;margin:0 0 10px">改了某产品的关键词/相关性后，可清掉它的旧数据，让采集器按新配置干净重采（仅删该产品，其他产品不动）。</p>'+
    '<div class="crow"><select id="pg-product">'+products.map(p=>opt2(p.key,p.name)).join('')+'</select>'+
    '<button class="btn bad" id="pg-go">清空该产品数据</button></div></div>'
  const sr=(sup.items||[])
  const suprows=sr.length?sr.map(s=>
    '<tr><td><span class="pill prod">'+esc(pname(s.product))+'</span></td>'+
    '<td>'+esc(s.kind)+'</td><td><b>'+esc(s.value)+'</b></td>'+
    '<td class="tabnum">'+s.hits+' 次'+(s.kind==='author'&&s.hits<2?' <span class="dim">(需≥2生效)</span>':'')+'</td>'+
    '<td class="right"><button class="btn sm bad" data-act="unsupp" data-id="'+s.id+'">解除</button></td></tr>').join('')
    :'<tr><td colspan="5" class="dim" style="text-align:center;padding:20px">还没有抑制规则。在「信号」页点"🚫 信号不符"会自动学习：同一作者被标≥2次→以后自动丢；被标内容也作为反例，让分类器丢弃同类。（"忽略"只是跳过，不记录）</td></tr>'
  const suppanel='<div class="panel"><h3>🚫 信号不符 / 抑制规则<span class="tag">点"信号不符"自动积累 · 可解除</span></h3>'+
    '<table class="tbl"><tr><th>产品</th><th>类型</th><th>对象</th><th>忽略次数</th><th></th></tr>'+suprows+'</table></div>'
  $('#app').innerHTML=shell('<p class="lead">临时有新的情报方向？在这里填关键词即时采集，勾选保存后会被纳入定时轮询。结果进入"信号"页（按产品标签过滤）。</p>'+form+list+suppanel+maint)
  $('#c-go').onclick=customGo
  $('#pg-go').onclick=purgeGo
}
H.unsupp=async id=>{await api('/api/internal/social/suppress/'+id,{method:'DELETE'});toast('已解除抑制');renderCustom()}
async function purgeGo(){
  const product=$('#pg-product').value
  const name=(products.find(p=>p.key===product)||{}).name||product
  if(!confirm('确定清空 '+name+' 的全部信号和草稿？此操作不可恢复（其他产品不受影响）。'))return
  const b=$('#pg-go');b.textContent='清空中…';b.disabled=true
  const r=await api('/api/internal/social/purge',{method:'POST',body:JSON.stringify({product})})
  toast(r.ok?('已清空 '+name+'：信号'+r.deleted.signals+' 草稿'+r.deleted.drafts):('失败：'+(r.error||'')))
  renderCustom()
}
async function customGo(){
  const body={label:$('#c-label').value,product:$('#c-product').value,kind:$('#c-kind').value,platform:$('#c-platform').value,query:$('#c-query').value,subreddits:$('#c-subs').value,save:$('#c-save').checked}
  if((body.query||'').trim().length<2){toast('请填写查询词（至少2字符）');return}
  const b=$('#c-go');b.textContent='采集中…';b.disabled=true
  const r=await api('/api/internal/social/custom',{method:'POST',body:JSON.stringify(body)})
  toast(r.ok?('采集完成，新增 '+(r.added||0)+' 条'+(r.savedId?'（已保存）':'')):('失败：'+(r.error||'未知')))
  if(r.ok&&r.added>0){tab='signals';filters.q=body.query;render()}else renderCustom()
}
H.crun=async id=>{toast('采集中…');const r=await api('/api/internal/social/custom/'+id+'/run',{method:'POST'});toast(r.ok?('新增 '+(r.added||0)+' 条'):'失败');renderCustom()}
H.ctoggle=async id=>{await api('/api/internal/social/custom/'+id+'/toggle',{method:'POST'});renderCustom()}
H.cdel=async id=>{await api('/api/internal/social/custom/'+id,{method:'DELETE'});toast('已删除');renderCustom()}

document.documentElement.lang=lang
startObs()
render()
</script>
</body></html>`
