// 内部社媒情报面板 — 单文件 HTML（同源，复用 wcoin_token；支持内置邮箱验证码登录）。
// 纯原生 JS，无构建步骤。数据接口均走管理员 token。
export const PANEL_HTML = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>社媒情报 · 内部</title>
<style>
  :root{--bg:#0b0e14;--panel:#141925;--line:#222a3a;--fg:#e6edf3;--mut:#8b97a8;--acc:#4f8cff;--good:#2ecc71;--warn:#f1c40f}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;align-items:center;gap:16px;padding:12px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
  h1{font-size:16px;margin:0}.mut{color:var(--mut)}
  .tabs{display:flex;gap:6px;margin-left:auto}
  .tab,.btn{background:var(--panel);border:1px solid var(--line);color:var(--fg);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px}
  .tab.on{background:var(--acc);border-color:var(--acc)}
  .btn:hover{border-color:var(--acc)}.btn.sm{padding:3px 8px;font-size:12px}
  .btn.good{background:#16351f;border-color:#1f5c33}.btn.bad{background:#3a1820;border-color:#5c1f2c}
  main{padding:16px 18px;max-width:1100px;margin:0 auto}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  select,input{background:var(--panel);border:1px solid var(--line);color:var(--fg);padding:6px 8px;border-radius:8px;font-size:13px}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 14px}
  .stat b{font-size:18px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
  .pill.demand{color:#ffd479;border-color:#5c4a1f}.pill.competitor{color:#ff9c7a;border-color:#5c2f1f}.pill.brand{color:#7ab8ff;border-color:#1f3a5c}
  .title{font-weight:600;margin:6px 0}.body{color:var(--mut);font-size:13px;max-height:5.2em;overflow:hidden}
  .intent{font-variant-numeric:tabular-nums}
  a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
  textarea{width:100%;min-height:80px;background:#0e1320;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px;font:13px/1.5 inherit;resize:vertical}
  .login{max-width:340px;margin:60px auto;text-align:center}.login input{width:100%;margin:6px 0}
  .toast{position:fixed;bottom:18px;right:18px;background:var(--panel);border:1px solid var(--acc);padding:10px 14px;border-radius:8px;opacity:0;transition:.2s}
  .toast.show{opacity:1}
  .empty{color:var(--mut);text-align:center;padding:40px}
</style></head>
<body>
<div id="app"></div>
<div class="toast" id="toast"></div>
<script>
const TOKEN_KEY='wcoin_token'
let token=localStorage.getItem(TOKEN_KEY)||''
let tab='signals', products=[], filters={product:'',kind:'',platform:'',minIntent:'0',sort:'ts'}
const $=s=>document.querySelector(s)
function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600)}
async function api(path,opts={}){
  const r=await fetch(path,{...opts,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,...(opts.headers||{})}})
  if(r.status===403){token='';localStorage.removeItem(TOKEN_KEY);render();throw new Error('需要管理员登录')}
  return r.json()
}
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const ago=ts=>{if(!ts)return '';const m=(Date.now()-ts)/60000;if(m<60)return Math.round(m)+'m';if(m<1440)return Math.round(m/60)+'h';return Math.round(m/1440)+'d'}

// ── login（内置邮箱验证码，复用 /api/auth）──
let loginEmail=''
async function reqCode(){loginEmail=$('#email').value.trim();const r=await fetch('/api/auth/request-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:loginEmail})});const j=await r.json();if(j.devCode)toast('开发验证码: '+j.devCode);else toast('验证码已发送');render(true)}
async function verify(){const code=$('#code').value.trim();const r=await fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:loginEmail,code})});const j=await r.json();if(j.token){token=j.token;localStorage.setItem(TOKEN_KEY,token);render()}else toast(j.error||'验证失败')}

