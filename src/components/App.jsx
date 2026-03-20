import { useState, useEffect, createContext, useContext, useRef } from "react";
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';

// ── UTILS ────────────────────────────────────────────────────────────────────
const fmtC = (n) => n >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : n >= 1000 ? `$${(n/1000).toFixed(0)}K` : `$${n ?? 0}`;
const dAgo = (d) => Math.floor((Date.now() - new Date(d)) / 86400000);
const dUntil = (d) => Math.ceil((new Date(d) - Date.now()) / 86400000);
const genId = () => Math.random().toString(36).substr(2,9);
const getCB = (inv={}) => (inv.costBasis > 0 ? inv.costBasis : inv.amount) || 0;

// ── VALUATION ENGINE ─────────────────────────────────────────────────────────
const STAGE_MAT = { 'pre-seed':'lab','seed':'pilot','series-a':'scale','series-b':'scale','series-c':'deploy','series-e':'deploy','growth':'deploy','lp-fund':'fund' };
const METRIC_DEFAULTS = {
  lab:   ['TRL level (1–9)', 'Grant / non-dilutive funding ($)', 'Key technical milestone hit'],
  pilot: ['Pilot throughput vs spec (%)', 'Cost per unit vs target ($)', 'LOIs or pilot customers signed'],
  scale: ['Commercial customers', 'Cost per unit ($)', 'ARR ($)'],
  deploy:[], // revenue only
  fund:  [],
};
const getMethod = (deal) => { const inv=deal.investment||{}; if(inv.valuationMethod) return inv.valuationMethod; const m=STAGE_MAT[deal.stage]||'lab'; return m==='lab'||m==='pilot'?'mark-at-cost':m==='fund'?'nav-lp':'last-round'; };
const getMethodLabel = (m) => ({'mark-at-cost':'Mark at cost','last-round':'Last round','safe-cap':'SAFE cap','nav-lp':'Fund NAV'}[m]||m);
const calcIV = (deal) => { const inv=deal.investment||{}; const m=getMethod(deal); const cb=getCB(inv); if(m==='mark-at-cost') return cb; if(inv.impliedValue>0) return inv.impliedValue; if(inv.ownershipPercent&&inv.impliedValuation) return Math.round((inv.ownershipPercent/100)*inv.impliedValuation); return cb; };
const calcMOIC = (deal) => { const cb=getCB(deal.investment||{}); return cb?calcIV(deal)/cb:null; };
const calcMarkup = (deal) => { const inv=deal.investment||{}; const m=getMethod(deal); if(m==='mark-at-cost'||m==='nav-lp') return null; const cur=inv.impliedValuation; if(!cur) return null; if(inv.vehicle==='SAFE'&&deal.terms?.cap) return cur/deal.terms.cap; if(inv.entryPostMoneyValuation>0) return cur/inv.entryPostMoneyValuation; return null; };
const getStaleness = (deal) => { const d=deal.investment?.lastValuationDate; if(!d) return 'unknown'; const x=dAgo(d); return x<90?'fresh':x<180?'ok':x<365?'stale':'very-stale'; };
const STALE_COL = { fresh:'#10b981',ok:'#5B6DC4',stale:'#f59e0b','very-stale':'#ef4444',unknown:'#78716c' };

// Derive current ownership from latest fundraise history entry
const getCurrentOwnership = (deal) => {
  const history = (deal.fundraiseHistory||[]).sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (!history.length) return deal.investment?.ownershipPercent||null;
  const latest = history[history.length-1];
  return latest.ownershipAfter || deal.investment?.ownershipPercent || null;
};

// Derive implied value from latest priced round post-money val × ownership
const getHistoryImpliedValue = (deal) => {
  const history = (deal.fundraiseHistory||[]).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const cb = getCB(deal.investment||{});
  for (let i=history.length-1; i>=0; i--) {
    const r = history[i];
    if (r.postMoneyVal && r.ownershipAfter) {
      return Math.round(r.postMoneyVal * (r.ownershipAfter/100));
    }
    if (r.postMoneyVal && deal.investment?.ownershipPercent) {
      // apply cumulative dilution from this round to now
      const laterRounds = history.slice(i+1);
      const cumDilution = laterRounds.reduce((acc,lr)=>acc*(1-(lr.dilutionPct||20)/100),1);
      const currentOwn = (deal.investment.ownershipPercent/100) * cumDilution;
      return Math.round(r.postMoneyVal * currentOwn);
    }
  }
  return null;
};

// Project ownership + implied value after active raise closes
const getProjected = (deal) => {
  const raise = deal.activeRaise;
  if (!raise?.dilutionPct) return null;
  const currentOwn = getCurrentOwnership(deal);
  if (!currentOwn) return null;
  const dilPct = Number(raise.dilutionPct)||20;
  const projectedOwn = currentOwn * (1 - dilPct/100);
  // If raise has a target amount and we know current post-money, project new post-money
  const history = (deal.fundraiseHistory||[]).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const latestRound = history[history.length-1];
  const currentPostMoney = latestRound?.postMoneyVal || deal.investment?.impliedValuation || null;
  const projectedPostMoney = currentPostMoney && raise.targetAmount
    ? currentPostMoney + Number(raise.targetAmount) : null;
  const projectedIV = projectedPostMoney
    ? Math.round(projectedPostMoney * (projectedOwn/100))
    : null;
  const cb = getCB(deal.investment||{});
  const projectedMOIC = projectedIV && cb ? projectedIV/cb : null;
  return {projectedOwn, projectedIV, projectedMOIC, dilPct, projectedPostMoney};
};

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
  const dealAge=deal.createdAt?dAgo(deal.createdAt):0;
  const dSinceUpd=lastUpd?dAgo(lastUpd):(dealAge<7?0:999);
  const dUntilNext=nextExp?dUntil(nextExp):null;
  const overdueThr=mat==='lab'?60:30;
  const isOverdue=dUntilNext!==null&&dUntilNext<-overdueThr;

  // ── Grounded check-in triggers (real data only) ───────────────────────────
  if(isOverdue){needsCheckIn=true;checkInReason=`Update ${Math.abs(dUntilNext)}d overdue`;}
  else if(dSinceUpd>(mat==='lab'?180:90)&&dSinceUpd!==999){needsCheckIn=true;checkInReason=`No contact in ${Math.round(dSinceUpd/30)} months`;}

  // No metric logged in 90 days
  const allMetrics=[...(deal.metricsToWatch||[])];
  const hasRecentMetric = allMetrics.some(m=>{
    const log=(deal.metricsLog||{})[m]||[];
    return log.some(e=>dAgo(e.date)<=90);
  });
  const hasRecentRevenue=(deal.revenueLog||[]).some(e=>dAgo(e.date)<=90);
  if(allMetrics.length>0&&!hasRecentMetric&&!hasRecentRevenue){
    if(!needsCheckIn){needsCheckIn=true;checkInReason='No metrics logged in 90 days';}
  }

  // Stale mark for priced rounds
  const staleness=getStaleness(deal);
  if((staleness==='very-stale')&&method!=='mark-at-cost'){
    if(!needsCheckIn){needsCheckIn=true;checkInReason='Valuation mark is over a year old';}
  }

  // Team risk signal from updates
  sigs.forEach(s=>{
    const pos=s.sentiment==='positive'; const neg=s.sentiment==='negative';
    if(s.tags.includes('hardware_milestone')){const v=pos?15:-18;score+=v;factors.push({l:pos?'Hardware milestone confirmed':'Hardware setback',v,t:pos?'positive':'negative'});if(neg&&!needsCheckIn){needsCheckIn=true;checkInReason='Hardware setback in recent update';}}
    if(s.tags.includes('policy_positive')&&pos){score+=12;factors.push({l:'Policy tailwind / federal funding',v:12,t:'positive'});}
    if(s.tags.includes('policy_risk')){score-=15;if(!needsCheckIn){needsCheckIn=true;checkInReason='Policy risk signal';}factors.push({l:'Policy risk signal',v:-15,t:'negative'});}
    if(s.tags.includes('offtake')&&pos){score+=14;factors.push({l:'Offtake / customer signal',v:14,t:'positive'});}
    if(s.tags.includes('team_risk')){score-=14;if(!needsCheckIn){needsCheckIn=true;checkInReason='Team risk in recent update';}factors.push({l:'Team / leadership risk',v:-14,t:'negative'});}
    if(s.tags.includes('funding_signal')&&pos){score+=10;factors.push({l:'New funding signal',v:10,t:'positive'});}
  });

  if(isOverdue){score-=12;factors.push({l:'Update overdue',v:-12,t:'warning'});}
  else if(dSinceUpd<45){score+=8;factors.push({l:'Recent founder update',v:8,t:'positive'});}
  if(dSinceUpd>(mat==='lab'?180:90)){score-=8;factors.push({l:`${Math.round(dSinceUpd/30)}mo silence`,v:-8,t:'warning'});}
  if(mat==='lab'){const ms=(deal.milestones||[]).filter(m=>dAgo(m.date)<180&&['product','partnership','fundraising'].includes(m.type)).length;if(ms>=1){score+=10;factors.push({l:'Recent technical milestone',v:10,t:'positive'});}factors.push({l:'Lab stage — marked at cost, TRL 1–3',v:0,t:'info'});}
  if(mat==='pilot'){const ps=(deal.milestones||[]).filter(m=>dAgo(m.date)<180&&m.type!=='update').length;if(ps>=2){score+=12;factors.push({l:'Active pilot cadence',v:12,t:'positive'});}factors.push({l:'Pilot stage — TRL 4–6',v:0,t:'info'});}
  if(mat==='scale'&&moic!==null){if(moic>=2){score+=18;factors.push({l:`${moic.toFixed(1)}x last-round mark`,v:18,t:'positive'});}else if(moic>=1.3){score+=8;factors.push({l:`${moic.toFixed(1)}x last-round mark`,v:8,t:'positive'});}else if(moic<0.8){score-=18;factors.push({l:`${moic.toFixed(1)}x — below cost`,v:-18,t:'negative'});}}
  if(mat==='deploy'&&moic!==null){if(moic>=3){score+=22;factors.push({l:`${moic.toFixed(1)}x — deployment premium`,v:22,t:'positive'});}else if(moic>=1.5){score+=12;factors.push({l:`${moic.toFixed(1)}x last-round mark`,v:12,t:'positive'});}else if(moic<1){score-=20;factors.push({l:`${moic.toFixed(1)}x — late-stage below cost`,v:-20,t:'negative'});}}
  const ms2=deal.monitoring||{};
  if(ms2.healthStatus==='thriving'){score+=8;factors.push({l:'Founder reports on track',v:8,t:'positive'});}
  if(ms2.healthStatus==='struggling'){score-=15;if(!needsCheckIn){needsCheckIn=true;checkInReason='Self-reported struggling';}factors.push({l:'Self-reported struggling',v:-15,t:'negative'});}
  if(ms2.runwayMonths&&ms2.runwayMonths<9){score-=12;if(!needsCheckIn){needsCheckIn=true;checkInReason=`${ms2.runwayMonths}mo runway`;}factors.push({l:`${ms2.runwayMonths}mo runway`,v:-12,t:'negative'});}

  score=Math.max(0,Math.min(100,score));
  const seen2=new Set(); const deduped=factors.filter(f=>{if(seen2.has(f.l)) return false;seen2.add(f.l);return true;});
  const label=score>=80?'On Track':score>=62?'Steady':score>=42?'Investigate':'Critical';
  const color=score>=80?'#10b981':score>=62?'#5B6DC4':score>=42?'#f59e0b':'#ef4444';
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
  return {score,label:score>=80?'On Track':score>=62?'Steady':score>=42?'Investigate':'Critical',color:score>=80?'#10b981':score>=62?'#5B6DC4':score>=42?'#f59e0b':'#ef4444'};
};

// ── DEMO DATA ────────────────────────────────────────────────────────────────
const DEALS = [
  {id:'1',companyName:'Form Energy',status:'invested',stage:'series-e',industry:'Long-Duration Storage',website:'https://formenergy.com',overview:'Iron-air battery technology enabling multi-day energy storage at 1/10th the cost of lithium-ion.',founders:[{name:'Mateo Jaramillo',role:'CEO'},{name:'Yet-Ming Chiang',role:'Co-Founder'}],terms:{instrument:'Equity'},investment:{amount:25000,costBasis:25000,vehicle:'Equity',date:new Date(Date.now()-365*864e5).toISOString(),ownershipPercent:0.01,entryPostMoneyValuation:800000000,impliedValuation:1500000000,impliedValue:45000,lastValuationDate:new Date(Date.now()-90*864e5).toISOString(),valuationMethod:'last-round',trlAtInvestment:8,lastUpdateReceived:new Date(Date.now()-14*864e5).toISOString(),nextUpdateExpected:new Date(Date.now()+20*864e5).toISOString()},coInvestors:[{id:'a',name:'ArcelorMittal',fund:'XCarb',role:'lead'},{id:'b',name:'GIC',fund:'GIC',role:'co-investor'},{id:'c',name:'Bill Gates',fund:'Breakthrough Energy',role:'co-investor'}],liquidityEvents:[],monitoring:{healthStatus:'thriving',fundraisingStatus:'not-raising',runwayMonths:24},memo:'Invested at Series E because iron-air is the only credible path to multi-day storage at grid scale. ArcelorMittal as lead investor is the key signal — they are a direct customer and strategic buyer, not just financial. Core bet: if they hit $50/kWh at scale, they win the long-duration market outright. Key risks: manufacturing scale-up, competition from other chemistries, utility procurement cycles are slow.',founderUpdates:[{id:'fu1',type:'text',content:'Q3 update from Mateo: first battery systems are rolling off the Weirton line. On track for Georgia Power delivery in Q3. Cost curve tracking ahead of plan at $142/kWh — targeting $100 by end of 2025. Team is 280 people now, hiring 40 more in manufacturing.',date:new Date(Date.now()-14*864e5).toISOString(),signals:['hardware_milestone']},{id:'fu2',type:'text',content:'Q2 update: Georgia Power offtake signed for 1.5 GWh. This is the first utility-scale agreement. Woodside also in late-stage discussions for Australian deployment. Revenue recognized on first delivery expected Q4.',date:new Date(Date.now()-90*864e5).toISOString(),signals:['offtake','funding_signal']},],
    metricsToWatch:['GWh capacity installed','Cost per kWh','Utility offtake contracts'],
    metricsLog:{
      'GWh capacity installed':[{v:0,date:new Date(Date.now()-365*864e5).toISOString()},{v:0.5,date:new Date(Date.now()-180*864e5).toISOString()},{v:1.2,date:new Date(Date.now()-60*864e5).toISOString()}],
      'Cost per kWh':[{v:180,date:new Date(Date.now()-365*864e5).toISOString()},{v:155,date:new Date(Date.now()-180*864e5).toISOString()},{v:130,date:new Date(Date.now()-60*864e5).toISOString()}],
      'Utility offtake contracts':[{v:0,date:new Date(Date.now()-365*864e5).toISOString()},{v:1,date:new Date(Date.now()-180*864e5).toISOString()},{v:1,date:new Date(Date.now()-60*864e5).toISOString()}],
    },
    fundraiseHistory:[
      {id:'fh1',roundName:'Seed',date:'2018-06-01',amountRaised:9000000,preMoneyVal:16000000,postMoneyVal:25000000,leadInvestor:'Breakthrough Energy Ventures',followOns:['Prelude Ventures'],dilutionPct:20,ownershipBefore:null,ownershipAfter:null},
      {id:'fh2',roundName:'Series A',date:'2019-08-01',amountRaised:20000000,preMoneyVal:80000000,postMoneyVal:100000000,leadInvestor:'Breakthrough Energy Ventures',followOns:['MIT','"The Engine"'],dilutionPct:20,ownershipBefore:null,ownershipAfter:null},
      {id:'fh3',roundName:'Series B',date:'2020-12-01',amountRaised:50000000,preMoneyVal:200000000,postMoneyVal:250000000,leadInvestor:'ArcelorMittal',followOns:['Breakthrough Energy','Prelude'],dilutionPct:20,ownershipBefore:0.012,ownershipAfter:0.0096},
      {id:'fh4',roundName:'Series C',date:'2021-08-01',amountRaised:200000000,preMoneyVal:600000000,postMoneyVal:800000000,leadInvestor:'GIC',followOns:['ArcelorMittal','Bill Gates','Capricorn'],dilutionPct:20,ownershipBefore:0.0096,ownershipAfter:0.0077},
      {id:'fh5',roundName:'Series E',date:'2023-03-01',amountRaised:450000000,preMoneyVal:1050000000,postMoneyVal:1500000000,leadInvestor:'ArcelorMittal',followOns:['GIC','Bill Gates','Breakthrough Energy'],dilutionPct:18,ownershipBefore:0.011,ownershipAfter:0.0091},
    ],
    revenueLog:[{v:0,date:new Date(Date.now()-365*864e5).toISOString()},{v:1200000,date:new Date(Date.now()-180*864e5).toISOString()},{v:4800000,date:new Date(Date.now()-60*864e5).toISOString()}],
    documents:[
      {id:'d1',label:'Series E Term Sheet',type:'Term Sheet',url:'https://drive.google.com/file/example1',addedAt:new Date(Date.now()-365*864e5).toISOString()},
      {id:'d2',label:'Equity Agreement',type:'SAFE',url:'https://drive.google.com/file/example2',addedAt:new Date(Date.now()-364*864e5).toISOString()},
      {id:'d3',label:'Form Energy Pitch Deck 2023',type:'Pitch Deck',url:'https://drive.google.com/file/example3',addedAt:new Date(Date.now()-300*864e5).toISOString()},
    ],healthHistory:[{date:new Date(Date.now()-300*864e5).toISOString(),score:72,label:'Steady'},{date:new Date(Date.now()-180*864e5).toISOString(),score:82,label:'On Track'},{date:new Date(Date.now()-60*864e5).toISOString(),score:80,label:'On Track'},{date:new Date(Date.now()-14*864e5).toISOString(),score:74,label:'Steady'}],milestones:[{id:'m1',type:'fundraising',title:'Series E — $450M',description:'Led by ArcelorMittal and GIC. Total raised over $1B.',date:new Date(Date.now()-300*864e5).toISOString()},{id:'m2',type:'partnership',title:'Georgia Power offtake',description:'First utility-scale deployment agreement.',date:new Date(Date.now()-180*864e5).toISOString()},{id:'m4',type:'update',title:'Founder update',description:'First battery systems rolling off the line. On track for utility delivery Q3.',date:new Date(Date.now()-14*864e5).toISOString()}]},
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
  {id:'4',companyName:'Rondo Energy',status:'watching',stage:'series-b',industry:'Industrial Heat',website:'https://rondoenergy.com',overview:'Electric thermal energy storage (ETES) that converts renewable electricity into industrial heat at 1500°C. Targets the 20% of global emissions from industrial processes that cannot be electrified directly.',founders:[{name:"John O'Donnell",role:'CEO',background:'Ex-Alphabet/Google X, energy storage pioneer'},{name:'John Sakamoto',role:'CTO',background:'Thermal systems engineering'}],terms:{},monitoring:{healthStatus:'stable',fundraisingStatus:'raising'},
    activeRaise:{roundName:'Series B',targetAmount:100000000,leadInvestor:'Microsoft Climate Innovation Fund',leadStatus:'confirmed',participants:'Rio Tinto,Breakthrough Energy',expectedClose:'2026-06-01',dilutionPct:20},
    fundraiseHistory:[
      {id:'rh1',roundName:'Series A',date:'2022-01-01',amountRaised:22000000,preMoneyVal:58000000,postMoneyVal:80000000,leadInvestor:'Breakthrough Energy Ventures',followOns:['Congruent Ventures'],dilutionPct:20,ownershipBefore:null,ownershipAfter:null},
    ],watchingNotes:"Strong team and real industrial demand. Watching Series B close — if IRA manufacturing credits get locked in for their heat blocks, the unit economics get dramatically better. Want to see one more named customer before committing.",memo:"Passing for now. Sales cycle for industrial customers feels long relative to current valuation. Woodside is one data point — want a second named customer before committing. Technology is validated but commercial traction is the open question. Watching: if a tier-1 climate fund leads the Series B and a second customer is named, I am in.",decisionReasoning:"Strong team and real industrial demand. Technology is validated — the question is whether the sales cycle for industrial customers is fast enough to justify the current valuation. Woodside partnership is promising but one data point isn't enough. Watching the Series B investor quality closely.",revisitDate:new Date(Date.now()+30*864e5).toISOString(),investmentTriggers:["Second named industrial customer signs contract","IRA 48C credits confirmed applicable to heat blocks","Series B closes with a tier-1 climate fund leading"],convictionLog:[{date:new Date(Date.now()-60*864e5).toISOString(),level:'medium'},{date:new Date(Date.now()-30*864e5).toISOString(),level:'medium'},{date:new Date(Date.now()-5*864e5).toISOString(),level:'high'}],coInvestors:[{id:'ci1',name:'Microsoft',fund:'Microsoft Climate Innovation Fund',role:'strategic'},{id:'ci2',name:'Rio Tinto',fund:'Rio Tinto Ventures',role:'strategic'}],milestones:[{id:'m1',type:'fundraising',title:'Series B — raising $100M',description:'Microsoft and Rio Tinto as strategic investors. Round not yet closed.',date:new Date(Date.now()-30*864e5).toISOString()},{id:'m2',type:'partnership',title:'Woodside Energy partnership',description:'First industrial deployment at LNG facility — heat block system replacing gas burners',date:new Date(Date.now()-50*864e5).toISOString()},{id:'m3',type:'product',title:'First commercial heat block shipped',description:'Initial unit delivered to Woodside facility. Performance data expected in 90 days.',date:new Date(Date.now()-10*864e5).toISOString()}]},
];

