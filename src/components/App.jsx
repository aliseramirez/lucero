import { useState, useEffect, createContext, useContext, useRef } from "react";

// ── STUBS ────────────────────────────────────────────────────────────────────
const supabase = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }), insert: () => Promise.resolve({}), update: () => ({ eq: () => ({ eq: () => Promise.resolve({}) }) }) }) };

// ── UTILS ────────────────────────────────────────────────────────────────────
const fmtC = (n) => n >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : n >= 1000 ? `$${(n/1000).toFixed(0)}K` : `$${n ?? 0}`;
const dAgo = (d) => Math.floor((Date.now() - new Date(d)) / 86400000);
const dUntil = (d) => Math.ceil((new Date(d) - Date.now()) / 86400000);
const genId = () => Math.random().toString(36).substr(2,9);
const getCB = (inv={}) => (inv.costBasis > 0 ? inv.costBasis : inv.amount) || 0;

// ── VALUATION ENGINE ─────────────────────────────────────────────────────────
const STAGE_MAT = { 'pre-seed':'lab','seed':'pilot','series-a':'scale','series-b':'scale','series-c':'deploy','series-e':'deploy','growth':'deploy','lp-fund':'fund' };
const getMethod = (deal) => { const inv=deal.investment||{}; if(inv.valuationMethod) return inv.valuationMethod; const m=STAGE_MAT[deal.stage]||'lab'; return m==='lab'||m==='pilot'?'mark-at-cost':m==='fund'?'nav-lp':'last-round'; };
const getMethodLabel = (m) => ({'mark-at-cost':'Mark at cost','last-round':'Last round','safe-cap':'SAFE cap','nav-lp':'Fund NAV'}[m]||m);
const calcIV = (deal) => { const inv=deal.investment||{}; const m=getMethod(deal); const cb=getCB(inv); if(m==='mark-at-cost') return cb; if(inv.impliedValue>0) return inv.impliedValue; if(inv.ownershipPercent&&inv.impliedValuation) return Math.round((inv.ownershipPercent/100)*inv.impliedValuation); return cb; };
const calcMOIC = (deal) => { const cb=getCB(deal.investment||{}); return cb?calcIV(deal)/cb:null; };
const calcMarkup = (deal) => { const inv=deal.investment||{}; const m=getMethod(deal); if(m==='mark-at-cost'||m==='nav-lp') return null; const cur=inv.impliedValuation; if(!cur) return null; if(inv.vehicle==='SAFE'&&deal.terms?.cap) return cur/deal.terms.cap; if(inv.entryPostMoneyValuation>0) return cur/inv.entryPostMoneyValuation; return null; };
const getStaleness = (deal) => { const d=deal.investment?.lastValuationDate; if(!d) return 'unknown'; const x=dAgo(d); return x<90?'fresh':x<180?'ok':x<365?'stale':'very-stale'; };
const STALE_COL = { fresh:'#10b981',ok:'#F5DFA0',stale:'#f59e0b','very-stale':'#ef4444',unknown:'#78716c' };

// ── HEALTH ENGINE ────────────────────────────────────────────────────────────
const SIG_KW = {
  hardware_milestone:['pilot','commissioning','operational','plant','demonstration','megawatt','gigawatt','mwh','gwh'],
  policy_positive:['ira','doe loan','arpa-e','sbir','45q','45v','48c','investment tax credit'],
  policy_risk:['rollback','repeal','tariff','ira repeal','epa reversal','permit denied'],
  offtake:['offtake','ppa','supply agreement','loi','letter of intent','mou','anchor customer'],
  team_risk:['ceo departure','cto left','co-founder left','founder resigned'],
  funding_signal:['series a','series b','seed round','raised','closed funding'],
};
const SIG_PATS = [
  { pat:/raised|closed.{0,15}round|new.{0,10}funding/i, s:'positive', t:'funding_signal', l:'Funding event mentioned' },
  { pat:/customer|signed|offtake|ppa|loi|mou/i, s:'positive', t:'offtake', l:'Customer or offtake signal' },
  { pat:/launched|deployed|operational|commission|on.track/i, s:'positive', t:'hardware_milestone', l:'Milestone progress' },
  { pat:/grant|award|doe|arpa|sbir/i, s:'positive', t:'policy_positive', l:'Grant or public funding' },
  { pat:/delay|behind.{0,10}schedule|push.{0,10}back/i, s:'negative', t:'risk', l:'Delay or setback' },
  { pat:/left.{0,10}(company|team)|resigned|departed/i, s:'negative', t:'team_risk', l:'Team departure' },
];
const parseNote = (text,date) => { if(!text||text.length<20) return []; const seen=new Set(); return SIG_PATS.filter(({pat,s,t})=>{ if(!pat.test(text)||seen.has(t+s)) return false; seen.add(t+s); return true; }).map(({s,t,l})=>({type:t,title:l,description:text.slice(0,100),sentiment:s,date:date||new Date().toISOString(),fromUpdate:true})); };
const getUpdateSigs = (deal) => (deal.milestones||[]).filter(m=>m.type==='update'&&dAgo(m.date)<180).flatMap(m=>parseNote(m.description,m.date));
const classifySig = (sig) => { const txt=`${sig.title} ${sig.description}`.toLowerCase(); return Object.entries(SIG_KW).filter(([,kws])=>kws.some(k=>txt.includes(k))).map(([t])=>t); };

const calcHealth = (deal, extSigs=[]) => {
  const inv=deal.investment||{}; const mat=STAGE_MAT[deal.stage]||'lab';
  const sigs=[...extSigs,...getUpdateSigs(deal)].map(s=>({...s,tags:classifySig(s)}));
  const cb=getCB(inv); const iv=calcIV(deal); const moic=cb>0?iv/cb:null; const method=getMethod(deal);
  let score=50; const factors=[]; let needsCheckIn=false; let checkInReason=null;

  const lastUpd=inv.lastUpdateReceived||deal.lastUpdateReceived;
  const nextExp=inv.nextUpdateExpected||deal.nextUpdateExpected;
  const dSinceUpd=lastUpd?dAgo(lastUpd):999;
  const dUntilNext=nextExp?dUntil(nextExp):null;
  const overdueThr=mat==='lab'?60:30;
  const isOverdue=dUntilNext!==null&&dUntilNext<-overdueThr;
  if(isOverdue){score-=12;needsCheckIn=true;checkInReason=`Update ${Math.abs(dUntilNext)}d overdue`;factors.push({l:'Update overdue',v:-12,t:'warning'});}
  else if(dSinceUpd<45){score+=8;factors.push({l:'Recent founder update',v:8,t:'positive'});}
  if(dSinceUpd>(mat==='lab'?180:90)){score-=8;factors.push({l:`${Math.round(dSinceUpd/30)}mo silence`,v:-8,t:'warning'});if(!needsCheckIn){needsCheckIn=true;checkInReason='Extended silence';}}

  sigs.forEach(s=>{
    const pos=s.sentiment==='positive'; const neg=s.sentiment==='negative';
    if(s.tags.includes('hardware_milestone')){const v=pos?15:-18;score+=v;factors.push({l:pos?'Hardware milestone confirmed':'Hardware setback',v,t:pos?'positive':'negative'});if(neg){needsCheckIn=true;checkInReason=checkInReason||'Hardware setback';}}
    if(s.tags.includes('policy_positive')&&pos){score+=12;factors.push({l:'Policy tailwind / federal funding',v:12,t:'positive'});}
    if(s.tags.includes('policy_risk')){score-=15;needsCheckIn=true;checkInReason=checkInReason||'Policy risk';factors.push({l:'Policy risk signal',v:-15,t:'negative'});}
    if(s.tags.includes('offtake')&&pos){score+=14;factors.push({l:'Offtake / customer signal',v:14,t:'positive'});}
    if(s.tags.includes('team_risk')){score-=14;needsCheckIn=true;checkInReason=checkInReason||'Team risk';factors.push({l:'Team / leadership risk',v:-14,t:'negative'});}
    if(s.tags.includes('funding_signal')&&pos){score+=10;factors.push({l:'New funding signal',v:10,t:'positive'});}
  });

  if(mat==='lab'){const ms=(deal.milestones||[]).filter(m=>dAgo(m.date)<180&&['product','partnership','fundraising'].includes(m.type)).length;if(ms>=1){score+=10;factors.push({l:'Recent technical milestone',v:10,t:'positive'});}factors.push({l:'Lab stage — marked at cost, TRL 1–3',v:0,t:'info'});}
  if(mat==='pilot'){const ps=(deal.milestones||[]).filter(m=>dAgo(m.date)<180&&m.type!=='update').length;if(ps>=2){score+=12;factors.push({l:'Active pilot cadence',v:12,t:'positive'});}else if(ps===0&&dSinceUpd>120){score-=12;needsCheckIn=true;checkInReason=checkInReason||'Pilot progress unclear';factors.push({l:'No pilot signals in 4mo',v:-12,t:'warning'});}factors.push({l:'Pilot stage — TRL 4–6',v:0,t:'info'});}
  if(mat==='scale'&&moic!==null){if(moic>=2){score+=18;factors.push({l:`${moic.toFixed(1)}x last-round mark`,v:18,t:'positive'});}else if(moic>=1.3){score+=8;factors.push({l:`${moic.toFixed(1)}x last-round mark`,v:8,t:'positive'});}else if(moic<0.8){score-=18;needsCheckIn=true;factors.push({l:`${moic.toFixed(1)}x — below cost`,v:-18,t:'negative'});}}
  if(mat==='deploy'&&moic!==null){if(moic>=3){score+=22;factors.push({l:`${moic.toFixed(1)}x — deployment premium`,v:22,t:'positive'});}else if(moic>=1.5){score+=12;factors.push({l:`${moic.toFixed(1)}x last-round mark`,v:12,t:'positive'});}else if(moic<1){score-=20;needsCheckIn=true;factors.push({l:`${moic.toFixed(1)}x — late-stage below cost`,v:-20,t:'negative'});}}
  const ms2=deal.monitoring||{};
  if(ms2.healthStatus==='thriving'){score+=8;factors.push({l:'Founder reports on track',v:8,t:'positive'});}
  if(ms2.healthStatus==='struggling'){score-=15;needsCheckIn=true;checkInReason=checkInReason||'Self-reported struggling';factors.push({l:'Self-reported struggling',v:-15,t:'negative'});}
  if(ms2.runwayMonths&&ms2.runwayMonths<9){score-=12;needsCheckIn=true;factors.push({l:`${ms2.runwayMonths}mo runway`,v:-12,t:'negative'});}

  score=Math.max(0,Math.min(100,score));
  const seen2=new Set(); const deduped=factors.filter(f=>{if(seen2.has(f.l)) return false;seen2.add(f.l);return true;});
  const label=score>=80?'On Track':score>=62?'Steady':score>=42?'Investigate':'Critical';
  const color=score>=80?'#10b981':score>=62?'#F5DFA0':score>=42?'#f59e0b':'#ef4444';
  const bg=score>=80?'#f0fdf4':score>=62?'#FFFBEC':score>=42?'#fffbeb':'#fef2f2';
  return {score,label,color,bg,factors:deduped,needsCheckIn,checkInReason,mat,moic,method};
};

