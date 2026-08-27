/* ═══════════════════════════════════════════════════════════════
   매크로렌즈 시세 수집기
   GitHub Actions 가 5분마다 돌려 data/*.json 을 갱신한다.
   서버가 없다 — 깃허브가 서버 노릇을 한다.

   왜 이 구조인가
     야후·네이버는 브라우저의 교차 출처 요청을 막는다(CORS 헤더 없음).
     지수선물 시세는 거래소 라이선스 대상이라 무료 API에 아예 없다.
     그래서 다른 곳들은 전부 백엔드를 둔다.
     깃허브 액션의 최소 주기가 정확히 5분이라, 우리 봉과 맞는다.
   ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const TF = Number(process.env.TF || 5);
const ATR_N = 10, MULT = 3, BARS = 300;
/* 야후는 IP가 아니라 User-Agent 문자열 단위로 요청을 셉니다.
   실측: 같은 IP에서 A라는 UA는 429, B라는 UA는 연속 200.
   그래서 UA는 실제 브라우저가 보내는 형식 그대로여야 합니다.
   (KHTML, like Gecko)가 빠지면 브라우저로 인정받지 못합니다. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SYMS = [
  { id:'K200',  n:'코스피200 선물',    g:'국내선물', d:2, mult:250000, cur:'KRW',
    unit:'1계약 = 25만원 × 포인트', note:'09:00–15:45', src:'naver', q:'FUT' },
  { id:'NQ', n:'나스닥100 선물', g:'해외선물', d:2, mult:20, cur:'USD',
    unit:'E-mini 1계약 = $20 × 포인트', note:'거의 24시간', src:'yahoo', q:'NQ=F' },
  { id:'ES', n:'S&P500 선물',   g:'해외선물', d:2, mult:50, cur:'USD',
    unit:'E-mini 1계약 = $50 × 포인트', note:'거의 24시간', src:'yahoo', q:'ES=F' },
  { id:'YM', n:'다우 선물',      g:'해외선물', d:0, mult:5,  cur:'USD',
    unit:'E-mini 1계약 = $5 × 포인트',  note:'거의 24시간', src:'yahoo', q:'YM=F' },
  { id:'BTC', n:'비트코인', g:'코인 무기한선물', d:1, mult:0.01, cur:'USD',
    unit:'1계약 = 0.01 BTC', src:'crypto', bitget:'BTCUSDT', gate:'BTC_USDT', okx:'BTC-USDT-SWAP' },
  { id:'ETH', n:'이더리움', g:'코인 무기한선물', d:2, mult:0.1, cur:'USD',
    unit:'1계약 = 0.1 ETH', src:'crypto', bitget:'ETHUSDT', gate:'ETH_USDT', okx:'ETH-USDT-SWAP' },
  { id:'SOL', n:'솔라나',   g:'코인 무기한선물', d:3, mult:1, cur:'USD',
    unit:'1계약 = 1 SOL', src:'crypto', bitget:'SOLUSDT', gate:'SOL_USDT', okx:'SOL-USDT-SWAP' },
  { id:'XRP', n:'리플',     g:'코인 무기한선물', d:4, mult:100, cur:'USD',
    unit:'1계약 = 100 XRP', src:'crypto', bitget:'XRPUSDT', gate:'XRP_USDT', okx:'XRP-USDT-SWAP' },
  { id:'DOGE',n:'도지코인', g:'코인 무기한선물', d:5, mult:1000, cur:'USD',
    unit:'1계약 = 1,000 DOGE', src:'crypto', bitget:'DOGEUSDT', gate:'DOGE_USDT', okx:'DOGE-USDT-SWAP' },
];

/* ── 가져오기 ─────────────────────────────────────────────── */
/* curl 로 부른다. 네이버는 Node 의 TLS 지문을 403 으로 막는다 —
   curl 은 통과한다. 깃허브 액션 러너에는 curl 이 기본 설치돼 있다. */
