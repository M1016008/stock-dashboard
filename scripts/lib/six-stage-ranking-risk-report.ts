// PREREG_RANKING_RISK_20261113 (研究 C・D) の報告ページ (1 つの HTML)。図と表の部品は研究 1・2・A・B の報告ページのものを使う。
// 遷移 X→Y ごとの数字 (探索) は transitions.json と同じものをページに埋め込み、選んだ遷移だけ表にする。本番のアプリには入れない。
import { REPORT_HELPERS, REPORT_STYLE } from './six-stage-transitions-report'

const NOTICES = [
  '過去の実データによる探索の結果であり、投資判断の根拠ではない。',
  '配当を含まない株価の値動き。過去の参考値であり予測ではない。',
  '売買の手数料・値幅の不利、空売りの貸株料・逆日歩などの費用は含めていない。',
  '研究 C の 20 万株の条件は、調整後の出来高 (後の分割で大きくなった値) で判断している。その日に知り得た出来高ではなく、後に分割した銘柄ほど過去のイベントが条件を通りやすい。確認のため、分割で変わらない売買代金で絞った集計を下に載せる (判定には使わない)。',
  '売買代金の「分割で変わらない」は、J-Quants が調整後の値を返した行についてのこと。調整前の値で取り込まれた行は区別できず、そのまま使っている。',
  '研究 C の点数の区切り (20% 点・80% 点) は Discovery 全体で決めたため、各イベントの時点では知り得なかった値を使っている。そのままでは日々の銘柄判断の規則にならない。',
  '限界: 2 本の移動平均が同じ値の日は桁が決まらない。E039 はその日で区間を切るため、その日をはさむ遷移は研究 C のイベントに入らない。研究 D では、月末にその日が当たる組は ① (6 桁がすべて決まる組) に入らず、日A がその日に当たる組は ② にも入らない (PREREG_TRANSITIONS_20261111.md の「限界」)。',
]

