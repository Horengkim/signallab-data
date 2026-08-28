/* 텔레그램 발송 — 방향이 바뀐 종목만, 한 번만
   ─────────────────────────────────────────────────────────────
   실행: node scripts/notify.mjs   (fetch.mjs 다음에)
   환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID
             DRY_RUN=1 이면 발송하지 않고 내용만 출력한다.

   왜 상태 파일을 두나 — 액션이 재실행되거나 같은 봉에 두 번 돌면
   같은 신호가 두 번 나간다. 종목별 마지막 발송 방향을 적어두고
   그것과 다를 때만 보낸다.

   왜 발송 로그를 따로 남기나 — 백테스트로 만든 성과와 "실제로
   보낸 신호"는 완전히 다른 물건븤다. 홈페이지에서 이 둘을 절대
   섞지 않기 위해, 실제 발송분만 sent.json 에 쌓는다.            */

import fs from 'node:fs/promises';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL = process.env.TELEGRAM_CHANNEL_ID;
const DRY     = process.env.DRY_RUN === '1';
const STATE   = 'data/sent.json';

if (!DRY && (!TOKEN || !CHANNEL)) {
  console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID 가 없습니다. 발송을 건너뜁니다.');
  process.exit(0);
}

const KST = t => new Date((t + 9*3600) * 1000).toISOString().slice(5,16).replace('T',' ');
const fixed = (v, d) => Number(v).toFixed(d);

async function readJSON(p, fallback){ try { return JSON.parse(await fs.readFile(p,'utf8')) } catch { return fallback } }

async function send(text, tries = 3){
  if (DRY){ console.log('─── DRY RUN ───\n' + text + '\n'); return true; }
  for (let i = 0; i < tries; i++){
    try{
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id: CHANNEL, text, parse_mode:'HTML', disable_web_page_preview:true })
      });
      const j = await r.json();
      if (j.ok) return true;
      /* 레이트리밋이면 텔레그램이 알려준 만큼 기다린다 */
      const wait = j.parameters?.retry_after;
      if (wait){ await new Promise(s => setTimeout(s, (wait + 1) * 1000)); continue; }
      console.error('발송 실패:', j.description);
    }catch(e){ console.error('발송 오류:', e.message); }
    await new Promise(s => setTimeout(s, 1500 * (i + 1)));
  }
  return false;
}

function message(s){
  const buy = s.dir === 1;
  const d = s.d ?? 2;
  return [
    `${buy ? '▲' : '▼'} <b>${s.n}</b> — ${buy ? '매수' : '매도'} 전환`,
    ``,
    `현재가   <code>${fixed(s.last, d)}</code>`,
    `전환선   <code>${fixed(s.line, d)}</code>`,
    `전환시각 ${KST(s.t0)} KST`,
    ``,
    `<i>슈퍼트렌드 5분봉 · ATR 10 · 배수 3</i>`,
    `<i>참고용 정보이며 매매 권유가 아닙니다. 원금 손실이 발생할 수 있습니다.</i>`
  ].join('\n');
}

/* ── 연결 점검 ──
   방향 전환은 며칠에 한 번뿐이다. 그 사이에 토큰이 만료되거나
   봇이 채널에서 쫓겨나도 우리는 모른다 — 발송할 일이 없으니
   실패할 일을 없기 때문이다. 그래서 매 실행마다 읽기 전용으로
   두 가지를 확인해 로그에 남긴다. 실제 신호가 나가기 전에
   끊긴 것을 알아채기 위함이다.
     getMe   토큰이 살아 있는가
     getChat 그 봇이 이 채널을 볼 수 있는가 (관리자 권한 포함) */
async function health(){
  if (DRY){ console.log('연결 점검 생략 (DRY_RUN)'); return; }
  try{
    const me = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`)).json();
    if (!me.ok){ console.error(`✗ 봇 토큰 이상 — ${me.description}`); return; }
    console.log(`✓ 봇 @${me.result.username}`);

    const ch = await (await fetch(
      `https://api.telegram.org/bot${TOKEN}/getChat?chat_id=${encodeURIComponent(CHANNEL)}`)).json();
    if (!ch.ok){
      console.error(`✗ 채널 접근 불가 — ${ch.description}`);
      console.error('  채널에 봇이 관리자로 들어가 있는지, 핸들이 맞는지 확인하십시오.');
      return;
    }
    console.log(`✓ 채널 ${ch.result.title} (${ch.result.type})`);
  }catch(e){ console.error('연결 점검 오류:', e.message); }
}
await health();

/* ── 실행 ── */
const sig  = await readJSON('data/signals.json', null);
if (!sig || !Array.isArray(sig.syms)){ console.error('signals.json 을 읽지 못했습니다.'); process.exit(1); }

const state = await readJSON(STATE, { v:1, last:{}, log:[] });
state.last = state.last || {};
state.log  = state.log  || [];

let sent = 0, skipped = 0;

for (const s of sig.syms){
  if (s.stale){ skipped++; continue; }            /* 직전 값 유지분은 보내지 않는다 */
  const prev = state.last[s.id];

  /* 처음 보는 종목은 기준만 세우고 보내지 않는다 —
     원래 있던 방향을 "새 신호"라고 알릴 수는 없다. */
  if (!prev){
    state.last[s.id] = { dir: s.dir, t0: s.t0, at: sig.at };
    console.log(`  ${s.id.padEnd(5)} 기준 설정 (${s.dir===1?'매수':'매도'}) — 발송 안 함`);
    skipped++;
    continue;
  }

  /* 방향이 같고 전환시각도 같으면 같은 신호다 */
  if (prev.dir === s.dir && prev.t0 === s.t0){ skipped++; continue; }

  const ok = await send(message(s));
  if (ok){
    state.last[s.id] = { dir: s.dir, t0: s.t0, at: sig.at };
    state.log.push({
      id:s.id, n:s.n, g:s.g, cur:s.cur, mult:s.mult,
      dir:s.dir, price:s.last, line:s.line, t0:s.t0, sentAt: Math.floor(Date.now()/1000)
    });
    sent++;
    console.log(`  ${s.id.padEnd(5)} ✓ ${s.dir===1?'매수':'매도'} 발송`);
    await new Promise(r => setTimeout(r, 1200));   /* 초당 30건 제한 여유있게 */
  } else {
    console.log(`  ${s.id.padEnd(5)} ✗ 발송 실패 — 상태 유지(다음 실행에 재시도)`);
  }
}

/* 로그가 무한정 커지지 않게 — 최근 5000건만 */
if (state.log.length > 5000) state.log = state.log.slice(-5000);
state.updatedAt = Math.floor(Date.now()/1000);

if (!DRY){
  await fs.mkdir('data', { recursive:true });
  await fs.writeFile(STATE, JSON.stringify(state));
}
console.log(`\n발송 ${sent}건 · 생략 ${skipped}건 · 누적 발송 ${state.log.length}건`);
