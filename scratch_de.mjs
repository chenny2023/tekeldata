const B='https://tekeldata.com'
const g=async(p)=>{try{const r=await fetch(B+p,{headers:{'user-agent':'v','cache-control':'no-cache'}});return{s:r.status,t:r.status===200?await r.text():''}}catch{return{s:0,t:''}}}
let live=false
for(let i=0;i<45;i++){const r=await g('/de/guide/what-is-a-crypto-casino');if(r.s===200&&r.t.includes('Krypto-Casino')&&!r.t.includes('id="root"')){live=true;break}await new Promise(x=>setTimeout(x,15000))}
console.log('德语上线:', live?'YES':'TIMEOUT')
for(const s of ['what-is-a-crypto-casino','are-crypto-casinos-safe']){
  let r; for(let j=0;j<8;j++){r=await g('/de/guide/'+s);if(r.s===200&&!r.t.includes('id="root"'))break;await new Promise(x=>setTimeout(x,10000))}
  const lang=(r.t.match(/<html lang="([^"]+)"/)||[])[1]||'?'
  console.log('/de/guide/'+s.padEnd(26), r.s, lang, r.t.includes('"robots" content="index')?'idx':'NOIDX', (r.t.match(/hreflang="/g)||[]).length+'hl', r.t.includes('"FAQPage"')?'faq':'-')
}
const hub=await g('/de/guide'); console.log('/de/guide hub:', hub.s, (hub.t.match(/<html lang="([^"]+)"/)||[])[1], hub.t.includes('"robots" content="index')?'idx':'NOIDX', (hub.t.match(/\/de\/guide\/[a-z-]+/g)||[]).length+'篇')
const en=await g('/guide/what-is-a-crypto-casino'); console.log('英文原页 hreflang→de:', en.t.includes('hreflang="de"')?'YES':'NO','(共'+(en.t.match(/hreflang="/g)||[]).length+')')
