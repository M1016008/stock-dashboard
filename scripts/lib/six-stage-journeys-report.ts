// 探索「111111 からの旅」の報告ページ (1 つの HTML、ネットにつながらなくても開ける)。本番のアプリには入れない。
// 軸・書式・色は研究 1・2 の報告ページの部品を使う。
import { REPORT_HELPERS, REPORT_STYLE } from './six-stage-transitions-report'

const NOTICES = [
  '探索。差がある・ないの判定はしない。',
  '配当を含まない株価の値動き。過去の参考値であり予測ではない。',
  '日本株、Discovery 期間 (2022-12-30 まで)。6 桁がすべて決まる日だけで数えるため、実際の期間は 2010 年以降。分割の補正漏れの 19 銘柄は除く。',
  '日数は、その銘柄の売買がある日で数える。途中に 10 営業日を超える売買の空白がある旅・滞在は除き、件数を下に示す。',
]

export function renderJourneysReport(result: unknown): string {
  const data = JSON.stringify(result).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>111111 からの旅 (探索)</title><style>${REPORT_STYLE}
svg.ring{width:100%;max-width:560px;height:auto;aspect-ratio:1}svg.wide{width:100%;height:680px}svg.small{width:100%;height:220px}
.multi{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.multi figure{margin:0}</style></head><body>
<header><h1>111111 からの旅 (探索)</h1><p class="sub">6 桁 = 日A・日B・週A・週B・月A・月B のステージ。111111 を出た日から、初めて 111111 に戻るまでを「旅」とする。</p>
<ul class="notice">${NOTICES.map((text) => `<li>${text}</li>`).join('')}</ul></header>
<main><section><h2>① 日A だけの遷移</h2><p>日A の桁が同じ日々を 1 つの滞在にまとめた。矢印の太さ = 回数。日数と騰落 (入った日の終値 → 次に移った日の終値) は、区間の初めから始まる滞在を除いて数える。矢印に指を置くと数字が出る。</p>
<div class="grid"><figure><svg id="ring" class="ring"></svg></figure><div id="ringTable"></div></div></section>
<section><h2>② 旅の集計</h2><div id="summary"></div><div class="grid"><figure><figcaption>戻るまでの日数 (戻った旅)</figcaption><svg id="hist"></svg></figure>
<figure><figcaption>まだ戻っていない割合 (戻らずに終わった旅も入れる。Kaplan–Meier)</figcaption><svg id="km"></svg></figure></div><div id="worst"></div><div id="quant"></div></section>
<section><h2>③ よくある旅の型 上位 ${20} (戻った旅)</h2><p>型 = 出た日から戻る前日までの 6 桁の並び。途中の状態が 6 個以上なら「最初の 3 つ → …(省いた数)… → 最後の 2 つ」。
図: 出た日の終値を基準にした終値の変化 (線 = 中央値、帯 = 25〜75%)。縦の線 = その型の戻るまでの日数の中央値。点線 = すべての旅 (戻らなかった旅も入れる) の中央値で、生き残った旅だけを見る偏りと比べるためのもの。</p>
<div id="types"></div><div class="multi" id="typeFigs"></div></section>
<section><h2>④ 出た直後の分かれ道 (1〜4 歩目)</h2><p>各歩で 1% 未満の状態は「その他」にまとめた。戻った・途切れ・データの終わり・売買の終わりは、そこで止める (まとめない)。</p><svg id="sankey" class="wide"></svg></section>
<section><h2>確認と件数</h2><div id="verify"></div><div id="counts"></div></section></main>
<script>const RESULT=${data};${REPORT_HELPERS}${SCRIPT}</script></body></html>
`
}

const SCRIPT = `
const J=RESULT.journeys;const OUT={RETURNED:'戻った',BREAK:'途切れ (6 桁が決まらない日が来た)',DATA_END:'データの終わり (2022-12-30 まで戻らず)',TRADING_END:'売買の終わり (それより前に売買が終わった)'};
const qrow=(name,q)=>'<tr><td class="k">'+name+'</td><td>'+num(q.n)+'</td>'+(q.n?[q.q10,q.q25,q.q50,q.q75,q.q90]:[null,null,null,null,null]).map(v=>'<td>'+pct(v)+'</td>').join('')+'</tr>';
const QH='<tr><th>項目</th><th>件数</th><th>10%</th><th>25%</th><th>中央値</th><th>75%</th><th>90%</th></tr>';
function ring(){const svg=document.getElementById('ring');svg.innerHTML='';svg.setAttribute('viewBox','0 0 520 520');const W=520,H=520,cx=W/2,cy=H/2,R=Math.min(W,H)/2-60;
 const pos=d=>{const a=-Math.PI/2+(d-1)*Math.PI/3;return[cx+R*Math.cos(a),cy+R*Math.sin(a)]};const max=Math.max(...RESULT.dailyA.map(e=>e.n));
 const defs=el('defs',{},svg);const mk=el('marker',{id:'arw',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:9,markerHeight:9,markerUnits:'userSpaceOnUse',orient:'auto'},defs);el('path',{d:'M0,0L10,5L0,10z',fill:'#555'},mk);
 for(const e of RESULT.dailyA){const [a,b]=e.key.split('>').map(Number);const [x1,y1]=pos(a),[x2,y2]=pos(b);const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy);
  const ux=dx/len,uy=dy/len,sx=x1+ux*26,sy=y1+uy*26,ex=x2-ux*26,ey=y2-uy*26,mx=(sx+ex)/2-uy*len*0.12,my=(sy+ey)/2+ux*len*0.12;
  const p=el('path',{d:'M'+sx+','+sy+' Q'+mx+','+my+' '+ex+','+ey,fill:'none',stroke:'var(--a)','stroke-opacity':.55,'stroke-width':1+14*Math.sqrt(e.n/max),'marker-end':'url(#arw)'},svg);
  el('title',{},p).textContent=a+'→'+b+' 回数 '+num(e.n)+'、平均 '+(e.meanDays==null?'—':e.meanDays.toFixed(1))+' 日、騰落の中央値 '+pct(e.medianReturn)}
 for(let d=1;d<=6;d++){const [x,y]=pos(d);el('circle',{cx:x,cy:y,r:22,fill:'#fff',stroke:'#333'},svg);el('text',{x,y:y+6,'text-anchor':'middle','font-size':18},svg).textContent=d}
 const by=Object.fromEntries(RESULT.dailyA.map(e=>[e.key,e]));let t='<table><caption>行 = 移る前 (a)、列 = 移った先 (b)。回数 / 平均日数 / 騰落の中央値</caption><tr><th>a＼b</th>'+[1,2,3,4,5,6].map(b=>'<th>'+b+'</th>').join('')+'</tr>';
 for(let a=1;a<=6;a++)t+='<tr><th>'+a+'</th>'+[1,2,3,4,5,6].map(b=>{const e=by[a+'>'+b];return'<td>'+(e?num(e.n)+'<br>'+(e.meanDays==null?'—':e.meanDays.toFixed(1))+' 日<br>'+pct(e.medianReturn):'—')+'</td>'}).join('')+'</tr>';
 document.getElementById('ringTable').innerHTML=t+'</table>'}
function summary(){const o=J.outcomes;const r=o.RETURNED/J.total;
 document.getElementById('summary').innerHTML='<p>旅の数 '+num(J.total)+' (出た日 '+J.firstExit+' 〜 '+J.lastExit+')。戻った割合 '+pct(r)+'。</p><table><tr><th>終わり方</th><th>件数</th><th>割合</th></tr>'+
  Object.keys(OUT).map(k=>'<tr><td class="k">'+OUT[k]+'</td><td>'+num(o[k])+'</td><td>'+pct(o[k]/J.total)+'</td></tr>').join('')+'</table><p>出た年ごとの旅の数: '+Object.entries(J.byYear).map(([y,n])=>y+' '+num(n)).join('、')+'</p>';
 const h=J.daysToReturn;const labels=h.bins.map((u,i)=>i===0?'1':(h.bins[i-1]+1===u?''+u:(h.bins[i-1]+1)+'〜'+u)).concat([(h.bins.at(-1)+1)+'〜']);const tot=h.histogram.reduce((a,b)=>a+b,0)||1;
 const hs=document.getElementById('hist');const f=frame(hs,[0,labels.length],[0,Math.max(...h.histogram)/tot*1.1],{t:'戻るまでの日数 (売買の日)',ticks:labels.map((_,i)=>i+0.5),f:v=>labels[Math.round(v-0.5)]},{t:'割合',f:v=>(v*100).toFixed(1)+'%'});
 h.histogram.forEach((n,i)=>{const v=n/tot;const b=el('rect',{x:f.x(i)+1,y:f.y(v),width:f.x(i+1)-f.x(i)-2,height:f.y(0)-f.y(v),fill:'var(--a)','fill-opacity':.55},hs);el('title',{},b).textContent=labels[i]+' 日: '+num(n)+' 件'});
 const k=J.kaplanMeier;const ks=document.getElementById('km');const g=frame(ks,[0,k.t.at(-1)||1],[0,1],{t:'出た日からの日数 (売買の日)',f:v=>v.toFixed(0)},{t:'まだ戻っていない割合',f:v=>(v*100).toFixed(0)+'%'});
 el('polyline',{points:[[g.x(0),g.y(1)],...k.t.map((t,i)=>[g.x(t),g.y(k.survival[i])])].map(p=>p.join(',')).join(' '),fill:'none',stroke:'var(--a)','stroke-width':2},ks);
 const mark=[20,60,120,250,500].filter(t=>t<=k.t.length);el('text',{x:g.W-g.m.r-4,y:g.m.t+12,'font-size':11,'text-anchor':'end'},ks).textContent=mark.map(t=>t+' 日 '+pct(k.survival[t-1])+' (残り '+num(k.atRisk[t-1])+' 件)').join('、');
 const w=J.worst;document.getElementById('worst').innerHTML='<table><caption>途中でいちばん悪くなった状態: ステージ 4 の桁の数の最大</caption><tr><th>4 の桁の数</th>'+[0,1,2,3,4,5,6].map(c=>'<th>'+c+'</th>').join('')+'</tr><tr><td class="k">すべての旅</td>'+w.all.map(n=>'<td>'+num(n)+'<br>'+pct(n/J.total)+'</td>').join('')+
  '</tr><tr><td class="k">戻った旅</td>'+w.returned.map(n=>'<td>'+num(n)+'<br>'+pct(n/o.RETURNED)+'</td>').join('')+'</tr></table><p>444444 まで落ちた旅: すべての旅の '+pct(w.all[6]/J.total)+'、戻った旅の '+pct(w.returned[6]/o.RETURNED)+'。</p>'+
  '<table><caption>いちばん悪い状態としてよく出た 6 桁 (上位 10、すべての旅)</caption><tr><th>6 桁</th><th>件数</th><th>割合</th></tr>'+w.top.map(([c,n])=>'<tr><td class="k">'+c+'</td><td>'+num(n)+'</td><td>'+pct(n/J.total)+'</td></tr>').join('')+'</table>';
 const d=J.daysToReturn.quantiles;document.getElementById('quant').innerHTML='<table><caption>旅の間の最大の下落 (出た日の次の日から終わりの日までの安値の最小 ÷ 出た日の終値 − 1) と、戻ったときの騰落</caption>'+QH+
  qrow('最大の下落: 戻った旅',J.maxDrawdown.returned)+qrow('最大の下落: 戻らなかった旅',J.maxDrawdown.notReturned)+qrow('最大の下落: すべて',J.maxDrawdown.all)+qrow('戻ったときの騰落 (戻った日の終値 ÷ 出た日の終値 − 1)',J.returnAtBack)+
  '</table><p>戻るまでの日数 (戻った旅): 10% '+d.q10+'、25% '+d.q25+'、中央値 '+d.q50+'、75% '+d.q75+'、90% '+d.q90+' 日。</p>'}
function band(svg,p,color,f,dash){const pts=(k)=>p[k].map((v,i)=>Number.isFinite(v)?[f.x(i),f.y(v)]:null).filter(Boolean);
 if(!dash){const hi=pts('q75'),lo=pts('q25').reverse();el('polygon',{points:[...hi,...lo].map(q=>q.join(',')).join(' '),fill:color,'fill-opacity':.18},svg)}
 el('polyline',{points:pts('q50').map(q=>q.join(',')).join(' '),fill:'none',stroke:color,'stroke-width':dash?1.5:2,'stroke-dasharray':dash?'4 3':''},svg)}
function types(){const T=J.types;document.getElementById('types').innerHTML='<p>戻った旅の型は '+num(T.distinct)+' 種類。上位 20 で戻った旅の '+pct(T.coveredByTop/J.outcomes.RETURNED)+'。</p><table><tr><th>順位</th><th>型</th><th>件数</th><th>戻るまでの日数 (中央値)</th><th>戻ったときの騰落 25% / 中央値 / 75%</th></tr>'+
  T.top.map((t,i)=>'<tr><td>'+(i+1)+'</td><td class="k">'+t.key+'</td><td>'+num(t.n)+'</td><td>'+t.days.q50+'</td><td>'+pct(t.returnAtBack.q25)+' / '+pct(t.returnAtBack.q50)+' / '+pct(t.returnAtBack.q75)+'</td></tr>').join('')+'</table>';
 const box=document.getElementById('typeFigs');box.innerHTML='';const all=J.paths.all;
 T.top.forEach((t,i)=>{const fig=document.createElement('figure');fig.innerHTML='<figcaption>'+(i+1)+'. '+t.key+' ('+num(t.n)+' 件)</figcaption>';const svg=el('svg',{class:'small'},fig);box.appendChild(fig);
  const vals=[...t.path.q25,...t.path.q75,...all.q50].filter(Number.isFinite);const f=frame(svg,[0,all.q50.length-1],extent(vals,0.05),{t:'出た日からの日数',f:v=>v.toFixed(0)},{t:'変化',f:P.f});zero(svg,f,true);
  band(svg,all,'#7a8496',f,true);band(svg,t.path,'var(--a)',f,false);const m=t.days.q50;if(m<=all.q50.length-1)el('line',{x1:f.x(m),x2:f.x(m),y1:f.m.t,y2:f.H-f.m.b,stroke:'var(--b)'},svg)})}
function sankey(){const svg=document.getElementById('sankey');svg.innerHTML='';const S2=J.sankey;const W=svg.clientWidth||900,H=680,top=24,bottom=10,nodeW=10,gap=4;
 const cols=[{'111111':J.total},...S2.steps];const term=new Set(['戻った','途切れ','データの終わり','売買の終わり']);const xs=cols.map((_,k)=>20+k*(W-160)/(cols.length-1));
 const scale=(H-top-bottom-gap*12)/J.total;const nodes=cols.map((col,k)=>{const keys=Object.keys(col).sort((a,b)=>(term.has(a)-term.has(b))||((a==='その他')-(b==='その他'))||col[b]-col[a]);let y=top;
  return Object.fromEntries(keys.map(key=>{const n={y,h:Math.max(1,col[key]*scale),out:0,in:0,n:col[key]};y+=n.h+gap;return[key,n]}))});
 const order=([k,f,t])=>[k,nodes[k][f]?nodes[k][f].y:0,nodes[k+1][t]?nodes[k+1][t].y:0];const links=[...S2.links].sort((p,q)=>{const x=order(p),y=order(q);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2]});
 for(const [k,from,to,n] of links){const a=nodes[k][from],b=nodes[k+1][to];if(!a||!b)continue;const h=n*scale,y1=a.y+a.out+h/2,y2=b.y+b.in+h/2;a.out+=h;b.in+=h;const x1=xs[k]+nodeW,x2=xs[k+1],c=(x1+x2)/2;
  const p=el('path',{d:'M'+x1+','+y1+' C'+c+','+y1+' '+c+','+y2+' '+x2+','+y2,fill:'none',stroke:term.has(to)?'var(--b)':'var(--a)','stroke-opacity':.3,'stroke-width':Math.max(1,h)},svg);el('title',{},p).textContent=from+' → '+to+': '+num(n)+' 件'}
 nodes.forEach((col,k)=>{el('text',{x:xs[k],y:14,'font-size':11},svg).textContent=k===0?'出る前':k+' 歩目';for(const [key,n] of Object.entries(col)){const r=el('rect',{x:xs[k],y:n.y,width:nodeW,height:n.h,fill:term.has(key)?'var(--b)':'#333'},svg);el('title',{},r).textContent=key+' '+num(n.n)+' 件 ('+pct(n.n/J.total)+')';
  if(n.h>=8)el('text',{x:xs[k]+nodeW+3,y:n.y+n.h/2+4,'font-size':10},svg).textContent=key+' '+pct(n.n/J.total)}})}
function verify(){const v=RESULT.verification;document.getElementById('verify').innerHTML='<p>'+v.note+' 銘柄 '+num(v.tickers)+'、行 '+num(v.rows)+'、6 桁が決まる行 '+num(v.validStageRows)+'、区間 '+num(v.validBlocks)+'、状態の変化 '+num(v.stateChanges)+'。</p><p>読んだもの: Discovery の元データ (sha256 '+RESULT.inputs.manifestSourceSha+')、E039 events.sqlite (sha256 '+RESULT.inputs.eventsSha+')。</p>';
 const c=RESULT.counts;document.getElementById('counts').innerHTML='<table><tr><th>項目</th><th>件数</th></tr>'+Object.keys(c).sort().map(k=>'<tr><td class="k">'+k+'</td><td>'+num(c[k])+'</td></tr>').join('')+'</table><p>journeys.excludedGap.* = 10 営業日を超える空白がある旅 (終わり方ごと)、dailyA.excludedGap = 同じく日A の滞在、dailyA.leftCensoredStays = 日数と騰落から除いた、区間の初めから始まる滞在。</p>'}
function draw(){ring();summary();types();sankey();verify()}window.onresize=draw;draw();
`