const calcPortHealth = (deals) => {
  const inv=deals.filter(d=>d.status==='invested');
  if(!inv.length) return {score:0,label:'No data',color:'#78716c'};
  const scores=inv.map(d=>calcHealth(d,[]));
  const total=inv.reduce((s,d)=>s+getCB(d.investment||{}),0);
  const ws=scores.reduce((s,h,i)=>{const w=total>0?getCB(inv[i].investment||{})/total:1/scores.length;return s+h.score*w;},0);
  const score=Math.round(ws);
  return {score,label:score>=80?'On Track':score>=62?'Steady':score>=42?'Investigate':'Critical',color:score>=80?'#10b981':score>=62?'#F5DFA0':score>=42?'#f59e0b':'#ef4444'};
};

// ── DEMO DATA ────────────────────────────────────────────────────────────────
const DEALS = [
  {id:'1',companyName:'Form Energy',status:'invested',stage:'series-e',industry:'Long-Duration Storage',website:'https://formenergy.com',overview:'Iron-air battery technology enabling multi-day energy storage at 1/10th the cost of lithium-ion.',founders:[{name:'Mateo Jaramillo',role:'CEO'},{name:'Yet-Ming Chiang',role:'Co-Founder'}],terms:{instrument:'Equity'},investment:{amount:25000,costBasis:25000,vehicle:'Equity',date:new Date(Date.now()-365*864e5).toISOString(),ownershipPercent:0.01,entryPostMoneyValuation:800000000,impliedValuation:1500000000,impliedValue:45000,lastValuationDate:new Date(Date.now()-90*864e5).toISOString(),valuationMethod:'last-round',trlAtInvestment:8,lastUpdateReceived:new Date(Date.now()-14*864e5).toISOString(),nextUpdateExpected:new Date(Date.now()+20*864e5).toISOString()},coInvestors:[{id:'a',name:'ArcelorMittal',fund:'XCarb',role:'lead'},{id:'b',name:'GIC',fund:'GIC',role:'co-investor'},{id:'c',name:'Bill Gates',fund:'Breakthrough Energy',role:'co-investor'}],liquidityEvents:[],monitoring:{healthStatus:'thriving',fundraisingStatus:'not-raising',runwayMonths:24},
    metricsToWatch:['GWh capacity installed','Cost per kWh','Utility offtake contracts'],
    metricsLog:{
      'GWh capacity installed':[{v:0,date:new Date(Date.now()-365*864e5).toISOString()},{v:0.5,date:new Date(Date.now()-180*864e5).toISOString()},{v:1.2,date:new Date(Date.now()-60*864e5).toISOString()}],
      'Cost per kWh':[{v:180,date:new Date(Date.now()-365*864e5).toISOString()},{v:155,date:new Date(Date.now()-180*864e5).toISOString()},{v:130,date:new Date(Date.now()-60*864e5).toISOString()}],
      'Utility offtake contracts':[{v:0,date:new Date(Date.now()-365*864e5).toISOString()},{v:1,date:new Date(Date.now()-180*864e5).toISOString()},{v:1,date:new Date(Date.now()-60*864e5).toISOString()}],
    },
    revenueLog:[{v:0,date:new Date(Date.now()-365*864e5).toISOString()},{v:1200000,date:new Date(Date.now()-180*864e5).toISOString()},{v:4800000,date:new Date(Date.now()-60*864e5).toISOString()}],healthHistory:[{date:new Date(Date.now()-300*864e5).toISOString(),score:72,label:'Steady'},{date:new Date(Date.now()-180*864e5).toISOString(),score:82,label:'On Track'},{date:new Date(Date.now()-60*864e5).toISOString(),score:80,label:'On Track'},{date:new Date(Date.now()-14*864e5).toISOString(),score:74,label:'Steady'}],milestones:[{id:'m1',type:'fundraising',title:'Series E — $450M',description:'Led by ArcelorMittal and GIC. Total raised over $1B.',date:new Date(Date.now()-300*864e5).toISOString()},{id:'m2',type:'partnership',title:'Georgia Power offtake',description:'First utility-scale deployment agreement.',date:new Date(Date.now()-180*864e5).toISOString()},{id:'m4',type:'update',title:'Founder update',description:'First battery systems rolling off the line. On track for utility delivery Q3.',date:new Date(Date.now()-14*864e5).toISOString()}]},
  {id:'2',companyName:'Exowatt',status:'invested',stage:'seed',industry:'AI Energy Infrastructure',website:'https://exowatt.com',overview:'Modular solar thermal energy storage for AI data centers. Firm, low-cost power without grid dependency.',founders:[{name:'Joey Kline',role:'CEO'}],terms:{instrument:'SAFE',cap:85000000,proRata:true},investment:{amount:10000,costBasis:10000,vehicle:'SAFE',date:new Date(Date.now()-200*864e5).toISOString(),ownershipPercent:0.02,entryPostMoneyValuation:85000000,impliedValuation:85000000,impliedValue:11800,lastValuationDate:new Date(Date.now()-190*864e5).toISOString(),valuationMethod:'safe-cap',trlAtInvestment:5,lastUpdateReceived:new Date(Date.now()-45*864e5).toISOString(),nextUpdateExpected:new Date(Date.now()-10*864e5).toISOString()},coInvestors:[{id:'a',name:'Marc Andreessen',fund:'a16z',role:'lead'},{id:'b',name:'Sam Altman',fund:'Personal',role:'co-investor'}],liquidityEvents:[],monitoring:{healthStatus:'stable',fundraisingStatus:'exploring',runwayMonths:18},
    metricsToWatch:['MW contracted','Data center pilots','Cost per MWh firm'],
    metricsLog:{
      'MW contracted':[{v:0,date:new Date(Date.now()-200*864e5).toISOString()},{v:5,date:new Date(Date.now()-100*864e5).toISOString()}],
      'Data center pilots':[{v:0,date:new Date(Date.now()-200*864e5).toISOString()},{v:1,date:new Date(Date.now()-100*864e5).toISOString()}],
      'Cost per MWh firm':[{v:95,date:new Date(Date.now()-200*864e5).toISOString()},{v:88,date:new Date(Date.now()-100*864e5).toISOString()}],
    },healthHistory:[{date:new Date(Date.now()-200*864e5).toISOString(),score:58,label:'Steady'},{date:new Date(Date.now()-100*864e5).toISOString(),score:60,label:'Steady'},{date:new Date(Date.now()-50*864e5).toISOString(),score:52,label:'Investigate'},{date:new Date(Date.now()-20*864e5).toISOString(),score:46,label:'Investigate'}],milestones:[{id:'m1',type:'fundraising',title:'Seed — $20M',description:'Led by a16z with Sam Altman.',date:new Date(Date.now()-190*864e5).toISOString()},{id:'m2',type:'partnership',title:'Meta pilot',description:'First hyperscaler agreement for off-grid AI compute.',date:new Date(Date.now()-100*864e5).toISOString()}]},
  {id:'3',companyName:'Ammobia',status:'invested',stage:'seed',industry:'Green Ammonia',website:'https://ammobia.com',overview:'Electrochemical green ammonia at the point of use. Eliminates Haber-Bosch — fertilizer from air, water, and renewables.',founders:[{name:'Travis Sherck',role:'CEO'}],terms:{instrument:'SAFE',cap:20000000,mfn:true},investment:{amount:10000,costBasis:10000,vehicle:'SAFE',date:new Date(Date.now()-150*864e5).toISOString(),ownershipPercent:0.05,entryPostMoneyValuation:20000000,impliedValuation:null,impliedValue:null,lastValuationDate:null,valuationMethod:'mark-at-cost',trlAtInvestment:3,lastUpdateReceived:new Date(Date.now()-30*864e5).toISOString(),nextUpdateExpected:new Date(Date.now()+45*864e5).toISOString()},coInvestors:[{id:'a',name:'Prelude Ventures',fund:'Prelude',role:'lead'}],liquidityEvents:[],monitoring:{healthStatus:'stable',fundraisingStatus:'not-raising',runwayMonths:20},
    metricsToWatch:['Energy efficiency (MWh/tonne NH3)','Pilot farm deployments','Cost vs conventional ($/tonne)'],
    metricsLog:{
      'Energy efficiency (MWh/tonne NH3)':[{v:11.2,date:new Date(Date.now()-150*864e5).toISOString()},{v:9.8,date:new Date(Date.now()-120*864e5).toISOString()},{v:8.5,date:new Date(Date.now()-30*864e5).toISOString()}],
      'Pilot farm deployments':[{v:0,date:new Date(Date.now()-150*864e5).toISOString()},{v:1,date:new Date(Date.now()-45*864e5).toISOString()}],
      'Cost vs conventional ($/tonne)':[{v:820,date:new Date(Date.now()-150*864e5).toISOString()},{v:710,date:new Date(Date.now()-30*864e5).toISOString()}],
    },healthHistory:[{date:new Date(Date.now()-150*864e5).toISOString(),score:55,label:'Steady'},{date:new Date(Date.now()-100*864e5).toISOString(),score:60,label:'Steady'},{date:new Date(Date.now()-20*864e5).toISOString(),score:65,label:'Steady'}],milestones:[{id:'m1',type:'product',title:'Bench-scale demo',description:'8.5 MWh/tonne NH3 at lab scale.',date:new Date(Date.now()-120*864e5).toISOString()},{id:'m3',type:'update',title:'Founder update',description:'Pilot running well. Yield 12% above projection. Starting conversations with two more co-ops.',date:new Date(Date.now()-30*864e5).toISOString()}]},
  {id:'4',companyName:'Rondo Energy',status:'watching',stage:'series-b',industry:'Industrial Heat',website:'https://rondoenergy.com',overview:'Electric thermal energy storage (ETES) that converts renewable electricity into industrial heat at 1500°C. Targets the 20% of global emissions from industrial processes that cannot be electrified directly.',founders:[{name:"John O'Donnell",role:'CEO',background:'Ex-Alphabet/Google X, energy storage pioneer'},{name:'John Sakamoto',role:'CTO',background:'Thermal systems engineering'}],terms:{},monitoring:{healthStatus:'stable',fundraisingStatus:'raising'},watchingNotes:"Strong team and real industrial demand. Watching Series B close — if IRA manufacturing credits get locked in for their heat blocks, the unit economics get dramatically better. Want to see one more named customer before committing.",decisionReasoning:"Strong team and real industrial demand. Technology is validated — the question is whether the sales cycle for industrial customers is fast enough to justify the current valuation. Woodside partnership is promising but one data point isn't enough. Watching the Series B investor quality closely.",revisitDate:new Date(Date.now()+30*864e5).toISOString(),investmentTriggers:["Second named industrial customer signs contract","IRA 48C credits confirmed applicable to heat blocks","Series B closes with a tier-1 climate fund leading"],convictionLog:[{date:new Date(Date.now()-60*864e5).toISOString(),level:'medium'},{date:new Date(Date.now()-30*864e5).toISOString(),level:'medium'},{date:new Date(Date.now()-5*864e5).toISOString(),level:'high'}],coInvestors:[{id:'ci1',name:'Microsoft',fund:'Microsoft Climate Innovation Fund',role:'strategic'},{id:'ci2',name:'Rio Tinto',fund:'Rio Tinto Ventures',role:'strategic'}],milestones:[{id:'m1',type:'fundraising',title:'Series B — raising $100M',description:'Microsoft and Rio Tinto as strategic investors. Round not yet closed.',date:new Date(Date.now()-30*864e5).toISOString()},{id:'m2',type:'partnership',title:'Woodside Energy partnership',description:'First industrial deployment at LNG facility — heat block system replacing gas burners',date:new Date(Date.now()-50*864e5).toISOString()},{id:'m3',type:'product',title:'First commercial heat block shipped',description:'Initial unit delivered to Woodside facility. Performance data expected in 90 days.',date:new Date(Date.now()-10*864e5).toISOString()}]},
];

