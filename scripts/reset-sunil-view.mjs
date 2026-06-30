// Reset the "customer viewed" indicator on Sunil's booking (owner test-clicked
// the link). Clears customerViewedAt and rolls the status back so the real
// customer's first view is tracked accurately.
import { readFileSync } from 'node:fs'
function loadEnv(p){const o={};for(const l of readFileSync(p,'utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(!m)continue;let v=m[2].trim();if(v.startsWith('"')&&v.endsWith('"'))v=v.slice(1,-1);o[m[1]]=v}return o}
const env=loadEnv(new URL('../.env.production.local',import.meta.url).pathname)
const URL_=env.KV_REST_API_URL,TOKEN=env.KV_REST_API_TOKEN
async function call(a){const r=await fetch(URL_,{method:'POST',headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(a.map(String))});const j=await r.json();if(j.error)throw new Error(j.error);return j.result}

const T='363a33b74cf44282b6967399c6e652a4dd1e50d9d7704183b338f817ffdb70d4'
const b=JSON.parse(await call(['GET',`bk:${T}`]))
delete b.customerViewedAt
if(b.status==='customer_viewed') b.status = b.confirmationLinkSentAt ? 'confirmation_link_sent' : 'booking_created'
b.updatedAt=Date.now()
await call(['SET',`bk:${T}`,JSON.stringify(b)])
await call(['ZADD','bk:index',String(b.updatedAt),T])
console.log('Reset done. status:',b.status,'| customerViewedAt:',b.customerViewedAt ?? '(cleared)')
