// Trigger Discovery 現在・単日時点 Design Lab のCSS。クラスは tdl- プレフィックスで隔離する。
export const TDL_CSS = `
.tdl{--brand:#1d4f91;--brand-d:#143a6e;--brand-l:#e8f0fb;--bd:#d3dae5;--bd-s:#e6ebf2;--tx:#0f172a;--tx2:#475569;--tx3:#64748b;--bg:#f4f6fa;--sf:#fff;--ok:#0f766e;--warn:#92400e;--err:#b91c1c;--ctl:40px;--row:42px;
 font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",system-ui,sans-serif;color:var(--tx);background:var(--bg);font-size:13px;line-height:1.45;height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden;position:relative}
.tdl *{box-sizing:border-box}
.tdl button,.tdl select,.tdl input{font:inherit;color:inherit}
.tdl button{cursor:pointer}
.tdl .tdl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.tdl .tdl-toggle{position:absolute;opacity:0;pointer-events:none}
.tdl-top{background:var(--sf);border-bottom:1px solid var(--bd);flex:none}
.tdl-head{display:flex;align-items:center;gap:16px;padding:8px 20px;border-bottom:1px solid var(--bd-s);min-height:52px}
.tdl-title{margin:0;font-size:18px;font-weight:700;white-space:nowrap}
.tdl-eyebrow{font-size:12px;color:var(--tx3);letter-spacing:.04em}
.tdl-modes{display:flex;gap:2px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:2px}
.tdl-mode{min-height:34px;padding:0 14px;border:0;border-radius:6px;background:transparent;font-weight:600;font-size:13px;color:var(--tx2);white-space:nowrap}
.tdl-mode[aria-current=page]{background:var(--brand-d);color:#fff}
.tdl-mode[disabled]{cursor:not-allowed;opacity:.8}
.tdl-latest{margin-left:auto;display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--tx3);white-space:nowrap}
.tdl-latest b{color:var(--tx2);font-weight:600;font-variant-numeric:tabular-nums}
.tdl-saved{display:flex;align-items:center;gap:8px;padding:6px 20px;border-bottom:1px solid var(--bd-s);flex-wrap:wrap}
.tdl-saved-label{display:inline-flex;gap:6px;align-items:center;font-weight:700;font-size:13px;white-space:nowrap}
.tdl-select{height:var(--ctl);border:1px solid var(--bd);border-radius:6px;background:#fff;padding:0 28px 0 10px;font-size:13px;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23475569' stroke-width='1.6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;min-width:0}
.tdl-saved .tdl-select{width:280px;max-width:100%}
.tdl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--ctl);padding:0 12px;border:1px solid var(--bd);border-radius:6px;background:#fff;font-size:13px;font-weight:600;color:var(--tx2);white-space:nowrap;text-decoration:none}
.tdl-btn:hover{border-color:var(--brand);color:var(--brand)}
.tdl-btn[disabled]{opacity:.45;cursor:not-allowed}
.tdl-btn.tdl-icon{width:var(--ctl);padding:0}
.tdl-btn.tdl-primary{background:var(--brand);border-color:var(--brand);color:#fff}
.tdl-btn.tdl-primary:hover{background:var(--brand-d);color:#fff}
.tdl-btn.tdl-primary[disabled]{opacity:.75}
.tdl-btn.tdl-ghost{border-color:transparent;background:transparent;color:var(--brand)}
.tdl-active{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--tx2);min-width:0}
.tdl-active-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tdl-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:4px;background:var(--bg);border:1px solid var(--bd-s);font-size:12px;font-weight:600;color:var(--tx2);white-space:nowrap}
.tdl-tag.warn{background:#fef3c7;border-color:#fde68a;color:var(--warn)}
.tdl-saved-actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.tdl-saved-msg{width:100%;font-size:12px;color:var(--tx3);margin:0}
.tdl-bar{display:grid;grid-template-columns:minmax(150px,1.1fr) minmax(104px,.8fr) minmax(86px,.6fr) minmax(86px,.6fr) minmax(120px,.8fr) auto auto;gap:10px;align-items:end;padding:10px 20px 12px}
.tdl-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.tdl-field>.tdl-lab{display:flex;justify-content:space-between;align-items:center;gap:4px;font-size:12px;font-weight:600;color:var(--tx2);min-height:18px}
.tdl-lab a{font-weight:600;color:var(--brand);font-size:12px;text-decoration:none}
.tdl-input{display:flex;align-items:center;height:var(--ctl);border:1px solid var(--bd);border-radius:6px;background:#fff;padding:0 10px;gap:4px}
.tdl-input:focus-within{border-color:var(--brand);box-shadow:0 0 0 2px #c7dbf5}
.tdl-input input{border:0;outline:0;background:transparent;min-width:0;width:100%;font-size:14px;font-variant-numeric:tabular-nums;padding:0;height:100%}
.tdl-input .tdl-suf{font-size:12px;color:var(--tx3);white-space:nowrap}
.tdl-input.err{border-color:var(--err)}
.tdl-field.tdl-wide{min-width:150px}
.tdl-bar .tdl-btn,.tdl-bar .tdl-search{height:var(--ctl)}
.tdl-search{min-width:150px;font-size:14px}
.tdl-badge{display:inline-grid;place-items:center;min-width:20px;height:20px;border-radius:10px;background:var(--brand);color:#fff;font-size:12px;font-weight:700;padding:0 5px}
.tdl-spin{animation:tdl-rot 1s linear infinite}
@keyframes tdl-rot{to{transform:rotate(360deg)}}
.tdl-compact{display:none}
.tdl-note{padding:0 20px 8px;margin:0;font-size:12px;color:var(--tx3)}
.tdl-main{flex:1;min-height:0;display:flex;flex-direction:column}
.tdl-sum{background:var(--sf);border-bottom:1px solid var(--bd);padding:10px 20px;flex:none}
.tdl-sum-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 18px}
.tdl-count{display:inline-flex;align-items:baseline;gap:4px}
.tdl-count b{font-size:28px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.tdl-count span{font-size:13px;color:var(--tx2);font-weight:600}
.tdl-kv{display:inline-flex;gap:5px;align-items:baseline;font-size:13px;color:var(--tx2)}
.tdl-kv i{font-style:normal;font-size:12px;color:var(--tx3)}
.tdl-kv b{font-weight:700;font-variant-numeric:tabular-nums;color:var(--tx)}
.tdl-resolve{display:inline-flex;gap:6px;align-items:center;padding:2px 8px;border-radius:5px;background:var(--brand-l);font-size:12.5px;color:var(--brand-d);font-variant-numeric:tabular-nums}
.tdl-resolve b{font-weight:700}
.tdl-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}
.tdl-chip{display:inline-flex;align-items:center;min-height:26px;padding:0 9px;border-radius:13px;border:1px solid var(--bd);background:#fff;font-size:12.5px;font-weight:600;color:var(--tx2);white-space:nowrap;cursor:pointer}
.tdl-chip.fixed{background:var(--bg);border-style:dashed;color:var(--tx3);cursor:default}
.tdl-chip:not(.fixed):hover{border-color:var(--brand);color:var(--brand)}
.tdl-chips-label{font-size:12px;font-weight:700;color:var(--tx3);margin-right:2px}
.tdl-funnel{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:12px;color:var(--tx3);font-variant-numeric:tabular-nums;align-items:center}
.tdl-funnel b{color:var(--tx2);font-weight:700}
.tdl-funnel .arrow{color:var(--bd)}
.tdl-funnel .stale b{color:var(--warn)}
.tdl-funnel-d{display:none;margin-top:6px;font-size:12px;color:var(--tx3)}
.tdl-funnel-d summary{cursor:pointer;font-weight:700;color:var(--brand);min-height:28px;display:flex;align-items:center}
.tdl-funnel-d p{margin:2px 0;display:flex;flex-wrap:wrap;gap:4px 12px}
.tdl-tools{display:flex;align-items:center;gap:10px;padding:8px 20px;background:var(--sf);border-bottom:1px solid var(--bd);flex:none;position:relative}
.tdl-seg{display:flex;gap:2px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:2px;overflow-x:auto;scrollbar-width:none}
.tdl-seg button{min-height:calc(var(--ctl) - 8px);padding:0 11px;border:0;border-radius:6px;background:transparent;font-size:13px;font-weight:600;color:var(--tx2);white-space:nowrap;display:inline-flex;gap:6px;align-items:center}
.tdl-seg button small{font-size:12px;font-weight:600;color:var(--tx3);font-variant-numeric:tabular-nums}
.tdl-seg button[aria-pressed=true]{background:#fff;box-shadow:0 0 0 1px var(--brand);color:var(--brand-d)}
.tdl-seg button[aria-pressed=true] small{color:var(--brand-d)}
.tdl-seg button[disabled]{opacity:.5}
.tdl-tools .tdl-sp{margin-left:auto}
.tdl-sort{display:none}
.tdl-pop{position:relative}
.tdl-pop summary{list-style:none;cursor:pointer}
.tdl-pop summary::-webkit-details-marker{display:none}
.tdl-pop-body{position:absolute;z-index:30;top:calc(100% + 6px);left:0;width:min(420px,86vw);background:#fff;border:1px solid var(--bd);border-radius:10px;box-shadow:0 10px 30px rgba(15,23,42,.18);padding:12px}
.tdl-scroll{flex:1;min-height:0;overflow:auto;background:var(--sf);-webkit-overflow-scrolling:touch}
.tdl-table{border-collapse:separate;border-spacing:0;width:100%;min-width:1330px;font-size:13px}
.tdl-table th{position:sticky;top:0;z-index:5;background:#eef2f7;text-align:left;font-size:12px;font-weight:700;color:var(--tx2);padding:0 8px;height:40px;border-bottom:1px solid var(--bd);white-space:nowrap}
.tdl-table th.r,.tdl-table td.r{text-align:right}
.tdl-table th.c,.tdl-table td.c{text-align:center}
.tdl-table td{height:var(--row);padding:0 8px;border-bottom:1px solid var(--bd-s);background:#fff;white-space:nowrap;font-variant-numeric:tabular-nums}
.tdl-table tbody tr:hover td{background:#f5f8fd}
.tdl-table .stk{position:sticky;left:0;z-index:6;box-shadow:6px 0 8px -7px rgba(15,23,42,.35)}
.tdl-table th.stk{z-index:8}
.tdl-table td.gs,.tdl-table th.gs{border-left:1px solid var(--bd-s)}
.tdl-sortbtn{display:inline-flex;align-items:center;gap:3px;border:0;background:transparent;padding:0;min-height:36px;font-weight:700;font-size:12px;color:var(--tx2);white-space:nowrap}
.tdl-sortbtn[aria-pressed=true]{color:var(--brand-d)}
.tdl-sortbtn .ar{font-size:11px;color:var(--tx3);opacity:.7}
.tdl-sortbtn[aria-pressed=true] .ar{color:var(--brand);opacity:1}
.tdl-stock{display:block;text-decoration:none;color:inherit;line-height:1.25;min-width:0}
.tdl-stock b{display:block;font-size:14px;font-weight:700}
.tdl-stock span{display:block;font-size:12px;color:var(--tx2);max-width:150px;overflow:hidden;text-overflow:ellipsis}
.tdl-stale{display:inline-flex;gap:3px;align-items:center;font-size:12px;font-weight:600;color:var(--warn);background:#fef3c7;border-radius:4px;padding:0 5px;margin-top:1px}
.tdl-st{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:5px;font-size:12px;font-weight:700;border:1px solid}
.tdl-st::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.tdl-st.IN_ZONE{color:#065f46;background:#d1fae5;border-color:#a7f3d0}
.tdl-st.NEAR{color:#92400e;background:#fef3c7;border-color:#fde68a}
.tdl-st.APPROACHING{color:#075985;background:#e0f2fe;border-color:#bae6fd}
.tdl-st.BELOW_ZONE{color:#475569;background:#f1f5f9;border-color:#e2e8f0}
.tdl-score{display:inline-flex;flex-direction:column;align-items:flex-end;gap:2px;min-width:44px;border:0;background:transparent;padding:2px 0;min-height:32px;justify-content:center}
.tdl-score b{font-size:15px;font-weight:700;line-height:1}
.tdl-score i{display:block;width:44px;height:4px;border-radius:2px;background:#e2e8f0;overflow:hidden}
.tdl-score i s{display:block;height:100%;background:var(--brand);text-decoration:none}
.tdl-zone{font-weight:700;font-size:14px}
.tdl-pos{color:var(--tx)}
.tdl-neg{color:var(--err)}
.tdl-mute{color:var(--tx2)}
.tdl-mkt{font-size:12px;color:var(--tx2);background:var(--bg);border:1px solid var(--bd-s);border-radius:4px;padding:1px 6px}
.tdl-stages{display:inline-grid;grid-template-columns:repeat(6,26px);gap:3px}
.tdl-sg{display:grid;place-items:center;height:24px;border-radius:4px;font-size:12px;font-weight:700;color:#fff}
.tdl-sg.s1{background:#c4d3e6;color:#1e3a5f}.tdl-sg.s2{background:#9db8d9;color:#122c4d}.tdl-sg.s3{background:#6f97c6}.tdl-sg.s4{background:#3f73b0}.tdl-sg.s5{background:#27568f}.tdl-sg.s6{background:#16365f}
.tdl-stages.hd span{font-size:12px;font-weight:600;color:var(--tx2);text-align:center}
.tdl-sg.s0{background:#fff;color:var(--tx3);border:1px dashed var(--bd)}
.tdl-star{width:36px;height:36px;display:inline-grid;place-items:center;border:0;background:transparent;border-radius:6px;color:var(--tx3)}
.tdl-star.on{color:#d97706}
.tdl-spark{display:block}
.tdl-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 20px;background:var(--sf);border-top:1px solid var(--bd);flex:none;font-size:13px;color:var(--tx2)}
.tdl-foot .tdl-sp{margin-left:auto}
.tdl-pager{display:inline-flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}
.tdl-cards{display:none}
.tdl-card{display:grid;gap:8px;padding:12px 14px;border-bottom:1px solid var(--bd-s);background:#fff}
.tdl-card-h{display:flex;align-items:center;gap:8px}
.tdl-card-h .tdl-stock{flex:1}
.tdl-card-h .tdl-stock span{max-width:none}
.tdl-card-s{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.tdl-card-s div{display:flex;flex-direction:column;min-width:0}
.tdl-card-s i{font-style:normal;font-size:12px;color:var(--tx3)}
.tdl-card-s b{font-size:14px;font-variant-numeric:tabular-nums}
.tdl-card-f{display:flex;align-items:center;justify-content:space-between;gap:8px}
.tdl-state{flex:1;min-height:0;overflow:auto;background:var(--sf);padding:32px 20px 40px}
.tdl-panel{max-width:760px;margin:0 auto;display:grid;gap:16px}
.tdl-panel h2{margin:0;font-size:20px}
.tdl-panel p{margin:0;color:var(--tx2);font-size:14px}
.tdl-ico{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--brand-l);color:var(--brand)}
.tdl-ico.err{background:#fee2e2;color:var(--err)}
.tdl-ico.warn{background:#fef3c7;color:var(--warn)}
.tdl-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0;padding:0;list-style:none}
.tdl-steps li{border:1px solid var(--bd-s);border-radius:10px;padding:10px 12px;font-size:13px;color:var(--tx2);background:var(--bg)}
.tdl-steps li b{display:block;color:var(--tx);margin-bottom:2px;font-size:13px}
.tdl-quick{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.tdl-quick li{display:flex;align-items:center;gap:10px;border:1px solid var(--bd);border-radius:10px;padding:8px 12px;min-height:52px;background:#fff}
.tdl-quick li div{flex:1;min-width:0}
.tdl-quick li b{display:block;font-size:14px}
.tdl-quick li span{font-size:12px;color:var(--tx3)}
.tdl-h3{font-size:12px;font-weight:700;color:var(--tx3);letter-spacing:.04em;margin:0}
.tdl-alert{display:flex;gap:12px;align-items:flex-start;border:1px solid #fecaca;border-left:4px solid var(--err);background:#fef2f2;border-radius:8px;padding:12px 14px;color:#7f1d1d}
.tdl-alert b{display:block;font-size:15px;margin-bottom:2px}
.tdl-alert p{color:#7f1d1d;font-size:13px}
.tdl-alert code{font-size:12px;background:#fee2e2;padding:1px 5px;border-radius:4px}
.tdl-actions{display:flex;flex-wrap:wrap;gap:8px}
.tdl-suggest{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.tdl-suggest li{display:flex;gap:10px;align-items:center;border:1px solid var(--bd);border-radius:10px;padding:8px 12px;background:#fff;min-height:52px}
.tdl-suggest li div{flex:1;font-size:13px;color:var(--tx2)}
.tdl-suggest li b{color:var(--tx)}
.tdl-drop{display:grid;gap:6px}
.tdl-drop-row{display:grid;grid-template-columns:150px 1fr 70px;gap:8px;align-items:center;font-size:12.5px;color:var(--tx2)}
.tdl-drop-row i{display:block;height:8px;border-radius:4px;background:#e2e8f0;overflow:hidden}
.tdl-drop-row i s{display:block;height:100%;background:var(--brand);text-decoration:none}
.tdl-drop-row b{text-align:right;font-variant-numeric:tabular-nums;color:var(--tx)}
.tdl-loadline{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--brand-l);border-bottom:1px solid #c7dbf5;color:var(--brand-d);font-weight:600;flex:none}
.tdl-skel{height:48px;display:grid;grid-template-columns:150px 80px 60px 90px 80px 80px 130px 1fr;gap:14px;align-items:center;padding:0 16px;border-bottom:1px solid var(--bd-s)}
.tdl-skel s{display:block;height:12px;border-radius:6px;background:linear-gradient(90deg,#e8edf4,#f4f6fa,#e8edf4);background-size:200% 100%;animation:tdl-sh 1.4s linear infinite;text-decoration:none}
@keyframes tdl-sh{to{background-position:-200% 0}}
.tdl-scrim{position:absolute;inset:0;background:rgba(15,23,42,.38);z-index:40;opacity:0;visibility:hidden;transition:opacity .18s}
.tdl-drawer{position:absolute;z-index:50;background:#fff;display:flex;flex-direction:column;visibility:hidden;transition:transform .2s,visibility .2s;top:0;bottom:0;right:0;width:460px;max-width:100%;transform:translateX(100%);box-shadow:-12px 0 30px rgba(15,23,42,.2)}
.tdl .tdl-toggle[id=tdl-drawer]:checked~.tdl-scrim{opacity:1;visibility:visible}
.tdl .tdl-toggle[id=tdl-drawer]:checked~.tdl-drawer{transform:none;visibility:visible}
.tdl-dh{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--bd);flex:none}
.tdl-dh h2{margin:0;font-size:16px;flex:1}
.tdl-grab{display:none;width:44px;height:5px;border-radius:3px;background:#cbd5e1;margin:8px auto 0}
.tdl-db{flex:1;overflow:auto;padding:4px 16px 16px;-webkit-overflow-scrolling:touch}
.tdl-sec{padding:14px 0;border-bottom:1px solid var(--bd-s);display:grid;gap:10px}
.tdl-sec:last-child{border-bottom:0}
.tdl-sec h3{margin:0;font-size:14px;display:flex;align-items:center;gap:6px}
.tdl-sec h3 small{font-weight:500;color:var(--tx3);font-size:12px;margin-left:auto}
.tdl-g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tdl-sw{display:flex;align-items:flex-start;gap:10px;min-height:44px;cursor:pointer}
.tdl-sw input{width:22px;height:22px;margin:2px 0 0;accent-color:var(--brand);flex:none}
.tdl-sw b{display:block;font-size:14px}
.tdl-sw span{font-size:12px;color:var(--tx3)}
.tdl-mk{display:flex;flex-wrap:wrap;gap:6px}
.tdl-mk label{display:inline-flex;align-items:center;gap:6px;min-height:var(--ctl);padding:0 12px;border:1px solid var(--bd);border-radius:8px;font-size:13px;font-weight:600;color:var(--tx2);cursor:pointer;background:#fff}
.tdl-mk label small{font-size:12px;color:var(--tx3);font-weight:600}
.tdl-mk label.on{border-color:var(--brand);background:var(--brand-l);color:var(--brand-d)}
.tdl-mk input{position:absolute;opacity:0;width:1px;height:1px}
.tdl-axes{display:grid;gap:6px}
.tdl-axis{display:flex;align-items:center;gap:6px}
.tdl-axis>span{width:28px;font-size:12px;font-weight:700;color:var(--tx2)}
.tdl-axis button{width:34px;height:34px;border-radius:6px;border:1px solid var(--bd);background:#fff;font-size:13px;font-weight:600;color:var(--tx2);font-variant-numeric:tabular-nums;padding:0}
.tdl-axis button[aria-pressed=true]{background:var(--brand-l);border-color:var(--brand);color:var(--brand-d)}
.tdl-df{display:flex;gap:8px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--bd);flex:none;background:#fff}
.tdl-df .tdl-primary{flex:1}
.tdl-df .tdl-note2{font-size:12px;color:var(--tx3)}
@media (max-width:1100px){
 .tdl{--ctl:44px;--row:48px}
 .tdl-head,.tdl-saved,.tdl-sum,.tdl-tools,.tdl-foot,.tdl-note,.tdl-loadline{padding-left:16px;padding-right:16px}
 .tdl-bar{padding:10px 16px 12px}
 .tdl-head{padding-top:6px;padding-bottom:6px;min-height:0}
 .tdl-eyebrow{display:none}
 .tdl-drawer{top:auto;left:0;right:0;bottom:0;width:100%;max-height:82%;border-radius:16px 16px 0 0;transform:translateY(100%);box-shadow:0 -12px 30px rgba(15,23,42,.25)}
 .tdl-grab{display:block}
 .tdl-funnel{display:none}.tdl-funnel-d{display:block}
 .tdl-latest{display:none}
 .tdl-saved .tdl-select{width:240px}
 .tdl-btn.tdl-hide-m span{display:none}
 .tdl-btn.tdl-hide-m{width:var(--ctl);padding:0}
 .tdl-saved,.tdl-bar,.tdl-note{display:none}
 .tdl .tdl-toggle[id=tdl-bar]:checked~.tdl-top .tdl-saved{display:flex}
 .tdl .tdl-toggle[id=tdl-bar]:checked~.tdl-top .tdl-bar{display:grid}
 .tdl .tdl-toggle[id=tdl-bar]:checked~.tdl-top .tdl-note{display:block}
 .tdl-compact{display:flex;align-items:center;gap:8px;padding:6px 16px;min-height:56px}
 .tdl .tdl-toggle[id=tdl-bar]:checked~.tdl-top .tdl-compact{display:none}
 .tdl-compact-t{flex:1;min-width:0;font-size:13px;color:var(--tx2);line-height:1.35}
 .tdl-compact-t b{color:var(--tx)}
 .tdl-compact-t div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
}
@media (max-width:900px){
 .tdl-pop{position:static}
 .tdl-tools>.tdl-sp{display:none}
 .tdl-pop-body{left:12px;right:12px;width:auto;max-width:440px}
 .tdl-bar{grid-template-columns:repeat(12,1fr)}
 .tdl-bar .tdl-f-asof{grid-column:span 4}.tdl-bar .tdl-f-tf{grid-column:span 4}.tdl-bar .tdl-f-dist{grid-column:span 4}
 .tdl-bar .tdl-f-ma1{grid-column:span 3}.tdl-bar .tdl-f-ma2{grid-column:span 3}.tdl-bar .tdl-f-detail{grid-column:span 3}.tdl-bar .tdl-f-go{grid-column:span 3}
}
@media (min-width:1101px) and (max-width:1280px){
 .tdl-bar{grid-template-columns:minmax(150px,1.1fr) minmax(104px,.8fr) minmax(80px,.6fr) minmax(80px,.6fr) minmax(110px,.8fr) auto auto;padding-left:16px;padding-right:16px}
}
@media (max-width:700px){
 .tdl{--row:auto}
 .tdl-head{flex-wrap:wrap;gap:6px 10px;padding:6px 12px;min-height:0}
 .tdl-title{font-size:17px}
 .tdl-eyebrow{display:none}
 .tdl-modes{width:100%}
 .tdl-modes .tdl-mode{flex:1;padding:0 6px;min-height:40px}
 .tdl-saved,.tdl-bar,.tdl-note{display:none}
 .tdl .tdl-toggle[id=tdl-bar]:checked~.tdl-top .tdl-saved{display:flex;padding:8px 12px}
 .tdl .tdl-toggle[id=tdl-bar]:checked~.tdl-top .tdl-bar{display:grid;padding:8px 12px 10px}
 .tdl .tdl-toggle[id=tdl-bar]:checked~.tdl-top .tdl-note{display:block;padding:0 12px 8px}
 .tdl-compact{display:flex;align-items:center;gap:8px;padding:6px 12px;min-height:56px}
 .tdl .tdl-toggle[id=tdl-bar]:checked~.tdl-top .tdl-compact{display:none}
 .tdl-compact-t{flex:1;min-width:0;font-size:13px;color:var(--tx2);line-height:1.35}
 .tdl-compact-t b{color:var(--tx)}
 .tdl-compact-t div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .tdl-saved .tdl-select{width:auto;flex:1 1 0;min-width:0}
 .tdl-saved-label{display:none}
 .tdl-saved-actions{margin-left:0;width:100%;justify-content:flex-end}
 .tdl-btn.tdl-hide-m span{display:none}
 .tdl-btn.tdl-hide-m{width:var(--ctl);padding:0}
 .tdl-bar{grid-template-columns:repeat(12,1fr);gap:8px}
 .tdl-bar .tdl-f-asof{grid-column:span 7}.tdl-bar .tdl-f-tf{grid-column:span 5}
 .tdl-bar .tdl-f-ma1,.tdl-bar .tdl-f-ma2,.tdl-bar .tdl-f-dist{grid-column:span 4}
 .tdl-bar .tdl-f-detail{grid-column:span 5}.tdl-bar .tdl-f-go{grid-column:span 7}
 .tdl-sum{padding:8px 12px}
 .tdl-count b{font-size:24px}
 .tdl-chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin-left:-12px;margin-right:-12px;padding:0 12px}
 .tdl-tools{padding:6px 12px;gap:8px;flex-wrap:wrap}
 .tdl-seg{max-width:100%;flex:1 1 100%}
 .tdl-tools .tdl-sp{margin-left:0}
 .tdl-sort{display:inline-flex;flex:1}
 .tdl-sort .tdl-select{width:100%}
 .tdl-pop-body{max-width:none}
 .tdl-table{display:none}
 .tdl-cards{display:block}
 .tdl-foot{padding:6px 12px;gap:6px 10px}
 .tdl-foot .tdl-sp{margin-left:0}
 .tdl-foot{flex-wrap:nowrap;justify-content:space-between}
 .tdl-foot label{font-size:0}
 .tdl-foot .tdl-select{font-size:13px;padding-right:24px;padding-left:8px}
 .tdl-foot .tdl-btn.tdl-icon{width:40px;min-height:40px}
 .tdl-pager{gap:4px}
 .tdl-tools>.tdl-sp{display:none}
 .tdl-chips-label{display:none}
 .tdl-seg button{padding:0 8px;gap:4px}
 .tdl-state{padding:20px 14px 28px}
 .tdl-steps{grid-template-columns:1fr}
 .tdl-drawer{max-height:94%}
 .tdl-skel{grid-template-columns:90px 60px 1fr;padding:0 12px}
 .tdl-skel s:nth-child(n+4){display:none}
 .tdl-drop-row{grid-template-columns:110px 1fr 60px}
 .tdl-loadline{padding:8px 12px}
}
.tdl-hint{display:none;align-items:center;gap:4px;font-size:12px;color:var(--tx3);white-space:nowrap}
@media (max-width:1100px) and (min-width:701px){.tdl-hint{display:inline-flex}.tdl-scroll{scrollbar-width:thin;scrollbar-color:#94a3b8 #e2e8f0}.tdl-scroll::-webkit-scrollbar{height:10px}.tdl-scroll::-webkit-scrollbar-thumb{background:#94a3b8;border-radius:5px}.tdl-scroll::-webkit-scrollbar-track{background:#e2e8f0}}
.tdl label[role=button]:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.tdl-spin,.tdl-skel s{animation:none}}
`