// ── SMALL COMPONENTS ─────────────────────────────────────────────────────────
const TRLBadge = ({trl}) => {
  if (!trl) return null;
  const c=trl<=3?'#78716c':trl<=6?'#F5DFA0':trl<=8?'#f59e0b':'#10b981';
  const l=trl<=3?'Lab':trl<=6?'Pilot':trl<=8?'Scale':'Deploy';
  return <span style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:11,padding:'2px 8px',borderRadius:99,fontWeight:600,backgroundColor:c+'20',color:c}}><span style={{width:6,height:6,borderRadius:99,backgroundColor:c,display:'inline-block'}}/>TRL {trl} · {l}</span>;
};

const ROLE_CFG = {lead:{l:'Lead',c:'#5B6DC4',bg:'#FFFBEC'},'co-investor':{l:'Co-investor',c:'#10b981',bg:'#f0fdf4'},'follow-on':{l:'Follow-on',c:'#f59e0b',bg:'#fefce8'},strategic:{l:'Strategic',c:'#7c3aed',bg:'#f5f3ff'}};
const LIQ_TYPES = {exit:{l:'Exit / Acquisition',i:'🏆',c:'#10b981',bg:'#f0fdf4'},secondary:{l:'Secondary sale',i:'🔄',c:'#5B6DC4',bg:'#FFFBEC'},distribution:{l:'Distribution',i:'💸',c:'#f59e0b',bg:'#fefce8'},writedown:{l:'Write-down',i:'📉',c:'#ef4444',bg:'#fef2f2'}};

const Toast = ({msg,onClose}) => { useEffect(()=>{const t=setTimeout(onClose,2500);return()=>clearTimeout(t);},[onClose]); return <div style={{position:'fixed',bottom:80,left:'50%',transform:'translateX(-50%)',background:'#eef2ff',color:'#5B6DC4',border:'1px solid #c7d2fe',borderRadius:10,padding:'8px 16px',fontSize:13,fontWeight:500,zIndex:999}}>{msg}</div>; };

const Pill = ({children,color='#78716c',bg='#f5f5f4'}) => <span style={{fontSize:11,padding:'2px 8px',borderRadius:99,fontWeight:600,color,backgroundColor:bg}}>{children}</span>;

// Known logo URLs — direct from company CDNs or public sources
const KNOWN_LOGOS = {
  'formenergy.com': 'https://formenergy.com/wp-content/uploads/2021/09/FE-Logo-Black.png',
  'exowatt.com': 'https://exowatt.com/img/logo.svg',
  'ammobia.com': 'https://ammobia.com/assets/logo.svg',
  'rondoenergy.com': 'https://rondoenergy.com/wp-content/uploads/2022/09/rondo-logo.svg',
};