// ── SMALL COMPONENTS ─────────────────────────────────────────────────────────
const TRLBadge = ({trl}) => {
  if (!trl) return null;
  const c=trl<=3?'#78716c':trl<=6?'#5B6DC4':trl<=8?'#f59e0b':'#10b981';
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
  const [active, setActive] = useState(null);
  const [inputVal, setInputVal] = useState('');
  const [inputDate, setInputDate] = useState(new Date().toISOString().slice(0,10));
  const [showReadings, setShowReadings] = useState(null);

  const logEntry = (key) => {
    if (!inputVal || isNaN(Number(inputVal))) return;
    const entry = { v: Number(inputVal), date: new Date(inputDate).toISOString() };
    onUpdate({ ...deal, metricsLog: { ...log, [key]: [...(log[key]||[]), entry].sort((a,b)=>new Date(a.date)-new Date(b.date)) }});
    setActive(null); setInputVal(''); setInputDate(new Date().toISOString().slice(0,10));
  };

  const deleteReading = (key, idx) => {
    const updated = [...(log[key]||[])]; updated.splice(idx,1);
    onUpdate({...deal, metricsLog:{...log,[key]:updated}});
  };

  const MiniLine = ({ readings, color='#5B6DC4' }) => {
    if (!readings || readings.length < 2) return <span style={{fontSize:11,color:'#d1d5db'}}>no readings yet</span>;
    const W=80, H=28, P=3;
    const vals = readings.map(r=>r.v);
    const mn=Math.min(...vals), mx=Math.max(...vals), rng=mx-mn||1;
    const pts = readings.map((r,i)=>[P+(i/(readings.length-1))*(W-P*2), P+((mx-r.v)/rng)*(H-P*2)]);
    const poly = pts.map(([x,y])=>`${x},${y}`).join(' ');
    const latest = readings[readings.length-1];
    const prev = readings[readings.length-2];
    const dir = latest.v > prev.v ? '↑' : latest.v < prev.v ? '↓' : '→';
    const dirColor = latest.v > prev.v ? '#10b981' : latest.v < prev.v ? '#ef4444' : '#9ca3af';
    return (
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <polyline points={poly} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
          <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="2.5" fill={color}/>
        </svg>
        <div style={{display:'flex',alignItems:'baseline',gap:4}}>
          <span style={{fontSize:13,fontWeight:700,color:'#111827'}}>{latest.v.toLocaleString()}</span>
          <span style={{fontSize:13,fontWeight:600,color:dirColor}}>{dir}</span>
        </div>
      </div>
    );
  };

  if (!metrics.length) return null;

  return (
    <div style={{background:'white',borderRadius:16,padding:20,marginBottom:12}}>
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:14}}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        <span style={{fontSize:14,fontWeight:600,color:'#111827'}}>Traction Metrics</span>
        <span style={{fontSize:11,color:'#9ca3af'}}>{metrics.length} tracked</span>
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
                  <button onClick={()=>logEntry(metric)} disabled={!inputVal||isNaN(Number(inputVal))} style={{padding:'6px 14px',background:'#5B6DC4',color:'white',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',opacity:inputVal?1:.5}}>Save</button>
                  <button onClick={()=>setActive(null)} style={{padding:'6px 10px',background:'none',border:'none',color:'#9ca3af',fontSize:13,cursor:'pointer'}}>Cancel</button>
                </div>
              ):readings.length===0?(
                <p style={{fontSize:12,color:'#d1d5db',fontStyle:'italic'}}>No readings yet</p>
              ):(
                <div>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                    <MiniLine readings={readings} color={['#5B6DC4','#f59e0b','#7c3aed'][i%3]}/>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:11,color:'#9ca3af'}}>{readings.length} reading{readings.length!==1?'s':''}</span>
                      <button onClick={()=>setShowReadings(showReadings===metric?null:metric)} style={{fontSize:11,color:'#9ca3af',background:'none',border:'none',cursor:'pointer',padding:0}}>{showReadings===metric?'▲':'▼'}</button>
                    </div>
                  </div>
                  {showReadings===metric&&<div style={{marginTop:8,display:'flex',flexDirection:'column',gap:4}}>
                    {readings.map((r,ri)=>(
                      <div key={ri} style={{display:'flex',alignItems:'center',gap:8,padding:'4px 8px',background:'#f9fafb',borderRadius:8}}>
                        <span style={{fontSize:12,color:'#374151',flex:1}}>{r.v.toLocaleString()} · {new Date(r.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>
                        <button onClick={()=>deleteReading(metric,ri)} style={{color:'#d1d5db',background:'none',border:'none',cursor:'pointer',padding:2,fontSize:11}}>✕</button>
                      </div>
                    ))}
                  </div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── SECTIONS ─────────────────────────────────────────────────────────────────
const DOC_TYPES = ['SAFE','Term Sheet','Cap Table','Pitch Deck','Due Diligence','Financial Model','Legal','Other'];

const DocumentsSection = ({deal, onUpdate, setToast}) => {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({label:'', url:'', type:'SAFE'});
  const docs = deal.documents || [];

  const add = () => {
    if (!form.label.trim() || !form.url.trim()) return;
    let url = form.url.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    const entry = {id:genId(), label:form.label.trim(), url, type:form.type, addedAt:new Date().toISOString()};
    onUpdate({...deal, documents:[...docs, entry]});
    setForm({label:'', url:'', type:'SAFE'});
    setAdding(false);
    setToast('Document added');
  };

  const remove = (id) => onUpdate({...deal, documents:docs.filter(d=>d.id!==id)});

  const typeIcon = (type) => ({'SAFE':'📄','Term Sheet':'📋','Cap Table':'📊','Pitch Deck':'📑','Due Diligence':'🔍','Financial Model':'💹','Legal':'⚖️','Other':'📎'}[type]||'📎');

  return (
    <div style={{background:'white',borderRadius:16,overflow:'hidden',marginBottom:12}}>
      <button onClick={()=>setOpen(v=>!v)} style={{width:'100%',padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'none',border:'none',cursor:'pointer'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Documents</span>
          {docs.length>0&&<span style={{fontSize:12,color:'#9ca3af'}}>({docs.length})</span>}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          {!open&&docs.length>0&&<span style={{fontSize:12,color:'#9ca3af'}}>{docs.slice(0,2).map(d=>d.type).join(' · ')}{docs.length>2?` +${docs.length-2}`:''}</span>}
          <span style={{color:'#9ca3af',fontSize:11}}>{open?'▲':'▼'}</span>
        </div>
      </button>
      {open&&<div style={{padding:'0 20px 20px',borderTop:'1px solid #f3f4f6'}}>
        {docs.length===0&&!adding&&<p style={{fontSize:13,color:'#9ca3af',textAlign:'center',padding:'8px 0'}}>No documents yet — paste a Google Drive or Dropbox link</p>}
        {docs.map(doc=>(
          <div key={doc.id} style={{display:'flex',alignItems:'center',gap:12,paddingTop:12}}>
            <span style={{fontSize:16,flexShrink:0}}>{typeIcon(doc.type)}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
                <a href={doc.url} target="_blank" rel="noopener noreferrer" style={{fontWeight:500,fontSize:13,color:'#5B6DC4',textDecoration:'none',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{doc.label}</a>
                <Pill>{doc.type}</Pill>
              </div>
              <p style={{fontSize:11,color:'#9ca3af'}}>Added {dAgo(doc.addedAt)}d ago</p>
            </div>
            <button onClick={()=>remove(doc.id)} style={{color:'#d1d5db',background:'none',border:'none',cursor:'pointer',padding:4,flexShrink:0}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        ))}
        {adding?(
          <div style={{paddingTop:12,marginTop:docs.length?8:0,borderTop:docs.length?'1px solid #f3f4f6':'none'}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
              <input placeholder="Label (e.g. Series A SAFE)" value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))} style={{padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}/>
              <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} style={{padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13}}>
                {DOC_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <input placeholder="Google Drive or Dropbox URL" value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} style={{width:'100%',padding:'8px 10px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,marginBottom:8,boxSizing:'border-box'}}/>
            <div style={{display:'flex',gap:8}}>
              <button onClick={add} disabled={!form.label.trim()||!form.url.trim()} style={{flex:1,padding:'8px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',opacity:form.label.trim()&&form.url.trim()?1:.5}}>Add document</button>
              <button onClick={()=>setAdding(false)} style={{padding:'8px 14px',background:'none',border:'none',color:'#6b7280',fontSize:13,cursor:'pointer'}}>Cancel</button>
            </div>
          </div>
        ):<button onClick={()=>setAdding(true)} style={{marginTop:10,background:'none',border:'none',color:'#5B6DC4',fontSize:13,cursor:'pointer',padding:0}}>+ Add document</button>}
      </div>}
    </div>
  );
};

// ── ACTIVE RAISE CARD ─────────────────────────────────────────────────────────
const ActiveRaiseCard = ({deal, onUpdate, setToast}) => {
  const raise = deal.activeRaise || {};
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    roundName: raise.roundName||'',
    targetAmount: raise.targetAmount||'',
    leadInvestor: raise.leadInvestor||'',
    leadStatus: raise.leadStatus||'rumored',
    participants: raise.participants||'',
    expectedClose: raise.expectedClose||'',
    dilutionPct: raise.dilutionPct||'20',
  });

  if (!deal.monitoring?.fundraisingStatus==='raising' && !raise.roundName) return null;
  if (deal.monitoring?.fundraisingStatus !== 'raising' && !raise.roundName) return null;

  const curOwnership = inv => {
    const history = (deal.fundraiseHistory||[]);
    if (!history.length) return null;
    return history[history.length-1].ownershipAfter || null;
  };
  const projectedOwnership = raise.dilutionPct && raise.ownershipBefore
    ? (raise.ownershipBefore * (1 - Number(raise.dilutionPct)/100)).toFixed(3)
    : null;

  const closeRound = () => {
    const raise = deal.activeRaise||{};
    const now = new Date().toISOString();
    const currentOwn = getCurrentOwnership(deal);
    const dilPct = Number(raise.dilutionPct)||20;
    const ownershipAfter = currentOwn ? Number((currentOwn*(1-dilPct/100)).toFixed(3)) : null;
    const newRound = {
      id: genId(),
      roundName: raise.roundName||'Unknown round',
      date: now.slice(0,10),
      amountRaised: raise.targetAmount||null,
      postMoneyVal: raise.targetAmount && deal.investment?.impliedValuation
        ? deal.investment.impliedValuation + Number(raise.targetAmount) : null,
      leadInvestor: raise.leadInvestor||null,
      followOns: raise.participants ? raise.participants.split(',').map(s=>s.trim()).filter(Boolean) : [],
      dilutionPct: dilPct,
      ownershipBefore: currentOwn||null,
      ownershipAfter,
    };
    // Compute new implied value from closed round
    const newIV = newRound.postMoneyVal && ownershipAfter
      ? Math.round(newRound.postMoneyVal*(ownershipAfter/100)) : null;
    onUpdate({
      ...deal,
      activeRaise: null,
      monitoring: {...(deal.monitoring||{}), fundraisingStatus:'not-raising'},
      fundraiseHistory: [...(deal.fundraiseHistory||[]), newRound],
      investment: {
        ...(deal.investment||{}),
        ...(newIV ? {impliedValue:newIV, impliedValuation:newRound.postMoneyVal, lastValuationDate:now, valuationMethod:'last-round'} : {}),
      },
    });
    setToast(`${newRound.roundName} closed — history and valuation updated`);
  };

  const save = () => {
    const updated = {...form, targetAmount:form.targetAmount?Number(form.targetAmount):null, dilutionPct:Number(form.dilutionPct)||20};
    onUpdate({...deal, activeRaise:updated, monitoring:{...(deal.monitoring||{}), fundraisingStatus:'raising'}});
    setEditing(false);
    setToast('Raise details saved');
  };

  const LEAD_STATUS = {confirmed:{l:'Lead confirmed',c:'#10b981'},rumored:{l:'Lead rumored',c:'#f59e0b'},none:{l:'No lead yet',c:'#ef4444'}};

  return (
    <div style={{borderRadius:16,overflow:'hidden',border:'2px solid #5B6DC4',marginBottom:12,background:'white'}}>
      <div style={{padding:'12px 18px',background:'#5B6DC4',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          <span style={{fontWeight:700,fontSize:13,color:'white'}}>Actively raising{raise.roundName?` · ${raise.roundName}`:''}</span>
          {raise.expectedClose&&<span style={{fontSize:12,color:'rgba(255,255,255,.75)'}}>· Close {new Date(raise.expectedClose).toLocaleDateString('en-US',{month:'short',year:'numeric'})}</span>}
        </div>
        <div style={{display:'flex',gap:6}}>
          <button onClick={()=>{setForm({roundName:raise.roundName||'',targetAmount:raise.targetAmount||'',leadInvestor:raise.leadInvestor||'',leadStatus:raise.leadStatus||'rumored',participants:raise.participants||'',expectedClose:raise.expectedClose||'',dilutionPct:raise.dilutionPct||'20'});setEditing(v=>!v);}} style={{background:'rgba(255,255,255,.2)',border:'none',borderRadius:8,padding:'4px 10px',color:'white',fontSize:12,cursor:'pointer',fontWeight:500}}>{editing?'Cancel':'Edit'}</button>
          <button onClick={closeRound} style={{background:'white',border:'none',borderRadius:8,padding:'4px 10px',color:'#5B6DC4',fontSize:12,cursor:'pointer',fontWeight:700}}>Close round ✓</button>
        </div>
      </div>

      {editing?(
        <div style={{padding:16,display:'flex',flexDirection:'column',gap:10}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            <div><p style={{fontSize:11,color:'#6b7280',marginBottom:3}}>Round name</p><input value={form.roundName} onChange={e=>setForm(f=>({...f,roundName:e.target.value}))} placeholder="Series B" style={{width:'100%',padding:'7px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,boxSizing:'border-box'}}/></div>
            <div><p style={{fontSize:11,color:'#6b7280',marginBottom:3}}>Target amount ($)</p><input type="number" value={form.targetAmount} onChange={e=>setForm(f=>({...f,targetAmount:e.target.value}))} placeholder="10000000" style={{width:'100%',padding:'7px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,boxSizing:'border-box'}}/></div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            <div><p style={{fontSize:11,color:'#6b7280',marginBottom:3}}>Lead investor</p><input value={form.leadInvestor} onChange={e=>setForm(f=>({...f,leadInvestor:e.target.value}))} placeholder="Investor name" style={{width:'100%',padding:'7px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,boxSizing:'border-box'}}/></div>
            <div><p style={{fontSize:11,color:'#6b7280',marginBottom:3}}>Lead status</p>
              <select value={form.leadStatus} onChange={e=>setForm(f=>({...f,leadStatus:e.target.value}))} style={{width:'100%',padding:'7px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13}}>
                <option value="confirmed">Confirmed</option><option value="rumored">Rumored</option><option value="none">None yet</option>
              </select>
            </div>
          </div>
          <div><p style={{fontSize:11,color:'#6b7280',marginBottom:3}}>Other participants (comma-separated)</p><input value={form.participants} onChange={e=>setForm(f=>({...f,participants:e.target.value}))} placeholder="Breakthrough Energy, GIC" style={{width:'100%',padding:'7px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,boxSizing:'border-box'}}/></div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            <div><p style={{fontSize:11,color:'#6b7280',marginBottom:3}}>Expected close</p><input type="date" value={form.expectedClose} onChange={e=>setForm(f=>({...f,expectedClose:e.target.value}))} style={{width:'100%',padding:'7px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,boxSizing:'border-box'}}/></div>
            <div><p style={{fontSize:11,color:'#6b7280',marginBottom:3}}>Expected dilution (%)</p><input type="number" value={form.dilutionPct} onChange={e=>setForm(f=>({...f,dilutionPct:e.target.value}))} placeholder="20" style={{width:'100%',padding:'7px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,boxSizing:'border-box'}}/></div>
          </div>
          <button onClick={save} style={{padding:'8px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer'}}>Save</button>
        </div>
      ):(
        <div style={{padding:'14px 18px',display:'flex',flexDirection:'column',gap:10}}>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10}}>
            <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:3}}>Target</p><p style={{fontSize:15,fontWeight:700,color:'#111827'}}>{raise.targetAmount?fmtC(raise.targetAmount):'—'}</p></div>
            <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:3}}>Lead</p>
              <div style={{display:'flex',alignItems:'center',gap:5}}>
                <span style={{width:6,height:6,borderRadius:99,background:LEAD_STATUS[raise.leadStatus||'none']?.c||'#9ca3af',display:'inline-block'}}/>
                <p style={{fontSize:13,fontWeight:600,color:'#374151'}}>{raise.leadInvestor||LEAD_STATUS[raise.leadStatus||'none']?.l}</p>
              </div>
            </div>
            <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:3}}>Dilution est.</p>
              <p style={{fontSize:15,fontWeight:700,color:'#5B6DC4'}}>{raise.dilutionPct||20}%</p>
            </div>
          </div>
          {raise.participants&&<div>
            <p style={{fontSize:11,color:'#9ca3af',marginBottom:4}}>Participants</p>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {raise.participants.split(',').map(p=>p.trim()).filter(Boolean).map((p,i)=><Pill key={i}>{p}</Pill>)}
            </div>
          </div>}
          {raise.leadStatus&&<div style={{padding:'8px 12px',background:LEAD_STATUS[raise.leadStatus]?.c+'12',borderRadius:10,display:'flex',alignItems:'center',gap:6}}>
            <span style={{width:6,height:6,borderRadius:99,background:LEAD_STATUS[raise.leadStatus].c,display:'inline-block'}}/>
            <span style={{fontSize:12,color:LEAD_STATUS[raise.leadStatus].c,fontWeight:600}}>{LEAD_STATUS[raise.leadStatus].l}</span>
            {raise.dilutionPct&&<span style={{fontSize:12,color:'#6b7280',marginLeft:4}}>— projected {raise.dilutionPct}% dilution to your position</span>}
          </div>}
        </div>
      )}
    </div>
  );
};

// ── FUNDRAISE HISTORY ──────────────────────────────────────────────────────────
const FundraiseHistory = ({deal, onUpdate, setToast}) => {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({roundName:'',date:'',amountRaised:'',preMoneyVal:'',postMoneyVal:'',leadInvestor:'',followOns:'',dilutionPct:'20',ownershipBefore:'',ownershipAfter:''});
  const rounds = (deal.fundraiseHistory||[]).sort((a,b)=>new Date(a.date)-new Date(b.date));

  const deleteRound = (id) => {
    onUpdate({...deal, fundraiseHistory:(deal.fundraiseHistory||[]).filter(r=>r.id!==id)});
    setToast('Round removed');
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setAdding(false);
    setForm({
      roundName:r.roundName||'', date:r.date||'',
      amountRaised:r.amountRaised||'', preMoneyVal:r.preMoneyVal||'',
      postMoneyVal:r.postMoneyVal||'', leadInvestor:r.leadInvestor||'',
      followOns:(r.followOns||[]).join(', '), dilutionPct:r.dilutionPct||'20',
      ownershipBefore:r.ownershipBefore||'', ownershipAfter:r.ownershipAfter||'',
    });
  };

  const saveEdit = () => {
    if (!form.roundName || !form.date) return;
    const ownershipAfter = form.ownershipAfter || calcOwnershipAfter(form.ownershipBefore, form.dilutionPct);
    const updated = {
      id: editingId,
      roundName:form.roundName, date:form.date,
      amountRaised:form.amountRaised?Number(form.amountRaised):null,
      preMoneyVal:form.preMoneyVal?Number(form.preMoneyVal):null,
      postMoneyVal:form.postMoneyVal?Number(form.postMoneyVal):null,
      leadInvestor:form.leadInvestor||null,
      followOns:form.followOns?form.followOns.split(',').map(s=>s.trim()).filter(Boolean):[],
      dilutionPct:Number(form.dilutionPct)||20,
      ownershipBefore:form.ownershipBefore?Number(form.ownershipBefore):null,
      ownershipAfter:ownershipAfter?Number(ownershipAfter):null,
    };
    const updatedInvestment = {...(deal.investment||{})};
    if (updated.postMoneyVal) { updatedInvestment.impliedValuation=updated.postMoneyVal; updatedInvestment.lastValuationDate=new Date(form.date).toISOString(); updatedInvestment.valuationMethod='last-round'; }
    if (updated.ownershipAfter) updatedInvestment.ownershipPercent=updated.ownershipAfter;
    onUpdate({...deal, fundraiseHistory:(deal.fundraiseHistory||[]).map(r=>r.id===editingId?updated:r), investment:updatedInvestment});
    setEditingId(null);
    setToast('Round updated — valuation refreshed');
  };

  const calcOwnershipAfter = (before, dilPct) => {
    if (!before || !dilPct) return null;
    return (Number(before) * (1 - Number(dilPct)/100)).toFixed(3);
  };

  const add = () => {
    if (!form.roundName || !form.date) return;
    const ownershipAfter = form.ownershipAfter || calcOwnershipAfter(form.ownershipBefore, form.dilutionPct);
    const entry = {
      id: genId(),
      roundName: form.roundName,
      date: form.date,
      amountRaised: form.amountRaised ? Number(form.amountRaised) : null,
      preMoneyVal: form.preMoneyVal ? Number(form.preMoneyVal) : null,
      postMoneyVal: form.postMoneyVal ? Number(form.postMoneyVal) : null,
      leadInvestor: form.leadInvestor || null,
      followOns: form.followOns ? form.followOns.split(',').map(s=>s.trim()).filter(Boolean) : [],
      dilutionPct: Number(form.dilutionPct)||20,
      ownershipBefore: form.ownershipBefore ? Number(form.ownershipBefore) : null,
      ownershipAfter: ownershipAfter ? Number(ownershipAfter) : null,
    };
    // Auto-update valuation mark if post-money is known
    const updatedInvestment = {...(deal.investment||{})};
    if (entry.postMoneyVal) {
      updatedInvestment.impliedValuation = entry.postMoneyVal;
      updatedInvestment.lastValuationDate = new Date(form.date).toISOString();
      updatedInvestment.valuationMethod = 'last-round';
    }
    if (entry.ownershipAfter) {
      updatedInvestment.ownershipPercent = entry.ownershipAfter;
    }
    onUpdate({...deal, fundraiseHistory:[...(deal.fundraiseHistory||[]), entry], investment:updatedInvestment});
    setForm({roundName:'',date:'',amountRaised:'',preMoneyVal:'',postMoneyVal:'',leadInvestor:'',followOns:'',dilutionPct:'20',ownershipBefore:'',ownershipAfter:''});
    setAdding(false);
    setToast('Round added — valuation and ownership updated');
  };

  const inp = {width:'100%',padding:'7px 10px',border:'1px solid #e5e7eb',borderRadius:8,fontSize:13,boxSizing:'border-box'};
  const lbl = {fontSize:11,color:'#6b7280',marginBottom:3};

  return (
    <div style={{background:'white',borderRadius:16,overflow:'hidden',marginBottom:12}}>
      <button onClick={()=>setOpen(v=>!v)} style={{width:'100%',padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'none',border:'none',cursor:'pointer'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Fundraise history</span>
          {rounds.length>0&&<span style={{fontSize:12,color:'#9ca3af'}}>{rounds.length} round{rounds.length!==1?'s':''}</span>}
        </div>
        <span style={{color:'#9ca3af',fontSize:11}}>{open?'▲':'▼'}</span>
      </button>

      {open&&<div style={{padding:'0 20px 20px',borderTop:'1px solid #f3f4f6'}}>
        {rounds.length===0&&!adding&&<p style={{fontSize:13,color:'#9ca3af',textAlign:'center',padding:'12px 0'}}>No rounds logged yet</p>}

        {/* Timeline */}
        <div style={{position:'relative',paddingLeft:16}}>
          {rounds.length>0&&<div style={{position:'absolute',left:6,top:8,bottom:8,width:1,background:'#e5e7eb'}}/>}
          {rounds.map((r,i)=>(
            <div key={r.id} style={{position:'relative',paddingTop:i===0?8:16}}>
              <div style={{position:'absolute',left:-10,top:i===0?12:20,width:8,height:8,borderRadius:99,background:'#5B6DC4',border:'2px solid white',boxShadow:'0 0 0 1px #5B6DC4'}}/>
              {editingId===r.id?(
                <div style={{background:'#f5f3ff',borderRadius:12,padding:'12px 14px',border:'1px solid #e9d5ff'}}>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
                    <div><p style={lbl}>Round name *</p><input value={form.roundName} onChange={e=>setForm(f=>({...f,roundName:e.target.value}))} style={inp}/></div>
                    <div><p style={lbl}>Date *</p><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={inp}/></div>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:8}}>
                    <div><p style={lbl}>Amount ($)</p><input type="number" value={form.amountRaised} onChange={e=>setForm(f=>({...f,amountRaised:e.target.value}))} style={inp}/></div>
                    <div><p style={lbl}>Pre-money ($)</p><input type="number" value={form.preMoneyVal} onChange={e=>setForm(f=>({...f,preMoneyVal:e.target.value}))} style={inp}/></div>
                    <div><p style={lbl}>Post-money ($)</p><input type="number" value={form.postMoneyVal} onChange={e=>setForm(f=>({...f,postMoneyVal:e.target.value}))} style={inp}/></div>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
                    <div><p style={lbl}>Lead</p><input value={form.leadInvestor} onChange={e=>setForm(f=>({...f,leadInvestor:e.target.value}))} style={inp}/></div>
                    <div><p style={lbl}>Follow-ons</p><input value={form.followOns} onChange={e=>setForm(f=>({...f,followOns:e.target.value}))} style={inp}/></div>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:10}}>
                    <div><p style={lbl}>Ownership before (%)</p><input type="number" value={form.ownershipBefore} onChange={e=>setForm(f=>({...f,ownershipBefore:e.target.value,ownershipAfter:calcOwnershipAfter(e.target.value,f.dilutionPct)||''}))} style={inp}/></div>
                    <div><p style={lbl}>Dilution (%)</p><input type="number" value={form.dilutionPct} onChange={e=>setForm(f=>({...f,dilutionPct:e.target.value,ownershipAfter:calcOwnershipAfter(f.ownershipBefore,e.target.value)||''}))} style={inp}/></div>
                    <div><p style={lbl}>Ownership after (%)</p><input type="number" value={form.ownershipAfter} onChange={e=>setForm(f=>({...f,ownershipAfter:e.target.value}))} style={{...inp,background:'#f9fafb'}}/></div>
                  </div>
                  <div style={{display:'flex',gap:8}}>
                    <button onClick={saveEdit} disabled={!form.roundName||!form.date} style={{flex:1,padding:'7px',background:'#5B6DC4',color:'white',border:'none',borderRadius:9,fontWeight:600,fontSize:13,cursor:'pointer',opacity:form.roundName&&form.date?1:.4}}>Save changes</button>
                    <button onClick={()=>setEditingId(null)} style={{padding:'7px 12px',background:'none',border:'none',color:'#6b7280',fontSize:13,cursor:'pointer'}}>Cancel</button>
                  </div>
                </div>
              ):(
                <div style={{background:'#f9fafb',borderRadius:12,padding:'12px 14px'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontWeight:700,fontSize:13,color:'#111827'}}>{r.roundName}</span>
                      {r.amountRaised&&<Pill color="#5B6DC4" bg="#FFFBEC">{fmtC(r.amountRaised)}</Pill>}
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:11,color:'#9ca3af'}}>{new Date(r.date).toLocaleDateString('en-US',{month:'short',year:'numeric'})}</span>
                      <button onClick={()=>startEdit(r)} style={{fontSize:11,color:'#9ca3af',background:'none',border:'none',cursor:'pointer',padding:0}}>Edit</button>
                      <button onClick={()=>deleteRound(r.id)} style={{fontSize:11,color:'#fca5a5',background:'none',border:'none',cursor:'pointer',padding:0}}>Delete</button>
                    </div>
                  </div>
                  <div style={{display:'flex',gap:16,flexWrap:'wrap',marginBottom:r.leadInvestor||r.followOns?.length?8:0}}>
                    {r.postMoneyVal&&<div><span style={{fontSize:11,color:'#9ca3af'}}>Post-money </span><span style={{fontSize:12,fontWeight:600,color:'#374151'}}>{fmtC(r.postMoneyVal)}</span></div>}
                    {r.ownershipBefore!=null&&r.ownershipAfter!=null&&<div>
                      <span style={{fontSize:11,color:'#9ca3af'}}>Your ownership </span>
                      <span style={{fontSize:12,fontWeight:600,color:'#374151'}}>{r.ownershipBefore}%</span>
                      <span style={{fontSize:11,color:'#9ca3af'}}> → </span>
                      <span style={{fontSize:12,fontWeight:600,color:r.ownershipAfter<r.ownershipBefore?'#ef4444':'#374151'}}>{r.ownershipAfter}%</span>
                      <span style={{fontSize:11,color:'#9ca3af'}}> ({r.dilutionPct}% dilution)</span>
                    </div>}
                  </div>
                  {(r.leadInvestor||r.followOns?.length>0)&&<div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
                    {r.leadInvestor&&<Pill color="#10b981" bg="#f0fdf4">Lead: {r.leadInvestor}</Pill>}
                    {r.followOns?.map((f,fi)=><Pill key={fi}>{f}</Pill>)}
                  </div>}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Add round form */}
        {adding?(
          <div style={{marginTop:16,paddingTop:16,borderTop:'1px solid #f3f4f6'}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
              <div><p style={lbl}>Round name *</p><input value={form.roundName} onChange={e=>setForm(f=>({...f,roundName:e.target.value}))} placeholder="Series A" style={inp}/></div>
              <div><p style={lbl}>Date *</p><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={inp}/></div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:8}}>
              <div><p style={lbl}>Amount raised ($)</p><input type="number" value={form.amountRaised} onChange={e=>setForm(f=>({...f,amountRaised:e.target.value}))} placeholder="5000000" style={inp}/></div>
              <div><p style={lbl}>Pre-money val ($)</p><input type="number" value={form.preMoneyVal} onChange={e=>setForm(f=>({...f,preMoneyVal:e.target.value}))} placeholder="20000000" style={inp}/></div>
              <div><p style={lbl}>Post-money val ($)</p><input type="number" value={form.postMoneyVal} onChange={e=>setForm(f=>({...f,postMoneyVal:e.target.value}))} placeholder="25000000" style={inp}/></div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
              <div><p style={lbl}>Lead investor</p><input value={form.leadInvestor} onChange={e=>setForm(f=>({...f,leadInvestor:e.target.value}))} placeholder="Breakthrough Energy" style={inp}/></div>
              <div><p style={lbl}>Follow-ons (comma-sep)</p><input value={form.followOns} onChange={e=>setForm(f=>({...f,followOns:e.target.value}))} placeholder="GIC, Bill Gates" style={inp}/></div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:12}}>
              <div><p style={lbl}>Your ownership before (%)</p><input type="number" value={form.ownershipBefore} onChange={e=>setForm(f=>({...f,ownershipBefore:e.target.value,ownershipAfter:calcOwnershipAfter(e.target.value,f.dilutionPct)||''}))} placeholder="0.05" style={inp}/></div>
              <div><p style={lbl}>Dilution (%)</p><input type="number" value={form.dilutionPct} onChange={e=>setForm(f=>({...f,dilutionPct:e.target.value,ownershipAfter:calcOwnershipAfter(f.ownershipBefore,e.target.value)||''}))} placeholder="20" style={inp}/></div>
              <div><p style={lbl}>Ownership after (%)</p><input type="number" value={form.ownershipAfter} onChange={e=>setForm(f=>({...f,ownershipAfter:e.target.value}))} placeholder="auto-calc" style={{...inp,background:'#f9fafb'}}/></div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={add} disabled={!form.roundName||!form.date} style={{flex:1,padding:'8px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',opacity:form.roundName&&form.date?1:.4}}>Add round</button>
              <button onClick={()=>setAdding(false)} style={{padding:'8px 14px',background:'none',border:'none',color:'#6b7280',fontSize:13,cursor:'pointer'}}>Cancel</button>
            </div>
          </div>
        ):<button onClick={()=>setAdding(true)} style={{marginTop:12,background:'none',border:'none',color:'#5B6DC4',fontSize:13,fontWeight:500,cursor:'pointer',padding:0,display:'flex',alignItems:'center',gap:6}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add round
        </button>}
      </div>}
    </div>
  );
};

// ── EXTERNAL SIGNAL FETCHER ───────────────────────────────────────────────────
const SIGNAL_CACHE_KEY = 'lucero_signals_v2';
const SIGNAL_TTL = 12 * 60 * 60 * 1000;
const loadSignalCache = () => { try { return JSON.parse(localStorage.getItem(SIGNAL_CACHE_KEY) || '{}'); } catch { return {}; } };
const saveSignalCache = (c) => { try { localStorage.setItem(SIGNAL_CACHE_KEY, JSON.stringify(c)); } catch {} };

const fetchExternalSignals = async (deal) => {
  const resp = await fetch('/api/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyName: deal.companyName, website: deal.website || null, stage: deal.stage || null, industry: deal.industry || null }),
  });
  if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || `HTTP ${resp.status}`); }
  return resp.json();
};

// ── STATUS DOTS ────────────────────────────────────────────────────────────────
const ActivityDot = ({ status }) => {
  const cfg = {
    active:   { color: '#10b981', label: 'Active',  bg: '#f0fdf4' },
    quiet:    { color: '#f59e0b', label: 'Quiet',   bg: '#fffbeb' },
    dark:     { color: '#ef4444', label: 'Dark',    bg: '#fef2f2' },
    unknown:  { color: '#9ca3af', label: 'Unknown', bg: '#f9fafb' },
  }[status || 'unknown'];
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px', borderRadius:99, background:cfg.bg, fontSize:11, fontWeight:600, color:cfg.color }}>
      <span style={{ width:6, height:6, borderRadius:99, background:cfg.color, display:'inline-block' }}/>
      {cfg.label}
    </span>
  );
};

const MomentumDot = ({ trend }) => {
  const cfg = {
    up:      { color: '#10b981', bg: '#f0fdf4', icon: '↑', label: 'Momentum ↑' },
    flat:    { color: '#5B6DC4', bg: '#eef2ff', icon: '→', label: 'Steady →' },
    down:    { color: '#ef4444', bg: '#fef2f2', icon: '↓', label: 'Slowing ↓' },
    unknown: { color: '#9ca3af', bg: '#f9fafb', icon: '·', label: 'No data' },
  }[trend || 'unknown'];
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px', borderRadius:99, background:cfg.bg, fontSize:11, fontWeight:600, color:cfg.color }}>
      {cfg.label}
    </span>
  );
};

const RiskDot = ({ level }) => {
  const cfg = {
    none:    { color: '#10b981', bg: '#f0fdf4', label: 'No risk flags' },
    watch:   { color: '#f59e0b', bg: '#fffbeb', label: 'Watch' },
    alert:   { color: '#ef4444', bg: '#fef2f2', label: 'Risk alert' },
  }[level || 'none'];
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px', borderRadius:99, background:cfg.bg, fontSize:11, fontWeight:600, color:cfg.color }}>
      <span style={{ width:6, height:6, borderRadius:99, background:cfg.color, display:'inline-block' }}/>
      {cfg.label}
    </span>
  );
};

// ── VALUE CHART ───────────────────────────────────────────────────────────────
// Tracks implied value over time with annotated event markers.
// Fundrise-style: area chart + step changes on valuation marks + event pins.
const ValueChart = ({ deal, allDeals, mode = 'deal' }) => {
  const [timeframe, setTimeframe] = useState('all');
  const [hovered, setHovered] = useState(null);
  const W = 500, H = 100, PL = 38, PR = 12, PT = 8, PB = 18;
  const CW = W - PL - PR, CH = H - PT - PB;

  // ── Build timeline data points ──────────────────────────────────────────────
  const buildDealTimeline = (d) => {
    const inv = d.investment || {};
    const cb = getCB(inv);
    if (!cb || !inv.date) return [];
    const points = [{ date: new Date(inv.date), value: cb, type: 'invest' }];

    // Each fundraise round with postMoneyVal recalculates implied value
    (d.fundraiseHistory || [])
      .filter(r => r.date && r.postMoneyVal && r.ownershipAfter)
      .forEach(r => {
        const iv = Math.round((r.ownershipAfter / 100) * r.postMoneyVal);
        points.push({ date: new Date(r.date), value: iv, type: 'round', label: r.roundName });
      });

    // Current mark at today
    const iv = calcIV(d);
    points.push({ date: new Date(), value: iv, type: 'current' });

    return points.sort((a, b) => a.date - b.date);
  };

  const buildPortfolioTimeline = (deals) => {
    // Collect all investment events across portfolio
    const events = [];
    deals.forEach(d => {
      const inv = d.investment || {};
      const cb = getCB(inv);
      if (!cb || !inv.date) return;
      events.push({ date: new Date(inv.date), deal: d, cb });
    });
    events.sort((a, b) => a.date - b.date);
    if (!events.length) return [];

    // Build cumulative value over time
    const points = [];
    let deployed = 0;
    events.forEach(e => {
      deployed += e.cb;
      points.push({ date: e.date, value: deployed, type: 'invest', label: e.deal.companyName });
    });
    // Add current total value at today
    const totalIV = deals.reduce((s, d) => s + calcIV(d), 0);
    points.push({ date: new Date(), value: totalIV, type: 'current' });
    return points;
  };

  // ── Build event markers ──────────────────────────────────────────────────────
  const buildMarkers = (d) => {
    const markers = [];
    (d.fundraiseHistory || []).forEach(r => {
      if (r.date) markers.push({
        date: new Date(r.date), type: 'round',
        label: r.roundName || 'Funding round',
        sub: [r.amountRaised ? fmtC(r.amountRaised) : null, r.leadInvestor || null].filter(Boolean).join(' · ') || null,
      });
    });
    (d.founderUpdates || []).slice(0, 6).forEach(u => {
      if (u.date) markers.push({
        date: new Date(u.date), type: 'update',
        label: u.keyTakeaway ? u.keyTakeaway.substring(0, 50) : 'Founder update',
        sub: null,
      });
    });
    (d.milestones || []).filter(m => m.fromPrimary || m.fromAgent).slice(0, 6).forEach(m => {
      if (m.date) markers.push({
        date: new Date(m.date),
        type: m.sentiment === 'negative' ? 'risk' : 'signal',
        label: m.title?.substring(0, 50) || '',
        sub: m.description ? m.description.substring(0, 40) : null,
      });
    });
    // Also include external signal fetch dates
    try {
      const cache = loadSignalCache()[d.id];
      if (cache?.fetchedAt) markers.push({
        date: new Date(cache.fetchedAt), type: 'signal',
        label: 'External signals fetched',
        sub: cache.activity?.status ? `Activity: ${cache.activity.status}` : null,
      });
    } catch {}
    return markers.sort((a, b) => a.date - b.date);
  };

  const buildPortfolioMarkers = (deals) => {
    const markers = [];
    deals.forEach(d => {
      const inv = d.investment || {};
      const cb = getCB(inv);
      if (!cb || !inv.date) return;
      markers.push({
        date: new Date(inv.date),
        type: d.isFund ? 'round' : 'invest',
        label: d.companyName,
        sub: [fmtC(cb), inv.vehicle || null].filter(Boolean).join(' · '),
      });
    });
    return markers.sort((a, b) => a.date - b.date);
  };

  const valuePoints = mode === 'deal' ? buildDealTimeline(deal) : buildPortfolioTimeline(allDeals || []);
  const markers = mode === 'deal' ? buildMarkers(deal) : buildPortfolioMarkers(allDeals || []);

  if (valuePoints.length < 2) return null;

  // ── Timeframe filter ─────────────────────────────────────────────────────────
  const now = new Date();
  const cutoff = timeframe === '3m' ? new Date(now - 90*864e5)
    : timeframe === '6m' ? new Date(now - 180*864e5)
    : timeframe === '1y' ? new Date(now - 365*864e5)
    : timeframe === 'ytd' ? new Date(now.getFullYear(), 0, 1)
    : null;

  // When filtering, always prepend the last point before the cutoff so the
  // line has a starting value even if no events happened in the window
  const filtered = (() => {
    if (!cutoff) return valuePoints;
    const inWindow = valuePoints.filter(p => p.date >= cutoff);
    const beforeWindow = valuePoints.filter(p => p.date < cutoff);
    if (beforeWindow.length === 0) return inWindow.length >= 1 ? inWindow : valuePoints;
    // Start from the last known value just before the cutoff
    const anchor = { ...beforeWindow[beforeWindow.length - 1], date: cutoff };
    return [anchor, ...inWindow];
  })();

  if (filtered.length < 1) return null;

  const filteredMarkers = cutoff ? markers.filter(m => m.date >= cutoff) : markers;

  // ── Scale ────────────────────────────────────────────────────────────────────
  const minDate = filtered[0].date.getTime();
  const maxDate = filtered[filtered.length - 1].date.getTime();
  const dateRange = maxDate - minDate || 1;
  const vals = filtered.map(p => p.value);
  const minVal = Math.min(...vals) * 0.9;
  const maxVal = Math.max(...vals) * 1.08;
  const valRange = maxVal - minVal || 1;

  const xOf = (date) => PL + ((date.getTime() - minDate) / dateRange) * CW;
  const yOf = (val) => PT + ((maxVal - val) / valRange) * CH;

  // Build step line (hold previous value until new event)
  const stepPts = [];
  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i];
    if (i > 0) stepPts.push([xOf(p.date), yOf(filtered[i-1].value)]); // horizontal step
    stepPts.push([xOf(p.date), yOf(p.value)]);
  }
  const linePath = stepPts.map(([x,y], i) => `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = linePath + ` L${xOf(filtered[filtered.length-1].date).toFixed(1)},${(PT+CH).toFixed(1)} L${PL},${(PT+CH).toFixed(1)} Z`;

  // Y axis labels
  const yTicks = [minVal + valRange*0.1, minVal + valRange*0.5, minVal + valRange*0.9];

  // Current value + change
  const startVal = filtered[0].value;
  const endVal = filtered[filtered.length - 1].value;
  const change = endVal - startVal;
  const changePct = startVal > 0 ? ((change / startVal) * 100).toFixed(1) : 0;
  const isUp = change >= 0;

  const MARKER_ICONS = {
    round: '💰', update: '✉', signal: '✦', risk: '⚠', invest: '●',
  };
  const MARKER_COLORS = {
    round: '#5B6DC4', update: '#10b981', signal: '#f59e0b', risk: '#ef4444', invest: '#9ca3af',
  };

  return (
    <div style={{ background: 'white', borderRadius: 16, padding: '16px 20px', marginBottom: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <p style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: .5, marginBottom: 2 }}>
            {mode === 'deal' ? 'Implied value' : 'Portfolio value'}
          </p>
          <p style={{ fontSize: 15, fontWeight: 700, color: '#111827', letterSpacing: '-0.3px' }}>{fmtC(endVal)}</p>
          <p style={{ fontSize: 12, fontWeight: 600, color: isUp ? '#10b981' : '#ef4444', marginTop: 2 }}>
            {isUp ? '▲' : '▼'} {fmtC(Math.abs(change))} ({Math.abs(changePct)}%) {timeframe === 'all' ? 'all time' : timeframe.toUpperCase()}
          </p>
        </div>
        {/* Timeframe selector */}
        <div style={{ display: 'flex', gap: 4, background: '#f3f4f6', borderRadius: 10, padding: 3 }}>
          {['3m','6m','ytd','1y','all'].map(tf => (
            <button key={tf} onClick={() => setTimeframe(tf)}
              style={{ padding: '3px 8px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                background: timeframe === tf ? 'white' : 'transparent',
                color: timeframe === tf ? '#111827' : '#9ca3af',
                boxShadow: timeframe === tf ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }}>
              {tf === 'all' ? 'All time' : tf.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div style={{ position: 'relative', overflowX: 'auto' }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <linearGradient id="valueGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#C9A84C" stopOpacity="0.18"/>
              <stop offset="100%" stopColor="#C9A84C" stopOpacity="0.02"/>
            </linearGradient>
          </defs>

          {/* Y axis gridlines + labels */}
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={PL} y1={yOf(v)} x2={W-PR} y2={yOf(v)} stroke="#f3f4f6" strokeWidth="1"/>
              <text x={PL-6} y={yOf(v)+4} textAnchor="end" fontSize="8" fill="#c4c4c4">{fmtC(v)}</text>
            </g>
          ))}

          {/* X axis baseline */}
          <line x1={PL} y1={PT+CH} x2={W-PR} y2={PT+CH} stroke="#e5e7eb" strokeWidth="1"/>

          {/* Area fill */}
          <path d={areaPath} fill="url(#valueGrad)"/>

          {/* Step line */}
          <path d={linePath} fill="none" stroke="#C9A84C" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>

          {/* End dot */}
          <circle cx={xOf(filtered[filtered.length-1].date)} cy={yOf(endVal)} r="3" fill="#C9A84C"/>

          {/* Event markers — placed on the value line at their date */}
          {filteredMarkers.map((m, i) => {
            const mx = xOf(m.date);
            // Find the value on the step line at this marker's date
            const valAtDate = (() => {
              const before = filtered.filter(p => p.date <= m.date);
              return before.length ? before[before.length-1].value : filtered[0].value;
            })();
            const my = yOf(valAtDate);
            const isHov = hovered === i;
            // Clamp tooltip x so it doesn't overflow
            const ttX = Math.max(PL, Math.min(mx - 65, W - PR - 130));
            const ttY = Math.max(PT + 4, my - 54);
            return (
              <g key={i} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
                {/* Vertical dashed line from marker to x-axis */}
                <line x1={mx} y1={my} x2={mx} y2={PT+CH} stroke={MARKER_COLORS[m.type]} strokeWidth="1" strokeDasharray="3,3" strokeOpacity="0.5"/>
                {/* Dot on the value line */}
                <circle cx={mx} cy={my} r={isHov ? 5 : 3.5} fill={MARKER_COLORS[m.type]} stroke="white" strokeWidth="1.5"/>
                {/* Tooltip on hover */}
                {isHov && (
                  <g>
                    <rect x={ttX} y={ttY} width="130" height={m.sub ? 46 : 36} rx="5" fill="white"
                      stroke={MARKER_COLORS[m.type]} strokeWidth="0.8" strokeOpacity="0.4"
                      style={{filter:'drop-shadow(0 2px 8px rgba(0,0,0,.14))'}}/>
                    <text x={ttX+8} y={ttY+12} fontSize="7.5" fontWeight="700" fill={MARKER_COLORS[m.type]} style={{textTransform:'uppercase',letterSpacing:'0.5px'}}>
                      {m.type === 'round' ? 'Funding round' : m.type === 'update' ? 'Founder update' : m.type === 'signal' ? 'Signal' : m.type === 'risk' ? 'Risk' : 'Event'}
                    </text>
                    <text x={ttX+8} y={ttY+24} fontSize="9" fontWeight="600" fill="#111827">
                      {(m.label||'').substring(0,24)}{(m.label||'').length>24?'…':''}
                    </text>
                    {m.sub && <text x={ttX+8} y={ttY+34} fontSize="8" fill="#6b7280">{m.sub.substring(0,26)}</text>}
                    <text x={ttX+8} y={ttY+(m.sub?46:36)-5} fontSize="7" fill="#9ca3af">
                      {m.date.toLocaleDateString('en-US',{month:'short',year:'numeric'})}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* X axis date labels — small, 3 evenly spaced */}
          {[filtered[0], filtered[Math.floor(filtered.length/2)], filtered[filtered.length-1]].map((p, i) => (
            <text key={i} x={xOf(p.date)} y={H-3} textAnchor="middle" fontSize="7" fill="#c4c4c4">
              {p.date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
            </text>
          ))}
        </svg>
      </div>

      {/* Legend */}
      {filteredMarkers.length > 0 && (
        <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap' }}>
          {['round','invest','update','signal','risk'].filter(t => filteredMarkers.some(m=>m.type===t)).map(t => (
            <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6b7280' }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: MARKER_COLORS[t], display: 'inline-block' }}/>
              {t === 'round' ? 'Fund / round' : t === 'invest' ? 'Investment' : t === 'update' ? 'Founder update' : t === 'signal' ? 'Signal' : 'Risk'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

// ── SIGNALS SECTION ───────────────────────────────────────────────────────────
const SignalsSection = ({ deal, onUpdate }) => {
  const [fetchState, setFetchState] = useState('idle');
  const [data, setData] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);

  // Load from cache on mount
  useEffect(() => {
    const cache = loadSignalCache();
    const cached = cache[deal.id];
    if (cached && (Date.now() - new Date(cached.fetchedAt).getTime()) < SIGNAL_TTL) {
      setData(cached);
      setLastFetched(new Date(cached.fetchedAt));
      setFetchState('done');
    }
  }, [deal.id]);

  const doFetch = async () => {
    setFetchState('loading');
    try {
      const result = await fetchExternalSignals(deal);
      const entry = { ...result, fetchedAt: new Date().toISOString() };
      const cache = loadSignalCache();
      cache[deal.id] = entry;
      saveSignalCache(cache);
      setData(entry);
      setLastFetched(new Date());
      setFetchState('done');

      if (!onUpdate) return;
      let updated = { ...deal };

      // Funding rounds → fundraiseHistory
      if (result.momentum?.fundingRounds?.length > 0) {
        const existing = new Set((deal.fundraiseHistory || []).map(r => r.roundName?.toLowerCase()));
        const newRounds = result.momentum.fundingRounds
          .filter(r => r.roundName && !existing.has(r.roundName.toLowerCase()))
          .map(r => ({
            id: genId(),
            roundName: r.roundName,
            date: r.date ? new Date(r.date).toISOString() : new Date().toISOString(),
            amountRaised: r.amountRaised || null,
            postMoneyVal: r.postMoneyVal || null,
            leadInvestor: r.leadInvestor || '',
            followOns: r.followOns || [],
            source: r.source || 'External search',
            sourceUrl: r.sourceUrl || null,
            fromAgent: true,
          }));
        if (newRounds.length) {
          updated.fundraiseHistory = [...(updated.fundraiseHistory || []), ...newRounds]
            .sort((a, b) => new Date(a.date) - new Date(b.date));
        }
      }

      // Revenue data → revenueLog
      if (result.momentum?.revenueData?.length > 0) {
        const existingDates = new Set((deal.revenueLog || []).map(r => r.date?.substring(0, 7)));
        const newRevenue = result.momentum.revenueData
          .filter(r => r.date && !existingDates.has(r.date?.substring(0, 7)))
          .map(r => ({
            id: genId(),
            date: new Date(r.date).toISOString(),
            metric: r.metric || 'Revenue',
            value: r.value || '',
            numericValue: r.numericValue || null,
            source: r.source || 'External search',
            sourceUrl: r.sourceUrl || null,
            fromAgent: true,
          }));
        if (newRevenue.length) {
          updated.revenueLog = [...(updated.revenueLog || []), ...newRevenue]
            .sort((a, b) => new Date(a.date) - new Date(b.date));
        }
      }

      // Momentum + activity + risk signals → milestones
      const allSignals = [
        ...(result.momentum?.signals || []),
        ...(result.activity?.signals || []),
        ...(result.risk?.signals || []).map(s => ({ ...s, sentiment: 'negative' })),
      ];
      if (allSignals.length > 0) {
        const existing = new Set((deal.milestones || []).map(m => m.title));
        const newMs = allSignals
          .filter(s => s.title && !existing.has(s.title))
          .slice(0, 8)
          .map(s => ({
            id: genId(),
            type: s.type === 'partnership' ? 'partnership' : s.type === 'product' ? 'product' : 'update',
            title: s.title,
            description: s.description || '',
            date: s.date ? new Date(s.date).toISOString() : new Date().toISOString(),
            source: s.source,
            sourceUrl: s.sourceUrl || null,
            fromAgent: true,
            sentiment: s.sentiment || 'neutral',
          }));
        if (newMs.length) updated.milestones = [...(updated.milestones || []), ...newMs];
      }

      onUpdate(updated);
    } catch (e) {
      console.error('Signal fetch failed:', e);
      setFetchState('error');
    }
  };

  const activity = data?.activity;
  const momentum = data?.momentum;
  const risk = data?.risk;
  const hasData = fetchState === 'done' && data;

  const SIG_CFG = {
    product:    { color: '#f59e0b', bg: '#fffbeb', label: 'Product' },
    partnership:{ color: '#10b981', bg: '#f0fdf4', label: 'Partnership' },
    team:       { color: '#7c3aed', bg: '#f5f3ff', label: 'Team' },
    award:      { color: '#5B6DC4', bg: '#eef2ff', label: 'Award' },
    news:       { color: '#78716c', bg: '#f5f5f4', label: 'News' },
    silence:    { color: '#ef4444', bg: '#fef2f2', label: 'Silence' },
    founder_departure: { color: '#ef4444', bg: '#fef2f2', label: 'Founder left' },
    pivot:      { color: '#f59e0b', bg: '#fffbeb', label: 'Pivot' },
    layoffs:    { color: '#ef4444', bg: '#fef2f2', label: 'Layoffs' },
    domain:     { color: '#ef4444', bg: '#fef2f2', label: 'Domain issue' },
    other:      { color: '#78716c', bg: '#f5f5f4', label: 'Risk' },
  };

  return (
    <div style={{ background:'white', borderRadius:16, padding:20, marginBottom:12 }}>
      {/* Header row */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: hasData ? 14 : 0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span style={{ fontWeight:600, fontSize:14, color:'#111827' }}>External Signals</span>
          {lastFetched && <span style={{ fontSize:11, color:'#9ca3af' }}>· updated {dAgo(lastFetched)}d ago</span>}
        </div>
        <button onClick={doFetch} disabled={fetchState === 'loading'}
          style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', borderRadius:8, fontSize:12, fontWeight:600,
            background: fetchState === 'loading' ? '#f3f4f6' : '#eef2ff',
            color: fetchState === 'loading' ? '#9ca3af' : '#5B6DC4', border:'none',
            cursor: fetchState === 'loading' ? 'not-allowed' : 'pointer' }}>
          {fetchState === 'loading'
            ? <><div style={{ width:10, height:10, border:'1.5px solid #d1d5db', borderTopColor:'#5B6DC4', borderRadius:'50%', animation:'spin 0.8s linear infinite' }}/> Searching…</>
            : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.12-7.51"/></svg>{hasData ? 'Refresh' : 'Fetch signals'}</>
          }
        </button>
      </div>

      {/* Idle */}
      {fetchState === 'idle' && (
        <p style={{ fontSize:13, color:'#9ca3af', textAlign:'center', padding:'12px 0' }}>
          Search for activity, momentum, and risk signals across the web.
        </p>
      )}

      {/* Error */}
      {fetchState === 'error' && (
        <p style={{ fontSize:13, color:'#ef4444', textAlign:'center', padding:'8px 0' }}>
          Failed to fetch — check connection and try again.
        </p>
      )}

      {hasData && (
        <>
          {/* 3-bucket status bar */}
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
            <ActivityDot status={activity?.status}/>
            <MomentumDot trend={momentum?.trend}/>
            <RiskDot level={risk?.level}/>
          </div>

          {/* Summary */}
          {data.summary && (
            <div style={{ background:'#f9fafb', borderRadius:10, padding:'10px 14px', marginBottom:12 }}>
              <p style={{ fontSize:13, color:'#374151', lineHeight:1.6 }}>{data.summary}</p>
              {activity?.websiteStatus && activity.websiteStatus !== 'unknown' && (
                <p style={{ fontSize:11, color:'#9ca3af', marginTop:6 }}>
                  <span style={{ width:6, height:6, borderRadius:99, background: activity.websiteStatus==='active'?'#10b981':activity.websiteStatus==='down'?'#ef4444':'#f59e0b', display:'inline-block', marginRight:5 }}/>
                  Website {activity.websiteStatus}{activity.websiteSummary ? ` — ${activity.websiteSummary}` : ''}
                </p>
              )}
            </div>
          )}

          {/* Auto-populated banner */}
          {(momentum?.fundingRounds?.length > 0 || momentum?.revenueData?.length > 0) && (
            <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:10, padding:'8px 14px', marginBottom:12, display:'flex', gap:14, flexWrap:'wrap', alignItems:'center' }}>
              <span style={{ fontSize:11, color:'#166534', fontWeight:600 }}>✓ Auto-populated:</span>
              {momentum.fundingRounds?.length > 0 && <span style={{ fontSize:11, color:'#166534' }}>{momentum.fundingRounds.length} funding round{momentum.fundingRounds.length>1?'s':''} → Fundraise History</span>}
              {momentum.revenueData?.length > 0 && <span style={{ fontSize:11, color:'#166534' }}>{momentum.revenueData.length} revenue point{momentum.revenueData.length>1?'s':''} → Revenue Log</span>}
            </div>
          )}

          {/* Risk alert */}
          {risk?.level === 'alert' && risk.signals?.length > 0 && (
            <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:10, padding:'10px 14px', marginBottom:12 }}>
              <p style={{ fontSize:12, fontWeight:600, color:'#dc2626', marginBottom:6 }}>⚠ Risk signals detected</p>
              {risk.signals.map((s, i) => (
                <div key={i} style={{ fontSize:12, color:'#7f1d1d', marginBottom: i < risk.signals.length-1 ? 4 : 0 }}>
                  <span style={{ fontWeight:500 }}>{s.title}</span>{s.description ? ` — ${s.description}` : ''}
                </div>
              ))}
            </div>
          )}

          {/* Check-in recommendation */}
          {data.checkInRecommended && (
            <div style={{ background:'#fffbeb', border:'1px solid #fde68a', borderRadius:10, padding:'8px 12px', marginBottom:12, display:'flex', alignItems:'center', gap:8 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <p style={{ fontSize:12, color:'#92400e' }}>{data.checkInReason}</p>
            </div>
          )}

          {/* Momentum signals */}
          {momentum?.signals?.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <p style={{ fontSize:11, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.6, marginBottom:8 }}>Momentum</p>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {momentum.signals.map((s, i) => {
                  const cfg = SIG_CFG[s.type] || SIG_CFG.news;
                  return (
                    <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'10px 12px', borderRadius:12, background:cfg.bg }}>
                      <Pill color={cfg.color} bg={cfg.color+'18'}>{cfg.label}</Pill>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ fontSize:13, fontWeight:500, color:'#111827', marginBottom:2 }}>{s.title}</p>
                        <p style={{ fontSize:12, color:'#6b7280', lineHeight:1.5 }}>{s.description}</p>
                        {s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize:11, color:'#5B6DC4', marginTop:3, display:'inline-block' }}>Source →</a>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Activity signals */}
          {activity?.signals?.length > 0 && (
            <div style={{ marginBottom: risk?.signals?.filter(s => risk.level !== 'alert').length ? 12 : 0 }}>
              <p style={{ fontSize:11, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.6, marginBottom:8 }}>Activity</p>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {activity.signals.map((s, i) => (
                  <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'10px 12px', borderRadius:12, background:'#f5f5f4' }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ fontSize:13, fontWeight:500, color:'#111827', marginBottom:2 }}>{s.title}</p>
                      <p style={{ fontSize:12, color:'#6b7280', lineHeight:1.5 }}>{s.description}</p>
                      {s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize:11, color:'#5B6DC4', marginTop:3, display:'inline-block' }}>Source →</a>}
                    </div>
                    {s.date && <span style={{ fontSize:11, color:'#9ca3af', flexShrink:0 }}>{s.date}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Watch-level risk signals (not already shown as alert) */}
          {risk?.level === 'watch' && risk.signals?.length > 0 && (
            <div>
              <p style={{ fontSize:11, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.6, marginBottom:8 }}>Risk</p>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {risk.signals.map((s, i) => {
                  const cfg = SIG_CFG[s.type] || SIG_CFG.other;
                  return (
                    <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'10px 12px', borderRadius:12, background:cfg.bg }}>
                      <Pill color={cfg.color} bg={cfg.color+'18'}>{cfg.label}</Pill>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ fontSize:13, fontWeight:500, color:'#111827', marginBottom:2 }}>{s.title}</p>
                        <p style={{ fontSize:12, color:'#6b7280', lineHeight:1.5 }}>{s.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};


// ── INVESTMENT MEMO ───────────────────────────────────────────────────────────
// Written once at the moment of decision. The thesis. Editable anytime.
// ── PRIMARY INSIGHT ───────────────────────────────────────────────────────────
// The most valuable section. Paste founder emails, call notes, or upload docs.
// Claude extracts structured insights — confirm before saving to deal.
const PrimaryInsight = ({ deal, onUpdate, setToast }) => {
  const [open, setOpen] = useState(true);
  const [inputMode, setInputMode] = useState(null); // null | 'text' | 'file'
  const [draft, setDraft] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(null); // pending confirmation
  const [approved, setApproved] = useState({}); // which items user approved
  const fileRef = useRef(null);
  const updates = (deal.founderUpdates || []).sort((a,b) => new Date(b.date) - new Date(a.date));

  const extract = async (content) => {
    if (!content?.trim()) return;
    setExtracting(true);
    setInputMode(null);
    try {
      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          dealName: deal.companyName,
          existingData: { revenueLog: deal.revenueLog, fundraiseHistory: deal.fundraiseHistory },
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      // Pre-approve all findings
      const initial = {};
      (result.revenuePoints||[]).forEach((_,i) => initial[`rev_${i}`] = true);
      (result.fundingSignals||[]).forEach((_,i) => initial[`fund_${i}`] = true);
      (result.risks||[]).forEach((_,i) => initial[`risk_${i}`] = true);
      (result.positives||[]).forEach((_,i) => initial[`pos_${i}`] = true);
      (result.teamChanges||[]).forEach((_,i) => initial[`team_${i}`] = true);
      setExtracted({ ...result, rawContent: content });
      setApproved(initial);
    } catch (e) {
      setToast('Extraction failed — saved as plain note');
      saveRaw(content);
    } finally {
      setExtracting(false);
    }
  };

  const saveRaw = (content) => {
    const entry = { id: genId(), type: 'text', content, date: new Date().toISOString() };
    onUpdate({ ...deal, founderUpdates: [...(deal.founderUpdates||[]), entry] });
    setDraft('');
  };

  const confirmExtracted = () => {
    if (!extracted) return;
    let updated = { ...deal };
    const now = new Date().toISOString();

    // Save raw entry
    const entry = { id: genId(), type: 'text', content: extracted.rawContent, date: now,
      sentiment: extracted.sentiment, keyTakeaway: extracted.keyTakeaway };
    updated.founderUpdates = [...(updated.founderUpdates||[]), entry];
    updated.investment = { ...(updated.investment||{}), lastUpdateReceived: now };

    // Apply approved revenue points
    (extracted.revenuePoints||[]).forEach((r, i) => {
      if (!approved[`rev_${i}`]) return;
      const date = r.date ? new Date(r.date).toISOString() : now;
      const existingDates = new Set((updated.revenueLog||[]).map(x => x.date?.substring(0,7)));
      if (existingDates.has(date.substring(0,7))) return;
      updated.revenueLog = [...(updated.revenueLog||[]),
        { id: genId(), date, metric: r.metric, value: r.value, numericValue: r.numericValue, source: 'Founder update', fromPrimary: true }
      ].sort((a,b) => new Date(a.date)-new Date(b.date));
    });

    // Apply approved funding signals
    (extracted.fundingSignals||[]).forEach((f, i) => {
      if (!approved[`fund_${i}`]) return;
      if (f.type === 'active_raise' || f.type === 'exploring') {
        updated.activeRaise = {
          roundName: f.roundName || '',
          targetAmount: f.amount || null,
          leadInvestor: f.leadInvestor || '',
          leadStatus: f.leadInvestor ? 'rumored' : 'none',
          participants: (f.participants||[]).join(', '),
          timeline: f.timeline || '',
          dilutionPct: '20',
        };
        updated.monitoring = { ...(updated.monitoring||{}), fundraisingStatus: 'raising' };
      } else if (f.type === 'closed_round') {
        const round = {
          id: genId(), roundName: f.roundName||'Unknown round', date: now,
          amountRaised: f.amount||null, leadInvestor: f.leadInvestor||null,
          followOns: f.participants||[], source: 'Founder update', fromPrimary: true,
        };
        updated.fundraiseHistory = [...(updated.fundraiseHistory||[]), round];
      }
    });

    // Apply risks + positives + team changes as milestones
    const newMilestones = [];
    const existing = new Set((updated.milestones||[]).map(m => m.title));
    (extracted.risks||[]).forEach((r, i) => {
      if (!approved[`risk_${i}`] || existing.has(r.title)) return;
      newMilestones.push({ id: genId(), type: 'update', title: r.title, description: r.description,
        date: now, sentiment: 'negative', fromPrimary: true });
    });
    (extracted.positives||[]).forEach((p, i) => {
      if (!approved[`pos_${i}`] || existing.has(p.title)) return;
      newMilestones.push({ id: genId(), type: 'update', title: p.title, description: p.description,
        date: now, sentiment: 'positive', fromPrimary: true });
    });
    (extracted.teamChanges||[]).forEach((t, i) => {
      if (!approved[`team_${i}`] || existing.has(t.title)) return;
      newMilestones.push({ id: genId(), type: 'update', title: `${t.type === 'hire' ? 'New hire' : t.type === 'departure' ? 'Departure' : 'Promotion'}: ${t.role}`,
        description: t.description, date: now, sentiment: t.type === 'departure' ? 'negative' : 'positive', fromPrimary: true });
    });
    if (newMilestones.length) updated.milestones = [...(updated.milestones||[]), ...newMilestones];

    onUpdate(updated);
    setExtracted(null);
    setApproved({});
    setDraft('');
    setToast('Primary insight saved');
  };

  const toggle = (key) => setApproved(prev => ({ ...prev, [key]: !prev[key] }));

  const sentColor = { positive: '#10b981', negative: '#ef4444', neutral: '#9ca3af', mixed: '#f59e0b' };

  return (
    <div style={{ background: 'white', borderRadius: 16, overflow: 'hidden', marginBottom: 12 }}>
      <button onClick={() => setOpen(v => !v)}
        style={{ width: '100%', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Primary Insight</span>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>founder updates · call notes · emails</span>
          {updates.length > 0 && <span style={{ fontSize: 12, color: '#9ca3af' }}>({updates.length})</span>}
        </div>
        <span style={{ color: '#9ca3af', fontSize: 11 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && <div style={{ padding: '0 20px 20px', borderTop: '1px solid #f3f4f6' }}>

        {/* Input buttons */}
        {!inputMode && !extracting && !extracted && (
          <div style={{ display: 'flex', gap: 8, paddingTop: 14, marginBottom: updates.length ? 16 : 0 }}>
            <button onClick={() => setInputMode('text')}
              style={{ flex: 1, padding: '10px', background: '#eef2ff', color: '#5B6DC4', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              Paste update / notes
            </button>
            <button onClick={() => fileRef.current?.click()}
              style={{ flex: 1, padding: '10px', background: '#f0fdf4', color: '#10b981', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload file
            </button>
            <input ref={fileRef} type="file" accept=".txt,.pdf,.md,.eml" style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => extract(ev.target.result);
                reader.readAsText(file);
                e.target.value = '';
              }}/>
          </div>
        )}

        {/* Text input */}
        {inputMode === 'text' && (
          <div style={{ paddingTop: 14 }}>
            <textarea value={draft} onChange={e => setDraft(e.target.value)} autoFocus
              placeholder="Paste a founder email, call notes, or any update here... Claude will extract revenue figures, funding signals, risks, and key highlights for you to confirm."
              rows={8} style={{ width: '100%', padding: '10px 12px', border: '1px solid #5B6DC4', borderRadius: 12, fontSize: 13, resize: 'vertical', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.7 }}/>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button onClick={() => extract(draft)} disabled={draft.trim().length < 10}
                style={{ flex: 2, padding: '9px', background: '#5B6DC4', color: 'white', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: draft.trim().length >= 10 ? 1 : .4 }}>
                Extract insights
              </button>
              <button onClick={() => saveRaw(draft)} disabled={draft.trim().length < 5}
                style={{ flex: 1, padding: '9px', background: '#f3f4f6', color: '#6b7280', border: 'none', borderRadius: 10, fontWeight: 500, fontSize: 13, cursor: 'pointer', opacity: draft.trim().length >= 5 ? 1 : .4 }}>
                Save as-is
              </button>
              <button onClick={() => { setInputMode(null); setDraft(''); }}
                style={{ padding: '9px 14px', background: 'none', border: 'none', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Extracting spinner */}
        {extracting && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 0', color: '#6b7280' }}>
            <div style={{ width: 16, height: 16, border: '2px solid #e5e7eb', borderTopColor: '#5B6DC4', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }}/>
            <span style={{ fontSize: 13 }}>Extracting insights from update…</span>
          </div>
        )}

        {/* Confirmation card */}
        {extracted && !extracting && (
          <div style={{ paddingTop: 14 }}>
            {/* Key takeaway */}
            <div style={{ background: '#f9fafb', borderRadius: 12, padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: sentColor[extracted.sentiment] || '#9ca3af', display: 'inline-block', marginTop: 4, flexShrink: 0 }}/>
              <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, flex: 1 }}>{extracted.keyTakeaway || 'Update logged.'}</p>
            </div>

            {/* Extracted items to confirm */}
            {[
              ...(extracted.revenuePoints||[]).map((r,i) => ({
                key: `rev_${i}`, icon: '📈', label: 'Revenue data point',
                title: r.value, sub: `${r.metric} · ${r.date} · ${r.confidence} confidence`,
                color: '#10b981', bg: '#f0fdf4',
              })),
              ...(extracted.fundingSignals||[]).map((f,i) => ({
                key: `fund_${i}`, icon: '💰', label: f.type === 'active_raise' ? 'Active raise → Fundraise History' : 'Funding signal',
                title: `${f.roundName || 'Round'}${f.amount ? ` · ${fmtC(f.amount)}` : ''}`,
                sub: `${f.leadInvestor ? `Lead: ${f.leadInvestor} · ` : ''}${f.timeline || ''}`,
                color: '#5B6DC4', bg: '#eef2ff',
              })),
              ...(extracted.positives||[]).map((p,i) => ({
                key: `pos_${i}`, icon: '✦', label: 'Positive signal',
                title: p.title, sub: p.description,
                color: '#10b981', bg: '#f0fdf4',
              })),
              ...(extracted.risks||[]).map((r,i) => ({
                key: `risk_${i}`, icon: '⚠', label: `Risk · ${r.severity}`,
                title: r.title, sub: r.description,
                color: '#ef4444', bg: '#fef2f2',
              })),
              ...(extracted.teamChanges||[]).map((t,i) => ({
                key: `team_${i}`, icon: '👤', label: `Team · ${t.type}`,
                title: `${t.role}${t.name ? ` — ${t.name}` : ''}`, sub: t.description,
                color: '#7c3aed', bg: '#f5f3ff',
              })),
            ].length === 0 ? (
              <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: '8px 0' }}>No structured data found — update will be saved as a note.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                <p style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: .5, marginBottom: 2 }}>Confirm what to save</p>
                {[
                  ...(extracted.revenuePoints||[]).map((r,i) => ({
                    key: `rev_${i}`, icon: '📈', label: 'Revenue data point',
                    title: r.value, sub: `${r.metric} · ${r.date} · ${r.confidence} confidence`,
                    color: '#10b981', bg: '#f0fdf4',
                  })),
                  ...(extracted.fundingSignals||[]).map((f,i) => ({
                    key: `fund_${i}`, icon: '💰', label: f.type === 'active_raise' ? 'Active raise → Fundraise History' : 'Funding signal',
                    title: `${f.roundName || 'Round'}${f.amount ? ` · ${fmtC(f.amount)}` : ''}`,
                    sub: `${f.leadInvestor ? `Lead: ${f.leadInvestor} · ` : ''}${f.timeline || ''}`,
                    color: '#5B6DC4', bg: '#eef2ff',
                  })),
                  ...(extracted.positives||[]).map((p,i) => ({
                    key: `pos_${i}`, icon: '✦', label: 'Positive signal',
                    title: p.title, sub: p.description,
                    color: '#10b981', bg: '#f0fdf4',
                  })),
                  ...(extracted.risks||[]).map((r,i) => ({
                    key: `risk_${i}`, icon: '⚠', label: `Risk · ${r.severity}`,
                    title: r.title, sub: r.description,
                    color: '#ef4444', bg: '#fef2f2',
                  })),
                  ...(extracted.teamChanges||[]).map((t,i) => ({
                    key: `team_${i}`, icon: '👤', label: `Team · ${t.type}`,
                    title: `${t.role}${t.name ? ` — ${t.name}` : ''}`, sub: t.description,
                    color: '#7c3aed', bg: '#f5f3ff',
                  })),
                ].map(item => (
                  <div key={item.key} onClick={() => toggle(item.key)}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 12,
                      background: approved[item.key] ? item.bg : '#f9fafb',
                      border: `1.5px solid ${approved[item.key] ? item.color + '40' : '#e5e7eb'}`,
                      cursor: 'pointer', opacity: approved[item.key] ? 1 : 0.5 }}>
                    <div style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${approved[item.key] ? item.color : '#d1d5db'}`,
                      background: approved[item.key] ? item.color : 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                      {approved[item.key] && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span style={{ fontSize: 10, color: item.color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5 }}>{item.label}</span>
                      </div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 2 }}>{item.title}</p>
                      {item.sub && <p style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>{item.sub}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmExtracted}
                style={{ flex: 2, padding: '9px', background: '#5B6DC4', color: 'white', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                Save {Object.values(approved).filter(Boolean).length} item{Object.values(approved).filter(Boolean).length !== 1 ? 's' : ''} + note
              </button>
              <button onClick={() => { setExtracted(null); setApproved({}); }}
                style={{ padding: '9px 14px', background: '#f3f4f6', color: '#6b7280', border: 'none', borderRadius: 10, fontSize: 13, cursor: 'pointer' }}>Discard</button>
            </div>
          </div>
        )}

        {/* Past updates log */}
        {updates.length > 0 && !extracted && !extracting && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: inputMode ? 0 : 4 }}>
            {updates.slice(0, 5).map((u, i) => (
              <div key={u.id || i} style={{ padding: '10px 12px', borderRadius: 12, background: '#f9fafb', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                {u.sentiment && <span style={{ width: 6, height: 6, borderRadius: 99, background: sentColor[u.sentiment] || '#9ca3af', display: 'inline-block', marginTop: 5, flexShrink: 0 }}/>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {u.keyTakeaway && <p style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 3 }}>{u.keyTakeaway}</p>}
                  <p style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{u.content}</p>
                </div>
                <span style={{ fontSize: 11, color: '#d1d5db', flexShrink: 0 }}>{dAgo(u.date)}d</span>
              </div>
            ))}
          </div>
        )}
      </div>}
    </div>
  );
};


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
  const deleteEvent=(id)=>onUpdate({...deal,liquidityEvents:events.filter(e=>e.id!==id)});
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
            <div style={{flex:1}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}><span style={{fontWeight:600,fontSize:13,color:c.c}}>{c.l}</span><span style={{fontSize:12,color:'#9ca3af'}}>{new Date(ev.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span></div>
              <p style={{fontWeight:700,fontSize:14,color:c.c,marginTop:2}}>{ev.type==='writedown'?`−${fmtC(amt)}`:`+${fmtC(amt)}`}</p>
              {ev.notes&&<p style={{fontSize:12,color:'#6b7280',marginTop:4}}>{ev.notes}</p>}
            </div>
            <button onClick={()=>deleteEvent(ev.id)} style={{color:'#d1d5db',background:'none',border:'none',cursor:'pointer',padding:4,alignSelf:'flex-start'}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
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
  const staleness=getStaleness(deal);
  const dSinceUpd=inv.lastUpdateReceived?dAgo(inv.lastUpdateReceived):null;
  const dUntilNext=inv.nextUpdateExpected?dUntil(inv.nextUpdateExpected):null;
  const overdue=dUntilNext!==null&&dUntilNext<-7;
  const health=calcHealth(deal,[]);
  const [generatingMemo, setGeneratingMemo] = useState(false);
  const [memo, setMemo] = useState(deal.memo || '');
  const [showMemo, setShowMemo] = useState(!!deal.memo);

  const generateMemo = async () => {
    setGeneratingMemo(true);
    setShowMemo(true);
    try {
      const signalCache = loadSignalCache()[deal.id];
      const context = {
        company: deal.companyName,
        stage: deal.stage,
        industry: deal.industry,
        invested: getCB(inv),
        vehicle: inv.vehicle,
        date: inv.date,
        cap: deal.terms?.cap,
        revenueLog: deal.revenueLog,
        fundraiseHistory: deal.fundraiseHistory,
        founderUpdates: (deal.founderUpdates||[]).slice(0,3).map(u=>u.content?.substring(0,500)),
        signals: signalCache ? { activity: signalCache.activity?.status, momentum: signalCache.momentum?.trend, risk: signalCache.risk?.level, summary: signalCache.summary } : null,
        milestones: (deal.milestones||[]).slice(0,5),
      };
      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `Generate an investment memo for: ${JSON.stringify(context)}`,
          dealName: deal.companyName,
          existingData: {},
          mode: 'memo',
        }),
      });
      // Use signals API instead for memo generation
      const memoResp = await fetch('/api/memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deal: context }),
      });
      if (!memoResp.ok) throw new Error('Memo generation failed');
      const { memo: generated } = await memoResp.json();
      setMemo(generated);
      onUpdate({ ...deal, memo: generated });
      setToast('Investment memo generated');
    } catch (e) {
      console.error('Memo generation failed:', e);
      setToast('Memo generation failed — check API connection');
    } finally {
      setGeneratingMemo(false);
    }
  };

  // Ownership + implied value: fundraise history takes precedence over manual fields
  const currentOwnership = getCurrentOwnership(deal);
  const historyIV = getHistoryImpliedValue(deal);
  const iv = historyIV || calcIV(deal);
  const cb = getCB(inv);
  const moic = cb>0 ? iv/cb : null;
  const markup = calcMarkup(deal);
  const projected = getProjected(deal);

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
    const [showThesis, setShowThesis] = useState(false);
    const [showPromote, setShowPromote] = useState(false);

    return (
      <div style={{padding:20}}>
        {showPromote&&<PromoteModal deal={deal} onClose={()=>setShowPromote(false)} onPromote={d=>{onUpdate(d);setToast(`${d.companyName} moved to portfolio`);}}/>}

        {/* Header */}
        <div style={C.card}>
          <div style={{display:'flex',alignItems:'flex-start',gap:14,marginBottom:deal.overview?12:0}}>
            <CompanyLogo name={deal.companyName} website={deal.website} size={52} radius={14} fallbackBg="#f59e0b" fallbackColor="white"/>
            <div style={{flex:1}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                <h2 style={{fontSize:20,fontWeight:800,color:'#111827'}}>{deal.companyName}</h2>
                {deal.website&&<a href={deal.website} target="_blank" rel="noopener noreferrer" style={{color:'#9ca3af'}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>}
              </div>
              <p style={{fontSize:13,color:'#6b7280',marginBottom:4}}>{deal.stage} · {deal.industry}</p>
              {deal.monitoring?.fundraisingStatus==='raising'&&<Pill color="#1d4ed8" bg="#eff6ff">Raising now</Pill>}
            </div>
            <button onClick={()=>setShowPromote(true)} style={{flexShrink:0,padding:'8px 14px',background:'#10b981',color:'white',border:'none',borderRadius:10,fontWeight:700,fontSize:13,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
              Invest
            </button>
          </div>
          {deal.overview&&<p style={{fontSize:14,color:'#374151',lineHeight:1.6,marginBottom:deal.founders?.length?12:0}}>{deal.overview}</p>}
          {deal.founders?.length>0&&<div style={{display:'flex',alignItems:'center',gap:8,paddingTop:12,borderTop:'1px solid #f3f4f6'}}>
            <span style={{fontSize:13,color:'#6b7280'}}>Founders:</span>
            {deal.founders.map((f,i)=><span key={i} style={{fontSize:13,color:'#374151',fontWeight:500}}>{f.name} <span style={{fontWeight:400,color:'#9ca3af'}}>({f.role})</span></span>)}
          </div>}
        </div>

        <ActiveRaiseCard deal={deal} onUpdate={onUpdate} setToast={setToast}/>

        {/* Revisit banner */}
        {revisitOverdue&&<div style={{padding:'10px 16px',background:'#fffbeb',border:'1px solid #fde68a',borderRadius:12,display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p style={{fontSize:13,color:'#92400e',fontWeight:500}}>Revisit date was {Math.abs(daysUntilRevisit)}d ago — time to update your view.</p>
        </div>}
        {daysUntilRevisit!==null&&!revisitOverdue&&daysUntilRevisit<=14&&<div style={{padding:'10px 16px',background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:12,display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p style={{fontSize:13,color:'#166534'}}>Revisit in {daysUntilRevisit} day{daysUntilRevisit!==1?'s':''}</p>
        </div>}

        {/* Traction metrics — same as invested */}
        <MetricsTracker deal={deal} onUpdate={onUpdate}/>

        <PrimaryInsight deal={deal} onUpdate={onUpdate} setToast={setToast}/>

        {/* Signals */}
        <SignalsSection deal={deal} onUpdate={onUpdate}/>

        {/* Known investors */}
        {(deal.coInvestors||[]).length>0&&<div style={C.card}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Known investors</span>
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

        {/* Documents */}
        <DocumentsSection deal={deal} onUpdate={onUpdate} setToast={setToast}/>

      </div>
    );
  }

  return (
    <div style={{padding:20}}>
      <div style={C.card}>
        <div style={{display:'flex',alignItems:'flex-start',gap:14,marginBottom:deal.overview?12:0}}>
          <CompanyLogo name={deal.companyName} website={deal.website} size={52} radius={14} fallbackBg="#f59e0b" fallbackColor="white"/>
          <div style={{flex:1}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
              <h2 style={{fontSize:20,fontWeight:800,color:'#111827'}}>{deal.companyName}</h2>
              {deal.website&&<a href={deal.website} target="_blank" rel="noopener noreferrer" style={{color:'#9ca3af'}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>}
            </div>
            <p style={{fontSize:13,color:'#6b7280',marginBottom:6}}>{deal.stage} · {deal.industry}</p>
            {(()=>{
              const cached = loadSignalCache()[deal.id];
              if (!cached) return null;
              return (
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  <ActivityDot status={cached.activity?.status}/>
                  <MomentumDot trend={cached.momentum?.trend}/>
                  <RiskDot level={cached.risk?.level}/>
                </div>
              );
            })()}
          </div>
          {/* Generate Memo button — top right */}
          <button onClick={generatingMemo ? undefined : generateMemo} disabled={generatingMemo}
            style={{flexShrink:0,padding:'7px 12px',background:generatingMemo?'#f3f4f6':'#f5f3ff',color:generatingMemo?'#9ca3af':'#7c3aed',border:`1px solid ${generatingMemo?'#e5e7eb':'#e9d5ff'}`,borderRadius:10,fontWeight:600,fontSize:12,cursor:generatingMemo?'not-allowed':'pointer',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}}>
            {generatingMemo
              ? <><div style={{width:10,height:10,border:'1.5px solid #d1d5db',borderTopColor:'#7c3aed',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/> Generating…</>
              : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>{memo ? 'Regenerate memo' : 'Generate memo'}</>
            }
          </button>
        </div>

        {/* Memo display — shows after generation */}
        {showMemo && memo && (
          <div style={{background:'#faf5ff',border:'1px solid #e9d5ff',borderRadius:12,padding:'12px 16px',marginBottom:12}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
              <span style={{fontSize:11,color:'#7c3aed',fontWeight:700,textTransform:'uppercase',letterSpacing:.6}}>Investment Memo</span>
              <button onClick={()=>setShowMemo(false)} style={{background:'none',border:'none',color:'#c4b5fd',cursor:'pointer',fontSize:11}}>hide</button>
            </div>
            <p style={{fontSize:13,color:'#374151',lineHeight:1.8,whiteSpace:'pre-wrap'}}>{memo}</p>
          </div>
        )}
        {!showMemo && memo && (
          <button onClick={()=>setShowMemo(true)} style={{fontSize:12,color:'#7c3aed',background:'none',border:'none',cursor:'pointer',padding:0,marginBottom:12,display:'block'}}>
            Show investment memo ↓
          </button>
        )}

        {deal.overview&&<p style={{fontSize:14,color:'#374151',lineHeight:1.6,marginBottom:12}}>{deal.overview}</p>}

        {/* Investment quick stats */}
        <div style={{display:'flex',gap:20,paddingTop:12,borderTop:'1px solid #f3f4f6',flexWrap:'wrap'}}>
          <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:2}}>Invested</p><p style={{fontSize:14,fontWeight:600,color:'#111827'}}>{fmtC(cb)}</p></div>
          <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:2}}>Vehicle</p><p style={{fontSize:14,fontWeight:600,color:'#111827'}}>{inv.vehicle||'—'}</p></div>
          <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:2}}>Date</p><p style={{fontSize:14,fontWeight:600,color:'#111827'}}>{inv.date?new Date(inv.date).toLocaleDateString('en-US',{month:'short',year:'numeric'}):'—'}</p></div>
          {inv.ownershipPercent&&<div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:2}}>Ownership</p><p style={{fontSize:14,fontWeight:600,color:'#111827'}}>{inv.ownershipPercent}%</p></div>}
        </div>

        {/* Founders */}
        {deal.founders?.length>0&&<div style={{display:'flex',alignItems:'center',gap:8,marginTop:12,paddingTop:12,borderTop:'1px solid #f3f4f6'}}>
          <span style={{fontSize:13,color:'#6b7280'}}>Founders:</span>
          {deal.founders.map((f,i)=><span key={i} style={{fontSize:13,color:'#374151',fontWeight:500}}>{f.name} <span style={{fontWeight:400,color:'#9ca3af'}}>({f.role})</span></span>)}
        </div>}

        {/* Co-investors on this round — collapsed by default */}
        {(()=>{
          const coInvs = deal.coInvestors||[];
          const [open, setOpen] = useState(false);
          return (
            <div style={{marginTop:12,paddingTop:12,borderTop:'1px solid #f3f4f6'}}>
              <button onClick={()=>setOpen(v=>!v)} style={{display:'flex',alignItems:'center',gap:8,background:'none',border:'none',cursor:'pointer',padding:0,width:'100%'}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                <span style={{fontSize:12,color:'#9ca3af',fontWeight:500}}>Co-investors on this round{coInvs.length>0?` (${coInvs.length})`:''}</span>
                <span style={{fontSize:10,color:'#d1d5db',marginLeft:'auto'}}>{open?'▲':'▼'}</span>
              </button>
              {open&&<div style={{marginTop:10}}>
                {coInvs.length===0&&<p style={{fontSize:12,color:'#d1d5db',fontStyle:'italic'}}>None logged — add from the Investors section below</p>}
                <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:coInvs.length?8:0}}>
                  {coInvs.map(ci=>{
                    const rc=ROLE_CFG[ci.role]||ROLE_CFG['co-investor'];
                    return <div key={ci.id} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 10px',borderRadius:99,background:rc.c+'12',border:`1px solid ${rc.c}30`}}>
                      <span style={{width:20,height:20,borderRadius:99,background:rc.c+'25',color:rc.c,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:10,flexShrink:0}}>{ci.name[0].toUpperCase()}</span>
                      <span style={{fontSize:12,fontWeight:500,color:'#374151'}}>{ci.name}</span>
                      {ci.fund&&ci.fund!==ci.name&&<span style={{fontSize:11,color:'#9ca3af'}}>· {ci.fund}</span>}
                      <Pill color={rc.c} bg={rc.c+'15'}>{rc.l}</Pill>
                    </div>;
                  })}
                </div>
              </div>}
            </div>
          );
        })()}
      </div>

      <ValueChart deal={deal} mode="deal"/>

      <ActiveRaiseCard deal={deal} onUpdate={onUpdate} setToast={setToast}/>

      <div style={C.card}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg><span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Valuation</span></div>
          <Pill>{getMethodLabel(method)}</Pill>
        </div>

        {/* Current row */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:12}}>
          <div><p style={C.label}>Cost basis</p><p style={C.val}>{fmtC(cb)}</p></div>
          <div><p style={C.label}>Implied value</p>
            {method==='mark-at-cost'
              ? <p style={{...C.val,color:'#9ca3af'}}>—</p>
              : <p style={{...C.val,color:iv>=cb?'#10b981':'#ef4444'}}>{fmtC(iv)}</p>}
          </div>
          <div><p style={C.label}>MOIC</p>
            {method==='mark-at-cost'
              ? <p style={{...C.val,color:'#9ca3af'}}>1.0x</p>
              : moic ? <p style={{...C.val,color:moic>=1.5?'#10b981':moic>=1?'#5B6DC4':'#ef4444'}}>{moic.toFixed(2)}x</p>
              : <p style={{...C.val,color:'#9ca3af'}}>—</p>}
          </div>
          <div><p style={C.label}>Ownership</p>
            <p style={{...C.val,color:'#374151'}}>{currentOwnership ? `${currentOwnership}%` : '—'}</p>
          </div>
        </div>

        {/* Projected row — shows when active raise exists */}
        {projected&&<div style={{marginTop:4,marginBottom:12,padding:'10px 14px',background:'#f5f3ff',borderRadius:12,border:'1px solid #e9d5ff'}}>
          <p style={{fontSize:10,color:'#7c3aed',fontWeight:700,textTransform:'uppercase',letterSpacing:.7,marginBottom:8}}>After {deal.activeRaise?.roundName||'active raise'} closes · {projected.dilPct}% dilution</p>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12}}>
            <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:3}}>Proj. value</p>
              <p style={{fontSize:14,fontWeight:700,color:projected.projectedIV&&projected.projectedIV>=cb?'#7c3aed':'#ef4444'}}>{projected.projectedIV?fmtC(projected.projectedIV):'—'}</p>
            </div>
            <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:3}}>Proj. MOIC</p>
              <p style={{fontSize:14,fontWeight:700,color:projected.projectedMOIC>=1.5?'#7c3aed':projected.projectedMOIC>=1?'#5B6DC4':'#ef4444'}}>{projected.projectedMOIC?`${projected.projectedMOIC.toFixed(2)}x`:'—'}</p>
            </div>
            <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:3}}>Proj. ownership</p>
              <p style={{fontSize:14,fontWeight:700,color:'#7c3aed'}}>{projected.projectedOwn.toFixed(3)}%</p>
            </div>
            <div><p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.6,marginBottom:3}}>Proj. post-$</p>
              <p style={{fontSize:14,fontWeight:700,color:'#374151'}}>{projected.projectedPostMoney?fmtC(projected.projectedPostMoney):'—'}</p>
            </div>
          </div>
        </div>}

        {method==='mark-at-cost'&&<div style={{marginTop:10,paddingTop:10,borderTop:'1px solid #f3f4f6'}}>
          <p style={{fontSize:12,color:'#9ca3af',fontStyle:'italic',marginBottom:8}}>{health.mat==='lab'?'Lab/bench stage — marked at cost. MOIC not meaningful pre-demonstration.':'Pilot stage — marked at cost until next priced round.'}</p>
          {inv.vehicle==='SAFE'&&deal.terms?.cap&&(()=>{const pct=deal.terms.cap>0?((cb/(deal.terms.cap+cb))*100):null;return <div style={{background:'#f9fafb',borderRadius:12,padding:'10px 14px'}}><p style={{fontSize:13,color:'#374151'}}>At your <strong>{fmtC(deal.terms.cap)}</strong> cap, you own approx <strong style={{color:'#5B6DC4'}}>~{pct?.toFixed(2)}%</strong> on conversion.{deal.terms.mfn&&<span style={{color:'#6b7280'}}> · MFN</span>}</p><p style={{fontSize:11,color:'#9ca3af',marginTop:4}}>Pre-dilution from option pool.</p></div>;})()}
        </div>}
        {method!=='mark-at-cost'&&inv.lastValuationDate&&<div style={{display:'flex',alignItems:'center',gap:6,marginTop:10}}>
          <span style={{width:6,height:6,borderRadius:99,background:STALE_COL[staleness],display:'inline-block'}}/>
          <p style={{fontSize:12,color:STALE_COL[staleness]}}>Mark from {new Date(inv.lastValuationDate).toLocaleDateString('en-US',{month:'short',year:'numeric'})}{staleness==='stale'?' — consider refreshing':staleness==='very-stale'?' — mark is outdated':''}</p>
        </div>}
      </div>

      <MetricsTracker deal={deal} onUpdate={onUpdate}/>

      <PrimaryInsight deal={deal} onUpdate={onUpdate} setToast={setToast}/>

      <SignalsSection deal={deal} onUpdate={onUpdate}/>

      <FundraiseHistory deal={deal} onUpdate={onUpdate} setToast={setToast}/>
      <div style={{marginTop:12}}><DocumentsSection deal={deal} onUpdate={onUpdate} setToast={setToast}/></div>
    </div>
  );
};

