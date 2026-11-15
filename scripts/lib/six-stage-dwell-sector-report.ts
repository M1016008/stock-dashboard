// PREREG_DWELL_SECTOR_20261111 の報告ページ (1 つの HTML)。図と表の部品は研究 1・2 の報告ページのものを使う。
// 遷移ごとの数字だけは大きいため、同じ場所の transitions/ のファイルを、選んだときに読み込む。本番のアプリには入れない。
import { REPORT_HELPERS, REPORT_STYLE } from './six-stage-transitions-report'

const NOTICES = [
  '過去の実データによる探索の結果であり、投資判断の根拠ではない。',
  '配当を含まない株価の値動き。過去の参考値であり予測ではない。',
  '売買の手数料・値幅の不利、空売りの貸株料・逆日歩などの費用は含めていない。',
  '研究 B の 33 業種は J-Quants の月末の上場銘柄一覧で、シグナルの月には前月末の値を使う (シグナル日 2016-12-01 以降)。60 分類は今の分類だけを全期間に使うため、上場廃止した銘柄が入らず、判定には使わない (探索)。',
]

export function renderDwellSectorReport(result: unknown): string {
  const data = JSON.stringify(result).replace(/</g, '\\u003c')
  // 60 分類の読み元 (sector60.json の記録)。事前登録から変えた場合は、その旨と理由を表示する。
  const source60 = (result as { inputs?: { sector60Source?: Record<string, string> } }).inputs?.sector60Source
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const source60Html = source60 ? `<p>60 分類の読み元: ${escape(source60.csv ?? '')} (SHA-256 ${escape(source60.csvSha256 ?? '')})。${escape(source60.note ?? '')}</p>` : ''
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>滞在日数と業種の強さの研究 (事前登録 2026-11-11)</title><style>${REPORT_STYLE}</style></head><body>
<header><h1>滞在日数と業種の強さで分けた遷移のその後の値動き</h1><p class="sub">事前登録: research/6stage/event-path-research/PREREG_DWELL_SECTOR_20261111.md (日本株、Discovery 期間 2022-12-30 まで)</p>
<ul class="notice">${NOTICES.map((text) => `<li>${text}</li>`).join('')}</ul>
<div class="controls">期間 <button data-h="10">10 営業日</button><button data-h="20">20 営業日</button>
　向き <button data-side="LONG">LONG</button><button data-side="SHORT">SHORT (理論上)</button>
　遷移 <button data-g="IMPROVE">すべて改善</button><button data-g="DETERIORATE">すべて悪化</button><button data-g="MIXED">混在 (探索)</button></div></header>
<main><section><h2>判定 (12 個の仮説。差は LONG で、強い証拠 = 99.58% の区間、弱い証拠 = 95% の区間)</h2><div id="judge"></div></section>
<section><h2>研究 A: 直前の状態にいた日数</h2><div class="grid"><figure><figcaption>③ リターンの分布 (割合 %)</figcaption><svg id="histA"></svg></figure>
<figure><figcaption>④ シグナルの日からの値動きの道筋</figcaption><svg id="pathA"></svg></figure></div><div id="tableA"></div></section>
<section><h2>研究 B: 業種の強さ (33 業種)</h2><div class="grid"><figure><figcaption>③ リターンの分布 (割合 %)</figcaption><svg id="histB"></svg></figure>
<figure><figcaption>④ シグナルの日からの値動きの道筋</figcaption><svg id="pathB"></svg></figure></div><div id="tableB"></div></section>
<section><h2>研究 B: 業種の強さ (60 分類、探索)</h2>${source60Html}<div id="tableB60"></div></section>
<section><h2>遷移ごとの数字 (探索)</h2><p id="tnote"></p><p>遷移を選ぶ (入力すると候補が出る。例: 111111&gt;111112) <input id="tkey" size="16" list="tlist"><datalist id="tlist"></datalist> <button id="tgo">表示</button></p><div id="tout"></div></section>
<section><h2>件数の内訳 (除外・重複・結果の無い期間)</h2><div id="counts"></div></section></main>
<script>const RESULT=${data};${REPORT_HELPERS}${SCRIPT}</script></body></html>
`
}

const SCRIPT = `
S.g='IMPROVE';const GN={IMPROVE:'すべて改善',DETERIORATE:'すべて悪化',MIXED:'混在'};const LV={STRONG:'強い証拠',WEAK:'弱い証拠',NONE:'差なし'};
const NAMES={A:['短い (1〜5 日)','中 (6〜19 日)','長い (20 日以上)'],B33:['強い (上位 3 分の 1)','中','弱い (下位 3 分の 1)'],B60:['強い (上位 3 分の 1)','中','弱い (下位 3 分の 1)']};
const COLORS={A:['var(--b)','#7a8496','var(--a)'],B33:['var(--a)','#7a8496','var(--b)']};
const iv=r=>pct(r.lower)+' 〜 '+pct(r.upper);
function judge(){const hs=RESULT.hypotheses;const head='<tr><th>研究</th><th>遷移</th><th>比べるもの</th><th>測るもの</th><th>期間</th><th>差 (LONG)</th><th>95% 区間</th><th>99.58% 区間</th>'+hs[0].blocks.map((_,i)=>'<th>期間 '+(i+1)+'</th>').join('')+'<th>段階</th></tr>';
 const line=r=>'<tr><td class="k">'+r.study+'</td><td class="k">'+GN[r.group]+'</td><td class="k">'+(r.study==='A'?'長い − 短い':'強い − 弱い')+'</td><td class="k">'+(r.measure==='median'?'中央値':'勝率')+'</td><td>'+r.horizon+' 日</td><td>'+pct(r.difference)+'</td><td>'+iv(r.interval95)+'</td><td>'+iv(r.intervalStrong)+'</td>'+
  r.blocks.map(b=>'<td>'+b.name+' '+pct(b.difference)+(b.sameDirection?' 同じ向き':' 同じ向きでない')+'</td>').join('')+'<td>'+(r.judged?LV[r.level]:'探索 (判定しない)')+'</td></tr>';
 document.getElementById('judge').innerHTML='<table>'+head+hs.filter(r=>r.judged).map(line).join('')+'</table><p>期間 1〜3 は、研究 A が 2008〜2012 / 2013〜2017 / 2018〜2022、研究 B が 2016-12〜2018-12 / 2019-01〜2020-12 / 2021-01〜2022-12。SHORT は向きが反対になるだけ。</p><h3>研究 B の勝率の差 (探索)</h3><table>'+head+hs.filter(r=>!r.judged).map(line).join('')+'</table>'}
function figs(key,h,p){const f=RESULT.studies[key].figures[S.g][S.h];const n=NAMES[key],c=COLORS[key];
 hist(document.getElementById(h),[0,1,2].map(i=>[n[i],f.histogram[i][S.side],c[i]]));bands(document.getElementById(p),[0,1,2].map(i=>[n[i],f.path[i],c[i]]))}
function tables(key,id,extra){const t=RESULT.studies[key].tables[S.g];let html=extra||'';for(const h of [5,10,15,20])html+='<table><caption>'+GN[S.g]+'、'+h+' 営業日</caption>'+HEAD+
 [0,1,2].map(i=>row(NAMES[key][i]+' 全期間',t[h][i].full)+Object.entries(t[h][i].blocks).map(([b,s])=>row(NAMES[key][i]+' '+b,s)).join('')).join('')+'</table>';document.getElementById(id).innerHTML=html}
const TR={};window.__transitions=(k,d)=>{TR[k]=d;showT()};const TK=(RESULT.transitions&&RESULT.transitions.keys)||[];
function loadShard(sh){if(TR[sh]||document.getElementById('shard-'+sh))return;const s=document.createElement('script');s.id='shard-'+sh;s.src='transitions/'+sh+'.js';
 s.onerror=()=>{document.getElementById('tout').innerHTML='<p>transitions/'+sh+'.js を読み込めない (この HTML と同じ場所に transitions フォルダがあるか、その先頭の遷移が無いか)。</p>'};document.head.appendChild(s)}
function fillList(){const v=document.getElementById('tkey').value.trim();document.getElementById('tlist').innerHTML=TK.filter(k=>k.startsWith(v)).slice(0,300).map(k=>'<option value="'+k+'">').join('')}
function crow(name,a){if(!a)return'<tr><td class="k">'+name+'</td><td>0</td>'+'<td>—</td>'.repeat(9)+'</tr>';const [n,wl,ws,mean,m,q10,q25,q75,q90,mfe,mae]=a;const L=S.side==='LONG';
 return'<tr><td class="k">'+name+'</td><td>'+num(n)+'</td><td>'+pct(L?wl:ws)+'</td><td>'+pct(L?mean:-mean)+'</td><td>'+pct(L?m:-m)+'</td>'+(L?[q10,q25,q75,q90]:[-q90,-q75,-q25,-q10]).map(v=>'<td>'+pct(v)+'</td>').join('')+'<td>'+pct(mfe)+'</td><td>'+pct(mae)+'</td></tr>'}
function showT(){const out=document.getElementById('tout');const key=S.t;if(!key){out.innerHTML='';return}const shard=TR[key.slice(0,2)];if(!shard)return;const d=shard[key];
 if(!d){out.innerHTML='<p>'+key+' は載せていない (結果のあるイベントがどの期間でも 100 件未満、または集計に使ったイベントに無い)。</p>';return}let html='<h3>'+key+' ('+S.side+')</h3>';
 [5,10,15,20].forEach((h,k)=>{html+='<table><caption>'+h+' 営業日</caption><tr><th>群</th><th>件数</th><th>勝率</th><th>平均</th><th>中央値</th><th>10%</th><th>25%</th><th>75%</th><th>90%</th><th>最大の上昇幅 (中央値)</th><th>最大の下落幅 (中央値)</th></tr>'+
  ['A','B33'].map(st=>!d[st]?'<tr><td class="k">研究 '+st.slice(0,1)+'</td><td colspan="10">この研究では 100 件未満のため載せない</td></tr>':[0,1,2].map(i=>d[st][k][i].map((a,b)=>crow('研究 '+st.slice(0,1)+' '+NAMES[st][i]+' '+(b?RESULT.blocks[st][b-1][0]:'全期間'),a)).join('')).join('')).join('')+'</table>'});out.innerHTML=html}
function loadT(){const key=document.getElementById('tkey').value.trim();S.t=key;if(!/^[0-9]{6}>[0-9]{6}$/.test(key)){document.getElementById('tout').innerHTML='<p>6 桁&gt;6 桁で入れる。</p>';return}
 if(TR[key.slice(0,2)])showT();else loadShard(key.slice(0,2))}
function counts(){const c=RESULT.counts||{};document.getElementById('counts').innerHTML='<table><tr><th>項目</th><th>件数</th></tr>'+Object.keys(c).sort().map(k=>'<tr><td class="k">'+k+'</td><td>'+num(c[k])+'</td></tr>').join('')+'</table><p>A = 研究 A、B33 = 研究 B (33 業種)、B60 = 研究 B (60 分類)。kept = 集計に使ったイベント、excluded* = 除外、dedupDropped = 同じ遷移の 20 営業日以内の重複、missingN.* = N 営業日の結果が無いもの。</p>'}
function draw(){document.querySelectorAll('[data-h]').forEach(b=>b.classList.toggle('on',+b.dataset.h===S.h));document.querySelectorAll('[data-side]').forEach(b=>b.classList.toggle('on',b.dataset.side===S.side));
 document.querySelectorAll('[data-g]').forEach(b=>b.classList.toggle('on',b.dataset.g===S.g));judge();figs('A','histA','pathA');figs('B33','histB','pathB');
 const dw=RESULT.studies.A.dwell[RESULT.groups.indexOf(S.g)];tables('A','tableA','<p>直前の状態にいた日数の中央値: '+[0,1,2].map(i=>NAMES.A[i]+' '+(dw[i].n?dw[i].median:'—')).join('、')+'</p>');
 tables('B33','tableB');tables('B60','tableB60');showT();counts()}
document.querySelectorAll('[data-h]').forEach(b=>b.onclick=()=>{S.h=+b.dataset.h;draw()});document.querySelectorAll('[data-side]').forEach(b=>b.onclick=()=>{S.side=b.dataset.side;draw()});
document.querySelectorAll('[data-g]').forEach(b=>b.onclick=()=>{S.g=b.dataset.g;draw()});document.getElementById('tgo').onclick=loadT;document.getElementById('tkey').oninput=fillList;
{const t=RESULT.transitions||{};document.getElementById('tnote').textContent='探索の表示。研究 2 と同じく、どれかの期間 (5・10・15・20 営業日) で結果のあるイベントが '+(t.minEvents||100)+' 件以上の遷移だけを載せる (研究 A・B ごとに判断)。載せた遷移 '+num(t.included)+' / 集計に使った遷移 '+num(t.observed)+'。'}window.onresize=draw;draw();`