async function get(url, tries=3, extra=[]){
  for(let i=0;i<tries;i++){
    try{
      const { stdout } = await run('curl',
        ['-sS','--compressed','--max-time','25','-H',`User-Agent: ${UA}`,
         '-H','Accept: application/json', ...extra, url],
        { maxBuffer: 40*1024*1024 });
      if(/Too Many Requests|Rate limit|Edge: Too/i.test(stdout.slice(0,120)))
        throw new Error('RATE');
      const j = JSON.parse(stdout);
      if(j && (j.error || j.errmsg)) throw new Error(JSON.stringify(j).slice(0,90));
      return j;
    }catch(e){
      if(i===tries-1) throw new Error(url.slice(8,46)+' · '+(e.message||e).slice(0,60));
      const rate=/RATE/.test(e.message||'');
      await new Promise(s=>setTimeout(s, rate ? 3500*(i+1) : 900*(i+1)));
    }
  }
}
function roll(m, tf){
  const sec = tf*60, out=[];
  for(const b of m){
    const k = Math.floor(b.t/sec)*sec, last = out[out.length-1];
    if(last && last.t===k){
      last.h=Math.max(last.h,b.h); last.l=Math.min(last.l,b.l);
      last.c=b.c; last.v+=(b.v||0);
    } else out.push({t:k,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v||0});
  }
  return out;
}
let yh=0;
async function fromYahoo(S){
  const range = TF<5 ? '5d' : '1mo';
  const host = ['query1','query2'][(yh++)%2];
  const j = await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(S.q)}?interval=${TF}m&range=${range}`,
    3, ['-H','Referer: https://finance.yahoo.com/']);
  const d = j.chart?.result?.[0]; if(!d) throw new Error(S.id+' 빈 응답');
  const q = d.indicators.quote[0], out=[];
  for(let i=0;i<d.timestamp.length;i++){
    if(q.close[i]==null) continue;
    out.push({t:d.timestamp[i], o:q.open[i], h:q.high[i], l:q.low[i], c:q.close[i], v:q.volume[i]||0});
  }
  return out.slice(-BARS);
}
async function fromNaver(S){
  const back = new Date(Date.now()-8*864e5), p=n=>String(n).padStart(2,'0');
  const from = `${back.getFullYear()}${p(back.getMonth()+1)}${p(back.getDate())}0000`;
  const j = await get(`https://api.stock.naver.com/chart/domestic/index/${S.q}/minute?startDateTime=${from}`,
    3, ['-H','Referer: https://m.stock.naver.com/']);
  if(!Array.isArray(j)||!j.length) throw new Error(S.id+' 빈 응답');
  const m = j.map(k=>{
    const t=k.localDateTime;
    const dt=Date.UTC(+t.slice(0,4), +t.slice(4,6)-1, +t.slice(6,8), +t.slice(8,10)-9, +t.slice(10,12));
    return {t:Math.floor(dt/1000), o:+k.openPrice, h:+k.highPrice, l:+k.lowPrice,
            c:+k.currentPrice, v:+(k.accumulatedTradingVolume||0)};
  }).sort((a,b)=>a.t-b.t);
  return roll(m, TF).slice(-BARS);
}
const FEEDS = [
  { n:'Bitget', u:S=>`https://api.bitget.com/api/v2/mix/market/candles?symbol=${S.bitget}&productType=usdt-futures&granularity=${TF}m&limit=${BARS}`,
    p:j=>{ if(j.code!=='00000') throw new Error(j.msg);
      return j.data.map(a=>({t:Math.floor(+a[0]/1000),o:+a[1],h:+a[2],l:+a[3],c:+a[4],v:+a[5]})) } },
  { n:'Gate.io', u:S=>`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${S.gate}&interval=${TF}m&limit=${BARS}`,
    p:j=>j.map(k=>({t:+k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+(k.v||0)})) },
  { n:'OKX', u:S=>`https://www.okx.com/api/v5/market/candles?instId=${S.okx}&bar=${TF}m&limit=${BARS}`,
    p:j=>{ if(j.code!=='0') throw new Error(j.msg);
      return j.data.slice().reverse().map(a=>({t:Math.floor(+a[0]/1000),o:+a[1],h:+a[2],l:+a[3],c:+a[4],v:+a[5]})) } },
];
let FEED=null;
async function fromCrypto(S){
  const order = FEED ? [FEED,...FEEDS.filter(f=>f!==FEED)] : FEEDS;
  let last;
  for(const f of order){
    try{ const r=f.p(await get(f.u(S),1)); if(r.length>ATR_N+5){ FEED=f; return r.sort((a,b)=>a.t-b.t) } }
    catch(e){ last=e }
  }
  throw last||new Error(S.id+' 시세 없음');
}
const LOAD = { yahoo:fromYahoo, naver:fromNaver, crypto:fromCrypto };

