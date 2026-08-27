/* ============ 标准化配置 ============ */
const D = (y,m,d)=>new Date(y,m,d);
const DT = (y,mon,d)=>new Date(y,mon-1,d);   // 真实月份(1-12)构造器，避免 0-indexed 误用
const START = new Date(2026,3,13);   // 2026-04-13（周一）——提前到覆盖最早5月前的排期
const DAYS  = 1400;                   // 覆盖到 2029 年底（约 2029-12-12，含完整 2026~2029 四年）
function todayDate(){const n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate());} // 真实系统当天 0 点
let TODAY = todayDate();              // 基准日：动态取真实今天（跨天自动刷新，见 bindTodayWatch）
const DAY_W_BASE = 8;                 // 基准每天 8px
let DAY_W = 8;                        // 实际每天宽度 = 基准 × 缩放（条宽滑块联动）

/* ============ 状态字典 ============ */
const STATUS = {
  todo:   {label:'未开始', cls:'b-gray',  col:'#7d92b3'},
  doing:  {label:'进行中', cls:'b-blue',  col:'#4d80ff'},
  review: {label:'待处理', cls:'b-amber', col:'#e08c00'},
  done:   {label:'已完成', cls:'b-done', col:'#4ecba0'},
  blocked:{label:'缺失',   cls:'b-red',   col:'#f5413f'},
  overdue:{label:'逾期未完', cls:'b-amber', col:'#f59e0b'},  // v5.9 排期到期但未人工确认完成：橙色提醒
};
const STATUS_ORDER=['todo','doing','review','done','blocked'];
/* 需求生命周期状态（独立于任务段聚合状态）：
   active=正常推进（默认）；paused=暂停（保留统计，仅打标+条纹）；dropped=废弃（不计风险、自动归档、删除线灰化）。
   存于 r.state（不设/为 active 即正常）。随 snapshot 三链路持久化。 */
const RSTATE={
  active: {label:'正常', col:'#1fae5a'},
  paused: {label:'暂停', col:'#e08c00'},
  done:   {label:'已完成', col:'#4ecba0'},
  dropped:{label:'废弃', col:'#9097a0'},
};
const RSTATE_PICK=['active','paused','done','dropped'];
function reqState(r){ return (r&&r.state)||'active'; }
/* 「终态」需求：已完成 / 已废弃——均不计风险、不计产能、自动归档。区别仅在视觉与语义。 */
function reqClosed(r){ const s=reqState(r); return s==='done'||s==='dropped'; }
/* 需求名旁的状态标签：正常态只显示一个低调的下拉箭头入口；暂停/废弃态显示醒目彩色徽标。点击弹状态菜单。 */
function reqStateTag(r){
  const st=reqState(r);
  if(st==='active'){
    return `<span class="rstate-tag active editable" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();openReqStateMenu(event,'${r.id}')" title="点击设置需求状态（正常/暂停/已完成/废弃）">状态<i class="rs-caret">▾</i></span>`;
  }
  const s=RSTATE[st];
  const ic = st==='paused'?'⏸':st==='done'?'✓':'✕';
  return `<span class="rstate-tag ${st} editable" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();openReqStateMenu(event,'${r.id}')" title="当前：${s.label}（点击更改）">${ic} ${s.label}</span>`;
}
const MSTATUS={
  on:  {label:'在岗', col:'#34c759'},
  busy:{label:'忙碌', col:'#ff9f0a'},
  leave:{label:'请假',col:'#a8adb5'},
  out: {label:'外出', col:'#3370ff'},
  left:{label:'已离职',col:'#9097a0'},   // 脑图灰色名字
  new: {label:'新人',  col:'#3b82f6'},   // 脑图蓝色名字
};
const MSTATUS_ORDER=['on','busy','out','leave'];   // 点击循环仅在日常考勤态间切换；离职/新人为HR态，展示用
/* 正编/基地：corp='reg' 正编(带队) | 'base' 基地 */
const CORP={reg:{label:'正编',col:'#0052d9',bg:'#e7f0ff'},base:{label:'基地',col:'#56607a',bg:'#eef1f7'}};

/* 隶属带队配色：每位带队正编一个固定色，用作人名标签上的小圆点，一眼看出"这人归谁带"。
   key = 带队正编姓名；其余/无归属用灰。 */
const LEAD_COLOR={'余洪震':'#e8590c','薛旭阳':'#1098ad','陈琛':'#7048e8'};
/* 解析某成员的"隶属带队"姓名：正编=自己；基地=其 lead 字段(指向带队正编) */
function leadOf(m){
  if(!m) return '';
  if(m.corp==='reg') return m.name;
  const L=m.lead;
  if(!L||L==='—'||L==='-') return '';
  return L;
}
const leadColor = name => LEAD_COLOR[name] || '#a3acba';
/* 某需求的"带队归属"：优先取参与的正编(带队)姓名；否则取基地成员里出现最多的隶属。
   用于判断谁是"跨队来支援的人"。 */
function reqLeadOf(r){
  if(!r||!r.segs) return '';
  const ms=[...new Set(r.segs.map(s=>s.m))].map(memById).filter(Boolean);
  const reg=ms.find(m=>m.corp==='reg');
  if(reg) return reg.name;
  const cnt={};
  ms.forEach(m=>{const L=leadOf(m);if(L)cnt[L]=(cnt[L]||0)+1;});
  let best='',bn=0;
  for(const k in cnt){if(cnt[k]>bn){bn=cnt[k];best=k;}}
  return best;
}
/* 动态支援判定：某成员在「某条具体需求」里，若其隶属正编导师 ≠ 该需求的带队归属，即为「跨队支援」。
   关键点：不依赖静态 support 字段——人被改派回自己导师的需求时支援标记会自动消失，调去别的导师需求时自动出现。
   特例：本身没有正编导师归属的游离人力（lead='—'，如金潇支援武器特效），用其 support 字段兜底。 */
function isSupportInReq(m,r){
  if(!m||!r) return false;
  const myLead=leadOf(m), reqLead=reqLeadOf(r);
  if(myLead && reqLead) return myLead!==reqLead;   // 双方归属都明确：不同导师 → 支援
  return !!m.support;                              // 无明确导师归属的游离人力：按静态字段兜底
}

/* 某成员的「最早被分配到需求」的开始日（取所有 segs 最小 s）。无任务返回 null。 */
function firstAssignDate(m){
  let min=null;
  reqs.forEach(r=>r.segs.forEach(s=>{
    if(s.m!==m.id) return;
    if(min===null || s.s<min) min=s.s;
  }));
  return min;
}
/* 「临 / 新人」精简为单一标记，且自动失效：
   ——这两个含义重复(都表示「新进/未稳定」)，统一只显示一个；
   ——从「最早分配制作需求」起算，超过 1 个月(31天)自动去除该标记(视为已转正常)。
   返回 'new'(显示新人) | 'tmp'(显示临) | ''(不显示)。新人优先于临。 */
function rookieFlag(m){
  if(!m) return '';
  if(m.status!=='new' && !m.tmp) return '';   // 本就不是新进/临时
  const fa=firstAssignDate(m);
  if(fa){
    const days=(TODAY-fa)/86400000;
    if(days>31) return '';                     // 分配满 1 个月，自动转正常，去标记
  }
  return m.status==='new' ? 'new' : 'tmp';     // 未满月：新人优先，否则临
}

/* 离职「满 1 个月(31天)」判定：离职超过 1 月的成员从各信息栏/名单中隐藏(视为已彻底离场)。
   以 leftAt(离职日)起算；若离职但缺 leftAt 则保守不隐藏(仍显示，避免误删)。
   返回 true 表示「应隐藏」。 */
function leftLong(m){
  if(!m || m.status!=='left') return false;
  if(!m.leftAt) return false;                  // 无离职日：保守保留
  return (TODAY-m.leftAt)/86400000 > 31;
}

/* 「是否已实际离职」：status=='left' 仅代表已登记离职安排；只有离职日 leftAt 当天或之前才真正生效。
   未到离职日（leftAt 在未来）→ 视为仍在岗，正常显示/计算负载/计入名单，不灰化不打「已离职」徽标。
   无 leftAt 的历史数据保守视为已离职。供 显示灰化 / 名单计数 / 排序沉底 等统一调用。 */
function effLeft(m){
  if(!m || m.status!=='left') return false;
  if(!m.leftAt) return true;                   // 无离职日：保守按已离职处理
  return m.leftAt <= TODAY;                     // 离职日已到 → 真正离职；未来日 → 仍在岗
}

/* ============ 分组归类 + 超期自动归档（可配置） ============
   ARCHIVE.on：是否启用自动归档；阈值 = ARCHIVE.val × ARCHIVE.unit（天/周/月），由 archiveDays() 换算成天比较。
   GROUP_MODE.person / GROUP_MODE.req：两视图各自的分组方式。
   collapsed：记录被折叠的分组 key（含归档区），值为 true 表示已折叠。
   以上均纳入 snapshot/applySnap 持久化（本地 / 分享链接 / 云端三链路一致）。 */
let ARCHIVE = { on:true, val:2, unit:'week' };   // 阈值=val×unit；unit: day|week|month
/* 「隐藏已完成」开关（按视图独立）：开启时，已完成(done) / 已废弃(dropped) / 派生已完成的需求从当前视图中隐藏。
   每个视图（person/req/hr）各自记录开关状态，切换视图时自动同步复选框。 */
let HIDE_DONE = { person:false, req:false, hr:false };
/* 阈值换算成天数：周=7天，月=30天。供 memArchived/reqArchived 比较用。 */
function archiveDays(){
  const u=ARCHIVE.unit, n=(+ARCHIVE.val||0);
  return u==='month' ? n*30 : u==='week' ? n*7 : n;
}
/* 人类可读阈值文案，如 “2 周”“200 天”“3 个月”，供归档区标题/提示展示。 */
function archiveLabel(){
  const n=(+ARCHIVE.val||0), u=ARCHIVE.unit;
  return u==='month' ? n+' 个月' : u==='week' ? n+' 周' : n+' 天';
}
let GROUP_MODE = { person:'corp', req:'mod' };   // person: none|corp|lead ; req: none|mod|char
let collapsed = {};   // key -> true(折叠)

/* 成员是否"应归档"：已离职且离职超过阈值（启用时）。
   阈值由 archiveDays() 统一换算（天/周/月）。离职者无论多久都进归档区（可展开），
   不再受 leftLong（31天硬隐藏）影响——避免阈值>31天时归档区永远为空。 */
function memArchived(m){
  if(!ARCHIVE.on || !m) return false;
  if(m.status!=='left' || !m.leftAt) return false;
  const d=(TODAY-m.leftAt)/86400000;
  return d>archiveDays();
}
/* 需求是否"应归档"：废弃需求立即归档；已完成/已完结(结束日已过)需结束日超过阈值才归档。 */
function reqArchived(r){
  if(!ARCHIVE.on || !r) return false;
  if(reqState(r)==='dropped') return true;   // 废弃需求：立即折叠进归档区
  if(!r.end) return false;
  const done = reqState(r)==='done' || (r.estimate>0 && r.done>=r.estimate) || (typeof aggStatus==='function' && aggStatus(r)==='done');
  const ended = r.end < TODAY;
  if(!done && !ended) return false;          // 既未完成也未结束：留在主区
  const d=(TODAY-r.end)/86400000;
  return d>archiveDays();                     // 已完成/已结束：结束日超期才归档
}

/* 分组方式定义：返回 {key, label, color} 用于左侧分组标题行。 */
function personGroupKey(m){
  const mode=GROUP_MODE.person;
  if(mode==='lead'){ const L=leadOf(m); return L?{key:'lead:'+L,label:'隶属 '+L,color:leadColor(L)}:{key:'lead:free',label:'游离 / 无带队归属',color:'#a3acba'}; }
  if(mode==='corp'){
    if(isExtLoan(m)) return {key:'corp:loan',label:'外借支援（非角色线）',color:'#f08c00'};
    if(m.corp==='reg'||m.corp==='sub') return {key:'corp:reg',label:'正编 / 子公司',color:'#0052d9'};
    return {key:'corp:base',label:'基地',color:'#56607a'};
  }
  return null;   // none
}
function reqGroupKey(r){
  const mode=GROUP_MODE.req;
  if(mode==='char'){ const c=charShort(r.char)||r.name; return {key:'char:'+c,label:c,color:charColor(c)}; }
  if(mode==='mod'){ const MM=modMeta(r.mod); return {key:'mod:'+(r.mod||'其他'),label:MM.s,color:MM.c}; }
  return null;   // none
}
/* 分组顺序：corp 用固定优先级，其余按出现顺序。 */
const CORP_GROUP_ORDER=['corp:reg','corp:base','corp:loan'];
function groupSortVal(key){ const i=CORP_GROUP_ORDER.indexOf(key); return i<0?99:i; }

/* 按人视图成员排序规则（v6.87 引入，彻底解决新成员恒排末尾的顽疾）：
   1. 人员状态：在职/正常在前，离职·已归档沉底
   2. 编制：正编(reg) → 子公司(sub) → 基地(base) → 外借(loan)
   3. 隶属带队：同一 leadOf 相邻（同导师团队聚合）
   4. 品级强度：红>金>橙>常规（能力强在前）
   5. 支援关系：本队在前，跨队支援在后
   6. 姓名：拼音 A→Z
   7. 兜底：原始录入顺序（保证稳定排序，不抖动） */
const CORP_PRI={reg:0,sub:1,base:2,loan:99};
const GRADE_RANK={'红':3,'金':2,'橙':1,'':0};
function personSortCompare(a,b){
  const la=(effLeft(a)||memArchived(a))?1:0, lb=(effLeft(b)||memArchived(b))?1:0;
  if(la!==lb) return la-lb;                                   // 1. 离职沉底
  /* v7.24 手动/智能排序：m.sort（全局唯一序号，同组内按序号升序）优先于默认规则。
     分组视图按组聚合后组内再调本比较器，全局序号在组内的相对顺序依然正确；
     无序号成员（新建/从未排过）排在同组已排序成员之后、按默认规则兜底。 */
  const oa=a.sort, ob=b.sort;
  if(oa!=null&&ob!=null&&oa!==ob) return oa-ob;               // 2+. 自定义序号
  if((oa!=null)!==(ob!=null)) return oa!=null?-1:1;           //    有序号在前
  const d=(CORP_PRI[a.corp]??99)-(CORP_PRI[b.corp]??99);
  if(d) return d;                                             // 2. 编制
  const lda=leadOf(a)||'~', ldb=leadOf(b)||'~';
  if(lda!==ldb) return lda.localeCompare(ldb,'zh-Hans-CN');   // 3. 隶属相邻
  const ga=GRADE_RANK[a.grade]||0, gb=GRADE_RANK[b.grade]||0;
  if(ga!==gb) return gb-ga;                                   // 4. 品级强在前
  const sa=a.support?1:0, sb=b.support?1:0;
  if(sa!==sb) return sa-sb;                                   // 5. 本队前/支援后
  const pn=(a.name||'').localeCompare(b.name||'','zh-Hans-CN');
  if(pn) return pn;                                           // 6. 姓名拼音
  return members.indexOf(a)-members.indexOf(b);               // 7. 原始顺序兜底
}

/* 分组方式下拉选项（随视图变化） */
const GROUP_OPTS={
  person:[{v:'none',t:'不分组'},{v:'corp',t:'按编制（正编/子公司/基地/外借）'},{v:'lead',t:'按隶属带队'}],
  req:[{v:'none',t:'不分组'},{v:'mod',t:'按模块（出场/检视/组队…）'},{v:'char',t:'按角色'}],
};
function updateGroupSelUI(){
  const sel=document.getElementById('groupSel'); if(!sel)return;
  const sc=document.getElementById('sortCtl'); if(sc)sc.style.display=(view==='person')?'':'none';   // v7.24 排序控件仅「按人看」可用
  if(view==='hr'){ sel.disabled=true; sel.innerHTML='<option>（人力视图按模块固定分组）</option>'; sel.parentElement.style.opacity='.5'; return; }
  sel.disabled=false; sel.parentElement.style.opacity='1';
  const vk=view==='req'?'req':'person';
  const cur=GROUP_MODE[vk];
  sel.innerHTML=GROUP_OPTS[vk].map(o=>`<option value="${o.v}" ${o.v===cur?'selected':''}>${o.t}</option>`).join('');
}
function changeGroup(v){
  const vk=view==='req'?'req':'person'; GROUP_MODE[vk]=v;
  try{localStorage.setItem('gantt_group_'+vk,v);}catch(_){}
  rerender();
}
function changeArchiveVal(v){
  let n=parseInt(v,10); if(!isFinite(n)||n<0)n=0; if(n>999)n=999;
  ARCHIVE.val=n; const el=document.getElementById('archiveVal'); if(el)el.value=n;
  save();broadcast();rerender();
  toast('超期归档阈值：'+archiveLabel());
}
function changeArchiveUnit(u){
  if(['day','week','month'].indexOf(u)<0)u='day';
  ARCHIVE.unit=u; save();broadcast();rerender();
  toast('超期归档阈值：'+archiveLabel());
}
function changeArchiveOn(on){
  ARCHIVE.on=!!on; save();broadcast();rerender();
  toast(on?'已启用超期自动归档':'已关闭自动归档（显示全部）');
}
function changeHideDone(on){
  HIDE_DONE[view]=!!on;
  const el=document.getElementById('hideDoneOn'); if(el)el.checked=!!on;
  save();broadcast();rerender();
  toast(on?'已隐藏已完成需求（仅影响显示，统计不变）':'已显示全部需求（含已完成）');
}
/* 切换视图时，将复选框同步为该视图的独立状态 */
function syncHideDoneCheckbox(){
  const el=document.getElementById('hideDoneOn'); if(!el)return;
  el.checked=!!HIDE_DONE[view];
}
function toggleGroup(key){
  collapsed[key]=!collapsed[key];
  try{localStorage.setItem('gantt_collapsed',JSON.stringify(collapsed));}catch(_){}
  rerender();
}
/* 分组标题行 HTML（左侧列内可点折叠） */
function groupHeaderHTML(g,count,isArchived,tip){
  const col=collapsed[g.key]?' collapsed':'';
  const arc=isArchived?' archived':'';
  /* v7.46：补 data-grp —— 分组 key 原先只存在于 onclick 字符串里，DOM 层无法识别分组边界。
     关键节点竖向虚线需要「止于该需求所属组的最后一行」，必须能在 DOM 里定位 .grp-header 才能求组尾。 */
  return `<div class="grp-header${col}${arc}" data-grp="${escAttr(g.key)}" onclick="toggleGroup('${g.key.replace(/'/g,"\\'")}')" title="点击折叠/展开该分组">
    <div class="gh-left">
      <span class="gh-caret">▼</span>
      ${g.color?`<span class="gh-dot" style="background:${g.color}"></span>`:''}
      <span class="gh-name">${isArchived?'📦 ':''}${g.label}</span>
      <span class="gh-cnt">${count}</span>
      <span class="gh-spacer"></span>
    </div>
    ${tip?`<span class="gh-tip">${tip}</span>`:''}
  </div>`;
}

/* 「长期外借」判定：编制仍挂在本团队，但长期支援其他管线(如武器特效)、不隶属任何角色线。
   特征：support===true 且无正编导师归属(lead 为 — / -)。这类人不应被当作角色线在岗人力统计，
   需在「按人看」姓名行用专属徽标醒目标注，避免被误读为可派给角色需求的基地人力。

   v7.48 改为「数据优先 + 兼容兜底」：
     · 优先读正式借出记录 m.loan（dir='out' 且 state='active' → 确属外借中）
     · 无记录时回落到旧口径（裸 support + 无 lead），保证历史数据与云端老快照行为不变
     · 注意：state='sealed'（已封存）**不计为外借中**——封存只归档记录，人是否已回来由 ended 决定
   这一处是本版唯一改动的判定表达式；corpStyle / personGroupKey / personSortCompare /
   computeHR / renderHR / updateKPIs 等调用点全部零改动、数值与现状严格一致。 */
function isExtLoan(m){
  if(!m) return false;
  const L=m.loan;
  if(L && L.dir==='out') return L.state==='active';   // 有正式记录：以记录为准
  if(!m.support) return false;                        // 兼容兜底：裸 support 的历史数据
  return !m.lead || m.lead==='—' || m.lead==='-';
}

/* ============ v7.48 借调记录（外借 / 借入）数据模型 ============
   m.loan     : LoanRec | null   —— 当前生效借调（至多一条）
   m.loanRecs : LoanRec[]        —— 历史归档（只增不改）

   LoanRec = {
     id:'ln_xxx', dir:'out'|'in', party:'对方管线', from:Date, to:Date|null,
     mod:'', note:'',
     snap:{corp,lead,mod,grade,line}|null,   // 借出前的原编制快照，供「回归」一键还原
     state:'active'|'sealed'|'ended',
     endAt:Date|null, endBy:'return'|'convert'|'seal:auto'|'seal:manual'|null,
   }
   state 语义（最易混淆，务必分清）：
     active = 在借中（外借方向时 isExtLoan() 为真）
     sealed = 记录已封存归档，**人还在外面**，只是不再计入活跃外借
     ended  = 人已回归/已归还/已转正，m.loan 清空，记录进 loanRecs */
function newLoanId(){ return 'ln_'+Math.random().toString(36).slice(2,9); }
/* 借调记录 Date ↔ 日索引 往返（与 leftAt 同式：idx/i2d）。借调不涉及末日±1 口径，无需 SNAP_VER 转换。 */
function serializeLoan(L){
  if(!L) return null;
  const o={};
  for(const k in L) o[k]=L[k];
  if(o.from)  o.from=idx(o.from);   else delete o.from;
  if(o.to)    o.to=idx(o.to);       else delete o.to;
  if(o.endAt) o.endAt=idx(o.endAt); else delete o.endAt;
  return o;
}
function deserializeLoan(o){
  if(!o) return null;
  const L={};
  for(const k in o) L[k]=o[k];
  if(L.from!=null)  L.from=i2d(L.from);
  if(L.to!=null)    L.to=i2d(L.to);
  if(L.endAt!=null) L.endAt=i2d(L.endAt);
  return L;
}
/* 是否「借入中」：外来人员以临时隶属身份在本队支援 */
function isLoanIn(m){
  return !!(m && m.loan && m.loan.dir==='in' && m.loan.state!=='ended');
}
/* 取当前生效借调（两方向通用） */
function curLoan(m){ return (m && m.loan && m.loan.state!=='ended') ? m.loan : null; }

/* 编制四态着色（统一口径，与「按人看·corp 分组」一致）：
   外借支援(橙) / 正编+子公司(蓝) / 基地(淡白)。
   返回 {key,label,col,short,txt,bord}：col=底色(甘特条/徽标背景)，txt=前景字色，bord=内描边色(空串表示无)。
   供「一人一行甘特」的条色与标签编制徽标统一取色——即甘特按"编制"上色，而非"隶属带队"。short 为标签徽标单字。
   注：基地用淡白底，需深字 txt + 描边 bord 才能在深色需求条上可见(纯白条/白字会看不见)；正编/子公司为实色底配白字。 */
function corpStyle(m){
  if(isExtLoan(m)) return {key:'loan',label:'外借支援',col:'#f08c00',short:'借',txt:'#fff',bord:'',tex:'',outline:''};
  // 已离职：冷调淡蓝白 + 无纹理 + 虚线描边 + 贯穿划除线（strike）—— 一条线把人划掉，语义最直接
  if(effLeft(m)) return {key:'gone',label:'已离职',col:'#e6ecf6',short:'离',txt:'#6b7385',bord:'#a9b8d0',
    tex:'', outline:'dashed', strike:'#222'};
  // 正编：实心深蓝 + 实线描边（最"实"）
  if(m&&m.corp==='reg') return {key:'reg',label:'正编带队',col:'#0052d9',short:'正',txt:'#fff',bord:'',tex:'',outline:'solid',strike:''};
  // 子公司：与正编同色系但略浅 + 细竖纹 —— 相近而不零区分
  if(m&&m.corp==='sub') return {key:'sub',label:'子公司',col:'#2b6fe3',short:'子',txt:'#fff',bord:'',
    tex:'repeating-linear-gradient(90deg,rgba(255,255,255,.28) 0 1.5px,transparent 1.5px 6px)', outline:'solid', strike:''};
  // 基地（在职）：钢蓝灰 + 细竖纹 + 实线描边 —— 在斜纹底纹上清晰可辨
  return {key:'base',label:'基地',col:'#c5cee0',short:'基',txt:'#3d4a5c',bord:'#9aa8bc',
    tex:'repeating-linear-gradient(90deg,rgba(60,75,95,.28) 0 1.5px,transparent 1.5px 7px)', outline:'solid', strike:''};
}

/* ============ 数据（真实：出场动画特效相关制作人 + 橙角出场特效排期） ============ */
/* 成员 = 出场/检视/组队/武器等模块制作人。
   corp=编制(reg正编带队/base基地)，lead=该正编带队负责的范围，mod=模块，grade=品级，line=管线，tmp=临时，status含 left离职/new新人 */
const members = [
  // ===== 正编（带领基地同学，搭配负责需求）=====
  {id:'yhz', name:'余洪震', role:'正编·带队 红角+金角', corp:'reg', lead:'红角 + 金角', mod:'出场', grade:'金', line:'J', eff:2, status:'on'},
  {id:'xxy', name:'薛旭阳', role:'正编·带队 橙角露西亚(管线1)', corp:'reg', lead:'橙角露西亚·管线1', mod:'出场', grade:'橙', line:'L1', eff:2, status:'on'},
  {id:'cc', name:'陈琛', role:'正编·带队 检视/组队/饰品', corp:'reg', lead:'橙角 检视 / 组队 / 饰品', mod:'检视', grade:'橙', line:'-', eff:2, status:'on'},
  {id:'m_3xqr1', name:'暂缺', role:'正编·带队', corp:'reg', lead:'暂缺', mod:'出场', grade:'橙', line:'L2', eff:2, status:'leave'},

  // ===== 基地（隶属正编带队；管线随正编线，不再单独设置）=====
  {id:'ygh', name:'杨光豪', role:'基地', corp:'base', lead:'薛旭阳', mod:'出场', grade:'橙', line:'-', eff:0.8, status:'on'},
  {id:'ll', name:'李龙', role:'基地·外借支援', corp:'base', lead:'余洪震', mod:'出场', grade:'橙', line:'-', eff:1, status:'on', support:true},
  {id:'zyq', name:'张雍祺', role:'基地', corp:'base', lead:'薛旭阳', mod:'出场', grade:'橙', line:'-', eff:0.5, status:'left', leftAt:DT(2026,7,17)},
  {id:'zjj', name:'曾俊杰', role:'基地·外借支援', corp:'base', lead:'余洪震', mod:'出场', grade:'橙', line:'-', eff:1, status:'on', support:true},
  {id:'zcz', name:'张长喆', role:'基地', corp:'base', lead:'薛旭阳', mod:'出场', grade:'橙', line:'-', eff:0.5, status:'left', tmp:true, leftAt:DT(2026,5,1)},
  {id:'ljy', name:'梁骏源', role:'基地', corp:'base', lead:'薛旭阳', mod:'出场', grade:'橙', line:'-', eff:0.5, status:'left', tmp:true, leftAt:DT(2026,5,1)},
  {id:'zjh', name:'邹佳豪', role:'基地', corp:'base', lead:'余洪震', mod:'出场', grade:'橙', line:'-', eff:0.3, status:'new', tmp:true},
  {id:'hsy', name:'胡斯雨', role:'基地', corp:'base', lead:'薛旭阳', mod:'出场', grade:'橙', line:'-', eff:0.5, status:'on'},
  {id:'yh', name:'于航', role:'基地', corp:'base', lead:'余洪震', mod:'出场', grade:'金', line:'-', eff:1, status:'on'},
  {id:'psq', name:'彭诗淇', role:'基地', corp:'base', lead:'余洪震', mod:'出场', grade:'金', line:'-', eff:1, status:'on'},
  {id:'lzs', name:'刘振山', role:'基地', corp:'base', lead:'余洪震', mod:'出场', grade:'金', line:'-', eff:0.5, status:'left', leftAt:DT(2026,7,17)},
  {id:'zc', name:'宗丞', role:'基地', corp:'base', lead:'余洪震', mod:'出场', grade:'金', line:'-', eff:0.5, status:'left', leftAt:DT(2026,7,3)},
  {id:'cyh', name:'陈禹汗', role:'基地', corp:'base', lead:'陈琛', mod:'检视', grade:'橙', line:'-', eff:0.8, status:'on'},
  {id:'zbw', name:'郑博文', role:'基地', corp:'base', lead:'陈琛', mod:'检视', grade:'橙', line:'-', eff:1, status:'on'},
  {id:'ljj', name:'娄佳俊', role:'基地', corp:'base', lead:'陈琛', mod:'组队', grade:'橙', line:'-', eff:0.3, status:'on'},
  {id:'jx', name:'金潇', role:'基地·外借支援', corp:'base', lead:'—', mod:'武器特效', grade:'', line:'-', eff:1, status:'busy', support:true},
  {id:'m_p00qs', name:'袁诗睿', role:'基地', corp:'base', lead:'余洪震', mod:'出场', grade:'橙', line:'-', eff:0.5, status:'left', leftAt:DT(2026,7,31)},
  {id:'m_ovsy7', name:'王君豪', role:'基地', corp:'base', lead:'余洪震', mod:'出场', grade:'金', line:'-', eff:0.5, status:'on'},
  {id:'m_s1wmk', name:'许未名', role:'基地', corp:'base', lead:'余洪震', mod:'出场', grade:'金', line:'-', eff:0.5, status:'left', leftAt:DT(2026,7,31)},
  {id:'m_ck8mo', name:'王雨菡', role:'基地', corp:'base', lead:'薛旭阳', mod:'出场', grade:'橙', line:'-', eff:0.3, status:'on'},
  {id:'m_5eibi', name:'暂缺-基地1', role:'基地', corp:'base', lead:'暂缺', mod:'出场', grade:'橙', line:'-', eff:1, status:'on'},
  {id:'m_t7pqf', name:'暂缺-基地2', role:'基地', corp:'base', lead:'暂缺', mod:'出场', grade:'橙', line:'-', eff:1, status:'on'},
  {id:'m_7hk9c', name:'暂缺-基地3', role:'基地', corp:'base', lead:'暂缺', mod:'出场', grade:'橙', line:'-', eff:1, status:'on'}
];

/* 初始成员 ID 快照：用于区分「硬编码本地成员」与「云端动态同步新增的成员」（如子公司/外协等）。
   在 members 定义后立即冻结，applySnap 新增的成员不在其中 → 渲染时加「动态」标识。 */
const LOCAL_MEMBER_IDS = new Set(members.map(m => m.id));

/* 需求 = 企微数据源表 q979lj 橙角出场特效排期(权威) + 大甘特图(image#1)红角女指挥官特效模块 + 金角/检视/组队/机动/武器支援。
   每条需求覆盖一个"角色×模块×品级"的特效工作；segs=投入的核心制作人(含正编带队+基地)。
   mod=模块, char=角色, grade=品级, line=管线 */
/* kind: fx=特效(紫,主体) | lt=联调(特效后→全量测试前) | qa=全量测试里程碑(黑,bug修复阶段,不计排期负载)。
   support:true 标在 seg 上=该人为支援性质(非本管线编制)。 */
const reqs = [
  {id:'LU_cc', name:'露西亚 出场特效', char:'露西亚·誓焰 X 安琪儿', mod:'出场', grade:'橙', line:'L1', kind:'fx', state:'done', estimate:134, end:DT(2026,6,24), split:null, split2:91, done:128, segs:[{m:'xxy', s:DT(2026,4,29), e:DT(2026,6,24), prog:1, status:'done'}, {m:'ygh', s:DT(2026,4,13), e:DT(2026,6,24), prog:1, status:'done'}, {m:'ll', s:DT(2026,5,27), e:DT(2026,6,24), prog:1, status:'done', support:true}, {m:'zyq', s:DT(2026,6,18), e:DT(2026,6,24), prog:1, status:'done'}, {m:'zjh', s:DT(2026,6,4), e:DT(2026,6,24), prog:1, status:'done'}, {m:'yhz', s:DT(2026,5,20), e:DT(2026,6,24), prog:1, status:'done', support:true, inv:0.3}, {m:'lzs', s:DT(2026,6,20), e:DT(2026,6,24), prog:1, status:'done', support:true}, {m:'zc', s:DT(2026,6,20), e:DT(2026,6,24), prog:1, status:'done', support:true}, {m:'cyh', s:DT(2026,6,9), e:DT(2026,6,16), prog:1, status:'done', support:true}, {m:'ljj', s:DT(2026,6,13), e:DT(2026,6,23), prog:1, status:'done', support:true}]},
  {id:'LU_cs', name:'露西亚 检视特效', char:'露西亚·誓焰 X 安琪儿', mod:'检视', grade:'橙', line:'L1', kind:'fx', state:'done', estimate:27, end:DT(2026,6,30), split:46, split2:null, done:27, segs:[{m:'cyh', s:DT(2026,6,16), e:DT(2026,6,30), prog:1, status:'done'}, {m:'cc', s:DT(2026,5,6), e:DT(2026,6,24), prog:1, status:'done', inv:0.6}, {m:'cyh', s:DT(2026,5,6), e:DT(2026,6,9), prog:1, status:'done'}]},
  {id:'LU_zd', name:'露西亚 组队特效', char:'露西亚·誓焰 X 安琪儿', mod:'组队', grade:'橙', line:'L1', kind:'fx', state:'done', estimate:29, end:DT(2026,6,26), split:null, split2:null, done:29, segs:[{m:'cc', s:DT(2026,5,19), e:DT(2026,6,26), prog:1, status:'done'}, {m:'zjj', s:DT(2026,6,3), e:DT(2026,6,24), prog:1, status:'done', support:true}]},
  {id:'LU_lt', name:'露西亚 联调', char:'露西亚·誓焰 X 安琪儿', mod:'联调', grade:'橙', line:'L1', kind:'fx', state:'done', estimate:33, end:DT(2026,7,9), split:null, split2:null, done:20, segs:[{m:'xxy', s:DT(2026,6,24), e:DT(2026,6,29), prog:1, status:'done'}, {m:'ygh', s:DT(2026,6,24), e:DT(2026,7,9), prog:1, status:'done'}, {m:'ll', s:DT(2026,6,24), e:DT(2026,7,8), prog:1, status:'done', support:true}, {m:'zyq', s:DT(2026,6,24), e:DT(2026,7,9), prog:1, status:'done'}, {m:'zjh', s:DT(2026,6,24), e:DT(2026,7,9), prog:1, status:'done'}, {m:'zjj', s:DT(2026,6,24), e:DT(2026,6,27), prog:1, status:'done', support:true}, {m:'cc', s:DT(2026,6,24), e:DT(2026,7,8), prog:1, status:'done', support:true}, {m:'lzs', s:DT(2026,6,24), e:DT(2026,6,29), prog:1, status:'done', support:true}, {m:'zbw', s:DT(2026,6,24), e:DT(2026,7,1), prog:1, status:'done', support:true, inv:0.6}]},
  {id:'BK_cc', name:'比安卡 出场特效', char:'比安卡·寻 X 奈芙', mod:'出场', grade:'橙', line:'L2', kind:'fx', state:'done', estimate:119, end:DT(2026,8,3), split:null, split2:null, done:15, segs:[{m:'hsy', s:DT(2026,6,2), e:DT(2026,7,29), prog:1, status:'done'}, {m:'yhz', s:DT(2026,6,29), e:DT(2026,7,29), prog:1, status:'done', support:true}, {m:'psq', s:DT(2026,6,29), e:DT(2026,7,29), prog:1, status:'done', support:true}, {m:'zjj', s:DT(2026,6,29), e:DT(2026,7,29), prog:1, status:'done', support:true}, {m:'ll', s:DT(2026,6,29), e:DT(2026,7,29), prog:1, status:'done', support:true}, {m:'ygh', s:DT(2026,6,29), e:DT(2026,7,29), prog:1, status:'done', support:true}, {m:'m_p00qs', s:DT(2026,7,8), e:DT(2026,7,29), prog:1, status:'done'}, {m:'m_ovsy7', s:DT(2026,7,8), e:DT(2026,7,16), prog:1, status:'done'}, {m:'zbw', s:DT(2026,7,25), e:DT(2026,8,3), prog:1, status:'done', support:true}, {m:'xxy', s:DT(2026,7,10), e:DT(2026,7,20), prog:1, status:'done', support:true}]},
  {id:'BK_cs', name:'比安卡 检视特效', char:'比安卡·寻 X 奈芙', mod:'检视', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:47, end:DT(2026,7,25), split:51, split2:null, done:16, segs:[{m:'cc', s:DT(2026,5,9), e:DT(2026,7,25), prog:1, status:'done', inv:0.6}, {m:'zbw', s:DT(2026,5,9), e:DT(2026,7,25), prog:1, status:'done'}]},
  {id:'BK_zd', name:'比安卡 组队特效', char:'比安卡·寻 X 奈芙', mod:'组队', grade:'橙', line:'L2', kind:'fx', state:'done', estimate:38, end:DT(2026,7,29), split:72, split2:null, done:10, segs:[{m:'cc', s:DT(2026,5,15), e:DT(2026,7,29), prog:1, status:'done'}, {m:'ljj', s:DT(2026,5,15), e:DT(2026,6,13), prog:1, status:'done'}]},
  {id:'BK_lt', name:'比安卡 联调', char:'比安卡·寻 X 奈芙', mod:'联调', grade:'橙', line:'L2', kind:'fx', state:'done', estimate:13, end:DT(2026,8,16), split:null, split2:null, done:0, segs:[{m:'hsy', s:DT(2026,7,29), e:DT(2026,8,16), prog:1, status:'done'}, {m:'ljj', s:DT(2026,7,7), e:DT(2026,7,16), prog:1, status:'done', support:true}]},
  {id:'QS_cc', name:'七十 出场特效', char:'七十·芒星之迹 X 茉莉', mod:'出场', grade:'金', line:'J', kind:'fx', state:'done', estimate:79, end:DT(2026,6,23), split:null, split2:null, done:65, segs:[{m:'yhz', s:DT(2026,5,20), e:DT(2026,6,23), prog:1, status:'done', inv:0.6}, {m:'yh', s:DT(2026,5,20), e:DT(2026,6,20), prog:1, status:'done'}, {m:'psq', s:DT(2026,5,27), e:DT(2026,6,23), prog:1, status:'done'}, {m:'lzs', s:DT(2026,5,13), e:DT(2026,6,20), prog:1, status:'done'}, {m:'zc', s:DT(2026,5,27), e:DT(2026,6,20), prog:1, status:'done'}, {m:'zyq', s:DT(2026,5,11), e:DT(2026,6,18), prog:0, status:'todo', support:true}]},
  {id:'HK_cc', name:'红蔻 出场特效', char:'红蔻', mod:'出场', grade:'金', line:'J', kind:'fx', state:'active', estimate:112, end:DT(2026,9,25), split:null, split2:null, done:0, segs:[{m:'lzs', s:DT(2026,6,29), e:DT(2026,9,7), prog:0, status:'todo'}, {m:'yhz', s:DT(2026,6,29), e:DT(2026,9,25), prog:0, status:'todo', inv:0.6}, {m:'zyq', s:DT(2026,6,29), e:DT(2026,9,7), prog:0, status:'todo', support:true}, {m:'yh', s:DT(2026,6,29), e:DT(2026,9,7), prog:0, status:'todo'}, {m:'zjh', s:DT(2026,6,29), e:DT(2026,9,7), prog:0, status:'todo'}, {m:'m_ovsy7', s:DT(2026,7,16), e:DT(2026,9,7), prog:0, status:'todo'}, {m:'m_s1wmk', s:DT(2026,7,8), e:DT(2026,9,7), prog:0, status:'todo'}]},
  {id:'CY_cc', name:'Cyndi 出场特效', char:'Cyndi', mod:'出场', grade:'金', line:'J', kind:'fx', state:'active', estimate:68, end:DT(2026,10,23), split:null, split2:null, done:0, segs:[{m:'yh', s:DT(2026,9,7), e:DT(2026,10,23), prog:0, status:'todo'}, {m:'m_ovsy7', s:DT(2026,9,7), e:DT(2026,10,23), prog:0, status:'todo'}, {m:'zjh', s:DT(2026,9,7), e:DT(2026,10,23), prog:0, status:'todo'}]},
  {id:'CY_lt', name:'Cyndi 联调', char:'Cyndi', mod:'联调', grade:'金', line:'J', kind:'fx', state:'active', estimate:14, end:DT(2026,11,13), split:null, split2:null, done:0, segs:[{m:'yh', s:DT(2026,10,26), e:DT(2026,11,13), prog:0, status:'todo'}]},
  {id:'WP_sup', name:'武器特效 支援', char:'武器（支援）', mod:'武器特效', grade:'', line:'-', kind:'fx', state:'active', estimate:30, end:DT(2026,8,31), split:null, split2:null, done:12, segs:[{m:'jx', s:DT(2026,5,1), e:DT(2026,8,31), prog:0.4, status:'doing', support:true, open:true}]},
  {id:'BL_cc', name:'白老板 出场特效', char:'白老板', mod:'出场', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:114, end:DT(2026,10,14), split:null, split2:null, done:0, segs:[{m:'xxy', s:DT(2026,7,20), e:DT(2026,10,14), prog:0, status:'todo', support:true}, {m:'ygh', s:DT(2026,8,4), e:DT(2026,10,14), prog:0, status:'todo'}, {m:'hsy', s:DT(2026,8,4), e:DT(2026,10,14), prog:0, status:'todo', support:true}, {m:'m_ck8mo', s:DT(2026,8,4), e:DT(2026,10,14), prog:0, status:'todo'}]},
  {id:'BL_cs', name:'白老板 检视组队特效', char:'白老板', mod:'检视', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:34, end:DT(2026,9,11), split:101, split2:null, done:0, segs:[{m:'cyh', s:DT(2026,7,1), e:DT(2026,9,11), prog:0, status:'doing'}, {m:'cc', s:DT(2026,7,1), e:DT(2026,8,15), prog:0, status:'doing', inv:0.3}, {m:'cc', s:DT(2026,8,17), e:DT(2026,9,11), prog:0, status:'todo', inv:0.6}]},
  {id:'HG_cc', name:'荷光者 出场特效', char:'荷光者', mod:'出场', grade:'橙', line:'L1', kind:'fx', state:'active', estimate:136, end:DT(2026,12,10), split:null, split2:null, done:0, segs:[{m:'m_3xqr1', s:DT(2026,9,7), e:DT(2026,12,10), prog:0, status:'todo', support:true}, {m:'m_t7pqf', s:DT(2026,9,7), e:DT(2026,12,10), prog:0, status:'todo'}, {m:'m_7hk9c', s:DT(2026,9,7), e:DT(2026,12,10), prog:0, status:'todo'}]},
  {id:'HG_cs', name:'荷光者 检视组队特效', char:'荷光者', mod:'检视', grade:'橙', line:'L1', kind:'fx', state:'active', estimate:43, end:DT(2026,11,12), split:144, split2:null, done:0, segs:[{m:'zbw', s:DT(2026,8,24), e:DT(2026,11,7), prog:0, status:'todo'}, {m:'cc', s:DT(2026,8,21), e:DT(2026,11,12), prog:0, status:'todo', inv:0.3}]},
  {id:'AF_cc', name:'阿尔法 出场特效', char:'阿尔法', mod:'出场', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:17, end:DT(2027,2,20), split:null, split2:null, done:0, segs:[{m:'hsy', s:DT(2026,11,11), e:DT(2027,2,20), prog:0, status:'todo'}, {m:'xxy', s:DT(2026,11,11), e:DT(2027,2,20), prog:0, status:'todo', inv:0.6}, {m:'ygh', s:DT(2026,11,11), e:DT(2027,2,20), prog:0, status:'todo'}, {m:'m_ck8mo', s:DT(2026,11,11), e:DT(2027,2,20), prog:0, status:'todo'}]},
  {id:'AF_cs', name:'阿尔法 检视组队特效', char:'阿尔法', mod:'检视', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:33, end:DT(2026,12,13), split:null, split2:null, done:0, segs:[{m:'cyh', s:DT(2026,10,14), e:DT(2026,12,13), prog:0, status:'todo'}]},
  {id:'AF_lt', name:'阿尔法 联调', char:'阿尔法', mod:'联调', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:7, end:DT(2027,3,13), split:null, split2:null, done:0, segs:[{m:'hsy', s:DT(2027,2,23), e:DT(2027,3,13), prog:0, status:'todo'}, {m:'ygh', s:DT(2027,2,23), e:DT(2027,3,13), prog:0, status:'todo'}, {m:'xxy', s:DT(2027,2,23), e:DT(2027,3,13), prog:0, status:'todo'}, {m:'m_ck8mo', s:DT(2027,2,23), e:DT(2027,3,13), prog:0, status:'todo'}]},
  {id:'NV_bt', name:'女指挥官 本体&3C特效', char:'女指挥官（S5.1）', mod:'本体/3C', grade:'红', line:'R', kind:'fx', state:'active', estimate:45, end:DT(2026,11,26), split:null, split2:null, done:0, segs:[{m:'yhz', s:DT(2026,8,19), e:DT(2026,11,26), prog:0, status:'todo', inv:0.3}, {m:'ll', s:DT(2026,8,17), e:DT(2026,11,7), prog:0, status:'todo', inv:0.3}]},
  {id:'NV_cc', name:'女指挥官 出场特效', char:'女指挥官（S5.1）', mod:'出场', grade:'红', line:'R', kind:'fx', state:'active', estimate:26, end:DT(2026,11,26), split:null, split2:null, done:0, segs:[{m:'yhz', s:DT(2026,8,19), e:DT(2026,11,26), prog:0, status:'todo'}, {m:'psq', s:DT(2026,8,24), e:DT(2026,11,26), prog:0, status:'todo'}, {m:'zjj', s:DT(2026,8,17), e:DT(2026,11,26), prog:0, status:'todo'}]},
  {id:'NV_mvp', name:'女指挥官 MVP特效', char:'女指挥官（S5.1）', mod:'MVP', grade:'红', line:'R', kind:'fx', state:'active', estimate:15, end:DT(2026,11,26), split:null, split2:null, done:0, segs:[{m:'yhz', s:DT(2026,8,19), e:DT(2026,11,26), prog:0, status:'todo', inv:0.3}]},
  {id:'NV_rj', name:'女指挥官 入局Cuts特效', char:'女指挥官（S5.1）', mod:'入局', grade:'红', line:'R', kind:'fx', state:'active', estimate:15, end:DT(2026,11,26), split:null, split2:null, done:0, segs:[{m:'yhz', s:DT(2026,8,19), e:DT(2026,11,26), prog:0, status:'todo', inv:0.3}]},
  {id:'NV_tpp', name:'女指挥官 TPP特效', char:'女指挥官（S5.1）', mod:'TPP', grade:'红', line:'R', kind:'fx', state:'active', estimate:12, end:DT(2026,11,26), split:null, split2:null, done:0, segs:[{m:'cc', s:DT(2026,8,19), e:DT(2026,11,26), prog:0, status:'todo', inv:0.3}]},
  {id:'NV_dt', name:'女指挥官 大厅特效', char:'女指挥官（S5.1）', mod:'大厅', grade:'红', line:'R', kind:'fx', state:'active', estimate:10, end:DT(2026,12,5), split:null, split2:null, done:0, segs:[{m:'yhz', s:DT(2026,8,19), e:DT(2026,12,5), prog:0, status:'todo', inv:0.3}, {m:'cyh', s:DT(2026,9,21), e:DT(2026,10,14), prog:0, status:'todo', support:true, inv:0.3}]},
  {id:'NV_cs', name:'女指挥官 检视特效', char:'女指挥官（S5.1）', mod:'检视', grade:'红', line:'R', kind:'fx', state:'active', estimate:9, end:DT(2026,12,14), split:null, split2:null, done:0, segs:[{m:'cc', s:DT(2026,8,21), e:DT(2026,12,14), prog:0, status:'todo', inv:0.3}]},
  {id:'NV_zd', name:'女指挥官 组队特效', char:'女指挥官（S5.1）', mod:'组队', grade:'红', line:'R', kind:'fx', state:'active', estimate:9, end:DT(2026,12,14), split:null, split2:null, done:0, segs:[{m:'cc', s:DT(2026,8,21), e:DT(2026,12,14), prog:0, status:'todo', inv:0.3}]},
  {id:'r_2i3iv', name:'幽魂骑士bug修复', char:'幽魂骑士', mod:'入局Cuts', grade:'红', line:'R', kind:'fx', state:'active', estimate:20, end:DT(2026,6,17), split:null, split2:null, done:0, segs:[{m:'xxy', s:DT(2026,5,18), e:DT(2026,6,17), prog:1, status:'done', inv:0.6}]},
  {id:'r_r17wv', name:'产假', char:'产假', mod:'通用', grade:'橙', line:'-', kind:'fx', state:'active', estimate:18, end:DT(2026,7,10), split:null, split2:null, done:0, segs:[{m:'xxy', s:DT(2026,6,29), e:DT(2026,7,10), prog:1, status:'done', support:true}]},
  {id:'r_o4g0p', name:'荷光者 组队', char:'荷光者', mod:'组队', grade:'橙', line:'L1', kind:'fx', state:'active', estimate:26, end:DT(2026,11,11), split:144, split2:null, done:0, segs:[{m:'cc', s:DT(2026,8,21), e:DT(2026,11,11), prog:0, status:'todo'}, {m:'m_5eibi', s:DT(2026,9,7), e:DT(2026,11,7), prog:0, status:'todo', support:true}]},
  {id:'r_tx5q5', name:'白老板 组队', char:'白老板', mod:'组队', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:19, end:DT(2026,9,5), split:114, split2:null, done:0, segs:[{m:'cc', s:DT(2026,7,15), e:DT(2026,8,29), prog:0, status:'todo', support:true, inv:0.3}, {m:'ljj', s:DT(2026,7,16), e:DT(2026,9,5), prog:0, status:'todo'}]},
  {id:'r_tvz0u', name:'休假 出场', char:'休假', mod:'出场', grade:'橙', line:'-', kind:'fx', state:'done', estimate:3, end:DT(2026,6,25), split:null, split2:null, done:3, segs:[{m:'yh', s:DT(2026,6,22), e:DT(2026,6,25), prog:1, status:'done'}]},
  {id:'r_ja61d', name:'S4.1饰品需求*6', char:'S4.1饰品需求*6', mod:'饰品', grade:'金', line:'-', kind:'fx', state:'done', estimate:3, end:DT(2026,7,10), split:null, split2:null, done:0, segs:[{m:'cc', s:DT(2026,6,25), e:DT(2026,7,10), prog:1, status:'done', inv:0.3}, {m:'ljj', s:DT(2026,6,25), e:DT(2026,7,7), prog:1, status:'done'}]},
  {id:'r_n1r76', name:'露西亚bug修复', char:'露西亚bug修复', mod:'通用', grade:'橙', line:'L1', kind:'fx', state:'done', estimate:20, end:DT(2026,7,20), split:null, split2:null, done:0, segs:[{m:'cc', s:DT(2026,7,8), e:DT(2026,7,20), prog:1, status:'done'}]},
  {id:'r_1rbi5', name:'性能&bug修复', char:'比安卡', mod:'联调', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:32, end:DT(2026,8,30), split:null, split2:null, done:0, segs:[{m:'yhz', s:DT(2026,7,30), e:DT(2026,8,19), prog:1, status:'done'}, {m:'cc', s:DT(2026,7,30), e:DT(2026,8,30), prog:1, status:'doing', support:true}, {m:'zbw', s:DT(2026,8,3), e:DT(2026,8,14), prog:1, status:'done', support:true}, {m:'ll', s:DT(2026,7,29), e:DT(2026,8,14), prog:1, status:'done'}, {m:'zjj', s:DT(2026,7,29), e:DT(2026,8,14), prog:1, status:'done'}]},
  {id:'r_ghct5', name:'阿尔法', char:'阿尔法', mod:'组队', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:20, end:DT(2027,1,9), split:null, split2:null, done:0, segs:[{m:'ljj', s:DT(2026,10,14), e:DT(2026,12,6), prog:0, status:'todo'}, {m:'xxy', s:DT(2026,10,14), e:DT(2027,1,9), prog:0, status:'todo', support:true, inv:0.3}]},
  {id:'r_5xu2m', name:'白老板', char:'白老板', mod:'联调', grade:'橙', line:'L1', kind:'fx', state:'active', estimate:20, end:DT(2026,11,11), split:null, split2:null, done:0, segs:[{m:'ljj', s:DT(2026,9,5), e:DT(2026,10,10), prog:0, status:'todo'}, {m:'cc', s:DT(2026,8,14), e:DT(2026,9,23), prog:0, status:'todo', inv:0.3}, {m:'ygh', s:DT(2026,10,14), e:DT(2026,11,11), prog:0, status:'todo', support:true}, {m:'hsy', s:DT(2026,10,14), e:DT(2026,11,11), prog:0, status:'todo', support:true}, {m:'m_ck8mo', s:DT(2026,10,14), e:DT(2026,11,11), prog:0, status:'todo', support:true}]},
  {id:'r_eeozh', name:'荷光者', char:'荷光者', mod:'联调', grade:'橙', line:'L2', kind:'fx', state:'active', estimate:38, end:DT(2026,12,19), split:null, split2:null, done:0, segs:[{m:'m_5eibi', s:DT(2026,11,9), e:DT(2026,12,19), prog:0, status:'todo'}]},
];

/* ============ 需求预处理：删除全量测试(qa)；v6.90 起联调(lt)改为「独立需求行」 ============ */
/* 不再把联调降为本体附属。relinkLt 仅清空历史数据可能残留的 attached/children，使所有需求独立成行。 */
function relinkLt(){
  // v6.90：联调独立成行，废弃 attached/children 附属机制。
  // 清空旧关系即可——下游渲染统一按「全部需求均独立」处理。
  reqs.forEach(r=>{ if(r.children) r.children=[]; if(r.attached) delete r.attached; });
}
(function prepReqs(){
  // 1) 删除全部"全量测试"需求 —— 不再以独立需求存在
  for(let i=reqs.length-1;i>=0;i--){ if(reqs[i].kind==='qa') reqs.splice(i,1); }
  // 2) 联调 = 独立需求行（v6.90 起）。relinkLt 仅清空历史残留的附属关系，不再建立新挂接。
  relinkLt();
  // 3) v7.43：为演示里程碑功能，给部分本地样本需求注入里程碑数据。
  //    云端同步后，真实数据的 req.milestones 会自然覆盖此处 seed。
  const MS_SEED={
    'NV_bt':[{date:DT(2026,9,15),label:'S5.1提审',type:'review',color:'#ffd23f'},{date:DT(2026,10,8),label:'S5.1封版',type:'freeze',color:'#ff5b58'}],
    'BK_cc':[{date:DT(2026,8,20),label:'比安卡L2',type:'phase',color:'#4d8eff'}],
    'HG_cc':[{date:DT(2026,10,10),label:'荷光者L2',type:'phase',color:'#4d8eff'}],
    'CY_cc':[{date:DT(2026,10,20),label:'Cyndi提审',type:'review',color:'#ffd23f'}]
  };
  /* v7.49：条件由 `!r.milestones` 收紧为 `r.milestones==null`。
     修复持久化后「删光节点」会存成空数组 []，而 `![]` 为 false —— 原写法碰巧也不会重新注入，
     但语义含混；显式判 null 才能准确表达「从未有过节点才注入演示数据」，
     避免将来有人误改成 `!r.milestones.length` 导致删光后演示数据复活。 */
  reqs.forEach(r=>{ if(MS_SEED[r.id] && r.milestones==null) r.milestones=MS_SEED[r.id]; });
})();
/* v7.05 联调「特殊类型」彻底取消：联调不再是独立 kind，而是普通特效需求 + mod='联调'。
   ---------------------------------------------------------------------------
   历史包袱：v6.90 之前联调是 kind:'lt' 并被 relinkLt() 挂成本体附属；v6.90 解除了附属关系，
   但 kind:'lt' 本身留着 → getPhases 仍给它 isLt:true、整条铺满紫色 .ph-lt，
   于是「同一个角色两条联调，一蓝一紫」这种视觉分裂长期存在。v7.05 收口：
   · 数据侧：9 条 kind:'lt' 全部迁移为 kind:'fx' + mod:'联调'（不删数据、不动排期）。
   · 代码侧：保留 kind==='lt' 的兼容分支（协作者可能还持有旧快照），但不再新建 lt。
   · 判定统一走 isLtReq()：既认旧的 kind==='lt'，也认新的 mod==='联调'。
   ---------------------------------------------------------------------------
   归一化角色名：防重复校验此前用 `r.char===host.char` 精确比对，而云端存在
   「比安卡」/「比安卡·寻 X 奈芙」、「女指挥官」/「女指挥官（S5.1）」这类同角色不同写法，
   导致校验被绕过、能重复建联调（lt_gaf25 就是这么来的）。改为取分隔符前的主名比对。 */
function charKey(c){
  return String(c||'').trim().split(/[·（(XＸx×\s]/)[0].trim().toLowerCase();
}
/* 是否属于「联调」需求：兼容旧 kind='lt' 与新 mod='联调' 两种表达 */
function isLtReq(r){ return !!r && (r.kind==='lt' || r.mod==='联调'); }
/* 该角色是否已存在联调需求（按归一化主名比对，跨 char 写法生效） */
function hasLtFor(charName){
  const k=charKey(charName);
  return reqs.some(r=>isLtReq(r) && charKey(r.char)===k);
}
/* 找某角色的「本体宿主需求」（出场_cc 优先，否则该角色首个特效需求）。与 relinkLt 的挂载规则保持一致。 */
function ltHostOf(charName){
  return reqs.find(r=>r.char===charName && r.kind==='fx' && /_cc$/.test(r.id))
      || reqs.find(r=>r.char===charName && r.kind==='fx' && !isLtReq(r))
      || reqs.find(r=>r.char===charName && r.kind!=='lt' && r.kind!=='qa');
}
/* v7.06：联调专属函数（addLt/quickLt/openEditLt/confirmEditLt/confirmAddLt/deleteLt）已全部移除。
   联调现在就是普通需求 —— 用「＋新需求」建、模块选「联调」即可，不再有独立入口与绑定工序。
   ltCtx 保留为 null 占位，避免历史残留引用报错。 */
let ltCtx=null;

/* ============ 修改需求信息 / 删除需求（需求级生命周期操作） ============ */
let erCtx=null;   // {reqId} —— 正在编辑信息的需求
/* 修改需求基本信息：名称 / 角色名 / 模块 / 品级 / 管线 / 工作量人天 / 已完成人天。
   两视图共用同一份数据，改后标题、标签、分组配色同步更新。联调(lt)走 openEditLt。 */
function openEditReq(reqId){
  if(!requireWrite()){hideMenu();return;}
  const r=reqs.find(z=>z.id===reqId && z.kind!=='lt'); if(!r){hideMenu();return;}
  hideMenu();
  erCtx={reqId:r.id};
  const gradeOpt=GRADE_OPTS_LIST.map(g=>`<option value="${g}" ${r.grade===g?'selected':''}>${g===''?'通用':g+'级'}</option>`).join('');
  const modOpt=MOD_OPTS_LIST.map(m=>`<option value="${m}" ${r.mod===m?'selected':''}>${m}</option>`).join('');
  const lineOpt=LINE_OPTS_LIST.map(l=>`<option value="${l[0]}" ${r.line===l[0]?'selected':''}>${l[1]}</option>`).join('');
  const g=HR_GRADE[r.grade]||HR_GRADE[''];
  const body=`
    <div class="ctx" style="background:#eef6ff;border-color:#bcd9f7;color:#185fa5">修改需求 <b>${escAttr(r.name)}</b> 的基本信息。改动后「按需求看 / 按人看」的标题、标签、分组配色会同步更新（共用同一份数据）。</div>
    <div class="row2">
      <div class="fld"><label>需求名称</label><input type="text" id="erName" value="${escAttr(r.name)}"></div>
      <div class="fld"><label>角色名</label><input type="text" id="erChar" value="${escAttr(r.char)}" placeholder="如：红蔻·赤焰"></div>
    </div>
    <div class="row2">
      <div class="fld"><label>模块</label><select id="erMod">${modOpt}</select></div>
      <div class="fld"><label>品级</label><select id="erGrade">${gradeOpt}</select></div>
    </div>
    <div class="row2">
      <div class="fld"><label>管线</label><select id="erLine">${lineOpt}</select></div>
      <div class="fld"><label>工作量（人天）</label><input type="number" id="erEst" value="${r.estimate}" min="1" step="1"></div>
    </div>
    <div class="row2">
      <div class="fld"><label>已完成人天</label><input type="number" id="erDone" value="${r.done||0}" min="0" step="1"></div>
      <div class="fld" style="display:flex;align-items:flex-end;color:var(--tx3);font-size:12px">当前：${g.label}级${r.line&&r.line!=='-'?' · '+lineName(r.line):''} · ${modMeta(r.mod).s||r.mod}</div>
    </div>
    <div class="warn" id="erWarn"></div>`;
  renderAddModal('✎', '修改需求信息', body, true);
  const ok=document.getElementById('addOk'); if(ok)ok.setAttribute('onclick','confirmEditReq()');
}
function confirmEditReq(){
  if(!erCtx)return;
  if(!requireWrite())return;
  const r=reqs.find(z=>z.id===erCtx.reqId); if(!r){closeAdd();return;}
  const warn=document.getElementById('erWarn');
  const name=(document.getElementById('erName').value||'').trim();
  if(!name){ warn.textContent='请填写需求名称'; warn.classList.add('show'); return; }
  const charV=(document.getElementById('erChar').value||'').trim();
  const est=Math.max(1,parseInt(document.getElementById('erEst').value,10)||r.estimate);
  const done=Math.max(0,parseInt(document.getElementById('erDone').value,10)||0);
  pushHistory();
  const oldChar=r.char;
  r.name=name;
  r.char = charV || name;
  r.mod = document.getElementById('erMod').value;
  r.grade = document.getElementById('erGrade').value;
  r.line = document.getElementById('erLine').value;
  r.estimate = est;
  r.done = done;
  if(oldChar!==r.char) relinkLt();   // 角色名变了 → 联调挂载关系需重算
  _logDesc='修改需求信息：'+name;
  save();broadcast();closeAdd();
  rerender();
  revealEntity('req', r.id);
  toast('需求信息已更新：'+name);
}
/* 删除整条需求（含其挂载的联调）。带确认、可撤销、可云同步；清除可能失效的选中/剪贴板引用。 */
function deleteReq(reqId){
  if(!requireWrite())return;
  const r=reqs.find(z=>z.id===reqId); if(!r)return;
  const isLt = isLtReq(r);
  const nm = r.name || (isLt ? charShort(r.char)+' 联调' : '');
  const extra = (!isLt && r.children && r.children.length) ? `\n\n该需求还挂着 ${r.children.length} 条联调，删除后联调也会一并移除。` : '';
  if(!confirm(`确定删除需求「${nm}」吗？\n删除后该需求及其所有任务条将永久移除，可用 Ctrl+Z 撤销。${extra}`)) return;
  pushHistory();
  const delIds=new Set([reqId, ...(r.children||[])]);
  for(let i=reqs.length-1;i>=0;i--){ if(delIds.has(reqs[i].id)) reqs.splice(i,1); }
  relinkLt();   // 重算其余联调挂载关系
  if(selectedBar && delIds.has(selectedBar.reqId)) setSelected(null);
  if(clip && delIds.has(clip.reqId)) clearClip();
  _logDesc='删除需求：'+nm;
  save();broadcast();rerender();
  toast('已删除需求：'+nm+'，可 Ctrl+Z 撤销');
}

/* ============ 人力分配数据（来源：当前人力分配脑图 / 企微表「当前人力分配」子表） ============ */
/* 结论：目前基地总人数 14 人，未来常规管线共缺 11 人（金角4人 / 橙角1号5人 / 橙角2号5人 / 红角11人） */
const HR_GRADE = {
  '金': {label:'金', col:'#f6cf3f'},
  '橙': {label:'橙', col:'#f59e0b'},
  '红': {label:'红', col:'#ef3b39'},
  '通用':{label:'通用',col:'#3b82f6'},
  '':   {label:'游离', col:'#9097a0'},
};
/* v6.19: 品级标签(.ld-ch)高对比度配色——解决浅色品级(金)在白底上看不清的问题 */
const LD_CH_STYLE = {
  '金': {bg:'linear-gradient(135deg,#fff8e6,#fef0c3)', color:'#92400e', border:'#f59e0b'},
  '橙': {bg:'linear-gradient(135deg,#fff7ed,#ffedd5)', color:'#c2410c', border:'#ea580c'},
  '红': {bg:'linear-gradient(135deg,#fef2f2,#fee2e2)', color:'#dc2626', border:'#ef3b39'},
  '通用':{bg:'linear-gradient(135deg,#eff6ff,#dbeafe)', color:'#1d4ed8', border:'#3b82f6'},
  '':  {bg:'linear-gradient(135deg,#f1f5f9,#e2e8f0)', color:'#475569', border:'#94a3b8'},
};
const HR_STATUS = {
  '启动中':  {col:'#16a34a', bg:'#e3f7e8', tx:'#1a8a3c'},
  '将要启动':{col:'#f59e0b', bg:'#fff1da', tx:'#b36b00'},
  '缺人':    {col:'#ef3b39', bg:'#ffe5e4', tx:'#d32320'},
  '':       {col:'#9097a0', bg:'#eef1f6', tx:'#646a73'},
};
// 模块 → [{role,grade,status,cfg,gap,makers:[],tmp:[],note}]

/* 动态品级：根据成员当前负责的角色线（hrData）取品级，而非成员固定属性。
   品级跟随任务/角色线绑定（金/橙/红），不是人的固有标签。
   优先级：金 > 橙 > 红；多角色线时取最高；未找到返回空字符串。 */
const GRADE_PRIORITY = ['金','橙','红','通用'];
function memWorkGrade(memId){
  const m = members.find(x=>x.id===memId); if(!m) return '';
  const nm = m.name;
  let found = '';
  hrData.forEach(mod=>mod.roles.forEach(r=>{
    if((r.makers||[]).some(n=>n===nm || String(n).replace(/[·\(].*$/,'')===nm)){
      // 取优先级最高的品级
      if(!found || GRADE_PRIORITY.indexOf(r.grade) < GRADE_PRIORITY.indexOf(found)) found = r.grade;
    }
    // 也检查 tmp（新人/临时）
    (r.tmp||[]).forEach(n=>{
      if(String(n).replace(/[·\(].*$/,'')===nm){
        if(!found || GRADE_PRIORITY.indexOf(r.grade) < GRADE_PRIORITY.indexOf(found)) found = r.grade;
      }
    });
  }));
  return found||'';
}

const hrData = [
  {mod:'出场', roles:[
    {role:'金（七十）',   grade:'金', status:'启动中',   cfg:4, gap:0, makers:['于航','彭诗淇','刘振山','宗丞'], tmp:[], note:'余洪震带 · 4人'},
    {role:'橙（露西亚·管线1）', grade:'橙', status:'启动中',   cfg:5, gap:3, makers:['杨光豪','张雍祺','李龙','曾俊杰'], tmp:['邹佳豪','张长喆','梁骏源'], note:'薛旭阳带 · 在编4人(杨光豪/李龙/曾俊杰/张雍祺)+新人1(邹佳豪)；张长喆/梁骏源已离职，仍缺3人'},
    {role:'橙（比安卡·管线2）', grade:'橙', status:'将要启动', cfg:1, gap:2, makers:['胡斯雨'], tmp:[], note:'余洪震统筹 · 目前仅胡斯雨1名基地，缺2人'},
    {role:'红（女指挥官）', grade:'红', status:'将要启动', cfg:1, gap:1, makers:['余洪震'], tmp:[], note:'余洪震带 · 本体/3C/出场/MVP/入局/TPP/大厅特效全包，缺1人补强'},
  ]},
  {mod:'检视', roles:[
    {role:'橙（露西亚）', grade:'橙', status:'启动中', cfg:2, gap:0, makers:['陈禹汗','陈琛'], tmp:[], note:'陈琛带'},
    {role:'橙（比安卡）', grade:'橙', status:'启动中', cfg:1, gap:0, makers:['郑博文'], tmp:[], note:'陈琛带'},
    {role:'红（女指挥官）', grade:'红', status:'将要启动',   cfg:1, gap:1, makers:['余洪震'], tmp:[], note:'余洪震带 · 缺1人'},
  ]},
  {mod:'组队', roles:[
    {role:'橙（露西亚）', grade:'橙', status:'启动中', cfg:0, gap:0, makers:[], tmp:[], note:'陈琛带 · 临时自消化'},
    {role:'橙（比安卡）', grade:'橙', status:'启动中', cfg:1, gap:0, makers:['娄佳俊'], tmp:[], note:'陈琛带'},
    {role:'红（女指挥官）', grade:'红', status:'将要启动',   cfg:1, gap:1, makers:['余洪震'], tmp:[], note:'余洪震带 · 缺1人'},
  ]},
  {mod:'饰品', roles:[
    {role:'常规饰品',     grade:'',  status:'', cfg:0, gap:0, makers:[], tmp:[], note:'陈琛带 · 常规饰品'},
    {role:'红（女指挥官）', grade:'红', status:'', cfg:0, gap:0, makers:[], tmp:[], note:'陈琛带'},
  ]},
  {mod:'入局Cuts', roles:[
    {role:'红（女指挥官）', grade:'红', status:'将要启动', cfg:1, gap:2, makers:['余洪震'], tmp:[], note:'余洪震带 · 缺2人'},
  ]},
  {mod:'TPP演绎（×3）', roles:[
    {role:'红（女指挥官）', grade:'红', status:'将要启动', cfg:1, gap:2, makers:['余洪震'], tmp:[], note:'余洪震带 · 豪华版+普通版×2，缺2人'},
  ]},
  {mod:'武器特效（支援·非角色特效模块）', roles:[
    {role:'—',          grade:'',  status:'启动中', cfg:1, gap:0, makers:['金潇'], tmp:[], note:'金潇暂时支援武器特效，不计入商业化角色特效需求'},
  ]},
  {mod:'3C相关', roles:[
    {role:'红（女指挥官）', grade:'红', status:'将要启动', cfg:1, gap:1, makers:['余洪震'], tmp:[], note:'余洪震带 · 走跑跳/双形态/切近战/披风PLUS，缺1人'},
  ]},
  {mod:'出场/MVP', roles:[
    {role:'红（女指挥官）', grade:'红', status:'将要启动', cfg:1, gap:1, makers:['余洪震'], tmp:[], note:'余洪震带 · 出场动画+MVP特效，缺1人'},
  ]},
];
const HR_CONCLUSION = {base:14, totalGap:11, detail:'金角4人 / 橙角1号5人 / 橙角2号5人 / 红角11人'};

/* 需求 → 基地制作人「标配人数」（应配编制，可按需调整）。
   缺口 = 标配 − 实际在岗基地人数，由 reqGapPpl(r) 动态算，加人/改派/离职后即时刷新。
   数据源优先级：STD_CFG 动态表（按品级×模块全匹配）> REQ_STD 硬编码（仅出场/本体等少数条目 fallback）。
   未列入的需求(联调等)默认无独立编制缺口(标配=0 → 不显示缺人徽标)。 */
/* ⚠️ v6.69 起本表已【废弃·不再参与任何计算】。仅保留作历史参考，随时可删。
   废弃原因：它与底部「出场标准工期 & 标配人力」表(STD_CFG)是两份互相矛盾的标准
   —— 例如它把 NV_bt(本体/3C) 记作 3 个基地，而 STD_CFG 的「3C相关」实为 1 个基地，
   模糊匹配失败时 fallback 到这里就产生了虚高缺口（用户实测「配置1人 缺2」应为「缺0」）。
   现在标配的唯一权威 = STD_CFG，查表入口 = stdCfgBaseForReq()。 */
const REQ_STD = {
  'LU_cc':3, 'BK_cc':3, 'BL_cc':3, 'HG_cc':3, 'AF_cc':3,   // 橙角出场：3 基地
  'QS_cc':4, 'HK_cc':4, 'CY_cc':4,                          // 金角出场：4 基地
  'NV_bt':3, 'NV_cc':3,                                     // 红角本体/出场：3 基地（MVP/入局/TPP/大厅/检视/组队默认标配0，需要可在此补）
};
/* 某需求当前「实际在岗基地制作人数」：去重；正编带队不占基地名额、跨队支援不抵消编制、离职不计。
   v6.64：补 segHasDuration 过滤 —— 零时长段在「按人看」不渲染，这里也不能凭它算人（三视图同源）。 */
function activeBase(r){
  const seen=new Set();
  (r&&r.segs||[]).forEach(s=>{
    if(!segHasDuration(s)) return;      // 零时长段：不是真实排期，不计
    const m=memById(s.m); if(!m) return;
    if(m.corp==='reg') return;          // 正编带队：统筹/带教，不占基地标配
    if(effLeft(m)) return;              // 已离职（离职日已到）：不计；未来离职日仍在岗计入
    if(isVacantMem(m)) return;          // 暂缺占位：不计入编制（仅占位）
    if(isSupportInReq(m,r)) return;     // 跨队支援：临时借调，不抵消本编制缺口
    seen.add(m.id);
  });
  return seen.size;
}
/* 某成员在 hrData 所有角色线中的缺口总和（用于按人看行内显示「缺N」徽标） */
function memGapCount(memId){
  const m=memById(memId); if(!m) return 0;
  const mn=m.name;
  let total=0;
  hrData.forEach(mod=>mod.roles.forEach(r=>{
    if(r.makers.includes(mn)||r.tmp.some(t=>t.replace(/\(.*\)/,'')===mn)){
      total+=Math.max(0,r.gap||0);
    }
  }));
  return total;
}
/* 从 STD_CFG 表的 ppl 文本中解析出数值化的标配人力 {reg, base}。
   解析规则（按常见写法）：
     "3 个基地人力"          → {reg:0, base:3}
     "3–4 个基地人力"        → {reg:0, base:3}  （区间取下限）
     "1 正编 + 3 个基地人力"  → {reg:1, base:3}
     "0.2 正编+1个基地人力"   → {reg:0.2, base:1}
     "按模块/缺口视图核定"等    → {reg:0, base:0}  （无法解析）
   返回值 base 用于与 HR 角色线的 cfg(基地在岗数) 对比算缺口。 */
function parseStdPpl(text){
  if(!text) return {reg:0,base:0};
  const t = String(text).trim();
  let reg=0, base=0;
  // 匹配 "N 正编" / "N正编" / "0.2 正编"
  const regM = t.match(/([\d.]+)\s*正编/);
  if(regM) reg = parseFloat(regM[1])||0;
  // 匹配 "M–N 个基地"（区间取下限 M）或 "N 个基地"（单值）
  const rangeM = t.match(/([\d.]+)\s*[-–~～]\s*([\d.]+)\s*个?\s*基地/);
  if(rangeM){
    base = parseFloat(rangeM[1])||0;   // 区间下限
  } else {
    const singleM = t.match(/([\d.]+)\s*个?\s*基地/);
    if(singleM) base = parseFloat(singleM[1])||0;
  }
  return {reg, base};
}
/* ============ v6.69 标准配置匹配：显式别名 + 严格匹配（唯一权威 = STD_CFG 表）============
   用户口径：「联调模块不用统计，只动态统计标准配置数据有的模块」。
   即 —— **底部「出场标准工期 & 标配人力」表里有的模块才统计缺口，没有的一律不统计**。

   v6.68 及之前的两个错误：
   ① 双向模糊匹配 `m.includes(e.mod) || e.mod.includes(m)` 既会漏也会误命中。
      典型漏配：需求 mod="本体/3C" 与表里 "3C相关" 互不包含 → 匹配失败。
   ② 匹配失败后 fallback 到硬编码 `REQ_STD[r.id]`，把 NV_bt 算成 3 个基地
      —— 而标准表里「3C相关」只需 1 个基地。结果李龙已在岗却仍显示「缺2」（用户截图）。

   v6.69 改法：用显式别名表把「需求里的写法」映射到「标准表里的写法」，只做精确相等匹配；
   映射不到 → std=0（不统计），不再有任何模糊猜测与硬编码兜底。
   新增模块时只需在 STD_CFG 加一行 + 在此别名表补一条映射，行为完全可预期。 */
const MOD_STD_ALIAS = {
  '出场':'出场',
  '检视':'检视1p+3p', '检视1p+3p':'检视1p+3p', '检视1p':'检视1p+3p',
  '组队':'组队',
  '入局':'入局Cuts', '入局Cuts':'入局Cuts',
  'TPP':'TPP*3', 'TPP*3':'TPP*3',
  'MVP':'红角 MVP', '红角MVP':'红角 MVP', '红角 MVP':'红角 MVP',
  '本体/3C':'3C相关', '3C':'3C相关', '3C相关':'3C相关', '本体':'3C相关',
  '大厅':'大厅待机', '大厅待机':'大厅待机',
  // 未列入的模块（联调 / 通用 / 饰品 / 武器特效 / bug修复 等）= 无标准编制，不统计缺口
};
const GRADE_STD_ALIAS = {'金':'金角','橙':'橙角','红':'红角','金角':'金角','橙角':'橙角','红角':'红角','通用':'通用'};
/* 查某需求在 STD_CFG 表中的标准基地编制。映射不到标准模块时返回 0（= 该模块不参与缺口统计）。 */
function stdCfgBaseForReq(r){
  if(!r) return 0;
  const stdMod = MOD_STD_ALIAS[r.mod || ''];
  if(!stdMod) return 0;                       // 模块不在标准配置表 → 不统计
  const g = GRADE_STD_ALIAS[r.grade || ''] || (r.grade || '');
  // 先按「品级×模块」精确匹配，再退到「通用×模块」（检视/组队在表里登记为通用品级）
  let entry = STD_CFG.find(e => e.grade === g && e.mod === stdMod)
           || STD_CFG.find(e => e.grade === '通用' && e.mod === stdMod);
  if(!entry || !entry.ppl || entry.ppl.includes('核定')) return 0;
  return parseStdPpl(entry.ppl).base || 0;
}

/* 动态人力缺口 = 标配 − 实际在岗（≥0）。
   v6.69：数据源收敛为**唯一权威 STD_CFG**（底部「出场标准工期 & 标配人力」表）。
   移除 REQ_STD 硬编码兜底 —— 它曾把「本体/3C」按 3 个基地算（标准表实为 1），造成虚高缺口。
   标准表里没有的模块（联调/通用/饰品/武器特效等）标配=0 → 恒不计缺口，符合团队口径。 */
function reqGapPpl(r){
  const std = stdCfgBaseForReq(r);
  if(std <= 0) return 0;                  // 无标准编制的模块：不统计缺口
  return Math.max(0, std - activeBase(r));
}
/* ============ 实时 HR 汇总：全部从 members + reqs 计算，不再依赖写死的 hrData ============
   - 基础编制：在岗（非离职）成员总数
   - 在岗制作人：在 reqs 里实际排了任务、且非离职的成员去重数（不含纯里程碑 qa）
   - 已配置岗位：各需求实际在岗基地人数之和（activeBase）
   - 缺口：Σ reqGapPpl(每条有标配的需求) + 暂缺占位成员数（名字含"暂缺"）
   - 等级缺口：按需求 grade 分组汇总 reqGapPpl
*/
function isVacantMem(m){ return m && /暂缺/.test(m.name||''); }
/* ============ v6.64 全视图统一口径（单一数据事实）============
   背景：HR 角色线、按人看、按需求看曾各自内联筛选条件，导致同一份数据在三个视图算出不同结果
   （零时长段有的算有的不算、离职成员有的留有的删、HIDE_DONE 直接参与统计）。
   原则：**筛选条件收敛为下列公共函数，任何视图不得再内联自己的判定。**

   segHasDuration(s)：任务段是否「有有效时长」——open 段(无明确时间)视为有效（铺满整行占位），
     普通段要求 e−s > 0。这是「这条排期是否真实存在」的唯一判定，
     渲染(personRowHTML/vacantRowHTML)与统计(buildRoleLines)必须同用。

   memCountsAsStaff(m)：该成员是否计入「在岗人力编制」——离职日已到 / 暂缺占位 均不计。
     注意与「是否出现在名单里」区分：离职者仍要在名单里显示(带已离标注)，只是不占编制数。 */
/* seg.open 类型规范化：从 boolean 升级为 string（'front'/'back'/'both'/null）。
   兼容旧数据：true → 'both'；false/undefined → null。 */
function segOpenType(s){
  if(!s || !s.open) return null;
  const t = String(s.open);
  if(t==='front' || t==='back' || t==='both') return t;
  return 'both';                       // 旧 true 或任何其它 truthy 值
}
function segHasDuration(s){
  if(!s) return false;
  if(segOpenType(s)) return true;      // 无明确时间段：铺满整行，视为有效占位
  return idx(s.e) - idx(s.s) > 0;      // 普通段：须有正时长
}
function memCountsAsStaff(m){
  if(!m) return false;
  if(effLeft(m)) return false;         // 离职日已到：不占在岗编制
  if(isVacantMem(m)) return false;     // 暂缺占位：不占编制（缺口另行统计）
  return true;
}
function computeHR(){
  // 在岗成员（排除已到离职日的人）
  const activeMems = members.filter(m=>!effLeft(m));
  const base = activeMems.length;
  // 暂缺占位成员（预排未到位，计入缺口）
  const vacantCount = members.filter(m=>isVacantMem(m) && !effLeft(m)).length;
  // 在岗制作人：在 reqs（非 qa 里程碑）里排了段的、非离职、非暂缺 成员去重
  const makerSet = new Set();
  let totalCfg = 0, totalGap = 0;
  const gradeGap = {金:0, 橙:0, 红:0};
  // 品级实人统计（在岗非暂非离，按成员.grade 聚合）
  const gradeCount = {金:0, 橙:0, 红:0, '':0};
  // 编制类型统计（在岗非暂非离）
  const corpCount = {reg:0, sub:0, base:0, loan:0};
  activeMems.forEach(m => {
    if(isVacantMem(m)) return;   // 暂缺不计入品级/编制实人
    const g = m.grade || '';
    gradeCount[g] = (gradeCount[g]||0) + 1;
    const c = m.corp || 'base';
    corpCount[c] = (corpCount[c]||0) + 1;
  });
  /* v6.72：品级缺口改为**复用 buildRoleLines() 的角色线结果**，不再自己按需求逐条累加。
     原因：按需求累加与角色线聚合是两套口径 —— 同一角色的多条需求（如荷光者出场+组队）
     会各自算一次缺口，而角色线是按 模块×角色 聚合后再算，两者数字必然对不上
     （截图中顶部"橙 缺14"明显高于下方角色线明细之和）。
     现在统一走角色线：顶部品级卡 = 下方明细的严格汇总，用户对得上账。 */
  reqs.forEach(r=>{
    if(r.kind==='qa') return;                     // 全量测试里程碑不计人力
    (r.segs||[]).forEach(s=>{
      if(!segHasDuration(s)) return;              // v6.64：零时长段不算真实排期（与按人看同源）
      const m=memById(s.m);
      if(!m||effLeft(m)||isVacantMem(m)) return;
      makerSet.add(m.id);
    });
    totalCfg += activeBase(r);                     // 实际在岗基地人数
  });
  // 缺口：以角色线为唯一口径（与「人力分配」视图下方明细完全一致）
  /* v6.74 品级缺口聚合修正（用户反馈"重复计算"）：
     v6.72 已解决「暂缺占位被多线各算一次」的问题（不再把 tmpCount 加入 gap），
     但 gradeGap 仍把同品级各角色线的 gap 累加（如 3 条橙线各缺 3 → 橙待补 9）。
     实际上同一批基地人力可跨角色线复用（时间分片/并行跟线），各线的缺口描述的是
     同一拨招聘需求的不同侧面，不应相加。
     改为取 max：该品级「最吃人」的那条角色线缺几个 → 最多就需要补几个。
     totalGap 同步改为「各品级 max 之和」（不同品级的人不可互通，故品级间仍求和），
     保证 totalGap 与 gradeGap 口径严格一致。 */
  try{
    (buildRoleLines()||[]).forEach(mo=>{
      (mo.roles||[]).forEach(rl=>{
        const g=rl.gap||0;
        if(g<=0) return;
        if(gradeGap[rl.grade]!==undefined) gradeGap[rl.grade] = Math.max(gradeGap[rl.grade] || 0, g);
      });
    });
    totalGap = Object.values(gradeGap).reduce((a,b)=>a+b, 0);   // 各品级 max 之和
  }catch(e){ console.warn('computeHR role-line gap failed',e); }
  /* v6.64 「缺少数」口径修正（与 v6.63 角色线同一个道理）：
     暂缺占位（vacantCount）与标配缺口（totalGap）描述的是**同一批要补的人**——
     「暂缺-基地2」这类占位就是已识别缺口的具象化，不是额外的新缺口。
     旧式 totalGap + vacantCount 把同一个人算两遍，故改为取 max。 */
  const lack = Math.max(totalGap, vacantCount);
  return {
    base,
    makers: makerSet.size,
    totalCfg,
    totalGap,                                       // 标配口径缺口（不含暂缺）
    vacantCount,
    lack,                                           // 缺少数 = max(标配缺口, 暂缺占位) —— 同一批人不重复计
    gradeGap,
    gradeCount,                                     // 品级→在岗实人数 {金:N, 橙:N, 红:N}
    corpCount,                                     // 编制→在岗人数 {reg:N, sub:N, base:N, loan:N}
  };
}
/* 兼容旧调用（按管线粗粒度），现已不参与风险计算 */
const LINE_GAP = { 'L1':3, 'L2':2, 'J':0, 'R':8, '-':0 };
const lineGap = line => LINE_GAP[line]||0;
/* 管线显示名（用于标签/tooltip） */
const LINE_NAME = { 'L1':'露西亚·管线1', 'L2':'比安卡·管线2', 'J':'七十·金角线', 'R':'女指挥官·红角线', '-':'通用' };
const lineName = line => LINE_NAME[line]||line;

/* 模块类型元数据：图标 + 主题色 + 短名，用于强化区分同角色不同模块的需求（出场/检视/组队/本体3C…）。
   ic=emoji图标, c=强调色(用于标签底色与左竖条), s=短名 */
const MOD_META = {
  '出场':            {ic:'🎬', c:'#e8590c', s:'出场'},
  '出场/MVP/入局':   {ic:'🎬', c:'#e8590c', s:'出场·MVP·入局'},
  'MVP':             {ic:'🏆', c:'#f08c00', s:'MVP'},
  '入局':            {ic:'🎞️', c:'#d9480f', s:'入局Cuts'},
  'TPP':             {ic:'🎭', c:'#c2255c', s:'TPP'},
  '大厅':            {ic:'🏛️', c:'#9c36b5', s:'大厅'},
  '检视':            {ic:'🔍', c:'#1098ad', s:'检视'},
  '组队':            {ic:'👥', c:'#7048e8', s:'组队'},
  '检视/组队':       {ic:'🔍', c:'#1098ad', s:'检视·组队'},
  '本体/3C':         {ic:'🧍', c:'#2f9e44', s:'本体·3C'},
  'TPP/大厅/检视组队':{ic:'🏛️', c:'#c2255c', s:'TPP·大厅·检视组队'},
  '武器特效':         {ic:'🗡️', c:'#868e96', s:'武器特效'},
  '通用':            {ic:'🧩', c:'#5c7080', s:'通用'},
  '联调':            {ic:'🔗', c:'#0e9aa7', s:'联调'},
  '全量测试':         {ic:'🐞', c:'#2b2f36', s:'全量测试'},
};
const modMeta = mod => MOD_META[mod] || {ic:'✦', c:'#646a73', s:mod||'其他'};
/* 模块「色族」：把 10+ 种零散主题色归并到业务大类色族，标签只用色族色着字，统一底色，去杂乱。
   出场系(暖橙) · 互动展示系(蓝紫) · 本体系(绿) · 中性/支援系(灰蓝) · 联调(独立青碧)。
   v7.06：联调从「中性灰蓝」独立出来——联调是贯穿所有模块的**需求类型**
   （每个模块都可能需要联调），不与出场/检视等具体模块并列，故给它专属色以便一眼区分。
   v7.24：联调专属色由深紫改青碧 #0e9aa7 —— 原紫与超期区/「超N周」徽标紫红撞色。 */
const MOD_FAM = {
  '出场':'#e8590c','出场/MVP/入局':'#e8590c','MVP':'#e8590c','入局':'#e8590c','入局Cuts':'#e8590c',
  'TPP':'#7048e8','大厅':'#7048e8','检视':'#7048e8','组队':'#7048e8','检视/组队':'#7048e8','TPP/大厅/检视组队':'#7048e8',
  '本体/3C':'#2f9e44',
  '联调':'#0e9aa7',
  '武器特效':'#5c7080','通用':'#5c7080','饰品':'#5c7080','全量测试':'#5c7080',
};
const modFamC = mod => MOD_FAM[mod] || '#5c7080';
/* 单击菜单里可快捷切换的模块类型（联调已纳入普通模块，与出场/检视/通用等并列）。 */
const MOD_PICK = ['出场','MVP','入局','TPP','大厅','检视','组队','本体/3C','武器特效','通用','联调'];

/* 角色配色：每个角色一个固定色，用于左侧竖带的「角色层」。与品级色、模块色错开色相，避免混淆。 */
const CHAR_COLOR = {
  '露西亚':'#6366f1', '比安卡':'#0ea5e9', '七十':'#d97706', '红蔻':'#db2777',
  'Cyndi':'#0891b2', '白老板':'#65a30d', '荷光者':'#7c3aed', '阿尔法':'#0d9488',
  '女指挥官':'#dc2626', '武器':'#64748b',
};
const CHAR_PALETTE=['#4f46e5','#0284c7','#ca8a04','#be185d','#0e7490','#4d7c0f','#6d28d9','#0f766e','#b91c1c','#475569','#9333ea','#c2410c'];
function charColor(cs){
  if(CHAR_COLOR[cs]) return CHAR_COLOR[cs];
  let h=0; for(let i=0;i<cs.length;i++) h=(h*31+cs.charCodeAt(i))>>>0;
  return CHAR_PALETTE[h%CHAR_PALETTE.length];
}

/* ============ 统一需求名称规范（两视图共用）============
   角色短名：去掉品级线/联动CP尾巴，保留主角色名（如「露西亚·誓焰 X 安琪儿」→「露西亚」）。
   完整角色名(含联动CP)作为副信息/悬停保留。 */
const charShort = char => String(char||'').split(/\s*[X×]\s*/)[0].split(/[·（(]/)[0].trim();
/* 统一规范的需求标题 HTML v4.8：横向单行、主次分明。
   任务名(白色大字)在左永远显示，模块/人天/投入比小徽标依次横排在右。
   opt = {pdays?: number, nShow?: 1..4}。nShow 控制显示几个信息位（含任务名）：
     4=任务名+模块+人天+投入比全显 / 3=去投入比 / 2=去人天+投入比 / 1=仅任务名。
   优先级「任务名 > 模块 > 人天 > 投入比」由高到低，窄条从右往左省略。 */
/* 字符串的横排宽度（以 em 计）：中文/全角≈1.0em，ASCII≈0.56em。仅用于竖排可行性粗判。 */
function strEmWidth(s){
  let w=0; for(const ch of String(s)){ w += /[\x00-\xff]/.test(ch) ? 0.56 : 1.0; } return w;
}
/* ============ v5.0 实测降级：不再用 em 预测，改为渲染后真实像素实测 ============
   预测式(v4.9)的 em 估算与浏览器真实渲染宽度对不上，导致竖排阈值几乎不触发、徽标乱裁切。
   v5.0 改为：DOM 画完后，对每根 .bar-task 的 .rt-line 逐个 measure，溢出则按优先级
   从低到高（rank 大先隐）隐藏徽标；隐藏到只剩任务名仍溢出 → 等比缩字号；缩到下限仍溢出
   且是短名(≤5字) → 竖排；否则 ellipsis 兜底。见 fitBarLabels()。 */
function reqTitleHTML(r, opt){
  opt=opt||{};
  const nShow=opt.nShow!=null?opt.nShow:4;
  const MM=modMeta(r.mod);
  const short=charShort(r.char)||r.name;
  const nm=`<span class="rt-nm" data-rank="1">${short}</span>`;
  const fc=modFamC(r.mod);   // 色族色：只用 4 个大类色着字/描边，底色统一
  // v5.0：始终输出全部信息位（模块 rank2 / 人天 rank3），实际显示几个交给渲染后的实测降级 fitBarLabels()。
  const mt=`<span class="rt-mod" data-rank="2" style="color:${fc};--mod-c:${fc}"><i class="rt-mi" style="filter:none">${MM.ic}</i>${MM.s}</span>`;
  // 人天徽标：
  //  · 「按人看」每条任务条传 opt.pdays = 该成员在本需求的个人投入(Σ投入比×效率)，显示个人量；
  //  · 「按需求看」不传 opt.pdays，显示整条需求总工作量 r.estimate。
  let md='';
  // v5.8：条上直接显示「≈X周」（用户选「直接换成周」更直观，无需再心算人天）；hover 保留人天原值+公式。
  const wkNum=n=>{const w=n/5;return (Math.round(w*10)/10).toFixed(1).replace(/\.0$/,'');};
  if(opt.pdays!=null){
    md=(opt.pdays>0)?`<span class="rt-md" data-rank="4" title="本人投入 ≈ ${wkNum(opt.pdays)}周全职（${opt.pdays}人天，1周=5个工作日）&#10;= 每天投入比 × 个人效率，逐日累加折算成的标准人天">≈${wkNum(opt.pdays)}<small>周</small></span>`:'';
  }else{
    md=(r.estimate>0)?`<span class="rt-md" data-rank="4" title="该需求总工作量 ≈ ${wkNum(r.estimate)}周全职（${r.estimate}人天，1周=5个工作日）&#10;= 全部参与成员的投入之和">≈${wkNum(r.estimate)}<small>周</small></span>`:'';
  }
  return `${nm}${mt}${md}`;
}
/* ============ 横向单行标签 v4.8：按条子像素宽度决定显示几个信息位 ============
   优先级 1=任务名 2=模块 3=人天 4=投入比。任务名永远显示（超长省略号），其余按宽度从右往左省略。
   估算每个信息位的横向占用（中文字宽约 fs、徽标含 padding+gap）：
   · 任务名：约 4 字 × 13.5 ≈ 54px（超长会被 ellipsis 截断，不影响下限）
   · 模块徽标：图标 + 2-3 字 ≈ 50px
   · 人天徽标：数字 + "人天" ≈ 46px
   · 投入比徽标：≈ 40px，gap 5px×3
   累计：4 位需 ≈ 205px / 3 位 ≈ 165px / 2 位 ≈ 115px / 1 位 ≈ 40px。
   阈值多留 10-15px 冗余，避免贴边溢出。 */
function calcNShow(barWpx){
  if(barWpx>=210) return 4;
  if(barWpx>=165) return 3;
  if(barWpx>=112) return 2;
  return 1;
}
/* 按条子像素高度选字号档：正常(1)/紧凑(2)。极矮多泳道条(barH<24)用紧凑档整体缩一号，仍单行。 */
function pickSizeTier(barHpx){ return barHpx<24 ? 2 : 1; }

/* ============ 按需求看：条内三阶段模型 L1 / L2 / 联调 ============
   - 特效本体区间 [s,e]：取该需求所有 segs 的最早开始~最晚结束。
   - L1(一审) + L2(二审) 平分本体区间，分界由 r.split（绝对日索引）决定，默认五五开。
   - 联调段 = 旧「附属」模式下、该需求 attached 子需求(联调)的区间。v6.90 起联调改为独立需求行，不再并入本体条（此分支保留兼容历史数据）。
   返回 {s,e,split,lt,barS,barE,l1,l2}；坐标均为「日索引」。 */
function getPhases(r){
  const s=Math.min(...r.segs.map(x=>idx(x.s)));
  const e=Math.max(...r.segs.map(x=>idx(x.e)));
  // v7.05：联调不再是特殊类型 —— kind:'lt' 已在数据层迁移为 kind:'fx' + mod:'联调'，
  //   转为与普通特效需求完全一致的 L1/L2 分段渲染，不再整条铺满紫色 .ph-lt。
  //   此分支仅为兼容协作者手上尚未刷新的旧快照（仍带 kind:'lt'）而保留。
  if(r.kind==='lt'){
    return {s,e,split:e,split2:null,lt:null,
      barS:s, barE:e,
      l1:{s,e:s}, l2:{s:e,e},     // L1/L2 宽度置 0，不渲染，整条由联调块占满
      lt2:{s,e}, isLt:true};      // 联调段占满整条
  }
  const addons=(r.children||[]).map(id=>reqs.find(x=>x.id===id)).filter(Boolean);
  let lt=null;
  if(addons.length){
    const aS=Math.min(...addons.flatMap(a=>a.segs.map(x=>idx(x.s))));
    const aE=Math.max(...addons.flatMap(a=>a.segs.map(x=>idx(x.e))));
    lt={s:aS,e:aE,ids:addons.map(a=>a.id),est:addons.reduce((t,a)=>t+a.estimate,0)};
  }
  let split=(r.split!=null)?r.split:Math.round((s+e)/2);
  split=Math.max(s+1,Math.min(e-1,split));        // 至少给 L1/L2 各留 1 天
  if(e-s<2) split=Math.max(s,Math.min(e,split));  // 区间过窄兜底
  const barE = lt?Math.max(e,lt.e):e;
  // L2/联调 分界 split2（联调开始时间，绝对日索引）：仅当存在联调段。
  // 【单一数据源】split2 直接派生自联调子需求的真实开始 lt.s —— 与「按人看」里那条联调任务条用的是同一份数据，
  // 从根上消除两视图脱钩（不再读独立存储的 r.split2；拖动分割线时改的是联调子需求的真实 segs，见 pointerup）。
  let split2=null;
  if(lt){
    split2=Math.max(split+1,Math.min(barE,lt.s));
  }
  return {s,e,split,split2,lt,
    barS:s, barE,
    l1:{s,e:split},
    l2:{s:split, e:(lt?split2:e)},
    lt2:(lt?{s:split2,e:barE}:null)};
}
// 拖拽 L2/联调 分割线时即时刷新左侧「+联调N工作日」文案（无需整页 rerender）
function updateLtMeta(reqId, ltDays){
  const el=document.getElementById('lt-meta-'+reqId); if(!el)return;
  el.innerHTML = ltDays>0 ? `+联调${ltDays}工作日` : '<span style="color:#a7adb8">联调已并入L2</span>';
}

/* ============ 计算工具 ============ */
const dayMs=864e5;
const idx = d => Math.round((d-START)/dayMs);
const i2d = i => new Date(START.getTime()+i*dayMs);
const isWE = i => {const d=new Date(START.getTime()+i*dayMs);const w=d.getDay();return w===0||w===6;};
/* ===== 节假日灰列配置
   数据来源：
   - 2026：国务院办公厅《关于2026年部分节假日安排的通知》（2025-11-04 发布）
   - 2027~2029：按2025新版《放假办法》推算（除夕纳入法定假，春节4天+调休8天，劳动节2天+调休5天，
     国庆3天+调休7天，元旦/清明/端午/中秋各1天+调休3天）。当年国务院公告发布后请更新为正式值。
   HOLIDAYS：法定放假日 → 标为节假日淡红灰；
   WORKMAKEUP：调休需要上班的周末/周日（即使周六日也不标灰，算工作日）。
   格式 'YYYY-M-D'，无前导零。改这两个集合即可，无需动其他代码。 */
const HOLIDAYS = new Set([
  // === 2026 年（国务院公告） ===
  // 元旦：1/1(四)–1/3(六)，共3天
  '2026-1-1','2026-1-2','2026-1-3',
  // 春节：2/15(日·腊廿八)–2/23(一·正月初七)，共9天（2026年新增为9天！）
  '2026-2-15','2026-2-16','2026-2-17','2026-2-18','2026-2-19','2026-2-20','2026-2-21','2026-2-22','2026-2-23',
  // 清明：4/4(六)–4/6(一)，共3天
  '2026-4-4','2026-4-5','2026-4-6',
  // 劳动节：5/1(五)–5/5(二)，共5天
  '2026-5-1','2026-5-2','2026-5-3','2026-5-4','2026-5-5',
  // 端午：6/19(五)–6/21(日)，共3天
  '2026-6-19','2026-6-20','2026-6-21',
  // 中秋：9/25(五)–9/27(日)，共3天
  '2026-9-25','2026-9-26','2026-9-27',
  // 国庆：10/1(四)–10/7(三)，共7天
  '2026-10-1','2026-10-2','2026-10-3','2026-10-4','2026-10-5','2026-10-6','2026-10-7',

  // === 2027 年（预计，以国务院公告为准） ===
  // 元旦：1/1(五)–1/3(日)，共3天
  '2027-1-1','2027-1-2','2027-1-3',
  // 春节：除夕=2/5(五)，新规除夕+春节4天+调休=9天（官方示例年份） 2/5–2/13
  '2027-2-5','2027-2-6','2027-2-7','2027-2-8','2027-2-9','2027-2-10','2027-2-11','2027-2-12','2027-2-13',
  // 清明：4/5(一)–4/7(三)，共3天（估算）
  '2027-4-5','2027-4-6','2027-4-7',
  // 劳动节：5/1(六)–5/5(三)，共5天（5/1-5/2法定+调休）
  '2027-5-1','2027-5-2','2027-5-3','2027-5-4','2027-5-5',
  // 端午：6/7(一)–6/9(三)，共3天（估算，农历五月初五≈6/7）
  '2027-6-7','2027-6-8','2027-6-9',
  // 中秋：9/15(三)（逢周三仅当日）/ 9/15–9/17（若调休）（估算）
  '2027-9-15','2027-9-16','2027-9-17',
  // 国庆：10/1(五)–10/7(四)，共7天
  '2027-10-1','2027-10-2','2027-10-3','2027-10-4','2027-10-5','2027-10-6','2027-10-7',

  // === 2028 年（预计，以国务院公告为准） ===
  // 元旦：1/1(六)–1/3(一)，共3天（跨周末）
  '2028-1-1','2028-1-2','2028-1-3',
  // 春节：除夕=1/26(三)，新规 1/26–2/2(七) + 调休 ≈ 1/26–2/3
  '2028-1-26','2028-1-27','2028-1-28','2028-1-29','2028-1-30','2028-1-31','2028-2-1','2028-2-2','2028-2-3',
  // 清明：4/4(二)–4/6(四)，共3天（估算）
  '2028-4-4','2028-4-5','2028-4-6',
  // 劳动节：5/1(一)–5/5(五)，共5天
  '2028-5-1','2028-5-2','2028-5-3','2028-5-4','2028-5-5',
  // 端午：5/28(日)–5/30(二)，共3天（估算，农历五月初五≈5/28）
  '2028-5-28','2028-5-29','2028-5-30',
  // 国庆+中秋合并：10/1(日)–10/8(二)，共8天（中秋=10/3 与国庆重叠）
  '2028-10-1','2028-10-2','2028-10-3','2028-10-4','2028-10-5','2028-10-6','2028-10-7','2028-10-8',

  // === 2029 年（预计，以国务院公告为准） ===
  // 元旦：1/1(一)–1/3(三)，共3天
  '2029-1-1','2029-1-2','2029-1-3',
  // 春节：除夕≈2/13(二)，新规 2/13–2/21（估算）
  '2029-2-13','2029-2-14','2029-2-15','2029-2-16','2029-2-17','2029-2-18','2029-2-19','2029-2-20','2029-2-21',
  // 清明：4/5(四)–4/7(六)，共3天（估算）
  '2029-4-5','2029-4-6','2029-4-7',
  // 劳动节：5/1(二)–5/5(六)，共5天
  '2029-5-1','2029-5-2','2029-5-3','2029-5-4','2029-5-5',
  // 端午：6/16(六)–6/18(一)，共3天（估算，农历五月初五≈6/16）
  '2029-6-16','2029-6-17','2029-6-18',
  // 中秋：9/24(二)–9/26(四)，共3天（估算，农历八月十五≈9/24）
  '2029-9-24','2029-9-25','2029-9-26',
  // 国庆：10/1(二)–10/7(一)，共7天
  '2029-10-1','2029-10-2','2029-10-3','2029-10-4','2029-10-5','2029-10-6','2029-10-7',
]);
/* 调休上班日（周末/周日因调休需要正常上班，不标休息日灰） */
const WORKMAKEUP = new Set([
  // === 2026 年 ===
  // 元旦调休：1/4(日) 上班
  '2026-1-4',
  // 春节调休：2/14(六·腊廿九) 上班、2/28(六) 上班
  '2026-2-14','2026-2-28',
  // 劳动节调休：5/9(六) 上班
  '2026-5-9',
  // 国庆调休：9/20(日) 上班、10/10(六) 上班
  '2026-9-20','2026-10-10',

  // === 2027 年（预计） ===
  // 元旦调休：1/4(日) 已是周日无需调休 / 1/9(五) 补班？
  '2027-1-4',
  // 春节调休：2/14(日) 上班？ 2/22(一)？
  '2027-2-14','2027-2-22',
  // 劳动节调休：5/9(日)？ 5/？
  '2027-5-8',
  // 国庆调休：9/26(日)？ 10/10(六)？
  '2027-9-26','2027-10-10',

  // === 2028 年（预计） ===
  // 元旦调休：1/4(二)？ 1/？
  '2028-1-4','2028-1-8',
  // 春节调休：1/25(二)？ 2/？
  '2028-1-23','2028-2-7',
  // 劳动节调休：5/？
  '2028-5-7',
  // 国庆+中秋调休：9/？ 10/？
  '2028-9-30','2028-10-12',

  // === 2029 年（预计） ===
  // 元旦调休
  '2029-1-5',
  // 春节调休
  '2029-2-9','2029-2-23',
  // 劳动节调休
  '2029-5-6',
  // 国庆调休
  '2029-9-29','2029-10-12',
]);
const dkey = i => {const d=new Date(START.getTime()+i*dayMs);return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();};
/* 返回该天灰列类型：'hol'=节假日 | 'we'=双休 | null=工作日(不标灰) */
const shadeType = i => {const k=dkey(i); if(WORKMAKEUP.has(k)) return null; if(HOLIDAYS.has(k)) return 'hol'; return isWE(i)?'we':null;};
/* v5.7 条内休息日暗块：给定任务条起止整天索引 [si0,ei0)，为其中每个休息日(周末/节假日)生成一块斜纹暗块，
   叠在进度层里表达「这天停工·不算人天产出」。left 相对 .prog 左缘(=si0*DAY_W 整天边界)按 (i-si0)*DAY_W 定位，天然对齐日期列。
   .prog 有 overflow:hidden，超出条体的部分自动裁掉。 */
function restBlocksHTML(si0, ei0){
  let s='';
  for(let i=si0;i<ei0;i++){ const t=shadeType(i); if(t){ s+=`<i class="rest ${t}" style="left:${(i-si0)*DAY_W}px;width:${DAY_W}px"></i>`; } }
  return s;
}
/* 第 i 天是否工作日（非周末且非节假日；调休上班的周末算工作日）——与休息日暗块口径完全一致 */
const isWorkday = i => shadeType(i)===null;
/* [a,b) 日索引区间内的工作日数（休息日不计） */
function workdaysIdx(a,b){ let n=0; for(let i=a;i<b;i++){ if(isWorkday(i)) n++; } return n; }
/* 给定 Date 对象，判断是否为工作日（与 isWorkday 完全一致口径：排除周末+法定节假日，
   调休上班日 WORKMAKEUP 算工作日）。供「逐日累加」类工时统计（按人/按段消化人天、
   投入比、负载窗口、并行峰值）统一使用，避免与超期/排期空隙/负载热力带口径不一致。 */
const isWorkdayD = d => isWorkday(Math.round((d-START)/dayMs));
/* ===== v5.8 按今天日期自动推进任务段的「状态 + 进度」（仅「按人看」） =====
   诉求：条颜色/进度不再靠手工字段，改为按当前日历日即时推算——到开始日自动由灰(未开始)变蓝(进行中)，
   进度随已过工作日增长（休息日不产出、进度不推进）。
   底线：人工已确认的「已完成 / 废弃」是数据事实，不被日期覆盖，避免「排期到了但没做完却显示已完成」的误导。
   返回 {status, prog}：status 用于着色(barCls)与状态标签，prog(0~1)用于进度填充。 */
function autoSegState(sg){
  if(sg.status==='done')    return {status:'done',    prog:1};
  if(sg.status==='dropped') return {status:'dropped', prog:(sg.prog||0)};
  // 无期限条(open)：无起止日，无法按日期推，沿用原字段
  if(sg.open) return {status:(sg.status||'doing'), prog:(sg.status==='todo'?0:(sg.prog||0))};
  const s=idx(sg.s), e=idx(sg.e), t=idx(TODAY);
  if(t<s)  return {status:'todo',  prog:0};                              // 今天还没到开始日 → 灰(未开始)
  // v5.9 逾期提醒：排期结束日已过、但没人工点「已完成」→ 橙色「逾期未完」，取代原先误导性的「蓝满格」。
  if(t>=e) return {status:'overdue', prog:1};
  // v5.9 进度对齐：改按「日历天」比例 (t-s)/(e-s)，而非工作日比例。
  //   因条左缘 x=s*DAY_W、今天红线 tx=t*DAY_W，故分界线绝对位置 = s*DAY_W + prog*(e-s)*DAY_W = t*DAY_W = 红线，
  //   所有进行中条的蓝白分界线精确落在同一条今天红线上（消除 −6~+11px 锯齿）。
  //   休息日「不产出」由条内斜纹暗块单独表达，不再折进进度百分比。
  const prog=Math.max(0,Math.min(1,(t-s)/Math.max(e-s,1)));
  return {status:'doing', prog};                                         // 进行中 → 蓝，分界线=今天
}
const fmt = d => (d.getMonth()+1)+'/'+d.getDate();
/* ============================================================
   v6.56 「含末日存储」口径迁移 —— 只在 I/O 边界转换
   ------------------------------------------------------------
   · 云端/localStorage 存的 e 是「含末日」（最后一个在排日），符合人的读法，前后段日期不重叠。
   · 运行时内存里的 e 仍是「排他式」终点（e = 最后一天 + 1），所有渲染/重叠判定/循环
     （for d=s; d<e）/工期统计等 20+ 处逻辑保持原样，零改动、零风险。
   · 边界转换：读入 +1（含末日 → 排他），写出 -1（排他 → 含末日）。
   · SNAP_VER 用于识别旧快照（无此字段 = 旧的排他式存储 → 读入时不做 +1，一次性自然升级）。
   ============================================================ */
const SNAP_VER = 2;                       // 2 = 含末日存储；缺失/1 = 旧的排他式存储
let _snapVerIn = SNAP_VER;                // 当前已加载快照的版本，供 applySnap 内部判断
/* 读入：把存储值转成内存用的排他终点 */
const eIn  = (v, ver) => (ver>=2 ? v+1 : v);
/* 写出：把内存的排他终点转成存储用的含末日 */
const eOut = v => v-1;
/* v6.55 结束日期「显示专用」格式化 —— 只影响显示，不动数据与渲染。
   底层 seg.e 是「排他式」终点（条宽 =(e-s)*DAY_W，实际画到 e-1 那天末尾），
   但过去直接用 fmt(seg.e) 显示，导致「前条末日」与「后条首日」是同一天（全表 40 对交接都这样），
   用户读起来像两条日期重叠了一天。此函数统一减 1 天，显示真正的「最后一个在排日」。
   注意：传入的是 Date 对象（i2d 转换后的），故减 1 天用毫秒运算。 */
const fmtEnd = d => fmt(new Date(d.getTime()-dayMs));
/* 同上，供 <input type="date"> 回填用：把排他终点转成含末日的日期对象 */
const dEndObj = d => new Date(d.getTime()-dayMs);
/* v7.37：工作日计数统一走 workdaysIdx（= isWorkday → shadeType），与「超期」「排期空隙」
   「负载热力带」完全同口径——排除周末+法定节假日，调休上班日算工作日。
   旧实现仅按 getDay() 跳过周末、漏排法定节假日，会导致工时/剩余窗口/消化人天多算节假日。 */
function workdays(a,b){ return workdaysIdx(Math.round((a-START)/dayMs), Math.round((b-START)/dayMs)); }
const memName=id=>{const m=members.find(m=>m.id===id);return m?m.name:id;};
const memById=id=>members.find(m=>m.id===id);
/* 视角团队：基于"我是"meId，判断某成员与我的关系。
   返回 'self'=我本人 | 'team'=与我同一带队团队(我带的人/带我的正编/同正编的同事) | '' 无关 */
function focusRole(m){
  const me=memById(meId); if(!me) return '';
  if(m.id===meId) return 'self';
  if(me.corp==='reg'){                 // 我是正编：我带的基地（lead==我名）属于我的团队
    if(m.lead===me.name) return 'team';
  }else{                               // 我是基地：我的带队正编 + 同带队的同事
    if(m.corp==='reg'&&m.name===me.lead) return 'team';
    if(m.lead && m.lead===me.lead) return 'team';
  }
  return '';
}
const memEff =id=>{const m=members.find(m=>m.id===id);return m?m.eff:1;};

/* ============ 效率系数档位（可编辑，驱动 eff → 产能/负载/风险） ============
   每档：{coef:系数, label:对应人群说明, mems:[成员id]}。
   档位的 coef 是该档全部成员 eff 的唯一来源；改档即改算法基线。 */
let EFF_TIERS = buildDefaultTiers();
let effLocked = true;  // 系数标定默认锁定，防误操作（在 snapshot/ORIG 之前声明，避免 TDZ）
let estRecalc = false; // 是否已用真实排期(投入比×效率)重算过占位工作量；一次性，随快照持久化
const EST_RECALC_VER = 4; // 重算口径版本：v1=初始；v2=投入比系数调整+跟进并行分摊；v3=所有跟进型消化系数归零（不消化人天）；v4=投入比区间模型(clamp(hi/并行数,lo,hi))
let estRecalcVer = 0;     // 已重算到的版本，随快照持久化
function buildDefaultTiers(){
  // 依据成员当前 eff 自动归档（保持初始数据语义），系数从高到低
  const meta=[
    {coef:1.10, label:'带队 / 资深老手'},
    {coef:1.05, label:'骨干'},
    {coef:1.00, label:'熟练基地（基准线）'},
    {coef:0.95, label:'稍弱'},
    {coef:0.90, label:'新人 / 在成长'},
    {coef:0.85, label:'新人 / 在成长'},
  ];
  const tiers=meta.map(t=>({coef:t.coef,label:t.label,mems:[]}));
  members.forEach(m=>{
    let bi=0,bd=1e9;
    tiers.forEach((t,i)=>{const d=Math.abs((m.eff!=null?m.eff:1)-t.coef);if(d<bd){bd=d;bi=i;}});
    tiers[bi].mems.push(m.id);
  });
  // 合并 label 相同且相邻的空理论档（0.90/0.85 都叫新人），但保留有人的档
  return tiers.filter((t,i)=>t.mems.length>0 || i<5);
}
// 把档位系数刷回每位成员 m.eff（成员落在哪档就取哪档系数）
function syncEffFromTiers(){
  const byMem={};
  EFF_TIERS.forEach(t=>{const c=Number(t.coef);if(!isFinite(c))return;(t.mems||[]).forEach(id=>{byMem[id]=c;});});
  members.forEach(m=>{ if(byMem[m.id]!=null) m.eff=byMem[m.id]; });
}
// 尚未分入任何档位的成员（含离职者，由 renderEffTable 负责灰化）
function unassignedMems(){
  const has={};EFF_TIERS.forEach(t=>(t.mems||[]).forEach(id=>has[id]=1));
  return members.filter(m=>!has[m.id]);
}
// 成员当前所在档 index，未分档返回 -1
function memTierIndex(id){
  for(let i=0;i<EFF_TIERS.length;i++){ if((EFF_TIERS[i].mems||[]).indexOf(id)>=0) return i; }
  return -1;
}
// 把某成员移入指定档（先从其它档/未分档清除，再加入），返回是否发生变化
function effMoveMemToTier(id, ti){
  if(ti<0||ti>=EFF_TIERS.length)return false;
  if((EFF_TIERS[ti].mems||[]).indexOf(id)>=0)return false; // 已在本档
  EFF_TIERS.forEach(t=>{t.mems=(t.mems||[]).filter(x=>x!==id);});
  EFF_TIERS[ti].mems.push(id);
  return true;
}

/* ============ 出场标准工期 & 标配人力（可编辑，按角色品级） ============
   每行：{grade:品级名, col:品级色, mod:模块类型, weeks:标准工期(制作), dur:展示时长(演出), ppl:标配人力说明}。
   注意：weeks=制作工期；dur=效果在游戏内的展示时间长度，二者含义不同不可混用。
   纯展示用配置表，可锁定/激活后编辑、增删行；纳入持久化与协同同步。 */
/* 品级色预设（不用系统调色板，只给金/橙/红三个固定值） */
const GRADE_PRESET = [
  {name:'金色', col:'#f6cf3f'},
  {name:'橙色', col:'#f59e0b'},
  {name:'红色', col:'#ef3b39'},
];
/* 品级定义：品级名 ⇆ 标准颜色 一一绑定。标准工期表的「品级」列从此用下拉选择，
   选中即自动套用对应颜色，不再手输文字、不再单独选色（颜色随品级走）。 */
const GRADE_DEFS = [
  {name:'金角', col:'#f6cf3f'},
  {name:'橙角', col:'#f59e0b'},
  {name:'红角', col:'#ef3b39'},
  {name:'通用', col:'#3b82f6'},
];
const gradeDef = name => GRADE_DEFS.find(d=>d.name===name);
function gradeOptsHTML(cur){
  let list=GRADE_DEFS.slice();
  if(cur && !list.some(d=>d.name===cur)) list=list.concat([{name:cur,col:''}]);  // 兜底：保留旧/自定义品级值
  return list.map(d=>`<option value="${effEsc(d.name)}"${d.name===cur?' selected':''}>${effEsc(d.name)}</option>`).join('');
}
/* v6.60：默认值补齐「制作工期」周数并与线上配置对齐（原来检视/组队/入局Cuts/TPP/MVP 的 weeks 为空，
   云端未加载时超期标注会因无标准而全部不显示）。品级/模块名沿用本表的长名写法，
   与需求侧短名（金/橙/红、检视、本体/3C…）的差异由 stdWeeksForReq 的归一化匹配吸收。 */
let STD_CFG = [
  {grade:'金角', col:'#f6cf3f', mod:'出场', dur:'20s',    weeks:'8 周',  ppl:'3–4 个基地人力'},
  {grade:'橙角', col:'#f59e0b', mod:'出场', dur:'40s',    weeks:'12 周', ppl:'1 正编 + 3 个基地人力'},
  {grade:'红角', col:'#ef3b39', mod:'出场', dur:'50s',    weeks:'16 周', ppl:'1 正编 + 3 个基地人力'},
  {grade:'通用', col:'#3b82f6', mod:'检视1p+3p', dur:'13-20s', weeks:'10 周', ppl:'0.2 正编+1个基地人力'},
  {grade:'通用', col:'#06b6d4', mod:'组队', dur:'10s',    weeks:'8 周',  ppl:'0.2 正编+1个基地人力'},
  {grade:'红角', col:'#8b5cf6', mod:'入局Cuts', dur:'20s', weeks:'8 周', ppl:'0.1 正编+ 1 个基地人力'},
  {grade:'红角', col:'#ec4899', mod:'TPP*3', dur:'15-20s', weeks:'10 周', ppl:'0.5 正编+ 1 个基地人力'},
  {grade:'红角', col:'#ef3b39', mod:'红角 MVP', dur:'15s', weeks:'8 周', ppl:'0.1 正编+ 1 个基地人力'},
  {grade:'红角', col:'#ef3b39', mod:'3C相关', dur:'20s',  weeks:'10 周', ppl:'0.5 正编+ 1 个基地人力'},
  {grade:'红角', col:'#ef3b39', mod:'大厅待机', dur:'10s', weeks:'5 周', ppl:'0.1 正编+ 1 个基地人力'},
];
let stdLocked = true;  // 标准工期表默认锁定，防误操作

/* 投入比 / 精力分配 档位（数据驱动、可编辑、带锁定）。v5.11 起改「区间」模型：
   每档有 [lo, hi] 区间——hi=独占（当天只跑这一条）时的投入比上限，lo=并行分摊的保底下限。
   当天有效投入比 = clamp(hi ÷ 当天并行条数, lo, hi)：独占取 hi，并行越多越往下降，触底 lo 后不再受并行影响。
   全人力 [0,1.0]（无保底，可自由 1/N 平摊）；完整跟进 [0.4,0.6]；部分跟进 [0.1,0.3]。
   val 保留=hi（独占上限，兼容旧字段/菜单选择时写入 seg.inv）。col=色块色, vbg/vfg=徽标底/字色, desc=规则, scene=场景。支援(外借)为固定行，不在此数组内。*/
let INV_TIERS = [
  {key:'full',  name:'全人力制作', val:1.0, lo:0,   hi:1.0, col:'#0a7d3c', vbg:'#e9f8ee', vfg:'#0a7d3c', desc:'全力投入单条产出（独占时 <b>1.0</b>）。当该成员同期还有其它需求时，当天精力在多条间<b>自动平摊</b>（并行 N 条则每条约 1/N），标签直接显示<b>分摊后的实际投入比</b>，无需手动设置、随排期实时变化。', scene:'主力特效师独立\n承制一条需求'},
  {key:'follow',name:'完整跟进', val:0.6, lo:0.4, hi:0.6, col:'#b36b00', vbg:'#fff1da', vfg:'#b36b00', desc:'持续跟进效果但非全力制作。投入比在 <b>0.4–0.6</b> 区间：独占时取上限 0.6，与其它需求并行时按条数摊薄，<b>但不低于下限 0.4</b>（跟进的最低精力）。不直接消化人天，但计入负载。', scene:'资深盯方向 /\n全程把控品质'},
  {key:'part',  name:'部分跟进', val:0.3, lo:0.1, hi:0.3, col:'#d6a000', vbg:'#fdf6e3', vfg:'#a07800', desc:'花一部分精力跟进反馈效果。投入比在 <b>0.1–0.3</b> 区间：独占时取上限 0.3，与其它需求并行时按条数摊薄，<b>但不低于下限 0.1</b>。不直接消化人天，但计入负载。', scene:'兼顾多条 /\n定期 review'},
];
let invLocked = true;  // 投入比表默认锁定，防误操作

/* v7.04 单一事实源修正：段状态一律走 autoSegState（按今天日期自动推进），
   与「按人看」每根子条完全同源。此前本函数直读 s.status 存储字段，导致同一需求
   在两视图状态打架 —— 典型症状：排期开始日已到（子条按人看已变蓝），但需求条仍显示
   灰色「未开始」（线上实测 48 条活跃需求中 13 条不一致，全为 todo↔doing）。
   优先级：缺失 > 全部完成 > 逾期 > 进行中/待处理 > 未开始。
   注意 autoSegState 会产出存储态没有的 'overdue'，必须显式接住，否则会掉进 else→todo。
   'done'(全段完成) 必须排在 'overdue' 之前 —— 否则整条已完成、但某段排期末日已过又没点完成的需求
   （如「七十 出场特效」5/6 段 done、reqState 已 done）会被判成「逾期未完」，
   与条体 b-done 的青绿视觉自相矛盾。 */
function aggStatus(r){
  const ss=r.segs.map(s=>autoSegState(s).status);
  if(ss.includes('blocked'))return 'blocked';
  if(ss.length&&ss.every(s=>s==='done'))return 'done';
  if(reqState(r)==='done')return 'done';
  if(ss.includes('overdue'))return 'overdue';
  if(ss.includes('doing')||ss.includes('review'))return 'doing';
  return 'todo';
}
/* 统一「需求是否已完成」判定：人工整条置完成(reqState=done)，或所有任务段都已完成的派生态(aggStatus=done)。
   两视图(按人看/按需求看)的「✓已完成」封存呈现一律以此为准，保证完全联动、所有人段同步。 */
function reqIsDone(r){ return reqState(r)==='done' || aggStatus(r)==='done'; }
/* 需求是否「已完成（须隐藏）」：人工态 done / 废弃 dropped / 派生态(段聚合 done) 任一即算。
   供「隐藏已完成」开关统一判定——与 reqClosed 等价(终态)，但独立命名便于语义。 */
function reqIsCompleted(r){ return reqState(r)==='done' || reqState(r)==='dropped' || aggStatus(r)==='done'; }

function reqRisk(r){
  // 终态需求（已完成/废弃）：不参与任何风险/产能/缺口计算，统一返回「无风险」占位。
  // 「已完成」含人工整条置位与「所有段都完成」的派生态(reqIsDone)，保证两视图封存联动后不再显红。
  if(reqClosed(r)||aggStatus(r)==='done'){
    const shown=[...new Set(r.segs.filter(s=>idx(s.e)>idx(s.s)).map(s=>s.m))];
    return {remain:0,left:0,ppl:shown.length,pplNames:shown.map(memName),cap:0,gap:0,lvl:'—',cls:'rk-low',txt:'b-gray',overloaded:[],gapPpl:0,started:false,cause:reqState(r)==='dropped'?'已废弃':'已完成'};
  }
  const remain = r.estimate - r.done;
  const left = Math.max(workdays(TODAY,r.end),0);
  // 仍在投入、未完成的任务段（用于产能计算：已完成/已结束的段不再贡献产能）
  const activeSegs = r.segs.filter(s=>s.e>=TODAY && s.status!=='done');
  // 去重到“人”，同一人多段不重复计数（产能口径）
  const memIds = [...new Set(activeSegs.map(s=>s.m))];
  // 展示口径：与「按人看」一致 —— 凡有有效时长(>0)的段都算参与该需求的人，无论是否已完成/已结束，
  // 保证两视图人员即时同步（拉满进度/改派后名字不再丢失）。
  const shownIds = [...new Set(r.segs.filter(s=>idx(s.e)>idx(s.s)).map(s=>s.m))];
  // 产能：超载成员对“单个需求”的有效产能按 1/负载比 折损（负载含其全部并行任务）
  const cap = left * memIds.reduce((sum,id)=>{
    const load = memLoad(id).pct;
    const of = load>100 ? 100/load : 1;   // 超载折损系数：170% → 0.59
    return sum + memEff(id)*of;
  },0);
  const gap = remain - cap;
  const ratio = remain>0 ? gap/remain : 0;
  // 维度A：产能/时间紧迫（0低 1中 2高）
  let capLvl = gap<=0 ? 0 : ratio<=0.2 ? 1 : 2;
  // 维度B：人力结构缺口 = 该需求标配 − 实际在岗基地人数（动态，加人/改派即时重算）。已开工且缺人=高(2)，未开工但缺人=中(1)
  const gapPpl = reqGapPpl(r);
  const started = r.segs.some(s=>s.status==='doing'||s.status==='review');
  let hrLvl = gapPpl<=0 ? 0 : (started ? 2 : 1);
  // 综合：取两维度较高者
  const score = Math.max(capLvl,hrLvl);
  const overloaded = memIds.filter(id=>memLoad(id).pct>110).map(memName);
  let lvl,cls,txt;
  if(score>=2){lvl='高';cls='rk-high';txt='b-red';}
  else if(score===1){lvl='中';cls='rk-mid';txt='b-amber';}
  else{lvl='低';cls='rk-low';txt='b-green';}
  // 风险主因，给 tooltip 用
  const cause = hrLvl>=capLvl && hrLvl>0 ? (started?`本需求缺${gapPpl}人且已开工`:`本需求缺${gapPpl}人(后续压力)`)
              : capLvl>0 ? '产能/工期偏紧' : '产能充足';
  return {remain,left,ppl:shownIds.length,pplNames:shownIds.map(memName),cap:Math.round(cap*10)/10,gap:Math.round(gap*10)/10,lvl,cls,txt,overloaded,gapPpl,started,cause};
}

/* ============ 产能消化分解：把"剩余工作量"按各制作人在剩余窗口内的预计产能拆开 ============
   口径与 reqRisk 完全一致：每人可消化人天 = 剩余工作日(left) × 效率(eff) × 超载折损(of)。
   返回 parts(每人一块)、totalCap(合计可消化)、gap(无法消化的缺口)、surplus(产能富余)。*/
function reqCapacityBreakdown(r){
  if(reqClosed(r)) return null;                 // 已完成/废弃需求不计产能
  const remain = Math.max(r.estimate - r.done, 0);          // 剩余工作量(人天)
  const left = r.end ? Math.max(workdays(TODAY,r.end),0) : 0;// 剩余工作日窗口
  const activeSegs = r.segs.filter(s=>s.e>=TODAY && s.status!=='done');
  const memIds = [...new Set(activeSegs.map(s=>s.m))];       // 去重到人(产能口径，与 reqRisk 一致)
  let parts = memIds.map(id=>{
    const load = memLoad(id).pct;
    const of = load>100 ? 100/load : 1;                     // 超载折损系数(与 reqRisk 同口径)
    const cap = left * memEff(id) * of;                     // 该人在剩余窗口内预计可消化人天
    const m = members.find(x=>x.id===id);
    return { id, name:memName(id), cap, eff:memEff(id), load, of, lead:leadOf(m), col:corpStyle(m).col };
  }).filter(p=>p.cap>0 && p.name);
  // 同隶属相邻、产能大的在前 —— 与人员标签的分组排序视觉呼应
  parts.sort((a,b)=> (a.lead||'~').localeCompare(b.lead||'~','zh-Hans-CN') || b.cap-a.cap);
  const totalCap = parts.reduce((s,p)=>s+p.cap,0);
  const gap = Math.max(remain - totalCap, 0);               // 无法消化的工作量
  const surplus = Math.max(totalCap - remain, 0);           // 产能富余
  return { remain, left, parts, totalCap, gap, surplus };
}

const r1=v=>Math.round(v*10)/10;
const r2=v=>Math.round(v*100)/100;   // 两位小数（分摊后投入比展示）

/* ============ 投入比（精力分配）口径 ============
   消化人天 = Σ(每个工作日的投入比) × 效率系数。投入比分两类：
   ① 跟进型：seg.inv 显式 <1（部分跟进 0.2~0.3 / 完整跟进 0.5）——该人本来就只投入部分精力，
      固定折算，不参与并行分摊；
   ② 全人力制作：seg.inv 未设或 =1 —— 该人当天若同时在跑 N 条「全人力制作」段，
      当天对每条的投入比自动平摊为 1/N（并行越多、单条消化越慢）。
   support（支援）只表编制隶属，不打折。 */
function segIsFollow(s){ return s.inv!=null && s.inv<1; }        // 跟进型(独占上限<1)
/* 任务段的「区间」[lo,hi]：hi=独占时投入比上限，lo=并行分摊保底下限。
   seg.inv 记录的是该段档位的 hi 值（完整跟进 0.6 / 部分跟进 0.3 / 未设=全人力 1.0）。
   反查 INV_TIERS 拿该档的 lo；查不到（自定义历史值）则按「跟进型 lo=hi 的一半、全人力 lo=0」兜底。 */
function segInvRange(s){
  const hi = (s.inv!=null && s.inv<1) ? s.inv : 1;
  if(hi>=1) return {lo:0, hi:1};                                  // 全人力：可自由 1/N 平摊，无保底
  const tier = (typeof INV_TIERS!=='undefined') ? INV_TIERS.find(t=>Math.abs((t.hi!=null?t.hi:t.val)-hi)<1e-6) : null;
  const lo = tier ? (tier.lo!=null?tier.lo:hi) : Math.round(hi*0.5*100)/100;
  return {lo, hi};
}
/* 任务段的「独占投入比上限」hi（兼容旧 segInvBase 调用点）。 */
function segInvBase(s){ return segInvRange(s).hi; }
/* 任务段的「消化系数」：决定该段投入比折算成多少「消化人天」。
   · 全人力制作 → 1.0（全额消化）；
   · 所有跟进型(完整跟进 0.4 / 部分跟进 0.2 / 自定义跟进) → 0（只跟反馈、不直接产出，不消化人天）。
   注意：本系数只作用于「消化人天」口径，不改变每日精力并行分摊(segEffInvOnDay)。
   旧版本曾对其它跟进型保留 0.5 减半，自 v3 起所有跟进型一律不消化。 */
function segDigestFactor(s){
  if(!segIsFollow(s)) return 1;                       // 全人力：全额消化
  return 0;                                          // 所有跟进型：不消化人天
}
/* 某人在某工作日的「并行段数」：当天所有在排段（含跟进，不含 open/废弃）的条数。
   用作每档独立分摊的分母：并行越多，各档投入比越往区间下限收敛。 */
function personDayWeightSum(id, t){
  let n=0;
  reqs.forEach(rr=>{
    if(reqState(rr)==='dropped') return;
    rr.segs.forEach(s=>{
      if(s.m!==id || s.open) return;
      if(t>=s.s.getTime() && t<s.e.getTime()) n++;
    });
  });
  return n;
}
/* 某段在某工作日「分摊后的有效投入比」：clamp(hi / 当天并行条数, lo, hi)。
   独占(并行=1) → hi（区间上限）；并行越多 → 越低，但触底 lo 后不再受并行影响。 */
function segEffInvOnDay(s, t){
  const {lo,hi}=segInvRange(s);
  const n=Math.max(1, personDayWeightSum(s.m, t));
  const v=hi/n;
  return Math.min(hi, Math.max(lo, v));
}
/* 某段在其全部工作日上的「平均有效投入比」与是否被分摊（用于标签数字）。 */
function segAvgEffInv(s){
  let sum=0, days=0, shared=false;
  const {hi}=segInvRange(s);
  for(let t=s.s.getTime(); t<s.e.getTime(); t+=dayMs){
    if(!isWorkdayD(new Date(t))) continue;        // 仅工作日：排除周末+法定节假日（v7.37 口径统一）
    const e=segEffInvOnDay(s,t); sum+=e; days++;
    if(e < hi-1e-6) shared=true;                  // 低于独占上限 → 被并行摊薄过
  }
  return { avg: days? sum/days : hi, days, shared, wt:hi };
}
/* 任务段的投入比徽标：直接显示「分摊后的实际投入比数字」（不显示固定系数 / 1/N 算法）。
   颜色：跟进型=琥珀、被并行分摊=紫、独占满额=蓝。 */
function segInvBadge(s, nShow){
  // v5.0：始终输出投入比徽标（rank4，最低优先级）。实际显示与否交给渲染后 fitBarLabels() 实测降级。
  const ae=segAvgEffInv(s);
  const num=r2(ae.avg);                            // 分摊后的有效投入比（保留两位小数）
  const follow=segIsFollow(s);
  const cls = follow ? 'follow' : (ae.shared ? 'par' : 'full');
  const {lo,hi}=segInvRange(s);
  const rgTxt = follow ? `（区间 ${lo}–${hi}）` : '';
  const tip = ae.shared
    ? `占 ${num}：与同期其它需求并行、按条数在区间内摊薄后的实际值${rgTxt}`
    : `占 ${num}：本段独占该成员精力，取${follow?'区间上限':'满额'} ${hi}${rgTxt}`;
  // v5.9：前缀「投」→「占」，更直白地表达「这条占该成员当天多少精力」（占用比），0.64=占了六成精力。
  return `<span class="rt-inv ${cls}" data-rank="5" title="${tip}"><i class="inv-k">占</i><b>${num}</b></span>`;
}
/* 任务段是否处于「已完成」终态：需求级被人工置为已完成/全段完成派生态(reqIsDone)，或该段自身=已完成。 */
function segIsDone(r,s){ return reqIsDone(r) || (s&&s.status==='done'); }
/* 「按人看」条内「✓已完成」徽标：
   - 整条完成(reqIsDone)：所有人段一律显示深绿封存印章「✓ 已完成」；
   - 仅本人这段完成(s.status==='done' 但整条未完成)：显示浅色「✓ 本人完成」，提示这段收尾、整条仍在进行。 */
function segDoneBadge(r,s){
  if(reqIsDone(r)) return `<span class="rt-done" data-rank="3" title="该需求已完成、信息锁定">✓ 已完成</span>`;
  if(s && s.status==='done') return `<span class="rt-done seg" data-rank="3" title="${memName(s.m)}这段已完成，整条需求仍在进行">✓ 本人完成</span>`;
  return '';
}
/* v5.9 逾期徽标：排期结束日已过、但没人工点「已完成」→ 条上橙色「⚠ 逾期未完」提醒收尾。
   仅在 autoSegState 判为 overdue 时插入（rank3，与完成印章同级，尽量保命）。 */
function segOverdueBadge(){ return `<span class="rt-late" data-rank="3" title="排期结束日已过，但尚未人工确认完成 → 请尽快收尾或调整排期">⚠ 逾期未完</span>`; }

/* v6.38 超标准工期标注：从 STD_CFG 按 (r.grade, r.mod) 查制作工期（周），与段实际【工作日】数对比。
   标准工期为空或0时不显示；实际 ≤ 标准 不显示；超出时返回紫红色「📏 超 N周」徽标。
   v7.x 起统一为工作日口径（与 overdueWorkdays / 工时统计一致）：actual 与 std 均只数工作日，
   排除周末+法定节假日、计入调休。标准工期(制作)按 5 个工作日/周折算；无假期内显示值与旧日历口径完全一致
   （两侧同乘 5/7，÷7 与 ÷5 抵消），仅跨春节等长假期时不再把假日计入超期。

   v6.57 关键修复：原来用严格相等匹配，但两边键名体系根本不同 → 44 个需求 100% 匹配失败、徽标从未出现过。
     · 品级：STD_CFG 写「金角/橙角/红角」，需求写「金/橙/红」
     · 模块：STD_CFG 写「检视1p+3p / 3C相关 / 大厅待机 / 红角 MVP」，需求写「检视 / 本体/3C / 大厅 / MVP」
   改为归一化后匹配：品级去掉「角」字后比较；模块用「归一别名 + 双向包含」兜底。
   通用级(STD_CFG 的 grade="通用")对任何品级都可作为兜底标准，优先精确品级、其次通用。 */
const _normGrade = g => String(g||'').replace(/角/g,'').trim();
/* 模块归一：统一到需求侧的短名，双向兼容 */
const _MOD_ALIAS = {
  '检视1p+3p':'检视', '检视1P+3P':'检视', '检视1p':'检视', '检视3p':'检视',
  '3C相关':'本体/3C', '本体/3C':'本体/3C', '本体&3C':'本体/3C', '3C':'本体/3C',
  '大厅待机':'大厅', '大厅':'大厅',
  '红角 MVP':'MVP', '红角MVP':'MVP', 'MVP':'MVP',
  '入局Cuts':'入局', '入局':'入局',
  'TPP*3':'TPP', 'TPP':'TPP'
};
const _normMod = m => {
  const raw = String(m||'').trim();
  if(_MOD_ALIAS[raw]) return _MOD_ALIAS[raw];
  return raw;
};
function stdWeeksForReq(r){
  const g = _normGrade(r.grade), m = _normMod(r.mod);
  if(!m) return 0;
  /* v6.60 严格解析「制作工期」：必须形如「N 周」才认；空值或「15-20s」这类展示时长一律返回 0。
     原正则 /(\d+(?:\.\d+)?)\s*周?/ 里「周」是可选的 → 会把 "15-20s" 误读成 15 周、"20s" 读成 20 周，
     导致标准工期被张冠李戴（如 TPP 标准 10 周被读成别的值），超期量算错。 */
  const weeksOf = e => {
    const mch = String(e.weeks||'').match(/(\d+(?:\.\d+)?)\s*周/);   // 「周」为必需
    return mch ? parseFloat(mch[1]) : 0;
  };
  // 模块是否视为同一项：归一后相等，或一方包含另一方（如「组队」vs「组队特效」）
  const modHit = e => {
    const em = _normMod(e.mod);
    if(!em) return false;
    if(em === m) return true;
    return em.includes(m) || m.includes(em);
  };
  /* 候选筛选后取「有有效周数」的那条 —— 避免选中一条 weeks 为空的同名配置就直接返回 0，
     而实际另有一条同模块、带周数的配置可用（STD_CFG 里同 mod 可能存在多行）。 */
  const pick = list => { for(const e of list){ if(weeksOf(e)>0) return e; } return null; };
  // ① 品级精确（归一后）+ 模块命中
  let entry = pick(STD_CFG.filter(e => _normGrade(e.grade) === g && modHit(e)));
  // ② 退而求其次：STD_CFG 里标为「通用」的行，对任何品级都适用
  if(!entry) entry = pick(STD_CFG.filter(e => _normGrade(e.grade) === '通用' && modHit(e)));
  if(!entry) return 0;
  return weeksOf(entry);
}
/* v6.58：超工期改为「条内区域标注」（替代 v6.38 的 rt-ovr 文字徽标）。
   在条内部按天比例定位：left = 标准工期占比，right = 0（一直铺到条尾），
   即视觉上「从标准工期结束那天起、到实际结束」的这段被斜纹罩住 + 起点一条竖分界线。
   优点：能直接看出超了多长、超在哪一段时间，不占用条内文字位（窄条也不会挤掉任务名）。
   返回值直接拼进 .bar-task 内部（同 .prog 层级），故必须是绝对定位元素。 */
function segStdOverflowZone(seg, r, m){
  /* v6.76 正编/子公司成员不显示超标准工期标注（用户要求：他们的条上不要有超期标记） */
  if(m && (m.corp==='reg'||m.corp==='sub')) return '';
  const stdWks = stdWeeksForReq(r);
  if(stdWks <= 0) return '';
  if(seg.open) return '';                                    // 时间待定的长期条无实义窗口，不标
  /* v7.x 统一为工作日口径（与 overdueWorkdays / 工时统计完全一致）：actual 与 std 均只数工作日，
     排除周末+法定节假日、计入调休。拖动条形跨春节等长假期时，假日不计入超期，
     消除「工作日没增加、超期周数却跳变」的口径不一致。
     标准工期(制作)按 5 个工作日/周折算 —— 无假期内显示值与旧版日历口径完全一致（两侧同乘 5/7，÷7 与 ÷5 抵消）。 */
  const actualWD = workdaysIdx(idx(seg.s), idx(seg.e));       // 该段实际工作日数（e 为排他终点）
  const stdWD   = Math.round(stdWks * 5);                      // 标准工期 → 工作日数（5 天/周）
  if(actualWD <= stdWD || actualWD <= 0) return '';
  const ovrWD  = actualWD - stdWD;
  const ovrWks = (ovrWD / 5).toFixed(1);                       // 超出周数（按 5 工作日/周）
  // 标准工期结束点在条内的百分比；上限 96% 保证极小超期量也有可见宽度（否则 0.4 周会窄到看不见）
  const leftPct = Math.min(96, stdWD / actualWD * 100).toFixed(3);
  const tip = `📏 超出标准工期　该段排期 ${actualWD} 个工作日（已排除周末与法定节假日）｜标准 ${stdWks} 周（${stdWD} 个工作日）｜超出 ${ovrWD} 个工作日（≈${ovrWks} 周）　斜纹区即超期部分，建议核查或调整排期`;
  return `<i class="ovr-zone" style="left:${leftPct}%" title="${escAttr(tip)}"><b class="ovr-tag">超${ovrWks}周</b></i>`;
}
/* v7.36 工作日口径「超期」核算 —— 实际排期结束日 vs 计划完成日(r.end)，仅数工作日。
   与休息日暗块/排期空隙提示完全同口径：均经 isWorkday()→shadeType() 排除周六日 + HOLIDAYS，
   调休上班日(WORKMAKEUP)计入工作日。节假日集合 HOLIDAYS/WORKMAKEUP 在文件顶部可配置。 */
function reqActualEndDate(r){ let d=null; (r.segs||[]).forEach(s=>{ if(s.open) return; if(!d||s.e>d) d=s.e; }); return d; }   // 各分段最晚结束日(排他 Date)，无日期段返回 null
function overdueWorkdays(r){
  if(!r||!r.end) return 0;
  const P = idx(r.end);                                    // 计划完成日索引（r.end 为含末日日历日）
  let A = -1; (r.segs||[]).forEach(s=>{ if(s.open) return; const e=idx(s.e); if(e>A) A=e; });   // 实际排期最晚结束日(排他索引)
  if(A <= P) return 0;                                     // 实际结束日 ≤ 计划完成日 → 不超期
  return workdaysIdx(P+1, A);                              // 仅工作日：(P, A] 区间内、shadeType 为 null 的天数 = 超期工作日数
}
function overdueTipText(r,n){
  const a = reqActualEndDate(r);
  return `<br><span class='g'>超期</span> ${n} 个工作日（已排除周末与法定节假日）　<span class='g'>计划完成</span> ${fmt(r.end)}　<span class='g'>实际结束</span> ${a?fmtEnd(a):'—'}`;
}
function segOverdueWDBadge(n){ return `<span class="rt-ovrwd" data-rank="3" title="实际排期结束日已晚于计划完成日，按工作日(排除周六日+法定节假日)核算超期 ${n} 天">⏰ 超期${n}工作日</span>`; }

/* 某人在某个工作日「全人力制作」的并行段数（用于自动分摊；跟进型不计入分摊分母） */
function personDayFullCount(id, t){
  let n=0;
  reqs.forEach(rr=>{
    if(reqState(rr)==='dropped') return;
    rr.segs.forEach(s=>{
      if(s.m!==id || s.open) return;
      if(segIsFollow(s)) return;                    // 跟进型不参与并行分摊计数
      if(t>=s.s.getTime() && t<s.e.getTime()) n++;
    });
  });
  return n;
}
/* 某人全排期的「全人力并行峰值」：在其所有全人力段覆盖的工作日里，单日最大并行条数。
   ≥2 表示此人存在并行需求 → 其所有全人力段统一按「并行人力制作」呈现（人级判定，避免同人段间割裂）。
   带缓存，render 周期内复用，避免 O(段²×天) 重复扫描。 */
let _peakParCache=null;
function _resetPeakParCache(){ _peakParCache=null; }
/* 排期空隙提示缓存：key=成员id，value=该人「空闲区间」数组 [{x0,x1,days}](天索引)。
   在 personRowHTML 渲染时按真实数据填充，paint 后由 injectGapIndicators 单独注入 DOM（出错只影响该块，绝不白屏）。 */
let gapData=new Map();
function personPeakPar(id){
  if(_peakParCache && _peakParCache.has(id)) return _peakParCache.get(id);
  if(!_peakParCache) _peakParCache=new Map();
  let mx=1;
  reqs.forEach(rr=>{
    if(reqState(rr)==='dropped') return;
    rr.segs.forEach(s=>{
      if(s.m!==id || s.open || segIsFollow(s)) return;
      for(let t=s.s.getTime(); t<s.e.getTime(); t+=dayMs){
        if(!isWorkdayD(new Date(t))) continue;    // 仅工作日：排除周末+法定节假日（v7.37 口径统一）
        const n=personDayFullCount(id,t)||1; if(n>mx) mx=n;
      }
    });
  });
  _peakParCache.set(id,mx);
  return mx;
}
/* 计算某人在某需求的「已消化工作量」：逐工作日累加分摊后投入比，再 × 效率。
   统一权重模型：全人力/跟进都按各自权重参与当天并行分摊（segEffInvOnDay）。 */
function digestPersonReq(r, id){
  const psegs = r.segs.filter(s=>s.m===id && idx(s.e)>idx(s.s) && !s.open);
  const eff = memEff(id);
  let investWD=0, invSum=0, doneSum=0, hasFollow=false, hasFull=false, effSum=0, effDays=0;
  psegs.forEach(seg=>{
    const follow = segIsFollow(seg);
    if(follow) hasFollow=true; else hasFull=true;
    const df = segDigestFactor(seg);                  // 消化系数：全人力1 / 任何跟进型0
    const pgr = (seg.prog!=null?seg.prog:0);          // 该段进度(用于折算已消化)
    for(let t=seg.s.getTime(); t<seg.e.getTime(); t+=dayMs){
      if(!isWorkdayD(new Date(t))) continue;        // 仅工作日：排除周末+法定节假日（v7.37 口径统一）
      investWD++;
      const inv = segEffInvOnDay(seg, t) * df;       // 分摊后的当天有效投入比 × 消化系数
      invSum  += inv;
      doneSum += inv * pgr;                          // 按段进度折算的已消化投入
      effSum += inv; effDays++;
    }
  });
  const avgEff = effDays ? effSum/effDays : 1;       // 平均有效投入比(用于 tip 说明)
  const followPct = hasFollow ? segInvBase(psegs.find(segIsFollow)) : null;
  // digest=全投入消化(估总量) · digestDone=按进度折算的已完成消化(两者同口径,× 效率)
  return { investWD, invSum:r1(invSum), eff, digest:r1(invSum*eff), digestDone:r1(doneSum*eff), hasFollow, hasFull, avgEff:r2(avgEff), followPct };
}
/* 单段消化人天：只算这一个段的「分摊后投入比 × 消化系数 × 效率」。
   用途：让任务条上的人天徽标只显示本段贡献量——跟进段天然=0（隐藏），全人力段显示自身贡献。*/
function segDigestOne(r, seg, id){
  const eff = memEff(id);
  const df = segDigestFactor(seg);
  const pgr = (seg.prog!=null?seg.prog:0);
  let invSum=0, doneSum=0;
  for(let t=seg.s.getTime(); t<seg.e.getTime(); t+=dayMs){
    if(!isWorkdayD(new Date(t))) continue;          // 仅工作日：排除周末+法定节假日（v7.37 口径统一）
    const inv = segEffInvOnDay(seg, t) * df;
    invSum += inv; doneSum += inv * pgr;
  }
  return { digest:r1(invSum*eff), digestDone:r1(doneSum*eff) };
}
/* 用真实排期重算每条需求的「总工作量 estimate / 已完成 done」,替换最初手填的占位数。
   estimate = Σ各参与成员( Σ每工作日投入比 × 效率系数 )——天然含投入比与效率两个因子;
   done     = 同式,但每个工作日再乘该段当前进度 prog,故 remain=estimate-done 恒非负。
   仅刷新「有真实排期段」的需求;纯占位无段的(如未排期的全量测试 estimate:0)保持不动。
   一次性数据清洗:由 estRecalc 标志守护,刷新后置 true,避免覆盖用户之后手改的工作量。 */
function recalcEstimatesFromSchedule(){
  _resetPeakParCache();
  reqs.forEach(r=>{
    const ids=[...new Set(r.segs.filter(s=>idx(s.e)>idx(s.s)&&!s.open).map(s=>s.m))];
    if(!ids.length) return;                          // 无有效排期段 → 保持原值
    let full=0, done=0;
    ids.forEach(id=>{ const d=digestPersonReq(r,id); full+=d.digest; done+=d.digestDone; });
    if(full<=0) return;
    r.estimate=Math.max(1, Math.round(full));
    r.done=Math.min(Math.round(done), r.estimate);
  });
}

/* 渲染需求行内的"产能消化占比条"：各人色块(按隶属上色) + 红斜纹缺口块 + 富余完成线 */
function capacityBarHTML(r){
  const cb = reqCapacityBreakdown(r);
  if(!cb) return '';                                        // 废弃需求：不显示
  const {remain,left,parts,totalCap,gap,surplus} = cb;
  if(remain<=0){                                            // 已无剩余工作量
    return `<div class="cap-wrap" onmousemove="showTip(event,\`<b>${r.name}</b><br>剩余工作量为 0，已无需消化\`,true)" onmouseleave="hideTip()"><div class="cap-bar done"><div class="cap-seg cap-done" style="width:100%">已完成 · 无剩余工作量</div></div></div>`;
  }
  const barTotal = Math.max(remain, totalCap) || 1;
  const pc = v => (v/barTotal*100);
  let segs='';
  parts.forEach(p=>{
    const w=pc(p.cap); if(w<=0) return;
    const tip=`<b>${p.name}</b>${p.lead?` · 隶属${p.lead}`:''}<br><span class='g'>效率系数</span> ${p.eff}　<span class='g'>当前负载</span> ${p.load}%${p.of<1?`（超载折损 ×${p.of.toFixed(2)}）`:''}<br><span class='g'>预计可消化</span> <b style='color:#7da0ff'>${r1(p.cap)}</b> 人天　<span class='g'>(剩余窗口 ${left} 工作日)</span>`;
    segs+=`<div class="cap-seg" style="width:${w}%;background:${p.col}" onmousemove="event.stopPropagation();showTip(event,\`${tip}\`,true)" onmouseleave="hideTip()"><span class="cap-nm">${p.name}</span><span class="cap-num">${r1(p.cap)}</span></div>`;
  });
  if(gap>0){
    const w=pc(gap);
    segs+=`<div class="cap-seg cap-gap" style="width:${w}%" onmousemove="event.stopPropagation();showTip(event,\`<b style='color:#d4380d'>消化缺口</b><br>现有人力预计<b>无法消化 ${r1(gap)} 人天</b><br><span class='g'>需 加人 / 延期 / 提效</span>\`,true)" onmouseleave="hideTip()"><span class="cap-num">缺${r1(gap)}</span></div>`;
  }
  let lineEl='';
  if(surplus>0){                                            // 产能 > 需求：画完成线 + 富余标记
    lineEl=`<i class="cap-line" style="left:${pc(remain)}%"></i><span class="cap-surplus">余${r1(surplus)}</span>`;
  }
  const headTip=`<b>${r.name} · 产能消化</b><br><span class='g'>剩余工作量</span> ${remain} 人天　<span class='g'>剩余窗口</span> ${left} 工作日<br><span class='g'>在做</span> ${parts.length} 人 · 合计可消化 <b>${r1(totalCap)}</b> 人天<br>${gap>0?`<span style='color:#d4380d'>⚠ 缺口 ${r1(gap)} 人天无法消化</span>`:`<span style='color:#2b8a3e'>✓ 产能可覆盖${surplus>0?`，富余 ${r1(surplus)} 人天`:''}</span>`}`;
  return `<div class="cap-wrap" onmousemove="showTip(event,\`${headTip}\`,true)" onmouseleave="hideTip()"><div class="cap-bar">${segs}${lineEl}</div></div>`;
}

/* ============ 产能消化泳道（一人一行甘特）============
   在右侧时间轴里、需求主条下方，按各制作人「真实投入日期段」画一人一行的甘特小条：
   每行 = 行首一枚编制徽标（正/基/借，色=编制色）+ 人名 + 该人剩余可消化天数；其后按真实档期画的甘特条。
   颜色按「编制」上色（正编深紫/基地淡紫/外借橙），不再按隶属带队。缺口/富余不单独成行，已并入需求条内的文字摘要。*/
const CLANE_H=24, CLANE_GAP=5;
/* 一人一行甘特（条内版）：覆盖在任务条内部、取代原角色标签。
   位置按「相对本条左缘的百分比」给出，与 L1/L2 同坐标系，自动对齐。
   每人标签的「消化N天」= 该人本需求投入工作日 × 效率系数（衡量已承担/消化的工作量，
   不依赖剩余窗口，只要有档期就有值）；条长=投入工期、条粗=效率。
   返回 {html, h, nRows}；html 为待注入条内的 .bl-lanes 块。 */
function capacityLanesHTML(r){
  if(reqState(r)==='dropped') return null;               // 仅废弃需求不画泳道；已完成同样有真实档期，照画
  const segsAll = r.segs.filter(s=>idx(s.e)>idx(s.s) && !s.open);
  if(!segsAll.length) return null;                       // 无固定窗口：不画
  const cb = reqCapacityBreakdown(r);
  const left = cb?cb.left:0;
  const capOf={}; if(cb) cb.parts.forEach(p=>{capOf[p.id]=p;});
  // 画甘特条的口径 = 所有在本需求「有真实固定档期段」的人，与「剩余产能」解耦：
  // 即便档期已过、剩余产能为 0，也照常画出其历史档期条，避免回退成只剩名字标签。
  const memIds=[...new Set(segsAll.map(s=>s.m))].filter(id=>memName(id));
  if(!memIds.length) return null;
  const capVal=id=>capOf[id]?capOf[id].cap:0;
  memIds.sort((a,b)=>{
    const ma=members.find(x=>x.id===a),mb=members.find(x=>x.id===b);
    const la=(leadOf(ma)||'~'),lb=(leadOf(mb)||'~');
    return la.localeCompare(lb,'zh-Hans-CN') || (capVal(b)-capVal(a));
  });
  const ph = getPhases(r);
  const span = Math.max(ph.barE-ph.barS,1);
  const pc=i=>Math.max(0,Math.min(100,((i-ph.barS)/span*100)));
  let lanes='', nRows=0;
  memIds.forEach(id=>{
    const psegs = r.segs.filter(s=>s.m===id && idx(s.e)>idx(s.s) && !s.open)
                        .sort((a,b)=>idx(a.s)-idx(b.s));
    if(!psegs.length) return;
    nRows++;
    const m=members.find(x=>x.id===id);
    const lead=leadOf(m);
    const cs=corpStyle(m), col=cs.col;            // 甘特条按「编制」着色：正编蓝/基地淡白/外借橙（不再按隶属带队色）
    const p = capOf[id] || {id, name:memName(id), cap:0, eff:memEff(id), load:(memLoad(id)||{}).pct, of:1, lead, col};
    const effv=(p.eff!=null?p.eff:1);
    const investWD = psegs.reduce((s,seg)=>s+workdays(seg.s,seg.e),0);   // 本需求投入工作日(各档期段跨度合计)
    const dg = digestPersonReq(r, id);                                   // 逐工作日累加投入比 × 效率
    const digest = dg.digest;                                            // 已消化工作量(人天)
    // 投入比说明文案：统一权重模型，显示平均分摊后的有效投入比
    const invDesc = `按权重并行分摊后<b>平均有效投入比 ${dg.avgEff}</b>${dg.hasFollow?`（含跟进段权重 ${dg.followPct}）`:''} → 折合 <b>${dg.invSum}</b> 满工作日`;
    const capTxt = p.cap>0
      ? `还可消化 <b style='color:#7da0ff'>${r1(p.cap)} 个工作日</b>的活　<span class='g'>(按剩余窗口 ${left} 个工作日 × 效率估算)</span>`
      : `<span class='g'>剩余窗口已结束 · 暂无可消化产能</span>`;
    const tip=`<b>${p.name}</b> · <span style='color:${col}'>${cs.label}</span>${lead?` · 隶属${lead}`:''}<br><span class='g'>效率系数</span> ${p.eff} <span class='g'>(条越粗=效率越高)</span>　<span class='g'>当前负载</span> ${p.load}%${p.of<1?`（超载折损 ×${p.of.toFixed(2)}）`:''}<br><span class='g'>本需求投入</span> ${psegs.map(s=>fmt(s.s)+'~'+fmtEnd(s.e)).join('、')}（共 ${investWD} 工作日）<br><span class='g'>精力分配</span> ${invDesc}<br><span class='g'>已消化工作量</span> 折合投入 ${dg.invSum} 工作日 × 效率 ${effv} = <b style='color:#5fd08a'>${digest} 人天</b>　<span class='g'>(条越长=投入越多·越粗=效率越高)</span><br><span class='g'>剩余产能</span> ${capTxt}`;
    // 编制视觉三维度：底色(col) + 纹理(tex) + 描边样式(outline)。离职用虚线描边，其余实线。
    const bordCol = cs.bord || '';
    const segBord = bordCol
      ? (cs.outline==='dashed'
          ? `;border:1px dashed ${bordCol};box-sizing:border-box;box-shadow:0 1px 2px rgba(0,0,0,.18)`
          : `;box-shadow:inset 0 0 0 1px ${bordCol},0 1px 2px rgba(0,0,0,.18)`)
      : '';
    // 纹理层叠在底色之上（background 多层：纹理在前、纯色在后）
    // 离职：不再用「条体中线贯穿黑带」(会切割文字且不齐整、只盖到标签中段)；改为对整个标签文字做 line-through（见下方 bl-lane-lab）
    const bgLayers = [cs.tex].filter(Boolean).join(',');
    const segBg = bgLayers ? `background:${bgLayers},${col}` : `background:${col}`;
    const segH=Math.round(Math.max(6,Math.min(26, 15+(effv-1)*90)));   // 条高随效率：差异拉大(斜率90)——效率越高越粗、越低越细（0.85→6 / 0.95→11 / 1.0→15 / 1.05→20 / 1.10→24px）
    let segs='';
    psegs.forEach(s=>{
      const l=pc(idx(s.s)), w=Math.max(pc(idx(s.e))-l,0.6);
      segs+=`<i class="bl-seg" style="left:${l}%;width:${w}%;height:${segH}px;${segBg}${segBord}" onmousemove="event.stopPropagation();showTip(event,\`${tip}\`,true)" onmouseleave="hideTip()"></i>`;
    });
    const labL=pc(idx(psegs[0].s));
    const badgeBord = cs.outline==='dashed'
      ? `border:1px dashed ${cs.bord};box-sizing:border-box`
      : `box-shadow:inset 0 0 0 1px ${cs.bord||'rgba(255,255,255,.35)'}`;
    const corpBadge=`<i class="bl-corp" style="background:${col};color:${cs.txt};${badgeBord}">${cs.short}</i>`;   // 编制徽标：正/子/基/离/借
    const nameHTML = p.name;
    const capLab = digest>0?`<b>消化${digest}天</b>`:'';                            // 消化N天 = 该人在本需求已投入工作日 × 效率（不依赖剩余窗口，有档期即有值）
    const invLab = segInvBadge(psegs[0]);                                            // 投入比状态徽标（全人力/跟进），取首段口径
    // 离职：给整个标签容器加类，用单个 ::after 画一条连续划除线；避免 text-decoration 在名字/b/投入比徽标上分段且高低不齐
    const departedCls = cs.strike ? ' is-departed' : '';
    lanes+=`<div class="bl-lane">${segs}<span class="bl-lane-lab${departedCls}" style="left:${labL}%" onmousemove="event.stopPropagation();showTip(event,\`${tip}\`,true)" onmouseleave="hideTip()">${corpBadge}${nameHTML}${capLab}${invLab}</span></div>`;
  });
  if(!nRows) return null;
  const H=nRows*(CLANE_H+CLANE_GAP)+2;
  return {html:`<div class="bl-lanes">${lanes}</div>`, h:H, nRows};
}

function memLoad(id){
  const horizonEnd = new Date(TODAY.getTime()+30*dayMs);   // 未来30天负载窗口（长周期排期）
  const avail = workdays(TODAY,horizonEnd);
  // v5.11：负载 = 未来30天每个工作日 Σ(该人各在排段·分摊后投入比)，逐日累加。
  //   并行需求的分摊后投入比在同一天相加 → 直接反映当天精力占用；跟进型（部分/完整跟进）也计入。
  //   分摊后投入比已由 segEffInvOnDay 用「clamp(hi/并行条数, lo, hi)」算好，故同一人同天多条相加可能 >1（超载）。
  let assigned=0;
  const T0=TODAY.getTime(), T1=horizonEnd.getTime();
  for(let t=T0; t<T1; t+=dayMs){
    if(!isWorkdayD(new Date(t))) continue;          // 仅工作日：排除周末+法定节假日（v7.37 口径统一）
    reqs.forEach(r=>{
      if(r.kind==='qa') return;   // 全量测试=bug修复阶段，不计入排期负载
      r.segs.forEach(s=>{
        if(s.m!==id) return;
        if(s.status==='done') return;
        if(s.open) return;   // 无明确时间段：不纳入负载窗口
        if(t>=s.s.getTime() && t<s.e.getTime()) assigned += segEffInvOnDay(s, t);
      });
    });
  }
  const pct=avail>0?assigned/avail:0;
  let cls,col;
  if(pct<=0.85){cls='正常';col='var(--green)';}
  else if(pct<=1.10){cls='饱和';col='var(--amber)';}
  else{cls='超载';col='var(--red)';}
  return {pct:Math.round(pct*100),cls,col,assigned:Math.round(assigned),avail};
}

function barCls(r,seg,m){
  const k = r.kind==='lt'?' k-lt':r.kind==='qa'?' k-qa':'';
  // 终态需求的条体配色固定（不受 colorMode 影响）：已完成=绿，废弃=灰
  const rs=reqState(r);
  if(rs==='done') return 'b-done'+k;     // 已完成：青绿任务条（区别于低风险安全绿）
  if(rs==='dropped') return 'b-gray'+k;   // 废弃：灰色任务条
  // 段级终态优先：该任务段自身已完成/废弃时固定按终态着色，避免「按风险」模式下被需求级风险染红
  if(seg){
    if(seg.status==='done')    return 'b-done'+k;   // 这段活已完成 → 绿
    if(seg.status==='dropped') return 'b-gray'+k;   // 这段已废弃 → 灰
    if(seg.status==='overdue' && !(m && (m.corp==='reg'||m.corp==='sub'))) return 'b-amber'+k;  // v5.9 排期到期未完成 → 橙；v6.76 正编/子公司除外
  } else if(aggStatus(r)==='done'){
    return 'b-done'+k;                                // 整条需求所有段都完成 → 绿（即便生命周期未手动置 done）
  }
  // 外借支援：非终态时统一中性灰（表示「不判断风险」）；已完成/废弃仍按终态色显示
  if(m && isExtLoan(m)) return 'b-gray'+k;
  /* v7.24：联调条体改青碧色系（b-lt）。v7.09 的紫 #7e63b5 与超期区/「超N周」徽标的紫红同族撞色，
     用户反馈「联调需求与超期紫分不清」；未启动(todo)的联调用低饱和浅青 b-lt0，退到背景层不抢眼。 */
  if(r.mod === '联调'){
    const _ltSt = seg ? (seg.status||'doing') : aggStatus(r);
    return (_ltSt==='todo' ? 'b-lt0' : 'b-lt')+k;
  }
  if(colorMode==='status'){
    return (seg ? STATUS[seg.status||'doing'].cls : STATUS[aggStatus(r)].cls)+k;
  }
  return reqRisk(r).txt+k;
}

/* ============ 负载热力图（拥堵线路图风格） ============
   在时间轴头部下方显示一条色带，每列一天，颜色表示当天整体负载率：
   - 绿色：负载低（<60%）→ 有空余
   - 黄色：负载适中（60-80%）
   - 橙色：负载高（80-100%）
   - 红色：超载（100-130%，有人并行多任务）
   - 深红：严重超载（>130%）
   - 灰色带闪烁标记：当天有活跃成员完全空闲（0任务）
   计算口径：仅统计在岗非离职、非暂缺成员；按需求段覆盖天数求和。 */
function loadHeatmapHTML(){
  // 1. 筛选有效在岗成员
  const activeMembers = members.filter(m =>
    !isVacantMem(m) && !effLeft(m) && !leftLong(m)
  );
  if(activeMembers.length === 0) return '';
  const totalActive = activeMembers.length;

  // 2. 预计算每天的「被分配人次数」（一人同天多段=多次，并行度）
  const dayLoad = new Int32Array(DAYS);
  // 成员→哪些天有任务（用于检测空闲）
  const memberHasTaskOnDay = new Map();

  activeMembers.forEach(m => {
    const taskDays = new Set();
    reqs.forEach(r => {
      if(reqClosed(r)) return;
      (r.segs||[]).forEach(s => {
        if(s.m !== m.id) return;
        let si = idx(s.s), ei = idx(s.e);
        const _ot=segOpenType(s);
        if(_ot==='front') si=0;
        else if(_ot==='back') ei=DAYS;
        else if(_ot==='both'){ si=0; ei=DAYS; }
        else if(ei <= si) return;
        si = Math.max(0, si); ei = Math.min(ei, DAYS);
        for(let d=si; d<ei; d++){
          dayLoad[d]++;
          taskDays.add(d);
        }
      });
    });
    memberHasTaskOnDay.set(m.id, taskDays);
  });

  // 3. 完全空闲的成员
  const idleMembers = activeMembers.filter(m => {
    const tasks = memberHasTaskOnDay.get(m.id);
    return !tasks || tasks.size === 0;
  });

  // 4. 按周聚合（自然周，周一起始）
  const weeks = [];
  for(let i=0; i<DAYS; ){
    const d = new Date(START.getTime() + i*dayMs);
    const dow = d.getDay();
    let wkStart = i - ((dow + 6) % 7);
    if(wkStart < 0) wkStart = 0;
    if(wkStart < i && i !== wkStart) wkStart = i;
    let wkEnd = wkStart + 7;
    if(wkEnd > DAYS) wkEnd = DAYS;
    weeks.push({s: wkStart, e: wkEnd});
    i = wkEnd;
  }
  if(weeks.length > 1 && (weeks[weeks.length-1].e - weeks[weeks.length-1].s) < 3){
    const last = weeks.pop();
    weeks[weeks.length-1].e = last.e;
  }

  // 5. 颜色映射：人天利用率 = 实际分配人天数 / (在岗人数 × 工作日数)
  //    <50% 绿(闲) / 50-70% 浅绿 / 70-85% 黄 / 85-100% 橙 / >100% 红(超载)
  const loadColor = (ratio) => {
    if(ratio <= 0.50) return '#22c55e';
    if(ratio <= 0.70) return '#86efac';
    if(ratio <= 0.85) return '#facc15';
    if(ratio <= 1.00) return '#fb923c';
    if(ratio <= 1.20) return '#f87171';
    return '#dc2626';
  };

  // 6. 生成周粒度色带
  let bars = '';
  /* v7.14 负载行配平：额外收集每周指标，用于
     ① 左侧标签的「峰 X% · 均 Y%」聚合数（原先左边只有「📊 负载」四字，与右侧整条大色带视觉失衡）
     ② 色段下沿的「N人·X%」微标注（把颜色翻译成数字，让色带自解释） */
  const wkStats = [];
  weeks.forEach((wk, wi) => {
    const wkDays = wk.e - wk.s;
    if(wkDays <= 0) return;

    let workdays = 0, totalAssignments = 0;
    let hasIdleInWk = false;

    for(let d=wk.s; d<wk.e; d++){
      if(shadeType(d) !== null) continue;  // 跳过周末/节假日
      workdays++;
      totalAssignments += dayLoad[d];

      if(!hasIdleInWk){
        const hasIdleToday = idleMembers.some(m => {
          const tasks = memberHasTaskOnDay.get(m.id);
          if(!tasks || tasks.size === 0) return true;
          return !tasks.has(d);
        });
        if(hasIdleToday) hasIdleInWk = true;
      }
    }

    // 核心指标：利用率（可超过100%=超载）
    const capacity = totalActive * workdays;
    const ratio = capacity > 0 ? totalAssignments / capacity : 0;
    const color = loadColor(ratio);

    const leftPx = wk.s * DAY_W;
    const widthPx = Math.min((wk.e - wk.s) * DAY_W, DAYS * DAY_W - leftPx);
    const idleCls = hasIdleInWk ? ' idle-wk' : '';

    const ratioPct = Math.round(ratio * 100);
    const tipParts = [`第${wi+1}周 利用率 ${ratioPct}%（${totalAssignments}人次/${capacity}容量）`];
    if(hasIdleInWk && idleMembers.length > 0) tipParts.push(`⚠ ${idleMembers.map(m=>m.name).join('、')} 空闲`);
    const tip = tipParts.join('　');

    bars += `<div class="load-seg${idleCls}" style="left:${leftPx}px;width:${widthPx}px;background:${color}"
      onmousemove="showTip(event,\`${tip}\`)" onmouseleave="hideTip()"></div>`;

    // v7.14 记录本周指标（workdays 为 0 的周不计入聚合，避免把假期周算成 0% 拉低均值）
    const parallel = workdays > 0 ? totalAssignments / workdays : 0;
    wkStats.push({ratioPct, parallel, leftPx, widthPx, counted: workdays > 0});
  });

  /* v7.20：移除色段底部的「人数·占比」逐周微标注。
     颜色与悬停提示已完整表达负载；把数值逐格铺开会使热力带变成难以扫读的数据墙。 */

  // v7.14 左侧标签聚合数：峰值取最大周利用率，均值按计入周求算术平均
  const counted = wkStats.filter(w => w.counted);
  const peakPct = counted.length ? Math.max(...counted.map(w=>w.ratioPct)) : 0;
  const avgPct  = counted.length ? Math.round(counted.reduce((s,w)=>s+w.ratioPct,0) / counted.length) : 0;

  // 7. 图例
  const legend = idleMembers.length > 0
    ? `<span class="load-legend-idle">⚠ ${idleMembers.map(m=>m.name).join('、')} 空闲</span>`
    : '';

  /* 8. v6.49 排期空隙标记：把「按人看」各行的内部空隙投影到色带上。
     **必须与行内 .gap-indicator 完全同源**，否则边界对不上（用户反馈"专属轨道没与空闲区域边界对齐"）。
     v6.48 前的 bug：这里遍历 activeMembers 重新调 getMemberBusyIntervals 计算，
     而行内块用的是 paint 期间存进 gapData 的结果 —— 两者成员集合与过滤口径不同：
       · 成员集合：activeMembers 排除占位成员，但占位行同样会渲染空隙块 → 色带漏掉占位行的空档
       · HIDE_DONE：旧版 getMemberBusyIntervals 内部按 HIDE_DONE[view] 过滤已完成需求，
         但色带在 view 非 person 时口径又不同 → 空隙宽窄不一致
     v6.49 改为**直接复用 gapData**（就是行内块渲染用的那份数据），从数据层保证像素级对齐。
     v6.64 补充：getMemberBusyIntervals 已彻底移除 HIDE_DONE 依赖（改为全量数据），
       且 personRowHTML / vacantRowHTML 也统一改调该函数写 gapData
       → 「行内块 = 色带标记 = 拖拽刷新」三者从此走同一条计算路径，勾选开关不再影响空隙。 */
  let gapMarks = '';
  try{
    const allGaps = [];
    gapData.forEach((gaps, mid) => {
      const mem = members.find(x=>x.id===mid);
      if(!mem || isVacantMem(mem)) return;   // 占位坑位不参与（缺人本就没排满，标"空闲"无意义）
      (gaps||[]).forEach(g => allGaps.push({s:g.x0, e:g.x1, name:mem.name, days:g.days}));
    });
    if(allGaps.length){
      // 按起点排序后合并重叠区间，并记录涉及的人
      allGaps.sort((a,b)=>a.s-b.s||a.e-b.e);
      const unions = [];
      allGaps.forEach(g => {
        const last = unions[unions.length-1];
        if(last && g.s <= last.e){
          last.e = Math.max(last.e, g.e);
          if(!last.who.includes(g.name)) last.who.push(g.name);
        }else{
          unions.push({s:g.s, e:g.e, who:[g.name]});
        }
      });
      gapMarks = unions.map(u => {
        const leftPx = u.s * DAY_W;
        const widthPx = (u.e - u.s) * DAY_W;
        // v6.43 工作日口径：统计该并集区间内的工作日（排除周末/节假日），与行内空隙块同口径
        let wd=0; for(let d=u.s; d<u.e; d++){ if(shadeType(d)===null) wd++; }
        const tip = `⏳ 排期空隙 ${wd} 个工作日（共 ${u.e-u.s} 天，已排除周末/节假日）　${u.who.join('、')} 此期间有空档`;
        return `<div class="load-gap-mark" style="left:${leftPx}px;width:${widthPx}px"
          onmousemove="showTip(event,\`${tip}\`)" onmouseleave="hideTip()"></div>`;
      }).join('');
    }
  }catch(e){ console.warn('[load-heatmap gap marks]', e); gapMarks=''; }

  /* v7.14 左侧标签两行化：主行给「团队负载 + 在岗人数徽标」，副行给「峰值/均值」，
     与右侧色带在信息量上对等，不再是孤零零的「📊 负载」两字。
     整行同时改为 sticky top:54px 纵向冻结（见 styles.css .load-heatmap 注释）。 */
  const labelTip = `在岗 ${totalActive} 人　按自然周聚合　峰值周利用率 ${peakPct}%　全周期均值 ${avgPct}%　利用率 = 分配人天 ÷ (在岗人数 × 工作日)`;
  return `<div class="load-heatmap" id="loadHeatmap">
    <div class="load-label" onmousemove="showTip(event,\`${labelTip}\`)" onmouseleave="hideTip()">
      <div class="ll-main">📊 团队负载</div>
    </div>
    <div class="load-track" style="width:${DAYS*DAY_W}px">${bars}${gapMarks}</div>
    ${legend}
  </div>`;
}

/* ============ 表头（按月+按周粒度，适配全跨度） ============ */
function headerHTML(){
  let months='',weeks='',vlines='',shades='';
  // 节假日/双休灰列（画在竖线层最底，贯穿全高；工作日不标）
  for(let i=0;i<DAYS;i++){
    const t=shadeType(i);
    if(t) shades+=`<div class="daycol ${t}" style="left:${i*DAY_W}px;width:${DAY_W}px"></div>`;
  }
  // 月份分隔（上行）
  let mi=0, monIdx=0;
  while(mi<DAYS){
    const d=new Date(START.getTime()+mi*dayMs);
    const y=d.getFullYear(), m=d.getMonth();
    // 本月在区间内的天数
    const monthStart=new Date(y,m,1);
    const nextMonth=new Date(y,m+1,1);
    const segStartIdx=Math.max(mi,0);
    const segEndIdx=Math.min(idx(nextMonth),DAYS);
    const left=segStartIdx*DAY_W, width=(segEndIdx-segStartIdx)*DAY_W;
    months+=`<div class="month-head${monIdx%2?' alt':''}" style="left:${left}px;width:${width}px">${y}年${m+1}月</div>`;
    // 月初竖线（粗）
    if(idx(monthStart)>=0&&idx(monthStart)<=DAYS) vlines+=`<div class="vline mono" style="left:${idx(monthStart)*DAY_W}px"></div>`;
    mi=segEndIdx; monIdx++;
  }
  // 周刻度（下行）+ 周竖线
  let wkIdx=0;
  for(let i=0;i<DAYS;i++){
    const d=new Date(START.getTime()+i*dayMs);
    if(d.getDay()===1){ // 每周一
      weeks+=`<div class="week-head${wkIdx%2?' alt':''}" style="left:${i*DAY_W}px;width:${7*DAY_W}px">${fmt(d)}</div>`;
      vlines+=`<div class="vline" style="left:${i*DAY_W}px"></div>`;
      wkIdx++;
    }
  }
  const tx=idx(TODAY)*DAY_W;
  const headLabel = view==='req' ? '角色　·　排期与风险'
                  : view==='hr'  ? '模块 / 品级　·　人力配置'
                  : '成员 / 角色　·　负载';
  return `<div class="row head">
    <div class="cell-left">${headLabel}</div>
    <div class="timeline" style="width:${DAYS*DAY_W}px">${months}${weeks}</div></div>`
   + `__VLINES__${shades}${vlines}`
   /* v7.12：今天红线从竖线层里独立出来。竖线层是 top:94px（表头 54 + 热力带 44 之下，v7.14 带高 32→44 故 82→94），
      红线画在里面就永远从表头下方才起笔，与表头上方的日期胶囊隔着一段空白、连不成一根指针。
      拆成 __TODAY__ 单独一层后由 paint 挂到 top:0 的贯穿层，红线自表头顶端一路贯到底；
      表头段用 CSS 渐变压到 28% 透明度，既连贯又不糊住月/周日期文字。 */
   + `__TODAY__<div class="todayline" data-today="今天 ${fmt(TODAY)}" style="left:${tx}px"></div>`;
}

/* ============ 里程碑渲染（v7.43） ============ */
/* 从所有需求提取里程碑，按日期排序，用于按人视图的汇总行。 */
function allMilestones(){
  const list=[];
  reqs.forEach(r=>{
    (r.milestones||[]).forEach((ms,mi)=>{
      list.push({...ms, reqId:r.id, reqName:r.name, msIdx:mi});
    });
  });
  list.sort((a,b)=>a.date-b.date);
  return list;
}
/* 单个里程碑节点 HTML。
   ctx='summary'：汇总行中的小标签（带文字）。
   ctx='bar'：需求条内标记（顶部圆点+竖线+文字）。
   left 传入像素偏移（summary）或百分比字符串（bar，需带 %）。 */
function milestoneNodeHTML(ms, ctx, left){
  const tip=`${escAttr(ms.label)}\n${fmt(ms.date)} · ${ms.reqName||'全局节点'}\n拖拽改期 / 右键编辑`;
  const color=ms.color||msDefaultColor();   // v7.47：无自定义色时取统一色板的虚线色
  // data-req 用于「hover/选中需求条 → 联动高亮其节点与虚线」；data-msidx 定位到 req.milestones 下标供编辑/删除
  const link=`data-req="${ms.reqId||''}" data-msidx="${ms.msIdx!=null?ms.msIdx:''}"`;
  if(ctx==='bar'){
    return `<div class="ms-mark ms-custom" ${link} style="left:${left}" onmousemove="event.stopPropagation();showTip(event,'${tip.replace(/'/g,"\\'")}')" onmouseleave="hideTip()">
      <span class="ms-label" style="color:${color}">${escHtml(ms.label)}</span>
      <!-- v7.47：光环改由 CSS 变量 --msc 驱动（样式表里统一定义三层描边），
           不再写死 inline box-shadow —— 内联样式会盖掉 CSS 的深色外环，对比度强化失效。 -->
      <span class="ms-dot" style="background:${color};--msc:${color}"></span>
      <span class="ms-line" style="background:${color}"></span>
    </div>`;
  }
  // summary 行：菱形图标 + 文字标签
  return `<div class="ms-node" ${link} style="left:${left}px" onmousemove="showTip(event,'${tip.replace(/'/g,"\\'")}')" onmouseleave="hideTip()">
    <span class="ms-diamond" style="background:${color}"></span>
    <span class="ms-text" style="color:${color}">${escHtml(ms.label)}</span>
  </div>`;
}
/* 按人视图：里程碑汇总行（方案 C）。插入在所有成员行之前，sticky 置顶。 */
function milestoneSummaryRowHTML(){
  const ms=allMilestones();
  const nodes=ms.map(m=>{
    const d=idx(m.date);
    if(d<0 || d>=DAYS) return '';
    return milestoneNodeHTML(m,'summary',d*DAY_W);
  }).join('');
  // v7.45：标签区加「＋」新增按钮；空时间轴右键可新建节点（见 contextmenu 的 .ms-summary-row 分支）
  return `<div class="row ms-summary-row" style="min-height:34px;position:sticky;top:86px;z-index:7">
    <div class="cell-left"><span class="ms-summary-label">🚩 关键节点</span><button class="ms-add-btn" onclick="event.stopPropagation();openAddMilestone()" title="新增关键节点">＋</button></div>
    <div class="timeline ms-summary-track" style="width:${DAYS*DAY_W}px">${nodes}</div>
  </div>`;
}
/* 按需求视图：将单个需求的里程碑渲染为条内标记（方案 B）。
   barS/barE/span 来自 getPhases(r) 的结果，与 L1/L2 分割同算法。
   v7.44 修复：越界里程碑（如落在条末端之后的"封版"节点）不再整条丢弃，
   而是把位置夹到 [2,98]% 贴在条两端，保证可见；真实日期由 hover tooltip 显示。 */
function reqMilestonesHTML(r, barS, barE, span){
  if(!r.milestones || !r.milestones.length || span<=0) return '';
  return r.milestones.map((ms,mi)=>{
    const d=idx(ms.date);
    let pct=((d-barS)/span*100);
    if(!isFinite(pct)) return '';
    // 夹到 [2,98]：既防圆点圆心贴边被 overflow:hidden 裁掉一半，又让越界节点仍可见
    pct=Math.max(2,Math.min(98,pct));
    return milestoneNodeHTML({...ms,reqId:r.id,reqName:r.name,msIdx:mi},'bar',pct.toFixed(2)+'%');
  }).join('');
}

/* ===== v7.45：阶段节点（L1/L2/联调完成点）—— 取消分段色块后改用「菱形圆点」表达 =====
   与自定义关键节点（圆形 .ms-dot）区分：阶段节点用菱形 .ms-pdot。
   圆点带 data-req/data-phdiv → 复用 pointerdown 的分割线拖拽分支改期；右键弹层编辑日期/颜色。 */
const PHASE_NODE_META={
  l1:{label:'L1 完成',color:'#5b9bff'},
  l2:{label:'L2 完成',color:'#f7a54f'},
};
function reqPhaseNodes(r,ph){
  if(ph.isLt) return [];   // 旧版联调整条铺满，无 L1/L2 分段概念
  const list=[{key:'l1',which:1,d:ph.split,label:PHASE_NODE_META.l1.label}];
  if(ph.split2!=null) list.push({key:'l2',which:2,d:ph.split2,label:ph.lt2?'L2 完成 · 联调开始':'L2 完成'});
  return list;
}
function reqPhaseNodesHTML(r,ph){
  const span=Math.max(ph.barE-ph.barS,1); if(span<=0) return '';
  const pc=i=>((i-ph.barS)/span*100);
  return reqPhaseNodes(r,ph).map(n=>{
    const pct=Math.max(2,Math.min(98,pc(n.d))).toFixed(2);   // 同自定义节点：夹到 [2,98] 防裁切
    // v7.47：需求自定义色优先，否则取「统一色板」的阶段色
    const color=msPhaseColor(r,n.key);
    const tip=`${n.label}\n${fmt(i2d(n.d))}　·　拖拽改期 / 右键编辑`;
    // v7.47：data-phlabel 供「出框文字标签层」读取（条内 .ms-mark 不再自带可见 label）
    return `<div class="ms-mark phase" data-req="${r.id}" data-phdiv="${n.which}" data-phkey="${n.key}" data-phlabel="${escAttr(n.label)}" style="left:${pct}%"
      onmousemove="event.stopPropagation();showTip(event,'${tip.replace(/'/g,"\\'")}')" onmouseleave="hideTip()">
      <span class="ms-pdot" style="background:${color}"></span>
      <span class="ms-pline" style="background:${color}"></span>
    </div>`;
  }).join('');
}

/* ===== v7.45：关键节点 → 需求条目 的竖向虚线层（仿 today 红线层）=====
   层：left:var(--left-w) 与内容同原点；每条 .ms-link left=idx(date)*DAY_W。
   高度由 syncMsLinks() 实测需求行 offsetTop 设定 → 精确停在需求行中线（按需求视图）。
   按人视图行=成员、无单一需求行 → .ms-link 加 .free 淡显全高兜底。 */
function msLinkLayerHTML(){
  const links=allMilestones().map(m=>{
    const d=idx(m.date);
    if(d<0||d>=DAYS) return '';
    return `<div class="ms-link" data-req="${m.reqId||''}" style="left:${d*DAY_W}px;--msc:${m.color||msDefaultColor()}"></div>`;
  }).join('');
  return `<div class="ms-link-layer" id="msLinkLayer" style="position:absolute;left:var(--left-w);top:0;bottom:0;right:0;pointer-events:none;z-index:7">${links}</div>`;
}
/* paint 后/滚动/缩放时同步虚线：top=汇总行底，height=需求行中线-汇总行底；并按 scrollLeft 裁掉漏进冻结左栏的部分。
   v7.46：终点语义由「该需求行中线」升级为「该需求所属分组的最后一行底边」——
     按需求视图按模块/角色分组时，一个组往往含多条需求，虚线应覆盖整组以表达"这个节点牵动这一组"，
     但绝不能越界画进下一个分组（那会误导成"与下一组也有关"）。
   实现：从目标行向前找最近的 .grp-header 确认有组（无组=GROUP_MODE.req==='none'，回落中线）；
        有组则向后遍历到下一个 .grp-header 之前，取最后一个 .req-row 的底边作为终点。 */
function syncMsLinks(){
  const layer=document.getElementById('msLinkLayer'); if(!layer) return;
  const sc=document.getElementById('scroll');
  if(sc) layer.style.clipPath=`inset(0 0 0 ${Math.max(0,sc.scrollLeft)}px)`;   // 同 v7.19 红线防穿透
  const sr=document.querySelector('.ms-summary-row');
  const base=sr ? (sr.offsetTop + sr.offsetHeight) : 120;   // 汇总行底（#grid 内容坐标，约 86+34）
  layer.querySelectorAll('.ms-link').forEach(link=>{
    const reqId=link.dataset.req;
    const row=reqId?document.querySelector(`.req-row[data-req-row="${reqId}"]`):null;
    link.style.top=base+'px';
    if(!row){
      link.classList.add('free');   // 无目标需求行（按人视图 / 所属组被折叠）：全高淡显
      link.style.height='';
      link.style.bottom='0';
      return;
    }
    // —— 向前找组头：确认该行处于某个分组内 ——
    let hdr=null, prev=row.previousElementSibling;
    while(prev){ if(prev.classList.contains('grp-header')){hdr=prev;break;} prev=prev.previousElementSibling; }
    let bottom;
    if(hdr){
      // 向后遍历到下一个组头之前，最后一个 .req-row 的底边 = 组末
      let last=row, next=row.nextElementSibling, guard=0;
      while(next && !next.classList.contains('grp-header') && guard++<5000){
        if(next.classList.contains('req-row')) last=next;
        next=next.nextElementSibling;
      }
      bottom=last.offsetTop + last.offsetHeight;
    }else{
      bottom=row.offsetTop + row.offsetHeight/2;   // 无组头（不分组视图）：回落「指向该行中线」
    }
    link.classList.remove('free');
    link.style.bottom='auto';
    link.style.height=Math.max(0,bottom-base)+'px';
  });
}

/* ===== v7.47：需求条内关键节点的「出框文字标签」层 =====
   为什么单独开一层：需求条 .bar-task 是 overflow:hidden（用于裁掉斜纹/进度层的溢出），
   任何画在条内的标签一旦上移到条外就会被裁掉 —— v7.44 就是因为 top:-10px 被裁才改成纯 tooltip。
   现在要求「标签显示在条目顶部并允许出框」，就必须让标签脱离那个裁切上下文：
   本层挂 #grid（无 overflow 裁切）、与虚线层同级，标签按节点实测坐标绝对定位到条顶之上。
   坐标来源：直接量 .ms-mark 相对 #grid 的矩形（不重算百分比），保证与渲染结果像素一致。 */
function msBarLabelLayerHTML(){
  return `<div class="ms-label-layer" id="msLabelLayer"></div>`;
}
/* 渲染/滚动/缩放后重算标签位置。与 syncMsLinks 同入口调用。 */
function syncMsBarLabels(){
  const layer=document.getElementById('msLabelLayer');
  if(!layer) return;
  const grid=document.getElementById('grid'); if(!grid) return;
  const gr=grid.getBoundingClientRect();
  const sc=document.getElementById('scroll');
  // 与虚线层同步做 clip-path 裁剪，防止标签横向滚进冻结左栏区域
  if(sc) layer.style.clipPath=`inset(0 0 0 ${Math.max(0,sc.scrollLeft)}px)`;
  const hlReq=_msHoverReq || (typeof selectedBar!=='undefined'&&selectedBar&&selectedBar.reqId) || null;
  let html='';
  grid.querySelectorAll('.bar-task.req-bar').forEach(bar=>{
    const br=bar.getBoundingClientRect();
    // 条整体滚出可视区则跳过（省 DOM，也避免标签飘在视口外）
    if(br.bottom<gr.top-40 || br.top>gr.bottom+40) return;
    bar.querySelectorAll('.ms-mark').forEach(mk=>{
      const mr=mk.getBoundingClientRect();
      if(mr.width===0&&mr.height===0) return;
      // 标签文本：自定义节点取 ms-label，阶段节点取 data-phlabel
      let txt='';
      if(mk.classList.contains('phase')) txt=mk.dataset.phlabel||'';
      else{
        const le=mk.querySelector('.ms-label'); txt=le?le.textContent:'';
      }
      if(!txt) return;
      // 定位：水平对准节点中心，垂直让标签【底边】落在条顶之上 → 整块出框。
      // ⚠️ 不能只减 7px：top 定的是标签上边，标签高约 15px，那样底边会压进条内 8px。
      // 正确做法是先量出标签高度再上移，故用两次布局：先按 0 高度写入取 offsetHeight，再修正 top。
      const x=mr.left-gr.left+mr.width/2;
      const yRaw=br.top-gr.top-5;   // 条顶上方 5px 作为目标【底边】
      const hl=(hlReq&&mk.dataset.req===hlReq)?' hl':'';
      html+=`<span class="ms-bar-label${hl}" data-req="${mk.dataset.req||''}" data-ybase="${yRaw.toFixed(1)}" style="left:${x.toFixed(1)}px;top:0px">${escHtml(txt)}</span>`;
    });
  });
  layer.innerHTML=html;
  /* 第二遍：按实测高度把每个标签上移，使其底边落在条顶之上（真正出框）。
     高度统一的标签本可只量一次，但不同字号/内边距会浮动，逐个量最稳。 */
  layer.querySelectorAll('.ms-bar-label').forEach(el=>{
    const base=parseFloat(el.dataset.ybase);
    if(isFinite(base)) el.style.top=(base-el.offsetHeight)+'px';
  });
}
/* ===== v7.47：关键节点「统一色板」面板 =====
   ⚠️ MS_COLORS 必须在此【之前】声明：applyMsPalette() 会就地改写它的内容（见下），
      而本块位于文件更上方、早于 MS_COLORS 原定义处，故把定义前移到这里。 */
const MS_COLORS=['#ffd23f','#ff5b5b','#5b9bff','#2fbf9a','#b06bff','#ff8c42'];
/* 把散落各处的节点相关颜色收进一张注册表，集中编辑：
     · msBg    —— 🚩 关键节点汇总行的整行底色（v7.46 已引出）
     · msLine  —— 竖向虚线颜色（未单独指定节点色时的默认值）
     · msL1 / msL2 —— 阶段节点（L1 完成 / L2 完成·联调开始）的菱形色
     · msA..F  —— 自定义关键节点的候选色板（新建/编辑节点时从这里选）
   约束（需求）：颜色必须不透明 —— 一律 #RRGGBB 六位十六进制，禁止 rgba()/#RRGGBBAA；
   半透明节点色叠在深色任务条上会与条色混脏，对比度也随背景漂移。
   作用域：本机 localStorage（gantt_ms_palette），不进云端快照、不影响他人视图。 */
const MS_PALETTE_DEF={
  msBg  :'#fdfcf5',
  msLine:'#ffb020',
  msL1  :'#5b9bff',
  msL2  :'#f7a54f',
  msA   :'#ffd23f',
  msB   :'#ff5b5b',
  msC   :'#5b9bff',
  msD   :'#2fbf9a',
  msE   :'#b06bff',
  msF   :'#ff8c42',
  /* v7.56 甘特图条配色：与「自定义节点色板」同构，但作用于**任务条本身**。
     每项对应一类条，默认色取自 styles.css 里原有的硬编码值（改前什么样、默认就什么样）：
       barGray  —— 外借支援条（isExtLoan 命中，本例中即支援·武器特效）原 b-gray #7d92b3
       barBlue/barGreen/barAmber/barRed —— 状态色（blue/green/amber/red）
       barDone  —— 已完成条 原 b-done #4ecba0
     约束同其他色板：必须不透明 #RRGGBB（半透明条色叠在日期底纹上会混脏）。
     作用域：本机 localStorage（同一 gantt_ms_palette），不进云端快照、不影响他人视图。 */
  barGray :'#7d92b3',
  barBlue :'#4d80ff',
  barGreen:'#1fae5a',
  barAmber:'#f59e0b',
  barRed  :'#ef3b39',
  barDone :'#4ecba0',
  /* 开放条（前端/后端/两端无限，本例即支援·武器特效）的底色。
     默认**空串** = 不注入 CSS 变量 = 保持 v7.55 的实体化实底 rgba(168,150,128,.20)。
     不设默认色值的原因：它本就没有「原始硬编码色」可回退（v7.55 之前是透明），
     若在此给一个默认色，会覆盖 v7.55 刚做的实体化效果，也会让「恢复默认」语义含混。 */
  barOpen :'',
};
/* 色板的展示元数据：label 用于面板显示，desc 说明它影响哪里 */
const MS_PALETTE_META=[
  {group:'关键节点行', items:[
    {k:'msBg',   label:'汇总行底色',   desc:'🚩 关键节点整行的背景色'},
    {k:'msLine', label:'竖向虚线色',   desc:'节点连到需求条/需求组的虚线（节点自身无色时用它）'},
  ]},
  {group:'阶段节点', items:[
    {k:'msL1',   label:'L1 完成',      desc:'需求条内 L1 阶段菱形圆点'},
    {k:'msL2',   label:'L2 完成',      desc:'需求条内 L2 阶段菱形圆点（= 联调开始）'},
  ]},
  {group:'自定义节点色板', items:[
    {k:'msA',label:'色 1',desc:'新建/编辑关键节点时可选'},{k:'msB',label:'色 2',desc:'新建/编辑关键节点时可选'},
    {k:'msC',label:'色 3',desc:'新建/编辑关键节点时可选'},{k:'msD',label:'色 4',desc:'新建/编辑关键节点时可选'},
    {k:'msE',label:'色 5',desc:'新建/编辑关键节点时可选'},{k:'msF',label:'色 6',desc:'新建/编辑关键节点时可选'},
  ]},
  {group:'甘特图条', items:[
    {k:'barGray', label:'支援条',   desc:'外借支援的甘特图条（如支援·武器特效）'},
    {k:'barOpen', label:'开放条',   desc:'起止不确定的无限条底色（默认沿用实体化实底，留空=不改）'},
    {k:'barBlue', label:'蓝条',     desc:'状态色：蓝色任务条'},
    {k:'barGreen',label:'绿条',     desc:'状态色：绿色任务条'},
    {k:'barAmber',label:'橙条',     desc:'状态色：橙色任务条（含超期）'},
    {k:'barRed',  label:'红条',     desc:'状态色：红色任务条'},
    {k:'barDone', label:'已完成条', desc:'已完成的甘特图条（青绿）'},
  ]},
];
const MS_PAL_KEY='gantt_ms_palette';
let MS_PALETTE=Object.assign({},MS_PALETTE_DEF);
try{
  const _p=JSON.parse(localStorage.getItem(MS_PAL_KEY)||'null');
  if(_p&&typeof _p==='object'){
    Object.keys(MS_PALETTE_DEF).forEach(k=>{
      // v7.56：barOpen 允许空串（沿用默认实底），其余必须是不透明 #RRGGBB
      if(k==='barOpen'){ if(typeof _p[k]==='string' && (_p[k]===''||/^#[0-9a-fA-F]{6}$/.test(_p[k]))) MS_PALETTE[k]=_p[k]; return; }
      if(typeof _p[k]==='string' && /^#[0-9a-fA-F]{6}$/.test(_p[k])) MS_PALETTE[k]=_p[k];   // 拒绝 rgba/8位hex，保证不透明
    });
  }
}catch(_){}
/* 应用色板：msBg 注入 CSS 变量（驱动汇总行底色），其余供 JS 渲染节点时读取 */
/* noRedraw=true 时跳过面板重建：供「连续选色」场景使用（见 changeMsPalette），
   避免每次改色都把 #msPaletteBox 的 DOM 换掉导致误写分离节点、并让系统取色器失焦。 */
/* v7.56：barXxx 一组注入 --bar-* CSS 变量，驱动甘特图条底色。
   注意**不调 rerender()** —— 变量一变浏览器立即重绘，条色实时生效（无需重建 DOM），
   这既满足「实时生效」，也不会在连续选第二个色时打断操作（与 v7.50 连续选色同一套约束）。 */
function applyMsPalette(noRedraw){
  document.documentElement.style.setProperty('--ms-bg',MS_PALETTE.msBg);
  ['barGray','barBlue','barGreen','barAmber','barRed','barDone'].forEach(k=>{
    document.documentElement.style.setProperty('--'+k.replace(/^bar/,'bar-').toLowerCase(),MS_PALETTE[k]);
  });
  /* barOpen 特殊：空串表示「不改」，此时必须把变量**移除**（而非设成空值）——
     否则 var(--bar-open, 兜底) 会拿到空值并按无效值处理，反而丢掉 v7.55 的实底兜底。 */
  if(MS_PALETTE.barOpen) document.documentElement.style.setProperty('--bar-open',MS_PALETTE.barOpen);
  else document.documentElement.style.removeProperty('--bar-open');
  // 自定义节点候选色列表：供新建/编辑弹层的色板使用
  MS_COLORS.length=0;
  ['msA','msB','msC','msD','msE','msF'].forEach(k=>MS_COLORS.push(MS_PALETTE[k]));
  if(!noRedraw) renderMsPaletteUI();
}
/* 改单个色。校验：仅接受 6 位 #RRGGBB（不透明），其余一律拒绝并提示。 */
function changeMsPalette(k,val){
  /* v7.56：barOpen 允许空串（= 沿用默认实底），其余一律要求不透明 #RRGGBB */
  const _allowEmpty = (k==='barOpen');
  if(_allowEmpty && val===''){ /* 通过：清空=不改 */ }
  else if(!/^#[0-9a-fA-F]{6}$/.test(val)){ toast('颜色必须是不透明的 #RRGGBB 格式'); return; }
  if(!(k in MS_PALETTE_DEF)) return;
  MS_PALETTE[k]=val;
  try{localStorage.setItem(MS_PAL_KEY,JSON.stringify(MS_PALETTE));}catch(_){}
  /* v7.50 连续选色：置位「取色中」屏蔽外部点击误关，短时延后自动解除。
     注意此处**不调 rerender() 重建面板** —— 那会在用户连续点第二个色块时把 DOM 换掉，
     既打断操作又让系统取色器失焦。色值靠 applyMsPalette() 直接作用于页面（CSS 变量 + 重绘节点），
     再手动把同项的 hex 文本刷新，观感与整块重绘一致但不重建 DOM。 */
  msPalettePicking=true;
  clearTimeout(changeMsPalette._t);
  changeMsPalette._t=setTimeout(()=>{ msPalettePicking=false; },600);
  /* 关键：传 noRedraw=true 跳过面板重建。
     否则 applyMsPalette() 会调 renderMsPaletteUI() 换掉整个 #msPaletteBox 的 DOM ——
     用户点第二个色块时面板已被重建，既打断连续操作、又会让系统取色器失焦。 */
  applyMsPalette(true);
  // 就地刷新该项的 hex 文本（DOM 未被替换，此处查询一定命中活节点）
  if(MS_PALETTE_META){
    let i=0, hit=null;
    for(const g of MS_PALETTE_META){
      for(const it of g.items){ if(it.k===k){ hit=i; break; } i++; }
      if(hit!=null) break;
    }
    if(hit!=null){
      const el=document.querySelectorAll('#msPaletteBox .mp-item')[hit];
      if(el){
        const hex=el.querySelector('.mp-hex'); if(hex) hex.textContent=(val==='')?'默认':val.toUpperCase();
        const inp=el.querySelector('.mp-color'); if(inp && inp.value.toLowerCase()!==val.toLowerCase() && val!=='') inp.value=val;
      }
    }
  }
}
function resetMsPalette(){
  MS_PALETTE=Object.assign({},MS_PALETTE_DEF);
  try{localStorage.setItem(MS_PAL_KEY,JSON.stringify(MS_PALETTE));}catch(_){}
  applyMsPalette(); rerender();
  toast('🎨 配色已恢复默认（关键节点 + 甘特图条）');
}
/* 阶段节点默认色：需求未自定义时取色板值 */
function msPhaseColor(r,key){
  if(r&&r.phaseColors&&r.phaseColors[key]) return r.phaseColors[key];
  return (key==='l2')?MS_PALETTE.msL2:MS_PALETTE.msL1;
}
/* 虚线/节点缺省色 */
function msDefaultColor(){ return MS_PALETTE.msLine; }
/* 渲染色板面板 UI（挂进 #colorPop 的 #msPaletteBox 容器） */
function renderMsPaletteUI(){
  const box=document.getElementById('msPaletteBox'); if(!box) return;
  let h='';
  MS_PALETTE_META.forEach(g=>{
    h+=`<div class="mp-grp"><div class="mp-grp-t">${g.group}</div><div class="mp-items">`;
    g.items.forEach(it=>{
      const v=MS_PALETTE[it.k];
      /* v7.56：barOpen 默认空串（= 不改，沿用实底兜底）。<input type="color"> 不接受空值，
         故显示时用兜底色占位，hex 文本显示「默认」；用户一改即写入真值。 */
      const empty=(v==='');
      const shown=empty?'#a89680':v;
      h+=`<div class="mp-item" title="${escAttr(it.desc)}">
        <input type="color" class="mp-color" value="${shown}" oninput="changeMsPalette('${it.k}',this.value)">
        <span class="mp-lab">${escHtml(it.label)}</span>
        <code class="mp-hex">${empty?'默认':v.toUpperCase()}</code>
      </div>`;
      /* v7.61：在「竖向虚线色」后面嵌入不透明度滑块 */
      if(it.k==='msLine'){
        const op=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ms-link-opacity'))||1;
        const opPct=Math.round(op*100);
        h+=`<div class="mp-item mp-opac-row" title="调节关键节点竖向虚线的可见度（100%=默认，调高更醒目，调低更淡）">
          <span class="mp-lab">虚线浓度</span>
          <input type="range" id="msLinkOpacRange" min="20" max="200" step="5" value="${opPct}" oninput="setMsLinkOpac(+this.value)" style="flex:1;min-width:80px">
          <code class="mp-hex" id="msLinkOpacVal">${opPct}%</code>
          <button class="mp-opac-reset" onclick="setMsLinkOpac(100)" title="恢复默认浓度">↺</button>
        </div>`;
      }
    });
    h+=`</div></div>`;
  });
  box.innerHTML=h;
}
let msCtx=null;   // {mode:'add'|'edit'|'phase', reqId, msIdx, phkey, which}
function msColorSwatches(cur){
  return MS_COLORS.map(c=>`<span class="ms-sw${c===cur?' on':''}" data-c="${c}" style="background:${c}" onclick="msPickColor('${c}')"></span>`).join('');
}
function msPickColor(c){
  const h=document.getElementById('msColor'); if(h)h.value=c;
  document.querySelectorAll('.ms-sw').forEach(s=>s.classList.toggle('on',s.dataset.c===c));
}
function msReqOptions(selId){
  return reqs.filter(r=>r.kind!=='lt').map(r=>`<option value="${r.id}" ${r.id===selId?'selected':''}>${escAttr(r.name)}</option>`).join('');
}
/* 新增关键节点：入口=汇总行「＋」按钮 / 汇总行空白右键 / 需求条右键菜单 */
function openAddMilestone(reqId, dateIdx){
  if(!requireWrite())return;
  hideMenu();
  msCtx={mode:'add'};
  const defDate=(dateIdx!=null)?i2d(dateIdx):TODAY;
  const body=`
    <div class="ctx" style="background:#fdf6e3;border-color:#eadfae;color:#8a6d2f">新增关键节点（里程碑）。它会出现在顶部「🚩 关键节点」行，并以竖向虚线连到所属需求条目。</div>
    <div class="fld"><label>所属需求</label><select id="msReq">${msReqOptions(reqId)}</select></div>
    <div class="row2">
      <div class="fld"><label>节点名称</label><input type="text" id="msLabel" placeholder="如：封版 / 内审通过"></div>
      <div class="fld"><label>日期</label><input type="date" id="msDate" value="${dInput(defDate)}"></div>
    </div>
    <div class="fld"><label>颜色</label><div class="ms-swrow">${msColorSwatches(MS_COLORS[0])}</div><input type="hidden" id="msColor" value="${MS_COLORS[0]}"></div>
    <div class="warn" id="msWarn"></div>`;
  renderAddModal('🚩','新增关键节点',body,true);
  const ok=document.getElementById('addOk'); if(ok)ok.setAttribute('onclick','confirmAddMilestone()');
}
function _msReadForm(warn){
  const r=reqs.find(x=>x.id===document.getElementById('msReq').value);
  const label=(document.getElementById('msLabel').value||'').trim();
  const d=parseInput(document.getElementById('msDate').value);
  const color=document.getElementById('msColor').value||MS_COLORS[0];
  if(!r){warn.textContent='请选择需求';warn.classList.add('show');return null;}
  if(!label){warn.textContent='请填写节点名称';warn.classList.add('show');return null;}
  if(!d){warn.textContent='请选择日期';warn.classList.add('show');return null;}
  return {r,label,d,color};
}
function confirmAddMilestone(){
  if(!requireWrite())return;
  const f=_msReadForm(document.getElementById('msWarn')); if(!f)return;
  pushHistory();
  (f.r.milestones=f.r.milestones||[]).push({date:f.d,label:f.label,color:f.color,type:'custom'});
  _logDesc='新增关键节点：'+f.label;
  save();broadcast();closeAdd();rerender();
  toast('已新增关键节点：'+f.label);
}
/* 编辑关键节点：右键节点（汇总行菱形 / 条内圆点）弹出 */
function openEditMilestone(reqId, msIdx){
  if(!requireWrite())return;
  hideMenu();
  const r=reqs.find(x=>x.id===reqId); if(!r)return;
  const ms=(r.milestones||[])[msIdx]; if(!ms)return;
  msCtx={mode:'edit',reqId,msIdx};
  const cur=ms.color||MS_COLORS[0];
  const body=`
    <div class="ctx" style="background:#fdf6e3;border-color:#eadfae;color:#8a6d2f">修改关键节点「${escAttr(ms.label)}」。可改所属需求 / 名称 / 日期 / 颜色，改动实时同步两个视图。</div>
    <div class="fld"><label>所属需求</label><select id="msReq">${msReqOptions(reqId)}</select></div>
    <div class="row2">
      <div class="fld"><label>节点名称</label><input type="text" id="msLabel" value="${escAttr(ms.label)}"></div>
      <div class="fld"><label>日期</label><input type="date" id="msDate" value="${dInput(ms.date)}"></div>
    </div>
    <div class="fld"><label>颜色</label><div class="ms-swrow">${msColorSwatches(cur)}</div><input type="hidden" id="msColor" value="${cur}"></div>
    <div class="warn" id="msWarn"></div>
    <div style="margin-top:10px"><button class="am-cancel" id="msDelBtn" style="color:#ef3b39;border-color:#f3c1c0" onclick="deleteMilestone()">🗑 删除该节点</button></div>`;
  renderAddModal('🚩','编辑关键节点',body,true);
  const ok=document.getElementById('addOk'); if(ok)ok.setAttribute('onclick','confirmEditMilestone()');
}
function confirmEditMilestone(){
  if(!requireWrite()||!msCtx)return;
  const f=_msReadForm(document.getElementById('msWarn')); if(!f)return;
  pushHistory();
  const or=reqs.find(x=>x.id===msCtx.reqId);
  if(or)(or.milestones||[]).splice(msCtx.msIdx,1);          // 先从原需求移除
  (f.r.milestones=f.r.milestones||[]).push({date:f.d,label:f.label,color:f.color,type:'custom'});  // 再加入目标（支持跨需求移动）
  _logDesc='编辑关键节点：'+f.label;
  save();broadcast();closeAdd();rerender();
  toast('关键节点已更新：'+f.label);
}
/* v7.46：删除改两段式确认 —— 首次点击把按钮切成「确认删除」态（4 秒无操作自动复位），
   再次点击才真删。用同弹层内的按钮态翻转实现，不引 window.confirm（会被浏览器拦截且样式割裂）。 */
function deleteMilestone(){
  if(!requireWrite()||!msCtx)return;
  const r=reqs.find(x=>x.id===msCtx.reqId); if(!r){closeAdd();return;}
  const ms=(r.milestones||[])[msCtx.msIdx]; if(!ms){closeAdd();return;}
  const label=ms.label||'';
  const btn=document.getElementById('msDelBtn');
  if(btn && btn.dataset.armed!=='1'){
    btn.dataset.armed='1'; btn.textContent='⚠️ 再点一次确认删除'; btn.style.background='#fdecec';
    setTimeout(()=>{
      if(btn.isConnected && btn.dataset.armed==='1'){
        btn.dataset.armed=''; btn.textContent='🗑 删除该节点'; btn.style.background='';
      }
    },4000);
    return;
  }
  pushHistory();
  (r.milestones||[]).splice(msCtx.msIdx,1);
  _logDesc='删除关键节点：'+label;
  save();broadcast();closeAdd();rerender();
  toast('已删除关键节点：'+label);
}
/* 编辑阶段节点（L1完成 / L2完成·联调开始）：日期写回逻辑与拖拽圆点一致；颜色存 r.phaseColors */
function openEditPhaseNode(reqId, phkey){
  if(!requireWrite())return;
  hideMenu();
  const r=reqs.find(x=>x.id===reqId); if(!r)return;
  const ph=getPhases(r);
  const which=phkey==='l2'?2:1;
  const curD=which===2?ph.split2:ph.split;
  if(curD==null){toast('该需求无此阶段节点');return;}
  msCtx={mode:'phase',reqId,phkey,which};
  const meta=PHASE_NODE_META[phkey]||PHASE_NODE_META.l1;
  const cur=msPhaseColor(r,phkey);   // v7.47：走统一色板
  const desc=which===2?'日期即「联调开始」时间（与拖拽该圆点等效，会同步移动联调子需求）':'日期即「L1 完成 / L2 开始」分割时间（与拖拽该圆点等效）';
  const body=`
    <div class="ctx" style="background:#eef6ff;border-color:#bcd9f7;color:#185fa5">修改阶段节点「${meta.label}」。${desc}。</div>
    <div class="row2">
      <div class="fld"><label>${meta.label}日期</label><input type="date" id="msDate" value="${dInput(i2d(curD))}"></div>
      <div class="fld"><label>颜色</label><div class="ms-swrow">${msColorSwatches(cur)}</div><input type="hidden" id="msColor" value="${cur}"></div>
    </div>
    <div class="warn" id="msWarn"></div>`;
  renderAddModal('◆','编辑阶段节点',body,true);
  const ok=document.getElementById('addOk'); if(ok)ok.setAttribute('onclick','confirmEditPhaseNode()');
}
function confirmEditPhaseNode(){
  if(!requireWrite()||!msCtx)return;
  const warn=document.getElementById('msWarn');
  const r=reqs.find(x=>x.id===msCtx.reqId); if(!r){closeAdd();return;}
  const d=parseInput(document.getElementById('msDate').value);
  if(!d){warn.textContent='请选择日期';warn.classList.add('show');return;}
  const color=document.getElementById('msColor').value;
  const newIdx=idx(d);
  pushHistory();
  const ph=getPhases(r);
  if(msCtx.which===2){
    // 与拖拽 split2 一致：移动联调子需求 segs 起点（锚定结束），split2 派生自 lt.s
    const addons=(r.children||[]).map(id=>reqs.find(x=>x.id===id)).filter(Boolean);
    addons.forEach(a=>a.segs.forEach(sg=>{ const se=idx(sg.e); sg.s=i2d(Math.min(Math.max(newIdx,0),se)); }));
    addons.forEach(a=>{ if(a.segs.length) a.end=i2d(Math.max(...a.segs.map(x=>idx(x.e)))); });
  }else{
    r.split=Math.max(ph.s+1,Math.min(ph.l2.e-1,newIdx));   // 同拖拽 L1/L2 分割的夹取区间
  }
  (r.phaseColors=r.phaseColors||{})[msCtx.phkey]=color;
  _logDesc='编辑阶段节点：'+msCtx.phkey;
  save();broadcast();closeAdd();rerender();
  toast('阶段节点已更新');
}

/* ============ 泳道分配：把时间重叠的任务条拆到多行并行 ============ */
/* 自适应条高：单任务时条占满行高（饱满），同行多任务并行时按泳道平分自动变窄。
   ROW_BASE=单泳道行高；PADV=行内上下留白；LANE_GAP=泳道间距；BAR_MIN=多泳道时单条最小高度（保证可读）。 */
const ROW_BASE=44, PADV=6, LANE_GAP=5, BAR_MIN=24;   // v6.21 统一间距：PADV=6(上下留白), LANE_GAP=5(条间距), ROW_BASE=44(单条行高=6+32+6)
const LANE_TOP=PADV;  // 兼容旧引用
function assignLanes(items){               // items: [{s,e,...}]，s/e 为天索引
  const arr=items.slice().sort((a,b)=>a.s-b.s||a.e-b.e);
  const laneEnd=[];                        // 每条泳道当前占用到的结束索引
  arr.forEach(it=>{
    let placed=-1;
    for(let i=0;i<laneEnd.length;i++){ if(it.s>=laneEnd[i]){placed=i;break;} }
    if(placed<0){placed=laneEnd.length;laneEnd.push(0);}
    it.lane=placed; laneEnd[placed]=it.e;
  });
  return {items:arr,lanes:Math.max(laneEnd.length,1)};
}

/* ============ 视图1：按人 ============ */
function renderPerson(){
  gapData.clear();   // v6.49：每次重渲染前清空，避免已删除/已改派成员的旧空隙残留污染色带标记
  // 先筛出可见成员。离职者一律保留（交给归档逻辑收纳进底部归档区，可展开），
  // 仅在「关闭自动归档」时才用 leftLong 做 31 天硬隐藏，避免列表无限堆积。
  const visible=members.filter(m=>{
    if(!ARCHIVE.on && leftLong(m)) return false;
    if(focusMode==='only' && focusRole(m)==='') return false;
    return true;
  });
  const live=visible.filter(m=>!memArchived(m));
  const archived=visible.filter(m=>memArchived(m));
  const mode=GROUP_MODE.person;
  // 基础排序（所有模式通用）：状态 → 编制 → 隶属 → 品级 → 支援 → 拼音（v6.87 统一规则）
  live.sort((a,b)=>personSortCompare(a,b));
  // v7.43：按人视图顶部插入里程碑汇总行（方案 C），始终置顶在所有成员/分组之前。
  let rows=milestoneSummaryRowHTML();
  if(mode==='none' || view!=='person'){
    live.forEach(m=>{ rows+=personRowHTML(m); });
  }else{
    // 按分组聚合
    const groups={}; const order=[];
    live.forEach(m=>{
      const g=personGroupKey(m); const k=g.key;
      if(!groups[k]){groups[k]={g,arr:[]};order.push(k);}
      groups[k].arr.push(m);
    });
    order.sort((a,b)=> groupSortVal(a)-groupSortVal(b) || groups[a].g.label.localeCompare(groups[b].g.label,'zh-Hans-CN'));
    order.forEach(k=>{
      const {g,arr}=groups[k];
      // 组内排序：状态 → 编制 → 隶属 → 品级 → 支援 → 拼音（同 personSortCompare 规则）
      arr.sort((a,b)=>personSortCompare(a,b));
      rows+=groupHeaderHTML(g,arr.length,false,'');
      if(!collapsed[k]) arr.forEach(m=>{ rows+=personRowHTML(m); });
    });
  }
  // 归档区（始终置底，默认折叠）
  if(archived.length){
    const gk={key:'__arch_person__',label:'已归档成员（离职超期）',color:'#9097a0'};
    rows+=groupHeaderHTML(gk,archived.length,true,`离职超过 ${archiveLabel()} 自动收纳 · 点击展开`);
    if(!collapsed[gk.key]) archived.forEach(m=>{ rows+=personRowHTML(m,true); });
  }
  paint(rows);
}
/* v5.34 暂缺占位行：将「暂缺」成员渲染为缺人状态卡（非真人行）
   - 左侧：虚线卡片 + 🔴缺人占位 + 模块/角色/效率信息
   - 时间线：斜纹 vacant-bar（已有 CSS）
   - 可被 isVacantMem / computeHR 统计识别 */
function vacantRowHTML(m,inArc){
    // 收集此占位的任务段（与真人行同样的逻辑，但用 vacant-bar 样式）
    const items=[];
    reqs.forEach(r=>r.segs.forEach((s,si)=>{
      if(s.m!==m.id)return;
      if(!segHasDuration(s)) return;                     // v6.64 统一时长判定
      if(HIDE_DONE[view] && reqIsCompleted(r)) return;   // 纯观看过滤（不影响下方空隙计算）
      let si0=idx(s.s),ei0=idx(s.e);
      const _ot=segOpenType(s);
      if(_ot==='front') si0=0;
      else if(_ot==='back') ei0=DAYS;
      else if(_ot==='both'){ si0=0; ei0=DAYS; }
      items.push({r,sg:s,si,si0,ei0});
    }));
    const laid=assignLanes(items.map(it=>({...it,s:it.si0,e:it.ei0})));
    const laneCount=Math.max(laid.lanes,1);
    /* v6.54：占位行原来完全没有空隙计算（gapData.set 只在 personRowHTML 里调用），
       所以常态下永远不显示空闲标识；而拖拽走 refreshGapsForMember 不区分成员类型 → 又会算出来，
       造成"常态无、拖拽有"的不一致。此处补上与真人行同源的计算。
       v6.64：改为直接调 getMemberBusyIntervals（全量数据、不读 HIDE_DONE），与真人行完全同一条路径。 */
    gapData.set(m.id, gapsFromIntervals(getMemberBusyIntervals(m.id)));
    let rowH = laneCount<=1 ? ROW_BASE : Math.max(ROW_BASE, PADV*2 + laneCount*BAR_MIN + (laneCount-1)*LANE_GAP);
    /* v6.47：占位行原来所有条都写死 top:0%;height:100%（铺满整格、零缝隙），并行时条与条紧贴、
       与真人行的固定 5px 缝隙不一致（用户反馈"贴得这么紧"）。现改为与 personRowHTML 完全同一套
       「重叠簇均高等分 + 固定像素缝隙」算法：clusterLanesOf 求传递闭包簇 → 簇内等分 → 扣 GAP_PX。 */
    const GAP_PX=5;                                  // 与真人行同值，保证两种行的条间缝隙视觉一致
    const clusterLanesOf=(it)=>{
      const inC=new Set([it]); const stk=[it];
      while(stk.length){ const cur=stk.pop();
        for(const b of laid.items){ if(inC.has(b))continue; if(b.si0<cur.ei0 && b.ei0>cur.si0){ inC.add(b); stk.push(b);} } }
      return [...new Set([...inC].map(b=>b.lane))].sort((a,b)=>a-b);
    };
    let bars='';
    laid.items.forEach(it=>{
      const {r,sg,si}=it;
      const openType=segOpenType(sg);
      let x=it.si0*DAY_W, w=(it.ei0-it.si0)*DAY_W;
      if(openType==='front'){ x=0; w=it.ei0*DAY_W; }
      else if(openType==='back'){ w=(DAYS-it.si0)*DAY_W; }
      else if(openType==='both'){ x=0; w=DAYS*DAY_W; }
      // 与真人行同源的纵向定位：本条所在重叠簇内等高等分，条间恒定 GAP_PX 缝隙
      const overlapLanes=clusterLanesOf(it);
      const kPar=Math.max(overlapLanes.length,1);
      const posPar=Math.max(overlapLanes.indexOf(it.lane),0);
      const segTop=posPar/kPar;
      const segH=1/kPar;
      const slotH=segH*rowH;
      const barHpx=Math.max(2, slotH-GAP_PX);
      const topPct=(((segTop*rowH)+(GAP_PX/2))/rowH*100).toFixed(3);
      const hPct=(barHpx/rowH*100).toFixed(3);
      const risk=reqRisk(r);
      const owd = overdueWorkdays(r);                   // v7.36 工作日口径超期数（排除周末+法定节假日）
      const auto=autoSegState(sg);
      const st=STATUS[auto.status||'doing'];
      const barWpx = w;
      const nShow = Math.max(1, Math.floor(barWpx / 55));
      // 安全获取人天（open段无日期时跳过segDigestOne）
      const pdays = openType ? '' : r1(segDigestOne(r,sg,m.id).digest);
      const lblInner = reqTitleHTML(r,{pdays, nShow, barWpx, barHpx});
      // 根据 corp 区分缺正编/缺基地（前置声明，供下方 tip / 角标复用，避免 TDZ）
      const isRegVac = m.corp === 'reg';
      const vacTypeLabel = isRegVac ? '缺正编' : '缺基地';
      const vacTypeIcon = isRegVac ? '🔴' : '🔴';
      const vacBadgeCls = isRegVac ? 'vacant-badge-reg' : 'vacant-badge-base';
      const winTip = openType==='front' ? `起始待定 → ${fmtEnd(sg.e)}（前端无限）`
        : openType==='back' ? `${fmt(sg.s)} → 结束待定（后端无限）`
        : openType==='both' ? '时间待定（长期/持续）'
        : `${fmt(sg.s)} → ${fmtEnd(sg.e)}`;
      const tip=`<b>${r.name}</b><br><span class='g'>占位</span> ${m.name}（${vacTypeLabel}）　<span class='g'>状态</span> ${st.label}<br><span class='g'>进度</span> 缺失（无人执行）　<span class='g'>窗口</span> ${winTip}<br><span class='g'>风险</span> ${risk.lvl} · 缺口${risk.gap}人天${owd>0?overdueTipText(r,owd):''}<br><span style='color:#f87171'>⚠ 此坑位缺人，分配真人后自动转为正常任务条</span>`;
      const slimCls = (barHpx/rowH)<0.34 ? ' slim' : '';   // v6.47 与真人行一致：条纤细时缩小字号
      bars+=`<div class="bar-task ${barCls(r,{...sg,status:auto.status})} vacant-bar${slimCls}${openType?' open open-'+openType:''}" data-req="${r.id}" data-seg="${si}" style="left:${x}px;width:${w}px;top:${topPct}%;height:${hPct}%;--gcol:${(HR_GRADE[r.grade]||HR_GRADE['']).col}"
        onmousemove="showTip(event,\`${tip}\`)" onmouseleave="hideTip()">
        <i class="sdot"></i><span class="rt-line">${lblInner}${auto.status==='overdue'&&!reqIsDone(r)?segOverdueBadge():''}${owd>0?segOverdueWDBadge(owd):''}</span><span class="vacant-badge ${vacBadgeCls}" title="${vacTypeLabel}占位">${vacTypeIcon}${vacTypeLabel}</span>
        ${(openType==='back'||openType==='both')?'<i class="open-r">»</i>':''}
        <div class="prog" style="--p:0"></div>
        ${segStdOverflowZone(sg,r,{...m,corp:'base'})}
        <i class="grip gl"></i><i class="grip gr"></i></div>`;
    });
    // 占位卡左侧信息 — 根据 corp 区分缺正编/缺基地
    const isRegVac = m.corp === 'reg';
    /* v6.48 坑位编号：名字里的编号后缀（如「暂缺-正编2」「暂缺-基地3」）提取出来显示在标题上，
       让同类的多个占位坑位可区分（旧版正编占位全叫"暂缺"，多个坑位在界面和隶属下拉里都撞车）。
       编号通过「✎ 编辑」改成员名维护（如把 name 改为 暂缺-正编1），此处只负责解析展示。 */
    const vacSeq = (()=>{ const mm=(m.name||'').match(/(?:正编|基地)\s*([0-9]+|[一二三四五六七八九十]+)/); return mm?mm[1]:''; })();
    const vacTypeLabel = (isRegVac ? '缺正编占位' : '缺基地占位') + (vacSeq?(' '+vacSeq):'');
    const vacTypeIcon = isRegVac ? '🔴' : '🔴';
    const vacBorderCls = isRegVac ? 'vacant-card-reg' : 'vacant-card-base';
    const vacRowBorder = '#f87171';  // 统一红色边框
    const effShow = m.eff && m.eff!==1 ? `<span class="vc-eff">⚡ 效率 ${m.eff}</span>` : '';
    /* v6.48 按编制区分占位行的可设置内容（基地与正编职责不同，不该给同一套标签）：
       - 正编占位 = 未来的「带队人」→ 需要提前规划负责的角色品级+模块（结构化 leadMap），
         并可用「坑位编号」区分同类的多个正编坑位（正编1/正编2/…）。
       - 基地占位 = 未来的「执行人力」→ 模块由所接需求(r.mod)决定、不属于人，因此
         **不显示成员级模块标签**（旧版显示 m.mod 的"出场"，与甘特条上各需求的实际模块不一致，
         用户反馈"模块设置与甘特条内容不一致"）；只需设置隶属哪个正编（含暂缺正编）。 */
    let tagsHTML='';
    if(isRegVac){
      const leadDisp = formatLeadDisplay(m);
      tagsHTML = `<span class="ltag lead editable vac-tag" onpointerdown="event.stopPropagation()" onclick="startEditLead(event,'${m.id}','lead')" title="点击设置：该正编坑位未来负责的角色品级与模块（招到人后直接沿用）">${leadDisp || '<span class="vac-hint">👑 未设置负责范围</span>'}<i class="edp">✎</i></span>`;
    }else{
      const belongTxt = (m.lead && m.lead!=='—' && m.lead!=='-') ? m.lead : '';
      const isVacLead = /暂缺/.test(belongTxt);   // 隶属的是一个「暂缺正编」坑位 → 加虚线提示样式
      tagsHTML = `<span class="ltag belong editable vac-tag${belongTxt?(isVacLead?' lead-vac':''):' vacant'}" onpointerdown="event.stopPropagation()" onclick="startEditLead(event,'${m.id}','belong')" title="点击设置：该基地坑位隶属哪个正编带队（可选尚未到岗的暂缺正编坑位）">${belongTxt?(isVacLead?'隶属 ⏳'+escAttr(belongTxt):'隶属 '+escAttr(belongTxt)):'<span class="vacant-ic">👑</span>未设置隶属'}<i class="edp">✎</i></span>`;
    }
    // 模块标签统一由上方 tagsHTML（formatLeadDisplay / leadMap 编辑器）负责渲染，不再单独读 m.mod 显示
    return `<div class="row vacant-row${inArc?' in-archived':''} vacant-row-${isRegVac?'reg':'base'}" data-mem="${m.id}" style="min-height:${rowH}px;border-left-color:${vacRowBorder}">
      <div class="cell-left">
        <i class="row-grip" title="按住上下拖动：自定义成员排序（同组内生效，自动保存并同步团队）" onpointerdown="rowGripDown(event,'${m.id}')">⋮⋮</i>
        <div class="vacant-card ${vacBorderCls}">
          <div class="vc-icon">${vacTypeIcon}</div>
          <div class="vc-body">
            <span class="vc-label">${vacTypeLabel}</span>
            <div class="vc-tags">
              ${tagsHTML}
              ${effShow}
            </div>
          </div>
          <div class="vc-act">
            <button onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();openEditMember('${m.id}')" title="编辑占位（可改为真人或调整）">✎ 编辑</button>
            <button onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();openAddTaskFor('${m.id}')" title="给此占位分配需求"><span class="pl">＋</span> 任务</button>
          </div>
        </div>
      </div>
      <div class="timeline" style="width:${DAYS*DAY_W}px">${bars}</div>
    </div>`;
}
/* 渲染单个成员行（inArc=是否归档区内，仅加淡化样式类） */
function personRowHTML(m,inArc){
    /* v5.34：暂缺成员 → 渲染为「缺人占位状态卡」，不再伪装成真人行 */
    if(isVacantMem(m)) return vacantRowHTML(m,inArc);
    const fr=focusRole(m);
    const L=memLoad(m.id);
    const MS=MSTATUS[m.status||'on'];
    const WG=memWorkGrade(m.id);   // 动态品级：从 hrData 角色线取，跟随任务而非人
    const G=WG?HR_GRADE[WG]:null;
    const CP=CORP[m.corp]||CORP.base;
    const isLeft=effLeft(m);   // 仅离职日已到才灰化/打徽标；未来离职日仍按在岗呈现
    // 收集此人所有任务段
    const items=[];
    reqs.forEach(r=>r.segs.forEach((s,si)=>{
      if(s.m!==m.id)return;
      if(!segHasDuration(s)) return;                     // v6.64 统一时长判定
      if(HIDE_DONE[view] && reqIsCompleted(r)) return;   // 纯观看过滤：不渲染此条（不影响下方空隙/负载计算）
      let si0=idx(s.s),ei0=idx(s.e);
      const _ot=segOpenType(s);
      if(_ot==='front') si0=0;
      else if(_ot==='back') ei0=DAYS;
      else if(_ot==='both'){ si0=0; ei0=DAYS; }    // 无明确时间(open)段铺满整行，按整行占位
      items.push({r,sg:s,si,si0,ei0});
    }));
    // 跨队「支援」改为标注在对应任务条上（见 bars 渲染的 .sup-mk），不再挂在姓名旁。
    // 分配泳道（用天索引判重叠）；open 段已在上方归一化为整行 [0,DAYS) 占位，故此处直接用 si0/ei0。
    const laid=assignLanes(items.map(it=>({...it,s:it.si0,e:it.ei0})));
    const laneCount=Math.max(laid.lanes,1);
    // v6.26：计算此人排期「内部空隙」（合并重叠段后，相邻任务块间 ≥MIN_WORKDAYS 天的空闲）
    // v6.64 关键修正：原来从 laid.items 推导——而 items 已被 HIDE_DONE 过滤，
    //   勾上「隐藏已完成」后已完成需求占的档期会被当成空闲，空闲标识凭空变多、与真实排期不符。
    //   改为直接调用 getMemberBusyIntervals(全量数据、不读 HIDE_DONE)，与拖拽时的
    //   refreshGapsForMember 完全同源，保证「静态渲染 = 拖拽刷新 = 真实占用」三者一致。
    gapData.set(m.id, gapsFromIntervals(getMemberBusyIntervals(m.id)));
    /* 「时间重叠传递闭包」内的 distinct lane 列表：用于均高等分定位。
       关键修复——只看「直接重叠」会在链式重叠(A↔B↔C 但 A、C 不重叠)时算出不一致的分母，
       导致同簇内的条槽位错位、互相压盖(同一垂直位糊成一团)。改用传递闭包后，同一重叠簇内
       所有条共享同一分母(簇内 distinct lane 数)、各按自身 lane 排名占槽，链式重叠也绝不重叠。
       不重叠的条各自成簇(lane 数=1)，仍铺满整行，与原行为一致。 */
    const clusterLanesOf=(it)=>{
      const inC=new Set([it]); const stk=[it];
      while(stk.length){ const cur=stk.pop();
        for(const b of laid.items){ if(inC.has(b))continue; if(b.si0<cur.ei0 && b.ei0>cur.si0){ inC.add(b); stk.push(b);} } }
      return [...new Set([...inC].map(b=>b.lane))].sort((a,b)=>a-b);
    };
    /* 自适应条高（关键）：纵向位置/高度全部用「行实际高度的百分比」表达，而不是固定像素。
       这样无论左侧信息栏把行撑多高，蓝条都会自动充满整行：
       · 某条任务所在时段没有别的条目挤占 → 它向上下吞并相邻空泳道，纵向占满整行（填满红框）。
       · 某条任务所在时段确有并行 → 只有真正打架的条目各占一槽、等高等分。
       槽位用 (lo/laneCount ~ hi/laneCount) 的百分比切分，bar 之间留固定像素缝隙（GAP_PX，不随并行数比例缩放）。 */
    const GAP_PX=5;                                  // v6.26fix: 固定像素条间缝隙（替代旧 FILL 比例缩放；并行越少缝隙也一致，不再忽大忽小）
    /* 行高 v4.8：横向单行标签后不再需要为「竖排 N 行」撑高。
       单泳道维持基础行高（横排单行足够）；多泳道时按 BAR_MIN 保证每条不低于可读下限。 */
    let rowH = laneCount<=1 ? ROW_BASE
               : Math.max(ROW_BASE, PADV*2 + laneCount*BAR_MIN + (laneCount-1)*LANE_GAP);
    // 判断某泳道在 [s,e) 时段是否被别的条目占用
    const occupied=(lane,s,e)=> laid.items.some(b=> b.lane===lane && b.si0<e && b.ei0>s);
    let bars='';
    laid.items.forEach(it=>{
      const {r,sg,si}=it;
      const openType=segOpenType(sg);
      // 无明确时间段：按 open 类型决定铺满方向（前端/后端/两端无限，靠 CSS 羽化表达"未定/持续"）
      let x=it.si0*DAY_W, w=(it.ei0-it.si0)*DAY_W;
      if(openType==='front'){ x=0; w=it.ei0*DAY_W; }
      else if(openType==='back'){ w=(DAYS-it.si0)*DAY_W; }
      else if(openType==='both'){ x=0; w=DAYS*DAY_W; }
      // 局部并行密度等分（关键·均高）：每条的纵向高度/位置只取决于它所在时段「真正并行的条数」，
      // 而不再被远期高并行撑大的全局 laneCount 影响、也不贪心吞并空泳道（旧算法会让某条独吞下方空槽
      // 变超高、相邻条被夹扁，导致同一个人的两条任务高度参差不齐）。改为：与本条时间重叠的若干条，
      // 平均瓜分该时段的整行高度（等高居中），不重叠的条各自按其局部并行数占位——既保证同时段的条
      // 等高、又不为远期泳道预留空白。assignLanes 已保证重叠条 lane 互异，故按重叠集合的 lane 排名定位不会相互压盖。
      const overlapLanes=clusterLanesOf(it);                   // 本条所在「重叠簇」的 distinct lane 列表（传递闭包，避免链式重叠压盖）
      const kPar=Math.max(overlapLanes.length,1);              // 本簇并行条数（同簇统一分母）
      const posPar=Math.max(overlapLanes.indexOf(it.lane),0);  // 本条在簇内的次序（0-based）
      const segTop=posPar/kPar;                                // 本条在簇内次序占比（0-based）
      const segH=1/kPar;                                       // 本条占整行高度比（等分）
      const slotH=segH*rowH;                                   // 本条所在簇槽位的完整像素高度
      const barHpx=Math.max(2, slotH-GAP_PX);                  // v6.26fix: 固定像素缝隙后本条像素高度（缝隙恒定，并行多少都整齐）
      const topPct=(((segTop*rowH)+(GAP_PX/2))/rowH*100).toFixed(3);
      const hPct=(barHpx/rowH*100).toFixed(3);
      const frac=barHpx/rowH;                                  // 本条实际占整行内高比例（估算是否纤细）
      const slimCls = frac<0.34 ? ' slim' : '';
      const risk=reqRisk(r);
      const owd = overdueWorkdays(r);                   // v7.36 工作日口径超期数（排除周末+法定节假日）
      // v5.8：状态/进度按今天日期自动推算（到开始日灰→蓝，进度随已过工作日增长；休息日不推进）。
      //       人工「已完成/废弃」仍为准，不被日期覆盖。构造 autoSeg 供着色/标签/进度统一使用。
      const auto=autoSegState(sg);
      const autoSeg={...sg, status:auto.status};        // 用于 barCls 着色（其余字段透传，供 k-lt/k-qa 等判断）
      const st=STATUS[auto.status||'doing'];
      const effProg=auto.prog;
      // 已完成呈现（与「按需求看」统一）：整条需求完成 → seg-done（深绿「✓已完成」居中印章）；
      // 仅本人这段完成 → seg-done-self（浅色「✓本人完成」居中）；其余照常。条内信息随之淡化锁定。
      const doneCls = reqIsDone(r) ? ' seg-done' : (auto.status==='done' ? ' seg-done-self' : '');
      const winTip = openType==='front' ? `<span class='g'>窗口</span> 起始待定 → ${fmtEnd(sg.e)}（前端无限延长）`
        : openType==='back' ? `<span class='g'>窗口</span> ${fmt(sg.s)} → 结束待定（后端无限延长）`
        : openType==='both' ? `<span class='g'>窗口</span> 时间待定（前后延长 · 长期/持续）`
        : `<span class='g'>窗口</span> ${fmt(sg.s)} → ${fmtEnd(sg.e)}`;
      /* 横向单行 v4.8：按条子像素宽度决定显示几个信息位（任务名永远显示），按高度选字号档。
         任务名 > 模块 > 人天 > 投入比 优先级递减；窄条从右往左省略，不缩字号硬撑、不换行裁切。 */
      const barWpx = w;                                                     // 本条像素宽度
      const nShow = calcNShow(barWpx);                                      // 1~4，按条宽自动选
      const szTier = pickSizeTier(barHpx);                                  // 1=正常 2=紧凑
      // 复用「按需求看」的居中大浮标：整条完成 + 条够宽够高（不溢出/不遮挡）→ done-float 居中「✓ 已完成」，
      // 条内信息淡化衬底；太窄(<108px)或太矮(<24px)则回退行内小徽标保命。浮标字号按条高分两档。
      const canFloat = reqIsDone(r) && barWpx>=108 && barHpx>=24;
      const floatCls = canFloat ? (barHpx>=34?' done-float':' done-float sm') : '';
      const tip=`<b>${r.name}</b><br><span class='g'>负责</span> ${m.name}　<span class='g'>状态</span> ${st.label}<br><span class='g'>进度</span> ${Math.round(effProg*100)}%　${winTip}<br><span class='g'>风险</span> ${risk.lvl} · 缺口${risk.gap}人天${owd>0?overdueTipText(r,owd):''}<br><span class='g' style='color:#7da0ff'>单击改状态 · 上下拖改派</span>`;
      const lblInner = reqTitleHTML(r,{pdays:r1(segDigestOne(r,sg,m.id).digest), nShow, barWpx, barHpx});
      bars+=`<div class="bar-task ${barCls(r,autoSeg,m)}${slimCls}${doneCls}${floatCls}${openType?' open open-'+openType:''}" data-req="${r.id}" data-seg="${si}" style="left:${x}px;width:${w}px;top:${topPct}%;height:${hPct}%;--gcol:${(HR_GRADE[r.grade]||HR_GRADE['']).col}"
        onmousemove="showTip(event,\`${tip}\`)" onmouseleave="hideTip()">
        <i class="sdot"></i><span class="rt-line" data-sz="${szTier}">${lblInner}${segInvBadge(sg,nShow)}${canFloat?'':segDoneBadge(r,sg)}${auto.status==='overdue'&&!reqIsDone(r)&&(m.corp!=='reg'&&m.corp!=='sub')?segOverdueBadge():''}${owd>0&&m.corp!=='reg'&&m.corp!=='sub'?segOverdueWDBadge(owd):''}</span>
        ${isSupportInReq(m,r)?'<i class="sup-mk" title="该任务为跨队支援">支</i>':''}
        ${(openType==='back'||openType==='both')?'<i class="open-r">»</i>':''}
        <div class="prog" style="--p:${Math.round(effProg*100)}">${openType?'':restBlocksHTML(it.si0,it.ei0)}</div>
        ${segStdOverflowZone(sg,r,m)}
        <i class="grip gl"></i><i class="grip gr"></i></div>`;
    });
    const focusCls = focusMode==='hl' ? (fr==='self'?' me-self':fr==='team'?' me-team':' dim') : (fr==='self'?' me-self':fr==='team'?' me-team':'');
    const isBase = m.corp === 'base';
    const isLoan=isExtLoan(m);
    /* v7.48 借入人员：行标青色，与外借（橙/紫）区分 */
    const isIn=isLoanIn(m);
    const L0=curLoan(m);
    /* v7.48 行内徽标改为读借调记录，显示对方与结束日，比原来写死的「外借支援 XXX」信息量大 */
    let loanNoteHTML='';
    if(isLoan||isIn){
      const dirIc=isIn?'↙':'↗';
      const party=(L0&&L0.party)?L0.party:(m.mod||'其他管线');
      const toTxt=(L0&&L0.to)?('至 '+fmt(L0.to)):'长期';
      const sealedTxt=(L0&&L0.state==='sealed')?'（已封存）':'';
      loanNoteHTML=`<span class="${isIn?'loan-in-note':'loan-note'}" onclick="event.stopPropagation();openLoanHistory('${m.id}')" title="${isIn?'从其他管线借来支援（临时隶属）':'长期外借：编制保留在本团队，实际支援'}${escAttr(party)}，不参与角色线需求排期&#10;${toTxt}${sealedTxt}｜点击查看完整借调记录">${dirIc} ${isIn?'借入自':'外借去'} ${escAttr(party)} · ${toTxt}${sealedTxt}</span>`;
    }
    return `<div class="row${isLeft?' is-left':''}${isLoan?' is-loan':''}${isIn?' is-loan-in':''}${isBase && !isLeft?' is-base':''}${inArc?' in-archived':''}${focusCls}" data-mem="${m.id}" style="min-height:${rowH}px">
      <div class="cell-left">
        <i class="row-grip" title="按住上下拖动：自定义成员排序（同组内生效，自动保存并同步团队）" onpointerdown="rowGripDown(event,'${m.id}')">⋮⋮</i>
        <div class="emp-badge ${m.corp}" title="${m.corp==='reg'?'正编（带队）':m.corp==='sub'?'子公司':'基地'}">
          <span class="el">${m.corp==='reg'?'正编':m.corp==='sub'?'子':'基地'}</span>
          <i class="ed mstat" data-mem="${m.id}" style="background:${MS.col}" title="${MS.label}（点击设置：在岗/忙碌/请假/外出/离职/新人）"></i>
          ${L.pct>110?'<i class="olflag" title="超载">!</i>':''}
        </div>
        <div class="who">
          <div class="nm"><span class="gdot-grade" style="background:${(G||HR_GRADE['']).col}" title="${G?G.label+'级':'未设品级'}"></span>${m.name}${(()=>{const rk=rookieFlag(m);return rk==='new'?'<span class="hr-flag new" title="新人（分配制作需求未满1个月，满月自动转正常）">新人</span>':rk==='tmp'?'<span class="tmp-tag" title="临时（分配制作需求未满1个月，满月自动转正常）">临</span>':'';})()}${isLeft?'<span class="hr-flag left">已离职</span>':(m.status==='left'?`<span class="hr-flag pend-left" title="已登记离职，离职日 ${fmt(m.leftAt)} 当天起生效；在此之前仍按在岗排期">待离职 ${fmt(m.leftAt)}</span>`:'')}${L.pct>110?'<span class="ol-badge" title="负载超过110%，已影响其参与需求的风险">⚠ 超载</span>':''}<button class="inl-edit" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();openEditMember('${m.id}')" title="编辑成员信息（姓名/编制/隶属/模块/效率/状态）">✎</button><button class="inl-add" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();openAddTaskFor('${m.id}')" title="给 ${m.name} 新分配一条任务（选择需求与起止）"><span class="pl">＋</span>加任务</button></div>
          <div class="tags">
            ${loanNoteHTML||(m.corp==='reg'||m.corp==='sub'?`<span class="ltag lead editable" onpointerdown="event.stopPropagation()" onclick="startEditLead(event,'${m.id}','lead')" title="点击编辑：负责的角色与模块（可下拉选择）">${formatLeadDisplay(m)}<i class="edp">✎</i></span>`:`<span class="ltag belong editable ${(!m.lead||m.lead==='—'||m.lead==='-')?'vacant':''}" onpointerdown="event.stopPropagation()" onclick="startEditLead(event,'${m.id}','belong')" title="点击更换：隶属的正编带队${(m.line&&m.line!=='-')?'　·　'+lineName(m.line):''}">${(!m.lead||m.lead==='—'||m.lead==='-')?'<span class="vacant-ic">👑</span>暂缺':'隶属 '+escAttr(m.lead)}<i class="edp">✎</i></span>`)}
            <span class="ltag eff" title="效率系数（1.0 为基准产能，>1 更快、<1 更慢）">⚡ 效率 ${m.eff}</span>
          </div>
        </div>
        <div class="load"><div class="pct" style="color:${L.col}">${L.pct}% ${L.cls}</div>
          <div class="bar-l${L.pct>110?' over':''}"><i style="width:${Math.min(L.pct,100)}%;background:${L.col}"></i></div></div>
      </div>
      <div class="timeline" style="width:${DAYS*DAY_W}px;box-shadow:inset 3px 0 0 0 ${(G||HR_GRADE['']).col}">${bars}</div>
    </div>`;
}

/* ============ 视图2：按需求 ============ */
function renderReq(){
  // 可见需求（联调已改为独立需求行，全部需求均参与渲染）；按分组方式归类，已完结超期的收纳进归档区。
  const vis=reqs;
  // v6.64：此处 HIDE_DONE 仅决定「这一行要不要出现在列表里」，属纯观看过滤，
  //   不参与任何统计/缺口/风险计算（那些一律基于全量 reqs），故保留。
  const hideDone=HIDE_DONE[view];
  const live=vis.filter(r=>!reqArchived(r) && !(hideDone && reqIsCompleted(r)));
  const archived=vis.filter(r=>reqArchived(r) && !(hideDone && reqIsCompleted(r)));
  const mode=GROUP_MODE.req;
  // v7.45：按需求视图同按人视图，顶部也插「🚩 关键节点」汇总行
  let rows=milestoneSummaryRowHTML();
  // band 连续性基于"实际相邻渲染的需求"，故按分组排好序后整体连续传 prev/next。
  const emit=(list)=>{
    list.forEach((r,i)=>{ rows+=reqRowHTML(r, list[i-1], list[i+1]); });
  };
  if(mode==='none'){
    emit(live);
  }else{
    const groups={}, order=[];
    live.forEach(r=>{ const g=reqGroupKey(r), k=g.key; if(!groups[k]){groups[k]={g,arr:[]};order.push(k);} groups[k].arr.push(r); });
    // mod 分组按 MOD_META 中出现顺序近似；char 按首次出现。这里统一按首次出现顺序，稳定直观。
    order.forEach(k=>{
      const {g,arr}=groups[k];
      rows+=groupHeaderHTML(g,arr.length,false,'');
      if(!collapsed[k]) arr.forEach((r,i)=>{ rows+=reqRowHTML(r, arr[i-1], arr[i+1]); });
    });
  }
  if(archived.length){
    const gk={key:'__arch_req__',label:'已归档需求（完结超期）',color:'#9097a0'};
    rows+=groupHeaderHTML(gk,archived.length,true,`完结超过 ${archiveLabel()} 自动收纳 · 点击展开`);
    if(!collapsed[gk.key]) archived.forEach((r,i)=>{ rows+=reqRowHTML(r, archived[i-1], archived[i+1], true); });
  }
  paint(rows);
}
function reqRowHTML(r, prevR, nextR, inArc){
    const risk=reqRisk(r);
    // 整条需求无明确时间：当其全部任务段都标记 open（时间待定）时，需求条也铺满整行延长
    const reqOpen = r.segs.length>0 && r.segs.every(s=>s.open);
    const allS=Math.min(...r.segs.map(s=>idx(s.s)));
    const allE=Math.max(...r.segs.map(s=>idx(s.e)));
    const x=allS*DAY_W,w=(allE-allS)*DAY_W;
    // 剩余工作日：独立计算（不走 risk，终态需求也保留真实数字）。
    const endD=r.end||i2d(allE);
    const leftWD = reqOpen?0:Math.max(workdays(TODAY, endD),0);
    // 进度口径：时间进度 =（总工作日 − 剩余工作日）/ 总工作日。不再用「工作量 done/estimate」。
    const prog=(()=>{
      if(reqOpen) return 0;
      const totalWD=workdays(i2d(allS), endD);
      if(totalWD<=0) return (TODAY>=endD)?100:0;
      const p=Math.round((totalWD-leftWD)/totalWD*100);
      return Math.max(0,Math.min(100,p));
    })();
    const ag=STATUS[aggStatus(r)];
    // 状态文案：优先认人工设定的需求级终态（废弃/暂停），已完成含派生态(reqIsDone)，否则按段聚合状态
    const stLabel = reqState(r)==='dropped'?'已废弃':reqState(r)==='paused'?'已暂停':reqIsDone(r)?'已完成':ag.label;
    const g=HR_GRADE[r.grade]||HR_GRADE[''];
    // 参与本需求的人（去重），带编制信息
    const memObjs=risk.pplNames.map(n=>members.find(m=>m.name===n)).filter(Boolean).filter(m=>!leftLong(m));
    // 组内排序：隶属关系(同带队相邻) → 能力强度(红>金>橙>常规) → 支援关系(本队前/支援后)，离职沉底
    const GRADE_RANK={'红':3,'金':2,'橙':1,'':0};
    const sortMem=arr=>[...arr].sort((a,b)=>{
      const la=effLeft(a)?1:0, lb=effLeft(b)?1:0;
      if(la!==lb) return la-lb;                                   // 离职沉底
      const lda=leadOf(a)||'~', ldb=leadOf(b)||'~';
      if(lda!==ldb) return lda.localeCompare(ldb,'zh-Hans-CN');   // 隶属分组相邻
      const ga=GRADE_RANK[a.grade]||0, gb=GRADE_RANK[b.grade]||0;
      if(ga!==gb) return gb-ga;                                   // 能力强 → 前
      const sa=a.support?1:0, sb=b.support?1:0;
      if(sa!==sb) return sa-sb;                                   // 本队 → 前，支援 → 后
      return (a.name||'').localeCompare(b.name||'','zh-Hans-CN');
    });
    const regs=sortMem(memObjs.filter(m=>m.corp==='reg'||m.corp==='sub'));
    const bases=sortMem(memObjs.filter(m=>m.corp!=='reg'&&m.corp!=='sub'));
    const olTip = risk.overloaded.length?`<br><span class='g' style='color:#ff8f8f'>⚠ 超载占用</span> ${risk.overloaded.join('、')}（产能已折损）`:'';
    const gapTip = risk.gapPpl>0?`<br><span class='g' style='color:#ff8f8f'>⚠ 人力缺口</span> 标配${stdCfgBaseForReq(r)}人 · 在岗${activeBase(r)}人 · 缺 ${risk.gapPpl} 人${risk.started?'（已开工，计入高风险）':'（后续压力，计入中风险）'}`:'';
    const teamTip = `<br><span class='g'>团队</span> 正编${regs.length}人${regs.length?'（'+regs.map(m=>m.name).join('、')+'）':''} · 基地${bases.length}人${bases.length?'（'+bases.map(m=>m.name).join('、')+'）':''}`;
    const tip=`<b>${r.name}</b><br><span class='g'>角色</span> ${r.char||'-'} · <span style='color:${g.col}'>${g.label}级</span> · ${r.mod||''}<br><span class='g'>状态</span> ${stLabel}　<span class='g'>时间进度</span> ${prog}% · 剩余${leftWD}工作日<br><span class='g'>窗口</span> ${fmt(i2d(allS))} → ${fmtEnd(i2d(allE))}${teamTip}<br><span class='g'>风险主因</span> ${risk.cause} → <b>${risk.lvl}风险</b>${gapTip}${olTip}<br><span class='g' style='color:#7da0ff'>单击改整条状态</span>`;
    // 统一人员标签：底色=编制(正编蓝/基地淡白)，橙环=跨队支援，新/临/离=角标。mini=蓝条内小号。隶属带队色圆点已去除（与编制色冲突）
    const reqLead = reqLeadOf(r);
    const ptag=(m,mini)=>{
      const myLead=leadOf(m);
      const isSup = isSupportInReq(m,r);   // 动态：仅当该成员隶属导师 ≠ 本需求带队归属才算支援
      const corpCls = m.corp==='reg'?'reg':m.corp==='sub'?'sub':'base';
      const stCls = effLeft(m)?' is-left':'';
      const supCls = isSup?' is-sup':'';
      const miniCls = mini?' mini':'';
      const crown = (m.corp==='reg'||m.corp==='sub')?'<i class="crown">👑</i>':'';
      const dot = '';   // 已去除隶属带队色圆点：编制已统一按 corpStyle 着色，隶属圆点冗余且与编制色混淆
      let marks='';
      if(isSup) marks+='<i class="mk mk-sup" title="跨队支援">支</i>';
      const rk=rookieFlag(m);
      if(rk==='new') marks+='<i class="mk mk-new" title="新人（分配未满1个月，满月自动转正常）">新</i>';
      else if(rk==='tmp') marks+='<i class="mk mk-tmp" title="临时（分配未满1个月，满月自动转正常）">临</i>';
      const ttl=`${m.corp==='reg'?'正编·带队':m.corp==='sub'?'子公司':'基地'}${myLead?' · 隶属'+myLead:''}${isSup?' · 跨队支援'+(reqLead?'('+reqLead+'线)':''):''}${effLeft(m)?' · 已离职':m.status==='left'?' · 待离职('+fmt(m.leftAt)+')':m.status==='new'?' · 新人':''}　[拖拽可改派到其他需求]`;
      return `<span class="ptag ${corpCls}${supCls}${stCls}${miniCls}" title="${ttl}" data-chip-mem="${m.id}" data-chip-req="${r.id}">${crown}${dot}<span class="nm-txt">${m.name}</span>${marks}</span>`;
    };
    // 左侧：按编制分两行（正编行 / 基地行），不混排。加人按钮统一移到时间线侧（不再每组各放一个）
    const groupRow=(label,arr,cls,corp)=>
      `<div class="who-grp ${cls}"><span class="grp-lab">${label}</span><div class="grp-chips">${arr.map(m=>ptag(m,false)).join('')}</div></div>`;
    const chips = memObjs.length
      ? groupRow('正编',regs,'reg-grp','reg')+groupRow('基地',bases,'base-grp','base')
      : `<div class="who-grp"><div class="grp-chips"><span class="ptag none">未排人</span></div></div>`;
    const addPersonRow = `<div class="who-grp add-row"><span class="grp-lab"></span><button class="inl-add" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();openAddPersonTo('${r.id}')" title="给「${r.name}」加人（可选正编或基地）"><span class="pl">＋</span>加人</button></div>`;
    // 蓝条内：同样按编制分两行，复用 ptag.mini
    const blRow=(label,arr)=> arr.length
      ? `<div class="bl-row"><span class="bl-cnt">${label}${arr.length}</span>${arr.map(m=>ptag(m,true)).join('')}</div>`
      : '';
    const blChips = memObjs.length
      ? blRow('正',regs)+blRow('基',bases)
      : '<div class="bl-row"><span class="bl-cnt">未排人</span></div>';
    const teamCount = `<span class="team-cnt"><b style="color:#0052d9">正编${regs.length}</b> · <b style="color:#56607a">基地${bases.length}</b></span>`;
    const gapBadge = risk.gapPpl>0?`<span class="gap-pill" title="标配${stdCfgBaseForReq(r)}人，当前在岗基地${activeBase(r)}人，缺${risk.gapPpl}人（已计入风险，加人后即时更新）">缺${risk.gapPpl}人</span>`:'';
    const MM = modMeta(r.mod);
    const modTag = `<span class="mod-tag" style="color:${modFamC(r.mod)}"><i>${MM.ic}</i>${MM.s}</span>`;
    // ===== 左侧单条品级色带：金/橙/红 按角色品级标注颜色 =====
    // 同品级的相邻行，竖带去掉圆角并向上下溢出 1px，视觉上连成一整条 → 体现「这几行同属一个品级」。
    const gKey=r.grade||'', gCol=g.col;
    const sameGradeUp   = prevR && (prevR.grade||'')===gKey;
    const sameGradeDown = nextR && (nextR.grade||'')===gKey;
    const contCls=(up,down)=> (up?' j-up':'')+(down?' j-down':'');
    const bands=`<span class="lv-bands" aria-hidden="true">`
      +`<i class="lv lv-grade${contCls(sameGradeUp,sameGradeDown)}" style="background:${gCol}" title="品级：${g.label}"></i>`
      +`</span>`;
    const rs=reqState(r);
    const rsCls = rs==='dropped'?' req-dropped':rs==='paused'?' req-paused':reqIsDone(r)?' req-done':'';
    // 产能消化泳道（一人一行甘特）：废弃/时间待定不画
    const laneObj = reqOpen ? null : capacityLanesHTML(r);
    const laneH = laneObj ? laneObj.h : 0;
    const rowHTML=`<div class="row req-row${inArc?' in-archived':''}${rsCls}${laneH?' has-lanes':''}" data-req-row="${r.id}" style="--lane-h:${laneH}px">
      <div class="cell-left has-bands">
        ${bands}
        <span class="gdot-grade" style="background:${g.col}" title="${g.label}级"></span>
        <div class="req" style="flex:1;min-width:0">
          <div class="nm">${reqTitleHTML(r)}${reqStateTag(r)}</div>
          <div class="who-groups">${chips}${addPersonRow}</div>
          <div class="meta">进度${prog}% · <span class="left-d">剩${leftWD}工作日</span></div>
          <div class="meta meta-team">${teamCount}</div>
        </div>
        <span class="req-badges">${gapBadge}<span class="badge ${risk.cls}">${risk.lvl}风险</span></span>
      </div>
      <div class="timeline" style="width:${DAYS*DAY_W}px">
        ${(()=>{
          // 整条需求时间待定：铺满整行、两端羽化的 open 条（不画 L1/L2/联调分段与分割线）
          if(reqOpen){
            return `<div class="bar-task req-bar open ${barCls(r,null)}" data-req="${r.id}" style="left:0;width:${DAYS*DAY_W}px"
            onmousemove="showTip(event,\`${tip}\`)" onmouseleave="hideTip()">
            <div class="prog" style="--p:${prog}"></div>
            <i class="sdot"></i>
            <div class="bl-top"><span class="rt-line">${reqTitleHTML(r)}</span><span class="bl-pct">${prog}%</span></div>
            <div class="bl-sub"><div class="bl-rows">${blChips}</div></div>
            <i class="open-r">»</i>${reqCmtBtnHTML(r)}</div>`;
          }
          const ph=getPhases(r);
          const bx=ph.barS*DAY_W, bw=Math.max((ph.barE-ph.barS)*DAY_W,46);
          const span=Math.max(ph.barE-ph.barS,1);
          // v7.45：L1/L2/联调分段色块已移除（用户决策），阶段节点改由 reqPhaseNodesHTML 画菱形圆点
          return `<div class="bar-task req-bar ${barCls(r,null)}" data-req="${r.id}" style="left:${bx}px;width:${bw}px;--gcol:${gCol}"
          onmousemove="showTip(event,\`${tip}\`)" onmouseleave="hideTip()">
          <div class="prog" style="--p:${prog}">${restBlocksHTML(ph.barS,ph.barE)}</div>
          <i class="sdot"></i>
          <div class="bl-top"><span class="rt-line">${reqTitleHTML(r)}</span><span class="bl-pct">${prog}%</span></div>
          ${laneH?laneObj.html:`<div class="bl-sub"><div class="bl-rows">${blChips}</div></div>`}
          <!-- v7.45：阶段节点菱形圆点（L1完成/L2完成·联调开始），可拖拽改期、右键编辑日期/颜色 -->
          ${reqPhaseNodesHTML(r,ph)}
          <!-- 自定义关键节点（圆形条内圆点），右键编辑 -->
          ${reqMilestonesHTML(r,ph.barS,ph.barE,span)}
          <i class="grip gl"></i><i class="grip gr"></i>${reqCmtBtnHTML(r)}</div>`;
        })()}
      </div>
    </div>`;
  return rowHTML;
}

/* ============ 需求图条·评论（折叠=只留标签 / 悬停展开 / 单击常态展开 / 再点收起） ============ */
let pinnedReqId=null, cmtHideT=null;
window.__cmtSuppressTip=false;
function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function getComment(r){return (r&&(r.comment||''))||'';}
function reqCmtBtnHTML(r){
  const c=getComment(r).trim();
  const pinned=pinnedReqId===r.id;
  const tip=c?('评论：'+c.slice(0,40)+(c.length>40?'…':'')+'　· 悬停展开 / 单击常态展开 / 再点收起'):'添加评论';
  return `<span class="cmt-btn ${c?'has':'empty'}${pinned?' pinned':''}" data-cmt="${r.id}" role="button" tabindex="0" title="${escAttr(tip)}">${c?'💬':'✎'}</span>`;
}
function showCommentPop(reqId,anchor){
  const r=reqs.find(x=>x.id===reqId); if(!r)return;
  let pop=document.getElementById('cmtPop');
  if(!pop){ pop=document.createElement('div'); pop.id='cmtPop'; document.body.appendChild(pop); }
  const c=getComment(r).trim();
  pop.innerHTML=`<div class="cmt-h"><span class="cmt-ic">💬</span><b>评论</b><span class="cmt-req">${escHtml(r.name)}</span></div>`
    +`<div class="cmt-body">${c?escHtml(c).replace(/\n/g,'<br>'):'<span class="cmt-empty">暂无评论，点「编辑」添加</span>'}</div>`
    +`<div class="cmt-ft"><button class="cmt-edit" onclick="openCommentEditor('${reqId}')">编辑</button>${pinnedReqId===reqId?'<button class="cmt-collapse" onclick="unpinComment()">收起</button>':''}</div>`;
  pop.style.display='block';
  window.__cmtSuppressTip=true; if(typeof hideTip==='function')hideTip();
  const a=anchor.getBoundingClientRect();
  const pw=pop.offsetWidth, ph=pop.offsetHeight;
  let left=Math.min(a.right-pw, a.left); if(left<6)left=6;
  let top=a.bottom+6;
  if(top+ph>window.innerHeight-6) top=Math.max(6,a.top-ph-6);
  pop.style.left=left+'px'; pop.style.top=top+'px';
  pop._reqId=reqId;
  clearTimeout(cmtHideT);
}
function hideCommentPop(){
  const pop=document.getElementById('cmtPop'); if(pop)pop.style.display='none';
  if(!pinnedReqId) window.__cmtSuppressTip=false;
}
function toggleCommentPin(reqId,anchor){
  if(pinnedReqId===reqId){ pinnedReqId=null; hideCommentPop(); }
  else { pinnedReqId=reqId; showCommentPop(reqId,anchor); }
  document.querySelectorAll('.cmt-btn').forEach(b=>b.classList.toggle('pinned', b.dataset.cmt===pinnedReqId));
}
function unpinComment(){ pinnedReqId=null; hideCommentPop(); document.querySelectorAll('.cmt-btn').forEach(b=>b.classList.remove('pinned')); }
function resyncCommentPin(){
  if(!pinnedReqId)return;
  const b=document.querySelector('.cmt-btn[data-cmt="'+pinnedReqId+'"]');
  if(!b){ pinnedReqId=null; hideCommentPop(); return; }
  b.classList.add('pinned');
  showCommentPop(pinnedReqId,b);
}
function openCommentEditor(reqId){
  if(!requireWrite())return;
  const r=reqs.find(x=>x.id===reqId); if(!r)return;
  const body=`<div class="fld" style="margin:0"><label>评论内容</label><textarea id="cmtText" rows="5" placeholder="填写该需求的备注 / 风险提示 / 协同说明…">${escHtml(getComment(r))}</textarea></div>`;
  renderAddModal('💬','编辑评论',body,true);
  const ok=document.getElementById('addOk'); if(ok){ ok.textContent='保存评论'; ok.setAttribute('onclick','confirmCommentEdit(\''+reqId+'\')'); }
}
function confirmCommentEdit(reqId){
  const r=reqs.find(x=>x.id===reqId); if(!r)return;
  const el=document.getElementById('cmtText'); const v=(el?el.value:'').trim();
  pushHistory();
  r.comment=v; _logDesc='编辑评论：'+(r.name||reqId);
  pinnedReqId=reqId;            // 编辑后常态展开，便于即时看到结果
  save();broadcast();closeAdd();
  rerender();
  setTimeout(()=>{ const b=document.querySelector('.cmt-btn[data-cmt="'+reqId+'"]'); if(b)showCommentPop(reqId,b); },0);
  toast(v?'评论已保存':'评论已清空');
}
/* 事件委托：悬停展开 / 单击常态展开 / 再点收起（单次绑定） */
(function(){
  document.addEventListener('mouseover',e=>{
    const b=e.target.closest && e.target.closest('.cmt-btn');
    const p=e.target.closest && e.target.closest('#cmtPop');
    if(b){ clearTimeout(cmtHideT); showCommentPop(b.dataset.cmt,b); }
    else if(p){ clearTimeout(cmtHideT); }
  });
  document.addEventListener('mouseout',e=>{
    const b=e.target.closest && e.target.closest('.cmt-btn');
    const p=e.target.closest && e.target.closest('#cmtPop');
    if(b && pinnedReqId!==b.dataset.cmt){ cmtHideT=setTimeout(()=>{ if(pinnedReqId!==b.dataset.cmt) hideCommentPop(); },180); }
    else if(p && !pinnedReqId){ cmtHideT=setTimeout(hideCommentPop,180); }
  });
  document.addEventListener('click',e=>{
    const b=e.target.closest && e.target.closest('.cmt-btn');
    if(b){ e.stopPropagation(); e.preventDefault(); toggleCommentPin(b.dataset.cmt,b); }
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){ const p=document.getElementById('cmtPop'); if(p&&p.style.display==='block'&&!pinnedReqId)p.style.display='none'; }
  });
})();

/* ============ v6.26 排期空隙提示 ============ */
/* 取某成员「忙碌区间」（合并重叠段），可选 transient 覆盖某一任务段的瞬时位置（拖拽中用）。
   仅用于空隙计算，不依赖泳道分配。 */
function getMemberBusyIntervals(mid, transient){
  const ivs=[];
  reqs.forEach(r=>r.segs.forEach((s,si)=>{
    if(s.m!==mid) return;
    // v6.64：**不再读 HIDE_DONE** —— 「隐藏已完成」是观看过滤，不是数据事实。
    //   一个人在已完成需求上占用的档期，客观上就是占了；若因勾选开关把它当空闲，
    //   空闲标识/负载色带会凭空多出一段，与真实排期不符。
    if(!segHasDuration(s)) return;          // 与全局同源的时长判定
    let si0=idx(s.s), ei0=idx(s.e);
    const _ot=segOpenType(s);
    if(_ot==='front') si0=0;
    else if(_ot==='back') ei0=DAYS;
    else if(_ot==='both'){ si0=0; ei0=DAYS; }
    if(transient && transient.reqId===r.id && transient.seg===si){ si0=transient.si0; ei0=transient.ei0; }
    ivs.push({s:si0,e:ei0});
  }));
  if(!ivs.length) return [];
  ivs.sort((a,b)=>a.s-b.s||a.e-b.e);
  const merged=[];
  for(const iv of ivs){
    if(merged.length && iv.s<=merged[merged.length-1].e) merged[merged.length-1].e=Math.max(merged[merged.length-1].e, iv.e);
    else merged.push({s:iv.s,e:iv.e});
  }
  return merged;
}
/* 由合并后的忙碌区间求「内部空隙」（相邻任务块之间的空闲段）。
   不含行首/行尾（1400 天窗口的首尾空隙无意义），只标真正插在排期中间的空档。
   v6.43：改为工作日口径 —— days 只数工作日（排除周末/节假日，用 shadeType 判定），
   阈值也按工作日比较。这样「周五结束、下周一开始」那种纯周末间隔不会再被误标成空闲。 */
function gapsFromIntervals(merged){
  const gaps=[]; const MIN_WORKDAYS=2;
  for(let i=0;i<merged.length-1;i++){
    const a=merged[i], b=merged[i+1];
    const x0=a.e, x1=b.s;
    if(x1<=x0) continue;
    // 统计该区间内的工作日天数（shadeType 非 null = 周末或节假日 → 不计）
    let wd=0;
    for(let d=x0; d<x1; d++){ if(shadeType(d)===null) wd++; }
    if(wd>=MIN_WORKDAYS) gaps.push({x0, x1, days:wd, calDays:(x1-x0)});
  }
  return gaps;
}
/* v6.46 空隙块构建（统一入口，injectGapIndicators 与 refreshGapsForMember 共用）。
   按可用像素宽度做「信息自适应降级」，不再让固定文案被父级硬裁切：
     ≥84px → 空闲 N 工作日   （完整语义）
     ≥58px → 空闲 N 天        （去掉"工作"二字，仍可理解）
     ≥34px → N 天             （只留最关键的数字+单位）
     ≥20px → N                （极窄：纯数字，配合琥珀条纹底仍可猜出是空档）
     < 20px → 不放标签         （只保留底纹+边框示意，避免糊成一团）
   hover title 始终携带完整信息，任何档位都能查到准确口径。 */
function buildGapEl(g){
  const wpx=(g.x1-g.x0)*DAY_W;
  const tip=`空档 ${g.days} 个工作日（共 ${g.calDays} 天，已排除周末/节假日）`;
  const d=document.createElement('div');
  d.className='gap-indicator';
  d.style.left=(g.x0*DAY_W)+'px';
  d.style.width=wpx+'px';
  d.title=tip;                     // 整块可查完整信息（含无标签的极窄档）
  let txt=null, tier='';
  if(wpx>=84){ txt=`空闲 ${g.days} 工作日`; tier='1'; }
  else if(wpx>=58){ txt=`空闲 ${g.days} 天`; tier='2'; }
  else if(wpx>=34){ txt=`${g.days} 天`; tier='3'; }
  else if(wpx>=20){ txt=`${g.days}`; tier='4'; }
  if(txt!==null){
    d.innerHTML=`<span class="gap-lbl" data-tier="${tier}" title="${tip}">${txt}</span>`;
  }else{
    d.classList.add('gap-tiny');   // 极窄：无标签，靠底纹+左右端点强化示意
  }
  return d;
}
/* paint 后调用：把 gapData 中的空隙注入对应行的 .timeline（半透琥珀底纹）。
   先清旧再注入，出错只影响该块，绝不拖垮整页。 */
function injectGapIndicators(){
  if(view!=='person') return;
  document.querySelectorAll('.gap-indicator').forEach(el=>el.remove());
  document.querySelectorAll('#grid .row[data-mem]').forEach(row=>{
    const mid=row.getAttribute('data-mem');
    const gaps=gapData.get(mid);
    if(!gaps||!gaps.length) return;
    const tl=row.querySelector('.timeline');
    if(!tl) return;
    gaps.forEach(g=>tl.appendChild(buildGapEl(g)));
  });
}
/* 拖拽过程中实时重算某人空隙（transient 覆盖被拖段的瞬时天索引），只动该行 DOM。
   v6.49：同时刷新色带上的下划线标记，保证拖拽过程中两者边界始终一致（不再一个动一个不动）。 */
function refreshGapsForMember(mid, transient){
  const merged=getMemberBusyIntervals(mid, transient);
  const gaps=gapsFromIntervals(merged);
  gapData.set(mid, gaps);
  const row=document.querySelector(`#grid .row[data-mem="${mid}"]`);
  if(row){
    const tl=row.querySelector('.timeline');
    if(tl){
      tl.querySelectorAll('.gap-indicator').forEach(el=>el.remove());
      gaps.forEach(g=>tl.appendChild(buildGapEl(g)));
    }
  }
  try{ refreshBandGapMarks(); }catch(_){}   // 色带下划线同步重算（出错不影响拖拽）
}
/* 由当前 gapData 重算色带下划线（与 loadHeatmapHTML 第 8 步同一算法），只替换 .load-gap-mark 节点。
   抽出来供拖拽实时调用，避免整页 rerender。 */
function refreshBandGapMarks(){
  const track=document.querySelector('#loadHeatmap .load-track');
  if(!track) return;
  track.querySelectorAll('.load-gap-mark').forEach(el=>el.remove());
  const allGaps=[];
  gapData.forEach((gaps, mid)=>{
    const mem=members.find(x=>x.id===mid);
    if(!mem || isVacantMem(mem)) return;
    (gaps||[]).forEach(g=>allGaps.push({s:g.x0, e:g.x1, name:mem.name}));
  });
  if(!allGaps.length) return;
  allGaps.sort((a,b)=>a.s-b.s||a.e-b.e);
  const unions=[];
  allGaps.forEach(g=>{
    const last=unions[unions.length-1];
    if(last && g.s<=last.e){ last.e=Math.max(last.e,g.e); if(!last.who.includes(g.name)) last.who.push(g.name); }
    else unions.push({s:g.s, e:g.e, who:[g.name]});
  });
  unions.forEach(u=>{
    let wd=0; for(let d=u.s; d<u.e; d++){ if(shadeType(d)===null) wd++; }
    const d=document.createElement('div');
    d.className='load-gap-mark';
    d.style.left=(u.s*DAY_W)+'px';
    d.style.width=((u.e-u.s)*DAY_W)+'px';
    d.title=`⏳ 排期空隙 ${wd} 个工作日（共 ${u.e-u.s} 天，已排除周末/节假日）　${u.who.join('、')} 此期间有空档`;
    track.appendChild(d);
  });
}

function paint(rows){
  const h=headerHTML();
  const [head,rest]=h.split('__VLINES__');
  const [vlines,todayLine]=rest.split('__TODAY__');   // v7.12：红线独立成层，见 headerHTML 注释
  const loadBar = loadHeatmapHTML();
  document.getElementById('grid').innerHTML =
    /* v7.47：钉选层已移除，只保留 hover 胶囊层。
       层级由 v7.41 的 z-index:50 大幅下调 —— 它只要不穿过甘特行即可，
       绝不能压住顶部冻结信息行(.row.head z7)与负载带(.load-heatmap z6)。 */
    `<div class="sel-pill-layer"><div class="sel-pill hover-pill" id="dateSelHoverPill"></div></div>`
    + head + `<div style="position:absolute;left:var(--left-w);top:86px;bottom:0;right:0;pointer-events:none">${vlines}</div>`
    // 红线专属贯穿层：top:0 从表头顶端起笔，与表头上方的胶囊箭头首尾相接
    + `<div class="today-layer" style="position:absolute;left:var(--left-w);top:0;bottom:0;right:0;pointer-events:none;z-index:8">${todayLine}</div>`
    + loadBar
    + `<div class="drop-band" id="dropBand"></div><div class="drop-guide" id="dropG0"></div><div class="drop-guide gend" id="dropG1"></div>`
    /* v7.40 日期悬停层（v7.47 仅保留 hover，pin 已删）：仿 today-layer 用 left:var(--left-w) 包裹，
       内部 left=天索引×DAY_W。pointer-events:none 不挡交互。 */
    + `<div class="date-sel-layer"><div id="dateSelHover" class="sel-band hover"></div></div>`
    /* v7.45：关键节点→需求条目 竖向虚线层（仿 today 层，高度由 syncMsLinks 实测需求行设定） */
    + msLinkLayerHTML()
    /* v7.47：需求条内关键节点的出框文字标签层（无 overflow 裁切，可溢出到条外） */
    + msBarLabelLayerHTML()
    + rows;
  updateKPIs();
  if(typeof reapplySelection==='function') reapplySelection();
  if(typeof bindDaySelect==='function') bindDaySelect();
  if(typeof applyDateSel==='function') applyDateSel();
  injectGapIndicators();   // v6.26：渲染后注入排期空隙提示（半透琥珀，始终显示）
  alignStripes();          // v6.83：把所有 45° 斜纹块对齐到全局坐标系（固定瓦片+双轴补偿）
  // v5.0：渲染后按真实像素实测降级标签（横排隐藏低优先徽标 → 缩字号 → 竖排 → 省略号）
  requestAnimationFrame(fitBarLabels);
  requestAnimationFrame(syncXWideLabels);   // v7.54：超宽条文字跟随视口（仅针对该条目显示问题）
  /* v7.12：今天日期胶囊——渲染完成后同步一次位置。
     胶囊本体常驻在 board 上方的 #todayRailTrack 里（见 syncTodayLabel），
     不再每次 paint 重建 DOM，也不再挂到 #sec-gantt（那样会被 overflow:hidden 裁 / 不随滚动走）。 */
  syncTodayLabel();
  syncMsLinks();   // v7.45：渲染完成后实测各需求行位置，设定关键节点虚线的 top/height
  if(typeof syncMsBarLabels==='function') syncMsBarLabels();   // v7.47：同步需求条内关键节点的出框标签
}

/* ===== v7.12 今天日期胶囊定位（单一入口：paint / 滚动 / 缩放 / 栏宽变化都走这里）=====
   为什么用「实测几何」而不是坐标推算：
     v7.11 的做法是 left = calc(var(--left-w) + tx)，纯推算且漏了 scrollLeft，
     横向滚动时红线走了、胶囊不动（实测滚 400px 直接错位 400px）。
   即使补上 scrollLeft，推算链路里还夹着 .board 的 1px 边框、vlines 层的 --left-w 偏移
   等多个中间量，任一改动都会重新引入亚像素错位（实测残留 1px）。
   故直接量红线与 track 的真实视口矩形做差 —— 边框/padding/缩放全部自动抵消，恒对齐。 */
function syncTodayLabel(){
  const track = document.getElementById('todayRailTrack');
  const rail  = document.getElementById('todayRail');
  if(!track) return;
  const tl = document.querySelector('.todayline');
  const sc = document.getElementById('scroll');
  const layer = document.querySelector('.today-layer');
  /* v7.19：红线层属于可横向滚动的完整内容画布；仅把冻结左栏的 z-index 提高，
     无法覆盖透明空隙，所以红线仍会漏进成员区。
     这里按当前 scrollLeft 从红线层左侧做几何裁剪：该层本地 x=scrollLeft 以前的内容
     正是被左侧冻结栏遮住的区域。这样红线在进入冻结栏之前就已经被裁掉，而非事后遮盖。 */
  if(layer && sc) layer.style.clipPath = `inset(0 0 0 ${Math.max(0, sc.scrollLeft)}px)`;
  let lbl = track.querySelector('.today-label');
  // 无红线的视图（如「人力分配」不画时间轴红线）：整条标尺收起，不留 26px 空白占位
  if(rail) rail.classList.toggle('empty', !tl);
  if(!tl || !sc){ if(lbl) lbl.remove(); return; }

  if(!lbl){
    lbl = document.createElement('div');
    lbl.className = 'today-label';
    lbl.title = '今天所在位置。红线滚出视野时点此跳回';
    // 贴边态可点击跳回今天（.today-rail 整体 pointer-events:none，仅 .off 态由 CSS 打开 auto）
    lbl.addEventListener('click', ()=>{ if(lbl.classList.contains('off')) scrollToToday(true); });
    track.appendChild(lbl);
  }
  const txt = tl.getAttribute('data-today') || '';
  const tr = track.getBoundingClientRect();
  const lr = tl.getBoundingClientRect();
  const xView = (lr.left + lr.width/2) - tr.left;      // 红线中心相对 track 左缘的可视偏移
  const half  = lbl.getBoundingClientRect().width/2 || 34;
  // 红线滚出可视区 → 胶囊贴边并降透明度，同时带上方向箭头，明确「今天在左边/右边」，
  // 而不是让用户对着一个不动的半透明标签猜今天在哪。
  const offL = xView < half + 2, offR = xView > tr.width - half - 2;
  const want = offL ? ('◀ ' + txt) : offR ? (txt + ' ▶') : txt;
  if(lbl.textContent !== want) lbl.textContent = want;
  lbl.classList.toggle('off', offL || offR);
  lbl.classList.toggle('off-l', offL);
  lbl.classList.toggle('off-r', offR);
  // 文案变了 → 宽度也变了，用最新宽度重算贴边位置，避免半个胶囊露出 track 外
  const half2 = lbl.getBoundingClientRect().width/2 || half;
  lbl.style.left = Math.max(half2 + 2, Math.min(tr.width - half2 - 2, xView)).toFixed(2) + 'px';
}

/* v7.12 一键回到今天：把红线滚到时间轴可视区左侧 1/3 处——今天靠左、未来排期留出 2/3 视野，
   比居中更贴合「看接下来要做什么」的实际使用习惯。 */
function scrollToToday(smooth){
  const sc = document.getElementById('scroll');
  const tl = document.querySelector('.todayline');
  if(!sc || !tl) return;
  const lw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w')) || 340;
  const viewW = Math.max(120, sc.clientWidth - lw);     // 时间轴可视宽度（扣掉冻结的左侧信息栏）
  const target = (parseFloat(tl.style.left) || 0) - viewW/3;
  const max = Math.max(0, sc.scrollWidth - sc.clientWidth);
  const left = Math.max(0, Math.min(max, target));
  if(smooth && sc.scrollTo){ sc.scrollTo({left, behavior:'smooth'}); } else { sc.scrollLeft = left; }
  syncTodayLabel();
}

/* 横向滚动 / 容器尺寸变化时实时重算胶囊位置。
   用 rAF 节流：滚动事件频率远高于渲染帧，逐事件改样式会造成多余的样式重算。 */
let _todayLabelBound = false;
function bindTodayLabelFollow(){
  if(_todayLabelBound) return; _todayLabelBound = true;
  const sc = document.getElementById('scroll');
  if(!sc) return;
  let pending = false;
  const tick = () => { pending = false; syncTodayLabel(); if(typeof syncMsLinks==='function') syncMsLinks(); if(typeof syncMsBarLabels==='function') syncMsBarLabels(); };   // v7.45：滚动/缩放同步刷新关键节点虚线（clip-path 随 scrollLeft）；v7.47：同步刷新出框标签
  const onScroll = () => { if(!pending){ pending = true; requestAnimationFrame(tick); } };
  sc.addEventListener('scroll', onScroll, {passive:true});
  window.addEventListener('resize', onScroll);
  if(window.ResizeObserver) new ResizeObserver(onScroll).observe(sc);   // 拖栏宽 / 拉伸看板高度也会改 track 宽
  // 首屏自动停在今天附近：否则今天常落在可视区外，胶囊只能贴边显示，用户还得自己横向找。
  requestAnimationFrame(()=>{ if(!_todayScrolledOnce){ _todayScrolledOnce = true; scrollToToday(false); } });
}
let _todayScrolledOnce = false;
/* ============ v6.83 45° 斜纹跨行对齐（真正根治「日期底纹歪了」）============
   现象：条内休息日暗块 .rest 的 45° 斜纹在不同行/不同条之间接不上，看起来"歪"。

   ★ v6.82 为什么仍然歪 —— 我上一版的数学漏了两项 CSS 规范行为：

   ① 渐变线穿过【背景定位区的中心】，不是左上角（CSS Images 规范）。
      故相位里含一项 −(W·sinA − H·cosA)/2，它随【元素自身宽高】变化。
      .rest 各块宽度都是 DAY_W，但高度=各自条高（不同条高度不同），
      → 该项不是常数，仅靠 (−dx,−dy) 补不掉。
   ② 渐变的 background-size 默认 = 背景定位区尺寸，且 background-repeat 默认 repeat。
      即"把整幅渐变缩成元素大小的一张瓦片再平铺"。用 background-position 平移
      非整数个瓦片时，元素内会出现瓦片接缝（相位在边界突跳）。

   ★ 正解：把 background-size 固定为【恰好一个条纹周期】的瓦片，让瓦片尺寸与元素尺寸解耦。
      对周期 P、角度 A：瓦片 Sx = P/|sinA|，Sy = P/|cosA|（45° 时 Sx=Sy=P·√2）。
      此时：
        · 中心项变成常数（只依赖 Sx,Sy，与元素宽高无关）→ 各元素同相基准一致；
        · 平移任意整数倍瓦片相位不变 → 无接缝；
        · 相位只由全局坐标 (X,Y) 的 (X−Y) 决定 → 天然跨行跨条严丝合缝。
      再配合 background-position = (−dx,−dy)（dx,dy = 元素相对 #grid 的偏移），
      所有斜纹块就像画在同一张连续画布上。（已用数值验证：位置/尺寸迥异的三个元素，
      在 X−Y 相同处相位完全一致；平移一个瓦片相位不变。）

   注：只改 background-size / background-position，不动 background-image、颜色、图案尺寸，
   故视觉质感与 v5.7 原版一致，只是相位对齐。 */
function alignStripes(){
  const grid=document.getElementById('grid'); if(!grid) return;
  const gRect=grid.getBoundingClientRect();
  // 所有可能带 45° 斜纹的元素：条内休息日块 + 行级状态斜纹 + 无限延长条 + QA条 + 占位条 + 空隙提示
  const els=grid.querySelectorAll('.rest, .timeline, .bar-task, .vacant-bar, .gap-indicator');
  els.forEach(el=>{
    const cs=getComputedStyle(el);
    const bg=cs.backgroundImage;
    if(!bg || bg.indexOf('repeating-linear-gradient')<0){
      // 之前对齐过、现在已无斜纹（如状态类被移除）→ 清掉残留内联样式，避免污染
      if(el.style.backgroundSize||el.style.backgroundPosition){
        el.style.backgroundSize=''; el.style.backgroundPosition='';
      }
      return;
    }
    /* 逐图层解析。多背景时（如 .bar-task.open 只有一层、.prog 有两层）必须按层给出
       size/position 列表，否则会错位到别的图层上。用括号深度切分，避免把
       rgba(...) / linear-gradient(...) 里的逗号误当分隔符。 */
    const layers=splitTopLevel(bg);
    const r=el.getBoundingClientRect();
    /* ★ v6.84 真凶修复：绝对不能对偏移量取整。
       行高不是整数（实测 24.7656px / 128.9844px 等），故各块 dy 天然带小数
       （153.7656 / 183.5469 / 213.3281 ...）。v6.83 用 Math.round 想"防亚像素抖动"，
       反而把相位碾出最多 0.5px 误差——而斜纹周期只有 6px，0.5px ≈ 8% 相位漂移，
       实测各行相位散成 5 个不同值，肉眼就是"歪"。
       必须保留完整小数精度：相位对齐要求的是精确同相，不是整数像素对齐。 */
    const dx=r.left-gRect.left;
    const dy=r.top -gRect.top;
    const sizes=[], poss=[];
    let touched=false;
    layers.forEach(L=>{
      const isRep=L.indexOf('repeating-linear-gradient')>=0;
      const m=isRep?L.match(/(-?\d+(?:\.\d+)?)deg/):null;
      // 该层不是斜向重复渐变 → 保持默认（auto / 0 0），不干扰
      if(!m){ sizes.push('auto'); poss.push('0 0'); return; }
      const aRaw=parseFloat(m[1]);
      const a=((aRaw%180)+180)%180;                 // 归一到 [0,180)
      if(a<1 || Math.abs(a-90)<1 || a>179){          // 近似横纹/竖纹：不受行偏移影响，跳过
        sizes.push('auto'); poss.push('0 0'); return;
      }
      const P=stripePeriod(L);                       // 从色标里取出一个完整周期长度(px)
      if(!(P>0)){ sizes.push('auto'); poss.push('0 0'); return; }
      const rad=aRaw*Math.PI/180;
      const sx=P/Math.abs(Math.sin(rad));
      const sy=P/Math.abs(Math.cos(rad));
      /* 保留 4 位小数：既避免超长浮点串，又把量化误差压到 1e-4 px（周期的 0.002%），
         远低于肉眼与渲染精度阈值。切勿改成整数——见上方 v6.84 真凶说明。
         位移用 (dx mod sx) / (dy mod sy) 归约到一个瓦片内：相位等价（平移整数瓦片不改相位），
         但避免出现 -11000px 这类巨大值带来的浮点精度损失。 */
      const px=-(dx%sx), py=-(dy%sy);
      sizes.push(sx.toFixed(4)+'px '+sy.toFixed(4)+'px');
      poss.push(px.toFixed(4)+'px '+py.toFixed(4)+'px');
      touched=true;
    });
    if(!touched){
      if(el.style.backgroundSize||el.style.backgroundPosition){
        el.style.backgroundSize=''; el.style.backgroundPosition='';
      }
      return;
    }
    el.style.backgroundSize=sizes.join(', ');
    el.style.backgroundPosition=poss.join(', ');
  });
}
/* 按顶层逗号切分多背景图层：只在括号深度为 0 处断开，
   这样 rgba(15,23,42,.10) 里的逗号不会被误判为图层分隔符。 */
function splitTopLevel(s){
  const out=[]; let depth=0, cur='';
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(ch==='(') depth++;
    else if(ch===')') depth--;
    if(ch===',' && depth===0){ out.push(cur.trim()); cur=''; continue; }
    cur+=ch;
  }
  if(cur.trim()) out.push(cur.trim());
  return out;
}
/* 求 repeating-linear-gradient 的一个条纹周期(px)。
   规范：repeating 的周期 = 最后一个色标位置 − 第一个色标位置。
   例 (45deg, A 0 2.5px, B 2.5px 6px) → 取到的最大位置 6px 即周期。
   注意只在【顶层色标】里找长度，避免把函数内部数字当位置。 */
function stripePeriod(layer){
  const i=layer.indexOf('(');
  const body=i>=0?layer.slice(i+1, layer.lastIndexOf(')')):layer;
  const parts=splitTopLevel(body);
  let maxPx=0, minPx=Infinity, seen=false;
  parts.forEach(p=>{
    // 去掉颜色函数，避免 rgba(...) 内数字干扰；再抓所有 px 长度
    const cleaned=p.replace(/[a-z-]*\([^()]*\)/gi,' ');
    const ms=cleaned.match(/(-?\d+(?:\.\d+)?)px/g);
    if(!ms) return;
    ms.forEach(t=>{
      const v=parseFloat(t);
      if(!isFinite(v)) return;
      seen=true;
      if(v>maxPx) maxPx=v;
      if(v<minPx) minPx=v;
    });
  });
  if(!seen) return 0;
  const per=maxPx-(isFinite(minPx)?Math.min(minPx,0):0);
  return per>0?per:maxPx;
}
/* ============ v5.0 标签实测降级（唯一可靠的自适应）============
   对每根任务条的 .rt-line 逐个测量：内容宽 > 可用宽 时，按 data-rank 从大到小(优先级从低到高)
   隐藏徽标——投入比(5) → 人天(4) → 完成印章(3) → 模块(2)，任务名(1)永不隐藏。
   隐藏到只剩任务名仍溢出：
     · 等比缩任务名字号(13.5→8.5px)；
     · 缩到下限仍溢出且是短名(≤5字) → 竖排(每字一列)，字号按条宽/条高双向再定；
     · 长名 → 锁 8.5px + 省略号兜底。
   全部用 clientWidth/scrollWidth 真实像素，杜绝 em 预测误差。 */
/* ============ v7.54 宽条文字跟随视口（仅针对「支援·武器特效」这类条目的显示问题） ============
   问题：该类条目在按人视图中条宽约一屏（1104px vs 容器 1113px），且条起点在视口左缘之外（x≈-373）；
   条内文字固定在条的最左端 → 文字整体在视口外，屏幕上只剩一段没有文字的斜纹条，认不出是哪条需求。
   方案：不改任何既有元素的样式/图标/标签/文字，只新增一层 position:fixed 的**浮动文字**。
   触发条件（两条同时满足才出现，最大限度避免影响其他条目）：
     ① 条宽 ≥ 视口宽 60%（短条滚出左缘时残余很短，不值得叠加）
     ② 条左端已滚出视口左缘 30px 以上（条内文字本可见时不叠加，避免与条上文字重复）
   条滚出视口（垂直或水平）即隐藏。内容直接读取条上既有文字（支角标/任务名/模块/人周），零信息变更。 */
let _xwlLayer=null;
function syncXWideLabels(){
  const sc=document.querySelector('.scroll');
  const grid=document.getElementById('grid');
  if(!sc||!grid) return;
  if(!_xwlLayer||!document.body.contains(_xwlLayer)){
    _xwlLayer=document.createElement('div');
    _xwlLayer.id='xwlLayer';
    _xwlLayer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:12;';
    document.body.appendChild(_xwlLayer);
  }
  const vpW=sc.clientWidth||1200;
  const scR=sc.getBoundingClientRect();
  let html='';
  grid.querySelectorAll('.bar-task').forEach(bar=>{
    const br=bar.getBoundingClientRect();
    if(br.width < vpW*0.6) return;                                  // 仅宽条
    if(br.left >= scR.left-30) return;                              // 条内文字仍可见，不叠加
    if(br.bottom<scR.top+2 || br.top>scR.bottom-2) return;          // 垂直不可见
    if(br.right<scR.left+2 || br.left>scR.right-2) return;          // 水平不可见
    const nm=bar.querySelector('.rt-nm'); if(!nm) return;
    const mod=bar.querySelector('.rt-mod');
    const md=bar.querySelector('.rt-md');
    const mk=bar.querySelector('.sup-mk');
    const esc=s=>(s||'').trim().replace(/</g,'&lt;');
    const y=br.top+Math.min(6, Math.max(2,(br.height-20)/2));
    html+=`<div class="bar-xwide-lbl" style="left:${Math.round(scR.left+8)}px;top:${Math.round(y)}px">`
        + (mk?'<span class="xl-mk">'+esc(mk.textContent)+'</span>':'')
        + `<span class="xl-nm">${esc(nm.textContent)}</span>`
        + (mod?`<span class="xl-md">${esc(mod.textContent)}</span>`:'')
        + (md?`<span class="xl-md">${esc(md.textContent)}</span>`:'')
        + `</div>`;
  });
  _xwlLayer.innerHTML=html;
}
/* 滚动/缩放时刷新。rAF 节流 + passive 监听；.scroll 在视图切换时会被重建，
   用 mousedown 捕获期补绑兜底（只绑一次/个实例）。 */
(function bindXWideLabelSync(){
  let raf=0;
  const kick=()=>{ if(raf) return; raf=requestAnimationFrame(()=>{ raf=0; syncXWideLabels(); }); };
  window.addEventListener('scroll',kick,true);
  window.addEventListener('resize',kick);
  const sc0=document.querySelector('.scroll');
  if(sc0){ sc0.__xwlBound=true; sc0.addEventListener('scroll',kick,{passive:true}); }
  document.addEventListener('mousedown',()=>{
    const sc=document.querySelector('.scroll');
    if(sc && !sc.__xwlBound){ sc.__xwlBound=true; sc.addEventListener('scroll',kick,{passive:true}); }
  },true);
})();
function fitBarLabels(){
  const HMAX=13.5, HMIN=8.5, VMIN=7, GAP=5;
  /* v5.4 两行堆叠：够高的窄条单行放不下时，改纵向两行——任务名横排居中一行 + 模块横排居中补第二行，
     充分利用纵向富余空间（比竖排更易读）。返回 true=成功堆叠；false=宽度连任务名单行都放不下(交给竖排兜底)。 */
  function tryStack(line, nm, avail, barH){
    nm.style.writingMode=''; nm.style.textOrientation=''; nm.removeAttribute('data-nm'); nm.style.textOverflow='';
    // 任务名横排，缩字号以适应条宽（scrollWidth 与字号近似线性）
    nm.style.fontSize=HMAX+'px';
    let nfs=HMAX;
    if(nm.scrollWidth>avail){
      nfs=Math.max(HMIN, Math.floor((HMAX*avail/(nm.scrollWidth||1))*10)/10);
      nm.style.fontSize=nfs+'px';
    }
    if(nm.scrollWidth>avail+0.5){ nm.style.fontSize=''; return false; }   // 宽都放不下任务名→交竖排
    // 宽度 OK → 开启两行堆叠（列方向、双向居中由 CSS 承担）
    line.querySelectorAll('[data-rank]').forEach(el=>{ if(el!==nm) el.style.display='none'; });
    line.setAttribute('data-stack','1');
    // 第二行补模块（最重要的次级信息），缩字号以适应条宽；补不下则撤销，保持干净的单行居中任务名
    const modEl=line.querySelector('.rt-mod');
    if(modEl){
      modEl.style.display='';
      let mfs=Math.min(nfs,11); modEl.style.fontSize=mfs+'px';
      let g=0; while(modEl.offsetWidth>avail && mfs>7.5 && g++<12){ mfs=Math.round((mfs-0.5)*10)/10; modEl.style.fontSize=mfs+'px'; }
      if(modEl.offsetWidth>avail+0.5 || (nm.offsetHeight+2+modEl.offsetHeight)>barH+1){
        modEl.style.display='none'; modEl.style.fontSize='';
      }
    }
    return true;
  }
  const lines=document.querySelectorAll('#grid .bar-task .rt-line');
  lines.forEach(line=>{
    const nm=line.querySelector('.rt-nm');
    if(!nm) return;
    // 圆点(.sdot)是「非必要」装饰元素，与 rt-line 同级、flex-shrink:0 不收缩；任务名(rt-nm)才是必须保命的。
    const bar=line.closest('.bar-task');
    const isReq=!!(bar&&bar.classList.contains('req-bar'));
    const sdot=(bar&&!isReq)?bar.querySelector(':scope > .sdot'):null;
    // 复位：清掉上一轮的 inline 降级痕迹，从「全显示、原始字号、横排、有圆点、原内边距」开始重新测
    line.querySelectorAll('[data-rank]').forEach(el=>{ el.style.display=''; el.style.fontSize=''; el.removeAttribute('data-nm'); });
    if(sdot) sdot.style.display='';
    if(bar&&!isReq){ bar.style.paddingLeft=''; bar.style.paddingRight=''; }
    nm.style.fontSize=''; nm.style.writingMode=''; nm.style.textOrientation='';
    nm.removeAttribute('data-nm'); nm.style.textOverflow='';
    line.removeAttribute('data-stack');                // v5.4：清掉上一轮的两行堆叠
    let avail=line.clientWidth;                         // rt-line 真实可用内宽
    /* 关键修正（v5.0.1）：.rt-line 是 flex+overflow:hidden 容器，flex 会把子元素压缩到适应容器，
       导致 line.scrollWidth 恒 ≈ clientWidth——用它判溢出永远是 false。
       正确做法：累加各子元素的「自然宽度」——任务名用 scrollWidth（内容真实宽，不受压缩影响），
       徽标 flex:0 0 auto 用 offsetWidth（本就是自然宽）——求和 vs 可用宽才是真溢出判定。 */
    const needW=()=>{
      let w=nm.scrollWidth, n=1;                         // 任务名自然内容宽
      line.querySelectorAll('[data-rank]').forEach(el=>{
        if(el===nm || el.style.display==='none') return;
        w+=el.offsetWidth; n++;
      });
      return w+GAP*Math.max(n-1,0);
    };
    const fits=()=> needW()<=avail;
    /* 0) 极窄条空间回收：圆点(.sdot)+条内边距会吃掉一大截宽度，窄条上直接把 rt-line 挤成 0 宽，
       导致任务名整个消失、只剩顽固不收缩的圆点（就是用户截图里的问题）。
       圆点是非必要装饰、任务名必须保命——所以放不下时优先牺牲圆点、再收窄内边距，把空间还给任务名。 */
    if(fits() && avail>0) return;                        // 全显示放得下：完事
    if(sdot){ sdot.style.display='none'; avail=line.clientWidth; if(fits()&&avail>0) return; }
    if(bar&&!isReq){ bar.style.paddingLeft='2px'; bar.style.paddingRight='2px'; avail=line.clientWidth; if(fits()&&avail>0) return; }
    if(avail<=0) return;                                 // 回收后仍无可用宽（条本身近乎 0px）：无解，跳过
    // —— 到这里说明横向放不下全部信息，必须降级 ——
    const short=nm.textContent||'';
    const nc=[...short].length||1;
    const barH=line.clientHeight||24;
    /* v5.4 两行堆叠优先：够高(≥40px)的窄条单行放不下全信息时，与其横向砍徽标只剩任务名、
       下方留一大片纵向空白（用户截图的核心痛点），不如堆成两行——任务名横排居中一行 +
       模块横排居中补第二行，充分利用纵向空间（比竖排更易读）。
       tryStack 成功即完成；返回 false=宽度连任务名单行都放不下 → 落到横向缩字号/竖排兜底。 */
    if(barH>=40 && nc<=6 && tryStack(line, nm, avail, barH)) return;
    // 堆叠不适用(矮条/长名/宽度不够)：回到干净态，走横向降级
    nm.style.fontSize=''; line.removeAttribute('data-stack');
    line.querySelectorAll('[data-rank]').forEach(el=>{ if(el!==nm) el.style.display=''; });
    // 1) 按优先级从低到高隐藏徽标（rank 5→4→3→2），任务名 rank1 不动
    const badges=[...line.querySelectorAll('[data-rank]')]
      .filter(el=>el!==nm && +el.getAttribute('data-rank')>=2)
      .sort((a,b)=>(+b.getAttribute('data-rank'))-(+a.getAttribute('data-rank')));
    for(const b of badges){
      b.style.display='none';
      if(fits()) return;
    }
    // 2) 只剩任务名仍溢出：等比缩字号（用内容宽反推目标字号，scrollWidth 与 fs 近似线性）
    const cur=nm.scrollWidth||1;
    let fs=Math.max(HMIN, Math.floor((HMAX*avail/cur)*10)/10);
    nm.style.fontSize=fs+'px';
    if(nm.scrollWidth<=avail+0.5) return;               // 缩后单行放得下
    // 3) 缩到下限仍溢出：短名转竖排，长名省略号兜底
    if(nc<=5){
      nm.setAttribute('data-nm','v');
      /* v5.2 舒适竖排：不再让字号顶到 HMAX 满格（红框那种又挤又顶格），改为按条高留呼吸余白——
         每字理想占高约字号×1.32（含行距+上下气口），据此反推字号并封顶到 VMAX(12px)，
         同时不超过横向可用宽 avail-1，保证竖排单列不横向溢出。 */
      const VMAX=12;
      let vfs=Math.max(VMIN, Math.min(VMAX, Math.floor((barH/(nc*1.32))*10)/10, avail-1));
      nm.style.fontSize=vfs+'px';
      // 竖排仍超高（条太矮塞不下）：逐步压到 VMIN；仍超则退回横排最小字号+省略号
      if(nm.scrollHeight>line.clientHeight+1){
        vfs=Math.max(VMIN, Math.floor((line.clientHeight/(nc*1.05))*10)/10);
        nm.style.fontSize=vfs+'px';
        if(nm.scrollHeight>line.clientHeight+1){
          nm.removeAttribute('data-nm'); nm.style.fontSize=HMIN+'px'; nm.style.textOverflow='ellipsis';
          return;
        }
      }
      /* v5.2 富余补信息：竖排任务名只占一列，若条子横向仍有明显富余（黑框那种），
         把模块名也竖排补成第二列——去底色纯白文字，秀气不抢戏。
         条件：① 有模块徽标；② 补列后总宽仍 ≤ 可用宽（留 4px 安全余量）；③ 模块竖排不超条高。 */
      const modEl=line.querySelector('.rt-mod');
      if(modEl){
        const nmW=nm.offsetWidth;                        // 竖排任务名单列宽
        const modTxt=(modEl.textContent||'').trim();
        const mnc=[...modTxt].length||1;
        const spare=avail-nmW-GAP;                       // 补列可用横向余量
        // 模块竖排字号：比任务名略小一号更谦逊，同样受条高与余量双重约束
        const mfs=Math.max(VMIN, Math.min(vfs-0.5, Math.floor((barH/(mnc*1.32))*10)/10));
        if(spare>=mfs+4){                                // 横向塞得下这一列才补
          modEl.style.display='';
          modEl.setAttribute('data-nm','v');
          modEl.style.fontSize=mfs+'px';
          // 补列后若横向溢出或该列超条高，撤销补列（保持只有任务名的干净竖排）
          if(needW()>avail+0.5 || modEl.scrollHeight>line.clientHeight+1){
            modEl.style.display='none'; modEl.removeAttribute('data-nm'); modEl.style.fontSize='';
          }
        }
      }
      return;
    }else{
      nm.style.fontSize=HMIN+'px'; nm.style.textOverflow='ellipsis';
    }
  });
}

/* ============ 动态角色线聚合（从 reqs + members 生成，替代写死 hrData）============
   按 mod(出场/检视/组队) 分组 → 每组内按 char(角色)×grade(品级) 聚合为一条角色线。
   每条线的数据全部从 reqs.segs 实时计算：
   - status: 聚合该角色该模块下所有需求的任务段状态
   - cfg:   实际在岗基地人数(baseSet.size，正编带队不占编制)
   - std:   标配基地人数(STD_CFG 表动态解析，按品级×模块匹配 ppl 文本)
   - gap:   标配缺口(std − cfg, ≥0)
   - regs:  正编人员名单(from segs, corp=reg, 排除 support/left)
   - bases: 基地人员名单(from segs, corp=base, 排除 support/left)
   - sup:    支援人员
   - note:  带队/支援说明
*/
function buildRoleLines(){
  // 只取特效类需求(kind=fx)，排除 qa/lt/联调 等
  // v6.64：**不再读 HIDE_DONE** —— 「隐藏已完成」只影响观看内容，不影响统计口径。
  //   否则勾一下开关，缺口/配置人数就跟着变，三视图数据互相错乱。
  const fxReqs = reqs.filter(r => r.kind === 'fx');
  // 按模组分
  const modGroups = {};
  fxReqs.forEach(r => {
    const m = r.mod || '其他';
    if(!modGroups[m]) modGroups[m] = [];
    modGroups[m].push(r);
  });
  const result = [];  // [{mod, roles:[{role,grade,status,cfg,std,gap,makers,sup,tmp,note}]}]
  for(const [mod, reqsOfMod] of Object.entries(modGroups)){
    // 该模块内按 char × grade 聚合
    const charMap = {};
    reqsOfMod.forEach(r => {
      const key = (r.char||'') + '::' + (r.grade||'');
      if(!charMap[key]){
        charMap[key] = {char:r.char, grade:r.grade, reqs:[]};
      }
      charMap[key].reqs.push(r);
    });
    const roles = [];
    for(const {char:cname, grade, reqs:rl} of Object.values(charMap)){
      // 短角色名
      const shortC = charShort(cname);
      // 角色显示名: "金（七十）" / "橙（露西亚·管线1）" / "红（女指挥官）"
      // 尝试从 line 字段取管线标识
      const lineTag = rl[0] && rl[0].line && rl[0].line !== '-' ? ('·'+rl[0].line) : '';
      const roleLabel = `${grade}（${shortC}${lineTag}）`;
      // 聚合状态: 基于日期自动推算（autoSegState），而非读取可能过时的 seg.status 原始值
      // 任何 doing/review/blocked→启动中, 任何 todo 且未到开始日→将要启动, 全 done→已完成
      let hasDoing=false, hasTodo=false, hasDone=false;
      rl.forEach(r => {
        (r.segs||[]).forEach(sg => {
          if(!segHasDuration(sg)) return;   // v6.64：零时长段不参与状态聚合（与人员口径一致）
          const auto = autoSegState(sg);
          const st = auto.status;
          if(st==='doing'||st==='review'||st==='blocked') hasDoing=true;
          else if(st==='todo') hasTodo=true;
          else if(st==='done') hasDone=true;
        });
        // 同时检查需求级人工状态
        const rs = reqState(r);
        if(rs==='done') { hasDone=true; hasDoing=false; hasTodo=false; }
        if(rs==='doing') hasDoing=true;
      });
      let status = '';
      if(hasDoing) status = '启动中';
      else if(hasTodo) status = '将要启动';
      else if(hasDone && !hasTodo && !hasDoing) status = '已完成';
      // 收集人员: 从 segs 提取（正编/基地分开）
      // v6.64 口径与「按人看」完全对齐：
      //   ① 零时长段(segHasDuration=false)一律跳过 —— 按人看不渲染这种条，HR 也不能凭它算人；
      //   ② 离职成员**始终保留在名单**（渲染层用 mk-left 打「已离」标注），不再因需求未完成就剔除
      //      —— 按人看会把离职者收进归档区仍可见，HR 直接删人会造成两视图人不一样；
      //   ③ 离职者只是「不占在岗编制」(memCountsAsStaff=false)，故计入 leftNames 但不进 regSet/baseSet。
      const isDone = status === '已完成';
      const regSet = new Set();       // 正编（在岗，占编制）
      const baseSet = new Set();      // 基地（在岗，占编制）
      const supSet = new Set();       // 支援（不占本管线编制）
      const tmpSet = new Set();       // 暂缺占位（不占编制，代表缺口）
      const leftNames = new Set();    // 已离职参与者（仍显示，不占编制）
      rl.forEach(r => {
        (r.segs||[]).forEach(s => {
          if(!segHasDuration(s)) return;        // ① 与按人看同源：零时长段不算
          const m = memById(s.m); if(!m) return;
          if(leftLong(m) && !isDone) return;    // 离职超期且需求未完成：与按人看归档收纳一致，隐藏
          if(effLeft(m)){ leftNames.add(m.name); return; }   // ② 离职：进名单、不占编制
          if(isVacantMem(m)){ tmpSet.add(m.name); return; }  // 暂缺占位：单独收集
          // 与按人看/按需求看同源：动态判定支援
          if(isSupportInReq(m, r)){ supSet.add(m.name); return; }
          if(m.corp === 'reg') regSet.add(m.name);
          else baseSet.add(m.name);
        });
      });
      // 配置人数 = 在岗基地人力（离职/暂缺/支援/正编带队均不占基地编制）
      const cfg = baseSet.size;
      // 标准配置 = 从 STD_CFG 表读取（v6.69 起为严格别名匹配，无硬编码兜底）
      let std = 0;
      rl.forEach(r => { std += stdCfgBaseForReq(r); });
      /* v6.69「只统计标准配置表里有的模块」（用户口径）：
         该角色线下所有需求的模块都不在 STD_CFG 中（std 恒为 0）→ 整条不参与缺口统计，
         连暂缺占位也不算缺口。理由：联调/通用/饰品这类模块没有团队标配编制，
         挂个占位只是排期占位，不代表"要招人"，不该冒出红色缺口徽标。 */
      const hasStdCfg = rl.some(r => stdCfgBaseForReq(r) > 0);
      /* ===== 缺口口径（v6.72 定稿）=====
         gap = max(0, 标配 − 在岗真人)。**暂缺占位不参与运算**，只作为"这个缺口已挂了坑位"的可视化。

         v6.63 曾用 `max(std-cfg, tmpCount)`，v6.72 移除 tmpCount 项，原因是同一批占位成员
         会被多条角色线共用 → 每条线各算一次 → 重复统计（用户反馈的直接问题）。
         实测：占位「暂缺 / 暂缺-基地2/3/4」这 4 个成员同时挂在
           出场|荷光者、出场|斩神橙 两条线上（组队还有更多重叠），
         于是两条线都显示"缺4"，而实际上要招的是同一批人。
         「暂缺-基地5~11」同理，同时出现在 女指挥官各模块 与 联调 上。

         为什么不用"先到先得去重"：那样谁被扣取决于遍历顺序，同一批人挂两条线时
         第二条会莫名少算，口径不可解释。
         改为只认标配缺口后：缺口 = 团队标准要几个人 − 实际到岗几个真人，
         与占位挂了几个、挂在几条线上完全无关 → 天然无重复，且可解释、可预期。
         占位数量仍在行内以红色虚线标签如实展示，供人工判断招聘进度。 */
      const tmpCount = tmpSet.size;
      const gap = (status === '已完成' || !hasStdCfg) ? 0 : Math.max(0, std - cfg);
      // note: 简要说明
      const leadInfo = [...regSet].find(n => {
        const mm = members.find(x=>x.name===n);
        return mm && mm.corp === 'reg';
      });
      const noteParts = [];
      if(leadInfo) noteParts.push(`${leadInfo}带`);
      if(supSet.size) noteParts.push(`${[...supSet].join('/')}为支援`);
      if(isDone && leftNames.size) noteParts.push(`${[...leftNames].join('/')}已离职`);
      /* v6.73 人员排序规律化（用户反馈"人员排序能规律一点吗"）。
         原来各组直接用 Set 的插入顺序 = 遍历 segs 的顺序 → 完全随机，
         同一批人在不同角色线里顺序还不一样（截图里"暂缺-基地8,9,10,7,6,5,11"乱序）。
         统一规则：
           · 暂缺占位按名称里的数字自然序（暂缺 → 暂缺-基地1 → 2 → … → 11），不做字典序（否则 10 会排到 2 前面）；
           · 真人（正编/基地/支援）按中文姓名拼音序，稳定可预期；
         分组大顺序仍是 正编 → 基地 → 暂缺 → 支援（不变）。 */
      const zhSort = arr => arr.slice().sort((a,b)=>String(a).localeCompare(String(b),'zh-Hans-CN'));
      const vacantSort = arr => arr.slice().sort((a,b)=>{
        const num = s => { const m=String(s).match(/(\d+)/); return m?parseInt(m[1],10):0; };  // 无数字的「暂缺」排最前
        return num(a)-num(b) || String(a).localeCompare(String(b),'zh-Hans-CN');
      });
      roles.push({
        role: roleLabel,
        grade: grade,
        status: status,
        cfg: cfg,
        std: std,
        gap: gap,
        regs: zhSort([...regSet]),
        bases: zhSort([...baseSet]),
        sup: zhSort([...supSet]),
        tmp: vacantSort([...tmpSet]),   // 暂缺占位名单（不计入编制），按编号自然序
        left: zhSort([...leftNames]),   // 已离职参与者名单（渲染用）
        /* v6.65：该角色线下的需求是否**全部**已完成/废弃。
           供渲染层实现「隐藏已完成」——注意这只是给渲染层的一个标记位，
           本函数所有统计（cfg/std/gap）依然基于全量数据算，勾选开关不会改变任何数字。
           这正是 v6.64 定下的分工：数据层算全量、渲染层决定看什么。 */
        allDone: rl.length > 0 && rl.every(r => reqIsCompleted(r)),
        hasStd: hasStdCfg,          // v6.69：该模块是否在标准配置表中（否 → 不显示缺口/齐，显示「无标配」）
        note: noteParts.join(' · ') || undefined
      });
    }
    // 按品级排序: 金 > 橙 > 红 > 其他
    const gradeOrder = {'金':0,'橙':1,'红':2,'通用':3};
    roles.sort((a,b) => (gradeOrder[a.grade]??9) - (gradeOrder[b.grade]??9));
    result.push({mod, roles});
  }
  /* v6.73（用户要求「联调不用列出来」）：只保留**标准配置表里有的模块**。
     联调/通用/饰品/武器特效等模块没有团队标配编制，v6.69 已让它们不计缺口、
     标注「无标配·不统计」；但整块列出来仍占版面、干扰阅读 —— 既然不统计，索性不列。
     判据沿用同一个 hasStd 标记，保证「统计口径」与「是否展示」出自同一处，不会分裂。 */
  const kept = result.filter(mo => (mo.roles||[]).some(r => r.hasStd));
  // 模块排序: 出场 > 检视 > 组队 > 其他
  const modOrder = {'出场':0,'检视':1,'组队':2};
  kept.sort((a,b) => (modOrder[a.mod]??9) - (modOrder[b.mod]??9));
  return kept;
}

/* ============ 视图3：人力分配（按模块） ============ */
function renderHR(){
  // ★ 顶部汇总卡：全部改用实时数据（computeHR 从 members+reqs 算），不再读 hrData/HR_CONCLUSION
  const HR = computeHR();
  /* v6.73：右侧汇总句同步澄清口径 —— 明确写「待补」而非「缺」，
     并把占位单独用「个」计量，避免与人数混读。 */
  const detailParts=[];
  if(HR.gradeGap.金>0) detailParts.push(`金角待补${HR.gradeGap.金}人`);
  if(HR.gradeGap.橙>0) detailParts.push(`橙角待补${HR.gradeGap.橙}人`);
  if(HR.gradeGap.红>0) detailParts.push(`红角待补${HR.gradeGap.红}人`);
  if(HR.gradeGap.通用>0) detailParts.push(`通用待补${HR.gradeGap.通用}人`);
  if(HR.vacantCount>0) detailParts.push(`已挂占位${HR.vacantCount}个`);
  const detailStr = detailParts.length ? detailParts.join(' / ') : '各线已配齐';

  // 补充指标：高峰角色线数 / 高峰负载率 / 高风险需求数（与顶部 KPI 同源）
  const roleLines = buildRoleLines();
  const roleLineCount = roleLines.reduce((sum, g) => sum + g.roles.length, 0);   // HR 角色线总数（如红蔻/金角/橙角等）
  const activeMems = members.filter(m => !effLeft(m) && !isVacantMem(m) && !isExtLoan(m));
  const loads = activeMems.map(m => memLoad(m.id).pct);
  const peakLoad = loads.length ? Math.max(...loads, 0) : 0;
  const highRiskCount = reqs.filter(r => reqRisk(r).lvl === '高').length;

  // ★ 固定头部：KPI汇总卡 + 品级统计 + 编制说明（sticky，不随角色线滚动）
  let html=`<div class="hr-sticky-header">`;
  // 顶部汇总卡（全部动态计算，随甘特表实时联动）
  html+=`<div class="hr-summary">
    <div class="hr-sc total"><div class="lab">在岗编制人数</div><div class="val">${HR.base}</div></div>
    <div class="hr-sc"><div class="lab">高峰并行角色数量</div><div class="val">${roleLineCount}</div></div>
    <div class="hr-sc"><div class="lab">高峰负载率</div><div class="val w">${Math.round(peakLoad)}%</div></div>
    <div class="hr-sc gap"><div class="lab">高风险需求</div><div class="val ${highRiskCount > 0 ? 'd' : ''}">${highRiskCount}</div></div>
    <div class="hr-sc"><div class="lab">常规管线缺口</div><div class="val d">${HR.lack}人</div></div>
  </div>`;
  // 品级统计条（动态：实人数 + 缺口 + 暂缺，全部从 computeHR 实时取）
  let gradeBarHtml = '';
  ['金','橙','红','通用'].forEach(g => {
    const cnt = HR.gradeCount[g] || 0;
    if(cnt > 0) {
      const col = (HR_GRADE[g]||{}).col || '#646a73';
      const gap = HR.gradeGap[g] || 0;
      /* v6.73（用户反馈"人数统计我看不懂"）：三个数并列一行、单位都写"人"，但维度完全不同 ——
         「N人」= 该品级在岗真人（人的固有属性）、「缺N」= 该品级角色线标配缺口（按需求算）、
         「暂缺占位N人」= 已挂的占位行数。故补明确标签 + hover 说明，杜绝误读为同一口径相加。 */
      gradeBarHtml += `<div class="gi" title="「${g}」品级在岗真人 ${cnt} 人（按成员品级字段统计）${gap>0?`；该品级各角色线标配缺口合计 ${gap} 人（= 标配人力 − 在岗真人，与占位数量无关）`:'；该品级各角色线已按标配配齐'}"><span class="gdot" style="background:${col}"></span>${g}在岗 <b>${cnt}人</b>${gap>0 ? `<small style="color:#d32320;margin-left:3px">待补${gap}</small>` : `<small style="color:#16a34a;margin-left:3px">已齐</small>`}</div>`;
    }
  });
  if(HR.vacantCount > 0) gradeBarHtml += `<div class="gi" title="已在排期里挂出的「暂缺」占位行共 ${HR.vacantCount} 个（尚未分配真人）。&#10;注意：占位是为上面各品级缺口挂的坑，与「待补」描述同一批待招人员的不同侧面，不要相加。&#10;同一个占位可同时挂在多条角色线上，故占位数与缺口数不必相等。"><span class="gdot" style="background:#d32320"></span>已挂占位 <b style="color:#d32320">${HR.vacantCount}个</b></div>`;
  if(!gradeBarHtml) gradeBarHtml = `<div class="gi" style="color:#16a34a">✅ 各角色线暂无缺口</div>`;
  html+=`<div class="hr-grade-bar">
    ${gradeBarHtml}
    <div class="gi" style="margin-left:auto;color:#646a73">📌 ${detailStr}</div>
  </div>`;
  // 编制/状态图例（全部动态生成：从 members 实时取，逐人列出编制+负责信息）
  const legendMems = members.filter(m => !effLeft(m) && !isVacantMem(m));
  const regMems = legendMems.filter(m => m.corp==='reg'||m.corp==='sub');
  const baseMems = legendMems.filter(m => m.corp==='base');
  const loanMems = legendMems.filter(m => isExtLoan(m));
  /* v7.48 借入人员：dir='in' 且记录未结束 —— 从其他管线借来支援，临时隶属本队 */
  const loanInMems = legendMems.filter(m => isLoanIn(m));
  const newMems = members.filter(m => m.status==='new' && !isVacantMem(m));
  const leftMems = members.filter(m => effLeft(m));
  /* 跨队支援：本队编制内、被派到其他带队需求上的人（排除外借与借入，两者各有专属栏） */
  const supMems = members.filter(m => m.support && !effLeft(m) && !isExtLoan(m) && !isLoanIn(m));
  // 逐人格式化：名字（编制 / 负责信息）
  const fmtMem = (m) => {
    const corpLabel = m.corp==='reg'?'正编':m.corp==='sub'?'子公司':'基地';
    let detail = '';
    if(m.corp==='reg'||m.corp==='sub'){
      // 正编/子：读 leadChars+leadMods（v5.49b 结构化字段），兼容旧 m.lead
      const chars = (m.leadChars||'').split(',').filter(Boolean);
      const mods  = (m.leadMods||'').split(',').filter(Boolean);
      // ★ 配对分行文本：角色(模块1 模块2) / 角色2(模块3)
      if(chars.length > 0){
        const pairs = chars.map((c, i) => {
          const start = Math.round(i * mods.length / chars.length);
          const end   = Math.round((i + 1) * mods.length / chars.length);
          const rowMods = mods.slice(start, end);
          return rowMods.length ? c+'('+rowMods.join(' ')+')' : c;
        });
        detail = pairs.join(' / ');
      } else if(mods.length){
        detail = mods.join('/');
      }
    } else if(m.corp==='base'){
      // 基地：显示隶属 + 模块
      const belong = (m.lead && m.lead!=='—' && m.lead!=='-') ? m.lead : '';
      const modInfo = m.mod || '';
      const parts = [];
      if(belong) parts.push('隶属'+belong);
      if(modInfo) parts.push(modInfo);
      detail = parts.join('/');
    }
    /* v7.48 表意优化：三类支援关系分开表述，各自带明确动词与方向，不再混在一个「支援」词里 */
    if(isExtLoan(m)){
      const L=curLoan(m);
      detail='↗ 外借去 '+(L&&L.party?L.party:(m.mod||'其他管线'))+((L&&L.to)?('（至 '+fmt(L.to)+'）'):'（长期）')
            +((L&&L.state==='sealed')?' · 记录已封存':'');
    }else if(isLoanIn(m)){
      const L=curLoan(m);
      detail='↙ 借入自 '+(L&&L.party?L.party:'其他管线')+((L&&L.to)?('（至 '+fmt(L.to)+'）'):'（长期）');
    }else if(m.support){
      detail = detail ? detail+'·跨队支援' : '⇄ 跨队支援';
    }
    return `${m.name}（${corpLabel}${detail ? '·'+detail : ''}）`;
  };
  html+=`<div class="hr-legend">
    <span class="lg-t">编制与带队：</span>`;
  // 正编/子组
  if(regMems.length){
    html+=`<span class="lg"><i class="corp-tag" style="background:#e7f0ff;color:#0052d9">正编/子${regMems.length}人</i> ${regMems.map(m=>`<span class="mem-tag" title="${fmtMem(m)}">${m.name}</span>`).join('')}</span>`;
  }
  // 基地组（逐人列出）
  if(baseMems.length){
    html+=`<span class="lg"><i class="corp-tag" style="background:#eef1f7;color:#56607a;border:1px solid #c4ccdb">基地${baseMems.length}人</i> ${baseMems.map(m=>`<span class="mem-tag" title="${fmtMem(m)}">${m.name}</span>`).join('')}</span>`;
  }
  /* v7.48 外借组：可交互 —— 点人名看记录，「+ 登记」开登记弹层 */
  if(loanMems.length){
    html+=`<span class="lg"><i class="corp-tag" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa">↗ 外借${loanMems.length}人</i> `
      + loanMems.map(m=>`<span class="mem-tag ln-click" onclick="openLoanHistory('${escAttr(m.id)}')" title="${fmtMem(m)}｜点击查看借调记录">${m.name}</span>`).join('')
      + `<span class="ln-add" onclick="openLoanOutPick()" title="登记一位成员外借去其他管线">＋ 登记外借</span></span>`;
  }
  /* v7.48 借入组：从其他管线借来支援的人（临时隶属），同样可点可加 */
  if(loanInMems.length){
    html+=`<span class="lg"><i class="corp-tag" style="background:#e6fcf5;color:#0b7285;border:1px solid #99e9f2">↙ 借入${loanInMems.length}人</i> `
      + loanInMems.map(m=>`<span class="mem-tag ln-click" onclick="openLoanHistory('${escAttr(m.id)}')" title="${fmtMem(m)}｜点击查看借调记录">${m.name}</span>`).join('')
      + `<span class="ln-add" onclick="openLoanInDialog()" title="登记一位从其他管线借来支援的人员">＋ 登记借入</span></span>`;
  }
  /* 借入为空时也常驻一个登记入口，否则「从其他管线借人」这条路径在界面上无处可点 */
  if(!loanInMems.length){
    html+=`<span class="lg"><i class="corp-tag" style="background:#f2f4f7;color:#7a8290;border:1px solid #e3e7ec">↙ 借入 0 人</i>`
      + `<span class="ln-add" onclick="openLoanInDialog()" title="登记一位从其他管线借来支援的人员">＋ 登记借入</span></span>`;
  }
  // 动态状态行（仅在有对应成员时显示；外借/借入已在主列表展示，不重复）
  const statusParts = [];
  if(newMems.length) statusParts.push(`<span class="lg"><i class="hr-flag new" style="margin:0">新人</i> ${newMems.map(m=>m.name).join(',')}</span>`);
  if(leftMems.length) statusParts.push(`<span class="lg"><i class="hr-flag left" style="margin:0">已离职</i> ${leftMems.length}人</span>`);
  if(supMems.length) statusParts.push(`<span class="lg"><i class="hr-flag sup" style="margin:0">⇄ 跨队支援</i> ${supMems.map(m=>`<span class="mem-tag" title="${fmtMem(m)}">${m.name}</span>`).join('')}</span>`);
  if(statusParts.length){
    html += `<span class="lg-div">|</span><span class="lg-t">状态：</span>${statusParts.join('')}`;
  }
  html += `</div></div><!-- /hr-sticky-header -->`;
  // 各模块 —— 从 reqs 动态聚合角色线（替代写死 hrData，随内容滚动）
  html += `<div class="hr-body">`;
  const roleModules = buildRoleLines();
  /* v6.65「隐藏已完成」在 HR 视图的正确落点：**渲染层过滤**。
     buildRoleLines 已按全量数据算完 cfg/std/gap（勾选不影响任何数字），
     此处仅决定「哪些角色线出现在列表里」。
     注意 modGap 仍用**全量** roles 累加 —— 模块头的缺口是客观事实，
     不能因为隐藏了几行就跟着变小（否则又回到 v6.64 之前"开关改统计"的老问题）。 */
  const hrHideDone = HIDE_DONE[view];
  roleModules.forEach(m => {
    const modGap = m.roles.reduce((a, r) => a + r.gap, 0);   // 全量口径，不受隐藏影响
    const shownRoles = hrHideDone ? m.roles.filter(r => !r.allDone) : m.roles;
    const hiddenCnt = m.roles.length - shownRoles.length;
    if(hrHideDone && shownRoles.length === 0) return;        // 整个模块都完成了：不渲染该模块
    const hiddenTag = hiddenCnt > 0
      ? `<span class="mtag" style="background:#f2f4f7;color:#7a8290" title="已完成的角色线被「隐藏已完成」开关折叠，但其缺口/配置仍计入统计">已隐藏 ${hiddenCnt} 条已完成</span>`
      : '';
    /* v6.69：整个模块都不在标准配置表里（联调/通用/饰品/武器特效等）→ 模块头标「无标配·不统计」，
       与「已配齐(无缺口)」区分开，避免用户误以为这些模块已经算过且刚好不缺人。 */
    const modHasStd = m.roles.some(r => r.hasStd);
    const modGapTag = !modHasStd
      ? `<span class="mgap" style="color:#9aa2ad" title="该模块不在「出场标准工期 &amp; 标配人力」表中，无团队标配编制 → 不参与缺口统计">无标配 · 不统计</span>`
      : `<span class="mgap" style="color:${modGap > 0 ? '#d32320' : '#1a8a3c'}">${modGap > 0 ? '缺 ' + modGap + ' 人' : '无缺口'}</span>`;
    html += `<div class="hr-mod">
      <div class="hr-mod-head"><span>${m.mod}</span><span class="mtag">${shownRoles.length} 个角色线</span>${hiddenTag}
        ${modGapTag}</div>`;
    shownRoles.forEach(r => {
      const g = HR_GRADE[r.grade] || HR_GRADE[''];
      const st = HR_STATUS[r.status] || HR_STATUS[''];
      const isDone = r.status === '已完成';
      const leftSet = new Set(r.left || []);
      let makersHTML = '';
      const mkTag = (n, corp) => {
        const mem = members.find(x => x.name === n);
        if (leftLong(mem) && !isDone) return '';            // 非已完成：离职满1月隐藏
        if (isVacantMem(mem)) return `<span class="mk tmp" title="缺人占位（尚未分配真人）" style="background:#fef2f2;color:#d32320;border:1.5px dashed #f87171;font-weight:700;">🔴 ${n}</span>`;
        const stt = effLeft(mem) ? 'left' : (mem ? mem.status : 'on');
        if (stt === 'left' && !isDone) return '';           // 非已完成：已离职不显示
        // 已离职参与者：显示名字 + 离职标注
        if (stt === 'left' || leftSet.has(n)) {
          const cls = corp === 'reg' ? 'mk reg-mk' : corp === 'sub' ? 'mk sub-mk' : 'mk';
          const prefix = (corp === 'reg' || corp === 'sub') ? '👑 ' : '';
          const dyn = (mem && !LOCAL_MEMBER_IDS.has(mem.id)) ? '<i class="dyn-dot" title="云端动态同步成员"></i>' : '';
          return `<span class="${cls} mk-left" title="已离职（历史参与者）" style="opacity:.65;text-decoration:line-through;text-decoration-color:#f87171;">${prefix}${n}${dyn}<small class="left-tag">已离</small></span>`;
        }
        if (stt === 'new')  return `<span class="mk" title="新人">${n}</span>`;
        const cls = corp === 'reg' ? 'mk reg-mk' : corp === 'sub' ? 'mk sub-mk' : 'mk';
        const prefix = (corp === 'reg' || corp === 'sub') ? '👑 ' : '';
        const dyn = (mem && !LOCAL_MEMBER_IDS.has(mem.id)) ? '<i class="dyn-dot" title="云端动态同步成员"></i>' : '';
        return `<span class="${cls}" title="${corp === 'reg' ? '正编·带队' : corp === 'sub' ? '子公司' : '基地'}${stt === 'new' ? '·新人' : ''}${dyn ? ' · 云端同步' : ''}">${prefix}${n}${dyn}</span>`;
      };
      // 正编组（蓝标）
      r.regs.forEach(n => makersHTML += mkTag(n, 'reg'));
      // 基地组（灰标）
      r.bases.forEach(n => makersHTML += mkTag(n, 'base'));
      // 暂缺组（红虚线）—— 单独渲染，不计入编制
      (r.tmp || []).forEach(n => {
        makersHTML += `<span class="mk tmp" title="缺人占位（尚未分配真人）" style="background:#fef2f2;color:#d32320;border:1.5px dashed #f87171;font-weight:700;">🔴 ${n}</span>`;
      });
      // 支援组
      (r.sup || []).forEach(n => {
        makersHTML += `<span class="mk sup" title="支援(非本管线编制)">${n}·支援</span>`;
      });
      if (!r.regs.length && !r.bases.length && !(r.sup||[]).length && !(r.tmp||[]).length) makersHTML = `<span class="empty">暂无人员</span>`;
      // 配置/缺口：直接用 buildRoleLines 算好的 r.gap（已含暂缺占位口径，见 v6.63 注释），
      //   渲染层不再二次加工，保证行内徽标与模块汇总(modGap)完全同源。
      const totalGap = r.gap;
      const tmpCount = (r.tmp || []).length;
      const gapTitle = tmpCount > 0
        ? `标配需 ${r.std} 个基地人力，当前真人 ${r.cfg} 人 + ${tmpCount} 个暂缺占位待招 → 缺 ${totalGap} 人`
        : `标配需 ${r.std} 个基地人力，当前在岗 ${r.cfg} 人 → 缺 ${totalGap} 人`;
      /* v6.69：无标准编制的模块（联调/通用/饰品等）不判缺口也不判"齐"，
         只如实显示在岗人数 + 灰色「无标配」说明，避免绿色"齐"被误读成"已按标准配满"。 */
      const cntHTML = !r.hasStd
        ? (r.cfg > 0
            ? `<span class="cfg">配置${r.cfg}人</span><span class="okb" style="background:#f2f4f7;color:#8d95a1;border-color:#e3e7ec" title="该模块不在标准配置表中，无标配编制 → 不统计缺口">无标配</span>`
            : `<span class="cfg">—</span>`)
        : (totalGap > 0
            ? `<span class="cfg">配置${r.cfg}人</span><span class="gapb" title="${gapTitle}">缺${totalGap}</span>`
            : (r.cfg > 0 ? `<span class="cfg">配置${r.cfg}人</span><span class="okb" title="标配需 ${r.std} 人，当前在岗 ${r.cfg} 人，已配齐">齐</span>` : `<span class="cfg">—</span>`));
      html += `<div class="hr-role">
        <span class="gdot" style="background:${g.col}"></span>
        <span class="rname">${r.role}</span>
        ${r.status ? `<span class="hr-stat" style="background:${st.bg};color:${st.tx}">${r.status}</span>` : ''}
        <span class="hr-cnt">${cntHTML}</span>
        <span class="hr-makers">${makersHTML}</span>
        ${r.note ? `<span class="hr-note">${r.note}</span>` : ''}
      </div>`;
    });
    html += `</div>`;
  });
  html += `</div></div><!-- /hr-body -->`;
  document.getElementById('grid').innerHTML = html;
}

function updateKPIs(){
  const HR = computeHR();

  // 1. 在岗编制人数：花名册在岗总人头（排除已离职）
  document.getElementById('kp-mem').textContent = HR.base;

  // 2. 高峰并行角色数量：HR 角色线总数（buildRoleLines 输出的角色行数，如红蔻/金角/橙角等）
  const roleLines = buildRoleLines();
  const roleLineCount = roleLines.reduce((sum, g) => sum + g.roles.length, 0);
  document.getElementById('kp-maker').textContent = roleLineCount;

  // 3. 高峰负载率：在岗成员中个人负载率的最大值（%）
  const activeMems = members.filter(m => !effLeft(m) && !isVacantMem(m) && !isExtLoan(m));
  const loads = activeMems.map(m => memLoad(m.id).pct);
  const peakLoad = loads.length ? Math.max(...loads, 0) : 0;
  const loadEl = document.getElementById('kp-cfg');
  loadEl.textContent = Math.round(peakLoad) + '%';
  loadEl.className = 'val ' + (peakLoad <= 85 ? 's' : peakLoad <= 110 ? 'w' : 'd');

  // 4. 高风险需求：风险等级为"高"的需求数量
  const highRiskCount = reqs.filter(r => reqRisk(r).lvl === '高').length;
  const riskEl = document.getElementById('kp-gap');
  riskEl.textContent = highRiskCount;
  riskEl.className = 'val ' + (highRiskCount > 0 ? 'd' : 's');

  // 5. 常规管线缺口：标配缺口 + 暂缺占位（与 HR 汇总卡一致）
  document.getElementById('kp-lack').textContent = HR.lack + '人';
}

/* ============ tooltip ============ */
const tip=document.getElementById('tip');
function showTip(e,html,wide){if(drag)return;if(window.__cmtSuppressTip)return;tip.classList.toggle('wide',!!wide);tip.innerHTML=html;tip.style.opacity=1;const w=wide?360:280;let x=e.clientX+14,y=e.clientY+14;if(x>innerWidth-w)x=e.clientX-w+6;if(x<6)x=6;const th=tip.offsetHeight||0;if(y>innerHeight-th-12)y=Math.max(8,innerHeight-th-12);tip.style.left=x+'px';tip.style.top=y+'px';}
function hideTip(){tip.style.opacity=0;}
/* ===== 名词释义悬停（规则面板里维度A/维度B等）===== */
const TERM_TIP={
  dimA:`<span class="tip-h">维度A · 产能（时间是否够用）</span>
比一比两个量：<br>
① <b class="hi">剩余工作量</b> = 总预估人天 − 已完成人天<br>
② <b class="hi">投入产能</b> = <code>剩余工作日 × Σ(每人 eff × 超载折损)</code><br>
<span class="g">· 只算还在干、且未完成的人，同一人多段按一个人头</span><br>
<span class="g">· eff＝效率系数；超载者按 100÷负载 打折</span>
<span class="tip-f">缺口 gap = ①−② ；比例 ratio = gap÷①。<br><b class="gn">低</b> gap≤0　·　<b class="am">中</b> ratio≤20%　·　<b class="rd">高</b> ratio&gt;20%</span>`,
  dimB:`<span class="tip-h">维度B · 人力结构（管线是否缺人）</span>
看该角色管线<b class="hi">缺不缺人</b>，与时间无关：<br>
· <b class="rd">高</b> = 缺人且<u>已开工</u>（眼下就缺）<br>
· <b class="am">中</b> = 缺人但<u>未开工</u>（后续压力）<br>
· <b class="gn">低</b> = 人力到位
<span class="tip-f">缺口数来自「人力分配（按模块/缺口）」视图的标配核定。</span>`,
  finalRisk:`<span class="tip-h">最终风险 = 两维取高</span>
同一需求分别按 <b class="hi">维度A</b> 和 <b class="hi">维度B</b> 各判一档，<br><b>取较高的一档</b>作为该需求最终风险。<br>
<span class="g">即"产能"和"人力结构"任一告急，需求就告急。</span>`
};
function showTermTip(e,key){showTip(e,TERM_TIP[key]||'',true);}

/* ============ 拖拽编辑（改期 + 跨人改派 + 单击改状态） ============ */
const grid=document.getElementById('grid');
const dlabel=document.getElementById('dlabel');
let drag=null;
let phdrag=null;   // L1/L2 分割线拖拽态
let msdrag=null;   // v7.46 关键节点拖拽改期态（汇总行菱形 .ms-node / 需求条内圆点 .ms-mark.ms-custom）

/* v5.90fix: 捕获阶段拦截 #grid 内任意左键 pointerdown 并 preventDefault，从源头掐断浏览器原生「拖拽选区/拖放」反馈
   （该反馈即用户看到的拖条时大块纯色高亮；它不属于页面 DOM、Selection API 也常采样不到，纯 CSS 禁选仍可能在
   部分 Chromium 版本漏网，故用 JS 双保险）。仅拦左键、且限定在 #grid 内，不影响外部点击/输入。 */
document.addEventListener('pointerdown',e=>{
  if(e.button!==0) return;
  if(e.target.closest('#grid')) e.preventDefault();
}, true);
grid.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;            // 仅左键可拖任务条/分割线；中键留给视图平移、右键留给浏览器菜单
  // 只读模式：任何任务条/分割线的拖拽与点击改状态都不允许（仅当点到可交互条时拦截并提示）
  // v7.46：补 .ms-node —— 汇总行菱形不在 .bar-task 内，原先漏判会在只读模式下仍可拖动关键节点
  if((e.target.closest('.bar-task')||e.target.closest('.ph-div')||e.target.closest('.ms-node')) && !requireWrite()){ e.preventDefault(); return; }
  /* —— v7.46：关键节点拖拽改期（必须排在 .bar-task 分支之前）——
     .ms-mark.ms-custom 是嵌在需求条内的圆点，若先走 .bar-task 分支会被"整条改期"吞掉；
     .ms-node 是汇总行菱形，本身不在条内。二者统一在此拦截。
     坐标系双轨：汇总行用像素（left = 天索引 × DAY_W），条内用百分比（相对条宽），
     故 inBar 与否各算各的，不可混用。 */
  const msel=e.target.closest('.ms-node,.ms-mark.ms-custom');
  if(msel && !msel.classList.contains('phase')){   // 阶段菱形归 .ms-mark.phase，仍走下方 phdrag 分支
    if(!requireWrite()){ e.preventDefault(); return; }
    const r=reqs.find(x=>x.id===msel.dataset.req); if(!r)return;
    const mi=+msel.dataset.msidx, ms=(r.milestones||[])[mi]; if(!ms)return;
    const inBar=msel.classList.contains('ms-mark');
    const bar=inBar?msel.closest('.bar-task'):null;
    /* 虚线 DOM 顺序 == allMilestones() 顺序（同一函数、同样按 date 排序），
       故按下时按全局下标缓存 link 元素即可，move 里不必再重排查询。 */
    const gi=allMilestones().findIndex(m=>m.reqId===r.id&&m.msIdx===mi);
    const lk=gi>=0?document.querySelectorAll('#msLinkLayer .ms-link')[gi]:null;
    msdrag={el:msel,r,mi,inBar,bar,reqId:r.id,startX:e.clientX,startIdx:idx(ms.date),
            barS:inBar?parseFloat(bar.style.left)/DAY_W:0,     // 条起点（天），供百分比换算
            span:inBar?parseFloat(bar.style.width)/DAY_W:0,    // 条宽度（天）
            linkEl:lk, cur:null, moved:false};
    msel.classList.add('dragging');hideTip();hideMenu();
    e.preventDefault();e.stopPropagation();
    return;
  }
  // —— 优先处理「阶段分割线」：独立拖拽，不触发整条改期/改派 ——
  //    phdiv=1 → L1/L2 分割（设 L1 完成时间，写 r.split）
  //    phdiv=2 → L2/联调 分割（设联调开始时间，写 r.split2）
  // v7.45：阶段节点圆点 .ms-mark.phase 复用分割线拖拽（data-req/data-phdiv 已带），改期写回逻辑不变
  const div=e.target.closest('.ph-div,.ms-mark.phase');
  if(div){
    const bar=div.closest('.bar-task');
    const r=reqs.find(x=>x.id===div.dataset.req); if(!r){return;}
    const ph=getPhases(r);
    const which=div.dataset.phdiv==='2'?2:1;
    phdrag={div,bar,r,ph,which,startX:e.clientX,split:(which===2?ph.split2:ph.split),moved:false};
    div.classList.add('dragging');hideTip();hideMenu();
    e.preventDefault();e.stopPropagation();
    return;
  }
  const bar=e.target.closest('.bar-task'); if(!bar)return;
  setSelected(bar);
  let mode=e.target.classList.contains('gl')?'l':e.target.classList.contains('gr')?'r':'m';
  // 按住 Shift 拖某人的任务段 → 复制模式：原段保留，落点复制出一份新段（仅整体移动有效，强制 mode='m'）
  const isSeg=bar.dataset.seg!==undefined && bar.dataset.seg!=='';
  const dup=e.shiftKey && isSeg;
  if(dup) mode='m';
  drag={bar,mode,dup,startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastY:e.clientY,
        origLeft:parseFloat(bar.style.left),origW:parseFloat(bar.style.width),
        delta:0,movedPx:0,targetMember:null,
        srcMember:isSeg?reqs.find(r=>r.id===bar.dataset.req).segs[+bar.dataset.seg].m:null};
  bar.classList.add('dragging'); if(dup)bar.classList.add('dup-src'); hideTip();hideMenu();
  e.preventDefault();
});
window.addEventListener('pointermove',e=>{
  // v7.46：关键节点拖拽 —— 实时改位 + 虚线跟随 + 日期标签
  if(msdrag){
    const d=Math.round((e.clientX-msdrag.startX)/DAY_W);
    const ni=Math.max(0,Math.min(DAYS-1,msdrag.startIdx+d));   // 夹在时间轴范围内
    if(d!==0) msdrag.moved=true;
    msdrag.cur=ni;
    if(msdrag.inBar){
      // 条内：百分比定位。夹 [2,98] 与 reqMilestonesHTML 一致，防 .bar-task 的 overflow:hidden 裁掉半颗粒子
      const pct=Math.max(2,Math.min(98,(ni-msdrag.barS)/msdrag.span*100));
      msdrag.el.style.left=pct.toFixed(2)+'%';
    }else{
      msdrag.el.style.left=(ni*DAY_W)+'px';   // 汇总行：像素定位
    }
    if(msdrag.linkEl) msdrag.linkEl.style.left=(ni*DAY_W)+'px';   // 竖向虚线实时跟随
    const lab=(msdrag.r.milestones[msdrag.mi]||{}).label||'';
    dlabel.textContent=`🚩 ${lab} → ${fmt(i2d(ni))}`;
    dlabel.style.opacity=1;dlabel.style.left=(e.clientX+14)+'px';dlabel.style.top=(e.clientY-32)+'px';
    return;
  }
  // 分割线拖拽：实时移动 + 标签提示
  if(phdrag){
    const {ph,bar,which}=phdrag;
    const dDays=Math.round((e.clientX-phdrag.startX)/DAY_W);
    let ns=phdrag.split+dDays;
    const span=Math.max(ph.barE-ph.barS,1);
    const pcL=i=>((i-ph.barS)/span*100);
    if(which===2){
      // L2/联调 分割：夹在 [split+1, barE]，拖到 barE 即 L2 全覆盖联调
      ns=Math.max(ph.split+1,Math.min(ph.barE,ns));
      phdrag.cur=ns;
      if(dDays!==0)phdrag.moved=true;
      phdrag.div.style.left=pcL(ns)+'%';
      const l2=bar.querySelector('.ph-l2'),ltb=bar.querySelector('.ph-lt');
      if(l2){l2.style.width=(pcL(ns)-pcL(ph.split))+'%';}
      if(ltb){ltb.style.left=pcL(ns)+'%';ltb.style.width=(pcL(ph.barE)-pcL(ns))+'%';}
      const ltDays=workdays(i2d(ns),i2d(ph.barE));
      // 即时刷新左侧「+联调N人天」（拖动过程中实时联动，不必等松手 rerender）
      updateLtMeta(r.id, ltDays);
      dlabel.textContent=ltDays>0
        ?`L2 ${fmt(i2d(ph.split))} → ${fmtEnd(i2d(ns))}　|　联调 ${fmt(i2d(ns))} → ${fmtEnd(i2d(ph.barE))}（${ltDays}工作日）`
        :`L2 ${fmt(i2d(ph.split))} → ${fmtEnd(i2d(ph.barE))}（已覆盖联调）`;
    }else{
      // L1/L2 分割：夹在 [s+1, l2.e-1]（不越过联调起点）
      ns=Math.max(ph.s+1,Math.min(ph.l2.e-1,ns));
      phdrag.cur=ns;
      if(dDays!==0)phdrag.moved=true;
      phdrag.div.style.left=pcL(ns)+'%';
      const l1=bar.querySelector('.ph-l1'),l2=bar.querySelector('.ph-l2');
      if(l1&&l2){
        l1.style.width=(pcL(ns)-pcL(ph.s))+'%';
        l2.style.left=pcL(ns)+'%';l2.style.width=(pcL(ph.l2.e)-pcL(ns))+'%';
      }
      dlabel.textContent=`L1 ${fmt(i2d(ph.s))} → ${fmtEnd(i2d(ns))}（${workdays(i2d(ph.s),i2d(ns))}工作日）　|　L2 ${fmt(i2d(ns))} → ${fmtEnd(i2d(ph.l2.e))}`;
    }
    dlabel.style.opacity=1;dlabel.style.left=(e.clientX+14)+'px';dlabel.style.top=(e.clientY-32)+'px';
    return;
  }
  if(!drag)return;
  drag.lastX=e.clientX;drag.lastY=e.clientY;
  drag.movedPx=Math.abs(e.clientX-drag.startX)+Math.abs(e.clientY-drag.startY);
  const d=Math.round((e.clientX-drag.startX)/DAY_W);
  drag.delta=d;
  const {bar,mode,origLeft,origW}=drag;
  if(mode==='m'){bar.style.left=(origLeft+d*DAY_W)+'px';}
  else if(mode==='l'){let nl=origLeft+d*DAY_W,nw=origW-d*DAY_W;if(nw<DAY_W){nw=DAY_W;nl=origLeft+origW-DAY_W;}bar.style.left=nl+'px';bar.style.width=nw+'px';}
  else if(mode==='r'){let nw=origW+d*DAY_W;if(nw<DAY_W)nw=DAY_W;bar.style.width=nw+'px';}

  // v6.26：拖拽过程中实时重算「源成员」的排期空隙（被拖段按瞬时位置覆盖），让琥珀提示跟随条子动态变化
  if(view==='person' && drag.srcMember){
    try{
      let si0=Math.round(origLeft/DAY_W), ei0=si0+Math.round(origW/DAY_W);
      if(mode==='m'||mode==='l') si0=Math.max(0, Math.round(origLeft/DAY_W+d));
      if(mode==='r') ei0=Math.round(origLeft/DAY_W+origW/DAY_W+d);
      si0=Math.max(0,Math.min(si0,DAYS)); ei0=Math.max(si0,Math.min(ei0,DAYS));
      refreshGapsForMember(drag.srcMember,{reqId:bar.dataset.req,seg:+(bar.dataset.seg||0),si0,ei0});
    }catch(_){}
  }

  document.querySelectorAll('.row-target').forEach(r=>r.classList.remove('row-target'));
  drag.targetMember=null;
  if(view==='person' && mode==='m' && drag.srcMember){
    const tm=rowMemberAt(e.clientX,e.clientY);
    // 普通拖拽：落到他人行才算改派；复制模式：落到任意行都高亮（含本人，复制一份给该人）
    if(tm && (drag.dup || tm!==drag.srcMember)){
      const row=document.querySelector(`.row[data-mem="${tm}"]`);
      if(row){row.classList.add('row-target');drag.targetMember=tm;}
    }
  }
  showDragLabel(e);
});
window.addEventListener('pointercancel',()=>{
  // 指针意外中断（离开窗口/触控中断等）：清理所有拖拽状态，防止 drop-guide 残留
  if(drag){drag=null;}
  if(phdrag){phdrag=null;}
  if(msdrag){msdrag=null;}   // v7.46：关键节点拖拽态一并清理
  hideDragLabel();
  document.querySelectorAll('.dragging,.dup-src,.row-target').forEach(el=>el.classList.remove('dragging','dup-src','row-target'));
});
window.addEventListener('pointerup',()=>{
  // v7.46：关键节点拖拽收尾 —— 写回 r.milestones[mi].date
  if(msdrag){
    const {el,r,mi,cur,moved}=msdrag;
    el.classList.remove('dragging');
    hideDragLabel();
    msdrag=null;
    if(moved && cur!=null){
      pushHistory();
      const lab=(r.milestones[mi]||{}).label||'';
      r.milestones[mi].date=i2d(cur);
      _logDesc='拖拽关键节点改期：'+lab;
      save();broadcast();rerender();
      toast('关键节点已改期 → '+fmt(i2d(cur)));
    }else{ rerender(); }   // 未移动：重渲染复位（顺带清掉可能的残留状态）
    return;
  }
  // 分割线拖拽收尾：写回 r.split（L1 完成时间）或 r.split2（联调开始时间）
  if(phdrag){
    const {div,r,cur,moved,which}=phdrag;
    div.classList.remove('dragging');
    hideDragLabel();
    phdrag=null;
    if(moved && cur!=null){
      pushHistory();
      if(which===2){
        // 【单一数据源】L2/联调 分割线 = 联调子需求的开始时间。
        // 不再写独立的 r.split2，而是直接 resize 联调子需求 segs 的起点（锚定结束），
        // 这样「按人看」里那条联调任务条会同步跟着变（两视图共用同一份数据）。
        const addons=(r.children||[]).map(id=>reqs.find(x=>x.id===id)).filter(Boolean);
        addons.forEach(a=>a.segs.forEach(sg=>{
          const se=idx(sg.e);
          const ns=Math.min(Math.max(cur,0),se);   // 起点夹在 [0, 该段结束]，拖到结束即联调窗口=0（被 L2 覆盖）
          sg.s=i2d(ns);
        }));
        addons.forEach(a=>{ if(a.segs.length) a.end=i2d(Math.max(...a.segs.map(x=>idx(x.e)))); });
        _logDesc='调整「'+r.name+'」联调开始时间';
      }
      else{ r.split=cur; }
      save();broadcast();rerender();
      toast(which===2?`已设定联调开始时间 ${fmt(i2d(cur))}`:`已设定 L1 完成时间 ${fmt(i2d(cur))}`);
    }else{ rerender(); }
    return;
  }
  if(!drag)return;
  const {bar,delta,mode,movedPx,targetMember,dup}=drag;
  bar.classList.remove('dragging','dup-src');
  document.querySelectorAll('.row-target').forEach(r=>r.classList.remove('row-target'));
  hideDragLabel();
  const d=drag;drag=null;
  // —— 复制模式（Shift 拖拽）：原段不动，落点复制出一份新段 ——
  if(dup){
    if(movedPx<5 && !targetMember){ rerender(); return; }   // 几乎没动且未跨人 → 视为放弃
    const r=reqs.find(x=>x.id===bar.dataset.req);
    if(r && bar.dataset.seg!==undefined && r.segs[+bar.dataset.seg]){
      pushHistory();
      const src=r.segs[+bar.dataset.seg];
      let s=idx(src.s)+delta, e=idx(src.e)+delta;
      if(s<0){e-=s;s=0;} if(e>DAYS){s-=(e-DAYS);e=DAYS;} s=Math.max(0,s);e=Math.min(DAYS,e);
      const newSeg={m:src.m, s:i2d(s), e:i2d(e), prog:0, status:'todo'};  // 复制派活=全新任务段，进度归零、未开始（不继承源段进度，避免显示成「整体/源进度」）
      if(src.support) newSeg.support=true;
      const _ot=segOpenType(src); if(_ot) newSeg.open=_ot;
      if(src.inv!=null) newSeg.inv=src.inv;
      if(targetMember && targetMember!==src.m){
        newSeg.m=targetMember;
        const mem=memById(targetMember), rl=reqLeadOf(r), ml=leadOf(mem);
        newSeg.support=(rl&&ml&&ml!==rl)?true:!!src.support;
        _logDesc='复制「'+r.name+'」任务段给'+memName(targetMember);
        toast('已复制一份给 '+memName(targetMember));
      }else{
        _logDesc='复制「'+r.name+'」任务段（'+memName(src.m)+'）';
        toast('已复制一份：'+memName(src.m));
      }
      r.segs.push(newSeg);
      r.end=i2d(Math.max(...r.segs.map(x=>idx(x.e))));
      save();broadcast();rerender();
    }else{ rerender(); }
    return;
  }
  if(movedPx<5 && mode==='m'){ /* 左键单击=仅选中(已在pointerdown中setSelected)，不弹菜单；右键菜单由contextmenu事件处理 */ return; }
  if(delta!==0 || targetMember){
    pushHistory();
    applyEdit(bar,delta,mode);
    const _r0=reqs.find(x=>x.id===bar.dataset.req);
    if(targetMember && bar.dataset.seg!==undefined){
      const r=reqs.find(x=>x.id===bar.dataset.req);
      if(r&&r.segs[+bar.dataset.seg]){
        r.segs[+bar.dataset.seg].m=targetMember;
        toast(`已改派给 ${memName(targetMember)}`);
        _logDesc='把「'+r.name+'」任务改派给'+memName(targetMember);
      }
    }
    if(!_logDesc&&_r0) _logDesc=(mode==='m'?'移动':'调整')+'「'+_r0.name+'」任务条时间';
    save();broadcast();rerender();
  }else{ rerender(); }
});

// 右键单击任务条 / 左栏需求行 / 成员行 → 选中 + 弹出状态/操作菜单
document.addEventListener('contextmenu',e=>{
  // v7.45：右键关键节点（汇总行菱形 / 条内圆点 / 阶段菱形）→ 弹节点编辑层，不走任务菜单
  const msEl=e.target.closest('.ms-node,.ms-mark');
  if(msEl){
    e.preventDefault();
    const rid=msEl.dataset.req;
    if(msEl.classList.contains('phase')) openEditPhaseNode(rid, msEl.dataset.phkey);
    else openEditMilestone(rid, +msEl.dataset.msidx);
    return;
  }
  // v7.45：右键「关键节点」汇总行空白时间轴 → 新建节点（按点击处的日期预填）
  const msTrack=e.target.closest('.ms-summary-track');
  if(msTrack){
    e.preventDefault();
    const rect=msTrack.getBoundingClientRect();
    const dIdx=Math.max(0,Math.min(DAYS-1,Math.round((e.clientX-rect.left)/DAY_W)));
    openAddMilestone(null, dIdx);
    return;
  }
  let bar=e.target.closest('.bar-task');
  // 右键点在「按需求看」的需求行上（.req-row）→ 找到该行的 req-bar 作为菜单锚点
  if(!bar){
    const row=e.target.closest('.req-row[data-req-row]');
    if(row) bar=row.querySelector('.bar-task.req-bar')||row.querySelector('.bar-task');
  }
  /* v7.14 右键人员行左栏 → 弹「人员管理」菜单（编辑 / 切换状态 / 加任务 / 删除人员）。
     必须在下面的 .row[data-mem] 回落分支【之前】拦截：
       · 旧行为：右键成员行左栏会去找该行第一个任务条当锚点，弹出来的是【任务菜单】—— 语义错位；
         且成员一条任务段都没有时 bar 为 null → 走到 if(!bar)return，什么都不弹，
         等于根本没有人员管理入口（这就是「右键删除人员」缺失的根因）。
       · 新行为：命中 .cell-left（且不在任务条内）一律走人员菜单；
         右键任务条本体仍走原有任务菜单，行为完全不变。 */
  if(!bar){
    const memRow=e.target.closest('.row[data-mem]');
    if(memRow && e.target.closest('.cell-left')){
      e.preventDefault();
      openMemberAdminMenu(memRow.dataset.mem, e.clientX, e.clientY);
      return;
    }
  }
  // 右键点在「按人看」的成员行任务区空白处 → 找到该成员的第一个任务条作为锚点
  if(!bar){
    const memRow=e.target.closest('.row[data-mem]');
    if(memRow) bar=memRow.querySelector('.bar-task');
  }
  if(!bar)return;
  e.preventDefault();                          // 屏蔽浏览器默认右键菜单
  setSelected(bar);                            // 先选中
  openStatusMenu(bar, e.clientX, e.clientY);   // 再弹菜单
}, {passive:false});

function rowMemberAt(x,y){
  const el=document.elementFromPoint(x,y);
  if(!el)return null;
  const row=el.closest('.row[data-mem]');
  return row?row.dataset.mem:null;
}

function showDragLabel(e){
  const {bar,targetMember,dup}=drag;
  const l=parseFloat(bar.style.left),w=parseFloat(bar.style.width);
  const si=Math.round(l/DAY_W),ei=Math.round((l+w)/DAY_W);
  let txt=fmt(i2d(si))+' → '+fmtEnd(i2d(ei))+'（'+workdays(i2d(si),i2d(ei))+'工作日）';
  if(targetMember) txt=(dup?'复制 → ':'改派 → ')+memName(targetMember)+'　'+txt;
  else if(dup) txt='＋复制一份　'+txt;
  dlabel.textContent=txt;
  dlabel.style.opacity=1;
  dlabel.style.left=(e.clientX+14)+'px';
  dlabel.style.top=(e.clientY-32)+'px';
  // 落点参考线/带：在 grid 坐标系中，timeline 左侧偏移 left-w
  const lw=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))||340;
  const g0=document.getElementById('dropG0'),g1=document.getElementById('dropG1'),band=document.getElementById('dropBand');
  if(g0&&g1&&band){
    const x0=lw+si*DAY_W, x1=lw+ei*DAY_W;
    g0.style.left=x0+'px'; g0.classList.add('show');
    g1.style.left=x1+'px'; g1.classList.add('show');
    band.style.left=x0+'px'; band.style.width=(x1-x0)+'px'; band.classList.add('show');
  }
}
function hideDragLabel(){
  dlabel.style.opacity=0;
  ['dropG0','dropG1','dropBand'].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.remove('show');});
}

function applyEdit(bar,delta,mode){
  const r=reqs.find(x=>x.id===bar.dataset.req); if(!r)return;
  if(delta===0)return;
  if(bar.dataset.seg!==undefined && bar.dataset.seg!==''){
    const seg=r.segs[+bar.dataset.seg];
    let s=idx(seg.s),e=idx(seg.e);
    if(mode==='m'){s+=delta;e+=delta;}
    else if(mode==='l'){s=Math.min(s+delta,e-1);}
    else if(mode==='r'){e=Math.max(e+delta,s+1);}
    if(s<0){if(mode==='m')e-=s;s=0;}
    if(e>DAYS){if(mode==='m')s-=(e-DAYS);e=DAYS;}
    s=Math.max(0,s);e=Math.min(DAYS,e);
    seg.s=i2d(s);seg.e=i2d(e);
  }else{
    // 拖头/尾改期前：若 L1/L2 分界仍是默认（r.split 未手动设过），先按当前区间中点固化成「绝对日索引」。
    // 否则它每次都由 getPhases 重算中点 (s+e)/2 —— 拖尾时 e 变大，中点随之右移，表现为「分界线跟着尾巴跑」。
    // 固化后 split 是定值，拖尾只动 e、分界纹丝不动（按固定日期标定）。
    if((mode==='r'||mode==='l') && r.split==null){
      const ps=Math.min(...r.segs.map(x=>idx(x.s))), pe=Math.max(...r.segs.map(x=>idx(x.e)));
      r.split=Math.max(ps+1,Math.min(pe-1,Math.round((ps+pe)/2)));
    }
    if(mode==='m'){
      let minS=Math.min(...r.segs.map(x=>idx(x.s)));
      let maxE=Math.max(...r.segs.map(x=>idx(x.e)));
      let d=delta;
      if(minS+d<0)d=-minS;
      if(maxE+d>DAYS)d=DAYS-maxE;
      r.segs.forEach(x=>{x.s=i2d(idx(x.s)+d);x.e=i2d(idx(x.e)+d);});
      if(r.split!=null)r.split+=d;          // 整条平移：L1/L2 分割点随之平移，保持相对位置
      // 整条平移：联调子需求的真实 segs 一起平移（它们是独立 reqs，不在 r.segs 里），
      // 否则「按需求看」联调段与「按人看」联调任务条会错位。split2 由 lt.s 派生，自然同步。
      (r.children||[]).map(id=>reqs.find(x=>x.id===id)).filter(Boolean).forEach(a=>{
        a.segs.forEach(x=>{x.s=i2d(idx(x.s)+d);x.e=i2d(idx(x.e)+d);});
        if(a.segs.length) a.end=i2d(Math.max(...a.segs.map(x=>idx(x.e))));
      });
    }else if(mode==='r'){
      // 整条需求的可见右端 barE = max(主特效段结束, 联调子需求结束)。拖右把手要移动的是这条「整体尾巴」。
      // 它可能由联调子需求决定——若只改主特效段尾巴、联调仍停在更右，bar 宽度(barE)不变 → 表现为「拖完回弹」。
      // 故跨「主 segs + 联调子需求 segs」找出结束最晚的所有档，整体平移到新尾巴并保持对齐。
      const kids=(r.children||[]).map(id=>reqs.find(x=>x.id===id)).filter(Boolean);
      const pools=[r.segs, ...kids.map(k=>k.segs)];
      let maxE=-Infinity; pools.forEach(arr=>arr.forEach(sg=>{ if(idx(sg.e)>maxE)maxE=idx(sg.e); }));
      const ctrl=[]; pools.forEach(arr=>arr.forEach(sg=>{ if(idx(sg.e)===maxE) ctrl.push(sg); }));
      const maxS=Math.max(...ctrl.map(sg=>idx(sg.s)));
      const ne=Math.min(Math.max(maxE+delta, maxS+1), DAYS);
      ctrl.forEach(sg=>{ sg.e=i2d(ne); });
      kids.forEach(k=>{ if(k.segs.length) k.end=i2d(Math.max(...k.segs.map(x=>idx(x.e)))); });
    }else if(mode==='l'){
      const seg=r.segs.reduce((a,b)=>idx(b.s)<idx(a.s)?b:a);
      const s=Math.max(Math.min(idx(seg.s)+delta,idx(seg.e)-1),0);seg.s=i2d(s);
    }
    // 改期后将 split 夹回新的特效区间内（getPhases 也会兜底，这里持久化一致性）
    if(r.split!=null){
      const ns=Math.min(...r.segs.map(x=>idx(x.s))), ne=Math.max(...r.segs.map(x=>idx(x.e)));
      r.split=Math.max(ns+1,Math.min(ne-1,r.split));
    }
  }
  r.end=i2d(Math.max(...r.segs.map(x=>idx(x.e))));
}

/* ============ 状态菜单（单击任务条） ============ */
const menu=document.getElementById('menu');
let menuCtx=null;
function openStatusMenu(bar,x,y){
  const r=reqs.find(z=>z.id===bar.dataset.req); if(!r)return;
  const isSeg=bar.dataset.seg!==undefined && bar.dataset.seg!=='';
  const cur=isSeg?(r.segs[+bar.dataset.seg].status||'doing'):aggStatus(r);
  menuCtx={reqId:r.id,seg:isSeg?+bar.dataset.seg:null,bar};
  let items=`<div class="mtitle">${isSeg?memName(r.segs[+bar.dataset.seg].m)+' · ':''}${r.name} — 改状态</div>`;
  STATUS_ORDER.forEach(k=>{
    const s=STATUS[k];
    if(k==='done' && isSeg){
      // 单击某个人的任务段标「已完成」时，给出二选一：整条需求收尾 vs 仅本人这段完成。
      const sg2=r.segs[+bar.dataset.seg];
      const allDone=reqIsDone(r), segDone=sg2.status==='done';
      items+=`<div class="mi mi-done ${allDone?'cur':''}" onclick="pickStatus('done')"><i style="background:${s.col}"></i>已完成（整条需求）<span class="mi-tag">封存全员</span></div>`;
      items+=`<div class="mi mi-done ${(segDone&&!allDone)?'cur':''}" onclick="pickSegDone()"><i style="background:${s.col};opacity:.5"></i>已完成（仅本人这段）<span class="mi-tag">不影响他人</span></div>`;
    }else{
      items+=`<div class="mi ${k===cur?'cur':''}" onclick="pickStatus('${k}')"><i style="background:${s.col}"></i>${s.label}</div>`;
    }
  });
  if(isSeg){
    const sg=r.segs[+bar.dataset.seg];
    const curInv=(sg.inv!=null&&sg.inv<1)?sg.inv:1;                 // 当前投入比：未设/=1 视为全人力
    items+=`<div class="msep"></div>`;
    items+=`<div class="mtitle">投入比（精力分配）</div>`;
    INV_TIERS.forEach(t=>{
      const hi=(t.hi!=null?t.hi:t.val), lo=(t.lo!=null?t.lo:(hi>=1?0:hi));
      const on=Math.abs(hi-curInv)<1e-6;
      const sub=hi>=1?'独占1.0·并行1/N':`区间 ${lo}–${hi}`;
      items+=`<div class="mi miv ${on?'cur':''}" onclick="pickInv(${hi})"><i style="background:${t.col}"></i><span class="miv-nm">${effEsc(t.name)} <b style="color:${t.col}">${hi>=1?hi:lo+'–'+hi}</b></span><span class="miv-sub">${sub}</span></div>`;
    });
    items+=`<div class="msep"></div>`;
    items+=`<div class="mtitle">时间长度</div>`;
    const _otm=segOpenType(sg);
    items+=`<div class="mi ${_otm===null?'cur':''}" onclick="toggleSegOpen(null)"><i style="background:#64748b"></i>固定起止时间<span style="font-size:10px;color:var(--tx3);margin-left:auto">有限长度</span></div>`;
    items+=`<div class="mi ${_otm==='front'?'cur':''}" onclick="toggleSegOpen('front')"><i style="background:#8b5cf6"></i>前端无限延长<span style="font-size:10px;color:var(--tx3);margin-left:auto">起始端无固定边界</span></div>`;
    items+=`<div class="mi ${_otm==='back'?'cur':''}" onclick="toggleSegOpen('back')"><i style="background:#a855f7"></i>后端无限延长<span style="font-size:10px;color:var(--tx3);margin-left:auto">结束端无固定边界</span></div>`;
    items+=`<div class="mi ${_otm==='both'?'cur':''}" onclick="toggleSegOpen('both')"><i style="background:#7c3aed"></i>前后无限延长<span style="font-size:10px;color:var(--tx3);margin-left:auto">时间待定 · 长期/持续</span></div>`;
    items+=`<div class="msep"></div>`;
    items+=`<div class="mtitle">模块类型（改本需求归属模块）</div>`;
    items+=`<div class="mod-grid">`;
    MOD_PICK.forEach(mk=>{
      const MM=modMeta(mk);
      const on=(r.mod||'')===mk;
      items+=`<span class="mod-chip ${on?'cur':''}" style="color:${MM.c};background:${MM.c}14;border-color:${MM.c}55" onclick="pickMod('${mk.replace(/'/g,"\\'")}')"><i>${MM.ic}</i>${MM.s}</span>`;
    });
    items+=`</div>`;
  items+=`<div class="msep"></div>`;
    items+=`<div class="mi danger" onclick="deleteSeg()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>删除任务（${memName(sg.m)}）</div>`;
  }
  // 需求级操作：修改信息 / 删除
  {
    const _r = reqs.find(z=>z.id===menuCtx.reqId);
    if(_r){
      items+=`<div class="msep"></div>`;
      items+=`<div class="mtitle">需求操作</div>`;
      items+=`<div class="mi" style="color:#185fa5;font-weight:600" onclick="hideMenu();openEditReq('${_r.id}')"><i style="background:#2563eb"></i>修改需求信息</div>`;
      items+=`<div class="mi" style="color:#8a6d2f;font-weight:600" onclick="hideMenu();openAddMilestone('${_r.id}')"><i style="background:#d4a017"></i>＋ 新建关键节点</div>`;
      items+=`<div class="mi danger" onclick="hideMenu();deleteReq('${_r.id}')"><i style="background:#b04632"></i>删除需求</div>`;
    }
  }
  menu.innerHTML=items;
  menu.classList.add('show');
  let mx=x, my=y; if(mx>innerWidth-330)mx=innerWidth-330;
  menu.style.left=mx+'px';menu.style.top=my+'px';
  // 测量实际渲染高度，自适应上移避免底部被视口截断
  const mh=menu.offsetHeight;
  if(my+mh>innerHeight-12) my=Math.max(8, innerHeight-mh-12);
  // 菜单比视口还高时：限制 maxHeight + 允许纵向滚动（极端长菜单兜底）
  if(mh>innerHeight-16){ menu.style.maxHeight=(innerHeight-16)+'px'; menu.style.overflowY='auto'; }
  else { menu.style.maxHeight=''; menu.style.overflowY=''; }
  menu.style.top=my+'px';
}
function hideMenu(){menu.classList.remove('show');menu.style.maxHeight='';menu.style.overflowY='';menuCtx=null;memMenuCtx=null;memAdminCtx=null;reqStateCtx=null;}

/* ============ v7.14 人员管理菜单 + 删除人员 ============
   入口：右键「按人看」成员行的左侧名栏（见上方 contextmenu 的 v7.14 分支）。
   命名说明：openMemStatusMenu / memMenuCtx / pickMemStatus 已被「点状态点弹状态菜单」占用，
   故本组统一用 MemberAdmin / memAdminCtx 后缀，避免与既有命名空间冲突。 */
let memAdminCtx=null;

/* 统计某成员的任务牵连面：段数、涉及需求数、以及「删掉这人就会整条空掉」的独占需求。
   独占判定 = 该需求的所有段都属于这个人（删段后 segs 归零，留个空需求行没有意义）。 */
function memSegStats(memId){
  let segs=0; const reqIds=[]; const soloReqs=[];
  reqs.forEach(r=>{
    const all=r.segs||[];
    const mine=all.filter(s=>s.m===memId);
    if(!mine.length) return;
    segs+=mine.length; reqIds.push(r.id);
    if(mine.length===all.length) soloReqs.push(r);
  });
  return {segs, reqCount:reqIds.length, soloReqs};
}

function openMemberAdminMenu(memId,x,y){
  const m=members.find(z=>z.id===memId); if(!m)return;
  memAdminCtx={memId};
  const st=memSegStats(memId);
  const vac=isVacantMem(m);
  const q=s=>String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const mid=q(memId);
  let items=`<div class="mtitle">${escAttr(m.name)} — 人员管理</div>`;
  items+=`<div class="mi" onclick="hideMenu();openEditMember('${mid}')"><i style="background:#2563eb"></i>编辑成员信息</div>`;
  if(!vac){
    const cur=(MSTATUS[m.status||'on']||{}).label||'在岗';
    items+=`<div class="mi" onclick="hideMenu();openMemStatusMenu('${mid}',${Math.round(x)},${Math.round(y)})"><i style="background:#0f9d58;border-radius:50%"></i>切换状态（当前：${cur}）</div>`;
  }
  items+=`<div class="mi" onclick="hideMenu();openAddTaskFor('${mid}')"><i style="background:#7c3aed"></i>给他加任务</div>`;
  /* v7.48 借调操作（上下文相关）：
     · 无生效借调 → 登记外借 / 登记借入（借入是外部人员，此处不提供，走 HR 面板「+登记借入」）
     · 外借中    → 回归原编制 / 提前封存
     · 借入中    → 归还 / 转正式隶属
     · 有历史    → 查看借调记录 */
  const L=curLoan(m);
  const hasHis=(m.loanRecs||[]).length>0;
  if(L && L.dir==='out'){
    items+=`<div class="msep"></div>`;
    items+=`<div class="mi" onclick="hideMenu();openReturnDialog('${mid}')"><i style="background:#16a34a"></i>↩ 回归原编制…<small>转回${escAttr((L.snap&&L.snap.lead&&L.snap.lead!=='—')?L.snap.lead:'原编制')}</small></div>`;
    if(L.state==='active')
      items+=`<div class="mi" onclick="hideMenu();sealLoan('${mid}','manual')"><i style="background:#9aa2ad"></i>🔒 提前封存此记录</div>`;
  }else if(L && L.dir==='in'){
    items+=`<div class="msep"></div>`;
    items+=`<div class="mi" onclick="hideMenu();convertLoanIn('${mid}')"><i style="background:#0f9d58"></i>⇄ 转为正式隶属…</div>`;
    items+=`<div class="mi danger" onclick="hideMenu();returnLoanIn('${mid}')"><i style="background:#d32320"></i>↩ 归还给${escAttr(L.party||'原管线')}</div>`;
  }else{
    items+=`<div class="msep"></div>`;
    items+=`<div class="mi" onclick="hideMenu();openLoanOutDialog('${mid}')"><i style="background:#f08c00"></i>↗ 登记外借…<small>去其他管线支援</small></div>`;
  }
  if(hasHis) items+=`<div class="mi" onclick="hideMenu();openLoanHistory('${mid}')"><i style="background:#646a73"></i>📜 借调记录（${(m.loanRecs||[]).length}）</div>`;
  items+=`<div class="msep"></div>`;
  const cnt = st.segs ? `（${st.segs} 条任务`+(st.soloReqs.length?` · ${st.soloReqs.length} 条独占需求`:'')+`）` : '（无任务）';
  items+=`<div class="mi danger" onclick="hideMenu();deleteMemberAdmin('${mid}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>删除人员${cnt}</div>`;
  menu.innerHTML=items;
  menu.classList.add('show');
  let mx=x,my=y; if(mx>innerWidth-260)mx=innerWidth-260;
  menu.style.left=mx+'px';menu.style.top=my+'px';
  const mh=menu.offsetHeight;
  if(my+mh>innerHeight-12) my=Math.max(8, innerHeight-mh-12);
  menu.style.top=my+'px';
}

/* 删除人员入口。无任务段者直接删；有任务段者弹三选一处理浮层。
   ⚠️ requireWrite() 必须保留 —— 只读模式下不得改数据（历史上为跑测试注掉过，属红线）。 */
function deleteMemberAdmin(memId){
  if(!requireWrite())return;
  const m=members.find(z=>z.id===memId); if(!m){toast('成员不存在或已被删除');return;}
  const st=memSegStats(memId);
  if(st.segs===0){
    if(!confirm(`确定删除成员「${m.name}」吗？\n该成员名下没有任何任务段，删除后可用 Ctrl+Z 撤销。`)) return;
    pushHistory();
    const i=members.findIndex(z=>z.id===memId);
    if(i>=0) members.splice(i,1);
    _logDesc='删除成员「'+m.name+'」（无任务）';
    save();broadcast();rerender();
    toast('已删除 '+m.name);
    return;
  }
  showDelMemberDialog(m, st);
}

/* 有任务在身时的处理浮层：三种方式二选一 —— 改派 / 连带删 / 悬空保留。 */
function showDelMemberDialog(m, st){
  // 可接管人选：在岗、非占位、非本人
  const cands=members.filter(z=>z.id!==m.id && !isVacantMem(z) && !effLeft(z) && !leftLong(z));
  const opts=cands.map(z=>`<option value="${escAttr(z.id)}">${escAttr(z.name)}</option>`).join('');
  const soloTip=st.soloReqs.length
    ? `其中 <b>${st.soloReqs.length}</b> 条需求由他独占（<span style="color:#b04632">${escAttr(st.soloReqs.slice(0,4).map(r=>r.name).join('、'))}${st.soloReqs.length>4?' 等':''}</span>），选「连带删除」时这些需求会整条移除。`
    : '所有涉及的需求都还有其他人的任务段，选「连带删除」只会删掉他自己那些段。';
  const ov=document.createElement('div');
  ov.className='date-pop-mask';
  ov.innerHTML=`<div class="date-pop del-mem" onclick="event.stopPropagation()">
    <div class="dp-h">删除「${escAttr(m.name)}」——他名下还有任务</div>
    <div class="dp-b">
      <div class="dm-stat">共 <b>${st.segs}</b> 条任务段，分布在 <b>${st.reqCount}</b> 条需求上。${soloTip}</div>
      <div class="dm-modes">
        <label class="dm-mode cur"><input type="radio" name="dmMode" value="reassign" checked><div><span class="dm-t">改派给其他人</span><span class="dm-d">保留全部任务段，归属整体转给下面选定的人</span>
          <select class="dm-sel" id="dmTo" ${cands.length?'':'disabled'}>${opts||'<option>（无可接管人员）</option>'}</select></div></label>
        <label class="dm-mode"><input type="radio" name="dmMode" value="purge"><div><span class="dm-t">连带任务一起删</span><span class="dm-d">删掉他的全部任务段；因此空掉的需求整条移除</span></div></label>
        <label class="dm-mode"><input type="radio" name="dmMode" value="orphan"><div><span class="dm-t">仅删人，任务悬空保留</span><span class="dm-d">任务段留在数据里但暂时无归属，之后手工改派</span></div></label>
      </div>
      <div class="dp-tip">所有方式都可用 Ctrl+Z 撤销。</div>
    </div>
    <div class="dp-f">
      <button class="dp-cancel" id="dmCancel">取消</button>
      <button class="dp-ok danger" id="dmOk">确认删除</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  // 只在点遮罩本体时关闭（点内容区已 stopPropagation）
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  ov.querySelector('#dmCancel').onclick=close;
  // 选中态高亮跟随
  ov.querySelectorAll('input[name=dmMode]').forEach(r=>{
    r.onchange=()=>ov.querySelectorAll('.dm-mode').forEach(l=>l.classList.toggle('cur', l.contains(r)&&r.checked));
  });
  ov.querySelector('#dmOk').onclick=()=>{
    const mode=(ov.querySelector('input[name=dmMode]:checked')||{}).value||'reassign';
    if(mode==='reassign' && !cands.length){ toast('没有可接管的人员，请改选其他方式'); return; }
    if(mode==='purge'){
      const extra=st.soloReqs.length?`\n其中 ${st.soloReqs.length} 条独占需求会被整条删除。`:'';
      if(!confirm(`确定连带删除吗？\n将移除「${m.name}」的 ${st.segs} 条任务段。${extra}\n可用 Ctrl+Z 撤销。`)) return;
    }
    const toId=mode==='reassign'?ov.querySelector('#dmTo').value:null;
    close();
    applyDeleteMember(m, st, mode, toId);
  };
}

/* 实际落数据：按 mode 处理任务段，再摘掉成员本身。三种模式共用一次 pushHistory。 */
function applyDeleteMember(m, st, mode, toId){
  if(!requireWrite())return;
  pushHistory();
  let movedSegs=0, killedSegs=0, killedReqs=0, orphaned=0;
  if(mode==='reassign'){
    reqs.forEach(r=>(r.segs||[]).forEach(s=>{ if(s.m===m.id){ s.m=toId; movedSegs++; } }));
  }else if(mode==='purge'){
    for(let i=reqs.length-1;i>=0;i--){
      const r=reqs[i];
      const before=(r.segs||[]).length;
      r.segs=(r.segs||[]).filter(s=>s.m!==m.id);
      killedSegs+=before-r.segs.length;
      if(before>0 && r.segs.length===0){ reqs.splice(i,1); killedReqs++; }
      else if(r.segs.length){ r.end=i2d(Math.max(...r.segs.map(x=>idx(x.e)))); }
    }
    if(typeof relinkLt==='function') relinkLt();
  }else{ // orphan：段留着但去掉归属
    reqs.forEach(r=>(r.segs||[]).forEach(s=>{ if(s.m===m.id){ s.m=null; orphaned++; } }));
  }
  const i=members.findIndex(z=>z.id===m.id);
  if(i>=0) members.splice(i,1);
  // 选中/剪贴板若指向已删对象，清掉避免悬空引用
  if(typeof selectedBar!=='undefined' && selectedBar && !reqs.some(r=>r.id===selectedBar.reqId)) setSelected(null);
  if(mode==='reassign') _logDesc='删除成员「'+m.name+'」，'+movedSegs+' 条任务改派给'+memName(toId);
  else if(mode==='purge') _logDesc='删除成员「'+m.name+'」，连带删除 '+killedSegs+' 条任务段'+(killedReqs?`、${killedReqs} 条需求`:'');
  else _logDesc='删除成员「'+m.name+'」，'+orphaned+' 条任务段转为悬空';
  save();broadcast();rerender();
  if(typeof renderEffTable==='function') renderEffTable();
  toast(mode==='reassign'?`已删除 ${m.name}，${movedSegs} 条任务改派给 ${memName(toId)}`
       :mode==='purge'?`已删除 ${m.name}，清掉 ${killedSegs} 条任务段${killedReqs?`、${killedReqs} 条需求`:''}`
       :`已删除 ${m.name}，${orphaned} 条任务段转为悬空`);
}
/* 删除某条任务段（人的排期）。reqId+seg 定位；删空后若该需求无人则保留空需求行。 */
function removeSeg(reqId, seg){
  if(!requireWrite())return false;
  const r=reqs.find(z=>z.id===reqId); if(!r||seg==null||!r.segs[seg])return false;
  const nm=memName(r.segs[seg].m);
  pushHistory();
  r.segs.splice(seg,1);
  if(r.segs.length) r.end=i2d(Math.max(...r.segs.map(x=>idx(x.e))));
  // 清理可能失效的选中/剪贴板引用
  if(clip&&clip.reqId===reqId){ if(clip.seg===seg){clearClip();} else if(clip.seg>seg){clip.seg--;} }
  setSelected(null);
  _logDesc='删除任务条：'+nm+' · '+r.name;
  save();broadcast();rerender();
  toast('已删除任务：'+nm+' · '+r.name);
  return true;
}
function deleteSeg(){
  if(!menuCtx||menuCtx.seg==null){hideMenu();return;}
  const reqId=menuCtx.reqId, seg=menuCtx.seg;
  hideMenu();
  removeSeg(reqId, seg);
}
function pickStatus(k){
  if(!menuCtx)return;
  if(!requireWrite()){hideMenu();return;}
  const r=reqs.find(z=>z.id===menuCtx.reqId); if(!r){hideMenu();return;}
  pushHistory();
  if(k==='done'){
    // 「已完成」是整条封存语义：无论在哪个视图、点的是整条还是某一个人的段，
    // 都把整条需求标记为完成（所有人段一起 done + 人工置位 reqState=done），
    // 使「按人看」✓徽标 /「按需求看」封存大标 / 所有人段完全联动。
    r.segs.forEach(s=>{s.status='done';s.prog=1;});
    r.state='done';
    _logDesc='把「'+r.name+'」整条标记为已完成（封存）';
  }else{
    if(menuCtx.seg!==null){
      r.segs[menuCtx.seg].status=k;
    }else{
      r.segs.forEach(s=>{s.status=k;});
    }
    // 从已完成态切回其它状态：解除人工完成封存位，避免改了状态仍显示「已完成」。
    if(reqState(r)==='done') delete r.state;
    _logDesc='把「'+r.name+(menuCtx.seg!==null?(' · '+memName(r.segs[menuCtx.seg].m)):'')+'」状态改为'+STATUS[k].label;
  }
  hideMenu();save();broadcast();
  const reqId=r.id;
  rerender();
  flashReq(reqId);
  toast('状态已更新：'+STATUS[k].label);
}
/* 仅把「当前点选的这一个人段」标为已完成，不收尾整条需求。
   用于「这个人的活做完了，但整条还没全部完成」的局部完成场景。
   若此操作恰好让所有段都 done，则整条自然进入派生完成态（reqIsDone 会认）。 */
function pickSegDone(){
  if(!menuCtx||menuCtx.seg==null){hideMenu();return;}
  if(!requireWrite()){hideMenu();return;}
  const r=reqs.find(z=>z.id===menuCtx.reqId); if(!r){hideMenu();return;}
  const sg=r.segs[menuCtx.seg]; if(!sg){hideMenu();return;}
  pushHistory();
  sg.status='done'; sg.prog=1;
  // 不整条置位 reqState；但若这次让全员都 done，解除可能残留的非完成封存冲突由 reqIsDone 派生态接管。
  _logDesc='把「'+r.name+' · '+memName(sg.m)+'」单段标记为已完成（仅本人）';
  hideMenu();save();broadcast();
  const reqId=r.id;
  rerender();
  flashReq(reqId);
  toast(reqIsDone(r)?('全员已完成，「'+r.name+'」整条收尾'):('已完成（仅 '+memName(sg.m)+' 这段）'));
}
function pickInv(v){
  if(!menuCtx||menuCtx.seg==null){hideMenu();return;}
  if(!requireWrite()){hideMenu();return;}
  const r=reqs.find(z=>z.id===menuCtx.reqId); if(!r){hideMenu();return;}
  const sg=r.segs[menuCtx.seg]; if(!sg){hideMenu();return;}
  pushHistory();
  if(v>=1) delete sg.inv;                  // 全人力：不写 inv，走并行自动分摊
  else sg.inv=v;                           // 跟进型：固定投入比
  const tier=INV_TIERS.find(t=>Math.abs(t.val-v)<1e-6);
  _logDesc='把「'+r.name+' · '+memName(sg.m)+'」投入比改为'+(tier?tier.name+' '+v:v);
  hideMenu();save();broadcast();
  const reqId=r.id;
  rerender();
  flashReq(reqId);
  toast('投入比已更新：'+(tier?tier.name:'')+' '+v+'，消化工作量已重算');
}
/* 设置某任务段「时间长度」类型：null=固定起止 / 'front'=前端无限 / 'back'=后端无限 / 'both'=两端无限。
   开无限：缓存原窗口 s/e 以便还原；关无限：优先恢复缓存，无缓存则以今日为起点给 10 工作日默认窗口。 */
function toggleSegOpen(type){
  if(!menuCtx||menuCtx.seg==null){hideMenu();return;}
  if(!requireWrite()){hideMenu();return;}
  const r=reqs.find(z=>z.id===menuCtx.reqId); if(!r){hideMenu();return;}
  const sg=r.segs[menuCtx.seg]; if(!sg){hideMenu();return;}
  const prevType=segOpenType(sg);
  if(prevType===type){ hideMenu(); return; }   // 无变化
  pushHistory();
  if(type==null){
    // 关无限：恢复固定起止
    delete sg.open;
    if(sg._fixS!=null && sg._fixE!=null){ sg.s=i2d(sg._fixS); sg.e=i2d(sg._fixE); }
    else{ const ns=Math.max(0,Math.min(idx(TODAY),DAYS-1)); sg.s=i2d(ns); sg.e=i2d(Math.min(ns+10,DAYS)); }
    delete sg._fixS; delete sg._fixE;
    _logDesc='把「'+r.name+' · '+memName(sg.m)+'」改回固定起止时间';
  }else{
    // 开无限（或切换类型）：若之前是固定则缓存原窗口；若之前是其它无限类型则保留已有缓存
    if(!prevType){ sg._fixS=idx(sg.s); sg._fixE=idx(sg.e); }
    sg.open=type;
    const typeLabel=type==='front'?'前端无限延长':type==='back'?'后端无限延长':'前后无限长度（时间待定）';
    _logDesc='把「'+r.name+' · '+memName(sg.m)+'」改为'+typeLabel;
  }
  r.end=i2d(Math.max(...r.segs.map(x=>idx(x.e))));
  hideMenu();save();broadcast();
  const reqId=r.id;
  rerender();
  flashReq(reqId);
  const curType=segOpenType(sg);
  const msg=curType==='front'?'已改为前端无限延长（起始端无固定边界）':curType==='back'?'已改为后端无限延长（结束端无固定边界）':curType==='both'?'已改为前后无限长度（时间待定）':'已改回固定起止时间';
  toast(msg);
}
/* 修改本需求的模块类型（需求级字段 r.mod）。两视图共享，改后标签/分组/配色随之更新。 */
function pickMod(mk){
  if(!menuCtx){hideMenu();return;}
  if(!requireWrite()){hideMenu();return;}
  const r=reqs.find(z=>z.id===menuCtx.reqId); if(!r){hideMenu();return;}
  if((r.mod||'')===mk){hideMenu();return;}
  pushHistory();
  const old=r.mod||'(空)';
  r.mod=mk;
  _logDesc='把「'+r.name+'」模块类型由'+old+'改为'+mk;
  hideMenu();save();broadcast();
  const reqId=r.id;
  rerender();
  flashReq(reqId);
  toast('模块类型已更新：'+modMeta(mk).s);
}
/* ===== 需求生命周期状态菜单（正常/暂停/废弃） ===== */
let reqStateCtx=null;
function openReqStateMenu(e,reqId){
  if(!requireWrite())return;
  const r=reqs.find(z=>z.id===reqId); if(!r)return;
  reqStateCtx={reqId};
  const cur=reqState(r);
  let items=`<div class="mtitle">${r.name} — 需求状态</div>`;
  RSTATE_PICK.forEach(k=>{
    const s=RSTATE[k];
    const hint = k==='active'?'正常推进':k==='paused'?'暂停（保留统计，仅标记）':k==='done'?'已完成（不计风险，自动归档）':'废弃（不计风险，自动归档）';
    items+=`<div class="mi ${k===cur?'cur':''}" onclick="pickReqState('${k}')"><i style="background:${s.col};border-radius:50%"></i><div style="display:flex;flex-direction:column;line-height:1.25"><span>${s.label}</span><span style="font-size:10px;color:var(--tx3)">${hint}</span></div></div>`;
  });
  menu.innerHTML=items;
  menu.classList.add('show');
  const x=e.clientX,y=e.clientY;
  let mx=x,my=y; if(mx>innerWidth-200)mx=innerWidth-200; if(my>innerHeight-200)my=innerHeight-200;
  menu.style.left=mx+'px';menu.style.top=my+'px';
}
function pickReqState(k){
  if(!reqStateCtx){hideMenu();return;}
  if(!requireWrite()){hideMenu();return;}
  const r=reqs.find(z=>z.id===reqStateCtx.reqId); if(!r){hideMenu();return;}
  hideMenu();
  if(reqState(r)===k)return;
  pushHistory();
  if(k==='active') delete r.state; else r.state=k;
  _logDesc='把需求「'+r.name+'」设为'+RSTATE[k].label;
  save();broadcast();rerender();
  toast('「'+r.name+'」：'+RSTATE[k].label);
}
document.addEventListener('pointerdown',e=>{ if(menu.classList.contains('show') && !e.target.closest('#menu') && !e.target.closest('.bar-task')) hideMenu(); });

/* ============ 成员状态切换（点左侧状态点 → 弹完整状态菜单） ============
   原来是「在岗→忙碌→外出→请假」循环，点不出离职。改为弹菜单：可直接选 在岗/忙碌/请假/外出/已离职/新人。
   选「已离职」时再弹日期选择框，录入具体离职日（决定何时灰化/归档）；改回非离职态则清除离职日。 */
const MSTAT_PICK=['on','busy','leave','out','left','new'];   // 菜单内可选的人员状态
function openMemStatusMenu(memId,x,y){
  const m=members.find(z=>z.id===memId); if(!m)return;
  memMenuCtx={memId};
  const cur=m.status||'on';
  let items=`<div class="mtitle">${m.name} — 设置状态</div>`;
  MSTAT_PICK.forEach(k=>{
    const s=MSTATUS[k];
    items+=`<div class="mi ${k===cur?'cur':''}" onclick="pickMemStatus('${k}')"><i style="background:${s.col};border-radius:50%"></i>${s.label}${k==='left'?' …':''}</div>`;
  });
  menu.innerHTML=items;
  menu.classList.add('show');
  let mx=x,my=y; if(mx>innerWidth-170)mx=innerWidth-170; if(my>innerHeight-260)my=innerHeight-260;
  menu.style.left=mx+'px';menu.style.top=my+'px';
}
let memMenuCtx=null;
function pickMemStatus(k){
  if(!memMenuCtx){hideMenu();return;}
  if(!requireWrite()){hideMenu();return;}
  const m=members.find(z=>z.id===memMenuCtx.memId); if(!m){hideMenu();return;}
  hideMenu();
  if(k==='left'){
    // 离职：弹日期选择，录入具体离职日（留空=今天）
    askLeaveDate(m);
    return;
  }
  pushHistory();
  m.status=k;
  if(k!=='left') delete m.leftAt;     // 改回非离职态：清除离职日，恢复正常显示/统计
  _logDesc=m.name+' 状态改为'+MSTATUS[k].label;
  save();broadcast();rerender();
  renderEffTable();  // 刷新效率档位表（离职/状态变更影响显示）
  toast(m.name+'：'+MSTATUS[k].label);
}
/* 离职日期选择浮层：默认填今天，可改具体日期；确定后写 m.leftAt + status='left' */
function askLeaveDate(m){
  const def=fmtInputDate(m.leftAt||TODAY);
  const ov=document.createElement('div');
  ov.className='date-pop-mask';
  ov.innerHTML=`<div class="date-pop" onclick="event.stopPropagation()">
    <div class="dp-h">设置「${m.name}」离职日期</div>
    <div class="dp-b">
      <input type="date" id="leaveDateInp" value="${def}">
      <div class="dp-tip">离职超过设定阈值将自动折叠进「已归档」区。留空默认今天。</div>
    </div>
    <div class="dp-f">
      <button class="dp-cancel" id="leaveCancel">取消</button>
      <button class="dp-ok" id="leaveOk">确定离职</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener('click',close);
  ov.querySelector('#leaveCancel').onclick=close;
  ov.querySelector('#leaveOk').onclick=()=>{
    const v=ov.querySelector('#leaveDateInp').value;
    const d=v?new Date(v+'T00:00:00'):new Date(TODAY);
    pushHistory();
    m.status='left'; m.leftAt=d;
    _logDesc=m.name+' 设为已离职（'+fmt(d)+'）';
    save();broadcast();rerender();
    renderEffTable();  // 刷新效率档位表（离职自动灰化）
    toast(m.name+'：已离职 · '+fmt(d));
    close();
  };
  setTimeout(()=>{const i=ov.querySelector('#leaveDateInp');if(i)i.focus();},30);
}
/* 把 Date 转成 <input type=date> 需要的 yyyy-mm-dd（本地时区，不用 toISOString 以免 UTC 偏移串日） */
function fmtInputDate(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

/* ================================================================================
   v7.48 支援模块：外借回归 / 借入登记 —— 业务函数
   --------------------------------------------------------------------------------
   全部遵循既有约定：
     · 每个写操作首行 requireWrite()（只读模式拦截）
     · 写前 pushHistory()（Ctrl+Z 可撤）
     · 写前设 _logDesc（变更留痕）
     · 结尾 save();broadcast();rerender();
     · 弹层复用 .date-pop-mask / .date-pop / .dp-h/.dp-b/.dp-f（与 askLeaveDate 同款）
   ================================================================================ */

/* 通用确认/表单浮层（与 askLeaveDate 同构，抽出来给借调各流程复用） */
function _loanPop(title, bodyHTML, okText, onOk, opt){
  const ov=document.createElement('div');
  ov.className='date-pop-mask';
  ov.innerHTML=`<div class="date-pop loan-pop" onclick="event.stopPropagation()">
    <div class="dp-h">${title}</div>
    <div class="dp-b">${bodyHTML}</div>
    <div class="dp-f"><button class="dp-cancel" id="lpCancel">取消</button><button class="dp-ok" id="lpOk">${okText||'确定'}</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener('click',close);
  ov.querySelector('#lpCancel').onclick=close;
  const okBtn=ov.querySelector('#lpOk');
  if((opt||{}).danger) okBtn.classList.add('danger');
  okBtn.onclick=()=>{ if(onOk(ov)!==false) close(); };
  setTimeout(()=>{const f=ov.querySelector('[data-autofocus]');if(f&&f.focus)f.focus();},30);
  return ov;
}
/* 读 <input type=date> 的值 → Date（空则 null），本地时区构造避免串日 */
function _dateOrNull(v){ return v ? new Date(v+'T00:00:00') : null; }
/* 借调记录一句话摘要（列表/弹层共用） */
function loanSummary(L){
  if(!L) return '';
  const dir=L.dir==='in'?'↙ 借入自':'↗ 外借去';
  const span=(L.from?fmt(L.from):'?')+' → '+(L.to?fmt(L.to):'长期未定');
  const st=L.state==='active'?'进行中':L.state==='sealed'?'已封存':'已结束';
  return `${dir} ${escAttr(L.party||'未填')} · ${span} · ${st}`;
}
const LOAN_END_TXT={return:'回归/归还',convert:'转正式隶属','seal:auto':'到期自动封存','seal:manual':'手动封存'};

/* ---------- ① 登记外借（本队人借出去） ---------- */
function openLoanOutDialog(memId){
  if(!requireWrite())return;
  const m=members.find(z=>z.id===memId); if(!m)return;
  if(curLoan(m)){ toast('该成员已有生效中的借调记录，请先结束它'); openLoanHistory(memId); return; }
  const body=`
    <div class="ctx">把 <b>${escAttr(m.name)}</b> 登记为<b>外借支援</b>：编制保留在本团队，实际去其他管线支援。
      登记时会自动<b>拍下当前编制快照</b>（编制/隶属/模块/品级/管线），供日后「回归原编制」一键还原。</div>
    <div class="fld"><label>去哪个管线 / 对方单位</label><input type="text" id="lnParty" data-autofocus value="${escAttr(m.mod||'')}" placeholder="如：武器特效"></div>
    <div class="row2">
      <div class="fld"><label>起始日</label><input type="date" id="lnFrom" value="${fmtInputDate(TODAY)}"></div>
      <div class="fld"><label>约定结束日（留空=长期未定）</label><input type="date" id="lnTo" value=""></div>
    </div>
    <div class="fld"><label>备注</label><input type="text" id="lnNote" placeholder="选填，如：支援到版本上线"></div>
    <div class="dp-tip">登记后该成员将脱离角色线（隶属置为「—」），在「按人看」里归入<b>外借支援</b>分组，不计入角色线在岗人力。</div>
    <div class="warn" id="lnWarn"></div>`;
  _loanPop(`↗ 登记外借 · ${escAttr(m.name)}`, body, '确认登记', ov=>{
    const party=(ov.querySelector('#lnParty').value||'').trim();
    if(!party){ const w=ov.querySelector('#lnWarn'); w.textContent='请填写去哪个管线'; w.classList.add('show'); return false; }
    const from=_dateOrNull(ov.querySelector('#lnFrom').value);
    const to=_dateOrNull(ov.querySelector('#lnTo').value);
    if(from&&to&&to<from){ const w=ov.querySelector('#lnWarn'); w.textContent='结束日不能早于起始日'; w.classList.add('show'); return false; }
    pushHistory();
    if(!Array.isArray(m.loanRecs)) m.loanRecs=[];
    /* 拍快照：记录外借「之前」的编制状态，回归时用它还原 */
    m.loan={ id:newLoanId(), dir:'out', party, from, to,
      mod:(m.mod||''), note:(ov.querySelector('#lnNote').value||'').trim(),
      snap:{corp:(m.corp||'base'), lead:(m.lead&&m.lead!=='—'&&m.lead!=='-')?m.lead:'—',
            mod:(m.mod||''), grade:(m.grade||''), line:(m.line||'-')},
      state:'active', endAt:null, endBy:null };
    m.lead='—';            // 脱离角色线
    m.support=true;        // 兼容旧判定（isExtLoan 现已优先读 m.loan，此行为冗余保险）
    m.mod=party;
    _logDesc='登记外借：'+m.name+' → '+party+(to?'（至 '+fmt(to)+'）':'（长期）');
    save();broadcast();rerender();
    toast(`${m.name} 已登记外借 → ${party}`);
  });
}

/* ---------- ② 外借回归（转回原编制） ---------- */
function openReturnDialog(memId){
  if(!requireWrite())return;
  const m=members.find(z=>z.id===memId); if(!m)return;
  const L=curLoan(m);
  if(!L || L.dir!=='out'){ toast('该成员没有生效中的外借记录'); return; }
  const s=L.snap||{};
  const sLead=(s.lead&&s.lead!=='—'&&s.lead!=='-')?s.lead:'';
  const sealed=L.state==='sealed';
  const body=`
    <div class="ctx">把 <b>${escAttr(m.name)}</b> 从「${escAttr(L.party||'外借')}」<b>转回原编制</b>。
      下面已按<b>外借前快照</b>预填，可直接改；改完即生效，本次外借记录自动归档进历史（可随时查看）。</div>
    ${sealed?'<div class="dp-tip">该记录已封存，回归不受影响。</div>':''}
    <div class="row2">
      <div class="fld"><label>编制</label><select id="rtCorp">
        <option value="base" ${(s.corp||'base')==='base'?'selected':''}>基地</option>
        <option value="sub"  ${s.corp==='sub'?'selected':''}>子公司</option>
        <option value="reg"  ${s.corp==='reg'?'selected':''}>正编（带队）</option></select></div>
      <div class="fld"><label>隶属带队</label><select id="rtLead">${regLeaderOpts(sLead||'—')}</select></div>
    </div>
    <div class="row2">
      <div class="fld"><label>模块</label><select id="rtMod">${MOD_OPTS_LIST.map(o=>`<option value="${o}" ${(s.mod||'')===o?'selected':''}>${o}</option>`).join('')}</select></div>
      <div class="fld"><label>品级</label><select id="rtGrade">${GRADE_OPTS_LIST.map(o=>`<option value="${o}" ${(s.grade||'')===o?'selected':''}>${o||'（未设）'}</option>`).join('')}</select></div>
    </div>
    <div class="dp-tip">历史记录：<b>${loanSummary(L)}</b></div>
    <div class="warn" id="rtWarn"></div>`;
  _loanPop(`↩ 回归原编制 · ${escAttr(m.name)}`, body, '确认回归', ov=>{
    const corp=ov.querySelector('#rtCorp').value;
    const lead=ov.querySelector('#rtLead').value||'—';
    pushHistory();
    m.corp=corp;
    m.lead=lead;
    m.mod=ov.querySelector('#rtMod').value;
    m.grade=ov.querySelector('#rtGrade').value;
    m.line=(s.line&&s.line!=='-')?s.line:'-';
    delete m.support;                 // 回归后不再是支援性质（跨队支援由 isSupportInReq 动态判定）
    /* 归档：记录进历史，当前借调清空 —— loanRecs 只增不改 */
    L.state='ended'; L.endBy='return'; L.endAt=new Date(TODAY);
    if(!Array.isArray(m.loanRecs)) m.loanRecs=[];
    m.loanRecs.push(L);
    m.loan=null;
    _logDesc='外借回归：'+m.name+' 转回'+(corp==='reg'?'正编':corp==='sub'?'子公司':'基地')+'·隶属'+lead;
    save();broadcast();rerender();
    toast(`${m.name} 已回归原编制`);
  });
}

/* ---------- ③ 封存外借记录（手动提前 / 自动到期走 scanLoanExpiry） ---------- */
function sealLoan(memId, by){
  if(!requireWrite())return;
  const m=members.find(z=>z.id===memId); if(!m)return;
  const L=m && m.loan;
  if(!L || L.dir!=='out'){ toast('该成员没有可封存的外借记录'); return; }
  if(L.state!=='active'){ toast('该记录已是'+(L.state==='sealed'?'封存':'结束')+'状态'); return; }
  if(by==='manual'){
    _loanPop(`🔒 提前封存外借记录 · ${escAttr(m.name)}`,
      `<div class="ctx">把这条外借记录标记为<b>已封存</b>：<br>
        · 记录归档，不再计入「活跃外借」（在编统计里不再算作外借中）<br>
        · <b>人仍在外借</b>，编制与隶属<b>一律不动</b>；人回来时走「回归原编制」即可<br>
        · 到约定结束日时系统也会自动封存，此处为提前手动封存</div>
       <div class="dp-tip">当前记录：${loanSummary(L)}</div>`,
      '确认封存', ()=>{
        pushHistory();
        L.state='sealed'; L.endBy='seal:manual'; L.endAt=new Date(TODAY);
        _logDesc='手动封存外借记录：'+m.name+' → '+(L.party||'');
        save();broadcast();rerender();
        toast(`已封存 ${m.name} 的外借记录`);
      }, {danger:true});
    return;
  }
  pushHistory();
  L.state='sealed'; L.endBy=by||'seal:manual'; L.endAt=new Date(TODAY);
  _logDesc='封存外借记录：'+m.name;
  save();broadcast();rerender();
}

/* ---------- ④ 登记借入（其他管线的人来本队支援，临时隶属） ---------- */
function openLoanInDialog(){
  if(!requireWrite())return;
  const body=`
    <div class="ctx">登记一位<b>从其他管线借来支援</b>的人员：他会作为<b>临时隶属</b>成员进入名单
      （编制=基地、可参与排期与负载计算），并挂一条「借入」记录。之后可<b>归还</b>或<b>转为正式隶属</b>。</div>
    <div class="row2">
      <div class="fld"><label>姓名</label><input type="text" id="liName" data-autofocus placeholder="如：张三"></div>
      <div class="fld"><label>来自哪个管线</label><input type="text" id="liParty" placeholder="如：场景特效"></div>
    </div>
    <div class="row2">
      <div class="fld"><label>起始日</label><input type="date" id="liFrom" value="${fmtInputDate(TODAY)}"></div>
      <div class="fld"><label>约定结束日（留空=长期未定）</label><input type="date" id="liTo" value=""></div>
    </div>
    <div class="row2">
      <div class="fld"><label>临时隶属带队</label><select id="liLead">${regLeaderOpts('—')}</select></div>
      <div class="fld"><label>模块</label><select id="liMod">${MOD_OPTS_LIST.map(o=>`<option value="${o}">${o}</option>`).join('')}</select></div>
    </div>
    <div class="row2">
      <div class="fld"><label>品级</label><select id="liGrade">${GRADE_OPTS_LIST.map(o=>`<option value="${o}">${o||'（未设）'}</option>`).join('')}</select></div>
      <div class="fld"><label>效率系数</label><input type="number" id="liEff" value="1" step="0.05" min="0"></div>
    </div>
    <div class="warn" id="liWarn"></div>`;
  _loanPop('↙ 登记借入支援人员', body, '确认登记', ov=>{
    const name=(ov.querySelector('#liName').value||'').trim();
    const party=(ov.querySelector('#liParty').value||'').trim();
    const warn=ov.querySelector('#liWarn');
    if(!name){ warn.textContent='请填写姓名'; warn.classList.add('show'); return false; }
    if(members.some(x=>x.name===name)){ warn.textContent='已存在同名成员，请用其它名称'; warn.classList.add('show'); return false; }
    if(!party){ warn.textContent='请填写来自哪个管线'; warn.classList.add('show'); return false; }
    const from=_dateOrNull(ov.querySelector('#liFrom').value);
    const to=_dateOrNull(ov.querySelector('#liTo').value);
    if(from&&to&&to<from){ warn.textContent='结束日不能早于起始日'; warn.classList.add('show'); return false; }
    pushHistory();
    const lead=ov.querySelector('#liLead').value||'—';
    const nm={
      id:genId('m_'), name, role:'基地·借入支援', corp:'base', lead,
      mod:ov.querySelector('#liMod').value, grade:ov.querySelector('#liGrade').value,
      line:'-', eff:(parseFloat(ov.querySelector('#liEff').value)||1), status:'on',
      support:true, tmp:true,
      loan:{ id:newLoanId(), dir:'in', party, from, to,
             mod:ov.querySelector('#liMod').value, note:'',
             snap:null, state:'active', endAt:null, endBy:null },
      loanRecs:[],
    };
    members.push(nm);
    _logDesc='登记借入支援：'+name+'（来自 '+party+'）';
    save();broadcast();rerender();
    toast(`已登记借入：${name} ← ${party}`);
  });
}

/* ---------- ⑤ 借入归还 ---------- */
function returnLoanIn(memId){
  if(!requireWrite())return;
  const m=members.find(z=>z.id===memId); if(!m)return;
  const L=curLoan(m);
  if(!L || L.dir!=='in'){ toast('该成员没有生效中的借入记录'); return; }
  _loanPop(`↩ 归还借入人员 · ${escAttr(m.name)}`,
    `<div class="ctx">把 <b>${escAttr(m.name)}</b> 归还给「${escAttr(L.party||'对方管线')}」。<br>
      归还后他将<b>移出在岗名单</b>（按已离职口径灰化/归档），但借入记录会<b>完整保留</b>在历史里，随时可查。</div>
     <div class="dp-tip">当前记录：${loanSummary(L)}</div>`,
    '确认归还', ()=>{
      pushHistory();
      L.state='ended'; L.endBy='return'; L.endAt=new Date(TODAY);
      if(!Array.isArray(m.loanRecs)) m.loanRecs=[];
      m.loanRecs.push(L);
      m.loan=null;
      m.status='left'; m.leftAt=new Date(TODAY);   // 等效离场（保留 loanRecs 留痕）
      delete m.support;
      _logDesc='归还借入人员：'+m.name+' → '+(L.party||'');
      save();broadcast();rerender();
      if(typeof renderEffTable==='function') renderEffTable();
      toast(`已归还 ${m.name}`);
    }, {danger:true});
}

/* ---------- ⑥ 借入转正式隶属 ---------- */
function convertLoanIn(memId){
  if(!requireWrite())return;
  const m=members.find(z=>z.id===memId); if(!m)return;
  const L=curLoan(m);
  if(!L || L.dir!=='in'){ toast('该成员没有生效中的借入记录'); return; }
  const body=`
    <div class="ctx">把 <b>${escAttr(m.name)}</b>（借入自「${escAttr(L.party||'')}」）<b>转为正式隶属</b>。
      转正后他变成本队常规成员，「借入」徽标消失，借入记录归档进历史。</div>
    <div class="row2">
      <div class="fld"><label>编制</label><select id="cvCorp">
        <option value="base" selected>基地</option>
        <option value="sub">子公司</option>
        <option value="reg">正编（带队）</option></select></div>
      <div class="fld"><label>隶属带队</label><select id="cvLead">${regLeaderOpts((m.lead&&m.lead!=='—'&&m.lead!=='-')?m.lead:'—')}</select></div>
    </div>
    <div class="fld"><label>模块</label><select id="cvMod">${MOD_OPTS_LIST.map(o=>`<option value="${o}" ${m.mod===o?'selected':''}>${o}</option>`).join('')}</select></div>
    <div class="dp-tip">当前记录：${loanSummary(L)}</div>`;
  _loanPop(`⇄ 转为正式隶属 · ${escAttr(m.name)}`, body, '确认转正', ov=>{
    pushHistory();
    const corp=ov.querySelector('#cvCorp').value;
    m.corp=corp;
    m.lead=ov.querySelector('#cvLead').value||'—';
    m.mod=ov.querySelector('#cvMod').value;
    delete m.tmp;          // 不再是临时
    delete m.support;      // 不再是支援性质
    m.role=(corp==='reg'?'正编·带队':corp==='sub'?'子公司':'基地');
    L.state='ended'; L.endBy='convert'; L.endAt=new Date(TODAY);
    if(!Array.isArray(m.loanRecs)) m.loanRecs=[];
    m.loanRecs.push(L);
    m.loan=null;
    _logDesc='借入转正式隶属：'+m.name+' → '+(corp==='reg'?'正编':corp==='sub'?'子公司':'基地');
    save();broadcast();rerender();
    toast(`${m.name} 已转为正式隶属`);
  });
}

/* HR 面板的「＋登记外借」没有成员上下文 → 先选人再进登记弹层。
   候选：在岗、非占位、当前无生效借调的成员。 */
function openLoanOutPick(){
  if(!requireWrite())return;
  const cands=members.filter(m=>!effLeft(m) && !isVacantMem(m) && !curLoan(m));
  if(!cands.length){ toast('没有可登记外借的成员（都有生效中的借调记录）'); return; }
  const opts=cands.map(m=>`<option value="${escAttr(m.id)}">${escAttr(m.name)}${m.mod?'（'+escAttr(m.mod)+'）':''}</option>`).join('');
  _loanPop('↗ 登记外借 · 选择成员',
    `<div class="ctx">选择要登记外借的成员，下一步填写去哪个管线与起止日期。</div>
     <div class="fld"><label>成员</label><select id="lpMem" data-autofocus>${opts}</select></div>`,
    '下一步', ov=>{
      const id=ov.querySelector('#lpMem').value;
      setTimeout(()=>openLoanOutDialog(id),60);   // 等本层关闭后再开下一层
    });
}

/* ---------- ⑦ 查看借调历史 ---------- */
function openLoanHistory(memId){
  const m=members.find(z=>z.id===memId); if(!m)return;
  const recs=(m.loanRecs||[]).slice().concat(m.loan?[m.loan]:[]);
  const rows=recs.length ? recs.slice().reverse().map(L=>{
    const stCls=L.state==='active'?'on':L.state==='sealed'?'seal':'end';
    const stTxt=L.state==='active'?'进行中':L.state==='sealed'?'已封存':'已结束';
    const endTxt=L.endBy?('　·　'+(LOAN_END_TXT[L.endBy]||L.endBy)+(L.endAt?' '+fmt(L.endAt):'')):'';
    return `<div class="loan-rec ${stCls}">
      <div class="lr-t">${L.dir==='in'?'↙ 借入自':'↗ 外借去'} <b>${escAttr(L.party||'未填')}</b>
        <span class="lr-st">${stTxt}</span></div>
      <div class="lr-d">${L.from?fmt(L.from):'起始未填'} → ${L.to?fmt(L.to):'长期未定'}${endTxt}</div>
      ${L.note?`<div class="lr-n">${escAttr(L.note)}</div>`:''}
      ${L.migrated?'<div class="lr-n lr-mig">由历史标记自动迁移</div>':''}
    </div>`;
  }).join('') : '<div class="dp-tip">暂无外借 / 借入记录。</div>';
  _loanPop(`📜 借调记录 · ${escAttr(m.name)}`, `<div class="loan-recs">${rows}</div>`, '关闭', ()=>{}, {});
  /* 历史弹层的「确定」按钮当关闭用：改成取消文案，避免误以为是写操作 */
  const ok=document.querySelector('.loan-pop #lpOk'); if(ok) ok.textContent='关闭';
}
grid.addEventListener('click',e=>{
  const ms=e.target.closest('.mstat');
  if(ms){
    if(!requireWrite())return;
    const rect=ms.getBoundingClientRect();
    openMemStatusMenu(ms.dataset.mem, rect.left, rect.bottom+4);
    return;
  }
  // 「按人看」：点击该人整行的任意空白处（信息栏或时间线空白）→ 选中整行作为粘贴改派目标
  if(view==='person'){
    // 避开栏内/条上的交互控件（按钮 / 可编辑标签 / 状态点 / 加任务 / 任务条 / 分割线 / 链接 / 输入），其余空白区均可选中
    if(!e.target.closest('button,.editable,.mstat,.inl-add,a,input,select,.bar-task,.ph-div,.grip')){
      const row=e.target.closest('.row[data-mem]'); if(!row)return;
      const mid=row.dataset.mem;
      if(selectedMem===mid){ setSelectedMem(null); }   // 再次点击取消选中
      else { setSelected(null); setSelectedMem(mid); }  // 选中人员行，取消任务条选中
    }
  }
});

function flashReq(reqId){
  document.querySelectorAll(`.bar-task[data-req="${reqId}"]`).forEach(b=>{
    b.classList.remove('flash');void b.offsetWidth;b.classList.add('flash');
  });
}
function flashReqRow(reqId){
  const row=document.querySelector(`.req-row[data-req-row="${reqId}"]`);
  if(row){row.style.transition='background .2s';row.style.background='#fff7e6';setTimeout(()=>row.style.background='',650);}
}
/* 新建成员/需求后：把视图中心拉到它身上并高亮，表示创建成功。
   kind:'mem'|'req'，id 为实体 id。会自动展开它所在的折叠分组、滚动居中、整行脉冲高亮。 */
function revealEntity(kind, id){
  const sel = kind==='mem' ? `.row[data-mem="${id}"]` : `.req-row[data-req-row="${id}"]`;
  // 若目标落在被折叠的分组里，先展开该分组再渲染，确保 DOM 中存在该行
  const gkey = (()=>{ try{
    if(kind==='mem'){ const m=members.find(x=>x.id===id); const g=m&&personGroupKey(m); return g?g.key:null; }
    const r=reqs.find(x=>x.id===id); const g=r&&reqGroupKey(r); return g?g.key:null;
  }catch(_){return null;} })();
  if(gkey && collapsed[gkey]){ collapsed[gkey]=false; try{localStorage.setItem('gantt_collapsed',JSON.stringify(collapsed));}catch(_){ } rerender(); }
  // 渲染后再定位（rerender 同步重建 DOM）
  requestAnimationFrame(()=>{
    const row=document.querySelector(sel);
    if(!row){ return; }
    try{ row.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'}); }catch(_){ row.scrollIntoView(); }
    row.classList.remove('just-new'); void row.offsetWidth; row.classList.add('just-new');
    setTimeout(()=>row.classList.remove('just-new'),2700);
  });
}

/* ============ 任务条选中（复制/剪切/粘贴的目标） ============ */
let selectedBar=null;          // {reqId, seg|null}
function setSelected(bar){
  document.querySelectorAll('.bar-task.sel').forEach(b=>b.classList.remove('sel'));
  if(!bar){selectedBar=null;return;}
  setSelectedMem(null);        // 选中任务条时取消人员行选中（两种粘贴目标互斥）
  bar.classList.add('sel');
  const seg=(bar.dataset.seg!==undefined && bar.dataset.seg!=='')?+bar.dataset.seg:null;
  selectedBar={reqId:bar.dataset.req, seg};
  if(typeof applyMsHighlight==='function') applyMsHighlight();   // v7.45：选中需求条 → 联动高亮其关键节点与虚线
}
function reapplySelection(){
  if(selectedMem){
    const mr=document.querySelector(`.row[data-mem="${selectedMem}"]`);
    if(mr)mr.classList.add('row-sel');
  }
  if(!selectedBar)return;
  const sel = selectedBar.seg!==null
    ? `.bar-task[data-req="${selectedBar.reqId}"][data-seg="${selectedBar.seg}"]`
    : `.bar-task.req-bar[data-req="${selectedBar.reqId}"]`;
  const b=document.querySelector(sel); if(b)b.classList.add('sel');
  if(clip&&clip.mode==='cut')markCut();
  // v7.45：重渲染后恢复关键节点联动高亮（DOM 已重建，需强制重算）
  _msHoverReq=null; _msApplied='__none__'; if(typeof applyMsHighlight==='function') applyMsHighlight();
}
/* ===== v7.45：需求条 ↔ 关键节点/竖虚线 联动高亮 =====
   hover（瞬时）与 选中（持久，selectedBar）两路汇聚到 applyMsHighlight。
   高亮对象：该需求的任务条(.req-glow 脉冲动画) + 其关键节点(.ms-node 汇总/.ms-mark 条内) + 竖虚线(.ms-link)。 */
let _msHoverReq=null, _msApplied='__none__';
function applyMsHighlight(){
  const id=_msHoverReq || (selectedBar&&selectedBar.reqId) || null;
  if(id===_msApplied) return;
  _msApplied=id||'__none__';
  document.querySelectorAll('.ms-active').forEach(el=>el.classList.remove('ms-active'));
  document.querySelectorAll('.req-glow').forEach(el=>el.classList.remove('req-glow'));
  if(!id) return;
  document.querySelectorAll(`.ms-node[data-req="${id}"],.ms-mark[data-req="${id}"],.ms-link[data-req="${id}"]`).forEach(el=>el.classList.add('ms-active'));
  document.querySelectorAll(`.bar-task.req-bar[data-req="${id}"]`).forEach(el=>el.classList.add('req-glow'));
}
grid.addEventListener('pointerover',e=>{
  const el=e.target.closest&&e.target.closest('.bar-task.req-bar,.ms-node,.ms-mark');
  const prev=_msHoverReq;
  _msHoverReq = el ? (el.dataset.req||null) : null;
  applyMsHighlight();
  // v7.47：出框标签层跟随高亮。放在 applyMsHighlight 之外 —— 那个函数有
  // 「id 未变则 early-return」的短路，高亮从 A 切回 null 时它仍会走完（id 变了），
  // 但 null→null 的重复 pointerover 不会重绘；此处统一兜底，保证标签态与高亮态一致。
  if(prev!==_msHoverReq && typeof syncMsBarLabels==='function') syncMsBarLabels();
});
/* ============ v7.40 日期悬停提示（v7.47 简化：去掉单击钉选） ============
   v7.47 变更：
     · 移除「单击钉选某天」—— 钉选列与 📍 胶囊被判定为干扰信息（强色带 + 紫色描边 +
       吸顶胶囊过于抢眼），且它在纵向滚动时一直悬在顶部，与「顶部冻结信息行」争夺注意力。
     · 悬停保留，但降为极轻微提示：细淡色带 + 跟随光标的日期胶囊（不再吸顶、不抢层级）。
   坐标：内容 x = 天索引×DAY_W，时间轴可视区自 --left-w 起、随 #scroll 横向滚动；
        故 day = floor((clientX - scrollRect.left - leftW + scrollLeft)/DAY_W)。 */
const _WD=['日','一','二','三','四','五','六'];
function dayLabel(d){ const dt=i2d(d); return fmt(dt)+' 周'+_WD[dt.getDay()]; }
function clientXToDay(clientX){
  const sc=document.getElementById('scroll'); if(!sc) return null;
  const lw=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))||340;
  const rect=sc.getBoundingClientRect();
  const x=clientX-rect.left-lw+sc.scrollLeft;
  if(x<0) return null;
  const d=Math.floor(x/DAY_W);
  return (d>=0&&d<DAYS)?d:null;
}
/* v7.47：钉选已移除，此函数降级为「清理历史 DOM/状态」+ 保留 hover 带的重绘入口。
   保留函数本身是因为 paint() 与其它地方仍有调用，直接删会抛 ReferenceError。 */
function applyDateSel(){
  const pin=document.getElementById('dateSelPin'); if(pin) pin.style.display='none';
  const pill=document.getElementById('dateSelPinPill'); if(pill) pill.style.display='none';
}
/* 悬停提示：竖带对准该天（内容坐标），日期胶囊跟随鼠标光标（视口坐标）。
   胶囊跟随光标而非吸顶 —— 既不会在纵向滚动时一直悬在顶部跟冻结信息行抢位，
   也更符合「指针在哪、信息在哪」的直觉。 */
function showHover(d,clientX,clientY){
  const h=document.getElementById('dateSelHover'); const pill=document.getElementById('dateSelHoverPill');
  if(h){ h.style.display='block'; h.style.left=(d*DAY_W)+'px'; h.style.width=DAY_W+'px'; }
  if(!pill) return;
  pill.textContent=dayLabel(d); pill.style.display='block';
  // 胶囊挂在 .sel-pill-layer（#grid 内静态定位层）下，用视口坐标时需换算成 #grid 内容坐标
  const grid=document.getElementById('grid');
  if(!grid) return;
  const gr=grid.getBoundingClientRect();
  let x=clientX-gr.left+14, y=clientY-gr.top+16;   // 光标右下偏移，避免压住指针
  const pw=pill.offsetWidth, ph=pill.offsetHeight;
  // 右/下越界时翻到光标另一侧，保证完整可见
  if(x+pw>gr.width) x=clientX-gr.left-pw-14;
  if(y+ph>gr.height) y=clientY-gr.top-ph-14;
  pill.style.transform='none';
  pill.style.left=Math.max(0,x)+'px';
  pill.style.top=y+'px';
}
function hideHover(){ const h=document.getElementById('dateSelHover'); const p=document.getElementById('dateSelHoverPill'); if(h) h.style.display='none'; if(p) p.style.display='none'; }
function bindDaySelect(){
  if(window.__daySelBound) return; window.__daySelBound=true;
  const grid=document.getElementById('grid'); if(!grid) return;
  grid.addEventListener('pointermove',e=>{
    if(drag||(typeof chipDrag!=='undefined'&&chipDrag)){ hideHover(); return; } // 拖拽中不打扰
    const d=clientXToDay(e.clientX);
    if(d==null){ hideHover(); return; }
    showHover(d,e.clientX,e.clientY);
  });
  grid.addEventListener('pointerleave',hideHover);
  // v7.47：click 钉选分支已整体移除（连同 selDay 状态），点击日期列不再产生任何持久选中。
}
/* ============ 人员行选中（「按人看」粘贴改派目标） ============
   点击某人的信息栏 → 选中整行；之后 Ctrl+V / 粘贴 会把剪贴板里的任务段「改派」给这个人。 */
let selectedMem=null;          // 选中的成员 id（仅按人看有意义）
function setSelectedMem(id){
  document.querySelectorAll('.row.row-sel').forEach(r=>r.classList.remove('row-sel'));
  if(!id){selectedMem=null;return;}
  selectedMem=id;
  const mr=document.querySelector(`.row[data-mem="${id}"]`);
  if(mr)mr.classList.add('row-sel');
}

/* ============ 复制 / 剪切 / 粘贴 ============ */
let clip=null;                 // {mode:'copy'|'cut', reqId, seg|null, payload}
function segPayload(r,si){
  const s=r.segs[si];
  return {m:s.m, s:idx(s.s), e:idx(s.e), prog:s.prog, status:s.status, support:!!s.support, open:segOpenType(s)||false, inv:(s.inv!=null?s.inv:null), span:idx(s.e)-idx(s.s)};
}
function doCopy(cut){
  if(!selectedBar){toast('请先点选一个任务条');return;}
  const r=reqs.find(x=>x.id===selectedBar.reqId); if(!r)return;
  if(selectedBar.seg===null){toast('请选中某个人的任务段（按人看里更精确）');return;}
  clip={mode:cut?'cut':'copy', reqId:r.id, seg:selectedBar.seg, payload:segPayload(r,selectedBar.seg)};
  if(cut)markCut(); else clearCutMark();
  showClip();
  toast(cut?'已剪切：'+memName(clip.payload.m)+' 的任务段':'已复制：'+memName(clip.payload.m)+' 的任务段');
}
function markCut(){
  clearCutMark();
  if(!clip||clip.mode!=='cut')return;
  const b=document.querySelector(`.bar-task[data-req="${clip.reqId}"][data-seg="${clip.seg}"]`);
  if(b)b.classList.add('cut-mark');
}
function clearCutMark(){document.querySelectorAll('.bar-task.cut-mark').forEach(b=>b.classList.remove('cut-mark'));}
function doPaste(){
  if(!requireWrite())return;
  if(!clip){toast('剪贴板为空');return;}
  // 模式一（按人看）：选中了人员行 → 把任务段「改派」给该人，保留来源需求与工期
  if(selectedMem){
    const dst=reqs.find(x=>x.id===clip.reqId); if(!dst){toast('来源需求不存在');return;}
    const src=dst;
    pushHistory();
    const p=clip.payload;
    // 保持原工期位置，仅替换负责人
    const isCut=clip.mode==='cut';  // 剪切=搬移同一段工作(保留进度)；复制=派一份新活(进度归零、未开始)
    const newSeg={m:selectedMem, s:i2d(p.s), e:i2d(Math.min(p.e,DAYS)), prog:isCut?p.prog:0, status:isCut?p.status:'todo'};
    if(p.inv!=null) newSeg.inv=p.inv;
    const mem=memById(selectedMem), rl=reqLeadOf(dst), ml=leadOf(mem);
    if(rl&&ml&&ml!==rl) newSeg.support=true;
    dst.segs.push(newSeg);
    dst.end=i2d(Math.max(...dst.segs.map(x=>idx(x.e))));
    if(clip.mode==='cut' && src){
      src.segs.splice(clip.seg,1);
      if(src.segs.length) src.end=i2d(Math.max(...src.segs.map(x=>idx(x.e))));
      clip=null; clearCutMark(); hideClip();
    }
    save();broadcast();rerender();
    toast(`已粘贴「${dst.name}」→ ${memName(selectedMem)}`);
    return;
  }
  if(!selectedBar){toast('请先点选目标：人员信息栏（改派给某人）或需求条');return;}
  const dst=reqs.find(x=>x.id===selectedBar.reqId); if(!dst)return;
  const src=reqs.find(x=>x.id===clip.reqId);
  pushHistory();
  const p=clip.payload;
  // 落点：保持原工期长度，对齐到目标需求的起始日
  const dstStart=Math.min(...dst.segs.map(s=>idx(s.s)));
  let ns=dstStart, ne=Math.min(dstStart+p.span, DAYS);
  const isCut2=clip.mode==='cut';  // 剪切=搬移同一段工作(保留进度)；复制=派一份新活(进度归零、未开始)
  const newSeg={m:p.m, s:i2d(ns), e:i2d(ne), prog:isCut2?p.prog:0, status:isCut2?p.status:'todo'};
  if(p.inv!=null) newSeg.inv=p.inv;
  // 跨队支援判定：粘到的需求带队归属 ≠ 此人隶属 → 标记支援
  const mem=memById(p.m), rl=reqLeadOf(dst), ml=leadOf(mem);
  if(p.support || (rl&&ml&&ml!==rl)) newSeg.support=true;
  dst.segs.push(newSeg);
  dst.end=i2d(Math.max(...dst.segs.map(x=>idx(x.e))));
  if(clip.mode==='cut' && src){
    src.segs.splice(clip.seg,1);
    if(src.segs.length) src.end=i2d(Math.max(...src.segs.map(x=>idx(x.e))));
    clip=null; clearCutMark(); hideClip();
  }
  save();broadcast();rerender();
  flashReqRow(dst.id);
  toast(`已粘贴 ${memName(p.m)} → ${dst.name}`);
}
function showClip(){
  let el=document.getElementById('clipchip');
  if(!el){el=document.createElement('div');el.id='clipchip';document.body.appendChild(el);}
  const p=clip.payload, srcR=reqs.find(x=>x.id===clip.reqId);
  el.innerHTML=`<span class="ck ${clip.mode==='cut'?'cut':''}">${clip.mode==='cut'?'剪切':'复制'}</span>
    <span>${memName(p.m)} · ${srcR?srcR.name:''}（${workdays(i2d(p.s),i2d(p.e))}工作日）</span>
    <button onclick="doPaste()">粘贴到选中目标 (Ctrl+V)</button>
    <button onclick="clearClip()">清空</button>`;
  el.classList.add('show');
}
function hideClip(){const el=document.getElementById('clipchip');if(el)el.classList.remove('show');}
function clearClip(){clip=null;clearCutMark();hideClip();toast('剪贴板已清空');}

/* ============ 人名标签拖拽改派（按需求视图） ============ */
let chipDrag=null;
grid.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;            // 仅左键可拖人员标签改派；中键留给视图平移
  const chip=e.target.closest('.ptag[data-chip-mem]'); if(!chip)return;
  if(!requireWrite()){ e.preventDefault(); return; }   // 只读模式：禁止拖拽改派
  e.preventDefault(); e.stopPropagation();
  chipDrag={memId:chip.dataset.chipMem, srcReq:chip.dataset.chipReq, el:chip,
            startX:e.clientX,startY:e.clientY,moved:false,targetReq:null,ghost:null};
  chip.setPointerCapture&&chip.setPointerCapture(e.pointerId);
});
window.addEventListener('pointermove',e=>{
  if(!chipDrag)return;
  const dx=e.clientX-chipDrag.startX, dy=e.clientY-chipDrag.startY;
  if(!chipDrag.moved && Math.abs(dx)+Math.abs(dy)<5)return;
  if(!chipDrag.moved){
    chipDrag.moved=true; chipDrag.el.classList.add('dragging');
    const g=document.createElement('div'); g.id='chipGhost';
    g.style.cssText='position:fixed;z-index:9999;pointer-events:none;font-size:11px;font-weight:600;background:#fff;border:1.5px solid #f08c00;border-radius:6px;padding:2px 9px;box-shadow:0 6px 18px rgba(0,0,0,.25);color:#5b21b6;';
    g.textContent=memName(chipDrag.memId);
    document.body.appendChild(g); chipDrag.ghost=g;
  }
  chipDrag.ghost.style.left=(e.clientX+12)+'px';
  chipDrag.ghost.style.top=(e.clientY+12)+'px';
  document.querySelectorAll('.req-row.chip-target').forEach(r=>r.classList.remove('chip-target'));
  chipDrag.targetReq=null;
  const el=document.elementFromPoint(e.clientX,e.clientY);
  const row=el&&el.closest('.req-row[data-req-row]');
  if(row && row.dataset.reqRow!==chipDrag.srcReq){
    row.classList.add('chip-target'); chipDrag.targetReq=row.dataset.reqRow;
  }
});
window.addEventListener('pointerup',()=>{
  if(!chipDrag)return;
  const cd=chipDrag; chipDrag=null;
  if(cd.ghost)cd.ghost.remove();
  cd.el.classList.remove('dragging');
  document.querySelectorAll('.req-row.chip-target').forEach(r=>r.classList.remove('chip-target'));
  if(!cd.moved || !cd.targetReq || cd.targetReq===cd.srcReq)return;
  assignMemberToReq(cd.memId, cd.srcReq, cd.targetReq);
});
/* 把某人从源需求加入(改派到)目标需求；跨队自动标支援 */
function assignMemberToReq(memId, srcReqId, dstReqId){
  const dst=reqs.find(r=>r.id===dstReqId); if(!dst)return;
  if(dst.segs.some(s=>s.m===memId)){toast(memName(memId)+' 已在该需求中');return;}
  const src=reqs.find(r=>r.id===srcReqId);
  pushHistory();
  // 以源需求里此人的段为模板（保持工期长度），对齐目标需求起始
  let tpl=src&&src.segs.find(s=>s.m===memId);
  const dstStart=Math.min(...dst.segs.map(s=>idx(s.s)));
  let span = tpl?(idx(tpl.e)-idx(tpl.s)):workdaysSpanDefault(dst);
  const ns=dstStart, ne=Math.min(dstStart+span,DAYS);
  const seg={m:memId, s:i2d(ns), e:i2d(ne), prog:0, status:'todo'};
  const mem=memById(memId), rl=reqLeadOf(dst), ml=leadOf(mem);
  if(rl&&ml&&ml!==rl) seg.support=true;        // 跨隶属 → 支援
  dst.segs.push(seg);
  dst.end=i2d(Math.max(...dst.segs.map(x=>idx(x.e))));
  save();broadcast();rerender();
  flashReqRow(dstReqId);
  toast(`${memName(memId)} → ${dst.name}${seg.support?'（标记支援）':''}`);
}
function workdaysSpanDefault(dst){
  const s=Math.min(...dst.segs.map(x=>idx(x.s))), e=Math.max(...dst.segs.map(x=>idx(x.e)));
  return Math.max(e-s,7);
}

/* ============ 新增任务 / 新增人员（双视图共用同一份 reqs.segs，提交后即时同步） ============ */
const addMask=document.getElementById('addMask');
const addModal=document.getElementById('addModal');
let addCtx=null;   // {mode:'task'|'person', memId|reqId}
/* Date <-> input[type=date] 的本地日期串，避免 toISOString 的时区偏移 */
function dInput(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),da=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${da}`;}
function parseInput(s){const a=String(s).split('-').map(Number);if(a.length!==3||!a[0])return null;return new Date(a[0],a[1]-1,a[2]);}
const G_MIN=dInput(i2d(0)), G_MAX=dInput(i2d(DAYS));

function closeAdd(){addMask.classList.remove('show');addCtx=null;}
addMask.addEventListener('pointerdown',e=>{if(e.target===addMask)closeAdd();});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&addMask.classList.contains('show'))closeAdd();},true);

/* 投入比下拉（加人/加任务弹窗共用）：全人力[0-1.0]、完整跟进[0.4-0.6]、部分跟进[0.1-0.3]，均按并行条数在区间内分摊 */
let INV_SELECT_HTML = '';
function syncInvSelectHTML(){
  const opts = INV_TIERS.map((t,i)=>{const hi=(t.hi!=null?t.hi:t.val),lo=(t.lo!=null?t.lo:(hi>=1?0:hi));const rg=hi>=1?`独占 1.0 · 并行 1/N`:`区间 ${lo}–${hi}`;return `<option value="${hi}"${i===0?' selected':''}>${effEsc(t.name)}（${rg}）</option>`;}).join('');
  INV_SELECT_HTML = `<div class="fld"><label>投入比（精力分配）</label>
      <select id="addInv">${opts}</select></div>`;
}
syncInvSelectHTML();

/* 给某成员加任务：选择「哪条需求」+ 起止日期 */
function openAddTaskFor(memId){
  if(!requireWrite())return;
  const m=memById(memId); if(!m)return;
  addCtx={mode:'task', memId};
  // 该成员尚未参与的需求（已参与的不再重复）
  const avail=reqs.filter(r=>!r.segs.some(s=>s.m===memId));
  const optHTML=avail.length
    ? avail.map(r=>{const g=HR_GRADE[r.grade]||HR_GRADE[''];const lbl=`${r.char?charShort(r.char)+' · ':''}${r.name}（${g.label}${r.line&&r.line!=='-'?'·'+lineName(r.line):''}）`;return `<option value="${r.id}">${lbl}</option>`;}).join('')
    : '';
  const body = avail.length ? `
    <div class="ctx">为 <b>${m.name}</b>（${m.corp==='reg'?'正编·带队':m.corp==='sub'?'子公司':'基地'}${m.grade?' · '+m.grade+'级':''}）新分配一条任务。提交后，「按需求看」对应需求的蓝色标签里会同步出现该成员。</div>
    <div class="fld"><label>分配到哪条需求</label>
      <select id="addReqSel" onchange="addPrefillDates()">${optHTML}</select></div>
    <div class="row2">
      <div class="fld"><label>开始日期</label><input type="date" id="addStart" min="${G_MIN}" max="${G_MAX}"></div>
      <div class="fld"><label>结束日期</label><input type="date" id="addEnd" min="${G_MIN}" max="${G_MAX}"></div>
    </div>
    <div class="fld"><label>时间长度</label>
      <select id="addOpen" onchange="toggleAddOpen()">
        <option value="">固定起止时间</option>
        <option value="front">前端无限延长（起始待定）</option>
        <option value="back">后端无限延长（结束待定）</option>
        <option value="both">前后无限延长（时间待定）</option>
      </select></div>
    ${INV_SELECT_HTML}
    <div class="seg-pre" id="addPre"></div>
    <div class="warn" id="addWarn"></div>`
    : `<div class="ctx">✅ <b>${m.name}</b> 已经参与了全部需求，没有可再新增的需求了。</div>`;
  renderAddModal('＋', `给 ${m.name} 加任务`, body, avail.length>0);
  if(avail.length){addPrefillDates();}
}

/* 给某需求加人：选择「哪位成员」+ 起止日期 */
function openAddPersonTo(reqId, prefCorp){
  if(!requireWrite())return;
  const r=reqs.find(x=>x.id===reqId); if(!r)return;
  addCtx={mode:'person', reqId};
  // 尚未在该需求中的成员（离职沉底、可选但给提示）
  const inReq=new Set(r.segs.map(s=>s.m));
  const avail=members.filter(m=>!inReq.has(m.id) && !leftLong(m));   // 离职满1月不再出现在加人下拉
  const grp=(label,arr)=>arr.length?`<optgroup label="${label}">${arr.map(m=>`<option value="${m.id}">${m.name}（${m.role}）${m.status==='left'?' · 已离职':m.status==='new'?' · 新人':''}</option>`).join('')}</optgroup>`:'';
  const regs=avail.filter(m=>m.corp==='reg'), bases=avail.filter(m=>m.corp!=='reg'&&m.status!=='left'), lefts=avail.filter(m=>m.corp!=='reg'&&m.status==='left');
  // 按点击的编制把对应分组排到最前，使默认选中项就是该编制的人
  const optHTML = prefCorp==='reg'
    ? grp('正编',regs)+grp('基地',bases)+grp('已离职',lefts)
    : prefCorp==='base'
      ? grp('基地',bases)+grp('正编',regs)+grp('已离职',lefts)
      : grp('正编',regs)+grp('基地',bases)+grp('已离职',lefts);
  const g=HR_GRADE[r.grade]||HR_GRADE[''];
  const body = avail.length ? `
    <div class="ctx">给需求 <b>${r.char?charShort(r.char)+' · ':''}${r.name}</b>（${g.label}级${r.line&&r.line!=='-'?' · '+lineName(r.line):''}）添加一名制作人。提交后，「按人看」里该成员的行会同步出现这条任务。跨带队归属会自动标记为「支援」。</div>
    <div class="fld"><label>添加哪位成员</label>
      <select id="addMemSel" onchange="addPrefillDates()">${optHTML}</select></div>
    <div class="row2">
      <div class="fld"><label>开始日期</label><input type="date" id="addStart" min="${G_MIN}" max="${G_MAX}"></div>
      <div class="fld"><label>结束日期</label><input type="date" id="addEnd" min="${G_MIN}" max="${G_MAX}"></div>
    </div>
    <div class="fld"><label>时间长度</label>
      <select id="addOpen" onchange="toggleAddOpen()">
        <option value="">固定起止时间</option>
        <option value="front">前端无限延长（起始待定）</option>
        <option value="back">后端无限延长（结束待定）</option>
        <option value="both">前后无限延长（时间待定）</option>
      </select></div>
    ${INV_SELECT_HTML}
    <div class="seg-pre" id="addPre"></div>
    <div class="warn" id="addWarn"></div>`
    : `<div class="ctx">✅ 全部成员都已在该需求中，没有可再添加的人了。</div>`;
  renderAddModal('＋', `给「${r.name}」加人`, body, avail.length>0);
  if(avail.length){addPrefillDates();}
}

function renderAddModal(icon,title,bodyHTML,withOk){
  addModal.innerHTML=`
    <div class="am-h"><span class="ic">${icon}</span>${title}<button class="am-x" onclick="closeAdd()" title="关闭">×</button></div>
    <div class="am-body">${bodyHTML}</div>
    <div class="am-foot">
      <button class="am-cancel" onclick="closeAdd()">取消</button>
      ${withOk?'<button class="am-ok" id="addOk" onclick="confirmAdd()">确定添加</button>':''}
    </div>`;
  addMask.classList.add('show');
}

/* 选择改变时，自动用「目标需求窗口」预填起止日期，给个合理默认 */
function addPrefillDates(){
  let r=null;
  if(addCtx.mode==='task'){const sel=document.getElementById('addReqSel');r=sel&&reqs.find(x=>x.id===sel.value);}
  else{r=reqs.find(x=>x.id===addCtx.reqId);}
  if(!r)return;
  const s=Math.min(...r.segs.map(x=>idx(x.s))), e=Math.max(...r.segs.map(x=>idx(x.e)));
  const sEl=document.getElementById('addStart'), eEl=document.getElementById('addEnd');
  if(sEl&&!sEl.dataset.touched) sEl.value=dInput(i2d(isFinite(s)?s:idx(TODAY)));
  if(eEl&&!eEl.dataset.touched) eEl.value=dInput(i2d(isFinite(e)?e:idx(TODAY)+14));
  if(sEl)sEl.onchange=()=>{sEl.dataset.touched=1;updateAddPre();};
  if(eEl)eEl.onchange=()=>{eEl.dataset.touched=1;updateAddPre();};
  updateAddPre();
}
/* 选择「时间长度」类型：前端/后端/两端无限时禁用相应日期输入，并刷新预览/校验 */
function toggleAddOpen(){
  const op=document.getElementById('addOpen');
  const sEl=document.getElementById('addStart'), eEl=document.getElementById('addEnd');
  const type=(op&&op.value)||'';
  if(sEl){sEl.disabled=type==='front'||type==='both';}
  if(eEl){eEl.disabled=type==='back'||type==='both';}
  updateAddPre();
}
function updateAddPre(){
  const pre=document.getElementById('addPre'), warn=document.getElementById('addWarn'), ok=document.getElementById('addOk');
  const op=document.getElementById('addOpen');
  const type=(op&&op.value)||'';
  if(type){   // 无限延长：跳过日期校验，直接放行
    const label=type==='front'?'前端无限延长（起始待定）':type==='back'?'后端无限延长（结束待定）':'前后无限延长（时间待定）';
    if(pre)pre.textContent=`${label} —— 任务条将向${type==='front'?'左':type==='back'?'右':'两侧'}延长铺满时间线（可后续改为固定时间）`;
    if(warn){warn.textContent='';warn.classList.remove('show');}
    if(ok)ok.disabled=false;
    return;
  }
  const sEl=document.getElementById('addStart'), eEl=document.getElementById('addEnd');
  if(!sEl||!eEl)return;
  const sd=parseInput(sEl.value), ed=parseInput(eEl.value);
  let msg='', bad=false;
  if(!sd||!ed){bad=true;msg='请选择开始与结束日期';}
  else if(ed<sd){bad=true;msg='结束日期不能早于开始日期';}
  /* v6.55 输入框为「含末日」语义：用户选的结束日算在工期内 → 计算工作日时需 +1 天 */
  else{const edIn=new Date(ed.getTime()+dayMs);pre.textContent=`工期约 ${workdays(sd,edIn)} 个工作日（${fmt(sd)} → ${fmt(ed)}）`;}
  if(warn){warn.textContent=msg;warn.classList.toggle('show',!!msg);}
  if(ok)ok.disabled=bad;
  if(bad&&pre)pre.textContent='';
}

function confirmAdd(){
  if(!addCtx)return;
  if(!requireWrite())return;
  const op=document.getElementById('addOpen');
  const openType=(op&&op.value)||'';
  const sEl=document.getElementById('addStart'), eEl=document.getElementById('addEnd');
  const sd=parseInput(sEl.value), ed=parseInput(eEl.value);
  if(!openType && (!sd||!ed||ed<sd)){updateAddPre();return;}
  let memId, r;
  if(addCtx.mode==='task'){memId=addCtx.memId;const sel=document.getElementById('addReqSel');r=reqs.find(x=>x.id===sel.value);}
  else{r=reqs.find(x=>x.id===addCtx.reqId);const sel=document.getElementById('addMemSel');memId=sel.value;}
  if(!r||!memId){closeAdd();return;}
  if(r.segs.some(s=>s.m===memId)){toast(memName(memId)+' 已在该需求中');closeAdd();return;}
  pushHistory();
  let seg;
  if(openType){
    // 无限延长：给一个占位窗口（仅作排序/兜底用），并标 open 类型让其渲染成相应方向的延长条；
    // open 段不计入负载/产能（见 memLoad/reqRisk 已按时长窗口计，open 占位窗口设在今日±少量天，影响可忽略，且渲染走铺满分支）。
    const ns=Math.max(0,Math.min(idx(TODAY),DAYS-1));
    seg={m:memId, s:i2d(ns), e:i2d(Math.min(ns+1,DAYS)), prog:0, status:'todo', open:openType};
  }else{
    // 夹到甘特范围内。v6.55：输入框是「含末日」语义 → idx(ed)+1 还原为底层排他终点
    let ns=Math.max(0,Math.min(idx(sd),DAYS-1)), ne=Math.max(ns+1,Math.min(idx(ed)+1,DAYS));
    seg={m:memId, s:i2d(ns), e:i2d(ne), prog:0, status:'todo'};
  }
  // 投入比（精力分配）：!=1 时写入 seg.inv；=1(全人力)不写，走自动并行分摊
  const invEl=document.getElementById('addInv');
  const invV=invEl?parseFloat(invEl.value):1;
  if(invV>0 && invV<1) seg.inv=invV;
  // 跨带队归属 → 标记支援
  const mem=memById(memId), rl=reqLeadOf(r), ml=leadOf(mem);  if(rl&&ml&&ml!==rl) seg.support=true;
  r.segs.push(seg);
  r.end=i2d(Math.max(...r.segs.map(x=>idx(x.e))));
  _logDesc='给「'+r.name+'」新增任务条（'+memName(memId)+'）';
  save();broadcast();
  closeAdd();
  rerender();
  // 反馈：两个视图都给高亮
  if(view==='req'){flashReqRow(r.id);} else {flashReq(r.id);}
  const openLabel=openType==='front'?'（前端无限）':openType==='back'?'（后端无限）':openType==='both'?'（时间待定）':'';
  toast(addCtx&&addCtx.mode==='person'
    ? `已为「${r.name}」添加 ${memName(memId)}${seg.support?'（支援）':''}${openLabel}`
    : `已为 ${memName(memId)} 新增任务：${r.name}${seg.support?'（支援）':''}${openLabel}`);
}

/* ============ 新建成员 / 新建需求（写入 members / reqs 数组，纳入持久化） ============ */
function escAttr(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
/* 由姓名/名称生成唯一英文 id（拼音不可得时用 m/r 前缀 + 随机） */
function genId(prefix){
  let id; do{ id=prefix+Math.random().toString(36).slice(2,7); }while(members.some(m=>m.id===id)||reqs.some(r=>r.id===id));
  return id;
}
/* 正编下拉（用于"隶属带队"选择） */
function regLeaderOpts(sel){
  const regs=members.filter(m=>m.corp==='reg');
  return `<option value="—" ${(!sel||sel==='—')?'selected':''}>（无 / 游离人力）</option>`
    + regs.map(m=>`<option value="${escAttr(m.name)}" ${sel===m.name?'selected':''}>${escAttr(m.name)}</option>`).join('');
}
const GRADE_OPTS_LIST=['','通用','金','橙','红'];
const MOD_OPTS_LIST=['出场','检视','组队','饰品','入局Cuts','TPP','MVP','大厅','本体/3C','武器特效','通用','联调'];
const CHAR_OPTS_LIST=['金','橙','红','通用'];   /* 正编「负责」可选品级（对应 HR_GRADE 的金/橙/红/通用） */
/* 按品级返回模块选项列表：金/橙/红用静态 MOD_OPTS_LIST；通用从 HR 角色线动态提取（与 HR 视图匹配）。 */
function modOptsForGrade(grade){
  if(grade !== '通用') return MOD_OPTS_LIST;
  // 从 buildRoleLines 提取所有含 通用 品级的模块名（去重保序）
  const lines = buildRoleLines();
  const mods = [];
  const seen = new Set();
  lines.forEach(g => {
    if(g.roles.some(r => r.grade === '通用') && !seen.has(g.mod)){
      seen.add(g.mod); mods.push(g.mod);
    }
  });
  // 补齐静态列表中可能遗漏的
  MOD_OPTS_LIST.forEach(m => { if(!seen.has(m)){ seen.add(m); mods.push(m); }});
  return mods;
}
const LINE_OPTS_LIST=[['-','通用'],['L1','露西亚·管线1'],['L2','比安卡·管线2'],['J','七十·金角线'],['R','女指挥官·红角线']];

/* 格式化正编「负责」显示：从 leadChars(品级) + leadMods(模块) 渲染为结构化标签。
   品级使用 HR_GRADE 配色（金/橙/红）。
   若多名正编选中同一品级，自动追加序号区分（金①/金②），按成员 id 排序确定顺序。 */
function formatLeadDisplay(m){
  if(!m || (m.corp!=='reg' && m.corp!=='sub')) return '';
  const chars = (m.leadChars||'').split(',').filter(Boolean);
  const mods  = (m.leadMods||'').split(',').filter(Boolean);
  // 旧格式回退解析（与 startEditLead 共用同一套逻辑）
  if(!chars.length && !mods.length){
    const txt=(m.lead||'').trim();
    if(txt && txt!=='暂缺' && txt!=='—'){
      const pi=txt.indexOf(' · ');
      const cRaw=pi>0?txt.slice(0,pi):txt;
      const mRaw=pi>0?txt.slice(pi+3):'';
      const cSet=new Set(CHAR_OPTS_LIST);
      // 角色提取：+ 分割 + 去尾数字 + 匹配
      const fc=cRaw.split('+').map(s=>s.trim().replace(/[①②③④⑤]$/,'')).filter(s=>cSet.has(s));
      // 子串扫描兜底（兼容 "橙角露西亚·管线1"）
      const ec=fc.length?fc:[...cSet].filter(c=>txt.includes(c));
      // 模块提取：/ 分割 + 复合模块处理
      const mp=mRaw.split('/').filter(Boolean);
      const mSet=new Set(MOD_OPTS_LIST);
      const em=[];
      for(let i=0;i<mp.length;i++){
        const cur=mp[i],nxt=mp[i+1];
        if(nxt!==undefined&&mSet.has(cur+'/'+nxt)){em.push(cur+'/'+nxt);i++;}
        else if(mSet.has(cur)){em.push(cur);}
      }
      if(ec.length||em.length){ return _formatLeadStructured(m,ec,em); }
    }
    // 最终回退：原样展示旧文本
    const t = txt;
    return t ? '负责 '+escAttr(t) : '';
  }
  return _formatLeadStructured(m, chars, mods);
}
/* 结构化负责标签渲染（被 formatLeadDisplay 和回退解析共同调用）
   v6.17: 优先使用 leadMap（每品级→专属模块列表）进行精确配对；
   无 leadMap 时从扁平 leadChars/leadMods 均分推导（向后兼容旧数据）。 */
function _formatLeadStructured(m, chars, mods){
    // 收集所有正编的品级选择，用于去重序号
    const regMembers = members.filter(x=>x.corp==='reg');
    const gradeCount = {};   // 品级 → 出现次数
    const gradeOrder = {};   // 品级 → [memberId...]
    regMembers.forEach(x => {
      const gs = (x.leadChars||'').split(',').filter(Boolean);
      gs.forEach(g => {
        gradeCount[g] = (gradeCount[g]||0) + 1;
        if(!gradeOrder[g]) gradeOrder[g] = [];
        gradeOrder[g].push(x.id);
      });
    });
    // 按 memberId 排序保证序号稳定
    Object.keys(gradeOrder).forEach(g => gradeOrder[g].sort());

    // ★ v6.17: 优先用 leadMap 精确配对
    let mapEntries = null;
    if(m.leadMap && Array.isArray(m.leadMap) && m.leadMap.length){
      mapEntries=m.leadMap.filter(e=>e.c&&chars.includes(e.c));
    }
    // 如果没有有效的 leadMap，从扁平数据均分推导（兼容旧格式）
    if(!mapEntries || !mapEntries.length){
      mapEntries=chars.map((c,i)=>{
        const start=Math.round(i*mods.length/chars.length);
        const end=Math.round((i+1)*mods.length/chars.length);
        return {c:c, m:mods.slice(start,end)};
      });
    }

    const charSpans = chars.map(c => {
      const gInfo = HR_GRADE[c] || HR_GRADE[''];
      const s = LD_CH_STYLE[c] || LD_CH_STYLE[''];
      let label = c;
      if((gradeCount[c]||0) > 1){
        const idx = (gradeOrder[c]||[]).indexOf(m.id);
        if(idx >= 0) label += ['①','②','③','④','⑤'][idx] || '';
      }
      return `<span class="ld-ch" style="background:${s.bg};color:${s.color};border-color:${s.border}">${escAttr(label)}</span>`;
    }).join('');
    const modSpans = mods.map(md=>`<span class="ld-md">${escAttr(md)}</span>`).join('');

    // 每个品级一行，带上其专属模块
    let html = '<span class="ld-block">';
    mapEntries.forEach(entry=>{
      const c=entry.c;
      const gInfo = HR_GRADE[c] || HR_GRADE[''];
      const s = LD_CH_STYLE[c] || LD_CH_STYLE[''];
      // ★ v6.18: 优先用用户自定义标签(entry.label)；留空则回退自动序号
      let label = (entry.label && entry.label.trim()) ? entry.label.trim() : c;
      if(!(entry.label && entry.label.trim()) && (gradeCount[c]||0) > 1){
        const idx = (gradeOrder[c]||[]).indexOf(m.id);
        if(idx >= 0) label += ['①','②','③','④','⑤'][idx] || '';
      }
      const chSpan = `<span class="ld-ch" style="background:${s.bg};color:${s.color};border-color:${s.border}">${escAttr(label)}</span>`;
      const mdStr = (entry.m||[]).map(md=>`<span class="ld-md">${escAttr(md)}</span>`).join('');
      html += '<span class="ld-row">'+chSpan+(mdStr ? ' · '+mdStr : '')+'</span>';
    });
    // 处理不在 leadMap 中的残留模块（防御性）
    const mappedMods=new Set(mapEntries.flatMap(e=>e.m||[]));
    const orphanMods=mods.filter(md=>!mappedMods.has(md));
    if(orphanMods.length){
      html += '<span class="ld-row ld-row-md">'+orphanMods.map(md=>`<span class="ld-md">${escAttr(md)}</span>`).join('')+'</span>';
    }
    html += '</span>';
    return '负责 '+html;
}

function openNewMember(){
  if(!requireWrite())return;
  addCtx={mode:'newMember'};
  const modOpt=MOD_OPTS_LIST.map(m=>`<option value="${m}" ${m==='出场'?'selected':''}>${m}</option>`).join('');
  const body=`
    <div class="ctx">添加一名<b>新成员</b>到团队名单。提交后会立即出现在「按人看」列表中，并纳入本地缓存 / 团队链接 / 云端协作同步。<br><span style="color:#8a9099;font-size:11px">💡 品级/管线跟随成员当前负责的角色线自动确定，无需在此设置</span></div>
    <div class="row2">
      <div class="fld"><label>姓名</label><input type="text" id="nmName" placeholder="如：张三"></div>
      <div class="fld"><label>编制</label><select id="nmCorp" onchange="nmCorpChange()"><option value="base" selected>基地</option><option value="sub">子公司</option><option value="reg">正编（带队）</option></select></div>
    </div>
    <div class="row2">
      <div class="fld" id="nmLeadFld"><label>隶属带队（正编）</label><select id="nmLead">${regLeaderOpts('—')}</select></div>
      <div class="fld"><label>模块</label><select id="nmMod">${modOpt}</select></div>
    </div>
    <div class="row2">
      <div class="fld"><label>效率系数</label><input type="number" id="nmEff" value="1.0" step="0.05" min="0"></div>
      <div class="fld"><label>状态</label><select id="nmStatus"><option value="on" selected>在岗</option><option value="new">新人</option><option value="busy">忙碌</option><option value="leave">请假</option></select></div>
    </div>
    /* v7.48 表意优化：与编辑弹层一致的三态单选（新建成员时默认「本队常规」） */
    <div class="loan-3way">
      <div class="l3-t">隶属类型</div>
      <div class="l3-row">
        <label class="l3 on"><input type="radio" name="nmLoanKind" value="normal" checked onchange="nmLoanKindChange()"><span>本队常规</span><small>编制与隶属都在本队</small></label>
        <label class="l3"><input type="radio" name="nmLoanKind" value="out" onchange="nmLoanKindChange()"><span>↗ 外借出去</span><small>编制留本队，人去别管线</small></label>
        <label class="l3"><input type="radio" name="nmLoanKind" value="in" onchange="nmLoanKindChange()"><span>↙ 借入支援</span><small>从别管线借来，临时隶属</small></label>
      </div>
      <div class="l3-extra" id="nmLoanExtra" style="display:none">
        <div class="row2">
          <div class="fld"><label id="nmPartyLab">对方管线</label><input type="text" id="nmParty" placeholder="如：武器特效"></div>
          <div class="fld"><label>约定结束日（留空=长期）</label><input type="date" id="nmLoanTo"></div>
        </div>
      </div>
    </div>
    <div class="warn" id="nmWarn"></div>`;
  renderAddModal('👤', '添加新成员', body, true);
  // 重新绑定确定按钮到本流程
  const ok=document.getElementById('addOk'); if(ok)ok.setAttribute('onclick','confirmNewMember()');
  nmCorpChange();
  nmLoanKindChange();
}
function nmCorpChange(){
  const corp=document.getElementById('nmCorp').value;
  const leadFld=document.getElementById('nmLeadFld');
  if(leadFld) leadFld.style.opacity = (corp==='reg'||corp==='sub')?'.4':'1';
  const ld=document.getElementById('nmLead'); if(ld) ld.disabled = (corp==='reg'||corp==='sub');
}
function confirmNewMember(){
  if(!requireWrite())return;
  const name=(document.getElementById('nmName').value||'').trim();
  const warn=document.getElementById('nmWarn');
  if(!name){ warn.textContent='请填写姓名'; warn.classList.add('show'); return; }
  if(members.some(m=>m.name===name)){ warn.textContent='已存在同名成员，请用其它名称'; warn.classList.add('show'); return; }
  const corp=document.getElementById('nmCorp').value;
  /* v7.48：三态单选取代原 nmSupport 勾选框（与编辑弹层同一套 m.loan 数据结构） */
  const kindEl=document.querySelector('input[name="nmLoanKind"]:checked');
  const kind=kindEl?kindEl.value:'normal';
  const partyEl=document.getElementById('nmParty');
  const toEl=document.getElementById('nmLoanTo');
  const party=(partyEl&&partyEl.value||'').trim();
  const loanTo=(toEl&&toEl.value)?_dateOrNull(toEl.value):null;
  const mod=document.getElementById('nmMod').value;
  let lead=(corp==='reg'||corp==='sub')?name:(document.getElementById('nmLead').value||'—');
  if(kind==='out'){
    if(!party){ warn.textContent='请填写「去哪个管线」'; warn.classList.add('show'); return; }
    lead='—';   // 外借：脱离角色线
  }
  if(kind==='in'){
    if(!party){ warn.textContent='请填写「来自哪个管线」'; warn.classList.add('show'); return; }
  }
  const eff=parseFloat(document.getElementById('nmEff').value)||1.0;
  pushHistory();
  const m={
    id:genId('m_'), name,
    role:(corp==='reg'?'正编·带队':corp==='sub'?'子公司':'基地')+(kind==='out'?'·外借支援':kind==='in'?'·借入支援':''),
    corp, lead,
    mod,
    grade:'',      // 品级不再与成员绑定，由 memWorkGrade() 从角色线动态取
    line:'-',      // 管线同理，不再固定绑定
    eff:Math.round(eff*100)/100,
    status:document.getElementById('nmStatus').value,
    loanRecs:[],
  };
  if(kind==='out'){
    m.support=true;
    m.loan={ id:newLoanId(), dir:'out', party, from:new Date(TODAY), to:loanTo, mod, note:'',
      snap:{corp, lead:'—', mod, grade:'', line:'-'}, state:'active', endAt:null, endBy:null };
  }else if(kind==='in'){
    m.support=true; m.tmp=true;
    m.loan={ id:newLoanId(), dir:'in', party, from:new Date(TODAY), to:loanTo, mod, note:'',
      snap:null, state:'active', endAt:null, endBy:null };
  }
  members.push(m);
  _logDesc='新增成员：'+m.name;
  save();broadcast();closeAdd();
  // 切到「按人看」（成员只在此视图出现），再把视图中心拉到新成员并高亮
  if(view!=='person'){ const vt=document.querySelector('#viewTabs button:nth-child(1)'); if(vt)setView('person',vt); else rerender(); }
  else rerender();
  revealEntity('mem', m.id);
  toast(`已添加新成员：${name}`);
}

/* ============ 编辑现有成员：复用新增表单字段，确认时改原记录而非新建 ============ */
function openEditMember(memId){
  if(!requireWrite())return;
  const m=members.find(x=>x.id===memId); if(!m)return;
  addCtx={mode:'editMember', memId};
  const modOpt=MOD_OPTS_LIST.map(o=>`<option value="${o}" ${m.mod===o?'selected':''}>${o}</option>`).join('');
  const body=`
    <div class="ctx">编辑 <b>${escAttr(m.name)}</b> 的成员信息。提交后实时刷新左侧名单、等级圆标、效率档位表与负载统计。</div>
    <div class="row2">
      <div class="fld"><label>姓名</label><input type="text" id="nmName" value="${escAttr(m.name)}" placeholder="如：张三"></div>
      <div class="fld"><label>编制</label><select id="nmCorp" onchange="nmCorpChange()"><option value="base" ${m.corp==='base'?'selected':''}>基地</option><option value="sub" ${m.corp==='sub'?'selected':''}>子公司</option><option value="reg" ${m.corp==='reg'?'selected':''}>正编（带队）</option></select></div>
    </div>
    <div class="row2">
      <div class="fld" id="nmLeadFld"><label>隶属带队（正编）</label><select id="nmLead">${regLeaderOpts(m.corp==='reg'?m.name:(m.lead||'—'))}</select></div>
      <div class="fld"><label>模块</label><select id="nmMod">${modOpt}</select></div>
    </div>
    <div class="row2">
      <div class="fld"><label>效率系数</label><input type="number" id="nmEff" value="${m.eff}" step="0.05" min="0"></div>
      <div class="fld"><label>状态</label><select id="nmStatus"><option value="on" ${m.status==='on'?'selected':''}>在岗</option><option value="new" ${m.status==='new'?'selected':''}>新人</option><option value="busy" ${m.status==='busy'?'selected':''}>忙碌</option><option value="leave" ${m.status==='leave'?'selected':''}>请假</option><option value="left" ${m.status==='left'?'selected':''}>离职</option></select></div>
    </div>
    /* v7.48 表意优化：原来只有一句长勾选框「外借支援（编制在本团队，不隶属角色线，如武器特效）」，
       读不出「借出 / 借入 / 跨队支援」的区别。改为三态单选 + 条件展开对应字段，一眼看懂。
       注意：这里只做「快捷表达」，正式借调记录（带起止日与快照）走右键菜单 / HR 面板的登记弹层，
       两者共用同一套 m.loan 数据结构，不会各写一份导致打架。 */
    <div class="loan-3way">
      <div class="l3-t">隶属类型</div>
      <div class="l3-row">
        <label class="l3 ${(!curLoan(m)&&!m.support)?'on':''}"><input type="radio" name="nmLoanKind" value="normal" ${(!curLoan(m)&&!m.support)?'checked':''} onchange="nmLoanKindChange()"><span>本队常规</span><small>编制与隶属都在本队</small></label>
        <label class="l3 ${(isExtLoan(m))?'on':''}"><input type="radio" name="nmLoanKind" value="out" ${isExtLoan(m)?'checked':''} onchange="nmLoanKindChange()"><span>↗ 外借出去</span><small>编制留本队，人去别管线</small></label>
        <label class="l3 ${(isLoanIn(m))?'on':''}"><input type="radio" name="nmLoanKind" value="in" ${isLoanIn(m)?'checked':''} onchange="nmLoanKindChange()"><span>↙ 借入支援</span><small>从别管线借来，临时隶属</small></label>
      </div>
      <div class="l3-extra" id="nmLoanExtra" style="display:none">
        <div class="row2">
          <div class="fld"><label id="nmPartyLab">对方管线</label><input type="text" id="nmParty" value="${escAttr((curLoan(m)&&curLoan(m).party)||m.mod||'')}" placeholder="如：武器特效"></div>
          <div class="fld"><label>约定结束日（留空=长期）</label><input type="date" id="nmLoanTo" value="${(curLoan(m)&&curLoan(m).to)?fmtInputDate(curLoan(m).to):''}"></div>
        </div>
        <div class="dp-tip">保存即写入借调记录<b>（带起止日与编制快照）</b>。要改「回归/归还/转正」等状态流转，请在成员上<b>右键</b>操作。</div>
      </div>
    </div>
    <div class="warn" id="nmWarn"></div>`;
  renderAddModal('👤', '编辑成员 · '+m.name, body, true);
  const ok=document.getElementById('addOk');
  if(ok){ ok.textContent='保存修改'; ok.setAttribute('onclick','confirmEditMember()'); }
  nmCorpChange();
  nmLoanKindChange();
}
/* 三态单选联动：非「本队常规」时展开对方管线 / 结束日字段，并按方向改标签文案 */
function nmLoanKindChange(){
  const pick=document.querySelector('input[name="nmLoanKind"]:checked');
  const ex=document.getElementById('nmLoanExtra');
  if(!pick||!ex) return;
  const v=pick.value;
  ex.style.display=(v==='normal')?'none':'block';
  const lab=document.getElementById('nmPartyLab');
  if(lab) lab.textContent=(v==='in')?'来自哪个管线':'去哪个管线';
  document.querySelectorAll('.loan-3way .l3').forEach(el=>{
    const r=el.querySelector('input[name="nmLoanKind"]');
    el.classList.toggle('on', !!(r&&r.checked));
  });
}
function confirmEditMember(){
  if(!requireWrite())return;
  const {memId}=addCtx||{}; const m=members.find(x=>x.id===memId); if(!m)return;
  const name=(document.getElementById('nmName').value||'').trim();
  const warn=document.getElementById('nmWarn');
  if(!name){ warn.textContent='请填写姓名'; warn.classList.add('show'); return; }
  if(members.some(x=>x.id!==memId && x.name===name)){ warn.textContent='已存在同名成员，请用其它名称'; warn.classList.add('show'); return; }
  const corp=document.getElementById('nmCorp').value;
  /* v7.48：三态单选取代原 nmSupport 勾选框。
     · normal → 清 support，无借调
     · out    → 登记外借（拍快照、lead 置 —）
     · in     → 转为借入（临时隶属）
     借调记录的起止日在展开区里填；若从「本队常规」切到借出，快照按**当前表单值**拍。 */
  const kindEl=document.querySelector('input[name="nmLoanKind"]:checked');
  const kind=kindEl?kindEl.value:'normal';
  const partyEl=document.getElementById('nmParty');
  const toEl=document.getElementById('nmLoanTo');
  const party=(partyEl&&partyEl.value||'').trim();
  const loanTo=(toEl&&toEl.value)?_dateOrNull(toEl.value):null;
  const mod=document.getElementById('nmMod').value;
  let lead=(corp==='reg'||corp==='sub')?name:(document.getElementById('nmLead').value||'—');
  if(kind==='out'){
    if(!party){ warn.textContent='请填写「去哪个管线」'; warn.classList.add('show'); return; }
    lead='—';   // 外借：脱离角色线
  }
  if(kind==='in'){
    if(!party){ warn.textContent='请填写「来自哪个管线」'; warn.classList.add('show'); return; }
  }
  const eff=parseFloat(document.getElementById('nmEff').value)||1.0;
  /* ★ 快照必须在写回 m 之前拍：它记录的是「打开弹层时」的编制状态，
       一旦下面把 corp/lead/mod/grade 覆盖成新值，就再也取不到原值了。 */
  const _snap0={corp:m.corp||'base', lead:m.lead||'—', mod:m.mod||'', grade:m.grade||'', line:m.line||'-'};
  pushHistory();
  const oldName=m.name;
  m.name=name;
  m.corp=corp;
  m.lead=lead;
  m.mod=mod;
  m.eff=Math.round(eff*100)/100;
  m.status=document.getElementById('nmStatus').value;
  if(!Array.isArray(m.loanRecs)) m.loanRecs=[];
  const prevLoan=curLoan(m);
  if(kind==='normal'){
    delete m.support;
    /* 原本在借 → 本次相当于结束借调：归档进历史，编制不动（由上方表单值决定） */
    if(prevLoan){
      prevLoan.state='ended'; prevLoan.endBy='return'; prevLoan.endAt=new Date(TODAY);
      m.loanRecs.push(prevLoan); m.loan=null;
    }
  }else if(kind==='out'){
    m.support=true;                                  // 兼容旧判定冗余保险
    if(prevLoan && prevLoan.dir==='out'){
      /* 已在借：就地更新对方与结束日，保留原快照（回归仍还原到最初外借前的编制） */
      prevLoan.party=party; prevLoan.to=loanTo; prevLoan.mod=mod;
      if(prevLoan.state==='ended'){ prevLoan.state='active'; prevLoan.endBy=null; prevLoan.endAt=null; }
    }else{
      if(prevLoan){ prevLoan.state='ended'; prevLoan.endBy='return'; prevLoan.endAt=new Date(TODAY); m.loanRecs.push(prevLoan); }
      /* 拍快照：用**改动前**的原始值（此时 m 尚未被上面的赋值覆盖到 loan 相关字段，
         m.corp/lead/grade/line 仍是打开弹层时的值——读的是同一个 m，故在此处取即为原值） */
      m.loan={ id:newLoanId(), dir:'out', party, from:prevLoan?prevLoan.from:new Date(TODAY), to:loanTo,
        mod, note:'', snap:_snap0, state:'active', endAt:null, endBy:null };
    }
  }else if(kind==='in'){
    m.support=true; m.tmp=true;
    if(prevLoan && prevLoan.dir==='in'){
      prevLoan.party=party; prevLoan.to=loanTo; prevLoan.mod=mod;
      if(prevLoan.state==='ended'){ prevLoan.state='active'; prevLoan.endBy=null; prevLoan.endAt=null; }
    }else{
      if(prevLoan){ prevLoan.state='ended'; prevLoan.endBy='return'; prevLoan.endAt=new Date(TODAY); m.loanRecs.push(prevLoan); }
      m.loan={ id:newLoanId(), dir:'in', party, from:new Date(TODAY), to:loanTo,
        mod, note:'', snap:null, state:'active', endAt:null, endBy:null };
    }
  }
  // 改名后同步其名下任务的成员显示引用（任务条按 member id 关联，无需改需求；仅同步 leftAt/状态外的可见名）
  _logDesc=(oldName!==name?('成员改名：'+oldName+'→'+name):('修改成员信息：'+m.name));
  save();broadcast();
  // 同步刷新效率档位表（v5.22 互通）：grade/eff 变化会影响归档
  if(typeof renderEffTable==='function') renderEffTable();
  closeAdd();
  rerender();
  toast(`已保存：${m.name}`);
}


/* ============ 标签内联编辑：隶属（基地换正编）/ 带队模块（正编可改可选） ============
   就地把人名行里的归属胶囊替换为编辑控件，回车 / 选中 / 失焦即提交，Esc 取消。
   只读模式拦截；提交后写入 member、save/broadcast/rerender 全链路同步。 */
let _editingLead=null;   // 防重入：记录当前正在编辑的标签元素
function startEditLead(ev, mid, kind){
  ev.stopPropagation();
  if(!requireWrite())return;
  const m=members.find(x=>x.id===mid); if(!m)return;
  const tag=ev.currentTarget;
  if(_editingLead===tag)return;
  _editingLead=tag;
  const wrap=document.createElement('span');
  wrap.className='lead-edit';
  const finish=(commit,val)=>{
    if(commit){
      if(kind==='belong'){
        // 基地成员更换隶属正编：'—' 表示游离/无归属
        const v=(val||'—');
        if(v!==m.lead){ pushHistory(); m.lead=v; m.role='基地'+(m.support?'·外借支援':''); _logDesc='把「'+m.name+'」隶属改为'+v; save();broadcast(); }
      }else{
        // 正编成员修改带队负责的模块/范围（自由文本）
        const v=(val||'').trim();
        if(v && v!==m.lead){ pushHistory(); m.lead=v; m.role='正编·带队'; _logDesc='把「'+m.name+'」带队范围改为'+v; save();broadcast(); }
      }
    }
    _editingLead=null;
    rerender();
  };
  if(kind==='belong'){
    /* 下拉：在岗正编 + 暂缺正编坑位 + 「无 / 游离」
       v6.48：改为分组下拉（optgroup）。基地人力常常先挂到一个「还没招到的正编坑位」下面，
       所以暂缺正编必须可选、且要与在岗正编视觉区分（⏳ 前缀 + 独立分组）。
       lead 字段存的是名字文本，故暂缺正编需靠名字后缀（暂缺-正编1/2/…）保持唯一，
       同名坑位会在选项后附加 id 尾号以便区分。 */
    const sel=document.createElement('select');
    const allRegs=members.filter(x=>x.corp==='reg'&&x.status!=='left');
    const onDuty=allRegs.filter(x=>!isVacantMem(x));
    const vacRegs=allRegs.filter(x=>isVacantMem(x));
    const cur=(m.lead&&m.lead!=='—'&&m.lead!=='-')?m.lead:'—';
    // 同名检测：若有重名坑位，选项文案附加 id 尾号（值仍写名字，避免破坏既有 lead 文本约定）
    const nameCount={};
    allRegs.forEach(x=>{ nameCount[x.name]=(nameCount[x.name]||0)+1; });
    const optOf=(x,prefix)=>{
      const dup=nameCount[x.name]>1 ? `（#${String(x.id).slice(-4)}）` : '';
      return `<option value="${escAttr(x.name)}"${cur===x.name?' selected':''}>${prefix}${escAttr(x.name)}${dup}</option>`;
    };
    let html=`<option value="—"${cur==='—'?' selected':''}>（无 / 游离人力）</option>`;
    if(onDuty.length) html+=`<optgroup label="在岗正编">`+onDuty.map(x=>optOf(x,'')).join('')+`</optgroup>`;
    if(vacRegs.length) html+=`<optgroup label="暂缺正编坑位（尚未到岗）">`+vacRegs.map(x=>optOf(x,'⏳ ')).join('')+`</optgroup>`;
    sel.innerHTML=html;
    sel.onpointerdown=e=>e.stopPropagation();
    sel.onclick=e=>e.stopPropagation();
    sel.onchange=()=>finish(true, sel.value);
    sel.onkeydown=e=>{ if(e.key==='Escape'){e.preventDefault();finish(false);} };
    sel.onblur=()=>{ setTimeout(()=>{ if(_editingLead===tag) finish(true, sel.value); },120); };
    wrap.appendChild(sel);
    tag.replaceWith(wrap);
    sel.focus();
  }else{
    // 正编「负责」结构化编辑：每个品级独立选择自己的模块（v6.17）
    const wrap=document.createElement('span');
    wrap.className='lead-edit lead-edit-struct';

    // ---- 解析当前值 ----
    const curChars = (m.leadChars||'').split(',').filter(Boolean);
    const curMods  = (m.leadMods||'').split(',').filter(Boolean);
    // 旧格式回退解析器
    function parseLeadFallback(txt){
      if(!txt || txt==='暂缺' || txt==='—') return {chars:[],mods:[]};
      const raw=(txt||'').trim();
      const cSet=new Set(CHAR_OPTS_LIST);
      const mSet=new Set(MOD_OPTS_LIST);
      const pi=raw.indexOf(' · ');
      let cRaw='', mRaw='';
      if(pi>0){ cRaw=raw.slice(0,pi); mRaw=raw.slice(pi+3); }
      else{ cRaw=raw; }
      const chars=cRaw.split('+').map(s=>s.trim().replace(/[①②③④⑤]$/,'')).filter(s=>cSet.has(s));
      const finalChars=chars.length?chars:[...cSet].filter(c=>raw.includes(c));
      const mp=mRaw.split('/').filter(Boolean);
      const mods=[];
      for(let i=0;i<mp.length;i++){
        const cur=mp[i], nxt=mp[i+1];
        if(nxt!==undefined && mSet.has(cur+'/'+nxt)){ mods.push(cur+'/'+nxt); i++; }
        else if(mSet.has(cur)){ mods.push(cur); }
      }
      return {chars:finalChars,mods};
    }
    const fb=(!curChars.length||!curMods.length)?parseLeadFallback(m.lead||''):{chars:[],mods:[]};
    const effChars=curChars.length?curChars:fb.chars;
    const effMods=curMods.length?curMods:fb.mods;

    // ---- 构建/恢复 leadMap（每品级→专属模块列表）----
    // 优先用已有的 leadMap；否则从扁平列表推导（均分模块到各品级，兼容旧数据）
    let leadMap;
    if(m.leadMap && Array.isArray(m.leadMap)){
      leadMap=m.leadMap.slice();
      // 确保所有当前品级都在 map 中（防止数据不一致）
      effChars.forEach(c=>{ if(!leadMap.find(x=>x.c===c)) leadMap.push({c:c,m:[]}); });
    }else{
      // 从扁平格式推导：把模块大致均分到各品级（与旧显示逻辑一致）
      leadMap=effChars.map((c,i)=>{
        const start=Math.round(i*effMods.length/effChars.length);
        const end=Math.round((i+1)*effMods.length/effChars.length);
        return {c:c, m:effMods.slice(start,end)};
      });
    }

    // ---- UI：每行 = 品级勾选 + 自定义标签 + 该品级的模块多选 ----
    const grid=document.createElement('div'); grid.className='le-grid';

    // 表头
    const hdr=document.createElement('div'); hdr.className='le-hdr';
    hdr.innerHTML='<span class="le-lbl">品级</span><span class="le-lbl" style="flex:1;text-align:left">显示名<span class="le-hint">（留空=自动序号）</span></span><span class="le-lbl">模块</span>';
    grid.appendChild(hdr);

    // 每个品级一行
    const rowEls={};
    const labelInputs={};   // 保存各品级的 label input 引用
    CHAR_OPTS_LIST.forEach(c=>{
      const row=document.createElement('div'); row.className='le-row';
      const active=leadMap.some(x=>x.c===c);
      const entry=leadMap.find(x=>x.c===c);
      const modSet=new Set(entry?entry.m:[]);
      const customLabel=(entry&&entry.label)?entry.label:'';

      // 左列：品级勾选
      const chk=document.createElement('div'); chk.className='le-char-ck';
      chk.innerHTML=`<span class="le-opt${active?' sel':''}"><span class="le-chk">${active?'✓':''}</span><span>${c}</span></span>`;
      chk.querySelector('.le-opt').onclick=e=>{e.stopPropagation();
        const idx=leadMap.findIndex(x=>x.c===c);
        if(idx>=0){ leadMap.splice(idx,1); }
        else{ leadMap.push({c:c,m:[],label:''}); }
        rebuildGrid();
      };
      row.appendChild(chk);

      // 中列：自定义显示名（可编辑文本框）
      const lblArea=document.createElement('div'); lblArea.className='le-lbl-area'+(active?'':' le-hidden');
      const lblInput=document.createElement('input'); lblInput.type='text'; lblInput.className='le-label-input';
      lblInput.placeholder=c+'①';   // 提示用户留空则自动序号
      lblInput.value=customLabel;
      lblInput.onpointerdown=e=>e.stopPropagation();
      lblInput.oninput=e=>{e.stopPropagation();
        const entry2=leadMap.find(x=>x.c===c);
        if(entry2) entry2.label = lblInput.value.trim();
      };
      lblArea.appendChild(lblInput);
      labelInputs[c]=lblInput;
      row.appendChild(lblArea);

      // 右列：该品级的模块多选（仅当品级选中时显示）——通用从 HR 角色线动态提取
      const modArea=document.createElement('div'); modArea.className='le-mod-area'+(active?'':' le-hidden');
      const modSel=document.createElement('div'); modSel.className='le-sel le-sel-mod';
      const gradeMods = modOptsForGrade(c);
      gradeMods.forEach(md=>{
        const opt=document.createElement('div');
        opt.className='le-opt'+(modSet.has(md)?' sel':'');
        opt.innerHTML=`<span class="le-chk">${modSet.has(md)?'✓':''}</span><span>${md}</span>`;
        opt.onclick=e=>{e.stopPropagation();
          const entry2=leadMap.find(x=>x.c===c);
          if(!entry2)return;
          const mi=entry2.m.indexOf(md);
          if(mi>=0)entry2.m.splice(mi,1); else entry2.m.push(md);
          rebuildGrid();
        };
        modSel.appendChild(opt);
      });
      modArea.appendChild(modSel);
      row.appendChild(modArea);
      rowEls[c]=row;
      grid.appendChild(row);
    });

    function rebuildGrid(){
      CHAR_OPTS_LIST.forEach(c=>{
        const row=rowEls[c]; if(!row)return;
        const active=leadMap.some(x=>x.c===c);
        const entry=leadMap.find(x=>x.c===c);
        const modSet=new Set(entry?entry.m:[]);
        // 更新品级勾选状态
        const ckOpt=row.querySelector('.le-char-ck .le-opt');
        if(active){ ckOpt.classList.add('sel'); ckOpt.querySelector('.le-chk').textContent='✓'; }
        else{ ckOpt.classList.remove('sel'); ckOpt.querySelector('.le-chk').textContent=''; }
        // 更新标签区域可见性
        const lblArea=row.querySelector('.le-lbl-area');
        if(active)lblArea.classList.remove('le-hidden'); else lblArea.classList.add('le-hidden');
        // 更新模块区域可见性 + 勾选状态
        const modArea=row.querySelector('.le-mod-area');
        if(active)modArea.classList.remove('le-hidden'); else modArea.classList.add('le-hidden');
        modArea.querySelectorAll('.le-sel .le-opt').forEach(opt=>{
          const md=opt.querySelector('span:last-child').textContent;
          if(modSet.has(md)){opt.classList.add('sel');opt.querySelector('.le-chk').textContent='✓';}
          else{opt.classList.remove('sel');opt.querySelector('.le-chk').textContent='';}
        });
      });
    }

    const ok=document.createElement('button'); ok.className='lk ok'; ok.textContent='✓';
    const cc=document.createElement('button'); cc.className='lk cancel'; cc.textContent='✕';

    [grid,ok,cc].forEach(el=>{ el.onpointerdown=e=>e.stopPropagation(); el.onclick=e=>e.stopPropagation(); });
    ok.onclick=e=>{e.stopPropagation();finish(true);};
    cc.onclick=e=>{e.stopPropagation();finish(false);};
    const finish=(commit)=>{
      if(commit){
        // 从 leadMap 推导扁平字段（向后兼容）
        const newLeadChars = leadMap.map(x=>x.c).join(',');
        const newLeadMods  = leadMap.flatMap(x=>x.m).join(',');
        // 组合 lead 文本
        let newLeadText = '';
        leadMap.forEach(entry=>{
          if(newLeadText)newLeadText+=' + ';
          newLeadText+=entry.c;
          if(entry.m.length)newLeadText+=' · '+entry.m.join('/');
        });
        if(newLeadText !== (m.lead||'')){
          pushHistory();
          m.lead = newLeadText || '—';
          m.leadChars = newLeadChars;
          m.leadMods = newLeadMods;
          m.leadMap = leadMap;   // ★ v6.17: 保存结构化配对
          m.role='正编·带队'+(newLeadChars?' '+newLeadChars:'')+(newLeadMods?'·'+newLeadMods:'');
          _logDesc='把「'+m.name+'」负责改为'+newLeadText||'(空)';
          save();broadcast();
        }
      }
      _editingLead=null;
      rerender();
    };
    wrap.appendChild(grid);
    wrap.appendChild(ok);     wrap.appendChild(cc);
    tag.replaceWith(wrap);
    grid.focus();
  }
}
/* 正编「带队负责」常用预设：品级 + 模块组合，供 datalist 提示 */
const LEAD_PRESETS=['金','金·出场/联调','橙','橙·检视/组队','红','红·本体/3C/MVP','金+橙','金+红','检视 / 组队 / 饰品','武器特效'];

/* 「新增需求」里：角色名 / 模块 改动时，自动把「角色短名 + 模块」回填到需求名称。
   仅当用户没手动编辑过名称(data-touched 为空)时才自动同步，避免覆盖手填内容。 */
function syncReqName(){
  const nm=document.getElementById('nrName'); if(!nm) return;
  if(nm.dataset.touched==='1') return;                 // 用户已手动填写 → 不覆盖
  const ch=(document.getElementById('nrChar').value||'').trim();
  const md=(document.getElementById('nrMod').value||'').trim();
  const auto=composeReqName(ch,md);
  nm.value=auto;                                       // 仅作预览占位，不算用户输入
}
/* 由角色名 + 模块合成需求名称：角色取短名(去品级线/联动CP尾巴)，与模块短名以空格相连。 */
function composeReqName(ch,md){
  const short=charShort(ch)||'';
  const ms=(md? (modMeta(md).s||md) : '');             // 模块短名(如「出场」「检视/组队」)
  return [short,ms].filter(Boolean).join(' ').trim();
}
function openNewReq(){
  if(!requireWrite())return;
  addCtx={mode:'newReq'};
  const gradeOpt=['金','橙','红','通用',''].map(g=>`<option value="${g}" ${g==='橙'?'selected':''}>${g===''?'游离':g==='通用'?'通用':g+'级'}</option>`).join('');
  const modOpt=MOD_OPTS_LIST.map(m=>`<option value="${m}" ${m==='出场'?'selected':''}>${m}</option>`).join('');
  const lineOpt=LINE_OPTS_LIST.map(l=>`<option value="${l[0]}">${l[1]}</option>`).join('');
  const today=dInput(TODAY), end60=dInput(i2d(Math.min(idx(TODAY)+40,DAYS)));
  const selMem0 = selectedMem && members.find(m=>m.id===selectedMem);
  const memHint = selMem0
    ? `<div class="ctx" style="background:#eef6ff;border-color:#bcd9f7;color:#185fa5">📌 将默认把制作人指派给当前选中的 <b>${effEsc(memName(selMem0.id))}</b>（新需求会直接挂到他/她那一行；如不需要可在创建后改派）。</div>`
    : '';
  const body=`
    <div class="ctx">添加一条<b>新需求</b>。提交后出现在「按需求看」列表中，可再用行内「＋加人」分配制作人。纳入本地 / 团队链接 / 云端同步。</div>
    ${memHint}
    <div class="row2">
      <div class="fld"><label>需求名称 <small style="font-weight:400;color:#8a93a3">可留空，自动＝角色＋模块</small></label><input type="text" id="nrName" placeholder="留空将自动用「角色 模块」合成" oninput="this.dataset.touched=this.value.trim()?'1':''"></div>
      <div class="fld"><label>角色名</label><input type="text" id="nrChar" placeholder="如：红蔻·赤焰" oninput="syncReqName()"></div>
    </div>
    <div class="row2">
      <div class="fld"><label>模块</label><select id="nrMod" onchange="syncReqName()">${modOpt}</select></div>
      <div class="fld"><label>品级</label><select id="nrGrade">${gradeOpt}</select></div>
    </div>
    <div class="row2">
      <div class="fld"><label>管线</label><select id="nrLine">${lineOpt}</select></div>
      <div class="fld"><label>工作量（人天）</label><input type="number" id="nrEst" value="20" min="1" step="1"></div>
    </div>
    <div class="row2">
      <div class="fld"><label>开始日期</label><input type="date" id="nrStart" min="${G_MIN}" max="${G_MAX}" value="${today}"></div>
      <div class="fld"><label>结束日期</label><input type="date" id="nrEnd" min="${G_MIN}" max="${G_MAX}" value="${end60}"></div>
    </div>
    <div class="fld" style="margin-top:2px"><label>评论（可选）<small style="font-weight:400;color:#8a93a3">备注 / 风险提示 / 协同说明，将随需求一起显示与同步</small></label><textarea id="nrComment" rows="2" placeholder="留空则不显示评论徽标"></textarea></div>
    <div class="warn" id="nrWarn"></div>`;
  renderAddModal('📋', '添加新需求', body, true);
  const ok=document.getElementById('addOk'); if(ok)ok.setAttribute('onclick','confirmNewReq()');
}
function confirmNewReq(){
  if(!requireWrite())return;
  const nmEl=document.getElementById('nrName');
  const charV=(document.getElementById('nrChar').value||'').trim();
  const modV=document.getElementById('nrMod').value;
  // 名称：用户手填则用手填值；留空(或仅自动预览)则用「角色短名 + 模块」自动合成
  let name=(nmEl.value||'').trim();
  if(nmEl.dataset.touched!=='1' || !name) name=composeReqName(charV,modV)||name;
  const warn=document.getElementById('nrWarn');
  if(!name){ warn.textContent='请填写需求名称，或填写角色名与模块以自动合成'; warn.classList.add('show'); return; }
  const sd=parseInput(document.getElementById('nrStart').value), ed=parseInput(document.getElementById('nrEnd').value);
  if(!sd||!ed||ed<sd){ warn.textContent='请选择有效的起止日期（结束不早于开始）'; warn.classList.add('show'); return; }
  const est=Math.max(1,parseInt(document.getElementById('nrEst').value,10)||20);
  pushHistory();
  /* v6.55 输入框「含末日」→ +1 天还原为底层排他终点 */
  const ns=Math.max(0,Math.min(idx(sd),DAYS-1)), ne=Math.max(ns+1,Math.min(idx(ed)+1,DAYS));
  const r={
    id:genId('r_'), name,
    char:(document.getElementById('nrChar').value||'').trim()||name,
    mod:document.getElementById('nrMod').value,
    grade:document.getElementById('nrGrade').value,
    line:document.getElementById('nrLine').value,
    kind:'fx', estimate:est, done:0, end:i2d(ne),
    comment:(document.getElementById('nrComment').value||'').trim(),
    segs:[]   // 新需求暂无制作人，用一段占位窗口保证可见（指向第一位成员但 0 进度，可随后改派/删除）
  };
  // 占位 seg：用一名在岗成员承载时间窗口，避免 segs 为空导致 min/max 报错；用户随后用「＋加人」替换。
  // 优先用当前选中的人员行（selectedMem）作为制作人，实现「新需求挂到选中的那一行」。
  const selMem = selectedMem && members.find(m=>m.id===selectedMem);
  const holder = selMem || members.find(m=>m.status==='on') || members[0];
  r.segs.push({m:holder.id, s:i2d(ns), e:i2d(ne), prog:0, status:'todo'});
  reqs.push(r);
  _logDesc='新增需求：'+r.name;
  save();broadcast();closeAdd();
  if(view!=='req'){ const vt=document.querySelector('#viewTabs button:nth-child(2)'); if(vt)setView('req',vt); }
  else rerender();
  revealEntity('req', r.id);
  toast(selMem ? `已添加新需求：${name}（已挂到 ${memName(holder.id)}，可在行内调整）` : `已添加新需求：${name}（请用「＋加人」分配制作人）`);
}


/* ============ toast ============ */
const toastEl=document.getElementById('toast');let toastT=null;
function toast(msg){toastEl.textContent=msg;toastEl.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>toastEl.classList.remove('show'),1800);}

/* ============ 本地保存 / 协同广播 ============ */
const KEY='gantt_collab_v7_mod';
/* ============ 变更记录（留痕 + 回退历史版本） ============
   CHANGELOG 每条 = {id, t:时间戳, who:操作人, desc:做了什么, snap:当时的完整排期(core)}。
   它被塞进 snapshot()._log，随 本地缓存/分享链接/云端 三链路自动持久化与同步，
   因此全团队都能看到同一份变更记录，并可一键回退到任意历史版本。 */
let CHANGELOG=[]; let _logSeq=0; let _logDesc='';
const LOG_MAX=120;
/* localStorage 通常只有约 5–10MB 配额；每条日志都带完整 coreSnapshot，120 条会让本地副本膨胀到数 MB。
   云端仍保留 120 条，本地仅保留最近 40 条，确保业务数据与最近恢复点能稳定落盘。 */
const LOCAL_LOG_MAX=40;
let _saveWarned=false;
function mergeLog(incoming){
  if(!Array.isArray(incoming)||!incoming.length)return;
  const indexById=new Map(CHANGELOG.map((e,i)=>[e.id,i]));
  let changed=false;
  incoming.forEach(e=>{
    if(!e||!e.id)return;
    const i=indexById.get(e.id);
    if(i===undefined){
      CHANGELOG.push(e); indexById.set(e.id,CHANGELOG.length-1); changed=true;
    }else if((e.t||0)>(CHANGELOG[i].t||0)){
      // recordLog 会在 1.5 秒内复用同一 id 并更新 t/snap；相同 id 必须保留更新版本，不能只做去重。
      CHANGELOG[i]=e; changed=true;
    }
  });
  if(changed){
    CHANGELOG.sort((a,b)=>a.t-b.t);
    if(CHANGELOG.length>LOG_MAX) CHANGELOG.splice(0,CHANGELOG.length-LOG_MAX);
    if(typeof renderLogPanel==='function' && document.getElementById('logPanel')) renderLogPanel();
  }
}
function snapshot(){
  const s=coreSnapshot();
  s._log=CHANGELOG.slice(-LOG_MAX);
  return s;
}
function coreSnapshot(){
  return {
    // 成员：除原有 status 外，序列化全部字段，使「新增成员」可在刷新/分享/云端后保留
    members:members.map(m=>({id:m.id,name:m.name,role:m.role||'',corp:m.corp,lead:m.lead,mod:m.mod||'',grade:m.grade||'',line:m.line||'-',eff:m.eff,status:m.status,support:!!m.support,tmp:!!m.tmp,leftAt:(m.leftAt?idx(m.leftAt):null),leadChars:m.leadChars||'',leadMods:m.leadMods||'',leadMap:m.leadMap||null,sort:(m.sort!=null?m.sort:null),
      // v7.48 借调记录：loan=当前生效借调，loanRecs=历史归档（只增不改）。漏了这两键 → 云端同步后历史蒸发。
      loan:serializeLoan(m.loan||null),
      loanRecs:(Array.isArray(m.loanRecs)?m.loanRecs.map(serializeLoan):[])})),
    effTiers:EFF_TIERS.map(t=>({coef:t.coef,label:t.label,mems:(t.mems||[]).slice()})),
    effLocked:effLocked,
    stdCfg:STD_CFG.map(t=>({mod:t.mod||'',grade:t.grade,col:t.col,dur:t.dur||'',weeks:t.weeks,ppl:t.ppl})),
    stdLocked:stdLocked,
    invTiers:INV_TIERS.map(t=>({key:t.key,name:t.name,val:t.val,lo:t.lo,hi:t.hi,col:t.col,vbg:t.vbg,vfg:t.vfg,desc:t.desc,scene:t.scene})),
    invLocked:invLocked,
    archive:{on:ARCHIVE.on,val:ARCHIVE.val,unit:ARCHIVE.unit},
    hideDone:{person:HIDE_DONE.person, req:HIDE_DONE.req, hr:HIDE_DONE.hr},
    estRecalc:estRecalc,
    estRecalcVer:estRecalcVer,
    groupMode:{person:GROUP_MODE.person,req:GROUP_MODE.req},
    snapVer:SNAP_VER,                                    // v6.56 标记本快照为「含末日存储」
    // 需求：除原有 end/done/split 外，序列化全部字段，使「新增需求」持久化
    // v6.56：end / seg.e 写出时 -1，由内存的排他终点转为存储的含末日（open 段无实义窗口，同样转换以保持可逆）
    reqs:reqs.map(r=>({id:r.id,name:r.name,char:r.char||'',mod:r.mod||'',grade:r.grade||'',line:r.line||'-',kind:r.kind||'fx',state:r.state||'active',estimate:r.estimate,end:eOut(idx(r.end)),done:r.done,split:(r.split!=null?r.split:null),split2:(r.split2!=null?r.split2:null),comment:(r.comment||''),
      segs:r.segs.map(s=>({m:s.m,s:idx(s.s),e:eOut(idx(s.e)),prog:s.prog,status:s.status,support:!!s.support,open:segOpenType(s)||false,...(s.inv!=null?{inv:s.inv}:{})})),
      /* ★ v7.49 关键节点持久化修复：milestones 自 v7.43 引入起就漏了这一键，
           导致新增/编辑/拖拽改期/删除全部只停留在内存，刷新、分享链接、云端同步后一律蒸发。
           date 存 Date 对象，必须走 idx() 转日索引（与 leftAt / loan 同式）——
           直接 JSON.stringify 塞 Date 会存成 ISO 字符串，读回是字符串而非 Date，渲染与拖拽全崩。
           全量写出（含空数组）：空数组代表「节点已全部删除」，须忠实落盘。 */
      milestones:(r.milestones||[]).map(ms=>({date:idx(ms.date),label:ms.label||'',color:ms.color||'',type:ms.type||'custom'}))}))
  };
}
function applySnap(snap){
  if(!snap)return;
  /* v6.56 口径识别：snapVer>=2 的快照存的是「含末日」，读入需 +1 还原成内存用的排他终点；
     旧快照（无 snapVer）本就是排他式，原样读入 → 首次保存时自动升级为新格式，无需手工迁移。 */
  const _ver = Number(snap.snapVer||1);
  _snapVerIn = _ver;
  // 合并对方带来的变更记录（去重、按时间排序），使留痕在全团队一致
  if(Array.isArray(snap._log)) mergeLog(snap._log);
  // 成员：按 id 更新现有；找不到则视为「新增成员」push 进数组（保证新建成员跨刷新/分享/云端不丢）
  (snap.members||[]).forEach(ms=>{
    let m=members.find(x=>x.id===ms.id);
    if(m){
      // 已存在：仅更新可变字段（状态等）；保留原有静态信息为主，但同步快照里的关键字段
      m.status=ms.status!=null?ms.status:m.status;
      if(ms.name!=null)m.name=ms.name;
      if(ms.role!=null)m.role=ms.role;
      if(ms.corp!=null)m.corp=ms.corp;
      if(ms.lead!=null)m.lead=ms.lead;
      if(ms.mod!=null)m.mod=ms.mod;
      if(ms.grade!=null)m.grade=ms.grade;
      if(ms.line!=null)m.line=ms.line;
      if(ms.eff!=null)m.eff=ms.eff;
      if(ms.support!=null)m.support=!!ms.support;
      if(ms.tmp!=null)m.tmp=!!ms.tmp;
      if(ms.leftAt!==undefined)m.leftAt=(ms.leftAt==null?null:i2d(ms.leftAt));
      // ★ v5.83 持久化修复：负责(leadChars/leadMods)结构化字段也要随快照/云端同步，否则刷新后丢失
      if(ms.leadChars!=null)m.leadChars=ms.leadChars;
      if(ms.leadMods!=null)m.leadMods=ms.leadMods;
      // ★ v6.17: leadMap（品级→模块配对）同步
      if(ms.leadMap!==undefined)m.leadMap=(ms.leadMap==null?null:ms.leadMap);
      // ★ v7.24: sort（手动/智能排序序号）同步
      if(ms.sort!==undefined)m.sort=(ms.sort==null?null:ms.sort);
      // ★ v7.48: 借调记录同步（loan=当前生效 / loanRecs=历史归档）。缺此步 → 云端覆盖后借调历史丢失。
      if(ms.loan!==undefined) m.loan=deserializeLoan(ms.loan);
      if(Array.isArray(ms.loanRecs)) m.loanRecs=ms.loanRecs.map(deserializeLoan);
    }else if(ms.name){
      const nm={id:ms.id,name:ms.name,role:ms.role||'',corp:ms.corp||'base',lead:ms.lead||'—',mod:ms.mod||'',grade:ms.grade||'',line:ms.line||'-',eff:(ms.eff!=null?ms.eff:1.0),status:ms.status||'on',leadChars:ms.leadChars||'',leadMods:ms.leadMods||'',leadMap:ms.leadMap||null};
      if(ms.support)nm.support=true;
      if(ms.tmp)nm.tmp=true;
      if(ms.leftAt!=null)nm.leftAt=i2d(ms.leftAt);
      if(ms.sort!=null)nm.sort=ms.sort;
      // v7.48 借调记录（新增成员路径同样要带，否则云端新增的借入人员会丢记录）
      nm.loan=deserializeLoan(ms.loan||null);
      nm.loanRecs=Array.isArray(ms.loanRecs)?ms.loanRecs.map(deserializeLoan):[];
      members.push(nm);
    }
  });
  if(Array.isArray(snap.effTiers)){
    EFF_TIERS=snap.effTiers.map(t=>({coef:Number(t.coef),label:t.label||'',mems:Array.isArray(t.mems)?t.mems.slice():[]}));
    syncEffFromTiers();
  }
  if(typeof snap.effLocked==='boolean') effLocked=snap.effLocked;
  if(Array.isArray(snap.stdCfg)){
    STD_CFG=snap.stdCfg.map(t=>({mod:t.mod||'',grade:t.grade||'',col:t.col||'#7048e8',dur:t.dur||'',weeks:t.weeks||'',ppl:t.ppl||''}));
  }
  if(typeof snap.stdLocked==='boolean') stdLocked=snap.stdLocked;
  if(Array.isArray(snap.invTiers) && snap.invTiers.length){
    // v5.11 区间迁移：旧快照只有 val（=独占上限 hi），补 lo/hi。
    //   hi>=1(全人力)→lo=0；完整跟进档(hi≈0.4~0.6)→lo=0.4；部分跟进档(hi≈0.1~0.3)→lo=0.1；其它跟进→lo=hi*0.5。
    const _migLo=(hi)=>{ if(hi>=1)return 0; if(hi>=0.4)return 0.4; if(hi>=0.1)return Math.min(0.1,hi); return Math.round(hi*0.5*100)/100; };
    INV_TIERS=snap.invTiers.map(t=>{
      const hi=(t.hi!=null?Number(t.hi):Number(t.val));
      const lo=(t.lo!=null?Number(t.lo):_migLo(hi));
      return {key:t.key||('inv'+Math.random().toString(36).slice(2,7)),name:t.name||'',val:hi,lo:lo,hi:hi,col:t.col||'#0a7d3c',vbg:t.vbg||'#e9f8ee',vfg:t.vfg||'#0a7d3c',desc:t.desc||'',scene:t.scene||''};
    });
    // 迁移：「并行人力制作」已改为自动状态（全人力并行时自动 1/N 平摊），不再作为可手动设置的固定档位 → 剔除残留旧档
    INV_TIERS=INV_TIERS.filter(t=>!/并行人力/.test(t.name||''));
    if(!INV_TIERS.length) INV_TIERS=[{key:'full',name:'全人力制作',val:1.0,lo:0,hi:1.0,col:'#0a7d3c',vbg:'#e9f8ee',vfg:'#0a7d3c',desc:'全力投入单条产出（独占 1.0）。并行多条时自动平摊为 1/N。',scene:''}];
    if(typeof syncInvSelectHTML==='function') syncInvSelectHTML();
  }
  if(typeof snap.invLocked==='boolean') invLocked=snap.invLocked;
  if(snap.archive){
    const a=snap.archive;
    if(typeof a.on==='boolean')ARCHIVE.on=a.on;
    if(a.unit){ ARCHIVE.unit=a.unit; ARCHIVE.val=(a.val!=null?a.val:2); }
    else if(a.days!=null){ ARCHIVE.unit='day'; ARCHIVE.val=a.days; }   // 兼容旧快照
  }
  // 默认显示已完成（不再自动隐藏）；兼容旧快照(boolean)和新格式(per-view object)
  if(snap.hideDone){
    if(typeof snap.hideDone === 'boolean'){ HIDE_DONE.person=HIDE_DONE.req=HIDE_DONE.hr=snap.hideDone; }
    else if(typeof snap.hideDone === 'object'){
      if(typeof snap.hideDone.person==='boolean')HIDE_DONE.person=snap.hideDone.person;
      if(typeof snap.hideDone.req==='boolean')HIDE_DONE.req=snap.hideDone.req;
      if(typeof snap.hideDone.hr==='boolean')HIDE_DONE.hr=snap.hideDone.hr;
    }
  }
  syncHideDoneCheckbox();
  if(snap.groupMode){ if(snap.groupMode.person)GROUP_MODE.person=snap.groupMode.person; if(snap.groupMode.req)GROUP_MODE.req=snap.groupMode.req; }
  if(typeof snap.estRecalc==='boolean') estRecalc=snap.estRecalc;
  if(typeof snap.estRecalcVer==='number') estRecalcVer=snap.estRecalcVer;
  (snap.reqs||[]).forEach(rs=>{
    let r=reqs.find(x=>x.id===rs.id);
    if(!r && rs.name){
      // 新增需求：按快照重建（含 segs），push 进数组
      // v7.49：milestones 一并重建，否则云端新建的需求首次读回会缺字段（节点渲染/拖拽对 undefined 容错不足）
      r={id:rs.id,name:rs.name,char:rs.char||'',mod:rs.mod||'',grade:rs.grade||'',line:rs.line||'-',kind:rs.kind||'fx',state:rs.state||'active',estimate:rs.estimate||1,done:rs.done||0,end:i2d(rs.end!=null?eIn(rs.end,_ver):idx(TODAY)),segs:[],comment:rs.comment||'',
        milestones:Array.isArray(rs.milestones)?rs.milestones.map(ms=>({date:i2d(ms.date),label:ms.label||'',color:ms.color||'',type:ms.type||'custom'})):[]};
      reqs.push(r);
    }
    if(!r)return;
    if(rs.state!==undefined){ if(rs.state&&rs.state!=='active')r.state=rs.state; else delete r.state; }
    if(rs.end!=null) r.end=i2d(eIn(rs.end,_ver));
    if(rs.done!==undefined)r.done=rs.done;
    if(rs.estimate!==undefined)r.estimate=rs.estimate;
    if(rs.name!=null)r.name=rs.name;
    if(rs.char!=null)r.char=rs.char;
    if(rs.mod!=null)r.mod=rs.mod;
    if(rs.grade!=null)r.grade=rs.grade;
    if(rs.line!=null)r.line=rs.line;
    if(rs.kind!=null)r.kind=rs.kind;
    if(rs.comment!=null)r.comment=rs.comment;
    if(rs.split!==undefined) r.split=(rs.split==null?undefined:rs.split);   // L1/L2 分割点（绝对日索引）
    if(rs.split2!==undefined) r.split2=(rs.split2==null?undefined:rs.split2); // L2/联调 分割点（绝对日索引）
    // 全量重建 segs（不再按下标合并）：保证「新增/删除人员段」在刷新、分享链接、跨标签同步后都不丢失
    if(Array.isArray(rs.segs)){
      r.segs=rs.segs.map(ss=>{const o={m:ss.m,s:i2d(ss.s),e:i2d(eIn(ss.e,_ver)),prog:ss.prog,status:ss.status};if(ss.support)o.support=true;if(ss.open)o.open=(ss.open===true?'both':(ss.open==='front'||ss.open==='back'||ss.open==='both'?ss.open:'both'));if(ss.inv!=null)o.inv=ss.inv;return o;});
    }
    /* ★ v7.49 关键节点读回（与 segs 同为「全量重建」语义）：
         · 字段是数组 → 忠实恢复，空数组代表节点已全删（不是"不处理"）
         · 字段缺失（旧快照）→ 不处理，保留内存现有值（向下兼容，老数据不会被清空）
       date 用 i2d() 还原为 Date，保证渲染 / 拖拽改期 / 虚线定位全部可用。 */
    if(Array.isArray(rs.milestones)){
      r.milestones=rs.milestones.map(ms=>({date:i2d(ms.date),label:ms.label||'',color:ms.color||'',type:ms.type||'custom'}));
    }
  });
  // 同步归档/分组控件 UI
  syncOrgUI();
  // 全量快照一致性：只要字段存在，空数组也代表“全部删除”，必须忠实恢复；字段缺失才表示不处理。
  if(Array.isArray(snap.members)){
    const keep=new Set(snap.members.map(x=>x.id));
    for(let i=members.length-1;i>=0;i--){ if(!keep.has(members[i].id)) members.splice(i,1); }
  }
  if(Array.isArray(snap.reqs)){
    const keepR=new Set(snap.reqs.map(x=>x.id));
    for(let i=reqs.length-1;i>=0;i--){ if(!keepR.has(reqs[i].id)) reqs.splice(i,1); }
  }
  // 按现存需求重建联调挂载关系（使「他人删除联调 / 撤销恢复」在本端正确反映）
  if(typeof relinkLt==='function') relinkLt();
  // v5.11 投入比区间模型迁移：任何来源(本地/云端/分享)的快照应用后都执行一次，把旧档上限/旧 seg.inv 升到新区间。
  if(typeof migrateInvModel==='function') migrateInvModel();
}
/* ============ v7.48 存量外借人员 → 正式外借记录（幂等，可重复调用）============
   背景：v7.48 之前「外借」没有独立数据，仅由 support 布尔 + lead='—' 推断出来，
   无法记录「借给谁 / 何时开始 / 何时到期 / 回归时还原到哪」。
   本函数把这类存量人员自动升级为带快照的正式借调记录。

   ⚠️ 关键约束：**只新增字段，绝不改动 support / lead / corp / mod 任何现有值**。
   因此 isExtLoan() 在迁移前后的返回值完全相同 —— corpStyle / personGroupKey /
   personSortCompare / computeHR / renderHR / updateKPIs 等 9 处调用点行为零变化，
   KPI 与 HR 统计数字严格不变（验收 #1）。

   快照取值：以「当前值」拍快照（历史数据没记录外借前的状态，当前编制状态是最合理推定），
   回归时弹层会预填这些值并允许用户改动（验收 #3）。
   to=null（存量无约定结束日 → 长期未定），因此**不会**被 scanLoanExpiry 自动封存。 */
function _migrateLoanRecords(){
  let n=0;
  members.forEach(m=>{
    if(!m || m.loan || Array.isArray(m.loanRecs)) return;   // 已迁移过 / 已有记录，跳过
    if(!m.support) return;                                   // 非支援人员
    if(m.lead && m.lead!=='—' && m.lead!=='-') return;       // 有角色线归属 → 属「跨队支援」，非外借
    const lead0=(m.lead && m.lead!=='—' && m.lead!=='-') ? m.lead : '—';
    m.loanRecs=[];
    m.loan={
      id:newLoanId(),
      dir:'out',
      party:(m.mod||'其他管线'),
      from:null,                    // 存量无起始日记录，留空
      to:null,                      // 存量无约定结束日 → 长期未定，不触发自动封存
      mod:(m.mod||''),
      note:'由历史「外借支援」标记自动迁移',
      snap:{corp:(m.corp||'base'), lead:lead0, mod:(m.mod||''), grade:(m.grade||''), line:(m.line||'-')},
      state:'active', endAt:null, endBy:null,
      migrated:true,                // 标记迁移来源，便于回溯
    };
    n++;
  });
  if(n){ save(); console.log('[v7.48] 自动迁移外借记录',n,'条'); }
  return n;
}

/* ============ v7.48 到期外借记录自动封存（幂等，只改 state）============
   语义提醒：封存 = **记录**归档，**人还在外面**（不动编制、不动 lead、不改 status）。
   只把 state 从 active 改为 sealed，使其不再计入「活跃外借」（isExtLoan 转 false）。
   ⚠️ 绝不可在此处改人 —— 自动任务悄悄改业务数据会引发统计口径漂移。 */
function scanLoanExpiry(){
  let n=0;
  members.forEach(m=>{
    const L=m && m.loan;
    if(!L || L.state!=='active' || !L.to || L.dir!=='out') return;
    if(TODAY > L.to){ L.state='sealed'; L.endBy='seal:auto'; L.endAt=L.to; n++; }
  });
  if(n){ save(); toast(`已自动封存 ${n} 条到期外借记录`); }
  return n;
}

/* 投入比区间模型迁移：把历史值升级到 v5.11 区间口径，幂等可重复调用。
   · INV_TIERS：完整跟进 hi 0.4/0.5→0.6、lo→0.4；部分跟进 hi 0.2→0.3、lo→0.1；缺 lo/hi 的补齐。
   · seg.inv（记录档上限）：0.4/0.5→0.6、0.2→0.3。仅命中旧默认值，自定义区间值不动。 */
function migrateInvModel(){
  if(estRecalcVer>=EST_RECALC_VER) return;           // 已迁移到最新口径，跳过
  INV_TIERS.forEach(t=>{
    const hi0=(t.hi!=null?t.hi:t.val);
    if(Math.abs(hi0-0.5)<1e-6||Math.abs(hi0-0.4)<1e-6){ t.val=0.6; t.hi=0.6; t.lo=0.4; }        // 完整跟进
    else if(Math.abs(hi0-0.2)<1e-6){ t.val=0.3; t.hi=0.3; t.lo=0.1; }                           // 部分跟进
    else { t.hi=hi0; if(t.lo==null) t.lo=(hi0>=1?0:(hi0>=0.4?0.4:(hi0>=0.1?0.1:Math.round(hi0*0.5*100)/100))); }
  });
  reqs.forEach(r=>r.segs.forEach(s=>{ if(s.inv!=null){
    if(Math.abs(s.inv-0.5)<1e-6||Math.abs(s.inv-0.4)<1e-6) s.inv=0.6;
    else if(Math.abs(s.inv-0.2)<1e-6) s.inv=0.3;
  }}));
  if(typeof recalcEstimatesFromSchedule==='function') recalcEstimatesFromSchedule();
  estRecalc=true; estRecalcVer=EST_RECALC_VER;
  if(typeof syncInvSelectHTML==='function') syncInvSelectHTML();
}
/* 把 ARCHIVE / GROUP_MODE 当前值反映到工具条控件 */
function syncOrgUI(){
  const av=document.getElementById('archiveVal'); if(av)av.value=ARCHIVE.val;
  const au=document.getElementById('archiveUnit'); if(au)au.value=ARCHIVE.unit;
  const ao=document.getElementById('archiveOn'); if(ao)ao.checked=ARCHIVE.on;
  if(typeof updateGroupSelUI==='function') updateGroupSelUI();
}
const ORIG=JSON.parse(JSON.stringify(snapshot()));
function localSnapshot(){
  const s=snapshot();
  if(Array.isArray(s._log) && s._log.length>LOCAL_LOG_MAX) s._log=s._log.slice(-LOCAL_LOG_MAX);
  return s;
}
/* 离线恢复补推时，在不改写业务字段的前提下合并本地与云端审计记录，避免 40 条本地副本截断云端 120 条历史。 */
function mergeSnapshotLogs(localSnap,remoteSnap){
  const out=JSON.parse(JSON.stringify(localSnap||{}));
  const remote=(remoteSnap&&Array.isArray(remoteSnap._log))?remoteSnap._log:[];
  const local=Array.isArray(out._log)?out._log:[];
  const byId=new Map();
  remote.concat(local).forEach(e=>{
    if(!e||!e.id)return;
    const prev=byId.get(e.id);
    if(!prev||(e.t||0)>(prev.t||0))byId.set(e.id,e);
  });
  out._log=Array.from(byId.values()).sort((a,b)=>(a.t||0)-(b.t||0)).slice(-LOG_MAX);
  return out;
}
function save(){
  try{
    localStorage.setItem(KEY,JSON.stringify(localSnapshot()));
    _saveWarned=false;
    return true;
  }catch(e){
    console.warn('local snapshot save failed',e);
    if(!_saveWarned){
      _saveWarned=true;
      toast('⚠ 本地恢复副本保存失败；云端仍会继续保存，请勿关闭页面并联系管理员');
    }
    return false;
  }
}
function loadSaved(){try{const v=localStorage.getItem(KEY);if(v)applySnap(JSON.parse(v));}catch(e){console.warn('local snapshot load failed',e);}}
function resetData(){if(!requireWrite())return;pushHistory();applySnap(JSON.parse(JSON.stringify(ORIG)));try{localStorage.removeItem(KEY);}catch(_){}_logDesc='重置为初始排期';broadcast();rerender();if(typeof applyEffLockUI==='function')applyEffLockUI();if(typeof applyStdLockUI==='function')applyStdLockUI();if(typeof applyInvLockUI==='function')applyInvLockUI();toast('已重置为初始排期');}

/* ============ Supabase 云端协作（全员实时读写 + 自动汇集，免后端） ============ */
const SB_URL='https://pwjowpkaypfwykejhosp.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3am93cGtheXBmd3lrZWpob3NwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxOTgzNTcsImV4cCI6MjA5Nzc3NDM1N30.gT0Kpi3s8JupoNT4pK4tz3RshcMfEaJoWEwBik8vV5A';
const SB_TABLE='board_state';
const SB_ROW='vfx-gantt-main';     // 单行存整份排期快照
const TEAM_PIN='vfx2026';          // 团队写入口令（可改），公开页内属软门禁：防止误改/陌生人随手改
const PIN_KEY='gantt_write_pin';
let sb=null, sbChan=null, cloudReady=false, cloudPushT=null, cloudPushEpoch=0, cloudPushRunning=false, cloudPushQueued=false, cloudWriteBusy=false, lastSyncJSON='', applyingRemote=false, hasHashSnap=false;
/* v6.39 「放弃编辑」基线：获取编辑权成功那一刻的数据快照 JSON。
   关键：持锁期间每次改动都会自动 cloudPush 到云端，所以「放弃编辑」不能靠"从云端重拉"还原
   （云端已经是改过的数据）。必须用这份进入编辑时的本地基线回滚，并把基线推回云端。 */
let editBaselineJSON='';
/* 每个页面文档使用独立 editor id。刷新也生成新 id，避免旧页面迟到的 keepalive beacon 清掉新页面租约。 */
let cloudCid='c'+Math.random().toString(36).slice(2,10);
sessionStorage.setItem('gantt_cloud_tab_cid',cloudCid);
let cloudLeaseNeedsRotate=false;
function rotateCloudCid(){
  cloudCid='c'+Math.random().toString(36).slice(2,10);
  sessionStorage.setItem('gantt_cloud_tab_cid',cloudCid);
  cloudLeaseNeedsRotate=false;
}
/* 云端离线兜底：503/网络抖动时不让看板停摆，改写 localStorage，云端恢复自动补同步。
   触发点：cloudInit 失败、tryReconnect 连续失败。退出点：tryReconnect 成功一次。 */
let cloudOffline=false;            // 当前是否在离线兜底模式
let cloudReconnTries=0;             // 连续失败次数（用于指数退避）
let cloudReconnT=null;              // 下次重试的 setTimeout 句柄
let cloudPendingPush=null;          // 离线期间最新 snapshot，重连后补推
const RECONN_DELAYS=[5000,15000,45000,180000,300000];  // 5s/15s/45s/3min/5min
/* 每个页面独立保存恢复副本，避免多个标签互相覆盖。启动时选最新一份；
   每次只删除用户刚处理的 storage key，其他标签页留下的较早副本继续逐份审核。 */
const PENDING_PREFIX='gantt_pending_snap:';
const LEGACY_PENDING_KEY='gantt_pending_snap';
const PENDING_KEY=PENDING_PREFIX+Date.now()+'-'+cloudCid;
let pendingKeySeq=0;
let cloudPendingStorageKey='', cloudPendingSavedAt=0;
function loadLatestPendingSnapshot(){
  cloudPendingPush=null; cloudPendingStorageKey=''; cloudPendingSavedAt=0;
  try{
    const candidates=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(!k||k.indexOf(PENDING_PREFIX)!==0)continue;
      const raw=localStorage.getItem(k); if(!raw)continue;
      try{
        const parsed=JSON.parse(raw);
        const wrapped=parsed&&parsed.snap&&parsed.savedAt;
        const savedAt=wrapped?Number(parsed.savedAt):(Number(k.slice(PENDING_PREFIX.length).split('-')[0])||0);
        candidates.push({key:k,savedAt:savedAt,snap:wrapped?parsed.snap:parsed});
      }catch(_){}
    }
    const legacyRaw=localStorage.getItem(LEGACY_PENDING_KEY);
    if(legacyRaw){try{candidates.push({key:LEGACY_PENDING_KEY,savedAt:1,snap:JSON.parse(legacyRaw)});}catch(_){}}
    candidates.sort((a,b)=>(b.savedAt-a.savedAt)||b.key.localeCompare(a.key));
    if(candidates.length){
      const latest=candidates[0];
      cloudPendingPush=latest.snap; cloudPendingStorageKey=latest.key; cloudPendingSavedAt=latest.savedAt;
    }
  }catch(_){}
}
function storePendingSnapshot(snap,keepSeparate){
  const compact=compactPendingSnapshot(snap);
  const savedAt=Date.now();
  // 离线连续自动保存属于同一分支，可覆盖本页固定 key；失锁/提交失败属于独立分叉，必须新建 key，避免后一次事故吞掉前一次。
  const storageKey=keepSeparate
    ?PENDING_PREFIX+savedAt+'-'+cloudCid+'-'+(++pendingKeySeq)
    :PENDING_KEY;
  const json=JSON.stringify({savedAt:savedAt,cid:cloudCid,snap:compact});
  try{
    localStorage.setItem(storageKey,json);
  }catch(firstError){
    // KEY 只是可重建的普通缓存；配额不足时优先牺牲它，为真正未同步的恢复副本腾空间。
    try{localStorage.removeItem(KEY);localStorage.setItem(storageKey,json);}catch(_){throw firstError;}
  }
  cloudPendingPush=compact; cloudPendingStorageKey=storageKey; cloudPendingSavedAt=savedAt;
  return compact;
}
function clearPendingSnapshot(){
  try{
    // 只确认当前这一份；不能用全局时间水位跳过其他标签页更早但尚未审核的独立副本。
    if(cloudPendingStorageKey)localStorage.removeItem(cloudPendingStorageKey);
  }catch(_){}
  cloudPendingPush=null; cloudPendingStorageKey=''; cloudPendingSavedAt=0;
}
loadLatestPendingSnapshot();
function cloudWho(){const m=members.find(x=>x.id===meId);return m?m.name:'某成员';}
/** v6.75 返回身份验证状态文案（用于编辑权提示等） */
function whoAmI(){
  const name = cloudWho();
  if(wecomVerified) return name + ' ✅';
  return meId ? name + '（未验证）' : '未设置身份';
}
/* ===== 编辑锁（同一时刻仅一人可编辑，其他人只读等待） =====
   机制（零SQL）：复用 board_state 已有的 editor/editor_name/updated_at 三列充当分布式互斥锁，无需新增数据库列。
   - 申请编辑 = 一条带条件的原子 UPDATE（仅当锁空闲/已过期/本就是我时才更新成功）→ 天然防并发抢占。
   - 抢到锁的人会被强制拉取并应用云端最新快照，确保永远在最新数据上编辑（满足"下一个人需被强制刷新"）。
   - 持有者每 30s 心跳续期；超过 90s 无心跳视为失效，可被他人抢占（应对崩溃/断网/直接关页）。
   - 结束编辑 / 关闭页面 = 把最终数据推上去并清空锁，下一个人立刻可编辑。
   - 强制解锁：他人持锁时，输入团队密码可强制接管；被接管者的最后改动只保存为独立本地恢复副本，禁止覆盖新持锁者。 */
const LOCK_TTL=90*1000;        // 锁「新鲜度」阈值(ms)：超过此时长无续期 → UI 标注"可能已离开"（v6.70 起不再等于可免密抢占）
const LOCK_HEARTBEAT=30*1000;  // 持有者续锁心跳间隔
/* v6.70 僵尸锁安全阀：正常关页/提交都会清空 editor，但断电/崩溃/强杀进程不会。
   若不留出口，锁会永久卡死、谁都拿不到编辑权（这是"过期也需密码"带来的新风险）。
   故设一个远超正常使用的阈值：连续 2 小时无任何心跳 → 判定为僵尸锁，允许免密接管。
   2 小时足以排除"切后台/午休/开会"等正常离开场景（那些情况仍需密码）。 */
const LOCK_ZOMBIE=2*60*60*1000;
const IDLE_AUTO_RELEASE=5*60*1000; // 持锁后无操作多久(ms)自动提交并释放编辑锁（5分钟）
let idleReleaseT=null;         // 空闲自动释放计时器句柄
let _idleBound=false;          // 全局活动监听是否已绑定
let lockMine=false;            // 我当前是否持有编辑锁（=唯一的可写依据）
let lockHolderCid='';          // 云端当前锁持有者的客户端ID
let lockHolderName='';         // 云端当前锁持有者姓名（用于提示"XX正在编辑"）
let lockHeartT=null;           // 心跳定时器句柄
/* 零SQL锁：锁信息复用 board_state 已有的三列，无需新增数据库列：
   editor      ← 锁持有者客户端ID（非空且 updated_at 在 TTL 内 = 有人正持锁）
   editor_name ← 持有者姓名
   updated_at  ← 锁心跳/最近活动时间（用于 TTL 判过期） */
/* ============ v6.70 锁安全加固（用户要求）============
   背景事故：用户编辑期间被他人无声顶掉，且对方顶着用户的名字在改。审计出三个漏洞：
     ① FORCE_UNLOCK_PIN 沿用 TEAM_PIN='vfx2026'（人人都知道）→ 强制接管形同无门禁；
     ② 锁过期(>90s无心跳)后可被**无密码**直接抢走 —— 标签页被浏览器挂起/系统休眠就会误触发；
     ③ 被接管时只弹一条 toast 就静默失锁，原持有者根本来不及反应。
   v6.70 修复：
     ① 强制解锁密码独立（FORCE_UNLOCK_PIN 与 TEAM_PIN 解耦）；
     ② **任何情况接管他人的锁都必须输密码**——移除 acquireLock 里的 updated_at 过期抢占条件，
        只有「editor 为 null（正常提交/关页释放）」才是真正空闲、可直接申请；
        锁过期仅作为 UI 提示（标注"可能已离开"），不再是免密通行证；
     ③ 被接管时弹出模态确认窗，由原持有者选择「上传改动」或「放弃改动」，不再静默。 */
const FORCE_UNLOCK_PIN='vfx-admin-2026';  // 强制解锁密码（**独立于团队口令**，仅告知管理员/主管）

/* ===== v6.75 企微 OAuth 真实身份认证（方案3，废弃方案1的自选身份） =====
   背景：方案1（自选姓名+localStorage）零可信度——任何人可冒充任何人，
   用户实际遭遇过"被他人顶着名字编辑"的事故。
   方案3通过企微 OAuth2.0 获取用户真实企微身份（userid+姓名），
   与 members 列表匹配后才能获取编辑权。

   流程：
   1. 前端跳转 → 企微OAuth授权URL（redirect_uri = 云函数 /auth/callback）
   2. 用户在企微中确认 → 企微重定向到云函数 ?code=xxx
   3. 云函数用 code → access_token → userid + 姓名
   4. 云函数重定向回前端 #wecom_auth=base64payload（hash不经过服务器）
   5. 前端解析hash → 匹配members → 设置meId → 标记wecom_verified=true

   部署前提：
   - cloud-auth/function.js 已部署到云函数（SCF/Vercel/任意Node.js）
   - 企微管理后台已创建自建应用、配置了网页授权域名和通讯录权限
   - 下方 WECOM_AUTH_CONFIG 已填入正确的 CorpID / AgentId / 回调地址 */

const WECOM_AUTH_CONFIG = {
  corpId: '',          // 企微企业ID（ww开头），部署时填入
  agentId: '',         // 自建应用AgentId，部署时填入
  redirectUri: '',     // 云函数回调完整URL（如 https://xxx.ap-guangzhou.app.tcloudbase.com/auth/callback）
  scope: 'snsapi_base', // snsapi_base=静默授权(只有userid) / snsapi_userinfo=弹窗授权(有姓名)
  state: 'vfxgantt-auth-v1' // 防CSRF状态码
};

/* 企微认证状态 */
let wecomVerified = false;    // 当前会话是否已通过企微验证
let wecomUserInfo = null;     // { userid, name, ts } 企微返回的用户信息
const WECOM_VERIFIED_KEY = 'gantt_wecom_verified';  // localStorage: 存验证结果(userid+name+过期时间)
const WECOM_VERIFY_TTL = 7 * 24 * 60 * 60 * 1000;  // 验证有效期 7 天（之后需重新授权）

/**
 * 启动企微 OAuth 登录流程
 * 构造企微授权URL并跳转
 */
function startWecomAuth() {
  const { corpId, agentId, redirectUri, scope, state } = WECOM_AUTH_CONFIG;
  if (!corpId || !agentId || !redirectUri) {
    toast('⚠️ 企微登录未配置（需管理员部署云函数并填写凭证），请使用手动选择');
    showManualIdentityFallback();
    return;
  }
  const url = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(corpId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${state}#wechat_redirect`;
  // 提示用户即将跳转
  toast('🔐 正在跳转到企微授权…');
  window.location.href = url;
}

/**
 * 解析 URL hash 中的企微认证结果
 * 云函数回调后会重定向回前端 #wecom_auth=base64json
 * 返回 { ok, userid?, name?, error?, message? } 或 null（无认证数据）
 */
function parseWecomAuthHash() {
  const hash = location.hash || '';
  const match = hash.match(/wecom_auth=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    const json = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    // 立即清理URL中的敏感信息
    history.replaceState(null, '', location.pathname + location.search);
    return json;
  } catch (e) {
    console.warn('Failed to parse wecom_auth from hash:', e);
    return null;
  }
}

/**
 * 处理企微 OAuth 回调结果
 * 匹配 members 列表，设置 meId，标记已验证
 * 返回 true=成功匹配并设置身份, false=未匹配/失败
 */
function processWecomAuthResult(authResult) {
  if (!authResult || !authResult.ok) {
    console.warn('Wecom auth failed:', authResult);
    toast('❌ 企微登录失败: ' + (authResult?.message || '未知错误'));
    return false;
  }

  const { userid, name, ts } = authResult;

  // 安全检查：结果是否过期（超过5分钟视为过期）
  if (ts && Date.now() - ts > 5 * 60 * 1000) {
    toast('❌ 企微登录结果已过期，请重新登录');
    return false;
  }

  // 匹配 members 列表：优先按userid（如果members里有userid字段），其次按姓名模糊匹配
  let matchedMember = null;

  // 策略1：精确匹配 userid（需要成员数据带 wecom_userid 字段）
  matchedMember = members.find(m =>
    m.wecom_userid === userid ||
    m.userid === userid ||
    m.id === userid
  );

  // 策略2：按姓名匹配（兼容没有 userid 字段的情况）
  if (!matchedMember && name) {
    matchedMember = members.find(m =>
      m.name === name ||
      m.name?.includes(name) ||
      name.includes(m.name)
    );
  }

  if (!matchedMember) {
    console.warn('Wecom user not found in members:', { userid, name, memberNames: members.map(m => m.name) });
    toast(`⚠️ 企微账号「${name || userid}」不在看板成员列表中。请联系管理员把你加到团队里，或使用手动选择。`);
    showManualIdentityFallback();
    return false;
  }

  // 设置身份
  meId = matchedMember.id;
  wecomVerified = true;
  wecomUserInfo = { userid, name, ts };

  // 持久化验证状态（含过期时间）
  try {
    const verifiedData = {
      userid,
      name,
      memberid: matchedMember.id,
      memberName: matchedMember.name,
      verifiedAt: Date.now(),
      expiresAt: Date.now() + WECOM_VERIFY_TTL
    };
    localStorage.setItem(WECOM_VERIFIED_KEY, JSON.stringify(verifiedData));
    localStorage.setItem('gantt_me', meId);
    localStorage.setItem(ME_CONFIRM_KEY, '1');
  } catch (_){}

  toast('✅ 企微身份验证成功：' + matchedMember.name + '　（已实名认证）');
  buildMeSel();
  rerender();
  return true;
}

/**
 * 检查是否有有效的企微验证缓存（不过期）
 */
function hasValidWecomCache() {
  try {
    const raw = localStorage.getItem(WECOM_VERIFIED_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !data.expiresAt || Date.now() > data.expiresAt) {
      // 过期了，清除
      localStorage.removeItem(WECOM_VERIFIED_KEY);
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 恢复缓存的企微验证状态
 */
function restoreWecomCache() {
  try {
    const raw = localStorage.getItem(WECOM_VERIFIED_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !data.expiresAt || Date.now() > data.expiresAt) {
      localStorage.removeItem(WECOM_VERIFIED_KEY);
      return false;
    }
    // 校验缓存的 memberid 是否仍在 members 列表中
    const stillExists = members.some(m => m.id === data.memberid);
    if (!stillExists) {
      localStorage.removeItem(WECOM_VERIFIED_KEY);
      return false;
    }
    meId = data.memberid;
    wecomVerified = true;
    wecomUserInfo = { userid: data.userid, name: data.name, ts: data.verifiedAt };
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 显示手动选择身份的降级界面（企微不可用时的兜底）
 */
function showManualIdentityFallback() {
  const fallbackEl = document.getElementById('idnManualFallback');
  if (fallbackEl) fallbackEl.style.display = '';
}

let _takeoverGrace=false;         // 兼容旧状态；v7.19 起不再允许失锁者向云端强制写入
let _takeoverGraceT=null;
let takeoverFrozenSnap=null;      // 失锁瞬间冻结，防止弹窗等待期间被 realtime 新快照覆盖
function lockExpiryISO(){return new Date(Date.now()-LOCK_TTL).toISOString();} // 早于此时刻的锁判定为过期
function canWrite(){return lockMine===true && !cloudWriteBusy;}   // 只有持锁且不在提交/回滚事务中才可写
function compactPendingSnapshot(snap){
  const out=JSON.parse(JSON.stringify(snap||snapshot()));
  if(Array.isArray(out._log)&&out._log.length>LOCAL_LOG_MAX)out._log=out._log.slice(-LOCAL_LOG_MAX);
  return out;
}
function freezeTakeoverSnap(){
  if(!takeoverFrozenSnap)takeoverFrozenSnap=compactPendingSnapshot(snapshot());
  return takeoverFrozenSnap;
}
/* 被强制接管后绝不能再写共享行，否则会覆盖新持锁者。改为保存失锁瞬间冻结的本地恢复副本，
   待下次安全获取编辑权时再由启动恢复流程合并云端日志并条件补推。 */
async function preserveTakeoverSnap(){
  try{
    const snap=storePendingSnapshot(takeoverFrozenSnap||snapshot(),true);
    takeoverFrozenSnap=null;
    toast('💾 你的最后改动已保留为本地恢复副本，未覆盖当前编辑者');
    return true;
  }catch(e){
    console.warn('preserve takeover snap failed',e);
    toast('⚠ 本地恢复副本保存失败，请勿关闭此页面，并截图联系管理员');
    return false;
  }
}

/* ===== 被强制接管：弹窗让原持有者决定未提交改动的去向 =====
   失锁者不再向共享行强制上传（会覆盖新持锁者），只允许保存本地恢复副本，或放弃并回滚到编辑起点。 */
let _tkPending=false;
function openTakeoverDialog(byWho){
  if(_tkPending) return;               // 已弹出，避免心跳重复触发
  const mask=document.getElementById('tkMask'); if(!mask){
    // 兜底：DOM 缺失时只保留本地恢复副本，绝不越过新持锁者写共享行。
    toast('⚠ 编辑权已被「'+byWho+'」接管，正在保存本地恢复副本…');
    preserveTakeoverSnap(); return;
  }
  _tkPending=true;
  const cur=JSON.stringify(snapshot());
  const changed = editBaselineJSON && cur!==editBaselineJSON;
  document.getElementById('tkWho').textContent=byWho;
  document.getElementById('tkChanged').textContent = changed?'未提交的改动':'尚未改动任何内容';
  document.getElementById('tkDiff').innerHTML = changed
    ? '<b>保留本地恢复副本</b>：保存你这次的修改，稍后安全获取编辑权后再恢复，不覆盖当前编辑者（推荐）。<br><b>放弃我的改动</b>：本地回滚到你开始编辑时的状态，云端保持当前编辑者的版本。'
    : '你没有任何改动，两个选项效果相同 —— 直接退出编辑即可。';
  mask.classList.add('show');
}
/* 用户在接管弹窗中做出选择：save=true 保留独立本地恢复副本；false 放弃并回滚 */
async function resolveTakeover(save){
  const mask=document.getElementById('tkMask');
  if(mask) mask.classList.remove('show');
  _tkPending=false;
  if(save){
    const saved=await preserveTakeoverSnap();
    if(!saved){ syncLockUI(); return; } // 冻结副本仍留在内存，允许用户释放空间后重试
  }else{
    // 放弃：回滚到本次编辑起点（与「放弃编辑」按钮同一套基线）
    if(editBaselineJSON){
      try{
        applyingRemote=true; applySnap(JSON.parse(editBaselineJSON)); applyingRemote=false;
        lastSyncJSON=editBaselineJSON;
        refreshAllUI();
        toast('已放弃本次改动，本地已回滚到编辑前状态');
      }catch(e){ console.warn('takeover rollback failed',e); }
    }else{
      toast('已退出编辑模式');
    }
  }
  takeoverFrozenSnap=null;
  editBaselineJSON='';
  syncLockUI();
}
/* ===== v7.39 云端冲突·非阻塞选择弹窗 + 需求级三方合并 + 锁判定加固 =====
   背景：原生 confirm() 会冻结主线程，连带冻结实时心跳 → 服务器误判客户端失活 → 触发离线+重连，
   重连合并又弹 confirm()，形成「弹窗频繁 + 重连增多 + 掉线感」的正反馈。
   ① 改用返回 Promise 的页内模态（不冻结主线程），决策期间连接保持活跃；同一时刻只弹一个（复用待决）。
   ② 重连合并由「整行二选一」升级为「按需求三方合并」：非重叠改动自动无感合并，仅同一需求双方都改才弹选择。
   ③ updateLockFromRow 仅在锁被「另一个非空持有者」占据时才判接管；锁被置空多为工具推送副作用，改为静默重占。 */
let _cfPending=null;   // {promise, resolve} 当前待决的冲突选择（去重用）
function askDataConflict(msgHTML, conflictNames){
  const mask=document.getElementById('cfMask');
  if(!mask){ // 兜底：DOM 缺失退回原生 confirm（文本剥标签）
    const txt=(conflictNames&&conflictNames.length?('双方都改了：'+conflictNames.join('、')+'\n\n'):'')
      +String(msgHTML||'').replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
    return Promise.resolve(window.confirm(txt));
  }
  if(_cfPending) return _cfPending.promise;   // 已有待决 → 复用同一决策，避免重连风暴连弹
  const msgEl=document.getElementById('cfMsg');
  const listEl=document.getElementById('cfList');
  if(msgEl) msgEl.innerHTML=msgHTML||'';
  if(listEl){
    if(conflictNames&&conflictNames.length){ listEl.style.display=''; listEl.innerHTML='双方都改了：<b>'+conflictNames.map(escHtml).join('</b>、<b>')+'</b>'; }
    else { listEl.style.display='none'; listEl.innerHTML=''; }
  }
  mask.classList.add('show');
  const promise=new Promise(res=>{ _cfPending={promise:null, resolve:res}; });
  _cfPending.promise=promise;
  return promise;
}
/* 用户在冲突弹窗中做出选择：useLocal=true 保留我的；false 采用云端 */
function resolveDataConflict(useLocal){
  const mask=document.getElementById('cfMask'); if(mask) mask.classList.remove('show');
  if(_cfPending){ const r=_cfPending.resolve; _cfPending=null; r(!!useLocal); }
}
/* —— 需求级三方合并（base=上次同步基线 lastSyncJSON，local=本地，remote=云端）—— */
function safeParseSnap(s){ try{ return (typeof s==='string')?JSON.parse(s):s; }catch(_){ return null; } }
function snapReqIndex(arr){ const m={}; (Array.isArray(arr)?arr:[]).forEach(r=>{ if(r&&r.id!=null)m[r.id]=r; }); return m; }
function stripReqsForCmp(s){ const o=JSON.parse(JSON.stringify(s||{})); delete o.reqs; delete o._log; return o; }
function threeWayMergeSnapshot(base, local, remote){
  const out=JSON.parse(JSON.stringify(local));           // 以本地为壳
  // 非需求部分（成员/配置）粗粒度三方：仅远端改了而本地没改 → 采用远端；其余保持本地（本地优先，避免丢用户配置）
  const bRest=JSON.stringify(stripReqsForCmp(base)), lRest=JSON.stringify(stripReqsForCmp(local)), rRest=JSON.stringify(stripReqsForCmp(remote));
  if(lRest===bRest && rRest!==bRest){ const ro=stripReqsForCmp(remote); Object.keys(ro).forEach(k=>{ out[k]=ro[k]; }); }
  const bR=snapReqIndex(base&&base.reqs), lR=snapReqIndex(local&&local.reqs), rR=snapReqIndex(remote&&remote.reqs);
  const ids=new Set([...Object.keys(bR),...Object.keys(lR),...Object.keys(rR)]);
  const mergedReqs=[]; const conflicts=[];
  ids.forEach(id=>{
    const b=bR[id], l=lR[id], r=rR[id];
    const bj=b?JSON.stringify(b):null, lj=l?JSON.stringify(l):null, rj=r?JSON.stringify(r):null;
    const lc=lj!==bj, rc=rj!==bj;                            // 各侧相对基线是否变化（含删除：该侧缺失）
    if(!lc && !rc){ const keep=l||r; if(keep)mergedReqs.push(keep); return; }
    if(lc && !rc){ if(l)mergedReqs.push(l); return; }        // 仅本地改/删 → 取本地
    if(!lc && rc){ if(r)mergedReqs.push(r); return; }        // 仅远端改/删 → 取远端
    if(lj===rj){ if(l)mergedReqs.push(l); return; }          // 双方改成一样 → 不冲突
    conflicts.push({id:id, name:String((l&&l.name)||(r&&r.name)||(b&&b.name)||('需求'+id)), local:l||null, remote:r||null});
    mergedReqs.push(l||r);                                    // 冲突需求占位（保证 id 在场，便于之后按选择替换/移除）
  });
  out.reqs=mergedReqs;
  return {snap:out, conflicts:conflicts};
}
/* 按用户选择落实冲突需求：useLocal=true 取本地版（本地已删则移除）；false 取云端版（云端已删则移除）。 */
function mergeResolveConflicts(mergeRes, useLocal){
  const pick={}; mergeRes.conflicts.forEach(c=>{ pick[c.id]= useLocal ? c.local : c.remote; });
  const reqs=[];
  (mergeRes.snap.reqs||[]).forEach(r=>{
    if(Object.prototype.hasOwnProperty.call(pick,r.id)){ if(pick[r.id])reqs.push(pick[r.id]); /* null=删除 */ }
    else reqs.push(r);
  });
  mergeRes.snap.reqs=reqs;
  return mergeRes.snap;
}
/* 锁在云端被置空（多为工具/AI 推送副作用，并非他人接管）时，静默重占锁，保住编辑权与未提交改动。 */
let _reacquiring=false;
async function silentReacquireLock(){
  if(_reacquiring||cloudOffline||!lockMine||!sb)return;
  _reacquiring=true;
  try{
    const {data,error}=await sb.from(SB_TABLE)
      .update({editor:cloudCid,editor_name:cloudWho(),updated_at:new Date().toISOString()})
      .eq('id',SB_ROW).is('editor',null)                 // 只在锁确实空闲时重占，绝不抢他人
      .select('editor');
    if(error)throw error;
    if(data&&data.length){ lockHolderCid=cloudCid; lockHolderName=cloudWho(); startHeart(); syncLockUI(); }
    else { await refreshLockStatus(); syncLockUI(); }    // 被人抢先 → 重读后走正常判定
  }catch(e){ console.warn('silent reacquire failed',e); }
  finally{ _reacquiring=false; }
}
/* 写操作守门：只读模式下统一拦截所有数据改动（排期/状态/改派/增删/重置/撤销重做/标准表编辑），
   仅提示需先解锁，不改动任何数据。返回 true=可写、false=已拦截。
   节流提示：避免拖拽等连续触发时狂弹 toast。 */
let _roToastT=0;
function requireWrite(silent){
  if(canWrite())return true;
  if(!silent){
    const now=Date.now();
    if(now-_roToastT>1200){
      _roToastT=now;
      const who=(lockHolderName&&lockHolderCid&&lockHolderCid!==cloudCid)?('「'+lockHolderName+'」正在编辑，请等待'):'点右上角「申请编辑」获取编辑权';
      toast('🔒 当前为只读模式 · '+who);
    }
  }
  return false;
}
function cloudSetStatus(state,txt){
  const el=document.getElementById('cloudInd');if(!el)return;
  el.classList.remove('on','syncing','err','locked','busy');
  if(state)el.classList.add(state);
  const t=el.querySelector('.ci-tx');if(t&&txt!=null)t.textContent=txt;
  // 【铁律】离线模式下 ro-mode 必须保持 false（让用户能编辑），不依赖 canWrite 推算
  if(cloudOffline){
    document.body.classList.remove('ro-mode');
    return;
  }
  // 同步只读视觉态：只读时给 body 加 ro-mode，CSS 据此把写按钮置灰禁用
  const wasRo=document.body.classList.contains('ro-mode');
  const nowRo=!canWrite();
  document.body.classList.toggle('ro-mode', nowRo);
  // 只读/可写切换时，三张配置表的「已锁定/编辑中」显示态需跟着刷新
  if(wasRo!==nowRo){
    if(typeof applyEffLockUI==='function')applyEffLockUI();
    if(typeof applyStdLockUI==='function')applyStdLockUI();
    if(typeof applyInvLockUI==='function')applyInvLockUI();
  }
}
/* 统一刷新指示器：持锁=on(绿，编辑中)，他人持锁=busy(琥珀，等待)，空闲=locked(灰，可申请) */
function syncLockUI(){
  /* 放弃编辑按钮与变更记录按钮在在线/离线状态都要刷新，不能被提前 return 跳过。 */
  const db=document.getElementById('discardEditBtn');
  if(db) db.style.display=(lockMine&&!cloudWriteBusy)?'inline-flex':'none';
  if(document.getElementById('logPanel') && typeof renderLogPanel==='function') renderLogPanel();
  if(cloudOffline){ cloudSetStatus('offline', '已离线 · 自动重连中'); return; }
  if(!cloudReady){ return; }
  if(lockMine) cloudSetStatus('on',lockBtnLabel());
  else if(lockHolderCid && lockHolderCid!==cloudCid) cloudSetStatus('busy',lockBtnLabel());
  else cloudSetStatus('locked',lockBtnLabel());
}
function refreshAllUI(){
  rerender();
  if(typeof applyEffLockUI==='function')applyEffLockUI();
  if(typeof applyStdLockUI==='function')applyStdLockUI();if(typeof applyInvLockUI==='function')applyInvLockUI();
}
async function cloudInit(){
  if(!window.supabase||!window.supabase.createClient){cloudSetStatus('err','云端库未加载');return;}
  if(hasHashSnap){cloudSetStatus('locked','分享快照（未连云端）');return;} // 打开的是分享链接，按快照看，不连云
  // 启动时先 ping 一次（保活 + 检测数据库是否已就绪）
  startKeepAlivePing(true);
  try{
    sb=window.supabase.createClient(SB_URL,SB_KEY,{realtime:{params:{eventsPerSecond:5}}});
    cloudSetStatus('syncing','连接中…');
    // 零SQL锁：复用现有列 editor(=锁持有者) / editor_name(=持有者名) / updated_at(=锁心跳时间)，无需新增数据库列
    let {data,error}=await sb.from(SB_TABLE).select('snap,editor,editor_name,updated_at').eq('id',SB_ROW).maybeSingle();
    if(error)throw error;
    if(data&&data.snap){
      const snapObj=(typeof data.snap==='string')?JSON.parse(data.snap):data.snap;
      const remoteJSON=JSON.stringify(snapObj);
      // 启动补救：上次会话离线时留下的未补推暂存(gantt_pending_snap)还在 → 不能无条件用云端覆盖，
      // 否则重开页面就会吞掉上次离线改动。走「保留本地/采用云端」的选择。
      if(cloudPendingPush){
        const pendJSON=JSON.stringify(cloudPendingPush);
        if(pendJSON!==remoteJSON){
          // v7.39：原生 confirm 改非阻塞模态，避免冻结主线程/心跳
          const useLocal=await askDataConflict('检测到你<b>上次离线期间有未同步的改动</b>，且云端数据与之不同。<br>· <b>保留我的</b>＝保留你离线期间的改动（推送到云端）<br>· <b>采用云端</b>＝丢弃离线改动');
          if(useLocal){
            // 先合并云端完整审计记录，再以“无人持锁或本标签已持锁”为条件补推；绝不 upsert 抢走他人编辑权。
            const recoverySnap=mergeSnapshotLogs(cloudPendingPush,snapObj);
            try{
              const {data:claimed,error:claimErr}=await sb.from(SB_TABLE)
                .update({snap:recoverySnap,editor:cloudCid,editor_name:cloudWho(),updated_at:new Date().toISOString()})
                .eq('id',SB_ROW).eq('updated_at',data.updated_at)
                .or('editor.is.null,editor.eq.'+cloudCid)
                .select('snap,editor,editor_name,updated_at');
              if(claimErr)throw claimErr;
              if(!claimed||!claimed.length){const busy=new Error('当前有人编辑，启动恢复未写入');busy.lockBusy=true;throw busy;}
              applyingRemote=true; applySnap(recoverySnap); applyingRemote=false;
              data=claimed[0];
              lockMine=true; lockHolderCid=cloudCid; lockHolderName=cloudWho();
              editBaselineJSON=remoteJSON; startHeart();
              lastSyncJSON=JSON.stringify(recoverySnap); save();
              clearPendingSnapshot();
              toast('☁ 已安全恢复上次离线改动，并获取编辑权');
            }catch(pe){
              console.warn('启动补推失败,保留暂存',pe);
              // 共享行未确认写入时继续展示云端版本；本地改动只留在 PENDING_KEY，避免误导为已恢复成功。
              applyingRemote=true; applySnap(snapObj); applyingRemote=false;
              lastSyncJSON=remoteJSON; save();
              toast(pe&&pe.lockBusy?'✋ 当前有人编辑；你的离线改动已保留本地，待其提交后再恢复':'⚠ 离线改动补推失败，已保留本地恢复副本');
            }
          }else{
            applyingRemote=true; applySnap(snapObj); applyingRemote=false;
            lastSyncJSON=remoteJSON; save();
            clearPendingSnapshot();
            toast('☁ 已采用云端最新排期');
          }
        }else{
          // 暂存与云端一致（上次其实已推成功）→ 清掉暂存，正常载入
          applyingRemote=true; applySnap(snapObj); applyingRemote=false;
          lastSyncJSON=remoteJSON;
          clearPendingSnapshot();
        }
        refreshAllUI();
      }else{
        applyingRemote=true; applySnap(snapObj); applyingRemote=false;
        lastSyncJSON=JSON.stringify(snapshot());
        refreshAllUI();
        toast('☁ 已载入云端最新排期');
      }
    }else{
      lastSyncJSON=JSON.stringify(snapshot());
    }
    if(data) updateLockFromRow(data);   // 读取当前锁状态（谁在编辑）
    cloudReady=true;
    syncLockUI();
    sbChan=sb.channel('board-'+SB_ROW)
      .on('postgres_changes',{event:'*',schema:'public',table:SB_TABLE,filter:'id=eq.'+SB_ROW},payload=>{
        const row=payload.new; if(!row)return;
        updateLockFromRow(row);                                // 先更新锁状态（即便快照没变也要刷新"谁在编辑"）
        if(!row.snap)return;
        if(row.editor===cloudCid)return;                       // 自己刚推的，忽略
        if(lockMine && !_takeoverGrace)return;                 // 我正持锁编辑，不让远端快照覆盖（接管宽限期内例外：接住被踢者的最后提交）
        const incoming=(typeof row.snap==='string')?row.snap:JSON.stringify(row.snap);
        if(incoming===lastSyncJSON)return;
        try{
          const obj=(typeof row.snap==='string')?JSON.parse(row.snap):row.snap;
          applyingRemote=true; applySnap(obj); applyingRemote=false;
          lastSyncJSON=incoming; refreshAllUI();
          toast('🔄 协作更新：'+(row.editor_name||'他人')+' 改动已同步');
        }catch(_){applyingRemote=false;}
      })
      .subscribe(st=>{ if(st==='CHANNEL_ERROR'||st==='TIMED_OUT'){cloudSetStatus('err','实时连接中断');} });
  }catch(e){
    console.warn('cloud init failed,降级到本地',e);
    enterOfflineMode('云端不可达');
  }
}
/* Supabase Free 计划项目连续 7 天无访问会自动 pause 数据库(PostgREST 会报 PGRST002)。
   每天 9 点本地时间自动 ping 一次,骗 Supabase "有人用",保活成本 = 0。
   - 启动时(boot)立即调用:今天已过 9 点但还没 ping → 立即补一次
   - 每 10 分钟检查一次,过 9 点就 ping,记 localStorage 防止重复
   - 失败静默,不打扰用户 */
function startKeepAlivePing(immediate){
  if(window.__keepAliveStarted) return;        // 防止 boot + cloudInit 各调一次重复启动
  window.__keepAliveStarted = true;
  const ping = () => fetch(`${SB_URL}/rest/v1/${SB_TABLE}?select=id&limit=1&id=eq.${encodeURIComponent(SB_ROW)}`, {
    headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY },
    cache: 'no-store',
  }).catch(()=>{});
  const tick = () => {
    try{
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const last = +localStorage.getItem('gantt_keepalive_day') || 0;
      if (last < today && now.getHours() >= 9) {
        ping();
        localStorage.setItem('gantt_keepalive_day', String(today));
      }
    }catch(_){}
  };
  if (immediate) tick();
  setInterval(tick, 10 * 60 * 1000);           // 每 10 分钟检查一次是否过 9 点
  setTimeout(tick, 60 * 1000);                 // 启动 1 分钟后兜底检查一次
}
/* 把编辑权授予本地（不依赖云端锁），让用户在离线期间不被只读卡住。重连成功后让真实锁接管。 */
function giveLocalLock(){
  lockMine=true; lockHolderCid=cloudCid; lockHolderName=cloudWho();
  if(!editBaselineJSON)editBaselineJSON=JSON.stringify(snapshot());
}
/* 进入离线模式：保留编辑权 + 暂存 + 安排重试。注：cloudReady 仍置 true，使 cloudPush 继续被调用（改走本地暂存）。 */
function enterOfflineMode(reason){
  if(cloudOffline) return;
  cloudOffline=true; cloudReady=true; cloudReconnTries=0;
  stopHeart(); // 离线期间停止更新 updated_at，避免与重连恢复的 CAS 自相竞争
  giveLocalLock();
  // 【铁律】离线模式下 body 一定不带 ro-mode，让用户立刻能编辑
  document.body.classList.remove('ro-mode');
  cloudSetStatus('offline', (reason||'已离线')+' · 现在可编辑');
  toast('☁ 云端不可达，但你仍可编辑（改动暂存本地，恢复后自动补同步）');
  scheduleReconnect();
}
function scheduleReconnect(){
  if(cloudReconnT) clearTimeout(cloudReconnT);
  const d=RECONN_DELAYS[Math.min(cloudReconnTries, RECONN_DELAYS.length-1)];
  cloudReconnT=setTimeout(tryReconnect, d);
}
async function tryReconnect(){
  if(!cloudOffline) return;
  cloudReconnTries++;
  // 【铁律】离线模式下重连中也保持 body 不带 ro-mode（用户能继续编辑）
  document.body.classList.remove('ro-mode');
  cloudSetStatus('syncing', `重连中（第${cloudReconnTries}次）… · 可编辑`);
  try{
    if(!sb) sb=window.supabase.createClient(SB_URL,SB_KEY,{realtime:{params:{eventsPerSecond:5}}});
    const {data,error}=await sb.from(SB_TABLE).select('snap,editor,editor_name,updated_at').eq('id',SB_ROW).maybeSingle();
    if(error) throw error;
    // 恢复成功。合并/补推事务完成前冻结写操作，避免请求等待期间的新修改被误标为已同步。
    cloudOffline=false; cloudReady=true; cloudReconnTries=0; cloudWriteBusy=true; syncLockUI();
    // ── 重连合并（四象限，绝不无条件覆盖本地离线改动）──
    // 关键修复：本地是否「脏」以「当前快照 vs 上次同步基线 lastSyncJSON」为准，
    // 不再依赖可能过期(700ms防抖漏最新改动)或为空的 cloudPendingPush，否则会把离线改动判成"无改动"直接被云端覆盖。
    const curSnap=snapshot();
    const localJSON=JSON.stringify(curSnap);
    const localDirty=(localJSON!==lastSyncJSON) || !!cloudPendingPush;   // 离线期间改过=脏
    let snapObj=null, remoteJSON=null;
    if(data && data.snap){
      snapObj=(typeof data.snap==='string')?JSON.parse(data.snap):data.snap;
      remoteJSON=JSON.stringify(snapObj);
    }
    const remoteChanged=(remoteJSON!=null) && (remoteJSON!==lastSyncJSON);  // 别人在你离线期间改过云端
    // 补推本地：先条件获取恢复锁，再写当前快照；有人持锁时返回零行，绝不 upsert 抢锁。
    const pushLocal=async(snap)=>{
      const {data:claimed,error:upErr}=await sb.from(SB_TABLE)
        .update({snap:snap,editor:cloudCid,editor_name:cloudWho(),updated_at:new Date().toISOString()})
        .eq('id',SB_ROW).eq('updated_at',data.updated_at)
        .or('editor.is.null,editor.eq.'+cloudCid)
        .select('id,editor,editor_name,updated_at');
      if(upErr) throw upErr;
      if(!claimed||!claimed.length){const busy=new Error('当前有人编辑，离线补推未写入');busy.lockBusy=true;throw busy;}
      lockMine=true; lockHolderCid=cloudCid; lockHolderName=cloudWho();
      editBaselineJSON=remoteJSON||JSON.stringify(snap); startHeart();
      if(Array.isArray(snap._log))mergeLog(snap._log);
      lastSyncJSON=JSON.stringify(snap); save();
      clearPendingSnapshot();
    };
    const takeRemote=()=>{
      applyingRemote=true; applySnap(snapObj); applyingRemote=false;
      lastSyncJSON=remoteJSON; save();   // 同步 localStorage，避免旧本地存档回灌
      clearPendingSnapshot();
    };
    // 本地缓存为防配额溢出只保留最近 LOCAL_LOG_MAX 条；补推前必须把云端历史合并回来，
    // 否则“保留本地离线改动”会把云端 120 条审计记录截成 40 条。
    const currentLocalForPush=()=>mergeSnapshotLogs(snapshot(),snapObj);
    try{
      if(localDirty && remoteChanged){
        // v7.39 需求级三方合并：非重叠改动自动无感合并，仅「同一需求双方都改」才弹非阻塞选择
        const baseSnap=lastSyncJSON?safeParseSnap(lastSyncJSON):null;
        const mergeRes=baseSnap?threeWayMergeSnapshot(baseSnap,curSnap,snapObj):null;
        if(mergeRes && !mergeRes.conflicts.length){
          // 无冲突 → 自动合并并补推，绝不打扰用户（先写云端成功再更新本地，避免补推失败时内存与恢复副本不一致）
          const mergedSnap=mergeSnapshotLogs(mergeRes.snap,snapObj);
          await pushLocal(mergedSnap);
          applyingRemote=true; applySnap(mergedSnap); applyingRemote=false;
          lastSyncJSON=JSON.stringify(mergedSnap); save();
          toast('☁ 已自动合并你与云端的改动');
        }else if(mergeRes){
          // 有冲突需求 → 其余已自动合并，仅针对冲突需求非阻塞二选一
          const names=mergeRes.conflicts.map(c=>c.name);
          const useLocal=await askDataConflict('云端已恢复，但<b>以下需求</b>你和云端都有改动：<br>· <b>保留我的</b>＝这些需求按你的改动<br>· <b>采用云端</b>＝这些需求按云端版本',names);
          const resolved=mergeResolveConflicts(mergeRes,useLocal);
          const mergedSnap=mergeSnapshotLogs(resolved,snapObj);
          await pushLocal(mergedSnap);
          applyingRemote=true; applySnap(mergedSnap); applyingRemote=false;
          lastSyncJSON=JSON.stringify(mergedSnap); save();
          toast(useLocal?'☁ 已保留你的改动，并合并了其余云端更新':'☁ 冲突需求已采用云端，其余改动已合并');
        }else{
          // 无基线可三方合并 → 退回非阻塞整体二选一（默认保留本地，刚辛苦编辑的内容优先）
          const useLocal=await askDataConflict('云端已恢复，但你离线期间云端数据也有变化（可能是其他人编辑）。<br>· <b>保留我的</b>＝保留你离线期间的改动（覆盖云端）<br>· <b>采用云端</b>＝丢弃你的离线改动');
          if(useLocal){ await pushLocal(currentLocalForPush()); toast('☁ 已保留你的离线改动并推送云端'); }
          else { takeRemote(); toast('已采用云端版本'); }
        }
      }else if(localDirty){
        // 只有本地改了 → 直接补推，绝不覆盖本地
        await pushLocal(currentLocalForPush()); toast('☁ 离线期间改动已补推云端');
      }else if(remoteChanged){
        // 只有远端改了 → 安全应用
        takeRemote(); toast('☁ 云端已恢复，期间他人改动已同步');
      }else{
        // 双方都没变
        clearPendingSnapshot();
      }
    }catch(upErr){
      console.warn('重连补推失败,保留本地暂存',upErr);
      const compact=compactPendingSnapshot(curSnap);
      let pendingSaved=false;
      try{storePendingSnapshot(compact);pendingSaved=true;}catch(e){console.warn('pending snapshot save failed',e);}
      if(upErr&&upErr.lockBusy){
        // 云端可达但已有编辑者：展示云端版本并转只读，本地改动仅保留在恢复副本中，禁止继续制造双写分叉。
        cloudOffline=false; lockMine=false; cloudLeaseNeedsRotate=true;
        if(pendingSaved){
          if(snapObj){ applyingRemote=true; applySnap(snapObj); applyingRemote=false; lastSyncJSON=remoteJSON; save(); }
        }else{
          // 磁盘配额不足时至少冻结在内存中，不立刻用云端覆盖；提示用户保持页面并人工处理。
          takeoverFrozenSnap=compact;
        }
        if(data)updateLockFromRow(data);
        if(!pendingSaved)openTakeoverDialog(lockHolderName||'当前编辑者');
        toast(pendingSaved?'✋ 当前有人编辑；你的离线改动已保留本地，待其提交后再恢复':'⚠ 当前有人编辑，且本地恢复副本保存失败；请勿关闭页面并联系管理员');
      }else{
        // 网络/服务错误：仍在真正离线状态，保留本地暂存并重试。
        cloudWriteBusy=false; cloudOffline=true; document.body.classList.remove('ro-mode');
        cloudSetStatus('offline','已离线 · 可编辑 · 补推失败重试中…');
        scheduleReconnect(); refreshAllUI(); syncLockUI(); return;
      }
    }
    cloudWriteBusy=false;
    // 重订阅 realtime
    try{ if(sbChan) await sbChan.unsubscribe(); }catch(_){}
    sbChan=sb.channel('board-'+SB_ROW)
      .on('postgres_changes',{event:'*',schema:'public',table:SB_TABLE,filter:'id=eq.'+SB_ROW},payload=>{
        const row=payload.new; if(!row)return;
        updateLockFromRow(row);
        if(!row.snap)return;
        if(row.editor===cloudCid)return;
        if(lockMine && !_takeoverGrace)return;
        const incoming=(typeof row.snap==='string')?row.snap:JSON.stringify(row.snap);
        if(incoming===lastSyncJSON)return;
        try{
          const obj=(typeof row.snap==='string')?JSON.parse(row.snap):row.snap;
          applyingRemote=true; applySnap(obj); applyingRemote=false;
          lastSyncJSON=incoming; refreshAllUI();
          toast('🔄 协作更新：'+(row.editor_name||'他人')+' 改动已同步');
        }catch(_){applyingRemote=false;}
      })
      .subscribe(st=>{ if(st==='CHANNEL_ERROR'||st==='TIMED_OUT'){ if(!cloudOffline) enterOfflineMode('实时连接中断'); } });
    refreshAllUI();
    syncLockUI();
    if(cloudReconnT){ clearTimeout(cloudReconnT); cloudReconnT=null; }
  }catch(e){
    console.warn('重连失败',e);
    cloudWriteBusy=false;
    // 【铁律】重连失败时也要保证 body 不带 ro-mode（用户可以继续编辑）
    document.body.classList.remove('ro-mode');
    scheduleReconnect();
    // 直接设状态为「可编辑」+ 重连中,不让 syncLockUI 走"未持锁"分支把 ro-mode 加上
    cloudSetStatus('offline', '已离线 · 可编辑 · 重连中（第'+cloudReconnTries+'次）…');
  }
}
function cloudPush(immediate){
  if(!cloudReady||!sb||applyingRemote)return;
  if(!canWrite())return;             // 只读/提交中：本页改动不外推
  clearTimeout(cloudPushT);
  const epoch=cloudPushEpoch;
  const doPush=async()=>{
    if(epoch!==cloudPushEpoch||!lockMine||cloudWriteBusy)return;   // 已进入提交/放弃流程，废弃旧防抖任务
    if(cloudOffline){
      // 离线模式：PENDING_KEY 同样只保留最近日志，恢复时再与云端 120 条历史合并，避免配额溢出。
      const snap=compactPendingSnapshot(snapshot());
      try{
        storePendingSnapshot(snap);
      }catch(e){
        console.warn('offline pending snapshot save failed',e);
        toast('⚠ 离线恢复副本保存失败，请勿关闭页面并联系管理员');
      }
      return;
    }
    // 同一标签页严格串行保存。若上一请求尚未完成，只记“还需补推一次最新状态”，禁止旧请求晚到覆盖新快照。
    if(cloudPushRunning){ cloudPushQueued=true; return; }
    cloudPushRunning=true;
    const snap=snapshot(); const json=JSON.stringify(snap);
    try{
      if(json===lastSyncJSON)return;
      cloudSetStatus('syncing','保存中…');
      // editor 使用每个标签页/每轮租约唯一的 cloudCid；迟到请求无法命中新标签或下一轮锁。
      const {data,error}=await sb.from(SB_TABLE)
        .update({snap:snap,editor_name:cloudWho(),updated_at:new Date().toISOString()})
        .eq('id',SB_ROW).eq('editor',cloudCid).select('id');
      if(error)throw error;
      if(!data||!data.length){const lost=new Error('编辑权已变化，保存被拒绝');lost.lockLost=true;throw lost;}
      if(epoch!==cloudPushEpoch)return;
      lastSyncJSON=json; cloudSetStatus('on',lockBtnLabel());
    }catch(e){
      // 这可能是“提交/放弃”前发出的旧请求；流程 epoch 已变化时不得把页面重新切回离线编辑态。
      if(epoch!==cloudPushEpoch)return;
      if(e&&e.lockLost){
        console.warn('cloud push rejected because lock changed',e);
        freezeTakeoverSnap();
        cloudLeaseNeedsRotate=true;
        lockMine=false; stopHeart();
        await refreshLockStatus(); syncLockUI();
        openTakeoverDialog(lockHolderName||'他人');
        toast('⚠ 编辑权已变化，本次自动保存未覆盖云端');
        return;
      }
      // 推送失败 → 切离线兜底,保留编辑权+暂存
      console.warn('cloud push failed,降级本地',e);
      enterOfflineMode('保存失败,已切本地');
    }finally{
      cloudPushRunning=false;
      if(cloudPushQueued){
        cloudPushQueued=false;
        // queued 可能来自下一轮租约；重新调用时读取当前 epoch/cid，而不是沿用旧请求的 epoch。
        if(lockMine && !cloudWriteBusy) cloudPush(true);
      }
    }
  };
  if(immediate)doPush(); else cloudPushT=setTimeout(doPush,700);
}

/* 根据云端行更新本地"谁在编辑"的认知。
   零SQL锁：holder=row.editor, 心跳时间=row.updated_at, 名字=row.editor_name
   v6.70 口径变更：**过期的锁不再视为"无人持有"**。
     原来 `lockHolderCid = fresh?holder:''` 会把超时锁抹成空，于是 cloudUnlock 走"直接申请"分支
     → 无密码抢走。现在只要 editor 非空就认为"有人占着"，过期只影响提示文案（标注"可能已离开"），
     接管一律要密码。stale 标记供 UI 区分两种占用状态。 */
let lockHolderStale=false;      // 当前持有者的锁是否已超时未续期（仅用于提示，不代表可免密抢占）
let lockHolderZombie=false;     // 是否已达僵尸阈值（2小时无心跳）→ 允许免密接管，防锁死
function updateLockFromRow(row){
  // 【铁律】离线模式下 lockMine 是本地给的，不要被云端 row 数据踢回去
  if(cloudOffline){ syncLockUI(); return; }
  const holder=row.editor||'';
  const at=row.updated_at?Date.parse(row.updated_at):0;
  const age=at?(Date.now()-at):Infinity;
  const fresh=holder && at && (age < LOCK_TTL);
  lockHolderCid  = holder;                              // 不再因过期抹空
  lockHolderName = holder?(row.editor_name||'某成员'):'';
  lockHolderStale= !!holder && !fresh;                  // 有人占但心跳已停
  lockHolderZombie= !!holder && age >= LOCK_ZOMBIE;     // 超长无心跳 = 僵尸锁
  // 若云端显示锁已被「另一个非空持有者」占据（真·被强制接管）→ 弹窗让我确认如何处理未提交改动（v6.70 不再静默）
  // v7.39 加固：仅当 holder 为非空且非我时才判接管；holder 被置空多为工具/AI 推送副作用，并非接管，改为静默重占。
  if(lockMine && lockHolderCid && lockHolderCid!==cloudCid){
    // 在 realtime 覆盖内存前冻结本地改动，再作废本租约的排队/在途自动保存。
    freezeTakeoverSnap();
    cloudPushEpoch++; cloudPushQueued=false; clearTimeout(cloudPushT);
    cloudLeaseNeedsRotate=true;
    lockMine=false; stopHeart();
    openTakeoverDialog(lockHolderName||'他人');
  }else if(lockMine && !lockHolderCid){
    // 锁在云端被置空：不弹接管窗，静默重占，保住编辑权与未提交改动
    silentReacquireLock();
  }
  syncLockUI();
}
function lockBtnLabel(){
  if(lockMine) return '编辑中·点此提交';
  // v6.70：过期锁不再等于"可抢"，但 UI 要如实区分——对方是活跃编辑还是可能已离开
  if(lockHolderCid && lockHolderCid!==cloudCid){
    return lockHolderName + (lockHolderStale ? ' 编辑中(可能已离开)' : ' 编辑中');
  }
  return '申请编辑';
}
function startHeart(){
  stopHeart();
  bumpIdle();   // 获取锁后开始计空闲：5分钟无操作自动提交解锁
  lockHeartT=setInterval(async()=>{
    if(!lockMine||!sb){stopHeart();return;}
    // 续锁：刷新 updated_at，并确认 editor 仍是我（被接管则不再续）
    try{ await sb.from(SB_TABLE).update({updated_at:new Date().toISOString()}).eq('id',SB_ROW).eq('editor',cloudCid); }
    catch(_){}
  },LOCK_HEARTBEAT);
}
function stopHeart(){ if(lockHeartT){clearInterval(lockHeartT);lockHeartT=null;} clearIdle(); }
/* v6.70：标签页从后台切回时立即补一次心跳。
   浏览器会节流后台标签的 setInterval（有时拉长到分钟级），导致"人还在、心跳停了"。
   虽然 v6.70 已改成过期也需密码接管，但补心跳能让状态条不再误显示"可能已离开"。 */
if(!window._heartVisBound){
  window._heartVisBound=true;
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible' && lockMine && sb){
      sb.from(SB_TABLE).update({updated_at:new Date().toISOString()})
        .eq('id',SB_ROW).eq('editor',cloudCid).then(()=>{},()=>{});
    }
  });
}

/* ===== 空闲自动解锁：持锁后 5 分钟无任何操作，自动把数据上传并释放编辑锁 =====
   releaseLock 本身就是「先推送最终快照到云端、再清空锁」，等价于「自动上传并解锁」。 */
function clearIdle(){ if(idleReleaseT){clearTimeout(idleReleaseT);idleReleaseT=null;} }
function bumpIdle(){
  // 仅在我持锁时计时；每次有操作就重置 5 分钟倒计时
  clearIdle();
  if(!lockMine)return;
  idleReleaseT=setTimeout(idleAutoRelease,IDLE_AUTO_RELEASE);
}
async function idleAutoRelease(){
  if(!lockMine)return;
  toast('⏱ 已 5 分钟无操作，正在自动提交并释放编辑权…');
  const ok=await releaseLock(true);      // 静默释放（含把最终数据上传云端）
  toast(ok?'🔓 已自动提交并解锁，其他人现在可以编辑':'⚠ 自动提交未确认成功，已保留本地恢复副本，请检查云端状态');
}
/* 全局活动监听：任何指针/键盘/滚动/输入都视为"有操作"，重置空闲计时（仅持锁时生效）。
   一次性绑定，passive 不阻塞滚动；节流避免高频事件频繁打点。 */
let _idleBumpAt=0;
function bindIdleWatch(){
  if(_idleBound)return; _idleBound=true;
  const onAct=()=>{
    if(!lockMine)return;
    const now=Date.now();
    if(now-_idleBumpAt<1000)return;  // 1s 节流
    _idleBumpAt=now; bumpIdle();
  };
  // 不监听 mousemove：鼠标偶尔晃动不应算"操作"，否则永不超时；只认实质交互
  ['pointerdown','mousedown','keydown','wheel','touchstart','input','change'].forEach(ev=>{
    document.addEventListener(ev,onAct,{passive:true,capture:true});
  });
}

/* 当前日期红线即时刷新：每分钟检查系统日期，跨天则更新 TODAY 并重绘红线。
   也在标签页重新可见(visibilitychange)时立即校正——避免电脑休眠唤醒后红线滞后。 */
let _todayWatchBound=false;
function syncTodayChip(){
  const el=document.getElementById('todayChip');
  if(el) el.textContent='📍 今天 '+fmt(TODAY);
}
function refreshToday(){
  const t=todayDate();
  if(t.getTime()===TODAY.getTime()){ syncTodayChip(); return false; }  // 没跨天，仅确保 chip 已填
  TODAY=t; rerender(); syncTodayChip(); return true;                   // 跨天：更新基准日并重绘（红线随 idx(TODAY) 跳到新位置）
}
function bindTodayWatch(){
  if(_todayWatchBound)return; _todayWatchBound=true;
  syncTodayChip();                                 // 初始化立即把"今天 X/X"填上真实日期
  setInterval(refreshToday,60000);                 // 每 60s 轮询一次系统日期
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) refreshToday(); });
}

/* 鼠标中键按住拖动平移视图：在滚动容器 #scroll 内按下中键并拖动，即可左右/上下平移时间线。
   松开中键结束。同时阻止浏览器中键默认的"自动滚动(autoscroll)"模式。 */
let _midPanBound=false;
function bindMidDragPan(){
  if(_midPanBound)return; _midPanBound=true;
  const sc=document.getElementById('scroll');
  if(!sc)return;
  let panning=false, sx=0, sy=0, sl=0, st=0;
  sc.addEventListener('mousedown',e=>{
    if(e.button!==1)return;            // 只响应鼠标中键，不干扰左键拖任务条
    e.preventDefault();                // 阻止中键默认的自动滚动模式
    panning=true; sx=e.clientX; sy=e.clientY; sl=sc.scrollLeft; st=sc.scrollTop;
    sc.classList.add('mid-panning');
  });
  window.addEventListener('mousemove',e=>{
    if(!panning)return;
    sc.scrollLeft = sl - (e.clientX - sx);   // 反向：鼠标右移→内容左移，符合"抓住拖动"直觉
    sc.scrollTop  = st - (e.clientY - sy);
  });
  const endPan=()=>{ if(!panning)return; panning=false; sc.classList.remove('mid-panning'); };
  window.addEventListener('mouseup',endPan);
  window.addEventListener('blur',endPan);
  sc.addEventListener('auxclick',e=>{ if(e.button===1) e.preventDefault(); }); // 兜底拦截中键 auxclick
}

/* 申请编辑：原子抢锁 → 强制拉取并应用云端最新快照 → 进入可编辑态 */
async function acquireLock(force){
  if(!cloudReady||!sb){ toast('云端尚未连接，稍后再试'); return false; }
  // 每轮新租约使用新标签页级 id；旧会话的迟到请求即使随后抵达，也无法命中新锁。
  if(cloudLeaseNeedsRotate) rotateCloudCid();
  cloudSetStatus('syncing',force?'强制接管中…':'申请编辑中…');
  try{
    const nowISO=new Date().toISOString();
    // 条件抢占：仅当(无人持锁 OR 本就是我 OR 强制接管)时才能写成功
    // v6.70 关键安全修正：**删除了 `updated_at.lt.<过期时刻>` 这个条件**。
    //   原来锁过期(>90s无心跳)就能被无密码抢走，但"没心跳"≠"人已离开"——
    //   浏览器把后台标签的定时器节流、笔记本合盖休眠、网络抖动，都会让心跳停摆，
    //   于是有人在你还在编辑时把锁无声拿走（用户实际遭遇）。
    //   现在只认 editor.is.null（对方正常提交或关页时才会被置空）= 真正空闲，
    //   其余情况一律要走「强制接管 + 密码」路径。
    let q=sb.from(SB_TABLE).update({editor:cloudCid,editor_name:cloudWho(),updated_at:nowISO}).eq('id',SB_ROW);
    if(!force){
      // 僵尸锁兜底：2 小时无心跳（断电/崩溃/强杀进程，beacon 没来得及释放）允许免密接管，
      // 否则锁会永久卡死。正常离开（切后台/午休/开会）远达不到 2 小时，仍需密码。
      const zombieISO=new Date(Date.now()-LOCK_ZOMBIE).toISOString();
      q=q.or('editor.is.null,editor.eq.'+cloudCid+',updated_at.lt.'+zombieISO);
    }
    const {data,error}=await q.select('snap,editor,editor_name,updated_at');
    if(error)throw error;
    if(!data||!data.length){
      // 没抢到：可能有人正持有有效锁，也可能云端这行还不存在（首次使用）
      await refreshLockStatus();
      if(!lockHolderCid){
        // 无人持锁却更新到 0 行 → 多半是行不存在，创建并占锁
        const {error:e2}=await sb.from(SB_TABLE).upsert({id:SB_ROW,snap:snapshot(),editor:cloudCid,editor_name:cloudWho(),updated_at:nowISO});
        if(e2)throw e2;
        lockMine=true; lockHolderCid=cloudCid; lockHolderName=cloudWho();
        lastSyncJSON=JSON.stringify(snapshot()); startHeart();
        editBaselineJSON=lastSyncJSON;   // v6.39 记录编辑起点，供「放弃编辑」回滚
        cloudSetStatus('on',lockBtnLabel());
        toast('✅ 已获取编辑权。改动实时保存，编辑完请点「提交」释放');
        return true;
      }
      cloudSetStatus('locked',lockBtnLabel());
      toast('✋ '+(lockHolderName||'有人')+' 正在编辑，请等其提交后再申请');
      return false;
    }
    // 抢到锁后不再开放“失锁者强制上传”宽限期；失锁者只能保存本地恢复副本。
    _takeoverGrace=false;
    clearTimeout(_takeoverGraceT);
    // 强制以云端最新快照刷新本地，保证在最新数据上编辑
    const row=data[0];
    if(row.snap){
      const obj=(typeof row.snap==='string')?JSON.parse(row.snap):row.snap;
      applyingRemote=true; applySnap(obj); applyingRemote=false;
      lastSyncJSON=JSON.stringify(snapshot());
      refreshAllUI();
    }else{
      lastSyncJSON=JSON.stringify(snapshot());
    }
    lockMine=true; lockHolderCid=cloudCid; lockHolderName=cloudWho();
    editBaselineJSON=lastSyncJSON;   // v6.39 记录编辑起点（此时本地已同步到云端最新），供「放弃编辑」回滚
    startHeart();
    syncLockUI();
    toast(force?'✅ 已强制接管编辑权；对方未提交改动将保留在其本地恢复副本':'✅ 已获取编辑权（已同步至最新）。改动实时保存，编辑完请点「提交」释放');
    return true;
  }catch(e){
    // 抢锁请求本身就是一次 Supabase 探针：失败=云端不可达，直接切离线兜底
    // 这样用户不会卡在「申请失败」红色状态无法编辑
    const msg=(e && e.message)?e.message:'';
    const isConn=/network|fetch|503|504|PGRST|timeout/i.test(msg);
    if(isConn) enterOfflineMode('申请失败·已切离线');
    else cloudSetStatus('err','申请失败');
    console.warn('acquire lock failed',e);
    toast(isConn?'☁ 云端不可达，已切离线（可继续编辑，暂存本地）':'申请编辑失败，请稍后重试');
    return false;
  }
}
/* 释放编辑锁：先把最终数据推上去，再清空锁字段，下一个人立即可编辑 */
async function releaseLock(silent){
  cloudWriteBusy=true; stopHeart(); syncLockUI();
  cloudPushEpoch++; cloudPushQueued=false; clearTimeout(cloudPushT);   // 让已排队/在途的旧自动保存失效
  if(!sb){
    cloudWriteBusy=false; lockMine=false; cloudLeaseNeedsRotate=true;
    cloudSetStatus('locked',lockBtnLabel());
    return false;
  }
  let attemptedSnap=null;
  try{
    if(lockMine){
      attemptedSnap=snapshot();
      // 释放锁：带 editor=cloudCid 条件提交最终快照，防止误清除已被他人接管的锁。
      const {data,error}=await sb.from(SB_TABLE)
        .update({snap:attemptedSnap,editor:null,editor_name:null,updated_at:new Date().toISOString()})
        .eq('id',SB_ROW).eq('editor',cloudCid).select('id');
      if(error)throw error;
      if(!data||!data.length)throw new Error('编辑权已变化，提交被拒绝');
      lastSyncJSON=JSON.stringify(attemptedSnap);
    }
  }catch(e){
    console.warn('release lock failed',e);
    cloudWriteBusy=false;
    const state=await reconcileAfterWriteFailure(attemptedSnap||snapshot());
    toast(state==='mine'?'⚠ 提交未成功，仍保留编辑权，请稍后重试':state==='remote'?'云端状态已重新同步，当前已退出编辑':'⚠ 提交结果未知，已转为只读；本地目标版本已保护，若弹窗出现请立即保存副本');
    return false;
  }
  cloudWriteBusy=false;
  lockMine=false; lockHolderCid=''; lockHolderName=''; cloudLeaseNeedsRotate=true;
  editBaselineJSON='';   // v6.39 正常提交后清空基线（改动已确认保存，不再需要回滚点）
  syncLockUI();
  if(!silent) toast('已提交并释放编辑权，其他人现在可以编辑了');
  return true;
}
/* 放弃编辑：把数据回滚到「获取编辑权那一刻」的基线，并把基线推回云端，再释放锁。
   v6.39 根因修复：旧实现是「从云端重拉」，但持锁期间每次改动都被 cloudPush 自动写进云端了，
   云端存的就是改过的数据 → 重拉回来等于没还原（功能完全失效）。
   现改为用 editBaselineJSON（进入编辑时的本地快照）回滚，并覆盖推回云端，撤销这段时间的所有自动保存。 */
async function discardEdit(){
  if(!lockMine) return;
  if(!editBaselineJSON){
    toast('⚠ 未找到编辑起点基线，无法安全回滚。请手动改回或刷新页面');
    return;
  }
  // 有没有实际改动？没改动就只是退出编辑模式
  const curJSON=JSON.stringify(snapshot());
  const changed=(curJSON!==editBaselineJSON);
  const msg=changed
    ? '确定放弃本次编辑的所有改动吗？\n\n数据将回滚到你获取编辑权那一刻的状态，\n本次编辑期间已自动保存到云端的改动也会被一并撤销。'
    : '本次编辑没有改动，确定退出编辑模式吗？';
  if(!confirm(msg)) return;

  // 事务期间先切只读，防止用户在回滚 payload 已生成后又产生新修改。
  cloudWriteBusy=true; stopHeart(); syncLockUI();
  // 取消待推送；epoch 会让已经进入异步流程的旧 cloudPush 也失效。
  cloudPushEpoch++; cloudPushQueued=false;
  clearTimeout(cloudPushT);

  let attemptedSnap=null;
  if(changed){
    toast('正在回滚数据…');
    try{
      const base=JSON.parse(editBaselineJSON);
      // 1) 先在内存外构造回滚 payload：业务数据来自基线，审计日志保留当前全部记录并追加本次“放弃编辑”。
      //    云端确认成功前绝不改写当前界面，避免条件更新失败时出现“本地已回滚、云端未回滚”的假象。
      const auditSnap=JSON.parse(JSON.stringify(base)); delete auditSnap._log;
      const rollbackLog=CHANGELOG.slice();
      rollbackLog.push({
        id:Date.now()+'-'+cloudCid+'-'+(_logSeq++),
        t:Date.now(), who:cloudWho(),
        desc:'放弃本次编辑，回滚到获取编辑权时的状态',
        snap:auditSnap
      });
      if(rollbackLog.length>LOG_MAX)rollbackLog.splice(0,rollbackLog.length-LOG_MAX);
      const rollbackSnap=JSON.parse(JSON.stringify(base));
      rollbackSnap._log=rollbackLog;
      attemptedSnap=rollbackSnap;
      const rollbackJSON=JSON.stringify(rollbackSnap);
      // 2) 必须带 editor=cloudCid 条件；如果期间已被接管，禁止覆盖新持锁者的数据。
      const {data,error}=await sb.from(SB_TABLE)
        .update({snap:rollbackSnap,editor:null,editor_name:null,updated_at:new Date().toISOString()})
        .eq('id',SB_ROW).eq('editor',cloudCid).select('id');
      if(error)throw error;
      if(!data||!data.length)throw new Error('编辑权已变化，放弃编辑被拒绝');
      // 3) 云端确认成功后再同步本地业务数据与审计日志。
      applyingRemote=true; applySnap(base); applyingRemote=false;
      CHANGELOG=rollbackLog;
      lastSyncJSON=rollbackJSON;
      save(); refreshAllUI();
    }catch(e){
      console.warn('discard rollback failed',e);
      cloudWriteBusy=false;
      const state=await reconcileAfterWriteFailure(attemptedSnap||snapshot());
      toast(state==='mine'?'⚠ 回滚未成功，仍保留编辑权，请重试':state==='remote'?'云端状态已重新同步，本次未覆盖他人数据':'⚠ 回滚结果未知，已转为只读；本地目标版本已保护，若弹窗出现请立即保存副本');
      return;
    }
  }else{
    // 无改动：只释放锁。Supabase 客户端会把服务端错误放在 result.error，必须显式检查。
    attemptedSnap=snapshot();
    try{
      const {data,error}=await sb.from(SB_TABLE)
        .update({editor:null,editor_name:null,updated_at:new Date().toISOString()})
        .eq('id',SB_ROW).eq('editor',cloudCid).select('id');
      if(error)throw error;
      if(!data||!data.length){const lost=new Error('编辑权已变化，退出编辑被拒绝');lost.lockLost=true;throw lost;}
    }catch(e){
      console.warn('discard lock release failed',e);
      cloudWriteBusy=false;
      const state=await reconcileAfterWriteFailure(attemptedSnap);
      toast(state==='mine'?'⚠ 退出编辑未成功，仍保留编辑权，请重试':state==='remote'?'云端状态已重新同步，当前已退出编辑':'⚠ 退出结果未知，已转为只读；本地目标版本已保护，若弹窗出现请立即保存副本');
      return;
    }
  }

  cloudWriteBusy=false;
  lockMine=false; lockHolderCid=''; lockHolderName=''; cloudLeaseNeedsRotate=true;
  editBaselineJSON='';
  syncLockUI();
  toast(changed?'✅ 已放弃编辑，数据已回滚到编辑前状态':'已退出编辑模式');
}
/* 仅刷新锁状态（用于抢锁失败后了解是谁占着） */
async function refreshLockStatus(){
  try{
    const {data,error}=await sb.from(SB_TABLE).select('editor,editor_name,updated_at').eq('id',SB_ROW).maybeSingle();
    if(error)throw error;
    if(data) updateLockFromRow(data);
    return data||null;
  }catch(_){return null;}
}
/* 提交/放弃的响应可能丢失：不能凭 catch 猜测锁仍属于我。重拉完整云端行后再决定本地状态。
   attemptedSnap 是本次条件写真正想提交的最终版本；若远端不包含它，必须先保留恢复副本再加载远端。 */
async function reconcileAfterWriteFailure(attemptedSnap){
  cloudWriteBusy=false;
  const intended=attemptedSnap||snapshot();
  try{
    const {data,error}=await sb.from(SB_TABLE).select('snap,editor,editor_name,updated_at').eq('id',SB_ROW).maybeSingle();
    if(error)throw error;
    if(!data)throw new Error('云端状态为空');
    if(data.editor===cloudCid){
      // 锁仍属于我：按正常锁状态刷新并恢复心跳，页面中的目标版本继续保留，允许用户重试。
      updateLockFromRow(data);
      lockMine=true; startHeart(); syncLockUI();
      return 'mine';
    }

    const remoteSnap=data.snap?((typeof data.snap==='string')?JSON.parse(data.snap):data.snap):null;
    const remoteHasIntended=!!remoteSnap && JSON.stringify(remoteSnap)===JSON.stringify(intended);
    if(!remoteHasIntended){
      // 条件写确实未落到云端，或落地后又被其他编辑覆盖。覆盖当前页面前先持久化本次目标版本。
      try{
        storePendingSnapshot(intended,true);
      }catch(pendingError){
        console.warn('write-failure pending save failed',pendingError);
        takeoverFrozenSnap=compactPendingSnapshot(intended);
        lockMine=false; stopHeart(); cloudLeaseNeedsRotate=true;
        updateLockFromRow(data); syncLockUI();
        // 不加载远端，保持当前页面和冻结副本；弹出明确的重试入口，避免用户误以为已经持久化后直接关页。
        openTakeoverDialog(lockHolderName||'当前编辑者');
        cloudSetStatus('err','云端已变化 · 请保存本地恢复副本');
        return 'unknown';
      }
    }

    // 可能是服务端已成功但响应丢失，也可能是失锁后已先保存 pending。此时才允许切换到远端真实状态。
    // 先退出本地持锁态，避免 updateLockFromRow() 把“自己刚释放成功”误判为强制接管并弹窗。
    lockMine=false; stopHeart(); editBaselineJSON=''; cloudLeaseNeedsRotate=true;
    updateLockFromRow(data);
    if(remoteSnap){
      applyingRemote=true; applySnap(remoteSnap); applyingRemote=false;
      lastSyncJSON=JSON.stringify(snapshot()); save(); refreshAllUI();
    }
    syncLockUI();
    return 'remote';
  }catch(e){
    console.warn('reconcile write failure failed',e);
    // 两次网络结果都未知时绝不能假定仍持锁。冻结写入并保留本次实际尝试提交的版本。
    let pendingSaved=false;
    try{
      storePendingSnapshot(intended,true);
      pendingSaved=true;
    }catch(err){
      console.warn('unknown-state pending save failed',err);
      takeoverFrozenSnap=compactPendingSnapshot(intended);
    }
    // 保留当前 cid，待网络恢复后先核对旧锁；此时不自动轮换，避免把仍属于自己的锁变成孤儿锁。
    lockMine=false; stopHeart();
    syncLockUI();
    if(!pendingSaved)openTakeoverDialog('云端状态未知');
    cloudSetStatus('err',pendingSaved?'云端状态待确认 · 本地副本已保留':'云端状态待确认 · 请保存本地恢复副本');
    return 'unknown';
  }
}
/* 右上角云端指示器点击入口：在"申请编辑 ↔ 提交释放"之间切换 */
function cloudUnlock(){
  if(!cloudReady){ toast('云端尚未连接，稍后再试'); return; }
  if(lockMine){ releaseLock(); return; }
  /* v6.75：未确认身份前不允许获取编辑权 —— 否则锁上会写「某成员」，
     团队根本不知道是谁在编辑，等于回到了"匿名可改"的老问题。
     优先引导企微登录（真实可信），允许手动降级（带警告）。 */
  if(typeof needIdentityConfirm==='function' && needIdentityConfirm()){
    toast('请先确认你的身份（推荐企微登录），再申请编辑权');
    openIdentityDialog();
    return;
  }
  /* v6.75 额外提示：如果身份未企微验证，提醒用户 */
  if(!wecomVerified && meId){
    // 不阻断，只提示一次（通过 toast 让用户知道当前身份可信度低）
    console.log('Editing with unverified identity:', memName(meId));
  }
  // 离线/失败状态：点状态条=先重试连接，成功就进入正常申请路径
  if(cloudOffline){
    cloudSetStatus('syncing','重连中…');
    tryReconnect();
    return;
  }
  if(lockHolderCid && lockHolderCid!==cloudCid){
    /* v6.70：有人占着锁（**无论心跳是否超时**）都必须输强制解锁密码才能接管。
       锁超时只是提示"对方可能已离开"，不再是免密通行证 —— 因为浏览器后台节流/
       休眠/断网都会让心跳停摆，而人其实还在编辑（用户实际遭遇的事故）。
       唯一例外：僵尸锁（2 小时无心跳，多为断电/崩溃）免密接管，防止锁永久卡死。 */
    if(lockHolderZombie){
      if(!confirm('「'+lockHolderName+'」的编辑锁已超过 2 小时无任何心跳，\n判定为异常残留（可能是断电/浏览器崩溃未正常释放）。\n\n确定直接接管编辑权吗？')) return;
      acquireLock(false);   // 僵尸锁走普通申请路径即可（SQL 条件已放行）
      return;
    }
    const staleNote = lockHolderStale
      ? '\n\n⚠ 对方心跳已超过 90 秒未更新（可能已离开，也可能只是切到后台/网络不稳，人仍在编辑）。'
      : '\n\n对方正在活跃编辑中。';
    const pin=prompt('当前「'+lockHolderName+'」持有编辑权。'+staleNote+
      '\n\n如需强制接管，请输入【强制解锁密码】：\n（非团队口令。接管后对方会收到确认弹窗，其未提交改动可选择上传保存）');
    if(pin==null) return;                       // 取消＝继续等待
    if(pin.trim()!==FORCE_UNLOCK_PIN){ toast('❌ 强制解锁密码不正确，无法接管'); return; }
    acquireLock(true);                          // 密码正确 → 强制接管
    return;
  }
  acquireLock(false);
}

/* ============ 团队链接分享（把当前排期编码进 URL，零后端、永不过期） ============ */
// 用 URL 安全的 base64 编码 JSON 快照
function encState(obj){
  const json=JSON.stringify(obj);
  const utf8=encodeURIComponent(json).replace(/%([0-9A-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
  return btoa(utf8).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function decState(str){
  try{
    let b=str.replace(/-/g,'+').replace(/_/g,'/'); while(b.length%4)b+='=';
    const utf8=atob(b);
    const json=decodeURIComponent(Array.prototype.map.call(utf8,c=>'%'+('00'+c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json);
  }catch(_){return null;}
}
function shareLink(){
  const snap=snapshot();
  const code=encState(snap);
  const base=location.origin+location.pathname;
  const url=base+'#s='+code;
  // 优先写入剪贴板
  const done=()=>showShareBox(url, code.length);
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(()=>{toast('✅ 团队链接已复制，发给同事即可');done();}).catch(done);
  }else{ done(); }
}
function showShareBox(url, len){
  let box=document.getElementById('shareBox');
  if(!box){
    box=document.createElement('div'); box.id='shareBox'; box.className='share-box';
    document.body.appendChild(box);
  }
  box.innerHTML=`
    <div class="sb-card">
      <div class="sb-h">🔗 团队分享链接已生成</div>
      <div class="sb-tip">把下面的链接发给同事，他们打开就能看到<b>你当前的最新排期</b>（含所有拖拽改动）。链接永久有效、不依赖任何服务器。</div>
      <textarea class="sb-url" readonly onclick="this.select()">${url}</textarea>
      <div class="sb-row">
        <button class="sb-copy" onclick="(function(){const t=document.querySelector('#shareBox .sb-url');t.select();navigator.clipboard&&navigator.clipboard.writeText(t.value);toast('已复制到剪贴板');})()">📋 复制链接</button>
        <button class="sb-close" onclick="document.getElementById('shareBox').classList.remove('show')">关闭</button>
      </div>
      <div class="sb-foot">提示：链接较长属正常（已内嵌完整排期数据，约 ${(len/1024).toFixed(1)} KB）。同事改动只在他自己页面，不会回传给你——如需汇总，请大家把各自链接发回。</div>
    </div>`;
  box.classList.add('show');
}
// 启动时：若 URL 带 #s=，则用链接里的排期覆盖
function loadFromHash(){
  const m=location.hash.match(/[#&]s=([^&]+)/);
  if(!m)return false;
  const snap=decState(m[1]);
  if(snap){ applySnap(snap); return true; }
  return false;
}

/* ============ 导出同步包（写回企微表用，含可读字段） ============ */
function fmtDate(d){
  const y=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),da=String(d.getDate()).padStart(2,'0');
  return `${y}-${mo}-${da}`;
}
function exportSync(){
  const id2name={}; members.forEach(m=>id2name[m.id]=m.name);
  const rows=reqs.map(r=>{
    let minS=null; (r.segs||[]).forEach(s=>{if(!minS||s.s<minS)minS=s.s;});
    const start=minS?fmtDate(minS):fmtDate(r.end);
    const makers=[...new Set((r.segs||[]).map(s=>id2name[s.m]||s.m))].join('、');
    const anyDoing=(r.segs||[]).some(s=>s.status==='doing');
    const status=anyDoing?'进行中':'未开始';
    const prog=r.estimate>0?Math.round(r.done/r.estimate*100):0;
    const firstSeg=(r.segs||[])[0];
    let owner='';
    if(firstSeg){const mem=members.find(m=>m.id===firstSeg.m);
      if(mem){owner=(mem.corp==='base'&&mem.lead&&!mem.lead.includes('角')&&mem.lead!=='—')?mem.lead:mem.name;}}
    return {reqId:r.id, 需求名称:`${r.char} · ${r.name}`, 角色:r.char, 品级:r.grade||'通用',
      负责人:owner, 状态:status, 开始日期:start, 截止日期:fmtDate(r.end),
      工作量人天:r.estimate, 完成进度:prog, 制作人列表:makers};
  });
  const pkg={kind:'vfx-gantt-sync', sheet:'q979lj', ts:new Date().toISOString(), count:rows.length, rows};
  const text=JSON.stringify(pkg,null,2);
  // 优先：复制到剪贴板（粘贴到对话即可写回企微，无需下载/上传文件）
  function fallbackDownload(){
    const blob=new Blob([text],{type:'application/json'});
    const a=document.createElement('a');
    const fn='排期同步包_'+fmtDate(new Date())+'.json';
    a.href=URL.createObjectURL(blob); a.download=fn;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    toast('⚠ 剪贴板不可用，已改为下载文件，发给我即可');
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text)
      .then(()=>toast('✅ 已复制'+rows.length+'条排期，直接粘贴到对话发我即可写回企微'))
      .catch(fallbackDownload);
  }else{
    // 老浏览器：用临时 textarea + execCommand 兜底
    try{
      const ta=document.createElement('textarea');
      ta.value=text; ta.style.position='fixed'; ta.style.left='-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok=document.execCommand('copy'); document.body.removeChild(ta);
      if(ok)toast('✅ 已复制'+rows.length+'条排期，直接粘贴到对话发我即可写回企微');
      else fallbackDownload();
    }catch(_){ fallbackDownload(); }
  }
}

/* ============ 撤销 / 重做（操作历史栈） ============ */
let undoStack=[], redoStack=[];
const HIST_MAX=60;
function curState(){return JSON.stringify(snapshot());}
/* 在“即将发生改动”之前调用：把当前状态压入 undo 栈，并清空 redo */
function pushHistory(){
  undoStack.push(curState());
  if(undoStack.length>HIST_MAX) undoStack.shift();
  redoStack.length=0;
  updateUndoUI();
}
function updateUndoUI(){
  const u=document.getElementById('undoBtn'), r=document.getElementById('redoBtn');
  if(u)u.disabled=undoStack.length===0;
  if(r)r.disabled=redoStack.length===0;
}
function undo(){
  if(!requireWrite())return;
  if(!undoStack.length){toast('没有可撤销的操作');return;}
  redoStack.push(curState());
  const prev=undoStack.pop();
  applySnap(JSON.parse(prev));
  updateUndoUI();save();broadcast();rerender();
  if(typeof applyEffLockUI==='function')applyEffLockUI();
  if(typeof applyStdLockUI==='function')applyStdLockUI();if(typeof applyInvLockUI==='function')applyInvLockUI();
  toast('已撤销');
}
function redo(){
  if(!requireWrite())return;
  if(!redoStack.length){toast('没有可重做的操作');return;}
  undoStack.push(curState());
  const next=redoStack.pop();
  applySnap(JSON.parse(next));
  updateUndoUI();save();broadcast();rerender();
  if(typeof applyEffLockUI==='function')applyEffLockUI();
  if(typeof applyStdLockUI==='function')applyStdLockUI();if(typeof applyInvLockUI==='function')applyInvLockUI();
  toast('已重做');
}
/* 快捷键：Ctrl/Cmd+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做，Ctrl+C 复制，Ctrl+X 剪切，Ctrl+V 粘贴，Esc 取消 */
window.addEventListener('keydown',e=>{
  const tag=(e.target.tagName||'').toLowerCase();
  if(tag==='input'||tag==='select'||tag==='textarea')return;
  if(e.key==='Escape'){ if(clip){clearClip();} setSelected(null); setSelectedMem(null); hideMenu(); return; }
  if(e.key==='Delete'||e.key==='Backspace'){
    if(!requireWrite())return;   // 只读模式：禁止删除
    if(selectedBar && selectedBar.seg!==null){
      e.preventDefault();
      removeSeg(selectedBar.reqId, selectedBar.seg);
    }else if(selectedBar){
      toast('请选中某个人的任务段再删除（按人看里更精确）');
    }
    return;
  }
  const ctrl=e.ctrlKey||e.metaKey;
  if(!ctrl)return;
  const k=e.key.toLowerCase();
  if(k==='z'&&!e.shiftKey){e.preventDefault();if(requireWrite())undo();}
  else if(k==='y'||(k==='z'&&e.shiftKey)){e.preventDefault();if(requireWrite())redo();}
  else if(k==='c'){e.preventDefault();doCopy(false);}
  else if(k==='x'){e.preventDefault();if(requireWrite())doCopy(true);}
  else if(k==='v'){e.preventDefault();if(requireWrite())doPaste();}
});

/* —— 跨标签页实时同步 —— */
let bc=null;
try{bc=new BroadcastChannel('gantt_collab');}catch(_){}

/* ============ 变更记录面板 + 回退 ============ */
function fmtLogTime(t){
  const d=new Date(t), now=new Date();
  const pad=n=>('0'+n).slice(-2);
  const hm=pad(d.getHours())+':'+pad(d.getMinutes());
  const sameDay=d.toDateString()===now.toDateString();
  if(sameDay)return '今天 '+hm;
  const y=new Date(now-86400000);
  if(d.toDateString()===y.toDateString())return '昨天 '+hm;
  return (d.getMonth()+1)+'月'+d.getDate()+'日 '+hm;
}
function toggleLogPanel(){
  let p=document.getElementById('logPanel');
  if(!p){
    p=document.createElement('div'); p.id='logPanel'; p.className='log-panel';
    p.innerHTML='<div class="lp-h"><b>🕑 变更记录</b><button class="lp-x" onclick="toggleLogPanel()">×</button></div>'
      +'<div class="lp-tip">每条改动自动留痕（含时间·操作人）。点「回退」可把整份排期恢复到该条记录时的状态——回退本身也会记一条，可再撤销。记录随团队链接/云端同步。</div>'
      +'<div class="lp-list" id="logList"></div>';
    document.body.appendChild(p);
    requestAnimationFrame(()=>p.classList.add('show'));
    renderLogPanel();
    return;
  }
  if(p.classList.contains('show')){ p.classList.remove('show'); }
  else { p.classList.add('show'); renderLogPanel(); }
}
function renderLogPanel(){
  const box=document.getElementById('logList'); if(!box)return;
  if(!CHANGELOG.length){ box.innerHTML='<div class="lp-empty">暂无变更记录。<br>开始编辑后，这里会自动记录每一步改动。</div>'; return; }
  const ro=!canWrite();
  box.innerHTML=CHANGELOG.slice().reverse().map(e=>{
    const safe=String(e.desc||'数据更新').replace(/</g,'&lt;');
    const who=String(e.who||'某成员').replace(/</g,'&lt;');
    return '<div class="log-item"><span class="li-dot"></span><div class="li-main">'
      +'<div class="li-desc">'+safe+'</div>'
      +'<div class="li-meta"><b>'+who+'</b> · '+fmtLogTime(e.t)+'</div></div>'
      +(ro
        ?'<button class="li-revert is-readonly" title="需先申请编辑权" onclick="requireWrite()">需编辑权</button>'
        :'<button class="li-revert" onclick="revertTo(\''+e.id+'\')">回退到此</button>')
      +'</div>';
  }).join('');
}
function revertTo(id){
  if(!requireWrite())return;
  const e=CHANGELOG.find(x=>x.id===id); if(!e||!e.snap){toast('该记录已失效');return;}
  if(!confirm('确定把整份排期回退到这条记录时的状态？\n\n「'+e.desc+'」\n'+fmtLogTime(e.t)+'　'+e.who+'\n\n（回退会保留之前所有记录，且本次回退也可撤销）'))return;
  pushHistory();
  // 用历史快照覆盖当前数据（保留 CHANGELOG 本身，不被快照里的旧 _log 截断）
  const keepLog=CHANGELOG.slice();
  applySnap(JSON.parse(JSON.stringify(e.snap)));
  CHANGELOG=keepLog;
  _logDesc='回退到「'+e.desc+'」（'+fmtLogTime(e.t)+'）';
  save();broadcast();rerender();
  if(typeof applyEffLockUI==='function')applyEffLockUI();
  if(typeof applyStdLockUI==='function')applyStdLockUI();if(typeof applyInvLockUI==='function')applyInvLockUI();
  renderLogPanel();
  toast('已回退到该历史版本');
}

function broadcast(){
  // 留痕：每次本地改动落一条变更记录（拖拽等连续操作做合并，避免刷屏）
  if(!applyingRemote) recordLog(_logDesc||'排期更新');
  _logDesc='';
  // 多数写操作在 broadcast() 前先 save()；此前会导致本地副本永远少最新一条日志。
  // 这里在 recordLog() 后再落盘一次，保证本地恢复点与实际广播/云端内容一致。
  save();
  const payload=JSON.stringify(snapshot());
  if(bc)bc.postMessage({from:meId,data:payload});
  if(typeof cloudPush==='function')cloudPush();   // 同步到云端（防抖，仅有写权限时生效）
}
/* 记录变更：1.5 秒内同一类操作合并为一条（更新其时间与结果快照） */
function recordLog(desc){
  const now=Date.now();
  const last=CHANGELOG[CHANGELOG.length-1];
  if(last && last.who===(typeof cloudWho==='function'?cloudWho():'某成员') && last.desc===desc && (now-last.t)<1500){
    last.t=now; last.snap=coreSnapshot();
  }else{
    CHANGELOG.push({ id:now+'-'+cloudCid+'-'+(_logSeq++), t:now, who:(typeof cloudWho==='function'?cloudWho():'某成员'), desc:desc||'数据更新', snap:coreSnapshot() });
    if(CHANGELOG.length>LOG_MAX) CHANGELOG.splice(0,CHANGELOG.length-LOG_MAX);
  }
  if(document.getElementById('logPanel')) renderLogPanel();
}
if(bc){
  bc.onmessage=ev=>{
    if(!ev.data||ev.data.from===meId)return;
    applySnap(JSON.parse(ev.data.data));
    rerender();
    if(typeof applyEffLockUI==='function')applyEffLockUI();
    if(typeof applyStdLockUI==='function')applyStdLockUI();if(typeof applyInvLockUI==='function')applyInvLockUI();
    toast('收到协作更新（来自其他标签页）');
  };
}
// localStorage 跨标签兜底
window.addEventListener('storage',e=>{
  if(e.key===KEY && e.newValue){applySnap(JSON.parse(e.newValue));rerender();if(typeof applyEffLockUI==='function')applyEffLockUI();if(typeof applyStdLockUI==='function')applyStdLockUI();if(typeof applyInvLockUI==='function')applyInvLockUI();}
});

/* ============ “我是谁” ============ */
/* v6.71 身份可信度改进（方案1：引导正确填写）。
   背景：上一轮审计发现身份完全靠自选、零校验，有人顶着别人的名字编辑（用户实际遭遇）。
   纯静态页无后端，做不到真身份校验（那需要企微 OAuth + 服务端换 token），
   故采取三项"降低误选与冒用成本"的措施：
     ① 首次打开必须在模态窗里明确选择本人，不选无法使用（旧版默认取 members[0]=余洪震，
        导致任何新用户不选身份就顶着余洪震的名字操作）；
     ② 「暂缺占位」与「已离职」成员从身份候选中剔除（用户被顶那次，对方身份就是"暂缺"）；
     ③ 切换身份时二次确认并写入变更记录，让冒用留痕、可追溯。 */
const ME_CONFIRM_KEY='gantt_me_confirmed';
/* 可选作"我是谁"的成员：排除暂缺占位（非真人）与已离职（不应再操作看板）。
   兜底：若过滤后为空（极端数据），退回全量，避免用户被卡死无法进入。 */
function selectableMembers(){
  const list=members.filter(m=>!isVacantMem(m) && !effLeft(m));
  return list.length?list:members.slice();
}
let meId=localStorage.getItem('gantt_me')||'';
let focusMode=localStorage.getItem('gantt_focus')||'off';   // off | hl | only
/* 身份选项文案（顶部下拉与首次确认弹窗共用，保证两处显示一致） */
function fmtMeOption(m){
  const chars = (m.leadChars||'').split(',').filter(Boolean);
  const mods  = (m.leadMods||'').split(',').filter(Boolean);
  let detail = m.role || '';
  if((m.corp==='reg'||m.corp==='sub') && (chars.length||mods.length)){
    if(chars.length > 0){
      const pairs = chars.map((c,i)=>{
        const s=Math.round(i*mods.length/chars.length), e=Math.round((i+1)*mods.length/chars.length);
        const rm=mods.slice(s,e);
        return rm.length ? c+'('+rm.join(' ')+')' : c;
      });
      detail = pairs.join(' / ');
    } else if(mods.length){
      detail = mods.join('/');
    }
  }
  return `${m.name}（${detail || m.role}）`;
}
function buildMeSel(){
  const sel=document.getElementById('meSel'); if(!sel) return;
  // v6.71：只列可选身份（排除暂缺占位/已离职）
  sel.innerHTML=selectableMembers().map(m=>`<option value="${m.id}" ${m.id===meId?'selected':''}>${escAttr(fmtMeOption(m))}</option>`).join('');
  const fs=document.getElementById('focusSel'); if(fs) fs.value=focusMode;
  // v6.75：同步验证状态徽章
  const badge=document.getElementById('wecomBadge');
  if(badge){
    badge.className='wecom-badge';
    if(wecomVerified){
      badge.classList.add('verified');
      badge.textContent='✅ 已验证';
      badge.title='企微OAuth实名验证 · '+ (wecomUserInfo?.name || '');
    } else if(meId){
      badge.classList.add('unverified');
      badge.textContent='⚠ 未验证';
      badge.title='手动选择身份，未通过企微验证 · 点击重新认证';
    } else {
      badge.classList.add('none');
      badge.textContent='未设置';
      badge.title='未设置身份 · 点击设置';
    }
  }
}

/* v6.75 身份确认判定（企微优先）：
   1. 已通过企微验证且缓存未过期 → 不需要重新确认
   2. 有手动选择的 meId 且在可选名单中 → 允许使用（但标记为未验证）
   3. 其他情况 → 需要弹窗确认身份 */
function needIdentityConfirm(){
  // 企微验证有效 → 直接放行
  if(wecomVerified) return false;
  // 尝试恢复缓存的企微验证
  if(restoreWecomCache()) return false;
  // 降级：检查旧版手动选择
  try{ var c = localStorage.getItem(ME_CONFIRM_KEY)==='1'; }catch(_){c=false;}
  const valid = meId && selectableMembers().some(m=>m.id===meId);
  return !c || !valid;
}

/* v6.75 打开身份确认弹窗（企微登录为主 + 手动降级）*/
function openIdentityDialog(){
  const mask=document.getElementById('idnMask');
  if(!mask){
    if(!meId) meId=selectableMembers()[0].id;
    return;
  }
  // 重置状态：隐藏手动降级区域，隐藏确认按钮
  const fallback=document.getElementById('idnManualFallback');
  if(fallback) fallback.style.display='none';
  const okBtn=document.getElementById('idnOk');
  if(okBtn) okBtn.style.display='none';

  // 如果企微未配置，直接显示手动降级
  const { corpId, agentId, redirectUri } = WECOM_AUTH_CONFIG;
  if(!corpId || !agentId || !redirectUri){
    showManualIdentityFallback();
    // 填充手动选择列表
    const sel=document.getElementById('idnSel');
    if(sel){
      const list=selectableMembers();
      sel.innerHTML='<option value="" disabled selected>— 请选择你的姓名 —</option>'
        + list.map(m=>`<option value="${m.id}">${escAttr(fmtMeOption(m))}</option>`).join('');
      sel.onchange=()=>{ if(okBtn){ okBtn.disabled=!sel.value; okBtn.style.display=sel.value?'':'none'; } };
      if(okBtn) okBtn.style.display='none';
    }
  }

  mask.classList.add('show');
}

/* v6.75 确认手动选择的身份（降级路径，无企微验证）*/
function confirmIdentity(){
  const sel=document.getElementById('idnSel');
  if(!sel||!sel.value){ toast('请先选择你的姓名'); return; }
  meId=sel.value;
  wecomVerified = false;  // 手动选择 = 未验证
  try{
    localStorage.setItem('gantt_me',meId);
    localStorage.setItem(ME_CONFIRM_KEY,'1');
    // 清除旧的企微验证（用户主动选择了手动模式）
    localStorage.removeItem(WECOM_VERIFIED_KEY);
  }catch(_){}
  const mask=document.getElementById('idnMask'); if(mask) mask.classList.remove('show');
  buildMeSel();
  rerender();
  toast('⚠️ 身份已设置（未验证）：'+memName(meId)+'　· 编辑时团队会看到「未验证」标记');
}

/* v6.75 跳过身份确认（只读模式）*/
function skipIdentity(){
  meId = '';
  wecomVerified = false;
  try{
    localStorage.removeItem('gantt_me');
    localStorage.removeItem(ME_CONFIRM_KEY);
  }catch(_){}
  const mask=document.getElementById('idnMask'); if(mask) mask.classList.remove('show');
  buildMeSel();
  rerender();
  toast('已跳过身份确认 · 当前为只读模式 · 需要编辑时可点击右上角「申请编辑」');
}
function changeMe(){
  const sel=document.getElementById('meSel');
  const next=sel.value;
  if(next===meId) return;
  // v6.71/v6.75：切换身份=改变团队看到的"是谁在改"，故二次确认 + 留痕，让冒用可追溯
  const from=memName(meId)||'(未设置)', to=memName(next);
  // v6.75：如果当前是企微验证身份，警告用户
  let extraMsg = '';
  if(wecomVerified){
    extraMsg = '\n\n⚠️ 你当前是「企微验证」身份，切换到手动选择后将失去验证标记。\n团队会看到你的身份变为「未验证」。';
  }
  if(!confirm('确定把身份从「'+from+'」切换为「'+to+'」吗？\n\n'
    +'· 身份会显示在编辑权提示与变更记录里\n'
    +'· 本次切换会写入「变更记录」'
    +'· 请勿冒用他人身份，否则会误导团队判断谁在编辑'
    +extraMsg)){
    sel.value=meId;   // 取消：回滚下拉，避免显示与实际身份不一致
    return;
  }
  const prev=meId;
  meId=next;
  wecomVerified = false;  // 手动切换 = 不再是企微验证
  try{
    localStorage.setItem('gantt_me',meId);
    localStorage.setItem(ME_CONFIRM_KEY,'1');
    localStorage.removeItem(WECOM_VERIFIED_KEY);  // 清除企微验证缓存
  }catch(_){}
  // 留痕：仅在有写权限时才产生记录（只读模式下切身份不该写云端）
  if(typeof canWrite==='function' && canWrite()){
    _logDesc='身份切换：'+from+' → '+to;
    if(typeof broadcast==='function') broadcast();
  }
  toast('已切换身份：'+memName(meId)+(prev?'（原：'+from+'）':'')+(wecomVerified ? ' · ✅ 已验证' : ' · ⚠️ 未验证'));
  rerender();   // 始终重渲染，保证「我/我的团队」高亮与底部标签同步更新（不再受 focusMode 限制）
}
function changeFocus(){
  focusMode=document.getElementById('focusSel').value;
  localStorage.setItem('gantt_focus',focusMode);
  if(view!=='person'){toast('视角筛选/高亮仅在「按人看」生效');}
  else{
    const me=memById(meId);
    const cnt=members.filter(m=>focusRole(m)!=='').length;
    toast(focusMode==='off'?'已显示全部成员':focusMode==='hl'?`已高亮 ${me?me.name:''} 及其团队（${cnt}人）`:`已筛选只看 ${me?me.name:''} 及其团队（${cnt}人）`);
  }
  rerender();
}

/* ============ 切换 / 渲染 ============ */
let view='person';
let colorMode='status';
/* ============ 效率档位表：渲染 + 编辑交互 ============ */
function effEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function memNm(id){const m=members.find(x=>x.id===id);return m?m.name:id;}
function renderEffTable(){
  const box=document.getElementById('effTiers'); if(!box)return;
  const ua=unassignedMems();
  const EL=effLockedView();
  let html='';
  EFF_TIERS.forEach((t,ti)=>{
    const tCoef=Number(t.coef)||1;
    // 每个成员 chip：离职灰化 + 显示当前 eff 值 + 不匹配角标
    const chips=(t.mems||[]).map(id=>{
      const m=members.find(x=>x.id===id);
      if(!m) return '';
      const isLeft=effLeft(m);
      const curEff=m.eff!=null?m.eff:1;
      const mismatch=Math.abs(curEff-tCoef)>0.001;
      const leftCls=isLeft?' is-left':'';
      const effBadge=mismatch?`<span class="eff-mismatch" title="该成员实际效率 ${curEff} 与本档系数 ${tCoef} 不一致，点击下方「同步」修正">⚠${curEff}</span>`:`<span class="eff-val">${curEff}</span>`;
      return `<span class="eff-chip${leftCls}" data-ti="${ti}" data-id="${id}" title="${isLeft?'已离职，已自动脱离档位':'拖到其它档可移动；拖到底部黄色区=移出'} · 当前效率=${curEff}">${effEsc(m.name)}${effBadge}<span class="x" data-act="rmMem" data-ti="${ti}" data-id="${id}" title="移出该档">×</span></span>`;
    }).join('');
    html+=`<div class="eff-row" data-droptier="${ti}">
      <input class="ef-coef" type="number" step="0.05" min="0" value="${t.coef}" data-act="coef" data-ti="${ti}" title="效率系数"${EL?' readonly':''}>
      <input class="ef-label" type="text" value="${effEsc(t.label)}" data-act="label" data-ti="${ti}" placeholder="对应人群说明"${EL?' readonly':''}>
      <div class="eff-mems">${chips||'<span style="font-size:11px;color:var(--tx3)">（拖人到此档）</span>'}</div>
      <button class="eff-del-tier" data-act="delTier" data-ti="${ti}" title="删除该档">×</button>
    </div>`;
  });
  // 未分档区：显示所有未归档成员（含离职灰化）
  const uaChips=ua.map(m=>{
    const isLeft=effLeft(m);
    const curEff=m.eff!=null?m.eff:1;
    const leftCls=isLeft?' is-left':'';
    return `<span class="eff-chip${leftCls}" data-ti="-1" data-id="${m.id}" title="${isLeft?'已离职':'拖到上面任意一档完成归档'} · 当前效率=${curEff}">${effEsc(m.name)}<span class="eff-val">${curEff}</span></span>`;
  }).join('');
  html+=`<div class="eff-unassigned" data-droptier="-1"><span class="ua-lab">⚠ 未分档（按 1.0 计）</span>${uaChips||'<span style="font-size:11px;color:#b36b00">（无）</span>'}</div>`;
  box.innerHTML=html;
}
// 编辑后统一收尾：回写 eff → 持久化 → 广播 → 重渲甘特 → 重渲本表
function effApplyChange(reRenderTable){
  syncEffFromTiers();
  save();broadcast();rerender();
  if(reRenderTable!==false) renderEffTable();
}
// 事件委托（绑定一次）
function bindEffTable(){
  const box=document.getElementById('effTiers');
  const addBtn=document.getElementById('effAddTier');
  const lockBtn=document.getElementById('effLock');
  // 锁定/激活编辑切换
  if(lockBtn&&!lockBtn._bound){lockBtn._bound=1;lockBtn.addEventListener('click',()=>{
    if(effLockedView() && !requireWrite())return;   // 只读模式：不允许解锁系数表
    effLocked=!effLocked; applyEffLockUI(); save();broadcast();
    toast(effLocked?'已锁定：系数标定不可编辑':'已激活：可拖拽归档 / 改系数');
  });}
  if(addBtn&&!addBtn._bound){addBtn._bound=1;addBtn.addEventListener('click',()=>{
    if(effLockedView())return;
    pushHistory();
    EFF_TIERS.push({coef:1.0,label:'自定义档位',mems:[]});
    renderEffTable();
  });}
  if(!box||box._bound)return; box._bound=1;
  // 改系数 / 改说明
  box.addEventListener('change',e=>{
    if(effLockedView())return;
    const el=e.target, act=el.getAttribute&&el.getAttribute('data-act'); if(!act)return;
    const ti=+el.getAttribute('data-ti');
    if(act==='coef'){
      let v=parseFloat(el.value); if(!isFinite(v)||v<0)v=1.0; v=Math.round(v*100)/100;
      pushHistory(); EFF_TIERS[ti].coef=v; el.value=v; effApplyChange(false);
      toast('系数已更新，计算已重算');
    }else if(act==='label'){
      pushHistory(); EFF_TIERS[ti].label=el.value; save();broadcast();
    }
  });
  // 移出成员 / 删除档位
  box.addEventListener('click',e=>{
    if(effLockedView())return;
    const el=e.target, act=el.getAttribute&&el.getAttribute('data-act'); if(!act)return;
    if(act==='rmMem'){
      const ti=+el.getAttribute('data-ti'), id=el.getAttribute('data-id');
      pushHistory(); EFF_TIERS[ti].mems=(EFF_TIERS[ti].mems||[]).filter(x=>x!==id);
      effApplyChange(); toast(`${memNm(id)} 已移出（未分档按 1.0 计）`);
    }else if(act==='delTier'){
      const ti=+el.getAttribute('data-ti');
      if(EFF_TIERS.length<=1){toast('至少保留一档');return;}
      const moved=(EFF_TIERS[ti].mems||[]).length;
      pushHistory(); EFF_TIERS.splice(ti,1);
      effApplyChange(); toast(moved?`已删档，${moved}人转为未分档(按1.0计)`:'已删除该档');
    }
  });
  // —— 指针拖拽：把成员 chip 拖到任意档行 / 未分档区即可移动（含移出）——
  const ghost=document.getElementById('effGhost');
  let ed=null; // {id,srcTi,chip,started}
  function rowAt(x,y){
    const el=document.elementFromPoint(x,y);
    return el&&el.closest?el.closest('[data-droptier]'):null;
  }
  function clearDrop(){document.querySelectorAll('.drop-on').forEach(r=>r.classList.remove('drop-on'));}
  box.addEventListener('pointerdown',e=>{
    if(effLockedView())return;
    if(e.target.closest&&e.target.closest('.x'))return; // 点×号是移出，不触发拖拽
    const chip=e.target.closest&&e.target.closest('.eff-chip'); if(!chip)return;
    ed={id:chip.getAttribute('data-id'),srcTi:+chip.getAttribute('data-ti'),chip,started:false,sx:e.clientX,sy:e.clientY};
    try{chip.setPointerCapture(e.pointerId);}catch(_){}
    e.preventDefault();
  });
  box.addEventListener('pointermove',e=>{
    if(!ed)return;
    if(!ed.started){
      if(Math.abs(e.clientX-ed.sx)<4&&Math.abs(e.clientY-ed.sy)<4)return;
      ed.started=true; ed.chip.classList.add('drag-src');
      ghost.textContent=memNm(ed.id); ghost.classList.add('show');
    }
    ghost.style.left=e.clientX+'px'; ghost.style.top=e.clientY+'px';
    const row=rowAt(e.clientX,e.clientY);
    clearDrop();
    if(row && +row.getAttribute('data-droptier')!==ed.srcTi) row.classList.add('drop-on');
  });
  function endDrag(e){
    if(!ed)return;
    const wasStarted=ed.started, id=ed.id, srcTi=ed.srcTi, chip=ed.chip;
    try{chip.releasePointerCapture(e.pointerId);}catch(_){}
    ghost.classList.remove('show'); chip.classList.remove('drag-src');
    const cur=ed; ed=null;
    if(!wasStarted){clearDrop();return;} // 没真正拖动=当点击处理
    const row=rowAt(e.clientX,e.clientY); clearDrop();
    if(!row){return;}
    const ti=+row.getAttribute('data-droptier');
    if(ti===srcTi){return;} // 落回原处不动
    pushHistory();
    if(ti<0){ // 拖到未分档区 = 移出
      EFF_TIERS.forEach(t=>{t.mems=(t.mems||[]).filter(x=>x!==id);});
      effApplyChange(); toast(`${memNm(id)} 已移出（未分档按 1.0 计）`);
    }else{
      effMoveMemToTier(id, ti);
      effApplyChange(); toast(`${memNm(id)} 已移入 ${EFF_TIERS[ti].coef} 档`);
    }
  }
  box.addEventListener('pointerup',endDrag);
  box.addEventListener('pointercancel',e=>{if(ed){ghost.classList.remove('show');ed.chip.classList.remove('drag-src');ed=null;clearDrop();}});
  bindEffSyncBtn();
}
// 锁定态 UI：切按钮样式、显隐加档钮、给档位容器加 .locked、重渲（让输入框只读态生效）
/* 只读模式(未持有编辑锁)时，三张配置表一律强制按「已锁定」呈现，
   且不污染真正持久化的 effLocked/invLocked/stdLocked（协作时各端独立） */
function roLocked(){ return (typeof canWrite==='function') ? !canWrite() : false; }
function effLockedView(){ return effLocked || roLocked(); }
function invLockedView(){ return invLocked || roLocked(); }
function stdLockedView(){ return stdLocked || roLocked(); }
function applyEffLockUI(){
  const lockBtn=document.getElementById('effLock');
  const addBtn=document.getElementById('effAddTier');
  const box=document.getElementById('effTiers');
  const L=effLockedView();
  if(lockBtn){
    lockBtn.className='eff-lock '+(L?'locked':'editing');
    lockBtn.textContent=L?'🔒 已锁定':'✏ 编辑中';
  }
  if(addBtn) addBtn.classList.toggle('hide', L);
  if(box) box.classList.toggle('locked', L);
  renderEffTable();
}
/* 同步：将系数标定（锚点）的各档系数下发至甘特图成员 m.eff */
function syncEffToMembers(){
  if(!requireWrite())return;
  pushHistory();
  let updated=0;
  const byMem={};
  EFF_TIERS.forEach(t=>{const c=Number(t.coef);if(!isFinite(c))return;(t.mems||[]).forEach(id=>{byMem[id]=c;});});
  members.forEach(m=>{
    if(byMem[m.id]!=null && m.eff!==byMem[m.id]){
      m.eff=byMem[m.id];
      updated++;
    }
  });
  save();broadcast();rerender();
  renderEffTable();
  toast(`已同步：${updated}名成员的效率系数已按标定档位更新`);
}
/* 绑定同步按钮 */
function bindEffSyncBtn(){
  const btn=document.getElementById('effSyncBtn');
  if(!btn||btn._bound)return; btn._bound=1;
  btn.addEventListener('click',syncEffToMembers);
}

/* ============ 投入比 / 精力分配表：渲染 + 编辑交互（数据驱动 + 锁定） ============ */
function renderInvTable(){
  const box=document.getElementById('invTable'); if(!box)return;
  const IL=invLockedView();
  const ro=IL?' readonly':'', rod=IL?' disabled':'';
  let html='<thead><tr><th style="width:150px">类型</th><th style="width:96px;text-align:center">投入比区间</th><th>行为 / 计算规则</th><th style="width:150px">典型场景</th><th style="width:28px"></th></tr></thead><tbody>';
  INV_TIERS.forEach((t,i)=>{
    const hi=(t.hi!=null?t.hi:t.val), lo=(t.lo!=null?t.lo:(hi>=1?0:hi));
    const rangeTxt = hi>=1 ? `0–${hi}` : `${lo}–${hi}`;
    // 锁定态：显示区间徽标；编辑态：下限/上限两个输入框
    const valCell = IL
      ? `<b style="background:${effEsc(t.vbg)};color:${effEsc(t.vfg)};display:inline-block;min-width:52px;padding:2px 8px;border-radius:6px;font-variant-numeric:tabular-nums">${rangeTxt}</b>`
      : `<span style="display:inline-flex;align-items:center;gap:3px;justify-content:center"><input class="iv-lo" type="number" step="0.05" min="0" max="1" value="${lo}" data-act="lo" data-i="${i}" title="并行分摊下限" style="width:44px;background:${effEsc(t.vbg)};color:${effEsc(t.vfg)}"><span style="color:var(--tx3)">–</span><input class="iv-val" type="number" step="0.05" min="0" max="1" value="${hi}" data-act="val" data-i="${i}" title="独占上限 (=1 视为全人力可 1/N 平摊)" style="width:44px;background:${effEsc(t.vbg)};color:${effEsc(t.vfg)}"></span>`;
    html+=`<tr data-i="${i}">
      <td class="it-type"><button class="it-dot" type="button" data-act="col" data-i="${i}" style="background:${effEsc(t.col)};display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:middle" title="${IL?'类型色':'点击改类型色'}"${rod}></button><input class="iv-name" type="text" value="${effEsc(t.name)}" data-act="name" data-i="${i}" placeholder="类型名"${ro}></td>
      <td class="it-val">${valCell}</td>
      <td class="it-desc"><textarea class="iv-desc" rows="2" data-act="desc" data-i="${i}" placeholder="行为/计算规则（可含<b>等标签）"${ro}>${effEsc(t.desc)}</textarea></td>
      <td class="it-scene"><textarea class="iv-scene" rows="2" data-act="scene" data-i="${i}" placeholder="典型场景"${ro}>${effEsc(t.scene)}</textarea></td>
      <td><button class="iv-del" data-act="del" data-i="${i}" title="删除该类">×</button></td>
    </tr>`;
  });
  // 自动行：并行分摊 —— 非手动档位，说明每档如何按并行条数在区间内摊薄
  html+=`<tr class="it-fixed"><td class="it-type"><i style="background:#5f3dc4;display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:middle"></i>并行分摊<span class="it-fixrow">自动</span></td>
    <td class="it-val"><b style="background:#efeafd;color:#5f3dc4;display:inline-block;min-width:34px;padding:2px 8px;border-radius:6px">区间内</b></td>
    <td class="it-desc">某人某天同时跑多条需求（<b>含跟进</b>）时，每条投入比 = <code>上限 ÷ 当天并行条数</code>，在各自<b>区间内向下收敛</b>——<b>独占取上限，并行越多越低，触底下限即不再降</b>。任务标签直接显示<b>分摊后的实际投入比数字</b>，<u>无需手动设置</u>，随排期实时变化。</td>
    <td class="it-scene">一人同期<br>并行多条需求</td><td></td></tr>`;
  // 固定行：支援(外借) —— 不可编辑/删除，仅说明编制隶属
  html+=`<tr class="it-fixed"><td class="it-type"><i style="background:var(--amber);display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:middle"></i>支援(外借)<span class="it-fixrow">固定项</span></td>
    <td class="it-val"><b style="background:#fff1da;color:#b36b00;display:inline-block;min-width:34px;padding:2px 8px;border-radius:6px">不打折</b></td>
    <td class="it-desc">仅表<b>编制隶属</b>状态（人来自其他基地/借调），<u>不改变投入比</u>，消化量按其实际投入比（全人力或跟进）计算。</td>
    <td class="it-scene">跨基地借调<br>支援本组</td><td></td></tr>`;
  html+='</tbody>';
  box.innerHTML=html;
}
function invApplyChange(reRender){ save();broadcast();rerender(); if(reRender!==false) renderInvTable(); }
function bindInvTable(){
  const box=document.getElementById('invTable');
  const addBtn=document.getElementById('invAddTier');
  const lockBtn=document.getElementById('invLock');
  if(lockBtn&&!lockBtn._bound){lockBtn._bound=1;lockBtn.addEventListener('click',()=>{
    if(invLockedView() && !requireWrite())return;   // 只读模式：不允许解锁投入比表
    invLocked=!invLocked; applyInvLockUI(); save();broadcast();
    toast(invLocked?'已锁定：投入比表不可编辑':'已激活：可编辑投入比类型 / 比值 / 说明');
  });}
  if(addBtn&&!addBtn._bound){addBtn._bound=1;addBtn.addEventListener('click',()=>{
    if(invLockedView())return;
    pushHistory();
    INV_TIERS.push({key:'inv'+Date.now().toString(36),name:'自定义跟进',val:0.3,lo:0.1,hi:0.3,col:'#d6a000',vbg:'#fdf6e3',vfg:'#a07800',desc:'自定义投入比区间。独占取上限，并行按条数在区间内摊薄、不低于下限。',scene:''});
    save();broadcast();renderInvTable(); syncInvSelectHTML();
  });}
  if(!box||box._bound)return; box._bound=1;
  box.addEventListener('change',e=>{
    if(invLockedView())return;
    const el=e.target, act=el.getAttribute&&el.getAttribute('data-act'); if(!act)return;
    const i=+el.getAttribute('data-i'); const t=INV_TIERS[i]; if(!t)return;
    if(act==='val'){
      let v=parseFloat(el.value); if(!isFinite(v)||v<0)v=0.3; if(v>1)v=1; v=Math.round(v*100)/100;
      pushHistory(); t.val=v; t.hi=v; if(t.lo==null) t.lo=(v>=1?0:v); if(t.lo>v)t.lo=v; el.value=v; invApplyChange(false);
      toast('投入比上限已更新，消化工作量已重算'); syncInvSelectHTML(); renderInvTable();
    }else if(act==='lo'){
      let v=parseFloat(el.value); if(!isFinite(v)||v<0)v=0; const hi=(t.hi!=null?t.hi:t.val); if(v>hi)v=hi; v=Math.round(v*100)/100;
      pushHistory(); t.lo=v; el.value=v; invApplyChange(false);
      toast('并行分摊下限已更新，负载/投入比已重算');
    }else if(act==='name'){ pushHistory(); t.name=el.value; save();broadcast(); syncInvSelectHTML(); }
    else if(act==='desc'){ pushHistory(); t.desc=el.value; save();broadcast(); }
    else if(act==='scene'){ pushHistory(); t.scene=el.value; save();broadcast(); }
  });
  box.addEventListener('click',e=>{
    if(invLockedView())return;
    const el=e.target, act=el.getAttribute&&el.getAttribute('data-act'); if(!act)return;
    const i=+el.getAttribute('data-i'); const t=INV_TIERS[i]; if(!t)return;
    if(act==='del'){
      if(INV_TIERS.length<=1){toast('至少保留一类');return;}
      pushHistory(); INV_TIERS.splice(i,1);
      save();broadcast();renderInvTable(); syncInvSelectHTML(); toast('已删除该投入比类型');
    }else if(act==='col'){
      const cur=t.col||'#0a7d3c';
      const inp=document.createElement('input'); inp.type='color'; inp.value=/^#([0-9a-f]{6})$/i.test(cur)?cur:'#0a7d3c';
      inp.style.position='fixed'; inp.style.left='-9999px'; document.body.appendChild(inp);
      inp.addEventListener('input',()=>{ t.col=inp.value; el.style.background=inp.value; });
      inp.addEventListener('change',()=>{ pushHistory(); t.col=inp.value; save();broadcast();renderInvTable(); inp.remove(); });
      inp.click();
    }
  });
}
function applyInvLockUI(){
  const lockBtn=document.getElementById('invLock');
  const addBtn=document.getElementById('invAddTier');
  const box=document.getElementById('invTable');
  const L=invLockedView();
  if(lockBtn){
    lockBtn.className='eff-lock '+(L?'locked':'editing');
    lockBtn.textContent=L?'🔒 已锁定':'✏ 编辑中';
  }
  if(addBtn) addBtn.classList.toggle('hide', L);
  if(box) box.classList.toggle('locked', L);
  renderInvTable();
}

/* ============ 标准工期 & 标配人力表：渲染 + 编辑交互 ============ */
function renderStdTable(){
  const box=document.getElementById('stdRows'); if(!box)return;
  const SL=stdLockedView();
  let html='<div class="std-head"><span>品级（含模块色）</span><span>模块类型</span><span>展示时长</span><span>制作工期</span><span>标配人力</span><span></span></div>';
  STD_CFG.forEach((t,i)=>{
    html+=`<div class="std-row" data-i="${i}">
      <span class="sd-grade"><i class="sd-gdot" style="background:${effEsc(t.col)}"></i><select class="sd-gsel" data-act="grade" data-i="${i}" title="${SL?'品级（颜色随品级自动套用）':'选择品级，颜色自动套用'}"${SL?' disabled':''}>${gradeOptsHTML(t.grade)}</select></span>
      <input class="sd-mod" type="text" value="${effEsc(t.mod||'')}" data-act="mod" data-i="${i}" placeholder="如 出场/检视" ${SL?' readonly':''}>
      <input class="sd-dur" type="text" value="${effEsc(t.dur||'')}" data-act="dur" data-i="${i}" placeholder="如 15 秒" title="效果在游戏内的展示时间长度"${SL?' readonly':''}>
      <input class="sd-weeks" type="text" value="${effEsc(t.weeks)}" data-act="weeks" data-i="${i}" placeholder="如 8 周" title="制作工期"${SL?' readonly':''}>
      <input class="sd-ppl" type="text" value="${effEsc(t.ppl)}" data-act="ppl" data-i="${i}" placeholder="标配人力说明"${SL?' readonly':''}>
      <button class="std-del" data-act="delRow" data-i="${i}" title="删除该行">×</button>
    </div>`;
  });
  box.innerHTML=html;
}
function bindStdTable(){
  const box=document.getElementById('stdRows');
  const addBtn=document.getElementById('stdAddRow');
  const lockBtn=document.getElementById('stdLock');
  if(lockBtn&&!lockBtn._bound){lockBtn._bound=1;lockBtn.addEventListener('click',()=>{
    if(stdLockedView() && !requireWrite())return;   // 只读模式：不允许解锁标准工期表
    stdLocked=!stdLocked; applyStdLockUI(); save();broadcast();
    toast(stdLocked?'已锁定：标准工期表不可编辑':'已激活：可编辑品级 / 工期 / 标配人力');
  });}
  if(addBtn&&!addBtn._bound){addBtn._bound=1;addBtn.addEventListener('click',()=>{
    if(stdLockedView())return;
    pushHistory();
    STD_CFG.push({grade:GRADE_DEFS[0].name,col:GRADE_DEFS[0].col,mod:'新模块',dur:'',weeks:'',ppl:''});
    save();broadcast();renderStdTable();
  });}
  if(!box||box._bound)return; box._bound=1;
  // 改文本（input 实时同步、change 落定一次历史）
  const onEdit=e=>{
    if(stdLockedView())return;
    const el=e.target, act=el.getAttribute&&el.getAttribute('data-act'); if(!act||act==='delRow'||act==='colpick')return;
    const i=+el.getAttribute('data-i'); if(!STD_CFG[i])return;
    if(e.type==='change') pushHistory();
    STD_CFG[i][act]=el.value;
    if(act==='grade'){ const d=gradeDef(el.value); if(d) STD_CFG[i].col=d.col; renderStdTable(); }  // 品级⇆颜色绑定：选品级即自动套色
    save();broadcast();
  };
  box.addEventListener('change',onEdit);
  box.addEventListener('input',onEdit);
  // 删除行
  box.addEventListener('click',e=>{
    if(stdLockedView())return;
    const el=e.target, act=el.getAttribute&&el.getAttribute('data-act'); if(act!=='delRow')return;
    if(STD_CFG.length<=1){toast('至少保留一行');return;}
    const i=+el.getAttribute('data-i');
    pushHistory(); STD_CFG.splice(i,1);
    save();broadcast();renderStdTable(); toast('已删除该行');
  });
}
function applyStdLockUI(){
  const lockBtn=document.getElementById('stdLock');
  const addBtn=document.getElementById('stdAddRow');
  const box=document.getElementById('stdRows');
  const L=stdLockedView();
  if(lockBtn){
    lockBtn.className='eff-lock '+(L?'locked':'editing');
    lockBtn.textContent=L?'🔒 已锁定':'✏ 编辑中';
  }
  if(addBtn) addBtn.classList.toggle('hide', L);
  if(box) box.classList.toggle('locked', L);
  renderStdTable();
}

function rerender(){
  // 安全清理：每次重渲染时强制隐藏所有拖拽残留（drop-guide、dragging 状态等）
  ['dropG0','dropG1','dropBand'].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.remove('show');});
  document.querySelectorAll('.dragging,.dup-src,.row-target').forEach(el=>el.classList.remove('dragging','dup-src','row-target'));
  _resetPeakParCache();                 // 排期可能变更→清空并行峰值缓存，确保人级并行判定实时
  document.body.classList.toggle('hr-view',view==='hr');  // 人力视图隐藏左列拖拽手柄
  if(typeof buildMeSel==='function') buildMeSel();        // 刷新「我是谁」下拉（成员/角色可能已变）
  if(view==='hr'){renderHR();return;}
  view==='person'?renderPerson():renderReq();
  if(typeof resyncCommentPin==='function') resyncCommentPin();
}
function setView(v,btn){view=v;document.getElementById('viewTabs').querySelectorAll('button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');updateLegend();updateHint();updateGroupSelUI();syncHideDoneCheckbox();syncSideNavViewLabel();rerender();}
/* v6.68：侧边导航「视图区」那一项跟随当前视图改名，让用户一眼确认目录指向的就是眼前这个视图。 */
function syncSideNavViewLabel(){
  const el=document.getElementById('snGanttLabel'); if(!el) return;
  const map={person:'按人看', req:'按需求看', hr:'人力分配'};
  el.textContent = map[view] || '甘特图';
  const a=el.closest('.sn-item');
  if(a) a.title = '甘特图主区 · 当前：' + (map[view]||'甘特图');
}
function updateHint(){
  const h=document.getElementById('hintBar'); if(!h)return;
  if(view==='req'){
    h.innerHTML='💡 左侧竖带=角色品级色：<b style="color:#e0a400">金</b> / <b style="color:#f59e0b">橙</b> / <b style="color:#ef3b39">红</b>，同品级相邻行连成整条 · 人名标签：<b style="color:#fff;background:#0052d9;padding:0 6px;border-radius:8px">👑正编</b> 实心蓝 / <span style="color:#56607a;background:#eef1f7;border:1px solid #c4ccdb;padding:0 6px;border-radius:8px">基地</span> 淡白 · <b style="color:#f08c00">橙环+支</b>=跨队支援 · 拖动标签改派';
  }else if(view==='person'){
    h.innerHTML='💡 拖中间=改期，上下拖到别人行=改派 · 拖两端=改工期 · 单击任务条=改状态/删除 · 拖行首 ⋮⋮=自定义排序 · 复制任务条(Ctrl+C)后，点人员信息栏选中行再 Ctrl+V，即把该任务改派给选中的人';
  }else{
    h.innerHTML='💡 人力分配视图：按模块汇总在岗人员与管线缺口';
  }
}
function setColor(c,btn){colorMode=c;document.getElementById('colorTabs').querySelectorAll('button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');updateLegend();rerender();}
/* 任务条色彩浓度滑块：百分比=浓度（与截图一致：左端0%最淡泛白 → 右端100%原色最浓）。
   内部用 --wash 表示“淡化量”=(100-浓度)/100：浓度越低越泛白。设置记本机。 */
const VIVID_KEY='gantt_vivid';
function setVivid(v,sync){
  v=Math.max(0,Math.min(100,Math.round(+v/5)*5));
  const wash=((100-v)/100).toFixed(2);
  document.documentElement.style.setProperty('--wash',wash);
  const val=document.getElementById('vividVal'); if(val)val.textContent=v+'%';
  const rng=document.getElementById('vividRange'); if(rng&&(sync||+rng.value!==v))rng.value=v;
  try{localStorage.setItem(VIVID_KEY,v);}catch(_){}
}
function initVivid(){
  let v=100; try{const s=localStorage.getItem(VIVID_KEY); if(s!==null&&s!=='')v=+s;}catch(_){}
  setVivid(v,true);
}
/* ===== 调试：条内栅格间距 ===== */
const GRIDGAP_KEY='gantt_gridgap';
function setGridGap(v){
  /* v=0 表示自动（跟随 --day-w 即每天一格）；否则为固定像素间距 */
  v=Math.max(0,Math.min(48,Math.round(+v)));
  const val=document.getElementById('gridGapVal');
  if(val)val.textContent=v===0?'自动':v+'px';
  const rng=document.getElementById('gridGapRange'); if(rng)rng.value=v;
  if(v===0){
    document.documentElement.style.removeProperty('--grid-gap');
  }else{
    document.documentElement.style.setProperty('--grid-gap',v+'px');
  }
  try{localStorage.setItem(GRIDGAP_KEY,v);}catch(_){}
}
function initGridGap(){
  let v=0; try{const s=localStorage.getItem(GRIDGAP_KEY); if(s!==null&&s!=='')v=+s;}catch(_){}
  setGridGap(v);
}
/* ===== 调试：假日阴影浓度 ===== */
const HOLOPAC_KEY='gantt_holopac';
function setHolOpacity(v){
  /* v 为百分比，100=默认原样，0=完全透明，200=两倍加深 */
  v=Math.max(0,Math.min(200,Math.round(+v/5)*5));
  document.documentElement.style.setProperty('--hol-opacity',(v/100).toFixed(2));
  const val=document.getElementById('holOpacVal'); if(val)val.textContent=v+'%';
  const rng=document.getElementById('holOpacRange'); if(rng)rng.value=v;
  try{localStorage.setItem(HOLOPAC_KEY,v);}catch(_){}
}
function initHolOpacity(){
  let v=100; try{const s=localStorage.getItem(HOLOPAC_KEY); if(s!==null&&s!=='')v=+s;}catch(_){}
  setHolOpacity(v);
}
/* ===== 关键节点竖虚线不透明度（配色面板内嵌滑块） ===== */
const MS_LINK_OPAC_KEY='gantt_ms_link_opac';
function setMsLinkOpac(v){
  v=Math.max(20,Math.min(200,Math.round(+v)));
  document.documentElement.style.setProperty('--ms-link-opacity',(v/100).toFixed(2));
  /* 同步面板内的显示值（如果面板当前打开） */
  const val=document.getElementById('msLinkOpacVal'); if(val)val.textContent=v+'%';
  const rng=document.getElementById('msLinkOpacRange'); if(rng)rng.value=v;
  try{localStorage.setItem(MS_LINK_OPAC_KEY,v);}catch(_){}
}
function initMsLinkOpac(){
  let v=100; try{const s=localStorage.getItem(MS_LINK_OPAC_KEY); if(s!==null&&s!=='')v=+s;}catch(_){}
  setMsLinkOpac(v);
}
/* 条宽 / 时间轴密度：滑块缩放 DAY_W（100%~320%），觉得任务条太细可调宽，设置记本机 */
const ZOOM_KEY='gantt_zoom';
function setZoom(v,sync){
  v=Math.max(100,Math.min(320,Math.round(+v/10)*10));
  /* v7.12 缩放锚定：记住缩放前视野里的一个「基准天」，缩放后把它放回原来的屏上位置。
     否则 scrollLeft 是像素值、DAY_W 一变含义就变，视野会莫名跳到几个月之外，
     用户拖一下条宽滑块就得重新找今天在哪。
     锚点优先级：① 今天红线若在可视区内 → 以红线为锚（缩放时今天钉在原处不动，最符合直觉）；
                 ② 否则以可视区中心那天为锚。
     坐标关系：内容坐标 x = 天索引 × DAY_W；左侧 --left-w 是 sticky 冻结名栏，
     故时间轴可视宽 = clientWidth − left-w，屏上偏移 = x − scrollLeft。 */
  const sc=document.getElementById('scroll');
  let anchorDay=null, anchorOff=0;
  if(sc && DAY_W>0){
    const lw=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))||340;
    const viewW=Math.max(120,sc.clientWidth-lw);
    const tl=document.querySelector('.todayline');
    const tx=tl?parseFloat(tl.style.left):NaN;
    const todayOff=tx-sc.scrollLeft;                    // 红线相对时间轴可视区左缘的屏上偏移
    if(isFinite(todayOff) && todayOff>=0 && todayOff<=viewW){
      anchorDay=tx/DAY_W; anchorOff=todayOff;           // ① 钉住今天
    }else{
      anchorOff=viewW/2; anchorDay=(sc.scrollLeft+anchorOff)/DAY_W;   // ② 钉住视野中心
    }
  }
  DAY_W=+(DAY_W_BASE*v/100).toFixed(2);
  document.documentElement.style.setProperty('--day-w',DAY_W+'px');  // v5.5 进度格线按天：同步每天像素宽
  const val=document.getElementById('zoomVal'); if(val)val.textContent=v+'%';
  const rng=document.getElementById('zoomRange'); if(rng&&(sync||+rng.value!==v))rng.value=v;
  try{localStorage.setItem(ZOOM_KEY,v);}catch(_){}
  if(typeof rerender==='function') rerender();
  if(sc && anchorDay!==null){
    const max=Math.max(0,sc.scrollWidth-sc.clientWidth);
    sc.scrollLeft=Math.max(0,Math.min(max,anchorDay*DAY_W-anchorOff));
    if(typeof syncTodayLabel==='function') syncTodayLabel();
  }
}
function initZoom(){
  let v=100; try{const s=localStorage.getItem(ZOOM_KEY); if(s)v=+s;}catch(_){}
  v=Math.max(100,Math.min(320,Math.round(+v/10)*10));
  DAY_W=+(DAY_W_BASE*v/100).toFixed(2);
  document.documentElement.style.setProperty('--day-w',DAY_W+'px');  // v5.5 进度格线按天：初始化每天像素宽
  const val=document.getElementById('zoomVal'); if(val)val.textContent=v+'%';
  const rng=document.getElementById('zoomRange'); if(rng)rng.value=v;
}

/* ===== 左侧信息栏宽度：可拖拽手柄(手动) + 双击自动适配内容(自动) ===== */
const LEFTW_KEY='gantt_leftw';
const LEFTW_MIN=240, LEFTW_MAX=620, LEFTW_DEF=340;
function setLeftW(px,save){
  const prev=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))||LEFTW_DEF;
  px=Math.max(LEFTW_MIN,Math.min(LEFTW_MAX,Math.round(px)));
  document.documentElement.style.setProperty('--left-w',px+'px');
  /* v7.12 两件事：
     ① 栏宽变了 → .tr-track 的 left/宽度随之变化，胶囊可视坐标必须重算，否则会与红线错位。
     ② 栏宽变宽 = 时间轴可视窗口变窄，原本靠左的红线会被挤到冻结名栏后面（实测「适配栏宽」
        340→619 后今天直接不可见，胶囊只能贴边）。故同步补偿 scrollLeft，让时间轴内容
        跟着左移相同像素，红线在屏上位置保持不动。 */
  const sc=document.getElementById('scroll');
  if(sc && px!==prev){
    const max=Math.max(0,sc.scrollWidth-sc.clientWidth);
    sc.scrollLeft=Math.max(0,Math.min(max,sc.scrollLeft+(px-prev)));
  }
  if(typeof syncTodayLabel==='function') syncTodayLabel();
  if(save!==false){ try{localStorage.setItem(LEFTW_KEY,px);}catch(_){} }
  return px;
}
function initLeftW(){
  let px=LEFTW_DEF; try{const s=localStorage.getItem(LEFTW_KEY); if(s)px=+s;}catch(_){}
  setLeftW(px,false);
  const grip=document.getElementById('lwGrip'); if(!grip)return;
  // 手动拖拽
  let startX=0,startW=0,dragging=false;
  const onMove=e=>{ if(!dragging)return; const dx=(e.touches?e.touches[0].clientX:e.clientX)-startX; setLeftW(startW+dx); };
  const onUp=()=>{ if(!dragging)return; dragging=false; grip.classList.remove('drag'); document.body.classList.remove('lw-resizing'); document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); document.removeEventListener('touchmove',onMove); document.removeEventListener('touchend',onUp); };
  const onDown=e=>{ dragging=true; startX=(e.touches?e.touches[0].clientX:e.clientX); startW=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w'))||LEFTW_DEF; grip.classList.add('drag'); document.body.classList.add('lw-resizing'); document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp); document.addEventListener('touchmove',onMove,{passive:false}); document.addEventListener('touchend',onUp); e.preventDefault(); };
  grip.addEventListener('mousedown',onDown);
  grip.addEventListener('touchstart',onDown,{passive:false});
  // 双击=自动适配内容最宽行
  grip.addEventListener('dblclick',()=>{ autoFitLeftW(); });
}
/* 自动适配：临时解除换行约束，量取所有信息栏的最大自然宽度，取其作为新栏宽 */
function autoFitLeftW(){
  const grid=document.getElementById('grid'); if(!grid)return;
  document.body.classList.add('lw-measure');
  let maxW=0;
  grid.querySelectorAll('.row:not(.head) .cell-left').forEach(el=>{ const w=el.scrollWidth; if(w>maxW)maxW=w; });
  document.body.classList.remove('lw-measure');
  if(maxW>0){ const px=setLeftW(maxW+6); toast('信息栏已自动适配至 '+px+'px'); }
}
function updateLegend(){
  const el=document.getElementById('legend');
  if(colorMode==='status'){
    el.innerHTML=STATUS_ORDER.map(k=>`<span class="dot"><i style="background:${STATUS[k].col}"></i>${STATUS[k].label}</span>`).join('');
  }else{
    el.innerHTML=`<span class="dot"><i style="background:#1fae5a"></i>低风险</span><span class="dot"><i style="background:#e08c00"></i>中风险</span><span class="dot"><i style="background:#f5413f"></i>高风险</span>`;
  }
}

/* ===== v7.24 条内标签全局显隐开关：占·投入比(.rt-inv) / ≈周·消化工时(.rt-md) =====
   纯观看开关：body 类 + CSS 隐藏，不触碰渲染逻辑；本机 localStorage 记忆。
   fitBarLabels 每轮复位 inline display='' 清除的是内联样式，body 类规则依然生效，两者不冲突。 */
let LBL_SHOW={inv:true,md:true,eff:true};
try{const _lv=JSON.parse(localStorage.getItem('gantt_lbl_show')||'null'); if(_lv){LBL_SHOW.inv=_lv.inv!==false; LBL_SHOW.md=_lv.md!==false; LBL_SHOW.eff=_lv.eff!==false;}}catch(_){}
function applyLblShow(){
  document.body.classList.toggle('lbl-hide-inv',!LBL_SHOW.inv);
  document.body.classList.toggle('lbl-hide-md',!LBL_SHOW.md);
  document.body.classList.toggle('lbl-hide-eff',!LBL_SHOW.eff);
  const _a=document.getElementById('lblInvOn'),_b=document.getElementById('lblMdOn');
  if(_a)_a.checked=LBL_SHOW.inv; if(_b)_b.checked=LBL_SHOW.md;
  const _c=document.getElementById('lblEffOn'); if(_c)_c.checked=LBL_SHOW.eff;
}
function changeLblShow(k,on){
  LBL_SHOW[k]=!!on;
  try{localStorage.setItem('gantt_lbl_show',JSON.stringify(LBL_SHOW));}catch(_){}
  applyLblShow();
  requestAnimationFrame(fitBarLabels);   // 标签占位变化→重测条内降级布局
}

/* v7.47：原 v7.46 的「汇总行底色」偏好已并入统一色板 MS_PALETTE.msBg（gantt_ms_palette），
   此处保留向后兼容：老用户 localStorage 里的 gantt_ms_bg 会在启动时迁移进色板，随后删除旧 key。 */
function _migrateMsBg(){
  try{
    const old=localStorage.getItem('gantt_ms_bg');
    if(old && /^#[0-9a-f]{6}$/i.test(old)){
      if(!localStorage.getItem(MS_PAL_KEY)){ MS_PALETTE.msBg=old; try{localStorage.setItem(MS_PAL_KEY,JSON.stringify(MS_PALETTE));}catch(_){} }
      localStorage.removeItem('gantt_ms_bg');
    }
  }catch(_){}
}

/* ===== v7.30 配色色盘：本机自助改 联调(待启动/进行中) 与 超期 颜色 =====
   纯本地 localStorage 偏好（gantt_user_colors）：不进云端快照、不改任何数据、不影响他人视图；
   色值以 CSS 变量(--c-lt0/--c-lt/--c-ovr…) 注入 documentElement，CSS 用 var() 取色；
   子色(文字/圆点/渐变末端/边框)由主色自动派生，保证任意主色下对比度与层次自洽。 */
let USER_COLORS={lt0:'#c8b6ec',lt:'#0e9aa7',ovr:'#bd5eb0'};
try{const _c=JSON.parse(localStorage.getItem('gantt_user_colors')||'null'); if(_c&&typeof _c==='object')USER_COLORS={lt0:_c.lt0||'#c8b6ec',lt:_c.lt||'#0e9aa7',ovr:_c.ovr||'#bd5eb0'};}catch(_){}
function _hc(h){h=(h||'').replace('#','');if(h.length===3)h=h.split('').map(x=>x+x).join('');const n=parseInt(h,16);return [(n>>16)&255,(n>>8)&255,n&255];}
function _hr(r,g,b){const t=v=>('0'+Math.max(0,Math.min(255,Math.round(v))).toString(16)).slice(-2);return '#'+t(r)+t(g)+t(b);}
function _rh(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h=0,s=0,l=(mx+mn)/2;if(mx!==mn){const d=mx-mn;s=l>0.5?d/(2-mx-mn):d/(mx+mn);if(mx===r)h=(g-b)/d+(g<b?6:0);else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h/=6;}return [h*360,s,l];}
function _hrgb(h,s,l){h/=360;s=Math.max(0,Math.min(1,s));l=Math.max(0,Math.min(1,l));const f=n=>{const k=(n+h*12)%12,a=s*Math.min(l,1-l);return l-a*Math.max(-1,Math.min(k-3,9-k,1));};return [f(0)*255,f(8)*255,f(4)*255];}
function _shade(hex,targetL){const _c=_hc(hex);const _h=_rh(_c[0],_c[1],_c[2]);const _o=_hrgb(_h[0],Math.min(1,(_h[1]||0)+0.05),Math.max(0,Math.min(1,targetL)));return _hr(_o[0],_o[1],_o[2]);}
function _deriveLt(base){const _c=_hc(base);const _h=_rh(_c[0],_c[1],_c[2]);const tx=_shade(base,Math.max(0.16,Math.min(0.30,_h[2]*0.30)));const sdot=_shade(base,Math.max(0.45,Math.min(0.82,_h[2]*0.74)));return {tx,sdot};}
function _deriveOvr(base){const _c=_hc(base);const _h=_rh(_c[0],_c[1],_c[2]);const ovr2=_shade(base,Math.max(0.30,Math.min(0.55,_h[2]*0.82)));const brd=_shade(base,Math.max(0.20,Math.min(0.45,_h[2]*0.60)));return {ovr2,brd};}
function applyUserColors(){
  const st=document.documentElement.style,d=USER_COLORS;
  const lt=_deriveLt(d.lt0);st.setProperty('--c-lt0',d.lt0);st.setProperty('--c-lt0-tx',lt.tx);st.setProperty('--c-lt0-sdot',lt.sdot);
  st.setProperty('--c-lt',d.lt);
  const ov=_deriveOvr(d.ovr);st.setProperty('--c-ovr',d.ovr);st.setProperty('--c-ovr2',ov.ovr2);st.setProperty('--c-ovr-brd',ov.brd);
  const a=document.getElementById('cpLt0'),b=document.getElementById('cpLt'),c=document.getElementById('cpOvr');
  if(a)a.value=d.lt0; if(b)b.value=d.lt; if(c)c.value=d.ovr;
}
function saveUserColors(){try{localStorage.setItem('gantt_user_colors',JSON.stringify(USER_COLORS));}catch(_){}}
function changeColor(k,val){if(!/^#[0-9a-fA-F]{6}$/.test(val))return;USER_COLORS[k]=val;applyUserColors();saveUserColors();_pushColorHistory();_addRecentColors([val]);}
function resetUserColors(){USER_COLORS={lt0:'#c8b6ec',lt:'#0e9aa7',ovr:'#bd5eb0'};applyUserColors();saveUserColors();_pushColorHistory();toast('🎨 已恢复默认配色');}
/* v7.47：打开面板时重绘「关键节点统一色板」—— 该面板内容由 JS 生成，
   而 rerender() 会重建 #grid（不影响 #colorPop），但色值改动后需保证展示与内存一致。 */
function toggleColorPop(){
  const p=document.getElementById('colorPop'); if(!p) return;
  p.classList.toggle('show');
  if(p.classList.contains('show') && typeof renderMsPaletteUI==='function') renderMsPaletteUI();
}
/* v7.50：色板选色期间也屏蔽误关 —— 点 <input type="color"> 会拉起系统取色器，
   取色器关闭瞬间的那次 click 可能被判定为「面板外点击」而把配色面板收掉，
   导致用户每选一个颜色面板就关一次，无法连续调整多个色值。
   msPalettePicking 在 changeMsPalette() 里置位、短时延后自动解除（见该函数）。 */
let COLOR_PICKING=false;
let msPalettePicking=false;
/* 点击面板外区域关闭色盘（按钮在 #colorCtl 内，不触发关闭；吸色/取色中不误关） */
document.addEventListener('click',function(e){
  if(COLOR_PICKING||msPalettePicking)return;
  const p=document.getElementById('colorPop'); if(!p||!p.classList.contains('show'))return;
  if(!p.contains(e.target)&&!e.target.closest('#colorCtl'))p.classList.remove('show');
},true);

/* ===== v7.32 颜色吸取（吸色器）：跨浏览器取色 + 预设生成 =====
   根因：原「颜色吸取」完全依赖原生 <input type=color> 自带的吸管按钮，该按钮
   仅 Chromium 内核(Chrome/Edge)提供；Firefox/Safari/移动端无此按钮 → 吸色根本不可用。
   本版新增 startEyeDrop()：优先用原生 EyeDropper API（屏幕级吸色，Chrome/Edge），
   不支持时降级为「点击页面任意元素取其计算色」模式（全浏览器可用），
   吸色全程用 COLOR_PICKING 屏蔽面板误关。 */
function _parseRGB(str){const m=/rgba?\(([^)]+)\)/.exec(str||'');if(!m)return null;const p=m[1].split(',').map(s=>parseFloat(s));if(p.length<3)return null;if(p.length>=4&&p[3]<0.01)return null;return [p[0],p[1],p[2]];}
function _gradLastColor(str){const m=(str||'').match(/rgb\([^)]+\)|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}/g);if(!m)return null;return m[m.length-1];}
function _elemColorHex(el){
  if(!el)return null;
  let node=el;
  while(node&&node.nodeType===1&&node!==document.documentElement){
    const cs=getComputedStyle(node);
    const rgb=_parseRGB(cs.backgroundColor);
    if(rgb)return _hr(rgb[0],rgb[1],rgb[2]);
    const g=_gradLastColor(cs.backgroundImage);
    if(g){if(g[0]==='#')return g;const r2=_parseRGB(g);if(r2)return _hr(r2[0],r2[1],r2[2]);}
    node=node.parentElement;
  }
  return null;
}
async function startEyeDrop(key){
  if(typeof window.EyeDropper!=='undefined'){
    COLOR_PICKING=true;
    // v7.47：统一色板的 key（msBg/msLine/msL1/…）走 changeMsPalette，其余仍走 changeColor
    const setter=(typeof MS_PALETTE_DEF==='object' && (key in MS_PALETTE_DEF))?changeMsPalette:changeColor;
    try{const ed=new EyeDropper();const res=await ed.open();const hex=(res&&res.sRGBHex)||'';if(/^#[0-9a-fA-F]{6}$/.test(hex))setter(key,hex);}
    catch(_){/* 用户取消或未授权，静默 */}
    COLOR_PICKING=false;return;
  }
  startClickPick(key);   // 降级：点击页面元素取色（Firefox/Safari/移动端）
}
function startClickPick(key){
  COLOR_PICKING=true;
  const setter=(typeof MS_PALETTE_DEF==='object' && (key in MS_PALETTE_DEF))?changeMsPalette:changeColor;   // v7.47：同上分发
  document.body.classList.add('cp-picking');
  const hint=document.createElement('div');hint.id='cpPickHint';hint.textContent='🎯 点击页面任意处吸取颜色（Esc 取消）';document.body.appendChild(hint);
  function cleanup(){COLOR_PICKING=false;document.body.classList.remove('cp-picking');if(hint.parentNode)hint.parentNode.removeChild(hint);document.removeEventListener('mousedown',onPick,true);document.removeEventListener('keydown',onKey,true);}
  function onKey(e){if(e.key==='Escape')cleanup();}
  function onPick(e){
    e.preventDefault();e.stopPropagation();   // 阻断面板误关
    const el=document.elementFromPoint(e.clientX,e.clientY);
    const hex=_elemColorHex(el);
    if(hex)setter(key,hex);else toast('未能读取该处颜色');
    cleanup();
  }
  document.addEventListener('mousedown',onPick,true);
  document.addEventListener('keydown',onKey,true);
}

/* ===== 预设（协调三色组，全局 CSS 变量驱动 → 所有视图/成员通用） =====
   内置预设 COLOR_PRESETS（不可删）；自定义预设 CUSTOM_PRESETS（用户增删，localStorage 持久化）
   renderPresetList() 渲染两类预设到 #cpPresetList   */
const COLOR_PRESETS=[
  {name:'默认·紫青', c:{lt0:'#c8b6ec',lt:'#0e9aa7',ovr:'#bd5eb0'},builtin:true},
  {name:'莫兰迪',    c:{lt0:'#d8c3c0',lt:'#9aa7b0',ovr:'#b07a86'},builtin:true},
  {name:'森系绿',    c:{lt0:'#cfe3cf',lt:'#4a9d7f',ovr:'#c98a3a'},builtin:true},
  {name:'暖阳橙',    c:{lt0:'#f0d9b5',lt:'#e08a3c',ovr:'#b5423f'},builtin:true},
  {name:'深海蓝',    c:{lt0:'#bcd0e8',lt:'#2f6fb0',ovr:'#7a3fa0'},builtin:true},
  {name:'樱粉',      c:{lt0:'#f3c6d6',lt:'#e06a9c',ovr:'#9b5cc4'},builtin:true},
];
let CUSTOM_PRESETS=[];
try{const _cp=JSON.parse(localStorage.getItem('gantt_custom_presets')||'null');if(Array.isArray(_cp))CUSTOM_PRESETS=_cp;}catch(_){}
function _saveCustomPresets(){try{localStorage.setItem('gantt_custom_presets',JSON.stringify(CUSTOM_PRESETS));}catch(e){}}
function applyPreset(c){USER_COLORS={lt0:c.lt0,lt:c.lt,ovr:c.ovr};applyUserColors();saveUserColors();_pushColorHistory();_addRecentColors([c.lt0,c.lt,c.ovr]);}
function generatePreset(){
  const h=Math.floor(Math.random()*360);
  const h2=(h+Math.floor(Math.random()*120+120))%360;
  const c={
    lt0:_hr(..._hrgb(h,0.28,0.82)),
    lt :_hr(..._hrgb(h,0.45,0.50)),
    ovr:_hr(..._hrgb(h2,0.55,0.58)),
  };
  applyPreset(c);toast('🎲 已生成和谐配色（'+h+'°）');return c;
}

/* ---- 最近使用颜色（最多8个，去重，localStorage 持久化） ---- */
let RECENT_COLORS=[];
try{const _rc=JSON.parse(localStorage.getItem('gantt_recent_colors')||'null');if(Array.isArray(_rc))RECENT_COLORS=_rc;}catch(_){}
function _saveRecentColors(){try{localStorage.setItem('gantt_recent_colors',JSON.stringify(RECENT_COLORS));}catch(e){}}
function _addRecentColors(colors){
  (colors||[]).forEach(c=>{if(/^#[0-9a-fA-F]{6}$/.test(c)){const i=RECENT_COLORS.indexOf(c);if(i>=0)RECENT_COLORS.splice(i,1);RECENT_COLORS.unshift(c);}});
  RECENT_COLORS=RECENT_COLORS.slice(0,8);_saveRecentColors();_renderRecentColors();
}
function _renderRecentColors(){
  const box=document.getElementById('cpRecentList');if(!box)return;
  box.innerHTML='';if(!RECENT_COLORS.length){box.style.display='none';return;}
  box.style.display='flex';
  RECENT_COLORS.forEach(hex=>{
    const s=document.createElement('span');s.className='cp-recent-swatch';s.title=hex;s.style.backgroundColor=hex;
    s.onclick=()=>{_pushColorHistory();/* 点击最近颜色 → 设为当前 lt（最常用操作） */USER_COLORS.lt=hex;applyUserColors();saveUserColors();_addRecentColors([hex]);toast('🎨 已应用：'+hex);};
    box.appendChild(s);
  });
}

/* ---- 撤销/重做（最多20步） ---- */
let COLOR_HISTORY=[];let COLOR_HISTORY_IDX=-1;
function _pushColorHistory(){
  const snap={...USER_COLORS};
  /* 截断：如果在中间位置做了新操作，丢弃后面的记录 */
  if(COLOR_HISTORY_IDX<COLOR_HISTORY.length-1)COLOR_HISTORY=COLOR_HISTORY.slice(0,COLOR_HISTORY_IDX+1);
  COLOR_HISTORY.push(snap);if(COLOR_HISTORY.length>20)COLOR_HISTORY.shift();
  COLOR_HISTORY_IDX=COLOR_HISTORY.length-1;
  _updateUndoRedoBtns();
}
function _undoColor(){
  if(COLOR_HISTORY_IDX<=0){toast('⏪ 已无撤销步骤');return;}
  COLOR_HISTORY_IDX--;
  const s=COLOR_HISTORY[COLOR_HISTORY_IDX];USER_COLORS={...s};applyUserColors();saveUserColors();toast('↩ 撤销');_updateUndoRedoBtns();
}
function _redoColor(){
  if(COLOR_HISTORY_IDX>=COLOR_HISTORY.length-1){toast('⏩ 已无重做步骤');return;}
  COLOR_HISTORY_IDX++;
  const s=COLOR_HISTORY[COLOR_HISTORY_IDX];USER_COLORS={...s};applyUserColors();saveUserColors();toast('↪ 重做');_updateUndoRedoBtns();
}
function _updateUndoRedoBtns(){
  const ub=document.getElementById('cpUndoBtn'),rb=document.getElementById('cpRedoBtn');
  if(ub)ub.disabled=COLOR_HISTORY_IDX<=0;if(rb)rb.disabled=COLOR_HISTORY_IDX>=COLOR_HISTORY.length-1;
}

/* ---- 自定义预设 CRUD ---- */
function _saveAsPreset(){
  const name=prompt('保存当前配色为预设（输入名称）：','我的预设 '+(CUSTOM_PRESETS.length+1));if(!name||!name.trim())return;
  const c={...USER_COLORS};
  CUSTOM_PRESETS.push({name:name.trim(),c:c,builtin:false});_saveCustomPresets();renderPresetList();toast('💾 已保存预设：'+name.trim());
}
function _deleteCustomPreset(idx){
  if(!confirm('确定删除预设「'+CUSTOM_PRESETS[idx].name+'」？'))return;
  CUSTOM_PRESETS.splice(idx,1);_saveCustomPresets();renderPresetList();toast('🗑 已删除');
}
function _renameCustomPreset(idx){
  const newName=prompt('重命名预设：',CUSTOM_PRESETS[idx].name);if(!newName||!newName.trim())return;
  CUSTOM_PRESETS[idx].name=newName.trim();_saveCustomPresets();renderPresetList();

}

/* ---- 渲染预设列表 + 最近颜色 ---- */
function renderPresetList(){
  const box=document.getElementById('cpPresetList');if(!box)return;
  box.innerHTML='';
  const allPresets=[...COLOR_PRESETS,...CUSTOM_PRESETS];
  allPresets.forEach((p,idx)=>{
    const b=document.createElement('div');b.className='cp-preset';
    b.setAttribute('data-name',p.name);
    b.innerHTML='<span style="background:'+p.c.lt0+'"></span><span style="background:'+p.c.lt+'"></span><span style="background:'+p.c.ovr+'"></span>';
    b.onclick=(e)=>{if(e.target.closest('.cp-p-del')||e.target.closest('.cp-p-edit'))return;applyPreset(p.c);toast('🎨 已应用预设：'+p.name);};
    box.appendChild(b);
    /* 自定义预设：悬浮显示编辑/删除按钮 */
    if(!p.builtin){
      const del=document.createElement('button');del.className='cp-p-del';del.title='删除预设';del.innerHTML='✕';del.onclick=(e)=>{e.stopPropagation();_deleteCustomPreset(idx-COLOR_PRESETS.length);};
      const edit=document.createElement('button');edit.className='cp-p-edit';edit.title='重命名';edit.innerHTML='✎';edit.onclick=(e)=>{e.stopPropagation();_renameCustomPreset(idx-COLOR_PRESETS.length);};
      b.appendChild(del);b.appendChild(edit);
    }
  });
  _renderRecentColors();
}

/* ===== v7.24 成员手动拖拽排序 + 智能排序 + FLIP 过渡动画 =====
   排序结果存 m.sort（全局唯一升序序号），随快照 save/broadcast 落本地+同步云端，刷新/协作不丢。
   手动拖拽：按住行首 ⋮⋮ 手柄上下拖，同组内插入（分组视图不跨组，避免与分组语义打架）。
   智能排序：最大化相邻成员相似度（共享需求×3 + 同带队×2 + 同编制×0.5），2-opt 插入法收敛，
   让甘特条内容相关的成员聚成整齐的块。FLIP：重渲染前后量行 top，translateY 反向补偿再过渡。 */
function captureRowTops(){
  const map=new Map();
  document.querySelectorAll('#grid > .row[data-mem]').forEach(r=>map.set(r.dataset.mem, r.getBoundingClientRect().top));
  return map;
}
function flipAnimateRows(before){
  if(!before||!before.size)return;
  const moved=[];
  document.querySelectorAll('#grid > .row[data-mem]').forEach(r=>{
    const old=before.get(r.dataset.mem);
    if(old==null)return;
    const dy=old-r.getBoundingClientRect().top;
    if(Math.abs(dy)<3)return;
    r.classList.add('flip-moving');
    r.style.transition='none';
    r.style.transform=`translateY(${dy}px)`;
    moved.push(r);
  });
  if(!moved.length)return;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    moved.forEach(r=>{
      r.style.transition='transform .38s cubic-bezier(.22,.8,.32,1)';
      r.style.transform='translateY(0px)';
      const done=()=>{r.classList.remove('flip-moving');r.style.transition='';r.style.transform='';};
      r.addEventListener('transitionend',done,{once:true});
      setTimeout(done,480);   // 兜底：transitionend 不触发时也清理现场
    });
  }));
}
/* 当前可视成员顺序（与 renderPerson 同一套筛选/排序，拖拽落点与智能排序共用） */
function currentPersonOrder(){
  const visible=members.filter(m=>{
    if(!ARCHIVE.on && leftLong(m)) return false;
    if(focusMode==='only' && focusRole(m)==='') return false;
    return true;
  });
  const live=visible.filter(m=>!memArchived(m));
  live.sort((a,b)=>personSortCompare(a,b));
  return live;
}
let _rowDrag=null;
function rowGripDown(e,memId){
  if(view!=='person')return;
  e.preventDefault();e.stopPropagation();
  const row=document.querySelector(`#grid > .row[data-mem="${memId}"]`);
  if(!row)return;
  const cl=row.querySelector('.cell-left'); if(!cl)return;
  const rect=row.getBoundingClientRect(), clRect=cl.getBoundingClientRect();
  const ghost=cl.cloneNode(true);
  ghost.classList.add('row-drag-ghost');
  ghost.style.cssText=`position:fixed;left:${clRect.left}px;top:${rect.top}px;width:${clRect.width}px;height:${rect.height}px;z-index:1000;pointer-events:none;box-sizing:border-box;margin:0;`;
  document.body.appendChild(ghost);
  _rowDrag={memId,ghost,offY:e.clientY-rect.top,targetId:null,insertBefore:true};
  row.classList.add('row-drag-src');
  document.body.classList.add('row-drag-active');
  window.addEventListener('pointermove',_rowDragMove,{passive:false});
  window.addEventListener('pointerup',_rowDragUp,{once:true});
}
function _rowDragCands(){
  // 候选落点：非归档区数据行；分组视图下与被拖行同组（不跨组，保持分组语义）
  const m0=members.find(x=>x.id===_rowDrag.memId); if(!m0)return [];
  const gk=(GROUP_MODE.person!=='none'&&typeof personGroupKey==='function')?((personGroupKey(m0)||{}).key||null):null;
  return [...document.querySelectorAll('#grid > .row[data-mem]')].filter(r=>{
    if(r.dataset.mem===_rowDrag.memId)return false;
    if(r.classList.contains('in-archived'))return false;
    if(gk){const mm=members.find(x=>x.id===r.dataset.mem);const k=mm?((personGroupKey(mm)||{}).key||null):null;if(k!==gk)return false;}
    return true;
  });
}
function _rowDragMove(e){
  if(!_rowDrag)return;
  e.preventDefault();
  const d=_rowDrag;
  d.ghost.style.top=(e.clientY-d.offY)+'px';
  let hit=null,before=true;
  for(const r of _rowDragCands()){
    const rc=r.getBoundingClientRect();
    if(e.clientY>=rc.top&&e.clientY<=rc.bottom){hit=r;before=e.clientY<rc.top+rc.height/2;break;}
  }
  document.querySelectorAll('#grid > .row.ins-before,#grid > .row.ins-after').forEach(x=>x.classList.remove('ins-before','ins-after'));
  d.targetId=null;
  if(hit){
    d.targetId=hit.dataset.mem; d.insertBefore=before;
    hit.classList.add(before?'ins-before':'ins-after');
  }
}
function _rowDragUp(){
  window.removeEventListener('pointermove',_rowDragMove);
  document.body.classList.remove('row-drag-active');
  document.querySelectorAll('#grid > .row.ins-before,#grid > .row.ins-after').forEach(x=>x.classList.remove('ins-before','ins-after'));
  document.querySelectorAll('#grid > .row.row-drag-src').forEach(x=>x.classList.remove('row-drag-src'));
  const d=_rowDrag; _rowDrag=null;
  if(d&&d.ghost)d.ghost.remove();
  if(d&&d.targetId)applyMemberDrop(d.memId,d.targetId,d.insertBefore);
}
function applyMemberDrop(dragId,targetId,before){
  if(dragId===targetId)return;
  const beforeMap=captureRowTops();
  const live=currentPersonOrder();
  const drag=live.find(m=>m.id===dragId), tgt=live.find(m=>m.id===targetId);
  if(!drag||!tgt)return;
  const arr=live.filter(m=>m.id!==dragId);
  let ti=arr.findIndex(m=>m.id===targetId);
  if(ti<0)return;
  if(!before)ti+=1;
  arr.splice(ti,0,drag);
  pushHistory();   // 排序入撤销栈（Ctrl+Z 可回退），与其他数据改动同待遇
  arr.forEach((m,i)=>{m.sort=i*10;});
  _logDesc=`成员排序：${drag.name}→${tgt.name}${before?'前':'后'}`;
  save();broadcast();rerender();
  flipAnimateRows(beforeMap);
  toast(`已把「${drag.name}」移到「${tgt.name}」${before?'前':'后'}面 · 排序已保存并同步`);
}
/* ===== v7.33 可配置智能排序规则 =====
   把原「单一相似度」拆成可开关/可调权的多维度信号，统一汇入 2-opt 邻接优化。
   每个维度是成员对的相似度函数 dim(a,b)→score；组合得分 = Σ 启用维度(权重×dim)。
   权重即优先级：多维度冲突由加权目标全局调和，权重高者主导（非字典序硬切）。
   维度清单：
     req  需求相近   = 共享需求数（原始计数，越多越应相邻）
     mod  模块相近   = 共享模块类型数（两人参与需求的 r.mod 集合交集大小）
     lead 隶属相近   = 同带队 ? 1 : 0
     neat 档期整齐度 = 两人活跃档期的时间重叠率(交集/并集∈[0,1])，档期越对齐越应相邻→纵向成块
     corp 编制聚合   = 同编制 ? 1 : 0
   默认沿用原配比(req3/lead2/corp0.5)，mod/neat 为新维度默认关闭 → 向后兼容不改变既有行为。
   配置持久化 localStorage('gantt_sort_rules')，纯本机偏好、不进云端、不影响他人。 */
const SORT_RULE_DEFS={
  req :{label:'需求相近',  def:{on:true ,w:3.0}},
  mod :{label:'模块相近',  def:{on:false,w:2.0}},
  lead:{label:'隶属相近',  def:{on:true ,w:2.0}},
  neat:{label:'档期整齐度',def:{on:false,w:1.5}},
  corp:{label:'编制聚合',  def:{on:true ,w:0.5}},
};
let SORT_RULES={};
try{
  const _r=JSON.parse(localStorage.getItem('gantt_sort_rules')||'null');
  for(const k in SORT_RULE_DEFS)SORT_RULES[k]={on:(_r&&_r[k]&&_r[k].on!=null)?!!_r[k].on:SORT_RULE_DEFS[k].def.on, w:(_r&&_r[k]&&typeof _r[k].w==='number')?_r[k].w:SORT_RULE_DEFS[k].def.w};
}catch(_){for(const k in SORT_RULE_DEFS)SORT_RULES[k]={...SORT_RULE_DEFS[k].def};}
function saveSortRules(){try{localStorage.setItem('gantt_sort_rules',JSON.stringify(SORT_RULES));}catch(_){}}
/* 各维度相似度（cache 含 req/mod/span 三个 Map） */
function _dimReq(a,b,cache){const ra=cache.req.get(a.id),rb=cache.req.get(b.id);let s=0;if(ra&&rb)ra.forEach(x=>{if(rb.has(x))s++;});return s;}
function _dimMod(a,b,cache){const ma=cache.mod.get(a.id),mb=cache.mod.get(b.id);let s=0;if(ma&&mb)ma.forEach(x=>{if(mb.has(x))s++;});return s;}
function _dimLead(a,b){const la=leadOf(a)||'',lb=leadOf(b)||'';return (la&&la===lb)?1:0;}
function _dimCorp(a,b){return a.corp===b.corp?1:0;}
function _dimNeat(a,b,cache){
  const ra=cache.span.get(a.id),rb=cache.span.get(b.id);
  if(!ra||!rb)return 0;
  const lo=Math.max(ra.min,rb.min),hi=Math.min(ra.max,rb.max);
  if(hi<=lo)return 0;
  const span=Math.max(ra.max,rb.max)-Math.min(ra.min,rb.min);
  return span>0?(hi-lo)/span:0;
}
/* 组合相似度：Σ 启用维度(权重×dim) */
function _combinedSim(a,b,cache){
  let s=0;
  if(SORT_RULES.req .on)s+=SORT_RULES.req .w*_dimReq (a,b,cache);
  if(SORT_RULES.mod .on)s+=SORT_RULES.mod .w*_dimMod (a,b,cache);
  if(SORT_RULES.lead.on)s+=SORT_RULES.lead.w*_dimLead(a,b);
  if(SORT_RULES.neat.on)s+=SORT_RULES.neat.w*_dimNeat(a,b,cache);
  if(SORT_RULES.corp.on)s+=SORT_RULES.corp.w*_dimCorp(a,b);
  return s;
}
/* 构建一次排序缓存：每成员的需求集合 / 模块集合 / 活跃档期区间(min~max ms) */
function _sortCache(live){
  const cache={req:new Map(),mod:new Map(),span:new Map()};
  live.forEach(m=>{
    const rset=new Set(),mset=new Set();let mn=Infinity,mx=-Infinity;
    reqs.forEach(r=>r.segs.forEach(s=>{if(s.m===m.id){rset.add(r.id);mset.add(r.mod||'其他');const t0=s.s.getTime(),t1=s.e.getTime();if(t0<mn)mn=t0;if(t1>mx)mx=t1;}}));
    cache.req.set(m.id,rset);cache.mod.set(m.id,mset);cache.span.set(m.id,isFinite(mn)?{min:mn,max:mx}:null);
  });
  return cache;
}
function _twoOptOrder(arr,sim){
  const o=arr.slice();
  const score=()=>{let s=0;for(let k=0;k<o.length-1;k++)s+=sim(o[k],o[k+1]);return s;};
  let guard=0;
  while(guard++<60){
    const cur=score();
    let best={gain:1e-9,j:-1,i:-1};
    for(let j=0;j<o.length;j++){
      for(let i=0;i<o.length;i++){
        if(i===j)continue;
        const rm=o.splice(j,1)[0]; o.splice(i,0,rm);
        const g=score()-cur;
        o.splice(i,1); o.splice(j,0,rm);
        if(g>best.gain)best={gain:g,j,i};
      }
    }
    if(best.j<0)break;
    const rm=o.splice(best.j,1)[0]; o.splice(best.i,0,rm);
  }
  return o;
}
function smartSortMembers(){
  if(view!=='person'){toast('「智能排序」作用于成员列表，请切换到「按人看」');return;}
  const live=currentPersonOrder();
  if(live.length<3){toast('成员太少，无需智能排序');return;}
  const cache=_sortCache(live);                       // v7.33 需求/模块/档期 三类缓存
  const sim=(a,b)=>_combinedSim(a,b,cache);           // v7.33 按用户勾选+权重组合
  const beforeMap=captureRowTops();
  let newLive=[];
  if(GROUP_MODE.person==='none'){
    newLive=_twoOptOrder(live,sim);
  }else{
    // 保持现有分组与组序，组内各自优化（与 renderPerson 的聚组/组序一致）
    const groups={},order=[];
    live.forEach(m=>{const g=personGroupKey(m),k=g.key;if(!groups[k]){groups[k]={g,arr:[]};order.push(k);}groups[k].arr.push(m);});
    order.sort((a,b)=>groupSortVal(a)-groupSortVal(b)||groups[a].g.label.localeCompare(groups[b].g.label,'zh-Hans-CN'));
    order.forEach(k=>{newLive=newLive.concat(_twoOptOrder(groups[k].arr,sim));});
  }
  pushHistory();   // 排序入撤销栈（Ctrl+Z 可回退）
  newLive.forEach((m,i)=>{m.sort=i*10;});
  _logDesc='智能排序成员';
  save();broadcast();rerender();
  flipAnimateRows(beforeMap);
  const act=Object.keys(SORT_RULES).filter(k=>SORT_RULES[k].on).map(k=>SORT_RULE_DEFS[k].label).join('·')||'无';
  toast('✨ 已按规则['+act+']优化成员排序 · 结果已保存并同步');
}
function resetMemberSort(){
  if(view!=='person'){toast('请切换到「按人看」再操作排序');return;}
  let n=0; members.forEach(m=>{if(m.sort!=null){m.sort=null;n++;}});
  if(!n){toast('已是默认排序');return;}
  const beforeMap=captureRowTops();
  pushHistory();   // 排序入撤销栈（Ctrl+Z 可回退）
  _logDesc='恢复默认成员排序';
  save();broadcast();rerender();
  flipAnimateRows(beforeMap);
  toast('↺ 已恢复系统默认排序');
}

/* ===== v7.33 排序规则配置面板（勾选维度 + 调权重，实时持久化） ===== */
function toggleSortRulePop(){const p=document.getElementById('sortRulePop');if(!p)return;const open=!p.classList.contains('show');if(open)renderSortRulePop();p.classList.toggle('show');}
function renderSortRulePop(){
  const box=document.getElementById('srList');if(!box)return;
  box.innerHTML='';
  for(const k in SORT_RULE_DEFS){
    const d=SORT_RULE_DEFS[k],r=SORT_RULES[k];
    const row=document.createElement('div');row.className='sr-row';
    row.innerHTML=`<label class="sr-chk"><input type="checkbox" ${r.on?'checked':''} onchange="changeSortRule('${k}','on',this.checked,this)"><span>${d.label}</span></label>`
      +`<input type="range" class="sr-w" min="0" max="5" step="0.5" value="${r.w}" ${r.on?'':'disabled'} oninput="changeSortRule('${k}','w',this.value)">`
      +`<span class="sr-val" id="srVal_${k}">${r.w}</span>`;
    box.appendChild(row);
  }
}
function changeSortRule(k,field,val,el){
  if(field==='on'){
    SORT_RULES[k].on=!!val;
    const row=el&&el.closest('.sr-row');const rng=row&&row.querySelector('.sr-w');
    if(rng)rng.disabled=!val;
  }else{
    SORT_RULES[k].w=parseFloat(val)||0;
    const v=document.getElementById('srVal_'+k);if(v)v.textContent=SORT_RULES[k].w;
  }
  saveSortRules();
}
function resetSortRules(){for(const k in SORT_RULE_DEFS)SORT_RULES[k]={...SORT_RULE_DEFS[k].def};saveSortRules();renderSortRulePop();toast('⚖️ 已恢复默认排序规则');}
function applySortRules(){smartSortMembers();}
/* 点击面板外区域关闭排序规则面板（按钮 #sortRuleBtn 不触发关闭） */
document.addEventListener('click',function(e){const p=document.getElementById('sortRulePop');if(!p||!p.classList.contains('show'))return;if(!p.contains(e.target)&&!e.target.closest('#sortRuleBtn'))p.classList.remove('show');},true);

buildMeSel();
initVivid();
initGridGap();
initHolOpacity();
initMsLinkOpac();
initZoom();
initLeftW();
applyLblShow();
_migrateMsBg();       // v7.47 老版 gantt_ms_bg → 统一色板 MS_PALETTE.msBg
applyMsPalette();    // v7.47 应用「关键节点统一色板」（汇总行底色 / 虚线色 / 阶段色 / 候选色板）
applyUserColors();   // v7.30 应用本机自定义配色（无则保持 :root 默认）
_pushColorHistory();   // v7.35 初始化撤销/重做栈
renderPresetList();   // v7.32 渲染一键预设色板
// 恢复分组方式 / 折叠状态（本机偏好）
try{const gp=localStorage.getItem('gantt_group_person'); if(gp)GROUP_MODE.person=gp;}catch(_){}
try{const gr=localStorage.getItem('gantt_group_req'); if(gr)GROUP_MODE.req=gr;}catch(_){}
try{const cs=localStorage.getItem('gantt_collapsed'); if(cs)collapsed=JSON.parse(cs)||{};}catch(_){}
// 分享链接优先：URL 带 #s= 时用链接里的排期；否则读本机缓存
if(loadFromHash()){ hasHashSnap=true; toast('已载入分享链接中的排期'); }
else { loadSaved(); }
syncEffFromTiers();
_migrateLoanRecords();   // v7.48 存量「裸 support」外借人员 → 正式外借记录（幂等，只加字段不改现值）
scanLoanExpiry();        // v7.48 到期外借记录自动封存（幂等，只改 state，不动人/编制）
// 首次/口径升级：用真实排期(Σ分摊后投入比×效率)重算占位工作量。applySnap 已对有快照的路径迁移过；
// 这里兜底处理「无快照的全新环境」（localStorage/云端都为空，INV_TIERS 走硬编码初始区间值）。
if(estRecalcVer < EST_RECALC_VER){
  migrateInvModel();   // 幂等：补齐区间 + 重算 estimate + 置 estRecalcVer
  save();
}
bindEffTable();
applyEffLockUI();
bindStdTable();
applyStdLockUI();
bindInvTable();
applyInvLockUI();
updateLegend();
updateHint();
updateGroupSelUI();
syncOrgUI();
rerender();
// 初始即反映只读视觉态（不等云端连上）
document.body.classList.toggle('ro-mode', !canWrite());
// 启动云端协作（公开读 / 编辑锁互斥写 / Realtime 实时汇集）
if(typeof cloudInit==='function'){ cloudInit(); }
/* v6.75 身份确认流程（企微OAuth优先）：
   1. 先尝试解析URL中的企微OAuth回调结果（#wecom_auth=base64）
   2. 再尝试恢复localStorage中的企微验证缓存
   3. 都没有 → 延后弹窗（等云端members拉取完毕再弹，确保名单完整） */
(function initIdentity(){
  // Step 1: 解析 OAuth 回调 hash（用户刚从企微授权回来）
  const authResult = parseWecomAuthHash();
  if(authResult){
    // OAuth 回调处理（异步，不需要等 cloudInit）
    if(processWecomAuthResult(authResult)){
      return; // 成功匹配到成员，不再弹窗
    }
    // 匹配失败：继续走下面的流程，会弹出身份选择窗
  }
  // Step 2: 恢复缓存的企微验证
  if(restoreWecomCache()){
    return; // 缓存有效且成员仍在名单中
  }
  // Step 3: 延后检查是否需要弹窗（与 v6.71 一致，等云端 members 拉取完）
  setTimeout(()=>{
    try{
      if(typeof needIdentityConfirm==='function' && needIdentityConfirm()){
        openIdentityDialog();
      }
    }catch(e){ console.warn('identity dialog failed',e); }
  }, 1200);
})();
// Supabase Free 计划 7 天无活动会自动 pause 数据库,这里每天 9 点自动 ping 一次防止被休眠
if(typeof startKeepAlivePing==='function'){ startKeepAlivePing(); }
// 持锁后 5 分钟无操作自动提交并释放编辑权：一次性绑定全局活动监听
if(typeof bindIdleWatch==='function'){ bindIdleWatch(); }
// 当前日期红线即时刷新：每分钟检查系统日期，跨天自动重绘红线
if(typeof bindTodayWatch==='function'){ bindTodayWatch(); }
// 鼠标中键按住拖动平移视图
if(typeof bindMidDragPan==='function'){ bindMidDragPan(); }
// v7.12 今天日期胶囊跟随横向滚动 / 容器尺寸变化（红线在内容坐标系，胶囊在可视坐标系，需减 scrollLeft）
if(typeof bindTodayLabelFollow==='function'){ bindTodayLabelFollow(); }
// 关闭/刷新页面时若持有编辑锁，立即释放，避免锁悬挂阻塞他人（用 keepalive 同步发出）
window.addEventListener('pagehide',()=>{ if(lockMine&&sb){ try{ releaseLockBeacon(); }catch(_){} } });
window.addEventListener('beforeunload',()=>{ if(lockMine&&sb){ try{ releaseLockBeacon(); }catch(_){} } });
/* 关页瞬间用 fetch+keepalive 释放锁。若最后 700ms 防抖尚未落云，先同步保存 PENDING_KEY，
   下次启动会走安全恢复流程；避免为了塞入大 snap 而超过 keepalive 约 64KB 上限。 */
let _beaconReleased=false;
function releaseLockBeacon(){
  if(_beaconReleased)return;
  _beaconReleased=true;
  stopHeart();
  let recoverySafe=true;
  try{
    const latest=snapshot();
    if(JSON.stringify(latest)!==lastSyncJSON)storePendingSnapshot(latest);
  }catch(e){
    recoverySafe=false;
    console.warn('pagehide pending snapshot save failed; keep lock to avoid silent data loss',e);
  }
  // 无法保存最后改动的恢复副本时宁可留下僵尸锁，也不释放后让未同步数据静默消失。
  if(!recoverySafe)return;
  // 关页瞬间清空锁：用本页面唯一 editor id，旧页面的迟到 beacon 无法命中新页面租约。
  const url=SB_URL+'/rest/v1/'+SB_TABLE+'?id=eq.'+SB_ROW+'&editor=eq.'+cloudCid;
  try{
    fetch(url,{method:'PATCH',keepalive:true,
      headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({editor:null,editor_name:null})});
  }catch(_){}
  lockMine=false; cloudLeaseNeedsRotate=true;
}

/* v6.66 首屏快捷入口跳转：滚到目标板块并短暂高亮，让用户跳过去后立刻知道该看哪一块。
   与左侧目录共用同一批 section id，行为一致。 */
function jumpToPanel(ev, secId){
  if(ev) ev.preventDefault();
  const el=document.getElementById(secId); if(!el) return;
  el.scrollIntoView({behavior:'smooth',block:'start'});
  // 落地闪烁：加类 → 动画结束自动移除（不残留状态）
  el.classList.remove('jump-flash');
  void el.offsetWidth;                 // 强制重排，保证连续点同一项也能重放动画
  el.classList.add('jump-flash');
  setTimeout(()=>el.classList.remove('jump-flash'), 1600);
}

/* v6.67 侧边导航折叠 / 展开（状态存 localStorage，刷新后保持用户选择）。
   同步给 body 打 .snav-collapsed 类 —— 内容区左侧让位宽度随之从 92px 收到 50px。 */
function toggleSideNav(){
  const nav=document.getElementById('sideNav'); if(!nav) return;
  const collapsed=nav.classList.toggle('collapsed');
  document.body.classList.toggle('snav-collapsed', collapsed);
  const btn=document.getElementById('sideNavToggle');
  if(btn){ btn.textContent = collapsed ? '›' : '‹'; btn.title = collapsed ? '展开侧边导航' : '折叠侧边导航'; }
  try{ localStorage.setItem('vfxSideNavCollapsed', collapsed ? '1' : '0'); }catch(_){}
  // 让位宽度变化会改变可视宽度，通知甘特区重算列宽/滚动位
  if(typeof rerender==='function'){ setTimeout(()=>{ try{ rerender(); }catch(_){} }, 220); }
}

/* v6.61/v6.67: 参考数据导航（面板内目录 .ptoc-item + 屏幕左缘侧边导航 .sn-item）
   —— 两套 DOM 共用同一批 section id 与同一个 IntersectionObserver，滚动高亮完全同步。 */
(function(){
  const tocItems=document.querySelectorAll('#panelToc .ptoc-item');
  const navItems=document.querySelectorAll('#sideNav .sn-item');
  const items=[...tocItems, ...navItems];
  if(!items.length) return;
  // 面板内目录的点击跳转（侧边导航已在 HTML 内联 jumpToPanel，带落地高亮）
  tocItems.forEach(a=>{
    a.addEventListener('click',function(e){
      e.preventDefault();
      jumpToPanel(e, this.dataset.target);
    });
  });
  // 恢复侧边导航折叠状态（含 body 让位类，避免刷新后导航是折叠态但内容仍留 92px 空白）
  try{
    if(localStorage.getItem('vfxSideNavCollapsed')==='1'){
      const nav=document.getElementById('sideNav');
      const btn=document.getElementById('sideNavToggle');
      if(nav){ nav.classList.add('collapsed'); }
      document.body.classList.add('snav-collapsed');
      if(btn){ btn.textContent='›'; btn.title='展开侧边导航'; }
    }
  }catch(_){}
  // 视图标签初始化（刷新后保持与当前 view 一致）
  if(typeof syncSideNavViewLabel==='function'){ syncSideNavViewLabel(); }

  /* v6.68 滚动高亮改用「滚动位置直接判定」，替代 IntersectionObserver。
     换掉的原因：IO 的 rootMargin:'-60px 0 -60% 0' 只留下屏幕上部 40% 作为判定带，
     而 .board（甘特图区）高度常达 600~900px，远超判定带 → 它整块 intersecting 的时机
     与底部小板块混在一起，导致看甘特图时高亮仍落在"负载率"上（用户反馈"对不上"）。
     新方案：取各锚点相对文档顶的位置，选出「最后一个已滚过判定线的锚点」，
     判定线设在视口上方 30% 处。这对区块高度完全不敏感，任意高度都准。 */
  const ids=[...new Set(items.map(a=>a.dataset.target))];
  /* ⚠️ 必须按**文档顺序**排序：判定逻辑是"取最后一个已滚过判定线的锚点"，
     若数组顺序与页面实际顺序不一致（本例导航里视图区在前、面板锚点在后，
     但 tocItems 先于 navItems 被收集，会让 sec-load 排在 sec-top 之前），结果就会错乱。
     用 compareDocumentPosition 保证与页面真实先后一致。 */
  const sections=ids.map(id=>document.getElementById(id)).filter(Boolean)
    .sort((a,b)=> (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  if(!sections.length) return;
  let rafPending=false;
  function updateActive(){
    rafPending=false;
    const line=window.scrollY + window.innerHeight*0.30;   // 判定线：视口上方 30%
    let cur=sections[0];
    sections.forEach(s=>{
      const top=s.getBoundingClientRect().top + window.scrollY;
      if(top <= line) cur=s;                                // 已滚过判定线 → 更新为它
    });
    // 滚到文档底部时强制高亮最后一项（否则末尾短板块永远选不中）
    if(window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4){
      cur = sections[sections.length-1];
    }
    if(cur) items.forEach(i=>i.classList.toggle('on', i.dataset.target===cur.id));
  }
  function onScroll(){ if(!rafPending){ rafPending=true; requestAnimationFrame(updateActive); } }
  window.addEventListener('scroll', onScroll, {passive:true});
  window.addEventListener('resize', onScroll, {passive:true});
  updateActive();
})();