// ── DEAL CARDS ────────────────────────────────────────────────────────────────
const InvestedCard = ({deal,onClick}) => {
  const health=calcHealth(deal,[]);
  const moic=calcMOIC(deal);
  const method=getMethod(deal);
  const cb = getCB(deal.investment||{});

  // Realized deal — has liquidity events
  const liquidityEvents = deal.liquidityEvents || [];
  const exits = liquidityEvents.filter(e => e.type !== 'writedown');
  const writedowns = liquidityEvents.filter(e => e.type === 'writedown');
  const isRealized = liquidityEvents.length > 0;
  const totalProceeds = exits.reduce((s,e) => s + (e.proceeds||0), 0);
  const isLoss = isRealized && totalProceeds === 0;
  const netReturn = totalProceeds - cb;

  if (isRealized) return (
    <div onClick={onClick} style={{background:'white',borderRadius:16,border:'1px solid #e5e7eb',cursor:'pointer',overflow:'hidden',opacity:0.75}}>
      <div style={{padding:'14px 16px',display:'flex',alignItems:'center',gap:14}}>
        <CompanyLogo name={deal.companyName} website={deal.website} size={44} radius={12} fallbackBg="#9ca3af" fallbackColor="white"/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}>
            <span style={{fontWeight:600,fontSize:14,color:'#6b7280'}}>{deal.companyName}</span>
            <Pill color="#6b7280" bg="#f3f4f6">Realized</Pill>
          </div>
          <p style={{fontSize:12,color:'#9ca3af'}}>{deal.industry} · {deal.stage}</p>
        </div>
        <div style={{textAlign:'right',flexShrink:0}}>
          <p style={{fontSize:14,fontWeight:600,color:'#9ca3af'}}>{fmtC(cb)} in</p>
          {isLoss
            ? <p style={{fontSize:12,fontWeight:600,color:'#ef4444'}}>−{fmtC(cb)} lost</p>
            : <p style={{fontSize:12,fontWeight:600,color:netReturn>=0?'#10b981':'#ef4444'}}>{netReturn>=0?'+':'-'}{fmtC(Math.abs(netReturn))}</p>
          }
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </div>
  );

  return (
    <div onClick={onClick} style={{background:'white',borderRadius:16,border:`1px solid ${health.needsCheckIn?'#fde68a':'#e5e7eb'}`,cursor:'pointer',overflow:'hidden'}}>
      {health.needsCheckIn&&<div style={{padding:'6px 16px',background:'#fffbeb',borderBottom:'1px solid #fde68a',display:'flex',gap:8,alignItems:'center'}}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span style={{fontSize:12,fontWeight:500,color:'#92400e'}}>{health.checkInReason}</span></div>}
      <div style={{padding:'14px 16px',display:'flex',alignItems:'center',gap:14}}>
        <CompanyLogo name={deal.companyName} website={deal.website} size={44} radius={12} fallbackBg="#f59e0b" fallbackColor="white"/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}>
            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>{deal.companyName}</span>
          </div>
          <p style={{fontSize:12,color:'#6b7280'}}>{deal.industry} · {deal.stage}</p>
          {health.factors.filter(f=>f.t!=='info').slice(0,1).map((f,i)=><div key={i} style={{display:'flex',alignItems:'center',gap:6,marginTop:4}}><span style={{width:6,height:6,borderRadius:99,background:f.t==='positive'?'#10b981':f.t==='negative'?'#ef4444':'#f59e0b',display:'inline-block'}}/><span style={{fontSize:11,color:'#9ca3af'}}>{f.l}</span></div>)}
        </div>
        <div style={{textAlign:'right',flexShrink:0}}>
          <p style={{fontSize:14,fontWeight:600,color:'#111827'}}>{fmtC(cb)}</p>
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
  const [f,setF]=useState(()=>{
    const mat=STAGE_MAT['seed']||'pilot';
    const defs=METRIC_DEFAULTS[mat]||[];
    return {name:'',website:'',industry:'',stage:'seed',status:'invested',amount:'',vehicle:'SAFE',founderName:'',founderRole:'CEO',note:'',metric1:defs[0]||'',metric2:defs[1]||'',metric3:defs[2]||''};
  });

  const updateStage = (stage) => {
    const mat=STAGE_MAT[stage]||'lab';
    const defs=METRIC_DEFAULTS[mat]||[];
    setF(prev=>({...prev,stage,metric1:defs[0]||'',metric2:defs[1]||'',metric3:defs[2]||''}));
  };
  const submit=()=>{
    if(!f.name||(f.status==='invested'&&!f.amount))return;
    const now=new Date().toISOString();
    const metrics=[f.metric1,f.metric2,f.metric3].map(m=>m.trim()).filter(Boolean);
    const base={
      id:genId(),companyName:f.name,status:f.status,stage:f.stage,
      industry:f.industry||'Other',
      website:f.website||null,
      founders:f.founderName?[{name:f.founderName,role:f.founderRole}]:[],
      coInvestors:[],liquidityEvents:[],documents:[],
      monitoring:{healthStatus:'stable',fundraisingStatus:'not-raising'},
      milestones:[],
      metricsToWatch:metrics,
      metricsLog:{},
      revenueLog:[],
      notesLog:f.note.trim()?[{id:genId(),text:f.note.trim(),date:now}]:[],
      memo:f.note.trim()||'',
      founderUpdates:[],
      createdAt:now,statusEnteredAt:now
    };
    if(f.status==='invested'){base.investment={amount:Number(f.amount),costBasis:Number(f.amount),vehicle:f.vehicle,date:now,lastUpdateReceived:now};}
    onAdd(base);onClose();
  };

  const inp={width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,boxSizing:'border-box'};
  const lbl={fontSize:12,color:'#6b7280',display:'block',marginBottom:4};

  return <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:100,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
    <div style={{background:'white',borderRadius:20,width:'100%',maxWidth:440,maxHeight:'88vh',overflow:'auto'}}>
      <div style={{padding:'16px 20px',borderBottom:'1px solid #f3f4f6',display:'flex',justifyContent:'space-between',alignItems:'center',position:'sticky',top:0,background:'white',zIndex:1}}>
        <span style={{fontWeight:700,fontSize:15,color:'#111827'}}>Add Company</span>
        <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'#9ca3af'}}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
      <div style={{padding:20,display:'flex',flexDirection:'column',gap:14}}>

        {/* Status */}
        <div><label style={lbl}>Status</label>
          <div style={{display:'flex',gap:8}}>
            {['invested','watching'].map(s=>(
              <button key={s} onClick={()=>setF({...f,status:s})} style={{flex:1,padding:'9px',borderRadius:10,fontSize:13,fontWeight:600,cursor:'pointer',border:`2px solid ${f.status===s?'#5B6DC4':'#e5e7eb'}`,background:f.status===s?'#5B6DC4':'white',color:f.status===s?'white':'#374151',textTransform:'capitalize'}}>{s}</button>
            ))}
          </div>
        </div>

        {/* Company basics */}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div style={{gridColumn:'1/-1'}}><label style={lbl}>Company name *</label><input value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="Acme Inc" style={inp}/></div>
          <div style={{gridColumn:'1/-1'}}><label style={lbl}>Website</label><input value={f.website} onChange={e=>setF({...f,website:e.target.value})} placeholder="https://acme.com" style={inp}/></div>
          <div><label style={lbl}>Industry</label><input value={f.industry} onChange={e=>setF({...f,industry:e.target.value})} placeholder="Climate Tech" style={inp}/></div>
          <div><label style={lbl}>Stage</label>
            <select value={f.stage} onChange={e=>updateStage(e.target.value)} style={inp}>
              <option value="pre-seed">Pre-seed</option><option value="seed">Seed</option>
              <option value="series-a">Series A</option><option value="series-b">Series B</option><option value="growth">Growth</option>
            </select>
          </div>
        </div>

        {/* Investment details */}
        {f.status==='invested'&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><label style={lbl}>Amount ($) *</label><input type="number" value={f.amount} onChange={e=>setF({...f,amount:e.target.value})} placeholder="25000" style={inp}/></div>
          <div><label style={lbl}>Vehicle</label>
            <select value={f.vehicle} onChange={e=>setF({...f,vehicle:e.target.value})} style={inp}>
              <option value="SAFE">SAFE</option><option value="Convertible Note">Conv. Note</option><option value="Equity">Equity</option>
            </select>
          </div>
        </div>}

        {/* Founder */}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><label style={lbl}>Founder name</label><input value={f.founderName} onChange={e=>setF({...f,founderName:e.target.value})} placeholder="Name" style={inp}/></div>
          <div><label style={lbl}>Role</label><input value={f.founderRole} onChange={e=>setF({...f,founderRole:e.target.value})} placeholder="CEO" style={inp}/></div>
        </div>

        {/* Traction metrics */}
        {(()=>{
          const mat = STAGE_MAT[f.stage]||'lab';
          const defs = METRIC_DEFAULTS[mat]||[];
          if(mat==='deploy'||mat==='fund') return (
            <div style={{padding:'10px 14px',background:'#f9fafb',borderRadius:10,border:'1px solid #f3f4f6'}}>
              <p style={{fontSize:13,color:'#9ca3af'}}>At {f.stage} stage, revenue is the primary metric — no traction proxies needed.</p>
            </div>
          );
          return (
            <div>
              <label style={lbl}>Traction metrics <span style={{fontWeight:400,color:'#9ca3af'}}>— pre-filled for {f.stage} stage, edit freely</span></label>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {['metric1','metric2','metric3'].map((k,i)=>(
                  <input key={k} value={f[k]} onChange={e=>setF({...f,[k]:e.target.value})}
                    placeholder={defs[i]||`Metric ${i+1}`}
                    style={{...inp,borderColor:f[k]?'#5B6DC4':'#e5e7eb'}}/>
                ))}
              </div>
              <p style={{fontSize:11,color:'#9ca3af',marginTop:6}}>Log readings on the deal page after each founder call</p>
            </div>
          );
        })()}

        {/* Initial note */}
        <div>
          <label style={lbl}>{f.status==='invested'?'Why you invested':'Why you are watching'} <span style={{fontWeight:400,color:'#9ca3af'}}>(optional)</span></label>
          <textarea value={f.note} onChange={e=>setF({...f,note:e.target.value})}
            placeholder={f.status==='invested'?'What made you invest? What is your thesis?':'Why are you watching? What would move you to invest?'}
            rows={3} style={{...inp,resize:'none',outline:'none',fontFamily:'inherit',lineHeight:1.6}}/>
        </div>
      </div>

      <div style={{padding:'12px 20px',borderTop:'1px solid #f3f4f6',position:'sticky',bottom:0,background:'white'}}>
        <button onClick={submit} disabled={!f.name||(f.status==='invested'&&!f.amount)} style={{width:'100%',padding:'12px',background:'#5B6DC4',color:'white',border:'none',borderRadius:12,fontWeight:600,fontSize:14,cursor:'pointer',opacity:f.name&&(f.status!=='invested'||f.amount)?1:.4}}>Add Company</button>
      </div>
    </div>
  </div>;
};

