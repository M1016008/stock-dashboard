// PREREG_TRANSITIONS_20261111 の報告ページ (1 つの HTML)。集計結果を埋め込み、図は素の SVG で描く。
// 外部のファイル・ネットワークを使わない。本番のアプリ (Next.js) には入れない。

const NOTICES = [
  '過去の実データによる探索の結果であり、投資判断の根拠ではない。',
  '配当を含まない株価の値動き。過去の参考値であり予測ではない。',
  '売買の手数料・値幅の不利、空売りの貸株料・逆日歩などの費用は含めていない。',
  '当時の市場区分は J-Quants の月末の上場銘柄一覧で、シグナルの月には前月末の値を使う。月の途中で区分が変わった銘柄は、その月末の値が翌月のシグナルから使われる。2016 年 11 月末より前の区分は「不明」。',
]

export function renderTransitionsReport(result: unknown): string {
  const data = JSON.stringify(result).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>6 ステージの遷移の研究 (事前登録 2026-11-11)</title><style>${STYLE}</style></head><body>
<header><h1>6 ステージの状態の遷移とその後の値動き</h1><p class="sub">事前登録: research/6stage/event-path-research/PREREG_TRANSITIONS_20261111.md (日本株、Discovery 期間 2022-12-30 まで)</p>
<ul class="notice">${NOTICES.map((text) => `<li>${text}</li>`).join('')}</ul>
<div class="controls">期間 <button data-h="10">10 営業日</button><button data-h="20">20 営業日</button>
　向き <button data-side="LONG">LONG</button><button data-side="SHORT">SHORT (理論上)</button></div></header>
<main><section><h2>研究 2: 6 桁の遷移ごとの勝率とリターン</h2><div id="s2summary"></div>
<div class="grid"><figure><figcaption>① 全遷移の地図 (Discovery 全体。横 = 勝率、縦 = 中央値、大きさ = 件数)</figcaption><svg id="map"></svg></figure>
<figure><figcaption>② 探す期間 (2008〜2017) と確かめる期間 (2018〜2022) の中央値</figcaption><svg id="periods"></svg></figure>
<figure><figcaption>③ リターンの分布 (割合 %)</figcaption><svg id="hist2"></svg></figure>
<figure><figcaption>④ シグナルの日からの値動きの道筋 (買値からの変化)</figcaption><svg id="path2"></svg></figure></div>
<p>遷移を選ぶ (①②の点、または一覧から。どの期間でも 100 件以上になった遷移すべて): <select id="pick"></select></p><div id="detail2"></div></section>
<section><h2>研究 1: X→Y→X 型と X→Y→Z 型</h2><div id="s1judge"></div>
<div class="grid"><figure><figcaption>③ リターンの分布 (割合 %)</figcaption><svg id="hist1"></svg></figure>
<figure><figcaption>④ シグナルの日からの値動きの道筋</figcaption><svg id="path1"></svg></figure></div><div id="detail1"></div></section>
<section><h2>件数の内訳 (除外・重複・結果の無い期間)</h2><div id="counts"></div></section></main>
<script>const RESULT=${data};${SCRIPT}</script></body></html>
`
}

const STYLE = `
:root{--bg:#fff;--fg:#1d2433;--muted:#5d6779;--line:#d8dde6;--a:#2f6fdb;--b:#d9822b;--cand:#c2185b;--band1:rgba(47,111,219,.14);--band2:rgba(47,111,219,.28)}
body{margin:0;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}header,main{max-width:1200px;margin:0 auto;padding:12px 16px}
h1{font-size:20px;margin:4px 0}h2{font-size:17px;border-bottom:1px solid var(--line);padding-bottom:4px}.sub{color:var(--muted);margin:0}
.notice{background:#fff7e6;border:1px solid #f0c36d;padding:8px 8px 8px 28px;margin:8px 0}.controls button{margin:0 4px 0 0;padding:4px 10px;border:1px solid var(--line);background:#f5f7fa;cursor:pointer}
.controls button.on{background:var(--fg);color:#fff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:12px}
figure{margin:0;border:1px solid var(--line);padding:8px}figcaption{font-size:12px;color:var(--muted)}svg{width:100%;height:320px}
table{border-collapse:collapse;font-size:12px;margin:8px 0;font-variant-numeric:tabular-nums}th,td{border:1px solid var(--line);padding:2px 6px;text-align:right}th{background:#f5f7fa}
td.k{text-align:left}.dot{cursor:pointer}.sel{stroke:#000;stroke-width:2}`

// 以下はブラウザで動く素の JavaScript。
const SCRIPT = `
const S={h:10,side:'LONG',sel:null};const NS='http://www.w3.org/2000/svg';
const pct=v=>v==null||Number.isNaN(v)?'—':(v*100).toFixed(2)+'%';const num=v=>v==null?'—':Number(v).toLocaleString('ja-JP');
const med=s=>!s||!s.n?null:S.side==='LONG'?s.median:-s.median;const win=s=>!s||!s.n?null:S.side==='LONG'?s.winLong:s.winShort;
function el(tag,attrs,parent){const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);parent&&parent.appendChild(e);return e}
function frame(svg,xs,ys,xl,yl){svg.innerHTML='';const W=svg.clientWidth||560,H=svg.clientHeight||320,m={l:56,r:12,t:10,b:36};
 const x=v=>m.l+(v-xs[0])/(xs[1]-xs[0]||1)*(W-m.l-m.r),y=v=>H-m.b-(v-ys[0])/(ys[1]-ys[0]||1)*(H-m.t-m.b);
 el('line',{x1:m.l,x2:W-m.r,y1:H-m.b,y2:H-m.b,stroke:'#999'},svg);el('line',{x1:m.l,x2:m.l,y1:m.t,y2:H-m.b,stroke:'#999'},svg);
 const xt=xl.ticks||[0,1,2,3,4].map(i=>xs[0]+(xs[1]-xs[0])*i/4);
 for(const vx of xt)el('text',{x:x(vx),y:H-m.b+14,'font-size':10,'text-anchor':'middle'},svg).textContent=xl.f(vx);
 for(let i=0;i<=4;i++){const vy=ys[0]+(ys[1]-ys[0])*i/4;
  el('text',{x:m.l-4,y:y(vy)+3,'font-size':10,'text-anchor':'end'},svg).textContent=yl.f(vy)}
 el('text',{x:(W+m.l)/2,y:H-4,'font-size':11,'text-anchor':'middle'},svg).textContent=xl.t;
 const t=el('text',{x:12,y:(H-m.b)/2,'font-size':11,'text-anchor':'middle',transform:'rotate(-90 12 '+(H-m.b)/2+')'},svg);t.textContent=yl.t;
 return{x,y,W,H,m}}
const P={t:'',f:v=>(v*100).toFixed(1)+'%'};const extent=(vals,pad)=>{const a=Math.min(...vals),b=Math.max(...vals);const p=(b-a)*pad||0.01;return[a-p,b+p]};
function zero(svg,f,horizontal){if(horizontal){const y=f.y(0);if(y>f.m.t&&y<f.H-f.m.b)el('line',{x1:f.m.l,x2:f.W-f.m.r,y1:y,y2:y,stroke:'#bbb','stroke-dasharray':'3 3'},svg)}}
function study2(){const d=RESULT.study2[S.h];const pr=RESULT.periods2;const rows=d.rows;const cands=new Set(d.candidates[S.side].keys);const b=d.candidates[S.side].baseline;
 document.getElementById('s2summary').innerHTML='<p>探す期間のシグナル: '+(pr.explore?pr.explore.firstSignal+' 〜 '+pr.explore.lastSignal:'—')+'、確かめる期間: '+(pr.confirm?pr.confirm.firstSignal+' 〜 '+pr.confirm.lastSignal:'—')+'</p><table><tr><th>対象の遷移 (100 件以上)</th><th>候補 ('+S.side+')</th><th>偶然で期待される数</th><th>偶然でこれ以上になる確率</th><th>入れ替えの回数</th></tr><tr><td>'+num(rows.length)+'</td><td>'+num(b.observed)+'</td><td>'+b.expected.toFixed(2)+'</td><td>'+b.probabilityAtLeastObserved.toFixed(4)+'</td><td>'+num(b.permutations)+'</td></tr></table>';
 const map=document.getElementById('map');const f=frame(map,extent(rows.map(r=>win(r.all)),0.05),extent(rows.map(r=>med(r.all)),0.05),{t:'勝率',f:v=>(v*100).toFixed(0)+'%'},{t:'中央値',f:P.f});
 const maxN=Math.max(...rows.map(r=>r.all.n));zero(map,f,true);
 for(const r of rows){const c=el('circle',{cx:f.x(win(r.all)),cy:f.y(med(r.all)),r:2+8*Math.sqrt(r.all.n/maxN),fill:cands.has(r.key)?'var(--cand)':'var(--a)','fill-opacity':.55,class:'dot'+(S.sel===r.key?' sel':'')},map);
  el('title',{},c).textContent=r.key+' 件数 '+r.all.n;c.onclick=()=>{S.sel=r.key;draw()}}
 const ok=rows.filter(r=>r.explore.n&&r.confirm.n);const pv=document.getElementById('periods');
 const g=frame(pv,extent(ok.map(r=>med(r.explore)),0.05),extent(ok.map(r=>med(r.confirm)),0.05),{t:'探す期間の中央値',f:P.f},{t:'確かめる期間の中央値',f:P.f});zero(pv,g,true);
 for(const r of ok){const c=el('circle',{cx:g.x(med(r.explore)),cy:g.y(med(r.confirm)),r:3,fill:cands.has(r.key)?'var(--cand)':'var(--a)','fill-opacity':.55,class:'dot'+(S.sel===r.key?' sel':'')},pv);
  el('title',{},c).textContent=r.key;c.onclick=()=>{S.sel=r.key;draw()}}
 const sel=rows.find(r=>r.key===S.sel);const note=S.sel&&!sel?'選んだ遷移 '+S.sel+' は、この期間では対象 (100 件以上) にならないため、全遷移を示す。':'';
 hist(document.getElementById('hist2'),[[ '全遷移',d.pooledHistogram[S.side],'var(--b)'],...(sel?[[sel.key,sel.histogram[S.side],'var(--a)']]:[])]);
 bands(document.getElementById('path2'),[[sel?sel.key:'全遷移',sel?sel.path:d.pooledPath,'var(--a)']]);
 document.getElementById('detail2').innerHTML=(note?'<p>'+note+'</p>':'')+(S.sel&&RESULT.details2[S.sel]?detail(S.sel):'<p>①②の点か一覧で遷移を選ぶと、その遷移の数字が出る。</p>')}
function hist(svg,series){const tot=series.map(s=>s[1].reduce((a,b)=>a+b,0)||1);const share=series.map((s,i)=>s[1].map(v=>v/tot[i]));
 const f=frame(svg,[0,62],[0,Math.max(...share.flat())*1.1],{t:'リターン (左端の棒 = −30% 未満、右端の棒 = +30% 以上)',ticks:[1,16,31,46,61],f:v=>{const p=v-31;return(p>0?'+':p<0?'−':'')+Math.abs(p)+'%'}},{t:'割合',f:v=>(v*100).toFixed(1)+'%'});
 series.forEach((s,i)=>{share[i].forEach((v,j)=>el('rect',{x:f.x(j),y:f.y(v),width:Math.max(1,f.x(j+1)-f.x(j)-1),height:f.y(0)-f.y(v),fill:s[2],'fill-opacity':.45},svg));
  el('text',{x:f.W-f.m.r-4,y:f.m.t+12+i*14,'font-size':11,'text-anchor':'end',fill:s[2]},svg).textContent=s[0]+' (−30% 未満 '+s[1][0]+' 件、+30% 以上 '+s[1][61]+' 件)'})}
function bands(svg,series){const all=series.flatMap(s=>s[1].flat());if(!all.length){svg.innerHTML='';return}
 const flip=q=>S.side==='LONG'?q:[-q[4],-q[3],-q[2],-q[1],-q[0]];const n=series[0][1].length;
 const f=frame(svg,[0,n-1],extent(all.map(Math.abs).flatMap(v=>[v,-v]),0.02),{t:'0 = シグナルの日、1 = 買った日、その後の行',f:v=>v.toFixed(0)},{t:'買値からの変化',f:P.f});zero(svg,f,true);
 series.forEach((s,i)=>{const q=s[1].map(v=>v.length?flip(v):null);const area=(lo,hi,fill)=>{const pts=q.map((v,j)=>v&&[f.x(j),f.y(v[hi])]).filter(Boolean);const back=q.map((v,j)=>v&&[f.x(j),f.y(v[lo])]).filter(Boolean).reverse();
   el('polygon',{points:[...pts,...back].map(p=>p.join(',')).join(' '),fill:s[2],'fill-opacity':fill},svg)};area(0,4,.12);area(1,3,.22);
  el('polyline',{points:q.map((v,j)=>v&&[f.x(j),f.y(v[2])].join(',')).filter(Boolean).join(' '),fill:'none',stroke:s[2],'stroke-width':2},svg);
  el('text',{x:f.W-f.m.r-4,y:f.m.t+12+i*14,'font-size':11,'text-anchor':'end',fill:s[2]},svg).textContent=s[0]+' (中央値、25〜75%、10〜90%)'})}
function row(name,s){if(!s||!s.n)return'<tr><td class="k">'+name+'</td><td>0</td>'+'<td>—</td>'.repeat(12)+'</tr>';
 const q=S.side==='LONG'?[s.q10,s.q25,s.q75,s.q90]:[-s.q90,-s.q75,-s.q25,-s.q10];
 return'<tr><td class="k">'+name+'</td><td>'+num(s.n)+'</td><td>'+pct(win(s))+'</td><td>'+pct(S.side==='LONG'?s.mean:-s.mean)+'</td><td>'+pct(med(s))+'</td>'+q.map(v=>'<td>'+pct(v)+'</td>').join('')+
  '<td>'+pct(s.mfeMedian)+'</td><td>'+pct(s.maeMedian)+'</td><td>'+s.hiDayMedian+' / '+s.loDayMedian+'</td><td>'+pct(s.mfeQ90)+' / '+pct(s.mfeMax)+'</td></tr>'}
const HEAD='<tr><th>区分</th><th>件数</th><th>勝率</th><th>平均</th><th>中央値</th><th>10%</th><th>25%</th><th>75%</th><th>90%</th><th>最大の上昇幅 (中央値)</th><th>最大の下落幅 (中央値)</th><th>到達日数 上昇 / 下落 (中央値)</th><th>逆に上がった最大の幅 90% 点 / 最大 (SHORT のリスク)</th></tr>';
function detail(key){const d=RESULT.details2[key];let html='<h3>'+key+' ('+S.side+')</h3>';for(const h of [5,10,15,20]){const r=d[h];
 html+='<table><caption>'+h+' 営業日'+(r.eligible?'':' (この期間では件数が 100 件未満のため、図・候補の対象外)')+'</caption>'+HEAD+row('探す期間 2008〜2017',r.explore)+row('確かめる期間 2018〜2022',r.confirm)+row('Discovery 全体',r.all)+'</table>';
 html+='<table><caption>'+h+' 営業日、当時の市場区分ごと (探索)</caption>'+HEAD+Object.entries(r.bySegment).map(([k,s])=>row(k,s)).join('')+'</table>'}return html}
function study1(){const d=RESULT.study1.horizons[S.h];const j=d.judgment;
 document.getElementById('s1judge').innerHTML='<table><tr><th>中央値の差 (X→Y→X − X→Y→Z、LONG)</th><th>保守的な 95% 区間</th><th>銘柄のまとまり</th><th>年月のまとまり</th>'+j.blocks.map(b=>'<th>'+b.name+'</th>').join('')+'<th>判断</th></tr><tr><td>'+pct(j.medianDifference)+'</td><td>'+pct(j.conservative95.lower)+' 〜 '+pct(j.conservative95.upper)+'</td><td>'+pct(j.tickerCluster.lower95)+' 〜 '+pct(j.tickerCluster.upper95)+'</td><td>'+pct(j.monthCluster.lower95)+' 〜 '+pct(j.monthCluster.upper95)+'</td>'+j.blocks.map(b=>'<td>'+pct(b.difference)+(b.sameDirection?' 同じ向き':' 同じ向きでない')+'</td>').join('')+'<td>'+(j.difference==='DIFFERENCE'?'差がある':'差がなかった')+'</td></tr></table><p>判断は LONG の差で行う (SHORT は向きが反対になるだけ)。</p>';
 hist(document.getElementById('hist1'),[['X→Y→Z',d.histogram.XYZ[S.side],'var(--b)'],['X→Y→X',d.histogram.XYX[S.side],'var(--a)']]);
 bands(document.getElementById('path1'),[['X→Y→X',d.path.XYX,'var(--a)'],['X→Y→Z',d.path.XYZ,'var(--b)']]);
 let html='';for(const h of [5,10,15,20]){const e=RESULT.study1.horizons[h];html+='<table><caption>'+h+' 営業日</caption>'+HEAD+row('X→Y→X',e.full.XYX)+row('X→Y→Z',e.full.XYZ)+row('全イベント (参考)',e.full.ALL)+
  Object.entries(e.blocks).map(([k,b])=>row(k+' X→Y→X ('+(b.firstSignal||'—')+' 〜 '+(b.lastSignal||'—')+')',b.XYX)+row(k+' X→Y→Z',b.XYZ)).join('')+'</table>'}
 for(const h of [5,10,15,20]){html+='<details'+(h===S.h?' open':'')+'><summary>X の種類ごと ('+h+' 営業日、探索)</summary><table>'+HEAD+Object.entries(RESULT.study1.horizons[h].byX).map(([k,s])=>row(k+' X→Y→X',s.XYX)+row(k+' X→Y→Z',s.XYZ)).join('')+'</table></details>'}
 html+='<table><caption>当時の市場区分ごと ('+S.h+' 営業日、探索)</caption>'+HEAD+Object.keys(d.bySegment.XYX).map(k=>row(k+' X→Y→X',d.bySegment.XYX[k])+row(k+' X→Y→Z',d.bySegment.XYZ[k])).join('')+'</table>';
 html+='<p>Y の滞在日数 (営業日): X→Y→X 中央値 '+RESULT.study1.dwellY.XYX.median+'、X→Y→Z 中央値 '+RESULT.study1.dwellY.XYZ.median+'。</p>';
 document.getElementById('detail1').innerHTML=html}
function counts(){const c=RESULT.counts||{};document.getElementById('counts').innerHTML='<table><tr><th>項目</th><th>件数</th></tr>'+Object.keys(c).sort().map(k=>'<tr><td class="k">'+k+'</td><td>'+num(c[k])+'</td></tr>').join('')+'</table><p>s1 = 研究 1、s2 = 研究 2。kept = 集計に使ったイベント、excluded* = 除外、dedupDropped = 20 営業日以内の重複、missingN.* = N 営業日の結果が無いもの (理由)。</p>'}
function draw(){document.querySelectorAll('[data-h]').forEach(b=>b.classList.toggle('on',+b.dataset.h===S.h));document.querySelectorAll('[data-side]').forEach(b=>b.classList.toggle('on',b.dataset.side===S.side));document.getElementById('pick').value=S.sel||'';study2();study1();counts()}
const pick=document.getElementById('pick');pick.innerHTML='<option value="">—</option>'+Object.keys(RESULT.details2||{}).sort().map(k=>'<option>'+k+'</option>').join('');pick.onchange=()=>{S.sel=pick.value||null;draw()};
document.querySelectorAll('[data-h]').forEach(b=>b.onclick=()=>{S.h=+b.dataset.h;draw()});document.querySelectorAll('[data-side]').forEach(b=>b.onclick=()=>{S.side=b.dataset.side;draw()});
window.onresize=draw;draw();`