/* ── SuperTrend (공식 기본값 ATR 10 × 3, 손대지 않음) ────────── */
function atr(B,n){
  const o=new Array(B.length).fill(NaN); let s=0;
  for(let i=1;i<B.length;i++){
    const tr=Math.max(B[i].h-B[i].l, Math.abs(B[i].h-B[i-1].c), Math.abs(B[i].l-B[i-1].c));
    if(i<=n){ s+=tr; if(i===n) o[i]=s/n } else o[i]=(o[i-1]*(n-1)+tr)/n;
  }
  return o;
}
function supertrend(B,n,mult){
  const A=atr(B,n), up=[], dn=[], dir=[], line=[];
  for(let i=0;i<B.length;i++){
    if(isNaN(A[i])){ up[i]=dn[i]=NaN; dir[i]=1; line[i]=NaN; continue }
    const mid=(B[i].h+B[i].l)/2;
    let u=mid+mult*A[i], d=mid-mult*A[i];
    if(!isNaN(up[i-1])) u=(u<up[i-1]||B[i-1].c>up[i-1])?u:up[i-1];
    if(!isNaN(dn[i-1])) d=(d>dn[i-1]||B[i-1].c<dn[i-1])?d:dn[i-1];
    up[i]=u; dn[i]=d;
    let k = dir[i-1]===undefined?1:dir[i-1];
    if(!isNaN(up[i-1])){
      if(k===-1 && B[i].c>up[i-1]) k=1;
      else if(k===1 && B[i].c<dn[i-1]) k=-1;
    }
    dir[i]=k; line[i]= k===1?d:u;
  }
  return {A,dir,line};
}
function segments(B,dir,line){
  /* 구간의 마지막 봉(b)은 화면에 색을 칠할 때 쓰는 경계다. i-1 이 맞다.
     그러나 체결가는 다르다 — 방향이 바뀐 사실은 i 번째 봉이 마감돼야 알 수 있다.
     따라서 청산가는 반드시 B[i].c 여야 한다. B[i-1].c 를 쓰면 아직 모르는
     시점의 가격으로 파는 셈이고, 하필 i 번째 봉이 전환을 유발한 역방향 봉이라
     그 손실만 빠진다. (실측: 이 한 줄 때문에 +14.35% → +0.34%)
     같은 이유로 새 구간의 진입가도 B[i].c 다. 청산과 진입이 같은 가격이 되어
     always-in-market 시스템의 갭이 사라진다. */
  const segs=[]; let a=null;
  for(let i=0;i<B.length;i++){
    if(isNaN(dir[i])||isNaN(line[i])) continue;
    if(a===null){ a={a:i,dir:dir[i]}; continue }
    if(dir[i]!==a.dir){
      a.b=i-1;                 /* 색칠 경계 */
      a.x=i;                   /* 체결 봉 */
      a.entry=B[a.a].c;
      a.exit=B[i].c;           /* ← 전환봉 종가 */
      segs.push(a);
      a={a:i,dir:dir[i]};
    }
  }
  if(a){ a.b=B.length-1; a.x=B.length-1; a.entry=B[a.a].c; a.exit=B[a.b].c; a.open=true; segs.push(a) }
  return segs;
}

/* ── 확정 거래 원장 (append-only) ──────────────────────────────
   왜 필요한가 — hist 는 매 실행마다 "최근 300봉"에서 다시 계산된다.
   해외선물·코인은 300봉이 약 25시간뿐이라, 그대로 두면 어제 기록이
   내일 사라진다. 청산이 끝난 구간만 골라 한 번 적고 다시는 건드리지
   않는 파일을 따로 둔다. 키는 종목+진입시각이라 중복 저장되지 않는다.

   첫 구간은 넣지 않는다 — 방향 초기값이 매수로 강제돼 있어서
   그 구간은 전환 신호가 아니라 계산 시작점이다.                       */
const LEDGER = 'data/trades.json';
const tradeKey = t => t.id + ':' + t.t0;

async function readLedger(){
  try{
    const j = JSON.parse(await fs.readFile(LEDGER,'utf8'));
    return Array.isArray(j.trades) ? j : { v:1, trades:[] };
  }catch(e){ return { v:1, trades:[] } }
}
async function writeLedger(led, incoming){
  const seen = new Set(led.trades.map(tradeKey));
  let added = 0;
  for(const t of incoming){
    if(seen.has(tradeKey(t))) continue;
    seen.add(tradeKey(t)); led.trades.push(t); added++;
  }
  led.trades.sort((a,b)=>a.t1-b.t1);
  led.updatedAt = Math.floor(Date.now()/1000);
  await fs.writeFile(LEDGER, JSON.stringify(led));
  return added;
}

/* ── 실행 ─────────────────────────────────────────────────── */
const now = Math.floor(Date.now()/1000);
/* 직전 결과를 읽어둔다. 한 종목이 실패해도 마지막 값이 남게 —
   제공처가 잠깐 막히거나 장이 닫혀도 화면이 비지 않는다. */