function loginView(step){
  $('#app').innerHTML='<div class="login"><h1>社媒情报 · 内部</h1><p class="mut">仅限管理员</p>'+
   (step?'<input id="code" placeholder="6 位验证码"><button class="btn" onclick="verify()">登录</button>':
         '<input id="email" placeholder="管理员邮箱" value="'+esc(loginEmail)+'"><button class="btn" onclick="reqCode()">获取验证码</button>')+'</div>'
}

function shell(inner){
  return '<header><h1>社媒情报</h1><span class="mut">竞品 / 用户需求 / 推荐机会</span>'+
   '<div class="tabs">'+
   ['signals|信号','drafts|草稿队列'].map(t=>{const[k,n]=t.split('|');return '<button class="tab '+(tab===k?'on':'')+'" onclick="go(\\''+k+'\\')">'+n+'</button>'}).join('')+
   '<button class="btn" onclick="runNow()">手动采集一轮</button>'+
   '<button class="btn" onclick="logout()">退出</button></div></header><main>'+inner+'</main>'
}
function go(t){tab=t;render()}
function logout(){token='';localStorage.removeItem(TOKEN_KEY);render()}
async function runNow(){await api('/api/internal/social/run',{method:'POST'});toast('已触发采集（结果稍后刷新可见）')}

async function render(loginStep){
  if(!token){loginView(loginStep);return}
  if(!products.length){try{const p=await api('/api/internal/social/products');products=p.products||[]}catch(e){return}}
  if(tab==='signals')await renderSignals();else await renderDrafts()
}

function filterBar(){
  const opt=(val,label,sel)=>'<option value="'+val+'"'+(sel===val?' selected':'')+'>'+label+'</option>'
  return '<div class="filters">'+
   '<select id="f-product" onchange="setF()">'+opt('','全部产品',filters.product)+products.map(p=>opt(p.key,p.name,filters.product)).join('')+'</select>'+
   '<select id="f-kind" onchange="setF()">'+['|全部类别','demand|需求/机会','competitor|竞品','brand|品牌'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.kind)}).join('')+'</select>'+
   '<select id="f-platform" onchange="setF()">'+['|全部平台','reddit|Reddit','x|X','threads|Threads'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.platform)}).join('')+'</select>'+
   '<select id="f-intent" onchange="setF()">'+['0|意图≥0','0.3|意图≥0.3','0.5|意图≥0.5','0.7|意图≥0.7'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.minIntent)}).join('')+'</select>'+
   '<select id="f-sort" onchange="setF()">'+['ts|最新优先','intent|意图优先'].map(o=>{const[v,l]=o.split('|');return opt(v,l,filters.sort)}).join('')+'</select>'+
   '</div>'
}
function setF(){filters={product:$('#f-product').value,kind:$('#f-kind').value,platform:$('#f-platform').value,minIntent:$('#f-intent').value,sort:$('#f-sort').value};renderSignals()}