export function renderRankingRiskReport(result: unknown, transitions: unknown = {}): string {
  const data = JSON.stringify(result).replace(/</g, '\\u003c')
  const pairs = JSON.stringify(transitions).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>おすすめ順の検証と危険の大きさ (事前登録 2026-11-13)</title><style>${REPORT_STYLE}</style></head><body>
<header><h1>おすすめ順の検証と危険の大きさ (研究 C・D)</h1><p class="sub">事前登録: research/6stage/event-path-research/PREREG_RANKING_RISK_20261113.md (日本株、Discovery 期間 2022-12-30 まで)</p>
<ul class="notice">${NOTICES.map((text) => `<li>${text}</li>`).join('')}</ul>
<div class="controls">期間 <button data-h="10">10 営業日</button><button data-h="20">20 営業日</button>
　研究 C の向き <button data-d="UP">上向き</button><button data-d="DOWN">下向き</button>
　研究 D の群 <button data-g="①">① 111111 と 444444</button><button data-g="②">② 日A の 1 と 4</button></div></header>
<main><section><h2>判定 (16 個の仮説。強い証拠 = 99.6875% の区間、弱い証拠 = 95% の区間)</h2><div id="judge"></div></section>
<section><h2>研究 C: おすすめ順の点数 (|5 日騰落率| × min(出来高倍率, 5))</h2><p>値は力の向きにそろえた騰落 (上向きはそのまま、下向きは符号を逆にしたもの)。勝率はこの値が 0 より大きい割合。</p>
<div class="grid"><figure><figcaption>③ 騰落の分布 (割合 %)</figcaption><svg id="histC"></svg></figure><figure><figcaption>④ シグナルの日からの値動きの道筋 (向きにそろえた値)</figcaption><svg id="pathC"></svg></figure></div>
<div id="tableC"></div><h3>遷移 X→Y ごと (探索)</h3><p>遷移を選ぶ (入力すると候補が出る。例: 111111&gt;211111) <input id="tkey" size="16" list="tlist"><datalist id="tlist"></datalist></p><div id="tout"></div></section>
<section><h2>研究 C の確認: 売買代金で絞った集計 (探索、段階は付けない)</h2><div id="turnover"></div></section>
<section><h2>研究 D: 月末の状態ごとの危険の大きさ</h2><div class="grid"><figure><figcaption>(a) 最大の下落率の分布 (割合 %)</figcaption><svg id="histDa"></svg></figure>
<figure><figcaption>(b) 日々の騰落率の標準偏差の分布 (割合 %)</figcaption><svg id="histDb"></svg></figure></div><div id="tableD"></div></section>
<section><h2>件数の内訳 (除外・重複・結果の無い期間)</h2><div id="counts"></div></section></main>
<script>const RESULT=${data};const PAIRS=${pairs};${REPORT_HELPERS}${SCRIPT}</script></body></html>
`
}

const SCRIPT = `
S.d='UP';S.g='①';const LV={STRONG:'強い証拠',WEAK:'弱い証拠',NONE:'差なし'};const CN=['下位 20%','中位','上位 20%'];const CC=['var(--b)','#7a8496','var(--a)'];
const DN={'①':['111111','444444'],'②':['日A 1','日A 4']};const DIRN={UP:'上向き',DOWN:'下向き'};const GN={IMPROVE:'すべて改善',DETERIORATE:'すべて悪化',MIXED:'混在'};
const iv=r=>pct(r.lower)+' 〜 '+pct(r.upper);
function htable(rows,levels){return'<table><tr><th>研究</th><th>比べるもの</th><th>測るもの</th><th>期間</th><th>差</th><th>95% 区間</th><th>99.6875% 区間</th>'+RESULT.blocks.map(b=>'<th>'+b[0]+'</th>').join('')+'<th>段階</th></tr>'+
 rows.map(r=>'<tr><td class="k">'+r.study+'</td><td class="k">'+r.label+'</td><td class="k">'+r.measureName+'</td><td>'+r.horizon+' 日</td><td>'+pct(r.difference)+'</td><td>'+iv(r.interval95)+'</td><td>'+iv(r.intervalStrong)+'</td>'+
 r.blocks.map(b=>'<td>'+pct(b.difference)+(b.sameDirection?' 同じ向き':' 同じ向きでない')+'</td>').join('')+'<td>'+(levels?LV[r.level]:'—')+'</td></tr>').join('')+'</table>'}
function judge(){document.getElementById('judge').innerHTML=htable(RESULT.hypotheses.filter(r=>r.judged),true)+'<p>研究 C の差 = 上位 20% − 下位 20%、研究 D の差 = 4 の群 − 1 の群。研究 D の値は比率 (−0.05 = −5%)。</p>'}
function studyC(){const c=RESULT.studyC.main[S.d];const f=c.figures[S.h];
 hist(document.getElementById('histC'),[0,1,2].map(g=>[CN[g],f.histogram[g],CC[g]]));bands(document.getElementById('pathC'),[2,0].map(g=>[CN[g],f.path[g],CC[g]]));
 let html='<p>区切りの値 ('+DIRN[S.d]+'): 20% 点 '+c.cut.p20.toFixed(5)+'、80% 点 '+c.cut.p80.toFixed(5)+'</p><table><tr><th>群</th><th>点数 最小</th><th>10%</th><th>25%</th><th>中央値</th><th>75%</th><th>90%</th><th>最大</th></tr>'+
  c.scoreQuantiles.map((q,g)=>'<tr><td class="k">'+CN[g]+'</td>'+(q.length?q.map(v=>'<td>'+v.toFixed(5)+'</td>').join(''):'<td colspan="7">0 件</td>')+'</tr>').join('')+'</table>';
 for(const h of [5,10,15,20])html+='<table><caption>'+DIRN[S.d]+'、'+h+' 営業日'+(h===10||h===20?'':' (探索)')+'</caption>'+HEAD+c.tables[h].map((t,g)=>row(CN[g],t.full)+Object.entries(t.blocks).map(([k,b])=>row(CN[g]+' '+k,b)).join('')).join('')+'</table>';
 html+='<details><summary>遷移の種類ごと ('+DIRN[S.d]+'、'+S.h+' 営業日、探索)</summary><table>'+HEAD+Object.entries(c.byTransitionGroup).map(([k,v])=>v[S.h].map((s,g)=>row(GN[k]+' '+CN[g],s)).join('')).join('')+'</table></details>';
 html+='<p>遷移 X→Y ごとの数字 (探索): 同じフォルダの transitions.json (結果のあるイベントが 100 件以上の '+num(RESULT.transitions.included)+' 遷移、全 '+num(RESULT.transitions.observed)+' 遷移)。</p>';
 document.getElementById('tableC').innerHTML=html;
 const t=RESULT.turnoverCheck;document.getElementById('turnover').innerHTML='<p>20 万株の条件を通る割合 p = '+pct(t.p)+'、基準の金額 (20 日平均の売買代金の (1 − p) 点) = '+num(Math.round(t.threshold))+' 円。対象 '+num(t.events)+' 件 (重複の規則の前)、集計に使ったイベント '+num(t.kept)+' 件、本集計と両方に入るもの '+num(t.inBoth)+' 件。</p>'+
  htable(RESULT.hypotheses.filter(r=>r.study==='C'&&!r.judged),false)}
const CH='<tr><th>群</th><th>件数</th><th>勝率</th><th>平均</th><th>中央値</th><th>10%</th><th>25%</th><th>75%</th><th>90%</th><th>最大の上昇幅 (中央値)</th><th>最大の下落幅 (中央値)</th></tr>';
function transition(){const key=document.getElementById('tkey').value.trim();const t=PAIRS[key];const out=document.getElementById('tout');
 if(!t){out.innerHTML='<p>'+(key?key+' は、結果のあるイベントが 100 件以上の遷移に無い。':'遷移を選ぶと、向き・群・期間ごとの数字が出る。')+'</p>';return}
 out.innerHTML=['UP','DOWN'].map(d=>'<table><caption>'+key+'、'+DIRN[d]+' (向きにそろえた値)</caption>'+CH+[0,1,2,3].map(k=>t[d][k].map((c,g)=>'<tr><td class="k">'+[5,10,15,20][k]+' 日 '+CN[g]+'</td>'+(c?[num(c[0]),...c.slice(1).map(pct)].map(v=>'<td>'+v+'</td>').join(''):'<td>0</td>'+'<td>—</td>'.repeat(9))+'</tr>').join('')).join('')+'</table>').join('')}
function rhist(svg,series,kind){const labels=kind==='a'?['<−40%',...Array.from({length:40},(_,i)=>(i-40)+'%'),'≥0%']:[...Array.from({length:40},(_,i)=>(i*0.25).toFixed(2)+'%'),'≥10%'];
 const share=series.map(s=>{const t=s[1].reduce((a,b)=>a+b,0)||1;return s[1].map(v=>v/t)});const n=labels.length;
 const f=frame(svg,[0,n],[0,Math.max(...share.flat())*1.1],{t:kind==='a'?'最大の下落率':'標準偏差',ticks:[0,Math.floor(n/4),Math.floor(n/2),Math.floor(3*n/4),n-1].map(i=>i+0.5),f:v=>labels[Math.floor(v)]},{t:'割合',f:v=>(v*100).toFixed(1)+'%'});
 series.forEach((s,i)=>{share[i].forEach((v,j)=>el('rect',{x:f.x(j),y:f.y(v),width:Math.max(1,f.x(j+1)-f.x(j)-1),height:f.y(0)-f.y(v),fill:s[2],'fill-opacity':.4},svg));
  el('text',{x:f.W-f.m.r-4,y:f.m.t+12+i*14,'font-size':11,'text-anchor':'end',fill:s[2]},svg).textContent=s[0]})}
function drow(name,x){const cell=s=>!s||!s.n?'<td>0</td><td>—</td><td>—</td><td>—</td><td>—</td>':'<td>'+num(s.n)+'</td><td>'+pct(s.q25)+'</td><td>'+pct(s.median)+'</td><td>'+pct(s.q75)+'</td><td>'+pct(s.mean)+'</td>';return'<tr><td class="k">'+name+'</td>'+cell(x.a)+cell(x.b)+'</tr>'}
const brief=(name,c)=>'<tr><td class="k">'+name+'</td>'+c.map(x=>x?'<td>'+num(x[0])+'</td>'+x.slice(1).map(v=>'<td>'+pct(v)+'</td>').join(''):'<td>0</td>'+'<td>—</td>'.repeat(4)).join('')+'</tr>';
const DH='<tr><th rowspan="2">群</th><th colspan="5">(a) 最大の下落率</th><th colspan="5">(b) 標準偏差</th></tr><tr>'+'<th>件数</th><th>25%</th><th>中央値</th><th>75%</th><th>平均</th>'.repeat(2)+'</tr>';
function studyD(){const D=RESULT.studyD;for(const kind of ['a','b']){const f=D.figures[S.h][kind];rhist(document.getElementById('histD'+kind),[[DN[S.g][0],f[S.g][0],'var(--a)'],[DN[S.g][1],f[S.g][1],'var(--b)'],['全銘柄',f.all,'#7a8496']],kind)}
 let html='<p>月末の日 '+D.monthEnds+' 個。E039 のイベントだけで状態が決まる組 '+num(D.reconcile.determined)+' 組 (2010 年以降の月末の組 '+num(D.reconcile.pairsFrom2010)+' 組) で、計算し直した 6 桁が E039 と一致した。月末ごとに計算し直した銘柄 (分割の推定で補正される所がある銘柄) '+num(D.reconcile.prefixTickers)+'。</p>';
 for(const h of [5,10,15,20]){const g=D.groups;html+='<table><caption>'+h+' 営業日'+(h===10||h===20?'':' (探索)')+'</caption>'+DH+drow('111111',g['①'][0][h])+drow('444444',g['①'][1][h])+drow('日A 1',g['②'][0][h])+drow('日A 4',g['②'][1][h])+drow('全銘柄',D.all[h])+'</table>'}
 html+='<details><summary>日A のステージごと ('+S.h+' 営業日、探索)</summary><table>'+DH+D.dailyA.map((x,i)=>drow('日A '+(i+1),x[S.h])).join('')+'</table></details>';
 html+='<details><summary>当時の市場区分ごと ('+S.h+' 営業日、探索。月末の状態には前月末の区分)</summary><table>'+DH+Object.entries(D.bySegment).map(([k,v])=>DN[S.g].map((n,i)=>drow(k+' '+n,v[S.g][i][S.h])).join('')).join('')+'</table></details>';
 html+='<details><summary>6 桁ごと ('+S.h+' 営業日、探索)</summary><table>'+DH+Object.entries(D.codes).map(([k,v])=>brief(k,v[S.h])).join('')+'</table></details>';
 html+='<h3>照合できた組だけ・照合できなかった組だけの差 (探索、段階は付けない)</h3>'+htable(RESULT.hypotheses.filter(r=>r.study==='D'&&!r.judged),false);
 document.getElementById('tableD').innerHTML=html}
function counts(){const c=RESULT.counts;document.getElementById('counts').innerHTML='<table><tr><th>項目</th><th>件数</th></tr>'+Object.keys(c).sort().map(k=>'<tr><td class="k">'+k+'</td><td>'+num(c[k])+'</td></tr>').join('')+'</table><p>C = 研究 C、T = 売買代金で絞った確認用 (T.pre = 重複の規則の前)、D = 研究 D。kept = 集計に使ったもの、excluded* = 除外、dedupDropped = 20 営業日以内の重複、missingN.* = N 営業日の結果が無いもの。</p>'}
function draw(){document.querySelectorAll('[data-h]').forEach(b=>b.classList.toggle('on',+b.dataset.h===S.h));document.querySelectorAll('[data-d]').forEach(b=>b.classList.toggle('on',b.dataset.d===S.d));document.querySelectorAll('[data-g]').forEach(b=>b.classList.toggle('on',b.dataset.g===S.g));judge();studyC();studyD();counts()}
document.querySelectorAll('[data-h]').forEach(b=>b.onclick=()=>{S.h=+b.dataset.h;draw()});document.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{S.d=b.dataset.d;draw()});document.querySelectorAll('[data-g]').forEach(b=>b.onclick=()=>{S.g=b.dataset.g;draw()});
const tk=document.getElementById('tkey');document.getElementById('tlist').innerHTML=Object.keys(PAIRS).map(k=>'<option value="'+k+'">').join('');tk.oninput=transition;
window.onresize=draw;draw();transition();`