const CompanyLogo = ({name, website, size=44, radius=12, fallbackBg='#f3f4f6', fallbackColor='#6b7280'}) => {
  const [failed, setFailed] = useState(false);

  let src = null;
  if (website && !failed) {
    try {
      const domain = new URL(website).hostname.replace('www.', '');
      src = KNOWN_LOGOS[domain] || `https://logo.clearbit.com/${domain}`;
    } catch {}
  }

  if (src && !failed) return (
    <div style={{width:size,height:size,borderRadius:radius,overflow:'hidden',flexShrink:0,background:'white',border:'1px solid #f3f4f6',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <img src={src} onError={()=>setFailed(true)} alt={name}
        style={{width:'80%',height:'80%',objectFit:'contain'}}/>
    </div>
  );
  return (
    <div style={{width:size,height:size,borderRadius:radius,background:fallbackBg,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:size*0.4,color:fallbackColor,flexShrink:0}}>
      {name?.[0]?.toUpperCase()}
    </div>
  );
};

const MetricsTracker = ({deal, onUpdate}) => {
  const metrics = deal.metricsToWatch || [];
  const log = deal.metricsLog || {};
  const revenue = deal.revenueLog || [];
  const [active, setActive] = useState(null);
  const [inputVal, setInputVal] = useState('');
  const [inputDate, setInputDate] = useState(new Date().toISOString().slice(0,10));

  const logEntry = (key, isRevenue=false) => {
    if (!inputVal || isNaN(Number(inputVal))) return;
    const entry = { v: Number(inputVal), date: new Date(inputDate).toISOString() };
    const updated = isRevenue
      ? { ...deal, revenueLog: [...revenue, entry].sort((a,b)=>new Date(a.date)-new Date(b.date)) }
      : { ...deal, metricsLog: { ...log, [key]: [...(log[key]||[]), entry].sort((a,b)=>new Date(a.date)-new Date(b.date)) }};
    onUpdate(updated);
    setActive(null); setInputVal(''); setInputDate(new Date().toISOString().slice(0,10));
  };

  const MiniLine = ({ readings, color='#5B6DC4', wide=false }) => {
    if (!readings || readings.length < 2) return <span style={{fontSize:11,color:'#d1d5db'}}>no readings yet</span>;
    const W=wide?200:80, H=wide?44:28, P=3;
    const vals = readings.map(r=>r.v);
    const mn=Math.min(...vals), mx=Math.max(...vals), rng=mx-mn||1;
    const pts = readings.map((r,i)=>[P+(i/(readings.length-1))*(W-P*2), P+((mx-r.v)/rng)*(H-P*2)]);
    const poly = pts.map(([x,y])=>`${x},${y}`).join(' ');
    const area = wide ? `M${pts[0][0]},${H} `+pts.map(([x,y])=>`L${x},${y}`).join(' ')+` L${pts[pts.length-1][0]},${H} Z` : null;
    const latest = readings[readings.length-1];
    const prev = readings[readings.length-2];
    const dir = latest.v > prev.v ? '↑' : latest.v < prev.v ? '↓' : '→';
    const dirColor = latest.v > prev.v ? '#10b981' : latest.v < prev.v ? '#ef4444' : '#9ca3af';
    return (
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {area&&<defs><linearGradient id={`rg${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".15"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs>}
          {area&&<path d={area} fill={`url(#rg${color.replace('#','')})`}/>}
          <polyline points={poly} fill="none" stroke={color} strokeWidth={wide?"2":"1.5"} strokeLinejoin="round" strokeLinecap="round"/>
          <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r={wide?"3":"2.5"} fill={color}/>
        </svg>
        <div>
          <div style={{display:'flex',alignItems:'baseline',gap:4}}>
            <span style={{fontSize:wide?16:13,fontWeight:700,color:'#111827'}}>{wide?fmtC(latest.v):latest.v.toLocaleString()}</span>
            <span style={{fontSize:wide?14:13,fontWeight:600,color:dirColor}}>{dir}</span>
          </div>
          {wide&&<p style={{fontSize:11,color:'#9ca3af',marginTop:1}}>{readings.length} readings · last {dAgo(latest.date)}d ago</p>}
        </div>
      </div>
    );
  };

  const hasRevenue = revenue.length > 0;
  const isLoggingRevenue = active === '__revenue__';

  return (
    <div style={{background:'white',borderRadius:16,padding:20,marginBottom:12}}>
      {/* Revenue — primary, always shown */}
      <div style={{marginBottom:metrics.length?16:0}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:hasRevenue?10:6}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Revenue</span>
            {!hasRevenue&&<span style={{fontSize:11,color:'#9ca3af'}}>— log when available</span>}
          </div>
          {!isLoggingRevenue&&<button onClick={()=>{setActive('__revenue__');setInputVal('');}} style={{fontSize:12,color:'#5B6DC4',background:'none',border:'none',cursor:'pointer',padding:0}}>+ Log</button>}
        </div>
        {isLoggingRevenue?(
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            <input type="number" value={inputVal} onChange={e=>setInputVal(e.target.value)} placeholder="Revenue ($)" autoFocus style={{width:110,padding:'6px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,outline:'none'}}/>
            <input type="date" value={inputDate} onChange={e=>setInputDate(e.target.value)} style={{padding:'6px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,outline:'none'}}/>
            <button onClick={()=>logEntry('__revenue__',true)} disabled={!inputVal||isNaN(Number(inputVal))} style={{padding:'6px 14px',background:'#10b981',color:'white',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',opacity:inputVal?1:.5}}>Save</button>
            <button onClick={()=>setActive(null)} style={{padding:'6px 10px',background:'none',border:'none',color:'#9ca3af',fontSize:13,cursor:'pointer'}}>Cancel</button>
          </div>
        ):hasRevenue?(
          <MiniLine readings={revenue} color="#10b981" wide={true}/>
        ):(
          <p style={{fontSize:12,color:'#d1d5db',fontStyle:'italic'}}>No revenue logged yet — add a reading once the company starts generating revenue</p>
        )}
      </div>

      {/* Traction metrics — pre-revenue proxies */}
      {metrics.length>0&&<div style={{borderTop:'1px solid #f3f4f6',paddingTop:14}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          <span style={{fontSize:12,fontWeight:600,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6}}>Traction metrics</span>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:0}}>
          {metrics.map((metric, i) => {
            const readings = log[metric] || [];
            const isLogging = active === metric;
            return (
              <div key={metric} style={{paddingTop:i===0?0:12,marginTop:i===0?0:12,borderTop:i===0?'none':'1px solid #f9fafb'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{fontSize:13,color:'#374151',fontWeight:500,flex:1,minWidth:0,marginRight:12}}>{metric}</span>
                  {!isLogging&&<button onClick={()=>{setActive(metric);setInputVal('');}} style={{fontSize:12,color:'#5B6DC4',background:'none',border:'none',cursor:'pointer',padding:0,flexShrink:0}}>+ Log</button>}
                </div>
                {isLogging?(
                  <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <input type="number" value={inputVal} onChange={e=>setInputVal(e.target.value)} placeholder="Value" autoFocus style={{width:90,padding:'6px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,outline:'none'}}/>
                    <input type="date" value={inputDate} onChange={e=>setInputDate(e.target.value)} style={{padding:'6px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,outline:'none'}}/>
                    <button onClick={()=>logEntry(metric,false)} disabled={!inputVal||isNaN(Number(inputVal))} style={{padding:'6px 14px',background:'#5B6DC4',color:'white',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',opacity:inputVal?1:.5}}>Save</button>
                    <button onClick={()=>setActive(null)} style={{padding:'6px 10px',background:'none',border:'none',color:'#9ca3af',fontSize:13,cursor:'pointer'}}>Cancel</button>
                  </div>
                ):readings.length===0?(
                  <p style={{fontSize:12,color:'#d1d5db',fontStyle:'italic'}}>No readings yet</p>
                ):(
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                    <MiniLine readings={readings} color={['#5B6DC4','#f59e0b','#7c3aed'][i%3]}/>
                    <span style={{fontSize:11,color:'#9ca3af'}}>{readings.length} reading{readings.length!==1?'s':''} · {dAgo(readings[readings.length-1].date)}d ago</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>}
    </div>
  );
};

// ── SECTIONS ─────────────────────────────────────────────────────────────────
const CoInvestorsSection = ({deal,onUpdate,setToast}) => {
  const [open,setOpen]=useState(true);
  const [adding,setAdding]=useState(false);
  const [form,setForm]=useState({name:'',fund:'',role:'co-investor',checkSize:''});
  const list=deal.coInvestors||[];
  const add=()=>{if(!form.name.trim())return;const e={id:genId(),name:form.name.trim(),fund:form.fund.trim()||null,role:form.role,checkSize:form.checkSize?Number(form.checkSize):null};onUpdate({...deal,coInvestors:[...list,e]});setForm({name:'',fund:'',role:'co-investor',checkSize:''});setAdding(false);setToast('Investor added');};
  const remove=(id)=>onUpdate({...deal,coInvestors:list.filter(c=>c.id!==id)});
  return (
    <div style={{background:'white',borderRadius:16,overflow:'hidden'}}>
      <button onClick={()=>setOpen(v=>!v)} style={{width:'100%',padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'none',border:'none',cursor:'pointer'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span style={{fontWeight:500,fontSize:14,color:'#374151'}}>Investors</span>
          {list.length>0&&<span style={{fontSize:12,color:'#9ca3af'}}>({list.length})</span>}
        </div>
        <span style={{color:'#9ca3af',fontSize:12}}>{open?'▲':'▼'}</span>
      </button>
      {open&&<div style={{padding:'0 20px 20px',borderTop:'1px solid #f3f4f6'}}>
        {list.length===0&&!adding&&<p style={{fontSize:13,color:'#9ca3af',textAlign:'center',padding:'8px 0'}}>No investors logged yet</p>}
        {list.map(ci=>{const rc=ROLE_CFG[ci.role]||ROLE_CFG['co-investor'];return(
          <div key={ci.id} style={{display:'flex',alignItems:'center',gap:12,paddingTop:12}}>
            <div style={{width:32,height:32,borderRadius:99,background:rc.c+'20',color:rc.c,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:13,flexShrink:0}}>{ci.name[0].toUpperCase()}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
                <span style={{fontWeight:500,fontSize:13,color:'#1f2937'}}>{ci.name}</span>
                {ci.fund&&ci.fund!==ci.name&&<span style={{fontSize:12,color:'#9ca3af'}}>· {ci.fund}</span>}
                <Pill color={rc.c} bg={rc.bg}>{rc.l}</Pill>
                {ci.checkSize&&<span style={{fontSize:12,color:'#9ca3af'}}>{fmtC(ci.checkSize)}</span>}
              </div>
            </div>
            <button onClick={()=>remove(ci.id)} style={{color:'#d1d5db',background:'none',border:'none',cursor:'pointer',padding:4}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
        );})}
        {adding?<div style={{paddingTop:12,borderTop:list.length?'1px solid #f3f4f6':'none',marginTop:list.length?8:0}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <input placeholder="Investor name *" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} style={{padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}/>
            <input placeholder="Fund / firm" value={form.fund} onChange={e=>setForm(f=>({...f,fund:e.target.value}))} style={{padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}/>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <select value={form.role} onChange={e=>setForm(f=>({...f,role:e.target.value}))} style={{padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}>
              <option value="lead">Lead</option><option value="co-investor">Co-investor</option><option value="follow-on">Follow-on</option><option value="strategic">Strategic</option>
            </select>
            <input placeholder="Check size ($)" type="number" value={form.checkSize} onChange={e=>setForm(f=>({...f,checkSize:e.target.value}))} style={{padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}/>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={add} disabled={!form.name.trim()} style={{flex:1,padding:'8px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',opacity:form.name.trim()?1:.5}}>Add investor</button>
            <button onClick={()=>setAdding(false)} style={{padding:'8px 14px',background:'none',border:'none',color:'#6b7280',fontSize:13,cursor:'pointer'}}>Cancel</button>
          </div>
        </div>:<button onClick={()=>setAdding(true)} style={{marginTop:10,background:'none',border:'none',color:'#5B6DC4',fontSize:13,cursor:'pointer',padding:0}}>+ Add investor</button>}
      </div>}
    </div>
  );
};

const LiquiditySection = ({deal,onUpdate,setToast}) => {
  const [open,setOpen]=useState(false);
  const [adding,setAdding]=useState(false);
  const [form,setForm]=useState({type:'exit',date:'',amount:'',notes:''});
  const events=deal.liquidityEvents||[];
  const realized=events.filter(e=>e.type!=='writedown').reduce((s,e)=>s+(e.proceeds||0),0);
  const cb=getCB(deal.investment||{});
  const dpi=cb>0?realized/cb:0;
  const add=()=>{if(!form.amount||!form.date)return;const e={id:genId(),type:form.type,date:form.date,proceeds:form.type==='writedown'?0:Number(form.amount),writedownAmount:form.type==='writedown'?Number(form.amount):0,notes:form.notes||null};onUpdate({...deal,liquidityEvents:[...events,e]});setForm({type:'exit',date:'',amount:'',notes:''});setAdding(false);setToast(`${LIQ_TYPES[form.type].l} logged`);};
  return (
    <div style={{background:'white',borderRadius:16,overflow:'hidden'}}>
      <button onClick={()=>setOpen(v=>!v)} style={{width:'100%',padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'none',border:'none',cursor:'pointer'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="16 12 12 8 8 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>
          <span style={{fontWeight:500,fontSize:14,color:'#374151'}}>Liquidity events</span>
          {events.length>0&&<Pill color="#10b981" bg="#f0fdf4">{fmtC(realized)} realized · {dpi.toFixed(2)}x DPI</Pill>}
        </div>
        <span style={{color:'#9ca3af',fontSize:12}}>{open?'▲':'▼'}</span>
      </button>
      {open&&<div style={{padding:'0 20px 20px',borderTop:'1px solid #f3f4f6'}}>
        {events.length===0&&!adding&&<p style={{fontSize:13,color:'#9ca3af',textAlign:'center',padding:'8px 0'}}>No liquidity events yet</p>}
        {events.map(ev=>{const c=LIQ_TYPES[ev.type];const amt=ev.type==='writedown'?ev.writedownAmount:ev.proceeds;return(
          <div key={ev.id} style={{display:'flex',gap:12,padding:12,borderRadius:12,marginTop:8,backgroundColor:c.bg}}>
            <span style={{fontSize:18}}>{c.i}</span>
            <div>
              <div style={{display:'flex',alignItems:'center',gap:8}}><span style={{fontWeight:600,fontSize:13,color:c.c}}>{c.l}</span><span style={{fontSize:12,color:'#9ca3af'}}>{new Date(ev.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span></div>
              <p style={{fontWeight:700,fontSize:14,color:c.c,marginTop:2}}>{ev.type==='writedown'?`−${fmtC(amt)}`:`+${fmtC(amt)}`}</p>
              {ev.notes&&<p style={{fontSize:12,color:'#6b7280',marginTop:4}}>{ev.notes}</p>}
            </div>
          </div>
        );})}
        {adding?<div style={{paddingTop:12,marginTop:8,borderTop:'1px solid #f3f4f6'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} style={{padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}>
              {Object.entries(LIQ_TYPES).map(([k,v])=><option key={k} value={k}>{v.l}</option>)}
            </select>
            <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={{padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}/>
          </div>
          <input placeholder={form.type==='writedown'?'Amount written down ($)':'Proceeds ($)'} type="number" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} style={{width:'100%',padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,marginBottom:8,boxSizing:'border-box'}}/>
          <input placeholder="Notes (optional)" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} style={{width:'100%',padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,marginBottom:8,boxSizing:'border-box'}}/>
          <div style={{display:'flex',gap:8}}>
            <button onClick={add} disabled={!form.amount||!form.date} style={{flex:1,padding:'8px',background:'#10b981',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',opacity:form.amount&&form.date?1:.5}}>Log event</button>
            <button onClick={()=>setAdding(false)} style={{padding:'8px 14px',background:'none',border:'none',color:'#6b7280',fontSize:13,cursor:'pointer'}}>Cancel</button>
          </div>
        </div>:<button onClick={()=>setAdding(true)} style={{marginTop:10,background:'none',border:'none',color:'#5B6DC4',fontSize:13,cursor:'pointer',padding:0}}>+ Log liquidity event</button>}
      </div>}
    </div>
  );
};

// ── DETAIL VIEW ───────────────────────────────────────────────────────────────
const DetailView = ({deal,onUpdate,setToast}) => {
  const inv=deal.investment||{};
  const method=getMethod(deal);
  const iv=calcIV(deal);
  const moic=calcMOIC(deal);
  const markup=calcMarkup(deal);
  const health=calcHealth(deal,[]);
  const staleness=getStaleness(deal);
  const [note,setNote]=useState('');
  const [showLog,setShowLog]=useState(false);
  const [showInvDetails,setShowInvDetails]=useState(false);
  const updateEntries=(deal.milestones||[]).filter(m=>m.type==='update').sort((a,b)=>new Date(b.date)-new Date(a.date));
  const dSinceUpd=inv.lastUpdateReceived?dAgo(inv.lastUpdateReceived):null;
  const dUntilNext=inv.nextUpdateExpected?dUntil(inv.nextUpdateExpected):null;
  const overdue=dUntilNext!==null&&dUntilNext<-7;

  const logUpdate=()=>{
    if(note.trim().length<5)return;
    const now=new Date().toISOString();
    const sigs=parseNote(note.trim(),now);
    const updated={...deal,milestones:[...(deal.milestones||[]),{id:`u-${Date.now()}`,type:'update',title:'Investor note',description:note.trim(),date:now}],investment:{...inv,lastUpdateReceived:now}};
    onUpdate(updated);setNote('');setShowLog(true);setToast(sigs.length?`Update logged · ${sigs.length} signal${sigs.length>1?'s':''} extracted`:'Update logged');
  };

  const C = {
    card:{background:'white',borderRadius:16,padding:20,marginBottom:12},
    label:{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.8,marginBottom:4},
    val:{fontSize:16,fontWeight:700,color:'#111827'},
    sm:{fontSize:13,color:'#374151'},
  };

  if(deal.status==='watching') {
    const daysUntilRevisit = deal.revisitDate ? dUntil(deal.revisitDate) : null;
    const revisitOverdue = daysUntilRevisit !== null && daysUntilRevisit < 0;
    const signals = (deal.milestones||[]).filter(m => ['fundraising','partnership','product'].includes(m.type));
    const convictionLog = deal.convictionLog || [];
    const curConviction = convictionLog[convictionLog.length-1];
    const CONV_LEVELS = [
      {v:'low',  l:'Low',    c:'#78716c',bg:'#f5f5f4'},
      {v:'medium',l:'Medium',c:'#5B6DC4',bg:'#FFFBEC'},
      {v:'high', l:'High',   c:'#10b981',bg:'#f0fdf4'},
    ];

    return (
      <div style={{padding:20}}>
        {/* Header */}
        <div style={C.card}>
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:12}}>
            <div style={{flex:1}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                <h2 style={{fontSize:20,fontWeight:800,color:'#111827'}}>{deal.companyName}</h2>
                {deal.website&&<a href={deal.website} target="_blank" rel="noopener noreferrer" style={{color:'#9ca3af'}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>}
              </div>
              <p style={{fontSize:13,color:'#6b7280',marginBottom:4}}>{deal.stage} · {deal.industry}</p>
              {deal.monitoring?.fundraisingStatus==='raising'&&<Pill color="#1d4ed8" bg="#eff6ff">Raising now</Pill>}
            </div>
            {deal.monitoring?.fundraisingStatus==='raising'&&<Pill color="#1d4ed8" bg="#eff6ff">Raising now</Pill>}
          </div>
          {deal.overview&&<p style={{fontSize:14,color:'#374151',lineHeight:1.6,marginBottom:deal.founders?.length?12:0}}>{deal.overview}</p>}
          {deal.founders?.length>0&&<div style={{display:'flex',alignItems:'center',gap:8,paddingTop:12,borderTop:'1px solid #f3f4f6'}}>
            <span style={{fontSize:13,color:'#6b7280'}}>Founders:</span>
            {deal.founders.map((f,i)=><span key={i} style={{fontSize:13,color:'#374151',fontWeight:500}}>{f.name} <span style={{fontWeight:400,color:'#9ca3af'}}>({f.role})</span></span>)}
          </div>}
        </div>

        {/* Revisit banner */}
        {revisitOverdue && (
          <div style={{padding:'10px 16px',background:'#fffbeb',border:'1px solid #fde68a',borderRadius:12,display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <p style={{fontSize:13,color:'#92400e',fontWeight:500}}>Revisit date was {Math.abs(daysUntilRevisit)}d ago — time to update your view.</p>
          </div>
        )}
        {daysUntilRevisit !== null && !revisitOverdue && daysUntilRevisit <= 14 && (
          <div style={{padding:'10px 16px',background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:12,display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <p style={{fontSize:13,color:'#166534'}}>Revisit scheduled in {daysUntilRevisit} day{daysUntilRevisit!==1?'s':''}</p>
          </div>
        )}

        {/* Decision log */}
        <div style={C.card}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Decision log</span>
            {deal.revisitDate&&<span style={{fontSize:12,color:'#9ca3af',marginLeft:'auto'}}>Revisit {new Date(deal.revisitDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>}
          </div>
          {deal.decisionReasoning&&<div style={{marginBottom:14}}>
            <p style={{...C.label,marginBottom:6}}>Why you're watching</p>
            <p style={{fontSize:13,color:'#374151',lineHeight:1.6}}>{deal.decisionReasoning}</p>
          </div>}
          {deal.investmentTriggers?.filter(t=>t).length>0&&<div>
            <p style={{...C.label,marginBottom:8}}>What would move you to invest</p>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {deal.investmentTriggers.filter(t=>t).map((trigger,i)=>{
                // Check if any milestone/signal could relate to this trigger
                const tl = trigger.toLowerCase();
                const matched = signals.some(s=>{
                  const txt=(s.title+' '+s.description).toLowerCase();
                  return tl.split(' ').filter(w=>w.length>4).some(w=>txt.includes(w));
                });
                return (
                  <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'8px 12px',borderRadius:10,background:matched?'#f0fdf4':'#f9fafb',border:`1px solid ${matched?'#bbf7d0':'#f3f4f6'}`}}>
                    <span style={{width:6,height:6,borderRadius:99,background:matched?'#10b981':'#d1d5db',marginTop:4,flexShrink:0,display:'inline-block'}}/>
                    <span style={{fontSize:13,color:matched?'#166534':'#374151',flex:1}}>{trigger}</span>
                    {matched&&<span style={{fontSize:11,fontWeight:600,color:'#16a34a',flexShrink:0}}>Signal detected ↑</span>}
                  </div>
                );
              })}
            </div>
          </div>}
        </div>

        {/* Conviction */}
        <div style={C.card}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Conviction</span>
            </div>
            {curConviction&&<span style={{fontSize:12,color:'#9ca3af'}}>updated {dAgo(curConviction.date)}d ago</span>}
          </div>
          <div style={{display:'flex',gap:8}}>
            {CONV_LEVELS.map(lv=>(
              <button key={lv.v} onClick={()=>{const e={date:new Date().toISOString(),level:lv.v};onUpdate({...deal,convictionLog:[...convictionLog,e].slice(-12)});}} style={{flex:1,padding:'8px 0',borderRadius:12,fontSize:13,fontWeight:600,cursor:'pointer',border:`2px solid ${curConviction?.level===lv.v?lv.c:'transparent'}`,background:curConviction?.level===lv.v?lv.c:'#f9fafb',color:curConviction?.level===lv.v?'white':lv.c}}>{lv.l}</button>
            ))}
          </div>
        </div>

        {/* Latest signals from milestones */}
        {signals.length>0&&<div style={C.card}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Recent signals</span>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {signals.slice(0,4).map((s,i)=>{
              const typeColor={fundraising:'#F5DFA0',partnership:'#10b981',product:'#f59e0b'}[s.type]||'#78716c';
              const typeBg={fundraising:'#FFFBEC',partnership:'#f0fdf4',product:'#fffbeb'}[s.type]||'#f5f5f4';
              return <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'10px 12px',borderRadius:12,background:typeBg}}>
                <div style={{width:6,height:6,borderRadius:99,background:typeColor,marginTop:5,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <p style={{fontSize:13,fontWeight:500,color:'#111827',marginBottom:2}}>{s.title}</p>
                  <p style={{fontSize:12,color:'#6b7280'}}>{s.description}</p>
                  <p style={{fontSize:11,color:'#9ca3af',marginTop:4}}>{dAgo(s.date)}d ago</p>
                </div>
              </div>;
            })}
          </div>
        </div>}

        {/* Known co-investors (deal flow intelligence) */}
        {(deal.coInvestors||[]).length>0&&<div style={C.card}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Known investors</span>
            <span style={{fontSize:12,color:'#9ca3af'}}>in this deal</span>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {deal.coInvestors.map(ci=>{const rc=ROLE_CFG[ci.role]||ROLE_CFG['co-investor'];return(
              <div key={ci.id} style={{display:'flex',alignItems:'center',gap:10}}>
                <div style={{width:30,height:30,borderRadius:99,background:rc.c+'20',color:rc.c,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:12,flexShrink:0}}>{ci.name[0]}</div>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span style={{fontWeight:500,fontSize:13,color:'#111827'}}>{ci.name}</span>
                    {ci.fund&&ci.fund!==ci.name&&<span style={{fontSize:12,color:'#9ca3af'}}>· {ci.fund}</span>}
                    <Pill color={rc.c} bg={rc.c+'15'}>{rc.l}</Pill>
                  </div>
                </div>
              </div>
            );})}
          </div>
        </div>}

      </div>
    );
  }

  return (
    <div style={{padding:20}}>
      <div style={C.card}>
        <div style={{display:'flex',alignItems:'flex-start',gap:14,marginBottom:deal.overview?12:0}}>
          <CompanyLogo name={deal.companyName} website={deal.website} size={52} radius={14} fallbackBg="#10b981" fallbackColor="white"/>
          <div style={{flex:1}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
              <h2 style={{fontSize:20,fontWeight:800,color:'#111827'}}>{deal.companyName}</h2>
              {deal.website&&<a href={deal.website} target="_blank" rel="noopener noreferrer" style={{color:'#9ca3af'}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>}
            </div>
            <p style={{fontSize:13,color:'#6b7280',marginBottom:inv.trlAtInvestment&&['lab','pilot','scale'].includes(health.mat)?6:0}}>{deal.stage} · {deal.industry}</p>
            {inv.trlAtInvestment&&['lab','pilot','scale'].includes(health.mat)&&<div style={{display:'flex',alignItems:'center',gap:6}}><TRLBadge trl={inv.trlAtInvestment}/><span style={{fontSize:11,color:'#9ca3af'}}>at investment</span></div>}
          </div>
        </div>
        {deal.overview&&<p style={{fontSize:14,color:'#374151',lineHeight:1.6}}>{deal.overview}</p>}
        {deal.founders?.length>0&&<div style={{display:'flex',alignItems:'center',gap:8,marginTop:12,paddingTop:12,borderTop:'1px solid #f3f4f6'}}>
          <span style={{fontSize:13,color:'#6b7280'}}>Founders:</span>
          {deal.founders.map((f,i)=><span key={i} style={{fontSize:13,color:'#374151',fontWeight:500}}>{f.name} <span style={{fontWeight:400,color:'#9ca3af'}}>({f.role})</span></span>)}
        </div>}
      </div>

      <div style={C.card}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg><span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Valuation</span></div>
          <Pill>{getMethodLabel(method)}</Pill>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:12,marginBottom:12}}>
          <div><p style={C.label}>Cost basis</p><p style={C.val}>{fmtC(getCB(inv))}</p></div>
          <div><p style={C.label}>Implied value</p>{method==='mark-at-cost'?<p style={{...C.val,color:'#9ca3af'}}>—</p>:<p style={{...C.val,color:iv>=getCB(inv)?'#10b981':'#ef4444'}}>{fmtC(iv)}</p>}</div>
          <div><p style={C.label}>MOIC</p>{method==='mark-at-cost'?<p style={{...C.val,color:'#9ca3af'}}>1.0x</p>:moic?<p style={{...C.val,color:moic>=1.5?'#10b981':moic>=1?'#F5DFA0':'#ef4444'}}>{moic.toFixed(2)}x</p>:<p style={{...C.val,color:'#9ca3af'}}>—</p>}</div>
          <div><p style={C.label}>{inv.vehicle==='SAFE'?'Cap markup':'Val. markup'}</p>{markup?<p style={{...C.val,color:markup>=3?'#10b981':markup>=1.5?'#F5DFA0':'#f59e0b'}}>{markup.toFixed(1)}x</p>:<p style={{...C.val,color:'#9ca3af'}}>—</p>}</div>
        </div>
        {method==='mark-at-cost'&&<div style={{marginTop:10,paddingTop:10,borderTop:'1px solid #f3f4f6'}}>
          <p style={{fontSize:12,color:'#9ca3af',fontStyle:'italic',marginBottom:8}}>{health.mat==='lab'?'Lab/bench stage — marked at cost. MOIC not meaningful pre-demonstration.':'Pilot stage — marked at cost until next priced round.'}</p>
          {inv.vehicle==='SAFE'&&deal.terms?.cap&&(()=>{const pct=deal.terms.cap>0?((getCB(inv)/(deal.terms.cap+getCB(inv)))*100):null;return <div style={{background:'#f9fafb',borderRadius:12,padding:'10px 14px'}}><p style={{fontSize:13,color:'#374151'}}>At your <strong>{fmtC(deal.terms.cap)}</strong> cap, you'd own approximately <strong style={{color:'#5B6DC4'}}>~{pct?.toFixed(2)}%</strong> on conversion.{deal.terms.mfn&&<span style={{color:'#6b7280'}}> · MFN</span>}</p><p style={{fontSize:11,color:'#9ca3af',marginTop:4}}>Pre-dilution from option pool.</p></div>;})()}
        </div>}
        {method!=='mark-at-cost'&&inv.lastValuationDate&&<div style={{display:'flex',alignItems:'center',gap:6,marginTop:10}}><span style={{width:6,height:6,borderRadius:99,background:STALE_COL[staleness],display:'inline-block'}}/><p style={{fontSize:12,color:STALE_COL[staleness]}}>Mark from {new Date(inv.lastValuationDate).toLocaleDateString('en-US',{month:'short',year:'numeric'})}{staleness==='stale'?' — consider refreshing':staleness==='very-stale'?' — mark is outdated':''}</p></div>}
      </div>

      <MetricsTracker deal={deal} onUpdate={onUpdate}/>

      <div style={{background:'white',borderRadius:16,overflow:'hidden',marginBottom:12}}>
        <button onClick={()=>setShowInvDetails(v=>!v)} style={{width:'100%',padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'none',border:'none',cursor:'pointer'}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="18"/><path d="M15 9.5c0-1.5-1.5-2.5-3-2.5s-3 .5-3 2.5c0 1.5 1.5 2 3 2.5s3 1 3 2.5c0 1.5-1.5 2.5-3 2.5s-3-1-3-2.5"/></svg>
            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Investment details</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            {!showInvDetails&&<span style={{fontSize:12,color:'#9ca3af'}}>{[inv.amount&&fmtC(inv.amount),inv.vehicle,inv.date&&new Date(inv.date).toLocaleDateString('en-US',{month:'short',year:'numeric'})].filter(Boolean).join(' · ')}</span>}
            <span style={{color:'#9ca3af',fontSize:11}}>{showInvDetails?'▲':'▼'}</span>
          </div>
        </button>
        {showInvDetails&&<div style={{padding:'0 20px 20px',borderTop:'1px solid #f3f4f6'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,paddingTop:16}}>
            {inv.amount&&<div><p style={C.label}>Amount in</p><p style={C.val}>{fmtC(inv.amount)}</p></div>}
            {inv.vehicle&&<div><p style={C.label}>Vehicle</p><p style={{...C.sm,fontWeight:600}}>{inv.vehicle}</p></div>}
            {inv.ownershipPercent&&<div><p style={C.label}>Ownership</p><p style={{...C.sm,fontWeight:600}}>{inv.ownershipPercent}%</p></div>}
            {inv.date&&<div><p style={C.label}>Date</p><p style={{...C.sm,fontWeight:600}}>{new Date(inv.date).toLocaleDateString('en-US',{month:'short',year:'numeric'})}</p></div>}
            {inv.entryPostMoneyValuation&&<div><p style={C.label}>Entry post-money</p><p style={{...C.sm,fontWeight:600}}>{fmtC(inv.entryPostMoneyValuation)}</p></div>}
          </div>
        </div>}
      </div>

      <div style={{background:'white',borderRadius:16,overflow:'hidden',marginBottom:12}}>
        {overdue&&<div style={{padding:'10px 20px',background:'#fffbeb',borderBottom:'1px solid #fde68a',display:'flex',gap:8,alignItems:'center'}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><p style={{fontSize:13,color:'#92400e'}}>Update overdue by {Math.abs(dUntilNext)} days</p></div>}
        <button onClick={()=>setShowLog(v=>!v)} style={{width:'100%',padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'none',border:'none',cursor:'pointer'}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span style={{fontSize:14,fontWeight:500,color:'#374151'}}>Update log</span>
            {updateEntries.length>0&&<span style={{fontSize:12,color:'#9ca3af'}}>({updateEntries.length})</span>}
            {dSinceUpd!==null&&<Pill color={overdue?'#b45309':'#6b7280'} bg={overdue?'#fef3c7':'#f5f5f4'}>Last {dSinceUpd}d ago</Pill>}
          </div>
          <span style={{color:'#9ca3af',fontSize:12}}>{showLog?'▲':'▼'}</span>
        </button>
        {showLog&&<div style={{padding:'0 20px 20px',borderTop:'1px solid #f3f4f6'}}>
          {updateEntries.length===0&&<p style={{fontSize:13,color:'#9ca3af',textAlign:'center',padding:'8px 0'}}>No updates logged yet</p>}
          {updateEntries.map(e=>{const s=parseNote(e.description,e.date);const neg=s.some(x=>x.sentiment==='negative');const pos=s.some(x=>x.sentiment==='positive');return <div key={e.id} style={{display:'flex',gap:12,paddingTop:12}}>
            <span style={{width:6,height:6,borderRadius:99,background:neg?'#f59e0b':pos?'#10b981':'#d1d5db',marginTop:6,flexShrink:0,display:'inline-block'}}/>
            <div><p style={{fontSize:13,color:'#374151'}}>{e.description}</p><p style={{fontSize:11,color:'#9ca3af',marginTop:4}}>{new Date(e.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}{s.length>0&&<span style={{marginLeft:8,color:neg?'#b45309':'#065f46',fontWeight:600}}>{s.length} signal{s.length>1?'s':''}</span>}</p></div>
          </div>;})}
          <div style={{marginTop:12}}>
            <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Paste a founder email or write what you observed..." rows={3} style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:12,fontSize:13,resize:'none',outline:'none',boxSizing:'border-box',fontFamily:'inherit'}}/>
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <button onClick={logUpdate} disabled={note.trim().length<5} style={{flex:1,padding:'8px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',opacity:note.trim().length>=5?1:.5}}>Log update</button>
            </div>
          </div>
        </div>}
      </div>

      <CoInvestorsSection deal={deal} onUpdate={onUpdate} setToast={setToast}/>
      <div style={{marginTop:12}}><LiquiditySection deal={deal} onUpdate={onUpdate} setToast={setToast}/></div>
    </div>
  );
};

// ── DEAL CARDS ────────────────────────────────────────────────────────────────
const InvestedCard = ({deal,onClick}) => {
  const health=calcHealth(deal,[]);
  const moic=calcMOIC(deal);
  const method=getMethod(deal);
  const trl={'lab':'TRL 1–3','pilot':'TRL 4–6','scale':'TRL 7–8'}[health.mat]||null;
  return (
    <div onClick={onClick} style={{background:'white',borderRadius:16,border:`1px solid ${health.needsCheckIn?'#fde68a':'#e5e7eb'}`,cursor:'pointer',overflow:'hidden'}}>
      {health.needsCheckIn&&<div style={{padding:'6px 16px',background:'#fffbeb',borderBottom:'1px solid #fde68a',display:'flex',gap:8,alignItems:'center'}}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span style={{fontSize:12,fontWeight:500,color:'#92400e'}}>{health.checkInReason}</span></div>}
      <div style={{padding:'14px 16px',display:'flex',alignItems:'center',gap:14}}>
        <CompanyLogo name={deal.companyName} website={deal.website} size={44} radius={12} fallbackBg={health.color} fallbackColor="white"/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}>
            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>{deal.companyName}</span>
            {trl&&<Pill>{trl}</Pill>}
          </div>
          <p style={{fontSize:12,color:'#6b7280'}}>{deal.industry} · {deal.stage}</p>
          {health.factors.filter(f=>f.t!=='info').slice(0,1).map((f,i)=><div key={i} style={{display:'flex',alignItems:'center',gap:6,marginTop:4}}><span style={{width:6,height:6,borderRadius:99,background:f.t==='positive'?'#10b981':f.t==='negative'?'#ef4444':'#f59e0b',display:'inline-block'}}/><span style={{fontSize:11,color:'#9ca3af'}}>{f.l}</span></div>)}
        </div>
        <div style={{textAlign:'right',flexShrink:0}}>
          <p style={{fontSize:14,fontWeight:600,color:'#111827'}}>{fmtC(getCB(deal.investment||{}))}</p>
          {method!=='mark-at-cost'&&moic?<p style={{fontSize:12,fontWeight:500,color:moic>=1?'#10b981':'#ef4444'}}>{moic.toFixed(2)}x</p>:<p style={{fontSize:12,color:'#9ca3af'}}>at cost</p>}
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </div>
  );
};

const WatchingCard = ({deal,onClick}) => (
  <div onClick={onClick} style={{background:'white',borderRadius:16,border:'1px solid #e5e7eb',cursor:'pointer',padding:'14px 16px',display:'flex',alignItems:'center',gap:14}}>
    <CompanyLogo name={deal.companyName} website={deal.website} size={44} radius={12} fallbackBg="#f3f4f6" fallbackColor="#6b7280"/>
    <div style={{flex:1,minWidth:0}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}><span style={{fontWeight:600,fontSize:14,color:'#374151'}}>{deal.companyName}</span></div>
      <p style={{fontSize:12,color:'#9ca3af'}}>{deal.industry} · {deal.stage}</p>
      {deal.watchingNotes&&<p style={{fontSize:12,color:'#9ca3af',marginTop:4,overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',fontStyle:'italic'}}>"{deal.watchingNotes}"</p>}
    </div>
    {deal.monitoring?.fundraisingStatus==='raising'&&<Pill color="#1d4ed8" bg="#eff6ff">Raising now</Pill>}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
  </div>
);

// ── ADD MODAL ─────────────────────────────────────────────────────────────────
const AddModal = ({onClose,onAdd}) => {
  const [f,setF]=useState({name:'',industry:'',stage:'seed',status:'invested',amount:'',vehicle:'SAFE',founderName:'',founderRole:'CEO'});
  const submit=()=>{
    if(!f.name||(f.status==='invested'&&!f.amount))return;
    const now=new Date().toISOString();
    const base={id:genId(),companyName:f.name,status:f.status,stage:f.stage,industry:f.industry||'Other',founders:f.founderName?[{name:f.founderName,role:f.founderRole}]:[],coInvestors:[],liquidityEvents:[],monitoring:{healthStatus:'stable',fundraisingStatus:'not-raising'},milestones:[],createdAt:now,statusEnteredAt:now};
    if(f.status==='invested'){base.investment={amount:Number(f.amount),costBasis:Number(f.amount),vehicle:f.vehicle,date:now,lastUpdateReceived:now};}
    onAdd(base);onClose();
  };
  return <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:100,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
    <div style={{background:'white',borderRadius:20,width:'100%',maxWidth:400,maxHeight:'80vh',overflow:'auto'}}>
      <div style={{padding:'16px 20px',borderBottom:'1px solid #f3f4f6',display:'flex',justifyContent:'space-between',alignItems:'center',position:'sticky',top:0,background:'white'}}>
        <span style={{fontWeight:600,fontSize:15,color:'#111827'}}>Add Company</span>
        <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'#9ca3af'}}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
      <div style={{padding:20,display:'flex',flexDirection:'column',gap:12}}>
        <div><label style={{fontSize:12,color:'#6b7280',display:'block',marginBottom:4}}>Status</label><select value={f.status} onChange={e=>setF({...f,status:e.target.value})} style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}><option value="invested">Invested</option><option value="watching">Watching</option></select></div>
        <div><label style={{fontSize:12,color:'#6b7280',display:'block',marginBottom:4}}>Company Name *</label><input value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="Acme Inc" style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,boxSizing:'border-box'}}/></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div><label style={{fontSize:12,color:'#6b7280',display:'block',marginBottom:4}}>Industry</label><input value={f.industry} onChange={e=>setF({...f,industry:e.target.value})} placeholder="Climate Tech" style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,boxSizing:'border-box'}}/></div>
          <div><label style={{fontSize:12,color:'#6b7280',display:'block',marginBottom:4}}>Stage</label><select value={f.stage} onChange={e=>setF({...f,stage:e.target.value})} style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}><option value="pre-seed">Pre-seed</option><option value="seed">Seed</option><option value="series-a">Series A</option><option value="series-b">Series B</option><option value="growth">Growth</option></select></div>
        </div>
        {f.status==='invested'&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div><label style={{fontSize:12,color:'#6b7280',display:'block',marginBottom:4}}>Amount ($) *</label><input type="number" value={f.amount} onChange={e=>setF({...f,amount:e.target.value})} placeholder="25000" style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,boxSizing:'border-box'}}/></div>
          <div><label style={{fontSize:12,color:'#6b7280',display:'block',marginBottom:4}}>Vehicle</label><select value={f.vehicle} onChange={e=>setF({...f,vehicle:e.target.value})} style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}><option value="SAFE">SAFE</option><option value="Convertible Note">Conv. Note</option><option value="Equity">Equity</option></select></div>
        </div>}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div><label style={{fontSize:12,color:'#6b7280',display:'block',marginBottom:4}}>Founder name</label><input value={f.founderName} onChange={e=>setF({...f,founderName:e.target.value})} placeholder="Name" style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,boxSizing:'border-box'}}/></div>
          <div><label style={{fontSize:12,color:'#6b7280',display:'block',marginBottom:4}}>Role</label><input value={f.founderRole} onChange={e=>setF({...f,founderRole:e.target.value})} placeholder="CEO" style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,boxSizing:'border-box'}}/></div>
        </div>
      </div>
      <div style={{padding:'12px 20px',borderTop:'1px solid #f3f4f6',position:'sticky',bottom:0,background:'white'}}>
        <button onClick={submit} disabled={!f.name||(f.status==='invested'&&!f.amount)} style={{width:'100%',padding:'12px',background:'#5B6DC4',color:'white',border:'none',borderRadius:12,fontWeight:600,fontSize:14,cursor:'pointer',opacity:f.name&&(f.status!=='invested'||f.amount)?1:.5}}>Add Company</button>
      </div>
    </div>
  </div>;
};

// ── ROOT APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [deals,setDeals]=useState(DEALS);
  const [page,setPage]=useState('list');
  const [selected,setSelected]=useState(null);
  const [toast,setToast]=useState(null);
  const [search,setSearch]=useState('');
  const [showAdd,setShowAdd]=useState(false);

  const portfolio=deals.filter(d=>d.status==='invested');
  const ph=calcPortHealth(deals);
  const totalDep=portfolio.reduce((s,d)=>s+getCB(d.investment||{}),0);
  const totalImp=portfolio.reduce((s,d)=>s+calcIV(d),0);
  const moic=totalDep>0?totalImp/totalDep:null;
  const realized=portfolio.reduce((s,d)=>(d.liquidityEvents||[]).filter(e=>e.type!=='writedown').reduce((a,e)=>a+(e.proceeds||0),s),0);
  const dpi=totalDep>0?realized/totalDep:0;
  const checkIns=portfolio.filter(d=>calcHealth(d,[]).needsCheckIn);

  const updateDeal=(updated)=>{setDeals(prev=>prev.map(d=>d.id===updated.id?updated:d));setSelected(updated);};
  const addDeal=(d)=>{setDeals(prev=>[d,...prev]);setToast(`${d.companyName} added`);};

  const filtered=search?deals.filter(d=>d.companyName.toLowerCase().includes(search.toLowerCase())):deals;
  const fInvested=filtered.filter(d=>d.status==='invested');
  const fWatching=filtered.filter(d=>d.status==='watching');

  if(page==='detail'&&selected) return (
    <div style={{minHeight:'100vh',background:'#f9fafb',fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'}}>
      <div style={{background:'white',borderBottom:'1px solid #e5e7eb',position:'sticky',top:0,zIndex:10}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 20px'}}>
          <button onClick={()=>{setPage('list');setSelected(null);}} style={{display:'flex',alignItems:'center',gap:6,background:'none',border:'none',cursor:'pointer',color:'#6b7280',fontSize:14,fontWeight:500}}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>Portfolio</button>
          <span style={{fontWeight:700,fontSize:14,color:'#111827'}}>{selected.companyName}</span>
          <div style={{width:60}}/>
        </div>
      </div>
      <DetailView deal={selected} onUpdate={updateDeal} setToast={setToast}/>
      {toast&&<Toast msg={toast} onClose={()=>setToast(null)}/>}
    </div>
  );

  return (
    <div style={{minHeight:'100vh',background:'#f9fafb',fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'}}>
      <div style={{background:'white',borderBottom:'1px solid #e5e7eb'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 20px'}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:34,height:34,borderRadius:10,background:'#1A1A2E',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 1px 6px rgba(26,26,46,.25)'}}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="9" cy="9" r="2.5" stroke="#F5DFA0" strokeWidth="1.4"/>
                  <line x1="9" y1="1" x2="9" y2="5.5" stroke="#5B6DC4" strokeWidth="1.4" strokeLinecap="round"/>
                  <line x1="9" y1="12.5" x2="9" y2="17" stroke="#5B6DC4" strokeWidth="1.4" strokeLinecap="round"/>
                  <line x1="1" y1="9" x2="5.5" y2="9" stroke="#5B6DC4" strokeWidth="1.4" strokeLinecap="round"/>
                  <line x1="12.5" y1="9" x2="17" y2="9" stroke="#5B6DC4" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </div>
            <span style={{fontWeight:800,fontSize:16,color:'#111827',letterSpacing:'-0.3px'}}>Lucero</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <button onClick={()=>setShowAdd(true)} style={{padding:'8px 14px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}><span style={{fontSize:16,lineHeight:1}}>+</span>Add Company</button>
            <img src="https://ui-avatars.com/api/?name=AR&background=F5DFA0&color=fff&size=64" style={{width:34,height:34,borderRadius:99}} alt="AR"/>
          </div>
        </div>
      </div>

      <div style={{padding:20,maxWidth:680,margin:'0 auto'}}>
        {portfolio.length>0&&<div style={{background:'white',borderRadius:16,padding:20,marginBottom:16,border:'1px solid #e5e7eb'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
            <h2 style={{fontSize:15,fontWeight:700,color:'#111827'}}>Portfolio</h2>
            <span style={{fontSize:12,color:'#9ca3af'}}>{portfolio.length} {portfolio.length===1?'company':'companies'}</span>
          </div>
          {(()=>{
            const unrealizedGain = totalImp - totalDep;
            const statC = (v, pos='#10b981', neg='#ef4444', neu='#9ca3af') =>
              v > 0 ? pos : v < 0 ? neg : neu;

            const stats = [
              { l:'Deployed',   v:fmtC(totalDep),      sub:'cost basis',        c:'#111827' },
              { l:'Implied',    v:fmtC(totalImp),       sub:'marked value',      c:totalImp>=totalDep?'#10b981':'#ef4444' },
              { l:'Gain',       v:unrealizedGain===0?'—':(unrealizedGain>0?`+${fmtC(unrealizedGain)}`:`−${fmtC(Math.abs(unrealizedGain))}`), sub:'unrealized', c:statC(unrealizedGain) },
              { l:'MOIC',       v:moic?`${moic.toFixed(2)}x`:'—', sub:'blended', c:moic>=1.5?'#10b981':moic>=1?'#F5DFA0':'#9ca3af' },
              { l:'DPI',        v:dpi>0?`${dpi.toFixed(2)}x`:'0.00x', sub:'distributed/paid-in', c:dpi>=1?'#10b981':dpi>0?'#F5DFA0':'#9ca3af' },
              { l:'Companies', v:String(portfolio.length), sub:'invested', c:'#111827' },
            ];

            return (
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10}}>
                {stats.map(({l,v,sub,c})=>(
                  <div key={l} style={{background:'#f9fafb',borderRadius:12,padding:'10px 12px'}}>
                    <p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.7,marginBottom:4}}>{l}</p>
                    <p style={{fontSize:16,fontWeight:700,color:c,lineHeight:1.2}}>{v}</p>
                    <p style={{fontSize:10,color:'#c4c4c4',marginTop:3}}>{sub}</p>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>}

        {checkIns.length>0&&<div style={{background:'white',borderRadius:16,overflow:'hidden',border:'1px solid #fde68a',marginBottom:16}}>
          <div style={{padding:'10px 16px',background:'#fffbeb',display:'flex',alignItems:'center',gap:8}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span style={{fontSize:13,fontWeight:600,color:'#92400e'}}>{checkIns.length} {checkIns.length===1?'company needs':'companies need'} your attention</span></div>
          {checkIns.map(d=>{const h=calcHealth(d,[]);return <div key={d.id} onClick={()=>{setSelected(d);setPage('detail');}} style={{display:'flex',alignItems:'center',gap:14,padding:'12px 16px',borderTop:'1px solid #fef3c7',cursor:'pointer'}}>
            <CompanyLogo name={d.companyName} website={d.website} size={36} radius={10} fallbackBg={h.color} fallbackColor="white"/>
            <div style={{flex:1}}><p style={{fontWeight:600,fontSize:13,color:'#111827'}}>{d.companyName}</p><p style={{fontSize:12,color:'#6b7280'}}>{h.checkInReason}</p></div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
          </div>;})}
        </div>}

        <div style={{marginBottom:14}}>
          <div style={{background:'white',borderRadius:14,border:'1px solid #e5e7eb',padding:'6px 12px',display:'flex',alignItems:'center',gap:10}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search companies..." style={{border:'none',outline:'none',fontSize:14,flex:1,color:'#111827'}}/>
          </div>
        </div>

        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          {fInvested.length>0&&<div>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}><span style={{width:8,height:8,borderRadius:99,background:'#10b981',display:'inline-block'}}/><p style={{fontSize:11,fontWeight:600,color:'#6b7280',textTransform:'uppercase',letterSpacing:.8}}>Invested · {fInvested.length}</p></div>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>{fInvested.map(d=><InvestedCard key={d.id} deal={d} onClick={()=>{setSelected(d);setPage('detail');}}/>)}</div>
          </div>}
          {fWatching.length>0&&<div>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}><span style={{width:8,height:8,borderRadius:99,background:'#9ca3af',display:'inline-block'}}/><p style={{fontSize:11,fontWeight:600,color:'#6b7280',textTransform:'uppercase',letterSpacing:.8}}>Watching · {fWatching.length}</p></div>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>{fWatching.map(d=><WatchingCard key={d.id} deal={d} onClick={()=>{setSelected(d);setPage('detail');}}/>)}</div>
          </div>}
        </div>
        <p style={{textAlign:'center',fontSize:12,color:'#9ca3af',marginTop:28}}>{portfolio.length} investment{portfolio.length!==1?'s':''} · health scores update every 6h</p>
      </div>

      {showAdd&&<AddModal onClose={()=>setShowAdd(false)} onAdd={addDeal}/>}
      {toast&&<Toast msg={toast} onClose={()=>setToast(null)}/>}
    </div>
  );
}