async function renderSignals(){
  const st=await api('/api/internal/social/stats')
  const qs=new URLSearchParams({product:filters.product,kind:filters.kind,platform:filters.platform,minIntent:filters.minIntent,sort:filters.sort,limit:'80'}).toString()
  const {signals}=await api('/api/internal/social/signals?'+qs)
  const stats='<div class="stats"><div class="stat"><div class="mut">总信号</div><b>'+st.total+'</b></div>'+
    '<div class="stat"><div class="mut">近24h</div><b>'+st.collected24h+'</b></div>'+
    '<div class="stat"><div class="mut">待审草稿</div><b>'+st.pendingDrafts+'</b></div></div>'
  const cards=signals.length?signals.map(s=>{
    const pname=(products.find(p=>p.key===s.product)||{}).name||s.product
    return '<div class="card"><div class="row"><span class="pill '+s.kind+'">'+s.kind+'</span>'+
      '<span class="pill">'+s.platform+'</span><span class="pill">'+esc(pname)+'</span>'+
      '<span class="pill intent">意图 '+(s.intent||0).toFixed(2)+'</span>'+
      '<span class="pill">情绪 '+(s.sentiment||0).toFixed(2)+'</span>'+
      '<span class="mut" style="margin-left:auto">'+ago(s.ts)+' · '+esc(s.author||'')+'</span></div>'+
      '<div class="title">'+esc(s.title)+'</div>'+
      '<div class="body">'+esc((s.body||'').slice(0,360))+'</div>'+
      '<div class="row" style="margin-top:8px"><a href="'+esc(s.url)+'" target="_blank">查看原贴 ↗</a>'+
      '<button class="btn sm" style="margin-left:auto" onclick="mkDraft(\\''+s.id+'\\',this)">生成推荐草稿</button>'+
      '<button class="btn sm" onclick="sigIgnore(\\''+s.id+'\\')">忽略</button></div></div>'
  }).join(''):'<div class="empty">暂无信号（采集器每 ~2min 抓一条查询，刚部署需等几分钟；或点"手动采集一轮"）</div>'
  $('#app').innerHTML=shell(filterBar()+stats+cards)
}
async function mkDraft(id,btn){btn.textContent='生成中…';btn.disabled=true;const r=await api('/api/internal/social/draft',{method:'POST',body:JSON.stringify({signalId:id})});toast(r.message||'完成');if(r.ok&&r.draftId){tab='drafts';render()}else{btn.textContent='生成推荐草稿';btn.disabled=false}}
async function sigIgnore(id){await api('/api/internal/social/signal/'+id+'/status',{method:'POST',body:JSON.stringify({status:'ignored'})});renderSignals()}

async function renderDrafts(){
  const {drafts}=await api('/api/internal/social/drafts?status=pending')
  const cards=drafts.length?drafts.map(d=>{
    const pname=(products.find(p=>p.key===d.product)||{}).name||d.product
    return '<div class="card"><div class="row"><span class="pill '+d.kind+'">'+d.kind+'</span>'+
      '<span class="pill">'+d.platform+'</span><span class="pill">'+esc(pname)+'</span>'+
      '<span class="pill intent">意图 '+(d.intent||0).toFixed(2)+'</span>'+
      '<span class="mut" style="margin-left:auto">'+esc(d.model||'')+'</span></div>'+
      '<div class="title">'+esc(d.post_title)+'</div>'+
      (d.rationale?'<div class="mut" style="font-size:12px">AI: '+esc(d.rationale)+'</div>':'')+
      '<textarea id="dft-'+d.id+'">'+esc(d.draft)+'</textarea>'+
      '<div class="row" style="margin-top:8px"><a href="'+esc(d.post_url)+'" target="_blank">去原贴回复 ↗</a>'+
      '<button class="btn sm" style="margin-left:auto" onclick="copyDraft('+d.id+')">复制</button>'+
      '<button class="btn sm good" onclick="setDraft('+d.id+',\\'posted\\')">已发布</button>'+
      '<button class="btn sm" onclick="setDraft('+d.id+',\\'approved\\')">通过</button>'+
      '<button class="btn sm bad" onclick="setDraft('+d.id+',\\'dismissed\\')">弃用</button></div></div>'
  }).join(''):'<div class="empty">没有待审核草稿。去"信号"页对高意图的需求贴点"生成推荐草稿"。</div>'
  $('#app').innerHTML=shell('<p class="mut">审核 AI 生成的推荐评论 → 复制 → 自己用真实账号去原贴发布（不自动发）。</p>'+cards)
}
function copyDraft(id){const t=$('#dft-'+id);t.select();navigator.clipboard.writeText(t.value);toast('已复制')}
async function setDraft(id,status){const draft=$('#dft-'+id).value;await api('/api/internal/social/draft/'+id+'/status',{method:'POST',body:JSON.stringify({status,draft})});toast('已'+({posted:'标记发布',approved:'通过',dismissed:'弃用'}[status]));renderDrafts()}

render()
</script>
</body></html>`