// ── ROOT APP ──────────────────────────────────────────────────────────────────

// ── DELETE BUTTON ─────────────────────────────────────────────────────────────
function DeleteButton({ onDelete }) {
  const [confirm, setConfirm] = useState(false);
  if (confirm) return (
    <div style={{display:'flex',alignItems:'center',gap:6}}>
      <span style={{fontSize:13,color:'#6b7280'}}>Remove company?</span>
      <button onClick={onDelete} style={{padding:'5px 10px',borderRadius:8,fontSize:13,fontWeight:600,background:'#ef4444',color:'white',border:'none',cursor:'pointer'}}>Delete</button>
      <button onClick={() => setConfirm(false)} style={{padding:'5px 10px',borderRadius:8,fontSize:13,color:'#6b7280',background:'#f3f4f6',border:'none',cursor:'pointer'}}>Cancel</button>
    </div>
  );
  return (
    <button onClick={() => setConfirm(true)} style={{display:'flex',alignItems:'center',gap:5,padding:'5px 10px',borderRadius:8,fontSize:13,color:'#9ca3af',background:'none',border:'1px solid #e5e7eb',cursor:'pointer'}}
      onMouseEnter={e => { e.currentTarget.style.color='#ef4444'; e.currentTarget.style.borderColor='#fca5a5'; }}
      onMouseLeave={e => { e.currentTarget.style.color='#9ca3af'; e.currentTarget.style.borderColor='#e5e7eb'; }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      Delete
    </button>
  );
}

// ── LOGIN PAGE ────────────────────────────────────────────────────────────────
function LoginPage({ onLogin }) {
  const [loading, setLoading] = useState(false);
  return (
    <div style={{minHeight:'100vh',background:'linear-gradient(135deg,#fafaf9,#e7e5e4)',display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{width:'100%',maxWidth:400}}>
        <div style={{textAlign:'center',marginBottom:32}}>
          <div style={{width:72,height:72,background:'#4A1942',borderRadius:20,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 20px',boxShadow:'0 20px 40px rgba(74,25,66,.25)'}}>
            <svg width="36" height="36" viewBox="0 0 38 38" fill="none">
              <circle cx="19" cy="19" r="4.5" fill="#F5DFA0"/>
              <line x1="19" y1="3" x2="19" y2="10" stroke="#F5DFA0" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="19" y1="28" x2="19" y2="35" stroke="#F5DFA0" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="3" y1="19" x2="10" y2="19" stroke="#F5DFA0" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="28" y1="19" x2="35" y2="19" stroke="#F5DFA0" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="7.1" y1="7.1" x2="12.1" y2="12.1" stroke="#F5DFA0" strokeWidth="1.8" strokeLinecap="round" opacity=".85"/>
              <line x1="25.9" y1="25.9" x2="30.9" y2="30.9" stroke="#F5DFA0" strokeWidth="1.8" strokeLinecap="round" opacity=".85"/>
              <line x1="30.9" y1="7.1" x2="25.9" y2="12.1" stroke="#F5DFA0" strokeWidth="1.8" strokeLinecap="round" opacity=".85"/>
              <line x1="12.1" y1="25.9" x2="7.1" y2="30.9" stroke="#F5DFA0" strokeWidth="1.8" strokeLinecap="round" opacity=".85"/>
            </svg>
          </div>
          <h1 style={{fontSize:28,fontWeight:800,color:'#1c1917',marginBottom:6,letterSpacing:'-0.5px'}}>Lucero</h1>
          <p style={{color:'#78716c',fontSize:15}}>Your angel portfolio, all in one place</p>
        </div>
        <div style={{background:'white',borderRadius:20,padding:32,border:'1px solid #e7e5e4',boxShadow:'0 4px 24px rgba(0,0,0,.06)'}}>
          <button
            onClick={async () => { setLoading(true); await onLogin(); }}
            disabled={loading}
            style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'center',gap:12,padding:'13px 16px',borderRadius:12,border:'1px solid #d1d5db',background:'white',color:'#374151',fontWeight:500,fontSize:15,cursor:loading?'not-allowed':'pointer',opacity:loading?0.6:1}}
          >
            {loading
              ? <div style={{width:20,height:20,border:'2px solid #d1d5db',borderTopColor:'#374151',borderRadius:'50%',animation:'spin 1s linear infinite'}}/>
              : <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            }
            Continue with Google
          </button>
          <p style={{fontSize:12,color:'#a8a29e',textAlign:'center',marginTop:16}}>Access is invite-only</p>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ── USER MENU ─────────────────────────────────────────────────────────────────
function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    if (open) document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  if (!user) return null;
  const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'User';
  const avatar = user.user_metadata?.avatar_url || user.user_metadata?.picture ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=4A1942&color=F5DFA0`;
  return (
    <div ref={ref} style={{position:'relative'}}>
      <button onClick={() => setOpen(v => !v)} style={{display:'flex',alignItems:'center',gap:6,background:'none',border:'none',cursor:'pointer',padding:4,borderRadius:99}}>
        <img src={avatar} alt={name} style={{width:32,height:32,borderRadius:99,objectFit:'cover'}}/>
        <span style={{fontSize:13,color:'#374151',fontWeight:500,maxWidth:100,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name.split(' ')[0]}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      {open && (
        <div style={{position:'absolute',right:0,top:'calc(100% + 8px)',width:210,background:'white',borderRadius:14,boxShadow:'0 10px 25px rgba(0,0,0,.12)',border:'1px solid #e5e7eb',zIndex:999,overflow:'hidden'}}>
          <div style={{padding:'12px 16px',borderBottom:'1px solid #f3f4f6'}}>
            <p style={{fontWeight:600,fontSize:13,color:'#111827',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name}</p>
            <p style={{fontSize:12,color:'#9ca3af',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user.email}</p>
          </div>
          <button
            onClick={() => { setOpen(false); onLogout(); }}
            style={{width:'100%',padding:'10px 16px',textAlign:'left',fontSize:13,color:'#ef4444',background:'none',border:'none',cursor:'pointer',display:'flex',alignItems:'center',gap:8}}
            onMouseEnter={e => e.currentTarget.style.background='#fef2f2'}
            onMouseLeave={e => e.currentTarget.style.background='none'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ── ANGELLIST CSV IMPORT MODAL ────────────────────────────────────────────────
function ImportModal({ onClose, onImport }) {
  const [stage, setStage] = useState('upload'); // upload | preview | importing | done
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [importSummary, setImportSummary] = useState({ updated: 0, added: 0 });
  const fileRef = useRef(null);

  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    // AngelList CSV has a disclaimer on row 1 — find the actual header row
    const headerIdx = lines.findIndex(l => l.includes('Company/Fund') || l.includes('company/fund'));
    if (headerIdx === -1) return null;
    const headers = lines[headerIdx].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
    return lines.slice(headerIdx + 1).map(line => {
      const cols = []; let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      cols.push(cur.trim());
      const row = {};
      headers.forEach((h, i) => { row[h] = (cols[i] || '').replace(/^"|"$/g, '').trim(); });
      return row;
    }).filter(r => r['company/fund'] && r['company/fund'].length > 0);
  };

  const parseMoney = (val) => {
    if (!val || val === 'Locked' || val === '$0') return 0;
    return parseFloat(val.replace(/[$,\s]/g, '')) || 0;
  };

  const rowToDeal = (row) => {
    const name = row['company/fund'] || '';
    const amount = parseMoney(row['invested']);
    const unrealized = parseMoney(row['unrealized value']);
    const realized = parseMoney(row['realized value']);
    const multiple = parseFloat(row['multiple']) || null;
    const dateRaw = row['invest date'] || '';
    const date = dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString();
    const round = (row['round'] || '').toLowerCase();
    const invType = (row['investment type'] || '').toLowerCase();
    const market = row['market'] || 'Other';
    const instrument = (row['instrument'] || '').toLowerCase();
    const isRealized = (row['status'] || '').toLowerCase() === 'realized';
    const capRaw = parseMoney(row['valuation or cap']);
    const discount = parseFloat((row['discount'] || '').replace('%', '')) || 0;
    const stageMap = {
      'pre-seed': 'pre-seed', 'preseed': 'pre-seed', 'seed': 'seed',
      'series a': 'series-a', 'series b': 'series-b', 'series c': 'series-c',
      'series d': 'series-c', 'series e': 'series-c', 'series f': 'series-c',
      'growth': 'growth', 'late': 'growth', 'spv': 'seed',
      'rolling fund': 'seed', 'syndicate': 'seed', 'fund': 'seed',
    };
    const vehicle = instrument.includes('safe') ? 'SAFE'
      : instrument.includes('note') ? 'Convertible Note'
      : invType === 'fund' ? 'Fund'
      : 'Equity';
    const deal = {
      id: genId(),
      companyName: name,
      status: 'invested',
      stage: stageMap[round] || 'seed',
      industry: market,
      website: null,
      founders: [],
      coInvestors: [],
      dealSource: row['lead'] || '',  // syndicate/fund channel from AngelList
      liquidityEvents: [],
      documents: [],
      monitoring: { healthStatus: 'stable', fundraisingStatus: 'not-raising' },
      milestones: [],
      metricsToWatch: [],
      metricsLog: {},
      revenueLog: [],
      notesLog: [],
      memo: '',
      founderUpdates: [],
      createdAt: date,
      statusEnteredAt: date,
      investment: {
        amount, costBasis: amount, vehicle, date,
        lastUpdateReceived: date,
        ...(capRaw > 0 ? { impliedValuation: capRaw } : {}),
        ...(discount > 0 ? { discount } : {}),
        ...(multiple && multiple > 0 && multiple !== 1 ? {
          impliedValue: Math.round(amount * multiple),
          lastValuationDate: date,
        } : {}),
      },
      source: { type: 'angellist', name: row['lead'] || 'AngelList' },
      isFund: invType === 'fund' || (row['investment type']||'').toLowerCase() === 'fund',
      terms: {
        instrument: vehicle,
        ...(capRaw > 0 ? { cap: capRaw } : {}),
        ...(discount > 0 ? { discount } : {}),
        capType: row['valuation or cap type'] || '',
      },
    };
    if (isRealized && realized > 0) {
      deal.liquidityEvents = [{ id: genId(), type: 'exit', date, proceeds: realized, notes: 'Imported from AngelList' }];
    } else if (isRealized) {
      deal.liquidityEvents = [{ id: genId(), type: 'writedown', date, writedownAmount: amount, proceeds: 0, notes: 'Realized $0 — imported from AngelList' }];
    }
    return deal;
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.csv')) { setError('Please upload a .csv file'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = parseCSV(ev.target.result);
        if (!parsed) { setError("Couldn't find the header row. Make sure this is an AngelList portfolio export."); return; }
        if (!parsed.length) { setError("No investments found in this file."); return; }
        setRows(parsed.map(r => ({ raw: r, deal: rowToDeal(r), selected: true })));
        setStage('preview');
        setError('');
      } catch (err) { setError('Failed to parse CSV: ' + err.message); }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    const toImport = rows.filter(r => r.selected).map(r => r.deal);
    setStage('importing');
    let updated = 0, added = 0;

    // Process in small batches to avoid hanging on any single deal
    const withTimeout = (promise, ms = 5000) =>
      Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

    for (let i = 0; i < toImport.length; i++) {
      const d = toImport[i];
      try {
        const isExisting = deals.find(x => x.companyName.toLowerCase() === d.companyName.toLowerCase());
        if (isExisting) updated++; else added++;
        await withTimeout(onImport(d, true));
      } catch (e) {
        console.warn(`Import failed for ${d.companyName}:`, e.message);
        // Continue with next deal even if this one fails/times out
      }
      setProgress(Math.round(((i + 1) / toImport.length) * 100));
    }
    setImportSummary({ updated, added });
    setStage('done');
  };

  const selected = rows.filter(r => r.selected).length;
  const liveCount = rows.filter(r => r.selected && (r.raw['status'] || '').toLowerCase() === 'live').length;
  const realizedCount = rows.filter(r => r.selected && (r.raw['status'] || '').toLowerCase() === 'realized').length;
  const btn = { padding: '10px 20px', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer', border: 'none' };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:'white',borderRadius:20,width:'100%',maxWidth:520,maxHeight:'85vh',display:'flex',flexDirection:'column',overflow:'hidden'}}>

        <div style={{padding:'16px 20px',borderBottom:'1px solid #f3f4f6',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
          <div>
            <p style={{fontWeight:700,fontSize:15,color:'#111827'}}>Import from AngelList</p>
            <p style={{fontSize:12,color:'#9ca3af',marginTop:2}}>Upload your AngelList portfolio CSV export</p>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'#9ca3af'}}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div style={{padding:20,overflowY:'auto',flex:1}}>
          {stage === 'upload' && (
            <div style={{display:'flex',flexDirection:'column',gap:20}}>
              <div style={{background:'#eef2ff',borderRadius:12,padding:16}}>
                <p style={{fontWeight:600,fontSize:13,color:'#3730a3',marginBottom:10}}>How to export from AngelList</p>
                {['Go to venture.angellist.com', 'Click Portfolio → Dashboard', 'Scroll to the Investments table', 'Click Export CSV'].map((step, i) => (
                  <div key={i} style={{display:'flex',alignItems:'center',gap:10,marginBottom:i<3?7:0}}>
                    <span style={{width:22,height:22,borderRadius:99,background:'#5B6DC4',color:'white',fontSize:11,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>{i + 1}</span>
                    <span style={{fontSize:13,color:'#374151'}}>{step}</span>
                  </div>
                ))}
              </div>
              <div
                onClick={() => fileRef.current?.click()}
                style={{border:'2px dashed #d1d5db',borderRadius:14,padding:'36px 20px',textAlign:'center',cursor:'pointer',background:'white',transition:'all .15s'}}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#5B6DC4'; e.currentTarget.style.background = '#f5f7ff'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.background = 'white'; }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5" style={{margin:'0 auto 12px',display:'block'}}>
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <p style={{fontWeight:600,fontSize:14,color:'#374151',marginBottom:4}}>Click to upload your CSV</p>
                <p style={{fontSize:12,color:'#9ca3af'}}>AngelList portfolio export (.csv)</p>
                <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{display:'none'}}/>
              </div>
              {error && <p style={{color:'#ef4444',fontSize:13,textAlign:'center'}}>{error}</p>}
            </div>
          )}

          {stage === 'preview' && (
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <div>
                  <p style={{fontSize:14,fontWeight:600,color:'#111827'}}>{selected} of {rows.length} selected</p>
                  <p style={{fontSize:12,color:'#9ca3af',marginTop:2}}>{liveCount} live · {realizedCount} realized/exited</p>
                </div>
                <button
                  onClick={() => setRows(r => r.map(x => ({ ...x, selected: !rows.every(r => r.selected) })))}
                  style={{fontSize:12,color:'#5B6DC4',background:'none',border:'none',cursor:'pointer'}}
                >
                  {rows.every(r => r.selected) ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {rows.map((r, i) => {
                  const isLive = (r.raw['status'] || '').toLowerCase() === 'live';
                  const amt = parseMoney(r.raw['invested']);
                  return (
                    <div
                      key={i}
                      onClick={() => setRows(prev => prev.map((x, j) => j === i ? { ...x, selected: !x.selected } : x))}
                      style={{display:'flex',alignItems:'center',gap:12,padding:'10px 14px',borderRadius:12,border:`1.5px solid ${r.selected ? '#5B6DC4' : '#e5e7eb'}`,background:r.selected ? '#f5f7ff' : 'white',cursor:'pointer'}}
                    >
                      <div style={{width:18,height:18,borderRadius:5,border:`2px solid ${r.selected ? '#5B6DC4' : '#d1d5db'}`,background:r.selected ? '#5B6DC4' : 'white',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                        {r.selected && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <p style={{fontWeight:600,fontSize:13,color:'#111827',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.deal.companyName}</p>
                        <p style={{fontSize:12,color:'#6b7280'}}>{r.deal.stage}{r.deal.industry !== 'Other' ? ` · ${r.deal.industry}` : ''}{amt > 0 ? ` · ${fmtC(amt)}` : ''}</p>
                      </div>
                      <span style={{fontSize:11,padding:'2px 8px',borderRadius:99,background:isLive?'#ecfdf5':'#f3f4f6',color:isLive?'#059669':'#6b7280',fontWeight:500,flexShrink:0}}>
                        {isLive ? 'Live' : 'Realized'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {stage === 'importing' && (
            <div style={{textAlign:'center',padding:'40px 20px'}}>
              <div style={{width:44,height:44,border:'3px solid #e5e7eb',borderTopColor:'#5B6DC4',borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 16px'}}/>
              <p style={{fontWeight:600,fontSize:15,color:'#111827',marginBottom:10}}>Importing {selected} investments…</p>
              <div style={{height:6,background:'#f3f4f6',borderRadius:99,overflow:'hidden',maxWidth:220,margin:'0 auto'}}>
                <div style={{height:'100%',background:'#5B6DC4',borderRadius:99,width:`${progress}%`,transition:'width .3s'}}/>
              </div>
              <p style={{fontSize:12,color:'#9ca3af',marginTop:8}}>{progress}%</p>
            </div>
          )}

          {stage === 'done' && (
            <div style={{textAlign:'center',padding:'40px 20px'}}>
              <div style={{width:56,height:56,background:'#ecfdf5',borderRadius:99,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px'}}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <p style={{fontWeight:700,fontSize:16,color:'#111827',marginBottom:6}}>{selected} investments synced</p>
              <div style={{display:'flex',justifyContent:'center',gap:16,marginBottom:20}}>
                {importSummary.added > 0 && <p style={{fontSize:13,color:'#10b981'}}>✦ {importSummary.added} new</p>}
                {importSummary.updated > 0 && <p style={{fontSize:13,color:'#5B6DC4'}}>↻ {importSummary.updated} updated</p>}
              </div>
              <button onClick={onClose} style={{...btn, background:'#5B6DC4', color:'white', width:'100%'}}>View Portfolio</button>
            </div>
          )}
        </div>

        {(stage === 'upload' || stage === 'preview') && (
          <div style={{padding:'14px 20px',borderTop:'1px solid #f3f4f6',display:'flex',gap:10,flexShrink:0}}>
            <button onClick={stage === 'preview' ? () => setStage('upload') : onClose} style={{...btn, background:'#f3f4f6', color:'#374151', flex:1}}>
              {stage === 'preview' ? 'Back' : 'Cancel'}
            </button>
            {stage === 'preview' && (
              <button onClick={handleImport} disabled={selected === 0} style={{...btn, background: selected > 0 ? '#5B6DC4' : '#e5e7eb', color: selected > 0 ? 'white' : '#9ca3af', flex:2}}>
                Import {selected} investment{selected !== 1 ? 's' : ''}
              </button>
            )}
          </div>
        )}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ── ROOT APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const { user, isLoading, isAuthenticated, signInWithProvider, signOut } = useAuth();
  const [deals, setDeals] = useState([]);
  const [dealsReady, setDealsReady] = useState(false);
  const [page, setPage] = useState('list');
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Load deals — wait for real data, never flash demo
  useEffect(() => {
    if (!user?.id) return;
    let mounted = true;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('deals').select('id, data').eq('user_id', user.id);
        if (!mounted) return;
        if (error) { console.warn('Load error:', error.message); setDealsReady(true); return; }
        if (data && data.length > 0) {
          setDeals(data.map(row => {
            const d = { ...row.data, id: row.id };
            // Compute isFund at runtime for existing deals that predate the flag
            if (!('isFund' in d)) {
              const name = (d.companyName || '').toLowerCase();
              const src = (d.source?.name || '').toLowerCase();
              const vehicle = (d.investment?.vehicle || '').toLowerCase();
              d.isFund = vehicle === 'fund'
                || name.includes('ventures')
                || name.includes(' fund')
                || name.includes('capital')
                || name.includes('partners')
                || src.includes('fund');
            }
            return d;
          }));
          setDealsReady(true);
        } else {
          // New user — seed demo deals then show them
          setDealsReady(true);
          for (const deal of DEALS) {
            const { id, ...dealData } = deal;
            await supabase.from('deals').insert({ id, user_id: user.id, company_name: deal.companyName, status: deal.status, data: dealData });
          }
          if (mounted) {
            const { data: seeded } = await supabase.from('deals').select('id, data').eq('user_id', user.id);
            if (mounted && seeded?.length) setDeals(seeded.map(row => ({ ...row.data, id: row.id })));
          }
        }
      } catch (e) {
        console.warn('Supabase error:', e.message);
        if (mounted) setDealsReady(true);
      }
    };
    load();
    return () => { mounted = false; };
  }, [user?.id]);

  const updateDeal = async (updated) => {
    setDeals(prev => prev.map(d => d.id === updated.id ? updated : d));
    setSelected(updated);
    const { id, ...dealData } = updated;
    const { error } = await supabase.from('deals')
      .update({ data: dealData, company_name: updated.companyName, status: updated.status })
      .eq('id', id).eq('user_id', user.id);
    if (error) console.error('Update failed:', error.message);
  };

  const deleteDeal = async (id) => {
    setDeals(prev => prev.filter(d => d.id !== id));
    setPage('list');
    setSelected(null);
    const { error } = await supabase.from('deals').delete().eq('id', id).eq('user_id', user.id);
    if (error) console.error('Delete failed:', error.message);
    else setToast('Company removed');
  };

  const massDelete = async () => {
    const ids = [...selectedIds];
    setDeals(prev => prev.filter(d => !selectedIds.has(d.id)));
    setSelectMode(false);
    setSelectedIds(new Set());
    setToast(`${ids.length} ${ids.length === 1 ? 'company' : 'companies'} removed`);
    // Delete from Supabase in background
    for (const id of ids) {
      supabase.from('deals').delete().eq('id', id).eq('user_id', user.id)
        .then(({ error }) => { if (error) console.warn('Delete failed:', id, error.message); });
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const addDeal = async (d, upsert = false) => {
    if (upsert) {
      const existing = deals.find(x => x.companyName.toLowerCase() === d.companyName.toLowerCase());
      if (existing) {
        const merged = { ...d, id: existing.id };
        // Update UI immediately
        setDeals(prev => prev.map(x => x.id === existing.id ? merged : x));
        // Write to Supabase in background — don't await
        const { id, ...dealData } = merged;
        supabase.from('deals')
          .update({ data: dealData, company_name: merged.companyName, status: merged.status })
          .eq('id', id).eq('user_id', user.id)
          .then(({ error }) => { if (error) console.warn('Update failed:', error.message); });
        return;
      }
      // New deal — insert without blocking
      setDeals(prev => [d, ...prev]);
      const { id, ...dealData } = d;
      supabase.from('deals')
        .insert({ id, user_id: user.id, company_name: d.companyName, status: d.status, data: dealData })
        .then(({ error }) => { if (error) console.warn('Insert failed:', error.message); });
      return;
    }
    // Manual add — await and show toast
    setDeals(prev => [d, ...prev]);
    setToast(`${d.companyName} added`);
    const { id, ...dealData } = d;
    const { error } = await supabase.from('deals')
      .insert({ id, user_id: user.id, company_name: d.companyName, status: d.status, data: dealData });
    if (error) {
      console.error('Save failed:', error.message);
      setToast(`Saved locally — sync failed: ${error.message}`);
    }
  };

  // Loading state — covers both auth and data fetching
  if (isLoading || (isAuthenticated && !dealsReady)) return (
    <div style={{minHeight:'100vh',background:'#f9fafb',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:14}}>
      <div style={{width:40,height:40,background:'#4A1942',borderRadius:12,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <svg width="20" height="20" viewBox="0 0 38 38" fill="none">
          <circle cx="19" cy="19" r="4.5" fill="#F5DFA0"/>
          <line x1="19" y1="3" x2="19" y2="10" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
          <line x1="19" y1="28" x2="19" y2="35" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
          <line x1="3" y1="19" x2="10" y2="19" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
          <line x1="28" y1="19" x2="35" y2="19" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
        </svg>
      </div>
      <div style={{width:18,height:18,border:'2px solid #e5e7eb',borderTopColor:'#4A1942',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (!isAuthenticated) return <LoginPage onLogin={() => signInWithProvider('google')} />;

  const portfolio = deals.filter(d => d.status === 'invested' && !d.isFund);
  const allInvested = deals.filter(d => d.status === 'invested');
  const ph = calcPortHealth(deals);

  // All invested including funds for financial totals
  const totalDep = allInvested.reduce((s, d) => s + getCB(d.investment || {}), 0);

  // Live implied value (unrealized marks) — funds mark at cost
  const totalUnrealizedImp = allInvested.reduce((s, d) => {
    const hasLiquidity = (d.liquidityEvents || []).length > 0;
    return s + (hasLiquidity ? 0 : calcIV(d));
  }, 0);

  // Realized proceeds (actual cash back from exits)
  const totalProceeds = allInvested.reduce((s, d) =>
    (d.liquidityEvents || []).filter(e => e.type !== 'writedown').reduce((a, e) => a + (e.proceeds || 0), s), 0);

  // Realized losses (cost basis of writedowns with $0 back)
  const totalWritedowns = allInvested.reduce((s, d) => {
    const hasWritedown = (d.liquidityEvents || []).some(e => e.type === 'writedown');
    const hasExit = (d.liquidityEvents || []).some(e => e.type !== 'writedown' && (e.proceeds || 0) > 0);
    if (hasWritedown && !hasExit) return s + getCB(d.investment || {});
    return s;
  }, 0);

  // Net P&L = proceeds from exits - writedowns - unrealized losses on live deals
  const realizedPnL = totalProceeds - totalWritedowns;
  // Total net: realized P&L + unrealized gain/loss on live positions
  const unrealizedPnL = totalUnrealizedImp - (totalDep - totalProceeds - totalWritedowns); // subtract deployed into realized deals
  const netPnL = totalProceeds + totalUnrealizedImp - totalDep; // simplified: total value - total cost

  const moic = totalDep > 0 ? (totalProceeds + totalUnrealizedImp) / totalDep : null;
  const dpi = totalDep > 0 ? totalProceeds / totalDep : 0;
  const filtered = search ? deals.filter(d => d.companyName.toLowerCase().includes(search.toLowerCase())) : deals;
  const fInvested = filtered.filter(d => d.status === 'invested' && !d.isFund);
  const fFunds = filtered.filter(d => d.status === 'invested' && d.isFund);
  const fWatching = filtered.filter(d => d.status === 'watching');

  if (page === 'detail' && selected) return (
    <div style={{minHeight:'100vh',background:'#f9fafb',fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'}}>
      <div style={{background:'white',borderBottom:'1px solid #e5e7eb',position:'sticky',top:0,zIndex:10}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 32px'}}>
          <button onClick={() => { setPage('list'); setSelected(null); }} style={{display:'flex',alignItems:'center',gap:6,background:'none',border:'none',cursor:'pointer',color:'#6b7280',fontSize:14,fontWeight:500}}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            Portfolio
          </button>
          <span style={{fontWeight:700,fontSize:14,color:'#111827'}}>{selected.companyName}</span>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <DeleteButton onDelete={() => deleteDeal(selected.id)}/>
            <UserMenu user={user} onLogout={signOut}/>
          </div>
        </div>
      </div>
      <DetailView deal={selected} onUpdate={updateDeal} setToast={setToast}/>
      {toast && <Toast msg={typeof toast === 'string' ? toast : toast.message} onClose={() => setToast(null)}/>}
    </div>
  );

  return (
    <div style={{minHeight:'100vh',background:'#f9fafb',fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'}}>
      <div style={{background:'white',borderBottom:'1px solid #e5e7eb',position:'sticky',top:0,zIndex:10}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 32px'}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:34,height:34,borderRadius:10,background:'#4A1942',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <svg width="18" height="18" viewBox="0 0 38 38" fill="none">
                <circle cx="19" cy="19" r="4.5" fill="#F5DFA0"/>
                <line x1="19" y1="3" x2="19" y2="10" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
                <line x1="19" y1="28" x2="19" y2="35" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
                <line x1="3" y1="19" x2="10" y2="19" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
                <line x1="28" y1="19" x2="35" y2="19" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
                <line x1="7.1" y1="7.1" x2="12.1" y2="12.1" stroke="#F5DFA0" strokeWidth="2" strokeLinecap="round" opacity=".8"/>
                <line x1="25.9" y1="25.9" x2="30.9" y2="30.9" stroke="#F5DFA0" strokeWidth="2" strokeLinecap="round" opacity=".8"/>
                <line x1="30.9" y1="7.1" x2="25.9" y2="12.1" stroke="#F5DFA0" strokeWidth="2" strokeLinecap="round" opacity=".8"/>
                <line x1="12.1" y1="25.9" x2="7.1" y2="30.9" stroke="#F5DFA0" strokeWidth="2" strokeLinecap="round" opacity=".8"/>
              </svg>
            </div>
            <span style={{fontWeight:800,fontSize:16,color:'#111827',letterSpacing:'-0.3px'}}>Lucero</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            {selectMode ? (
              <>
                <span style={{fontSize:13,color:'#6b7280'}}>{selectedIds.size} selected</span>
                <button
                  onClick={() => {
                    const allIds = new Set(deals.map(d => d.id));
                    setSelectedIds(selectedIds.size === deals.length ? new Set() : allIds);
                  }}
                  style={{padding:'8px 12px',background:'white',color:'#374151',border:'1px solid #e5e7eb',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer'}}
                >
                  {selectedIds.size === deals.length ? 'Deselect all' : 'Select all'}
                </button>
                <button
                  onClick={massDelete}
                  disabled={selectedIds.size === 0}
                  style={{padding:'8px 14px',background:selectedIds.size>0?'#ef4444':'#f3f4f6',color:selectedIds.size>0?'white':'#9ca3af',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:selectedIds.size>0?'pointer':'not-allowed',display:'flex',alignItems:'center',gap:6}}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>
                  Delete {selectedIds.size > 0 ? selectedIds.size : ''}
                </button>
                <button
                  onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                  style={{padding:'8px 12px',background:'white',color:'#6b7280',border:'1px solid #e5e7eb',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer'}}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setShowImport(true)} style={{padding:'8px 14px',background:'white',color:'#374151',border:'1px solid #e5e7eb',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Import CSV
                </button>
                <button onClick={() => setShowAdd(true)} style={{padding:'8px 14px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>
                  <span style={{fontSize:16,lineHeight:1}}>+</span>Add Company
                </button>
                <button onClick={() => setSelectMode(true)} style={{padding:'8px 10px',background:'white',color:'#6b7280',border:'1px solid #e5e7eb',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer'}} title="Select to delete">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>
                </button>
              </>
            )}
            <UserMenu user={user} onLogout={signOut}/>
          </div>
        </div>
      </div>

      <div style={{padding:'24px 32px'}}>
        {portfolio.length > 0 && (
          <div style={{background:'white',borderRadius:16,padding:20,marginBottom:16,border:'1px solid #e5e7eb'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
              <h2 style={{fontSize:15,fontWeight:700,color:'#111827'}}>Portfolio</h2>
              <span style={{fontSize:12,color:'#9ca3af'}}>{allInvested.length} {allInvested.length === 1 ? 'position' : 'positions'}</span>
            </div>
            {(() => {
              const statC = (v) => v > 0 ? '#10b981' : v < 0 ? '#ef4444' : '#9ca3af';
              const fmtPnL = (v) => {
                if (v === 0) return '—';
                const abs = fmtC(Math.abs(v));
                return v > 0 ? `+${abs}` : `−${abs}`;
              };
              const stats = [
                { l: 'Deployed', v: fmtC(totalDep), sub: 'total cost basis', c: '#111827' },
                { l: 'Live Value', v: fmtC(totalUnrealizedImp), sub: 'unrealized marks', c: '#111827' },
                { l: 'Net P&L', v: fmtPnL(netPnL), sub: `${totalProceeds > 0 ? fmtC(totalProceeds) + ' returned · ' : ''}${totalWritedowns > 0 ? fmtC(totalWritedowns) + ' lost' : 'no exits yet'}`, c: statC(netPnL) },
                { l: 'MOIC', v: moic ? `${moic.toFixed(2)}x` : '—', sub: 'blended', c: moic >= 1.5 ? '#10b981' : moic >= 1 ? '#5B6DC4' : '#9ca3af' },
                { l: 'DPI', v: dpi > 0 ? `${dpi.toFixed(2)}x` : '0.00x', sub: 'distributed/paid-in', c: dpi >= 1 ? '#10b981' : dpi > 0 ? '#5B6DC4' : '#9ca3af' },
                { l: 'Watching', v: String(deals.filter(d => d.status === 'watching').length), sub: `${portfolio.length} invested`, c: '#5B6DC4' },
              ];
              return (
                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10}}>
                  {stats.map(({ l, v, sub, c }) => (
                    <div key={l} style={{background:'#f9fafb',borderRadius:12,padding:'10px 12px'}}>
                      <p style={{fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.7,marginBottom:4}}>{l}</p>
                      <p style={{fontSize:16,fontWeight:700,color:c,lineHeight:1.2}}>{v}</p>
                      <p style={{fontSize:10,color:'#c4c4c4',marginTop:3}}>{sub}</p>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {allInvested.length > 1 && <ValueChart allDeals={allInvested} mode="portfolio"/>}

        <div style={{marginBottom:14}}>
          <div style={{background:'white',borderRadius:14,border:'1px solid #e5e7eb',padding:'6px 12px',display:'flex',alignItems:'center',gap:10}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search companies..." style={{border:'none',outline:'none',fontSize:14,flex:1,color:'#111827',background:'transparent'}}/>
          </div>
        </div>

        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          {fInvested.length > 0 && (
            <div>
              {/* Live startups */}
              {fInvested.filter(d => !(d.liquidityEvents||[]).length).length > 0 && (
                <div style={{marginBottom:16}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
                    <span style={{width:8,height:8,borderRadius:99,background:'#10b981',display:'inline-block'}}/>
                    <p style={{fontSize:11,fontWeight:600,color:'#6b7280',textTransform:'uppercase',letterSpacing:.8}}>Invested · {fInvested.filter(d => !(d.liquidityEvents||[]).length).length}</p>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    {fInvested.filter(d => !(d.liquidityEvents||[]).length).map(d => (
                    <div key={d.id} style={{position:'relative'}} onClick={selectMode ? () => toggleSelect(d.id) : undefined}>
                      <InvestedCard deal={d} onClick={selectMode ? undefined : () => { setSelected(d); setPage('detail'); }}/>
                      {selectMode && <div style={{position:'absolute',top:12,left:12,width:20,height:20,borderRadius:6,border:`2px solid ${selectedIds.has(d.id)?'#5B6DC4':'#d1d5db'}`,background:selectedIds.has(d.id)?'#5B6DC4':'white',display:'flex',alignItems:'center',justifyContent:'center',zIndex:10,pointerEvents:'none'}}>
                        {selectedIds.has(d.id)&&<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                      </div>}
                    </div>
                  ))}
                  </div>
                </div>
              )}
              {/* Realized */}
              {fInvested.filter(d => (d.liquidityEvents||[]).length > 0).length > 0 && (
                <div style={{marginBottom:16}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
                    <span style={{width:8,height:8,borderRadius:99,background:'#9ca3af',display:'inline-block'}}/>
                    <p style={{fontSize:11,fontWeight:600,color:'#9ca3af',textTransform:'uppercase',letterSpacing:.8}}>Realized · {fInvested.filter(d => (d.liquidityEvents||[]).length > 0).length}</p>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    {fInvested.filter(d => (d.liquidityEvents||[]).length > 0).map(d => (
                    <div key={d.id} style={{position:'relative'}} onClick={selectMode ? () => toggleSelect(d.id) : undefined}>
                      <InvestedCard deal={d} onClick={selectMode ? undefined : () => { setSelected(d); setPage('detail'); }}/>
                      {selectMode && <div style={{position:'absolute',top:12,left:12,width:20,height:20,borderRadius:6,border:`2px solid ${selectedIds.has(d.id)?'#5B6DC4':'#d1d5db'}`,background:selectedIds.has(d.id)?'#5B6DC4':'white',display:'flex',alignItems:'center',justifyContent:'center',zIndex:10,pointerEvents:'none'}}>
                        {selectedIds.has(d.id)&&<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                      </div>}
                    </div>
                  ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Fund LP positions */}
          {fFunds.length > 0 && (
            <div style={{marginBottom:16}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
                <span style={{width:8,height:8,borderRadius:99,background:'#7c3aed',display:'inline-block'}}/>
                <p style={{fontSize:11,fontWeight:600,color:'#7c3aed',textTransform:'uppercase',letterSpacing:.8}}>Fund LP Positions · {fFunds.length}</p>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                {fFunds.map(d => {
                  const cb = getCB(d.investment||{});
                  return (
                    <div key={d.id} style={{position:'relative'}} onClick={selectMode ? () => toggleSelect(d.id) : undefined}>
                      <div onClick={selectMode ? undefined : () => { setSelected(d); setPage('detail'); }}
                        style={{background:'white',borderRadius:16,border:'1px solid #ede9fe',cursor:'pointer',padding:'14px 16px',display:'flex',alignItems:'center',gap:14}}>
                        <div style={{width:44,height:44,borderRadius:12,background:'#7c3aed20',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                        </div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}>
                            <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>{d.companyName}</span>
                            <Pill color="#7c3aed" bg="#f5f3ff">LP</Pill>
                          </div>
                          <p style={{fontSize:12,color:'#9ca3af'}}>{d.source?.name && d.source.name !== 'AngelList' ? d.source.name : 'Fund investment'}</p>
                        </div>
                        <div style={{textAlign:'right',flexShrink:0}}>
                          <p style={{fontSize:14,fontWeight:600,color:'#111827'}}>{fmtC(cb)}</p>
                          <p style={{fontSize:12,color:'#9ca3af'}}>LP position</p>
                        </div>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                      </div>
                      {selectMode && <div style={{position:'absolute',top:12,left:12,width:20,height:20,borderRadius:6,border:`2px solid ${selectedIds.has(d.id)?'#5B6DC4':'#d1d5db'}`,background:selectedIds.has(d.id)?'#5B6DC4':'white',display:'flex',alignItems:'center',justifyContent:'center',zIndex:10,pointerEvents:'none'}}>
                        {selectedIds.has(d.id)&&<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                      </div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {fWatching.length > 0 && (
            <div>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
                <span style={{width:8,height:8,borderRadius:99,background:'#9ca3af',display:'inline-block'}}/>
                <p style={{fontSize:11,fontWeight:600,color:'#6b7280',textTransform:'uppercase',letterSpacing:.8}}>Watching · {fWatching.length}</p>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                {fWatching.map(d => (
                <div key={d.id} style={{position:'relative'}} onClick={selectMode ? () => toggleSelect(d.id) : undefined}>
                  <WatchingCard deal={d} onClick={selectMode ? undefined : () => { setSelected(d); setPage('detail'); }}/>
                  {selectMode && <div style={{position:'absolute',top:12,left:12,width:20,height:20,borderRadius:6,border:`2px solid ${selectedIds.has(d.id)?'#5B6DC4':'#d1d5db'}`,background:selectedIds.has(d.id)?'#5B6DC4':'white',display:'flex',alignItems:'center',justifyContent:'center',zIndex:10,pointerEvents:'none'}}>
                    {selectedIds.has(d.id)&&<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                  </div>}
                </div>
              ))}
              </div>
            </div>
          )}
          {filtered.length === 0 && (
            <div style={{textAlign:'center',padding:'60px 20px',color:'#9ca3af'}}>
              <p style={{fontWeight:500,marginBottom:4}}>No companies yet</p>
              <p style={{fontSize:13}}>Add your first investment or import from AngelList</p>
            </div>
          )}
        </div>

        <p style={{textAlign:'center',fontSize:12,color:'#9ca3af',marginTop:28}}>
          {portfolio.length} investment{portfolio.length !== 1 ? 's' : ''}
        </p>
      </div>

      {showAdd && <AddModal onClose={() => setShowAdd(false)} onAdd={addDeal}/>}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onImport={addDeal}/>}
      {toast && <Toast msg={typeof toast === 'string' ? toast : toast.message} onClose={() => setToast(null)}/>}
    </div>
  );
}