let prev={syms:[]}, prevBars={};
try{ prev=JSON.parse(await fs.readFile('data/signals.json','utf8')) }catch(e){}
try{ prevBars=JSON.parse(await fs.readFile('data/bars.json','utf8')) }catch(e){}
const prevMap=Object.fromEntries((prev.syms||[]).map(s=>[s.id,s]));
const out = { tf:TF, atrN:ATR_N, mult:MULT, at:now, syms:[] };
const bars = {};
let ok=0, fail=[];
const ledger = await readLedger();
const freshTrades = [];

for(const S of SYMS){
  await new Promise(r=>setTimeout(r,700));   /* 제공처를 몰아치지 않는다 */
  try{
    const B = await LOAD[S.src](S);
    if(B.length < ATR_N+5) throw new Error('봉 부족('+B.length+')');
    const st = supertrend(B, ATR_N, MULT);
    const segs = segments(B, st.dir, st.line).filter(s=>!isNaN(st.line[s.a]));
    if(!segs.length) throw new Error('구간 없음');
    const c = segs[segs.length-1], i = B.length-1;
    const pts = (B[i].c - c.entry) * c.dir;
    out.syms.push({
      id:S.id, n:S.n, g:S.g, d:S.d, mult:S.mult, cur:S.cur, unit:S.unit, note:S.note||'',
      dir:c.dir, entry:+c.entry.toFixed(6), line:+st.line[i].toFixed(6),
      last:+B[i].c.toFixed(6), t0:B[c.a].t, bars:i-c.a, at:B[i].t,
      pts:+pts.toFixed(6), pct:+(pts/c.entry*100).toFixed(4), money:+(pts*S.mult).toFixed(2),
      hist: segs.map(g=>{
        const px = g.open ? B[i].c : B[g.x].c;      /* 체결 가능한 가격 */
        return { t0:B[g.a].t, t1:B[g.x].t, dir:g.dir, open:!!g.open,
          entry:+g.entry.toFixed(6), exit:+px.toFixed(6),
          pts:+((px-g.entry)*g.dir).toFixed(6),
          ret:+(((px-g.entry)*g.dir)/g.entry*100).toFixed(4),
          bars:g.b-g.a };
      }),
    });
    /* 청산이 끝난 구간만 원장으로 보낸다. 첫 구간(index 0)은 제외 —
       방향 초기값에서 출발하므로 전환 신호가 아니다. */
    segs.forEach((g,gi)=>{
      if(gi===0 || g.open) return;
      const px = B[g.x].c;
      freshTrades.push({
        id:S.id, n:S.n, g:S.g, cur:S.cur, mult:S.mult,
        t0:B[g.a].t, t1:B[g.x].t, dir:g.dir,
        entry:+g.entry.toFixed(6), exit:+px.toFixed(6),
        pts:+((px-g.entry)*g.dir).toFixed(6),
        ret:+(((px-g.entry)*g.dir)/g.entry*100).toFixed(4),
        bars:g.b-g.a
      });
    });
    bars[S.id] = B.map(b=>[b.t, +b.o.toFixed(6), +b.h.toFixed(6), +b.l.toFixed(6), +b.c.toFixed(6)]);
    ok++;
    console.log(`  ${S.id.padEnd(5)} ${B.length}봉  ${c.dir>0?'매수':'매도'}  ${(pts/c.entry*100).toFixed(2)}%`);
  }catch(e){
    fail.push(S.id+': '+(e.message||e));
    const old=prevMap[S.id];
    if(old && prev.tf===TF){                 /* 직전 값을 이어 쓴다 */
      out.syms.push({...old, stale:true});
      if(prevBars[S.id]) bars[S.id]=prevBars[S.id];
      console.log(`  ${S.id.padEnd(5)} ✗ ${(e.message||e).slice(0,40)} → 직전 값 유지`);
    } else {
      console.log(`  ${S.id.padEnd(5)} ✗ ${(e.message||e).slice(0,60)}`);
    }
  }
}
/* 순서를 원래대로 */
out.syms.sort((a,b)=>SYMS.findIndex(s=>s.id===a.id)-SYMS.findIndex(s=>s.id===b.id));
out.ok=ok; out.fail=fail;
await fs.mkdir('data',{recursive:true});
await fs.writeFile('data/signals.json', JSON.stringify(out));
await fs.writeFile('data/bars.json', JSON.stringify(bars));
const addedTrades = await writeLedger(ledger, freshTrades);
console.log(`  원장: 신규 ${addedTrades}건 · 누적 ${ledger.trades.length}건`);
console.log(`\n${ok}/${SYMS.length} 종목 · ${TF}분봉 · ${new Date(now*1000).toISOString()}`);
if(!ok) process.exit(1);
