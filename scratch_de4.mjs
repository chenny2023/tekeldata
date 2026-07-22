const B='https://tekeldata.com'
const g=async(p)=>{try{const r=await fetch(B+p,{headers:{'user-agent':'v','cache-control':'no-cache'}});return{s:r.status,t:r.status===200?await r.text():''}}catch{return{s:0,t:''}}}
for(let i=0;i<20;i++){
  const en=await g('/guide/what-is-a-crypto-casino')
  const hasDe=en.t.includes('hreflang="de"')
  const de=await g('/de/guide/what-is-a-crypto-casino')
  const deLang=(de.t.match(/<html lang="([^"]+)"/)||[])[1]||'?'
  const deOk=de.s===200&&deLang==='de'&&!de.t.includes('id="root"')
  console.log(`[${i}] ${new Date().toISOString().slice(11,19)} 英文页含de-hreflang:${hasDe?'YES':'no'} | /de页:${deOk?'德语✅':(de.t.includes('id="root"')?'SPA':deLang)}`)
  if(hasDe&&deOk){console.log('  → de hreflang数:',(de.t.match(/hreflang="/g)||[]).length,'FAQPage:',de.t.includes('"FAQPage"')?'Y':'N','index:',de.t.includes('content="index')?'Y':'N');break}
  await new Promise(x=>setTimeout(x,25000))
}
