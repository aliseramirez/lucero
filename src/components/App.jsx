import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';

const ThemeContext = createContext({ theme: 'light', setTheme: () => {} });
const useTheme = () => useContext(ThemeContext);

// Utilities
const formatCurrency = (n) => n >= 1000000 ? `$${(n/1000000).toFixed(1)}M` : n >= 1000 ? `$${(n/1000).toFixed(0)}K` : `$${n}`;
const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const daysAgo = (d) => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
const generateId = () => Math.random().toString(36).substr(2, 9);
const daysUntil = (d) => Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
const formatRelativeTime = (d) => {
  const days = daysAgo(d);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

// Returns the effective cost basis for any investment object.
// Falls back to amount if costBasis is not explicitly set — works for all existing and future deals.
const getEffectiveCostBasis = (inv = {}) => {
  if (inv.costBasis && inv.costBasis > 0) return inv.costBasis;
  return inv.amount || 0;
};

// Returns true only when cost basis meaningfully differs from amount (>$1 to avoid float noise).
// When false, the UI stays clean — no extra row shown.
const hasSeparateCostBasis = (inv = {}) => {
  if (!inv.costBasis || inv.costBasis <= 0) return false;
  return Math.abs(inv.costBasis - (inv.amount || 0)) > 1;
};

// ── VALUATION ENGINE ─────────────────────────────────────────────────────────
// Climate/deep tech maturity is defined by hardware readiness, not ARR.
// Stages map to TRL (Technology Readiness Level) bands, not revenue multiples.
const STAGE_MATURITY = {
  'pre-seed': 'lab',       // TRL 1–3: bench science, proof-of-concept
  'seed':     'pilot',     // TRL 4–6: pilot plant, field demo, first offtake
  'series-a': 'scale',     // TRL 7–8: commercial scale, first revenue
  'series-b': 'scale',
  'series-c': 'deploy',    // TRL 9: full deployment, project finance, offtake secured
  'series-e': 'deploy',
  'growth':   'deploy',
  'lp-fund':  'fund',
};

// Climate/deep tech valuation methods by TRL band:
// - lab/pilot: mark-at-cost — no revenue comp exists, DCF meaningless pre-demonstration
// - scale: last-round — priced rounds exist but comps are thin; use sparingly
// - deploy: last-round with project finance haircut if applicable
// - fund: LP NAV
const getValuationMethod = (deal) => {
  const inv = deal.investment || {};
  if (inv.valuationMethod) return inv.valuationMethod;
  const maturity = STAGE_MATURITY[deal.stage] || 'lab';
  if (maturity === 'lab' || maturity === 'pilot') return 'mark-at-cost';
  if (maturity === 'fund') return 'nav-lp';
  return 'last-round';
};

const calcImpliedValue = (deal) => {
  const inv = deal.investment || {};
  const method = getValuationMethod(deal);
  const costBasis = getEffectiveCostBasis(inv);
  if (method === 'mark-at-cost') return costBasis;
  if (inv.impliedValue && inv.impliedValue > 0) return inv.impliedValue;
  if (inv.ownershipPercent && inv.impliedValuation) {
    return Math.round((inv.ownershipPercent / 100) * inv.impliedValuation);
  }
  if (deal.terms?.cap && inv.impliedValuation) {
    return Math.round(costBasis * Math.min(inv.impliedValuation / deal.terms.cap, 3));
  }
  if (method === 'nav-lp') {
    const nav = deal.fundData?.currentNAV || 0;
    const lpPct = deal.fundData?.lpOwnershipPercent || 0;
    return Math.round(nav * (lpPct / 100));
  }
  return costBasis;
};

// calcMOIC defined below

const getValuationLabel = (method) => ({
  'mark-at-cost': 'Mark at cost', 'last-round': 'Last round',
  'safe-cap': 'SAFE cap', 'nav-lp': 'Fund NAV', 'comparables': 'Comparables',
}[method] || method);

const getMarkStaleness = (deal) => {
  const date = deal.investment?.lastValuationDate;
  if (!date) return 'unknown';
  const days = daysAgo(date);
  if (days < 90) return 'fresh'; if (days < 180) return 'ok';
  if (days < 365) return 'stale'; return 'very-stale';
};

// ── CLIMATE/DEEP TECH HEALTH SCORING ENGINE ───────────────────────────────────
//
// SaaS health = MoM ARR, churn, CAC/LTV. That framework is useless here.
// Climate/deep tech health = proof that physics works at scale, capital is
// available to get there, policy isn't a headwind, and the team can execute
// on a 10–15 year commercialization timeline.
//
// Signal taxonomy by TRL band:
//
// LAB (pre-seed/seed, TRL 1–3):
//   Positive: breakthrough publication / patent, top-tier lab validation,
//             government R&D grant (DOE ARPA-E, DARPA, SBIR), strategic hire
//             from national lab or industry, pilot MOU signed
//   Negative: PI departure, key IP dispute, replication failure reported,
//             fundamental physics challenge surfaced publicly
//   Neutral/expected: slow cadence is NORMAL — science takes time
//   Valuation: mark at cost; MOIC is irrelevant pre-demonstration
//
// PILOT (seed/A, TRL 4–6):
//   Positive: pilot plant operational, performance at or above spec,
//             first LOI or offtake letter, DOE loan guarantee application,
//             strategic partner / corporate co-investor, IRA/CHIPS incentive qualified,
//             cost curve improvement demonstrated
//   Negative: pilot underperformance vs. published spec, cost overrun >2x,
//             key customer LOI not converting, regulatory obstacle,
//             competing technology reaches same milestone faster
//   Watch: pilot silence >90d after announced, founder team turnover,
//          fundraise taking >12mo
//
// SCALE (Series A/B, TRL 7–8):
//   Positive: commercial-scale unit operating, first paying customer,
//             project finance commitment, utility or industrial offtake signed,
//             federal funding (IRA 45Q/48C/45V credits locked), Series close
//   Negative: cost-per-unit not tracking to target, capacity factor underperformance,
//             supply chain constraint (critical minerals), financing round struggling,
//             key utility partner pulling back
//   MOIC matters here: last-round mark with staleness penalty
//
// DEPLOY (Series C+, TRL 9):
//   Positive: GW/GWh or kt deployed, project pipeline >3x current capacity,
//             investment grade credit rating, replication in second geography,
//             M&A interest / strategic acquirer
//   Negative: project cancellation, permitting delays >18mo, policy reversal
//             (ITC/PTC removal), commodity input price shock
//   MOIC + staleness both matter
//
// FUND (LP position):
//   Health = DPI progress, portfolio construction quality, GP access to next fund,
//            vintage/sector alignment with current deal flow
//
// POLICY RISK is a cross-cutting dimension unique to climate tech:
//   Any signal containing keywords about IRA rollback, EPA rule reversal,
//   tariff on critical minerals, or utility rate case loss gets a flag

// Signal keyword classifiers for climate/deep tech context
const CLIMATE_SIGNAL_CLASSIFIERS = {
  hardware_milestone: ['pilot', 'commissioning', 'operational', 'plant', 'trl', 'demonstration', 'kilowatt', 'megawatt', 'gigawatt', 'mwh', 'gwh', 'tonne', 'metric ton', 'capacity factor', 'efficiency record'],
  policy_positive: ['ira', 'inflation reduction act', 'doe loan', 'arpa-e', 'doe grant', 'sbir', '45q', '45v', '48c', 'investment tax credit', 'production tax credit', 'doe conditional commitment', 'doe guarantee'],
  policy_risk: ['rollback', 'repeal', 'tariff', 'trade war', 'ira repeal', 'tax credit elimination', 'epa reversal', 'permit denied', 'environmental review', 'nepa delay', 'utility rate case', 'stranded asset'],
  offtake: ['offtake', 'power purchase agreement', 'ppa', 'supply agreement', 'loi', 'letter of intent', 'mou', 'memorandum of understanding', 'term sheet', 'anchor customer', 'anchor tenant'],
  project_finance: ['project finance', 'debt financing', 'green bond', 'tax equity', 'doe loan guarantee', 'investment grade', 'credit rating', 'financial close', 'construction financing'],
  competing_tech: ['competing', 'competitor', 'rival technology', 'alternative approach', 'cost parity', 'cheaper than', 'beats on cost'],
  team_risk: ['ceo departure', 'cto left', 'co-founder left', 'founder resigned', 'executive turnover', 'layoffs', 'rif', 'headcount reduction'],
  funding_signal: ['series a', 'series b', 'series c', 'seed round', 'raised', 'closed funding', 'oversubscribed', 'strategic investment', 'corporate venture'],
};

// ── EXTRACT HEALTH SIGNALS FROM INVESTOR NOTES / FOUNDER UPDATES ──────────────
// Parses free-text update notes (founder emails pasted in, investor observations)
// and extracts structured signals that feed into calcDealHealth.
// This bridges the gap when external agent signals are sparse for early-stage cos.

const UPDATE_SIGNAL_PATTERNS = {
  // Positive signals
  runway_good:     { pattern: /runway.{0,30}(\d+)\s*(month|mo|yr|year)/i, sentiment: 'positive', type: 'funding_signal', label: 'Runway reported from update' },
  raised:          { pattern: /raised|closed.{0,15}round|new.{0,10}funding|investment.{0,10}closed/i, sentiment: 'positive', type: 'funding_signal', label: 'Funding event mentioned' },
  customer_win:    { pattern: /customer|client|contract|signed|offtake|ppa|loi|mou/i, sentiment: 'positive', type: 'offtake', label: 'Customer or offtake signal' },
  milestone_hit:   { pattern: /launched|shipped|deployed|operational|commission|on.track|ahead.of/i, sentiment: 'positive', type: 'hardware_milestone', label: 'Milestone progress reported' },
  grant_award:     { pattern: /grant|award|doe|arpa|sbir|nsf|funded.by/i, sentiment: 'positive', type: 'policy_positive', label: 'Grant or public funding mentioned' },
  hiring:          { pattern: /hired|new.{0,10}(cto|cfo|vp|head|chief)|joined.the.team/i, sentiment: 'positive', type: 'funding_signal', label: 'Key hire mentioned' },
  // Negative / warning signals
  runway_low:      { pattern: /runway.{0,30}(3|4|5|6).{0,10}month|burn.{0,15}high|need.{0,10}bridge|running.{0,10}low/i, sentiment: 'negative', type: 'team_risk', label: 'Low runway signal in update' },
  pivot:           { pattern: /pivot|change.{0,10}direction|shift.{0,10}focus|new.{0,10}model/i, sentiment: 'negative', type: 'risk', label: 'Pivot or direction change mentioned' },
  delay:           { pattern: /delay|behind.{0,10}schedule|slower.than|push.{0,10}back|not.{0,10}on.track/i, sentiment: 'negative', type: 'risk', label: 'Delay or setback mentioned' },
  team_issue:      { pattern: /left.{0,10}(company|team)|resigned|departed|co-founder.{0,10}(left|out)/i, sentiment: 'negative', type: 'team_risk', label: 'Team departure mentioned' },
  regulatory:      { pattern: /permit|denied|rejected|regulatory.{0,15}issue|epa|blocked/i, sentiment: 'negative', type: 'policy_risk', label: 'Regulatory issue mentioned' },
  // Neutral but important
  fundraising:     { pattern: /raising|fundrais|looking.for.{0,15}(round|invest)|in.{0,10}market/i, sentiment: 'positive', type: 'funding_signal', label: 'Active fundraise mentioned' },
  cost_issue:      { pattern: /cost.{0,20}(over|above|higher)|over.budget|more.expensive.than/i, sentiment: 'negative', type: 'risk', label: 'Cost overrun signal' },
};

const parseUpdateForSignals = (text, date) => {
  if (!text || text.trim().length < 20) return [];
  const signals = [];
  const seen = new Set();
  for (const [key, { pattern, sentiment, type, label }] of Object.entries(UPDATE_SIGNAL_PATTERNS)) {
    if (pattern.test(text) && !seen.has(type + sentiment)) {
      seen.add(type + sentiment);
      signals.push({
        type,
        title: label,
        description: text.slice(0, 120) + (text.length > 120 ? '…' : ''),
        sentiment,
        source: 'Investor note',
        sourceUrl: null,
        date: date || new Date().toISOString(),
        urgency: sentiment === 'negative' ? 'high' : 'low',
        fromUpdate: true,
      });
    }
  }
  return signals;
};

// Extract all signals from a deal's update log
const getUpdateLogSignals = (deal) => {
  const updates = (deal.milestones || []).filter(m => m.type === 'update' || m.type === 'investor-update');
  // Only use updates from the last 180 days — older notes are less relevant to current health
  const recent = updates.filter(m => daysAgo(m.date) < 180);
  return recent.flatMap(m => parseUpdateForSignals(m.description, m.date));
};


const classifySignal = (signal) => {
  const text = `${signal.title} ${signal.description}`.toLowerCase();
  const tags = [];
  for (const [tag, keywords] of Object.entries(CLIMATE_SIGNAL_CLASSIFIERS)) {
    if (keywords.some(kw => text.includes(kw))) tags.push(tag);
  }
  return tags;
};

const calcDealHealth = (deal, signals = []) => {
  const inv = deal.investment || {};
  const maturity = STAGE_MATURITY[deal.stage] || 'lab';
  // Merge external signals with signals extracted from the investor's own update log.
  // Update log signals fill the gap when the agent finds nothing for early-stage companies.
  const updateLogSignals = getUpdateLogSignals(deal);
  const allSignals = [...signals, ...updateLogSignals];
  // Use allSignals from here on — replace references to signals in classifier loop
  const signalsToClassify = allSignals;
  const costBasis = getEffectiveCostBasis(inv);
  const implied = calcImpliedValue(deal);
  const moic = costBasis > 0 ? implied / costBasis : null;
  const method = getValuationMethod(deal);

  let score = 50;
  const factors = [];
  let shouldCheckIn = false;
  let checkInReason = null;

  // ── 1. FOUNDER COMMUNICATION ─────────────────────────────────────────────
  // Climate/deep tech founders are often in the lab or at pilot sites.
  // Silence is more normal than in SaaS — so thresholds are longer.
  const lastUpdate = inv.lastUpdateReceived || deal.lastUpdateReceived;
  const nextExpected = inv.nextUpdateExpected || deal.nextUpdateExpected;
  const daysSinceUpdate = lastUpdate ? daysAgo(lastUpdate) : 999;
  const daysUntilNextUpdate = nextExpected ? daysUntil(nextExpected) : null;
  // Overdue threshold: 30d for pilot/scale (more active), 60d for lab (science time)
  const overdueThreshold = (maturity === 'lab') ? 60 : 30;
  const updateOverdue = daysUntilNextUpdate !== null && daysUntilNextUpdate < -overdueThreshold;
  const longSilence = daysSinceUpdate > (maturity === 'lab' ? 180 : 90);

  if (updateOverdue) {
    score -= 12; shouldCheckIn = true;
    checkInReason = `Update ${Math.abs(daysUntilNextUpdate)}d overdue`;
    factors.push({ label: 'Update overdue', impact: -12, type: 'warning' });
  } else if (daysSinceUpdate < 45) {
    score += 8; factors.push({ label: 'Recent founder update', impact: 8, type: 'positive' });
  }
  if (longSilence) {
    score -= 8;
    factors.push({ label: `${Math.round(daysSinceUpdate/30)}mo communication silence`, impact: -8, type: 'warning' });
    if (!shouldCheckIn) { shouldCheckIn = true; checkInReason = 'Extended silence'; }
  }

  // ── 2. CLASSIFY & WEIGHT EXTERNAL SIGNALS ─────────────────────────────────
  // Not all signals are equal. A DOE loan guarantee is 10x more meaningful
  // than a press mention. Hardware milestones prove the science works.
  // Policy risks are existential for IRA-dependent business models.
  const classifiedSignals = signalsToClassify.map(s => ({ ...s, tags: classifySignal(s) }));

  classifiedSignals.forEach(s => {
    const isPositive = s.sentiment === 'positive';
    const isNegative = s.sentiment === 'negative';

    if (s.tags.includes('hardware_milestone')) {
      const impact = isPositive ? 15 : -18;
      score += impact;
      factors.push({ label: isPositive ? 'Hardware milestone confirmed' : 'Hardware milestone setback', impact, type: isPositive ? 'positive' : 'negative' });
      if (isNegative) { shouldCheckIn = true; checkInReason = checkInReason || 'Hardware setback reported'; }
    }
    if (s.tags.includes('policy_positive') && isPositive) {
      score += 12;
      factors.push({ label: 'Federal funding / policy tailwind', impact: 12, type: 'positive' });
    }
    if (s.tags.includes('policy_risk')) {
      score -= 15; shouldCheckIn = true;
      checkInReason = checkInReason || 'Policy risk detected';
      factors.push({ label: 'Policy / regulatory risk signal', impact: -15, type: 'negative' });
    }
    if (s.tags.includes('offtake') && isPositive) {
      score += 14;
      factors.push({ label: 'Offtake / customer signal', impact: 14, type: 'positive' });
    }
    if (s.tags.includes('project_finance') && isPositive) {
      score += 12;
      factors.push({ label: 'Project finance signal', impact: 12, type: 'positive' });
    }
    if (s.tags.includes('team_risk')) {
      score -= 14; shouldCheckIn = true;
      checkInReason = checkInReason || 'Team risk signal';
      factors.push({ label: 'Team / leadership risk', impact: -14, type: 'negative' });
    }
    if (s.tags.includes('funding_signal') && isPositive) {
      score += 10;
      factors.push({ label: 'New funding round signal', impact: 10, type: 'positive' });
    }
    if (s.tags.includes('competing_tech') && isNegative) {
      score -= 8;
      factors.push({ label: 'Competing technology gaining ground', impact: -8, type: 'warning' });
    }
    // Generic sentiment for unclassified signals (lower weight)
    if (s.tags.length === 0) {
      const impact = isPositive ? 5 : isNegative ? -7 : 0;
      if (impact !== 0) {
        score += impact;
        factors.push({ label: isPositive ? 'Positive press signal' : 'Negative press signal', impact, type: isPositive ? 'positive' : 'negative' });
      }
    }
  });

  // ── 3. TRL-BAND SPECIFIC LOGIC ────────────────────────────────────────────

  if (maturity === 'lab') {
    // Lab stage: prove the science. Milestones are publications, grants, patents.
    // Long timelines are expected — don't penalize for slow progress unless silent.
    const scienceMilestones = (deal.milestones || []).filter(m =>
      daysAgo(m.date) < 180 && ['product', 'partnership', 'fundraising'].includes(m.type)
    ).length;
    if (scienceMilestones >= 1) { score += 10; factors.push({ label: 'Recent technical milestone', impact: 10, type: 'positive' }); }
    factors.push({ label: 'Lab stage — marked at cost, TRL 1–3', impact: 0, type: 'info' });
  }

  if (maturity === 'pilot') {
    // Pilot stage: the hard part. Most deep tech companies die here.
    // Key signals: pilot plant status, cost vs. spec, regulatory progress.
    const pilotMilestones = (deal.milestones || []).filter(m =>
      daysAgo(m.date) < 180 && m.type !== 'update'
    ).length;
    if (pilotMilestones >= 2) { score += 12; factors.push({ label: 'Active pilot cadence', impact: 12, type: 'positive' }); }
    else if (pilotMilestones === 0 && daysSinceUpdate > 120) {
      score -= 12; shouldCheckIn = true;
      checkInReason = checkInReason || 'Pilot progress unclear';
      factors.push({ label: 'No pilot progress signals in 4mo', impact: -12, type: 'warning' });
    }
    factors.push({ label: 'Pilot stage — SAFE/cap mark, TRL 4–6', impact: 0, type: 'info' });
  }

  if (maturity === 'scale') {
    // Scale stage: does the unit economics work at commercial scale?
    // MOIC starts to matter here — there's a market price to compare against.
    if (moic !== null) {
      if (moic >= 2.0) { score += 18; factors.push({ label: `${moic.toFixed(1)}x on last-round mark`, impact: 18, type: 'positive' }); }
      else if (moic >= 1.3) { score += 8; factors.push({ label: `${moic.toFixed(1)}x on last-round mark`, impact: 8, type: 'positive' }); }
      else if (moic < 0.8) {
        score -= 18; shouldCheckIn = true;
        checkInReason = checkInReason || 'Mark below cost basis';
        factors.push({ label: `${moic.toFixed(1)}x — marked below cost`, impact: -18, type: 'negative' });
      } else {
        factors.push({ label: `${moic.toFixed(1)}x on last-round mark`, impact: 0, type: 'info' });
      }
    }
    const staleness = getMarkStaleness(deal);
    if (staleness === 'stale') { score -= 5; factors.push({ label: 'Valuation mark 6–12mo old', impact: -5, type: 'warning' }); }
    if (staleness === 'very-stale') { score -= 10; factors.push({ label: 'Valuation mark 12mo+ old', impact: -10, type: 'warning' }); }
  }

  if (maturity === 'deploy') {
    // Deploy stage: project pipeline, GW deployed, financing in place.
    if (moic !== null) {
      if (moic >= 3.0) { score += 22; factors.push({ label: `${moic.toFixed(1)}x — deployment premium`, impact: 22, type: 'positive' }); }
      else if (moic >= 1.5) { score += 12; factors.push({ label: `${moic.toFixed(1)}x on last-round mark`, impact: 12, type: 'positive' }); }
      else if (moic < 1.0) {
        score -= 20; shouldCheckIn = true;
        checkInReason = checkInReason || 'Mark below cost basis at deploy stage';
        factors.push({ label: `${moic.toFixed(1)}x — late-stage mark below cost is serious`, impact: -20, type: 'negative' });
      } else {
        factors.push({ label: `${moic.toFixed(1)}x on last-round mark`, impact: 0, type: 'info' });
      }
    }
    const staleness = getMarkStaleness(deal);
    if (staleness === 'stale') { score -= 8; factors.push({ label: 'Late-stage mark 6–12mo old', impact: -8, type: 'warning' }); }
    if (staleness === 'very-stale') { score -= 15; shouldCheckIn = true; checkInReason = checkInReason || 'Stale mark at deploy stage'; factors.push({ label: 'Late-stage mark 12mo+ old — refresh needed', impact: -15, type: 'negative' }); }
  }

  if (maturity === 'fund') {
    // LP fund: DPI, TVPI, vintage alignment, GP quality signals
    if (moic !== null) {
      if (moic >= 1.5) { score += 15; factors.push({ label: `${moic.toFixed(1)}x fund NAV mark`, impact: 15, type: 'positive' }); }
      else if (moic >= 1.0) { score += 5; factors.push({ label: `${moic.toFixed(1)}x fund NAV mark`, impact: 5, type: 'info' }); }
    }
    // LP funds: silence is fine, quarterly reporting is standard
    factors.push({ label: 'LP fund — quarterly NAV cadence normal', impact: 0, type: 'info' });
  }

  // ── 4. SELF-REPORTED MONITORING ───────────────────────────────────────────
  const ms = deal.monitoring || {};
  if (ms.healthStatus === 'thriving') { score += 8; factors.push({ label: 'Founder reports on track', impact: 8, type: 'positive' }); }
  if (ms.healthStatus === 'struggling') {
    score -= 15; shouldCheckIn = true;
    checkInReason = checkInReason || 'Self-reported struggling';
    factors.push({ label: 'Self-reported struggling', impact: -15, type: 'negative' });
  }
  if (ms.fundraisingStatus === 'exploring') { score += 6; factors.push({ label: 'Next round in progress', impact: 6, type: 'positive' }); }
  if (ms.runwayMonths && ms.runwayMonths < 9) {
    score -= 12; shouldCheckIn = true;
    checkInReason = checkInReason || `${ms.runwayMonths}mo runway`;
    factors.push({ label: `${ms.runwayMonths}mo runway — bridge needed`, impact: -12, type: 'negative' });
  }

  score = Math.max(0, Math.min(100, score));

  // Climate/deep tech health labels reflect the domain — not generic startup health
  const label = score >= 80 ? 'On Track' : score >= 62 ? 'Steady' : score >= 42 ? 'Investigate' : 'Critical';
  const color = score >= 80 ? '#10b981' : score >= 62 ? '#5B6DC4' : score >= 42 ? '#f59e0b' : '#ef4444';
  const bg = score >= 80 ? 'bg-emerald-50 dark:bg-emerald-900/20' : score >= 62 ? 'bg-indigo-50 dark:bg-indigo-900/20' : score >= 42 ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-red-50 dark:bg-red-900/20';

  // Deduplicate factors (same label can appear from multiple signal loops)
  const seen = new Set();
  const dedupedFactors = factors.filter(f => { const k = f.label; if (seen.has(k)) return false; seen.add(k); return true; });

  return { score, label, color, bg, factors: dedupedFactors, shouldCheckIn, checkInReason, maturity, moic, implied, method };
};

const calcPortfolioHealth = (deals, signalsByDeal = {}) => {
  const invested = deals.filter(d => d.status === 'invested');
  if (!invested.length) return { score: 0, label: 'No data', color: '#78716c', dealScores: [], urgent: [] };
  const dealScores = invested.map(d => ({ id: d.id, name: d.companyName, ...calcDealHealth(d, signalsByDeal[d.id] || []) }));
  // Weight by cost basis — larger positions drive portfolio health
  const totalBasis = dealScores.reduce((sum, ds) => {
    const inv = deals.find(d => d.id === ds.id)?.investment || {};
    return sum + getEffectiveCostBasis(inv);
  }, 0);
  const weightedScore = dealScores.reduce((sum, ds) => {
    const inv = deals.find(d => d.id === ds.id)?.investment || {};
    const weight = totalBasis > 0 ? getEffectiveCostBasis(inv) / totalBasis : 1 / dealScores.length;
    return sum + ds.score * weight;
  }, 0);
  const score = Math.round(weightedScore);
  const label = score >= 80 ? 'On Track' : score >= 62 ? 'Steady' : score >= 42 ? 'Investigate' : 'Critical';
  const color = score >= 80 ? '#10b981' : score >= 62 ? '#5B6DC4' : score >= 42 ? '#f59e0b' : '#ef4444';
  return { score, label, color, dealScores, urgent: dealScores.filter(ds => ds.shouldCheckIn) };
};

// ── AUTONOMOUS MONITORING AGENT ────────────────────────────────────────────────
const AGENT_CACHE_KEY = 'convex_agent_signals_v2';
const getAgentCache = () => {
  try { return JSON.parse(localStorage.getItem(AGENT_CACHE_KEY) || '{}'); } catch { return {}; }
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const AGENT_SCHEDULE_KEY = 'convex_agent_next_run';

const loadAgentCache = () => { try { return JSON.parse(localStorage.getItem(AGENT_CACHE_KEY) || '{}'); } catch { return {}; } };
const saveAgentCache = (cache) => { try { localStorage.setItem(AGENT_CACHE_KEY, JSON.stringify(cache)); } catch {} };
const getNextRunTime = () => { try { return parseInt(localStorage.getItem(AGENT_SCHEDULE_KEY) || '0', 10); } catch { return 0; } };
const setNextRunTime = (ms) => { try { localStorage.setItem(AGENT_SCHEDULE_KEY, String(Date.now() + ms)); } catch {} };

const fetchSignalForDeal = async (deal) => {
  const maturity = STAGE_MATURITY[deal.stage] || 'lab';

  // Signal priorities are different by TRL band — tell the agent what to look for
  const maturityContext = {
    lab:    'This is a lab-stage deep tech company (TRL 1–3). Prioritize: scientific publications, patent filings, government grants (DOE ARPA-E, SBIR, DARPA), national lab partnerships, key technical hires, proof-of-concept validations. Do NOT penalize for slow commercial progress — that is expected.',
    pilot:  'This is a pilot-stage climate/deep tech company (TRL 4–6). Prioritize: pilot plant status and performance vs. spec, cost curve progress, regulatory milestones, LOI/MOU/offtake letters, IRA or DOE incentive qualification, strategic corporate co-investors. Flag any pilot underperformance, cost overruns, or founder departures.',
    scale:  'This is a commercial-scale climate tech company (TRL 7–8). Prioritize: first commercial customers, offtake agreements, project finance commitments, IRA tax credit eligibility (45Q, 45V, 48C), unit economics vs. targets, next funding round signals. Flag supply chain issues, cost-per-unit misses, or utility partner pullbacks.',
    deploy: 'This is a deployment-stage climate tech company (TRL 9). Prioritize: GW/GWh/kt deployed, project pipeline, project finance closes, M&A interest, replication in new geographies, investment-grade signals. Flag project cancellations, permitting delays, policy reversal risks (ITC/PTC), commodity input shocks.',
    fund:   'This is a climate/deep tech LP fund. Prioritize: portfolio company milestones, new fund close signals, GP thought leadership, DPI/TVPI updates, notable exits or writedowns, fund strategy shifts.',
  }[maturity] || '';

  const systemPrompt = `You are a climate and deep tech investment intelligence agent. Your job is to surface signals that matter for a hardware-intensive, long-timeline climate technology investment — NOT SaaS metrics like ARR or churn.

${maturityContext}

Signal type taxonomy for this domain:
- "hardware_milestone": pilot plant, demonstration, performance record, TRL advance
- "policy": IRA credits, DOE loan guarantee, EPA rule, permit, regulatory decision
- "offtake": PPA, supply agreement, LOI, MOU, anchor customer
- "project_finance": debt financing, tax equity, green bond, financial close
- "fundraising": venture round, strategic investment, grant award
- "team": executive hire, departure, org change
- "risk": cost overrun, technical setback, policy reversal, supply chain, competition
- "press": general coverage, awards, conference

For sentiment: positive/neutral/negative. For urgency: high (act within 2 weeks), medium (worth noting), low (FYI).

Return ONLY valid JSON, no markdown, no preamble:
{"signals":[{"type":"hardware_milestone|policy|offtake|project_finance|fundraising|team|risk|press","title":"string","description":"1-2 sentences","sentiment":"positive|neutral|negative","source":"source name","sourceUrl":"url or null","date":"ISO date string","urgency":"high|medium|low"}],"summary":"2-sentence assessment of company trajectory based on what you found","checkInRecommended":true|false,"checkInReason":"specific reason or null"}
Return at most 6 signals, prioritized by relevance to the TRL stage above. If nothing found: {"signals":[],"summary":"No recent public signals found. This is common for early-stage deep tech companies.","checkInRecommended":false,"checkInReason":null}`;

  const userPrompt = `Company: ${deal.companyName}
Industry: ${deal.industry}
Stage: ${deal.stage} (maturity band: ${maturity})
Website: ${deal.website || 'unknown'}
Search for signals in the last 6 months. Focus on what matters for a ${maturity}-stage climate/deep tech company: ${
    maturity === 'lab' ? 'scientific validation, grants, technical hires' :
    maturity === 'pilot' ? 'pilot performance, offtake letters, cost progress' :
    maturity === 'scale' ? 'commercial customers, project finance, IRA credits' :
    maturity === 'deploy' ? 'deployment scale, project pipeline, financing closes' :
    'portfolio performance, fund news'
  }.`;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  const data = await response.json();
  const textBlock = data.content.filter(b => b.type === 'text').pop();
  if (!textBlock?.text) return { signals: [], summary: 'No data.', checkInRecommended: false };
  return JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
};

const useMonitoringAgent = (deals) => {
  const [agentData, setAgentData] = useState(() => loadAgentCache());
  const [agentStatus, setAgentStatus] = useState('idle');
  const [lastRun, setLastRun] = useState(null);
  const [nextRun, setNextRunState] = useState(null);
  const [runLog, setRunLog] = useState([]);
  const runningRef = useRef(false);
  const portfolioDeals = deals.filter(d => d.status === 'invested');

  const runAgent = useCallback(async (force = false) => {
    if (runningRef.current) return;
    const cache = loadAgentCache();
    const now = Date.now();
    const toFetch = portfolioDeals.filter(deal => {
      if (force) return true;
      const cached = cache[deal.id];
      return !cached || (now - new Date(cached.fetchedAt).getTime()) > CACHE_TTL_MS;
    });
    if (toFetch.length === 0) { setAgentStatus('done'); setLastRun(new Date()); return; }
    runningRef.current = true;
    setAgentStatus('running');
    setRunLog(toFetch.map(d => ({ id: d.id, name: d.companyName, status: 'pending' })));
    const updated = { ...cache };
    for (let i = 0; i < toFetch.length; i++) {
      const deal = toFetch[i];
      setRunLog(prev => prev.map(l => l.id === deal.id ? { ...l, status: 'fetching' } : l));
      try {
        if (i > 0) await new Promise(r => setTimeout(r, 3000));
        const result = await fetchSignalForDeal(deal);
        updated[deal.id] = { ...result, fetchedAt: new Date().toISOString(), dealName: deal.companyName };
        setRunLog(prev => prev.map(l => l.id === deal.id ? { ...l, status: 'done', count: result.signals?.length || 0 } : l));
      } catch (e) {
        updated[deal.id] = updated[deal.id] || { signals: [], summary: 'Fetch failed.', checkInRecommended: false, fetchedAt: new Date().toISOString(), dealName: deal.companyName };
        setRunLog(prev => prev.map(l => l.id === deal.id ? { ...l, status: 'error' } : l));
      }
    }
    saveAgentCache(updated);
    setAgentData(updated);
    setNextRunTime(CACHE_TTL_MS);
    setNextRunState(new Date(Date.now() + CACHE_TTL_MS));
    setLastRun(new Date());
    setAgentStatus('done');
    runningRef.current = false;
  }, [portfolioDeals.map(d => d.id).join(',')]);

  useEffect(() => {
    const check = () => { if (Date.now() >= getNextRunTime()) runAgent(); else setNextRunState(new Date(getNextRunTime())); };
    check();
    const iv = setInterval(check, 30 * 60 * 1000);
    return () => clearInterval(iv);
  }, [runAgent]);

  const signalsByDeal = Object.fromEntries(Object.entries(agentData).map(([id, d]) => [id, d.signals || []]));
  const urgentFeed = Object.entries(agentData)
    .flatMap(([dealId, d]) => (d.signals || []).filter(s => s.urgency === 'high' || s.sentiment === 'negative').map(s => ({ ...s, dealId, dealName: d.dealName })))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return { agentData, signalsByDeal, agentStatus, lastRun, nextRun, runLog, urgentFeed, triggerRun: () => runAgent(true) };
};


// Default settings
const DEFAULT_SETTINGS = {
  profile: { name: '', email: '', timezone: 'America/New_York' },
  accountType: 'Solo angel',
  notifications: { push: false, reminderFrequency: 'daily', quietHoursStart: '22:00', quietHoursEnd: '08:00' },
  appearance: 'light'
};

// Portfolio statuses
const STATUS_CONFIG = {
  'invested': { label: 'Invested', color: 'bg-emerald-500', light: 'bg-emerald-50 text-emerald-600 border border-emerald-200', question: 'Capital deployed' },
  'watching': { label: 'Watching', color: 'bg-stone-400',   light: 'bg-stone-100 text-stone-500 border border-stone-200',   question: 'Tracking, not yet invested' },
  'passed':   { label: 'Passed',   color: 'bg-stone-300',   light: 'bg-stone-50 text-stone-400 border border-stone-200',    question: 'Decided not to invest' },
};

// Demo Data
const createDemoDeals = () => [
  // PORTFOLIO - Invested companies
  {
    id: '1', companyName: 'Form Energy', logoUrl: 'https://ui-avatars.com/api/?name=FE&background=10b981&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'Long-Duration Storage', stage: 'series-e',
    website: 'https://formenergy.com',
    source: { type: 'syndicate', name: 'CladoVC' },
    lastAssessedAt: new Date(Date.now() - 5*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 365*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 5*86400000).toISOString(),
    lastUpdateReceived: new Date(Date.now() - 14*86400000).toISOString(),
    createdAt: new Date(Date.now() - 400*86400000).toISOString(),
    overview: 'Iron-air battery technology enabling multi-day energy storage at 1/10th the cost of lithium-ion. Critical infrastructure for a fully renewable grid.',
    founders: [
      { name: 'Mateo Jaramillo', role: 'CEO', background: 'Ex-Tesla VP of Energy Products, Tesla Powerwall & Megapack creator' },
      { name: 'Yet-Ming Chiang', role: 'Co-Founder', background: 'MIT Materials Science professor, battery chemistry pioneer' }
    ],
    terms: { instrument: 'Equity', proRata: false, notes: 'Series E participation' },
    documents: [
      { id: 'd1', label: 'Stock Purchase Agreement', url: 'https://drive.google.com', type: 'equity', addedAt: new Date(Date.now() - 365*86400000).toISOString() },
      { id: 'd2', label: 'K-1 2023', url: 'https://drive.google.com', type: 'tax', addedAt: new Date(Date.now() - 90*86400000).toISOString() },
    ],
    attachments: [],
    investment: {
      amount: 25000, costBasis: 25000, vehicle: 'Equity', date: new Date(Date.now() - 365*86400000).toISOString(),
      ownershipPercent: 0.01,
      impliedValuation: 1500000000, impliedValue: 45000, lastValuationDate: new Date(Date.now() - 90*86400000).toISOString(), valuationMethod: 'last-round',
      updateFrequency: 'quarterly', metricsToWatch: ['GWh capacity installed', 'Cost per kWh', 'Utility offtake contracts'],
      nextUpdateExpected: new Date(Date.now() + 20*86400000).toISOString()
    },
    healthHistory: [
      { date: new Date(Date.now() - 300*86400000).toISOString(), score: 72, label: 'Steady' },
      { date: new Date(Date.now() - 240*86400000).toISOString(), score: 78, label: 'Steady' },
      { date: new Date(Date.now() - 180*86400000).toISOString(), score: 82, label: 'On Track' },
      { date: new Date(Date.now() - 120*86400000).toISOString(), score: 85, label: 'On Track' },
      { date: new Date(Date.now() - 60*86400000).toISOString(), score: 80, label: 'On Track' },
      { date: new Date(Date.now() - 14*86400000).toISOString(), score: 74, label: 'Steady' },
    ],
    monitoring: { healthStatus: 'thriving', fundraisingStatus: 'not-raising', runwayMonths: 24, followOns: [] },
    milestones: [
      { id: 'm1', type: 'fundraising', title: 'Series E — $450M', description: 'Led by ArcelorMittal and GIC. Total raised over $1B.', date: new Date(Date.now() - 300*86400000).toISOString() },
      { id: 'm2', type: 'partnership', title: 'Georgia Power offtake', description: 'First utility-scale deployment agreement for multi-day storage', date: new Date(Date.now() - 180*86400000).toISOString() },
      { id: 'm3', type: 'product', title: 'Weirton factory groundbreaking', description: 'Manufacturing facility in West Virginia, 750 jobs', date: new Date(Date.now() - 90*86400000).toISOString() },
      { id: 'm4', type: 'update', title: 'Founder update', description: 'First battery systems rolling off the line. On track for utility delivery Q3.', date: new Date(Date.now() - 14*86400000).toISOString() }
    ]
  },
  {
    id: '2', companyName: 'Exowatt', logoUrl: 'https://ui-avatars.com/api/?name=EW&background=f59e0b&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'AI Energy Infrastructure', stage: 'seed',
    website: 'https://exowatt.com',
    source: { type: 'syndicate', name: 'CladoVC' },
    lastAssessedAt: new Date(Date.now() - 3*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 200*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 3*86400000).toISOString(),
    lastUpdateReceived: new Date(Date.now() - 45*86400000).toISOString(),
    createdAt: new Date(Date.now() - 220*86400000).toISOString(),
    overview: 'Modular solar thermal energy storage systems purpose-built for AI data centers. Delivers firm, low-cost power without grid dependency.',
    founders: [
      { name: 'Joey Kline', role: 'CEO', background: 'Ex-SpaceX, energy infrastructure focus' },
    ],
    terms: { instrument: 'SAFE', cap: 85000000, proRata: true, mfn: false },
    documents: [
      { id: 'd1', label: 'SAFE Agreement', url: 'https://drive.google.com', type: 'safe', addedAt: new Date(Date.now() - 200*86400000).toISOString() },
    ],
    attachments: [],
    investment: {
      amount: 10000, costBasis: 10000, vehicle: 'SAFE', date: new Date(Date.now() - 200*86400000).toISOString(),
      ownershipPercent: 0.02,
      impliedValuation: 85000000, impliedValue: 11800, lastValuationDate: new Date(Date.now() - 190*86400000).toISOString(), valuationMethod: 'safe-cap',
      updateFrequency: 'quarterly', metricsToWatch: ['MW contracted', 'Data center pilots', 'Cost per MWh firm'],
      nextUpdateExpected: new Date(Date.now() - 10*86400000).toISOString() // overdue - shows nudge
    },
    healthHistory: [
      { date: new Date(Date.now() - 200*86400000).toISOString(), score: 58, label: 'Steady' },
      { date: new Date(Date.now() - 150*86400000).toISOString(), score: 62, label: 'Steady' },
      { date: new Date(Date.now() - 100*86400000).toISOString(), score: 60, label: 'Steady' },
      { date: new Date(Date.now() - 50*86400000).toISOString(), score: 52, label: 'Investigate' },
      { date: new Date(Date.now() - 20*86400000).toISOString(), score: 46, label: 'Investigate' },
    ],
    monitoring: { healthStatus: 'stable', fundraisingStatus: 'exploring', runwayMonths: 18, followOns: [] },
    milestones: [
      { id: 'm1', type: 'fundraising', title: 'Seed — $20M', description: 'Led by a16z with participation from Sam Altman', date: new Date(Date.now() - 190*86400000).toISOString() },
      { id: 'm2', type: 'partnership', title: 'Meta pilot announced', description: 'First hyperscaler agreement for off-grid AI compute power', date: new Date(Date.now() - 100*86400000).toISOString() },
    ]
  },
  {
    id: '3', companyName: 'Ammobia', logoUrl: 'https://ui-avatars.com/api/?name=AM&background=6366f1&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'Green Ammonia', stage: 'seed',
    website: 'https://ammobia.com',
    source: { type: 'syndicate', name: 'CladoVC' },
    lastAssessedAt: new Date(Date.now() - 10*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 150*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 10*86400000).toISOString(),
    lastUpdateReceived: new Date(Date.now() - 30*86400000).toISOString(),
    createdAt: new Date(Date.now() - 170*86400000).toISOString(),
    overview: 'Electrochemical green ammonia production at the point of use. Eliminates Haber-Bosch entirely — no pipeline, no shipping, fertilizer made on-farm from air, water, and renewable electricity.',
    founders: [
      { name: 'Travis Sherck', role: 'CEO', background: 'Chemical engineering, electrosynthesis R&D' },
    ],
    terms: { instrument: 'SAFE', cap: 20000000, proRata: true, mfn: true },
    documents: [
      { id: 'd1', label: 'SAFE Agreement', url: 'https://drive.google.com', type: 'safe', addedAt: new Date(Date.now() - 150*86400000).toISOString() },
    ],
    attachments: [],
    investment: {
      amount: 10000, costBasis: 10000, vehicle: 'SAFE', date: new Date(Date.now() - 150*86400000).toISOString(),
      ownershipPercent: 0.05,
      impliedValuation: null, impliedValue: null, lastValuationDate: null, valuationMethod: 'mark-at-cost',
      updateFrequency: 'quarterly', metricsToWatch: ['kg NH3 per kWh', 'Pilot farm deployments', 'Cost vs. conventional'],
      nextUpdateExpected: new Date(Date.now() + 45*86400000).toISOString()
    },
    healthHistory: [
      { date: new Date(Date.now() - 150*86400000).toISOString(), score: 55, label: 'Steady' },
      { date: new Date(Date.now() - 100*86400000).toISOString(), score: 60, label: 'Steady' },
      { date: new Date(Date.now() - 45*86400000).toISOString(), score: 63, label: 'Steady' },
      { date: new Date(Date.now() - 20*86400000).toISOString(), score: 65, label: 'Steady' },
    ],
    monitoring: { healthStatus: 'stable', fundraisingStatus: 'not-raising', runwayMonths: 20, followOns: [] },
    milestones: [
      { id: 'm1', type: 'product', title: 'Bench-scale demo', description: 'Achieved target energy efficiency at lab scale — 8.5 MWh/tonne NH3', date: new Date(Date.now() - 120*86400000).toISOString() },
      { id: 'm2', type: 'partnership', title: 'Iowa co-op pilot', description: 'First on-farm deployment with 300-acre corn operation', date: new Date(Date.now() - 45*86400000).toISOString() },
      { id: 'm3', type: 'update', title: 'Founder update', description: 'Pilot running well. Yield 12% above projection. Starting conversations with two more co-ops.', date: new Date(Date.now() - 30*86400000).toISOString() }
    ]
  },
  {
    id: '4', companyName: 'Rondo Energy', logoUrl: 'https://ui-avatars.com/api/?name=RE&background=78716c&color=fff&size=64&bold=true',
    status: 'watching', engagement: 'active', industry: 'Industrial Heat Decarbonization', stage: 'series-b',
    website: 'https://rondoenergy.com',
    source: { type: 'network', name: 'LaFamilia' },
    lastAssessedAt: new Date(Date.now() - 12*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 60*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 12*86400000).toISOString(),
    createdAt: new Date(Date.now() - 65*86400000).toISOString(),
    overview: 'Electric thermal energy storage (ETES) that converts renewable electricity into industrial heat at 1500°C. Targets the 20% of global emissions from industrial processes that cannot be electrified directly.',
    founders: [
      { name: "John O'Donnell", role: 'CEO', background: 'Ex-Alphabet/Google X, energy storage pioneer' },
    ],
    terms: {},
    documents: [],
    attachments: [],
    watchingNotes: 'Strong team and real industrial demand. Watching Series B close — if IRA manufacturing credits get locked in for their heat blocks, the unit economics get dramatically better. Want to see one more customer win before committing.',
    monitoring: { healthStatus: 'stable', fundraisingStatus: 'raising', runwayMonths: null, followOns: [] },
    milestones: [
      { id: 'm1', type: 'fundraising', title: 'Series B — raising $100M', description: 'Microsoft and Rio Tinto as strategic investors. Round not yet closed.', date: new Date(Date.now() - 30*86400000).toISOString() },
      { id: 'm2', type: 'partnership', title: 'Woodside Energy partnership', description: 'First industrial deployment at LNG facility — heat block system replacing gas burners', date: new Date(Date.now() - 50*86400000).toISOString() },
    ]
  }
];

// Components
// CompanyLogo defined below

const StatusBadge = ({ status, size = 'md' }) => {
  const config = STATUS_CONFIG[status];
  const sizes = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-xs' };
  return <span className={`${sizes[size]} rounded-full font-medium ${config.light}`}>{config.label}</span>;
};

const EngagementBadge = ({ active }) => (
  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${active ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-500'}`}>
    {active ? 'Active' : 'Inactive'}
  </span>
);

const Card = ({ children, className = '', onClick }) => (
  <div onClick={onClick} className={`bg-white dark:bg-stone-800 rounded-2xl p-4 shadow-sm dark:shadow-stone-900/20 ${onClick ? 'cursor-pointer hover:shadow-md active:scale-[0.99] transition-all' : ''} ${className}`}>{children}</div>
);

// Reminder Button Component
// Signal Icons for Monitoring
const SettingsPage = ({ settings, onUpdate, onClose }) => {
  const [localSettings, setLocalSettings] = useState(settings);
  const [activeSection, setActiveSection] = useState('profile');

  const updateLocal = (section, field, value) => {
    setLocalSettings(prev => ({
      ...prev,
      [section]: typeof prev[section] === 'object' ? { ...prev[section], [field]: value } : value
    }));
  };

  const handleSave = () => {
    onUpdate(localSettings);
    onClose();
  };

  const sections = [
    { id: 'profile', label: 'Profile', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> },
    { id: 'account', label: 'Account Type', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> },
    { id: 'notifications', label: 'Notifications', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> },
    { id: 'appearance', label: 'Appearance', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg> },
    { id: 'archive', label: 'Archive', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg> },
    { id: 'data', label: 'Data & Privacy', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> },
  ];

  const accountTypes = ['Solo angel', 'Syndicate lead', 'Scout / advisor', 'Micro-fund GP'];
  const timezones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo'];

  // Determine if dark mode should be active
  const isDark = localSettings.appearance === 'dark' || 
    (localSettings.appearance === 'auto' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div 
      className="min-h-screen"
      style={{ 
        backgroundColor: isDark ? '#1c1917' : '#fafaf9',
        color: isDark ? '#fafaf9' : '#1c1917'
      }}
    >
      <header 
        className="sticky top-0 z-30 backdrop-blur-lg px-4 pt-4 pb-3"
        style={{ 
          backgroundColor: isDark ? 'rgba(28, 25, 23, 0.9)' : 'rgba(250, 250, 249, 0.9)',
          borderBottom: isDark ? '1px solid #44403c' : '1px solid #e7e5e4'
        }}
      >
        <div className="flex items-center justify-between">
          <button onClick={onClose} className="flex items-center gap-1" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            <span className="text-sm">Back</span>
          </button>
          <button onClick={handleSave} className="px-3 py-1.5 text-white text-sm font-medium rounded-lg" style={{ backgroundColor: '#5B6DC4' }}>
            Save
          </button>
        </div>
        <h1 className="text-xl font-bold mt-3" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Settings</h1>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <nav 
          className="w-48 p-4 min-h-[calc(100vh-80px)]"
          style={{ borderRight: isDark ? '1px solid #44403c' : '1px solid #e7e5e4' }}
        >
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm mb-1 transition-colors"
              style={{
                backgroundColor: activeSection === s.id ? (isDark ? '#44403c' : '#e7e5e4') : 'transparent',
                color: activeSection === s.id ? (isDark ? '#fafaf9' : '#1c1917') : (isDark ? '#a8a29e' : '#57534e')
              }}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="flex-1 p-6 max-w-xl">
          {activeSection === 'profile' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Profile</h2>
              <div>
                <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Name</label>
                <input 
                  type="text" 
                  value={localSettings.profile?.name || ''} 
                  onChange={e => updateLocal('profile', 'name', e.target.value)}
                  className="w-full mt-1 p-3 rounded-lg text-sm"
                  style={{ 
                    border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                    backgroundColor: isDark ? '#292524' : 'white',
                    color: isDark ? '#fafaf9' : '#1c1917'
                  }}
                  placeholder="Your name"
                />
              </div>
              <div>
                <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Email</label>
                <input 
                  type="email" 
                  value={localSettings.profile?.email || ''} 
                  onChange={e => updateLocal('profile', 'email', e.target.value)}
                  className="w-full mt-1 p-3 rounded-lg text-sm"
                  style={{ 
                    border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                    backgroundColor: isDark ? '#292524' : 'white',
                    color: isDark ? '#fafaf9' : '#1c1917'
                  }}
                  placeholder="you@email.com"
                />
              </div>
              <div className="relative">
                <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Timezone</label>
                <select 
                  value={localSettings.profile?.timezone || 'America/New_York'} 
                  onChange={e => updateLocal('profile', 'timezone', e.target.value)}
                  className="w-full mt-1 p-3 pr-10 rounded-lg text-sm appearance-none cursor-pointer"
                  style={{ 
                    border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                    backgroundColor: isDark ? '#292524' : 'white',
                    color: isDark ? '#fafaf9' : '#1c1917'
                  }}
                >
                  {timezones.map(tz => <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>)}
                </select>
                <svg className="absolute right-3 top-[42px] pointer-events-none" style={{ color: isDark ? '#78716c' : '#a8a29e' }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
            </div>
          )}

          {activeSection === 'account' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Account Type</h2>
              <p className="text-sm mb-4" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>This adjusts default copy and workflow suggestions.</p>
              <div className="space-y-2">
                {accountTypes.map(type => (
                  <label 
                    key={type} 
                    className="flex items-center gap-3 p-3 rounded-lg cursor-pointer"
                    style={{ 
                      border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                      color: isDark ? '#fafaf9' : '#1c1917'
                    }}
                  >
                    <input 
                      type="radio" 
                      name="accountType" 
                      checked={localSettings.accountType === type}
                      onChange={() => setLocalSettings(prev => ({ ...prev, accountType: type }))}
                      className="w-4 h-4"
                    />
                    <span className="text-sm" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>{type}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'notifications' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Notifications</h2>
              <label 
                className="flex items-center justify-between p-3 rounded-lg"
                style={{ border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4' }}
              >
                <div>
                  <span className="text-sm" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Push notifications</span>
                  <p className="text-xs" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>Receive reminders on your device</p>
                </div>
                <button 
                  onClick={() => updateLocal('notifications', 'push', !localSettings.notifications?.push)}
                  className="w-12 h-6 rounded-full transition-colors"
                  style={{ backgroundColor: localSettings.notifications?.push ? '#10b981' : (isDark ? '#57534e' : '#d6d3d1') }}
                >
                  <span 
                    className="block w-5 h-5 bg-white rounded-full shadow transition-transform"
                    style={{ transform: localSettings.notifications?.push ? 'translateX(24px)' : 'translateX(2px)' }}
                  />
                </button>
              </label>
              <div className="relative">
                <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Reminder frequency</label>
                <select 
                  value={localSettings.notifications?.reminderFrequency || 'daily'} 
                  onChange={e => updateLocal('notifications', 'reminderFrequency', e.target.value)}
                  className="w-full mt-1 p-3 pr-10 rounded-lg text-sm appearance-none cursor-pointer"
                  style={{ 
                    border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                    backgroundColor: isDark ? '#292524' : 'white',
                    color: isDark ? '#fafaf9' : '#1c1917'
                  }}
                >
                  <option value="realtime">Real-time</option>
                  <option value="daily">Daily digest</option>
                  <option value="weekly">Weekly digest</option>
                </select>
                <svg className="absolute right-3 top-[42px] pointer-events-none" style={{ color: isDark ? '#78716c' : '#a8a29e' }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Quiet hours start</label>
                  <input 
                    type="time" 
                    value={localSettings.notifications?.quietHoursStart || '22:00'} 
                    onChange={e => updateLocal('notifications', 'quietHoursStart', e.target.value)}
                    className="w-full mt-1 p-3 rounded-lg text-sm"
                    style={{ 
                      border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                      backgroundColor: isDark ? '#292524' : 'white',
                      color: isDark ? '#fafaf9' : '#1c1917'
                    }}
                  />
                </div>
                <div>
                  <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Quiet hours end</label>
                  <input 
                    type="time" 
                    value={localSettings.notifications?.quietHoursEnd || '08:00'} 
                    onChange={e => updateLocal('notifications', 'quietHoursEnd', e.target.value)}
                    className="w-full mt-1 p-3 rounded-lg text-sm"
                    style={{ 
                      border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                      backgroundColor: isDark ? '#292524' : 'white',
                      color: isDark ? '#fafaf9' : '#1c1917'
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {activeSection === 'appearance' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Appearance</h2>
              <div className="grid grid-cols-3 gap-3">
                {['light', 'dark', 'auto'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => setLocalSettings(prev => ({ ...prev, appearance: mode }))}
                    className="p-4 rounded-xl text-center transition-all"
                    style={{
                      border: localSettings.appearance === mode ? '2px solid #5B6DC4' : (isDark ? '1px solid #57534e' : '1px solid #e7e5e4'),
                      backgroundColor: localSettings.appearance === mode ? 'rgba(91, 109, 196, 0.1)' : 'transparent'
                    }}
                  >
                    <div 
                      className="w-10 h-10 mx-auto mb-2 rounded-lg flex items-center justify-center"
                      style={{
                        backgroundColor: mode === 'light' ? '#fef3c7' : mode === 'dark' ? '#e7e5e4' : 'linear-gradient(135deg, #fef3c7, #e0e7ff)',
                        background: mode === 'auto' ? 'linear-gradient(135deg, #fef3c7, #e0e7ff)' : undefined,
                        border: mode === 'light' ? '1px solid #fcd34d' : mode === 'dark' ? '1px solid #a8a29e' : '1px solid #c7d2fe'
                      }}
                    >
                      {mode === 'light' && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>}
                      {mode === 'dark' && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1c1917" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
                      {mode === 'auto' && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/></svg>}
                    </div>
                    <span 
                      className="text-sm font-medium capitalize"
                      style={{ color: localSettings.appearance === mode ? (isDark ? '#fafaf9' : '#1c1917') : (isDark ? '#a8a29e' : '#57534e') }}
                    >
                      {mode === 'auto' ? 'System' : mode}
                    </span>
                  </button>
                ))}
              </div>
              
              <p className="text-sm" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>
                {localSettings.appearance === 'auto' ? 'Theme will match your system preferences.' : `${localSettings.appearance === 'light' ? 'Light' : 'Dark'} mode will be used regardless of system settings.`}
              </p>
              
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => {
                    // Apply theme immediately without closing settings
                    onUpdate({ ...localSettings });
                  }}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors hover:opacity-80"
                  style={{ 
                    border: '2px solid #5B6DC4',
                    color: '#5B6DC4',
                    backgroundColor: 'transparent'
                  }}
                >
                  Apply
                </button>
                <button
                  onClick={() => {
                    onUpdate({ ...localSettings });
                    onClose();
                  }}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors hover:opacity-90"
                  style={{ 
                    backgroundColor: '#5B6DC4',
                    color: 'white'
                  }}
                >
                  Save & Close
                </button>
              </div>
            </div>
          )}

          {activeSection === 'archive' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Passed Deals</h2>
              <p className="text-sm mb-4" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>Deals you've passed on are archived here for reference.</p>
              <div className="text-center py-8" style={{ color: isDark ? '#78716c' : '#a8a29e' }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 opacity-50"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                <p className="text-sm">Passed deals will appear here</p>
              </div>
            </div>
          )}

          {activeSection === 'data' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Data & Privacy</h2>
              <button 
                className="w-full p-3 rounded-lg text-left transition-colors"
                style={{ 
                  border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                  backgroundColor: 'transparent'
                }}
              >
                <span className="text-sm" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Export all data</span>
                <p className="text-xs" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>Download a copy of your deals and settings</p>
              </button>
              <button 
                className="w-full p-3 rounded-lg text-left transition-colors"
                style={{ 
                  border: isDark ? '1px solid #7f1d1d' : '1px solid #fecaca',
                  backgroundColor: 'transparent'
                }}
              >
                <span className="text-sm" style={{ color: isDark ? '#f87171' : '#dc2626' }}>Delete account</span>
                <p className="text-xs" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>Permanently remove all data</p>
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

// Attachments Component
// Founders Section Component - Editable
// Deal Terms Component - Editable
// Milestones Timeline Component
// Add Company Modal - supports all statuses
const AddPortfolioModal = ({ onClose, onAdd }) => {
  const [form, setForm] = useState({
    companyName: '',
    industry: '',
    stage: 'seed',
    companyStatus: 'invested',
    engagement: 'active',
    // Investment fields
    investmentAmount: '',
    costBasis: '',
    investmentDate: '',
    vehicle: 'SAFE',
    // Watching fields
    watchingReasoning: '',
    revisitDate: '',
    // Common fields
    founderName: '',
    founderRole: 'CEO',
    founderEmail: '',
    source: ''
  });

  const statusOptions = [
    { value: 'invested', label: 'Invested', description: 'Capital deployed', color: '#10b981' },
    { value: 'watching', label: 'Watching', description: 'Tracking, not yet invested', color: '#78716c' },
    { value: 'passed',   label: 'Passed',   description: 'Decided not to invest', color: '#a8a29e' },
  ];

  const handleSubmit = () => {
    if (!form.companyName) return;
    if (form.companyStatus === 'invested' && !form.investmentAmount) return;
    
    const now = new Date().toISOString();
    const baseFields = {
      id: Date.now().toString(),
      companyName: form.companyName,
      logoUrl: null,
      status: form.companyStatus,
      engagement: form.engagement,
      industry: form.industry || 'Other',
      stage: form.stage,
      source: { type: 'manual', name: form.source || 'Manual Entry' },
      statusEnteredAt: now,
      lastActivity: now,
      createdAt: now,
      founders: form.founderName ? [{
        name: form.founderName,
        role: form.founderRole,
        email: form.founderEmail || undefined
      }] : [],
      attachments: [],
      screening: { signals: [] }
    };

    let newDeal = { ...baseFields };

    // Add watching/passed fields
    if (form.companyStatus === 'watching' || form.companyStatus === 'passed') {
      newDeal = {
        ...newDeal,
        decisionReasoning: form.watchingReasoning || '',
        revisitDate: form.revisitDate || '',
        watchingNotes: form.watchingReasoning || '',
        decisionLogUpdatedAt: now,
        milestones: [],
      };
    }

    // Add investment fields
    if (form.companyStatus === 'invested') {
      newDeal = {
        ...newDeal,
        terms: { instrument: form.vehicle },
        investment: {
          amount: Number(form.investmentAmount),
          costBasis: Number(form.costBasis) || Number(form.investmentAmount),
          vehicle: form.vehicle,
          date: form.investmentDate || now,
          updateFrequency: 'quarterly',
          metricsToWatch: []
        },
        monitoring: {
          healthStatus: 'stable',
          followOns: []
        },
        milestones: []
      };
    }
    
    onAdd(newDeal);
    onClose();
  };

  const currentStatus = statusOptions.find(s => s.value === form.companyStatus);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-stone-800 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white dark:bg-stone-800 px-4 py-3 border-b border-stone-200 dark:border-stone-700 flex items-center justify-between">
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">Add Company</h2>
          <button onClick={onClose} className="p-1 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        
        <div className="p-4 space-y-4">
          {/* Company Status Selection - Dropdown */}
          <div>
            <label className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide">Status *</label>
            <div className="relative mt-2">
              <select
                value={form.companyStatus}
                onChange={e => setForm({...form, companyStatus: e.target.value})}
                className="w-full p-3 pr-10 border rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#5B6DC4]/20"
                style={{ borderColor: currentStatus?.color || '#e7e5e4' }}
              >
                {statusOptions.map(status => (
                  <option key={status.value} value={status.value}>
                    {status.label} — {status.description}
                  </option>
                ))}
              </select>
              <svg 
                className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-stone-400" 
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2"
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
          </div>

          {/* Active/Inactive Toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-stone-700 dark:text-stone-300">Engagement Status</p>
              <p className="text-xs text-stone-500 dark:text-stone-400">Is this actively being worked on?</p>
            </div>
            <button
              onClick={() => setForm({...form, engagement: form.engagement === 'active' ? 'inactive' : 'active'})}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                form.engagement === 'active' 
                  ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' 
                  : 'bg-stone-200 dark:bg-stone-700 text-stone-500 dark:text-stone-400'
              }`}
            >
              {form.engagement === 'active' ? 'Active' : 'Inactive'}
            </button>
          </div>

          <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
            <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Company Details</p>
            
            <div className="space-y-3">
              <div>
                <label className="text-xs text-stone-500 dark:text-stone-400">Company Name *</label>
                <input 
                  type="text" 
                  value={form.companyName} 
                  onChange={e => setForm({...form, companyName: e.target.value})} 
                  placeholder="Acme Inc" 
                  className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                />
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-stone-500 dark:text-stone-400">Industry</label>
                  <input 
                    type="text" 
                    value={form.industry} 
                    onChange={e => setForm({...form, industry: e.target.value})} 
                    placeholder="SaaS, Fintech..." 
                    className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                  />
                </div>
                <div>
                  <label className="text-xs text-stone-500 dark:text-stone-400">Funding Stage</label>
                  <div className="relative mt-1">
                    <select 
                      value={form.stage} 
                      onChange={e => setForm({...form, stage: e.target.value})} 
                      className="w-full p-3 pr-10 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#5B6DC4]/20"
                    >
                      <option value="pre-seed">Pre-seed</option>
                      <option value="seed">Seed</option>
                      <option value="series-a">Series A</option>
                      <option value="series-b">Series B</option>
                      <option value="growth">Growth</option>
                    </select>
                    <svg 
                      className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-stone-400" 
                      width="16" 
                      height="16" 
                      viewBox="0 0 24 24" 
                      fill="none" 
                      stroke="currentColor" 
                      strokeWidth="2"
                    >
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs text-stone-500 dark:text-stone-400">Source</label>
                <input 
                  type="text" 
                  value={form.source} 
                  onChange={e => setForm({...form, source: e.target.value})} 
                  placeholder="How did you find this company?" 
                  className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                />
              </div>
            </div>
          </div>

          {/* Watching / Passed fields — shown when not investing */}
          {(form.companyStatus === 'watching' || form.companyStatus === 'passed') && (
            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-1">
                {form.companyStatus === 'passed' ? 'Why did you pass?' : 'Why are you watching?'}
              </p>
              <p className="text-xs text-stone-400 mb-2">Required — you'll thank yourself later.</p>
              <textarea
                value={form.watchingReasoning}
                onChange={e => setForm({...form, watchingReasoning: e.target.value})}
                placeholder={form.companyStatus === 'passed'
                  ? "e.g. Strong team but market timing feels early. Would reconsider if a major utility signs an offtake agreement."
                  : "e.g. Compelling technology but waiting for pilot plant data. If efficiency holds at target in field conditions, strong yes."}
                rows={3}
                className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400 resize-none focus:outline-none focus:border-[#5B6DC4]"
              />
              <div className="mt-3">
                <label className="text-xs text-stone-500 dark:text-stone-400">Revisit by (optional)</label>
                <input
                  type="date"
                  value={form.revisitDate}
                  onChange={e => setForm({...form, revisitDate: e.target.value})}
                  className="mt-1 p-2.5 border border-stone-200 dark:border-stone-700 rounded-lg text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 focus:outline-none focus:border-[#5B6DC4]"
                />
              </div>
            </div>
          )}

          {/* Conditional Investment Fields */}
          {form.companyStatus === 'invested' && (
            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Investment Details</p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-stone-500 dark:text-stone-400">Amount ($) *</label>
                    <input 
                      type="number" 
                      value={form.investmentAmount} 
                      onChange={e => setForm({...form, investmentAmount: e.target.value})} 
                      placeholder="25000" 
                      className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                    />
                  </div>
                  <div className="relative">
                    <label className="text-xs text-stone-500 dark:text-stone-400">Vehicle</label>
                    <select 
                      value={form.vehicle} 
                      onChange={e => setForm({...form, vehicle: e.target.value})} 
                      className="w-full mt-1 p-3 pr-10 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer"
                    >
                      <option value="SAFE">SAFE</option>
                      <option value="Convertible Note">Convertible Note</option>
                      <option value="Equity">Priced Equity</option>
                    </select>
                    <svg className="absolute right-3 top-[34px] pointer-events-none text-stone-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-stone-500 dark:text-stone-400">
                    Cost basis ($) <span className="font-normal text-stone-400 dark:text-stone-500">optional</span>
                  </label>
                  <input
                    type="number"
                    value={form.costBasis}
                    onChange={e => setForm({...form, costBasis: e.target.value})}
                    placeholder="Same as amount"
                    className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400"
                  />
                  <p className="text-xs text-stone-400 dark:text-stone-500 mt-1">Leave blank if same as amount. Use if secondary purchase or adjusted entry.</p>
                </div>
                <div>
                  <label className="text-xs text-stone-500 dark:text-stone-400">Investment Date</label>
                  <input 
                    type="date" 
                    value={form.investmentDate} 
                    onChange={e => setForm({...form, investmentDate: e.target.value})} 
                    className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900" 
                  />
                </div>
              </div>
            </div>
          )}

          {/* Founder Section */}
          <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
            <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Founder (optional)</p>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <input 
                  type="text" 
                  value={form.founderName} 
                  onChange={e => setForm({...form, founderName: e.target.value})} 
                  placeholder="Name" 
                  className="p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                />
                <input 
                  type="text" 
                  value={form.founderRole} 
                  onChange={e => setForm({...form, founderRole: e.target.value})} 
                  placeholder="Role" 
                  className="p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                />
              </div>
              <input 
                type="email" 
                value={form.founderEmail} 
                onChange={e => setForm({...form, founderEmail: e.target.value})} 
                placeholder="Email" 
                className="w-full p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
              />
            </div>
          </div>
        </div>
        
        <div className="sticky bottom-0 bg-white dark:bg-stone-800 px-4 py-3 border-t border-stone-200 dark:border-stone-700">
          <button 
            onClick={handleSubmit} 
            disabled={!form.companyName || (form.companyStatus === 'invested' && !form.investmentAmount) || (['watching','passed'].includes(form.companyStatus) && !form.watchingReasoning.trim())} 
            style={{ backgroundColor: currentStatus?.color || '#5B6DC4' }}
            className="w-full py-3 text-white rounded-xl text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:opacity-90"
          >
            Add {currentStatus?.label || 'Company'}
          </button>
        </div>
      </div>
    </div>
  );
};

const Toast = ({ message, type = 'success', onClose }) => {
  useEffect(() => { const t = setTimeout(onClose, 2500); return () => clearTimeout(t); }, [onClose]);
  
  return (
    <div 
      className="fixed bottom-20 left-1/2 transform -translate-x-1/2 z-[200] px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 shadow-md"
      style={{ 
        backgroundColor: type === 'error' ? '#FEE2E2' : '#EEF2FF',
        color: type === 'error' ? '#DC2626' : '#5B6DC4',
        border: type === 'error' ? '1px solid #FECACA' : '1px solid #C7D2FE'
      }}
    >
      {type === 'success' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
      {type === 'error' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
      )}
      {message}
    </div>
  );
};

const ActionButton = ({ children, variant = 'secondary', onClick, disabled, className = '' }) => {
  const variants = {
    primary: 'bg-[#5B6DC4] text-white hover:bg-[#4F5FB3]',
    secondary: 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-700 dark:text-stone-300 dark:hover:bg-stone-600',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    warning: 'bg-amber-100 text-amber-800 hover:bg-amber-200',
    ghost: 'bg-transparent text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800',
  };
  return <button onClick={onClick} disabled={disabled} className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}>{children}</button>;
};

const ProgressBar = ({ value, max, label }) => {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-stone-500">{label}</span>
        <span className="font-medium text-stone-700">{value}/{max}</span>
      </div>
      <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${percent >= 70 ? 'bg-emerald-500' : percent >= 40 ? 'bg-amber-500' : 'bg-stone-300'}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
};

const TimeStamp = ({ label, date, warning }) => (
  <div className="flex justify-between items-center py-2 border-b border-stone-100 dark:border-stone-700 last:border-0">
    <span className="text-sm text-stone-500 dark:text-stone-400">{label}</span>
    <span className={`text-sm font-medium ${warning ? 'text-red-600 dark:text-red-400' : 'text-stone-900 dark:text-stone-100'}`}>{date ? `${daysAgo(date)}d ago` : '—'}</span>
  </div>
);

// Document Links Section
// Invested View - Clean confirmation design
const WatchingView = ({ deal, onUpdate, setToast }) => {
  const [showDecisionLog, setShowDecisionLog] = useState(true);
  const [editingDecision, setEditingDecision] = useState(false);
  const [decisionForm, setDecisionForm] = useState({
    reasoning: deal.decisionReasoning || '',
    revisitDate: deal.revisitDate || '',
    triggers: deal.investmentTriggers || ['', '', ''],
    currentStatus: deal.watchingNotes || '',
  });

  const agentCache = getAgentCache();
  const signals = agentCache[deal.id]?.signals || [];
  const agentSummary = agentCache[deal.id]?.summary || null;
  const agentFetchedAt = agentCache[deal.id]?.fetchedAt || null;

  const saveDecision = () => {
    const updated = {
      ...deal,
      decisionReasoning: decisionForm.reasoning,
      revisitDate: decisionForm.revisitDate,
      investmentTriggers: decisionForm.triggers.filter(t => t.trim()),
      watchingNotes: decisionForm.currentStatus,
      decisionLogUpdatedAt: new Date().toISOString(),
    };
    onUpdate(updated);
    setEditingDecision(false);
    if (setToast) setToast({ message: 'Decision log saved', type: 'success' });
  };

  const daysUntilRevisit = deal.revisitDate ? Math.ceil((new Date(deal.revisitDate) - Date.now()) / 86400000) : null;
  const revisitOverdue = daysUntilRevisit !== null && daysUntilRevisit < 0;

  return (
    <div className="space-y-4">
      {/* Company header */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center text-xl font-bold bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400 flex-shrink-0">
              {deal.companyName?.charAt(0)?.toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-xl font-bold text-stone-900 dark:text-white">{deal.companyName}</h2>
                {deal.website && (
                  <a href={deal.website} target="_blank" rel="noopener noreferrer" className="text-stone-400 hover:text-stone-600">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}
              </div>
              <p className="text-sm text-stone-500 dark:text-stone-400">{deal.stage} · {deal.industry}</p>
              {deal.founders?.[0] && <p className="text-xs text-stone-400 mt-0.5">{deal.founders[0].name} · {deal.founders[0].role}</p>}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className="text-xs px-2 py-1 rounded-full bg-stone-100 dark:bg-stone-700 text-stone-500 font-medium">
              {deal.status === 'passed' ? 'Passed' : 'Watching'}
            </span>
            {deal.monitoring?.fundraisingStatus === 'raising' && (
              <span className="text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-600 font-medium dark:bg-blue-900/30 dark:text-blue-400">Raising now</span>
            )}
          </div>
        </div>
        {deal.overview && <p className="mt-4 text-sm text-stone-600 dark:text-stone-300 leading-relaxed">{deal.overview}</p>}
      </div>

      {/* Revisit banner if overdue */}
      {revisitOverdue && (
        <div className="rounded-xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: '#fef3c7', border: '1px solid #fde68a' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p className="text-sm text-amber-800 font-medium">
            Revisit date was {Math.abs(daysUntilRevisit)}d ago — time to update your view on {deal.companyName}.
          </p>
        </div>
      )}
      {daysUntilRevisit !== null && !revisitOverdue && daysUntilRevisit <= 14 && (
        <div className="rounded-xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p className="text-sm text-emerald-800">Revisit scheduled in {daysUntilRevisit} day{daysUntilRevisit !== 1 ? 's' : ''}</p>
        </div>
      )}

      {/* Decision log — the core of the watching view */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl overflow-hidden">
        <button
          onClick={() => setShowDecisionLog(!showDecisionLog)}
          className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50 dark:hover:bg-stone-700/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            <span className="text-sm font-semibold text-stone-700 dark:text-stone-300">Decision log</span>
            {deal.decisionLogUpdatedAt && (
              <span className="text-xs text-stone-400">· updated {formatRelativeTime(deal.decisionLogUpdatedAt)}</span>
            )}
            {!deal.decisionReasoning && !deal.investmentTriggers?.length && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Empty — add your reasoning</span>
            )}
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="2" className={`transition-transform ${showDecisionLog ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
        </button>

        {showDecisionLog && (
          <div className="px-5 pb-5 border-t border-stone-100 dark:border-stone-700">
            {editingDecision ? (
              <div className="pt-4 space-y-4">
                <div>
                  <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide">
                    Why are you watching / why did you pass?
                  </label>
                  <p className="text-xs text-stone-400 mt-0.5 mb-2">Be specific. You'll read this in 18 months.</p>
                  <textarea
                    value={decisionForm.reasoning}
                    onChange={e => setDecisionForm(f => ({ ...f, reasoning: e.target.value }))}
                    placeholder={deal.status === 'passed'
                      ? "e.g. Team is strong but the market timing feels early — industrial customers aren't ready to pay for this yet. Would reconsider if a major utility signs an offtake."
                      : "e.g. Compelling technology but waiting for the pilot plant data before committing. If efficiency holds at 8+ MWh/tonne in field conditions, this is a strong yes."}
                    rows={4}
                    className="w-full p-3 text-sm border border-stone-200 dark:border-stone-600 rounded-xl bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:border-[#5B6DC4] resize-none"
                    autoFocus
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide">
                    What would change your mind?
                  </label>
                  <p className="text-xs text-stone-400 mt-0.5 mb-2">Specific triggers that would move this to invested (or permanently pass).</p>
                  <div className="space-y-2">
                    {decisionForm.triggers.map((t, i) => (
                      <input
                        key={i}
                        type="text"
                        value={t}
                        onChange={e => {
                          const updated = [...decisionForm.triggers];
                          updated[i] = e.target.value;
                          setDecisionForm(f => ({ ...f, triggers: updated }));
                        }}
                        placeholder={[
                          'e.g. Pilot plant achieves target efficiency',
                          'e.g. Tier-1 climate fund leads Series A',
                          'e.g. First paying customer signs',
                        ][i] || 'Add another trigger...'}
                        className="w-full p-2.5 text-sm border border-stone-200 dark:border-stone-600 rounded-lg bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:border-[#5B6DC4]"
                      />
                    ))}
                    {decisionForm.triggers.length < 5 && (
                      <button
                        onClick={() => setDecisionForm(f => ({ ...f, triggers: [...f.triggers, ''] }))}
                        className="text-xs text-[#5B6DC4] hover:underline"
                      >+ Add trigger</button>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide">Revisit date</label>
                  <p className="text-xs text-stone-400 mt-0.5 mb-2">When should you re-evaluate this decision?</p>
                  <input
                    type="date"
                    value={decisionForm.revisitDate}
                    onChange={e => setDecisionForm(f => ({ ...f, revisitDate: e.target.value }))}
                    className="p-2.5 text-sm border border-stone-200 dark:border-stone-600 rounded-lg bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 focus:outline-none focus:border-[#5B6DC4]"
                  />
                </div>

                <div className="flex gap-2 pt-1">
                  <button onClick={saveDecision} className="flex-1 py-2.5 text-sm font-semibold text-white rounded-xl" style={{ backgroundColor: '#5B6DC4' }}>Save decision log</button>
                  <button onClick={() => setEditingDecision(false)} className="px-4 py-2.5 text-sm text-stone-500 hover:text-stone-700 transition-colors">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="pt-4 space-y-4">
                {deal.decisionReasoning ? (
                  <div>
                    <p className="text-xs text-stone-400 uppercase tracking-wide font-semibold mb-2">Your reasoning</p>
                    <p className="text-sm text-stone-700 dark:text-stone-300 leading-relaxed">{deal.decisionReasoning}</p>
                  </div>
                ) : (
                  <p className="text-sm text-stone-400 italic">No reasoning logged yet. Add it while it's fresh.</p>
                )}

                {deal.investmentTriggers?.filter(t => t).length > 0 && (
                  <div>
                    <p className="text-xs text-stone-400 uppercase tracking-wide font-semibold mb-2">What would change your mind</p>
                    <div className="space-y-1.5">
                      {deal.investmentTriggers.filter(t => t).map((trigger, i) => {
                        // Check if any agent signal might relate to this trigger
                        const triggerLower = trigger.toLowerCase();
                        const matched = signals.some(s =>
                          s.sentiment === 'positive' &&
                          (triggerLower.split(' ').filter(w => w.length > 4).some(w => (s.title + s.description).toLowerCase().includes(w)))
                        );
                        return (
                          <div key={i} className={`flex items-start gap-2 px-3 py-2 rounded-lg ${matched ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-stone-50 dark:bg-stone-700/50'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${matched ? 'bg-emerald-500' : 'bg-stone-300'}`}/>
                            <span className={`text-sm ${matched ? 'text-emerald-800 dark:text-emerald-300 font-medium' : 'text-stone-600 dark:text-stone-400'}`}>{trigger}</span>
                            {matched && <span className="ml-auto text-xs text-emerald-600 font-semibold flex-shrink-0">Signal detected ↑</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {deal.revisitDate && (
                  <div className="flex items-center gap-2 text-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#78716c" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    <span className="text-stone-500">Revisit by {new Date(deal.revisitDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                    {daysUntilRevisit !== null && (
                      <span className={`text-xs font-medium ${revisitOverdue ? 'text-red-500' : 'text-stone-400'}`}>
                        ({revisitOverdue ? `${Math.abs(daysUntilRevisit)}d overdue` : `in ${daysUntilRevisit}d`})
                      </span>
                    )}
                  </div>
                )}

                <button
                  onClick={() => {
                    setDecisionForm({
                      reasoning: deal.decisionReasoning || '',
                      revisitDate: deal.revisitDate || '',
                      triggers: deal.investmentTriggers?.length ? [...deal.investmentTriggers, '', ''].slice(0, 3) : ['', '', ''],
                      currentStatus: deal.watchingNotes || '',
                    });
                    setEditingDecision(true);
                  }}
                  className="text-sm text-[#5B6DC4] hover:text-[#4a5ba8] transition-colors"
                >
                  {deal.decisionReasoning ? 'Edit decision log' : '+ Add your reasoning'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>


      {/* Conviction tracker — manual history, builds calibration dataset */}
      {(() => {
        const convictionLog = deal.convictionLog || [];
        const current = convictionLog[convictionLog.length - 1];
        const LEVELS = [
          { value: 'low',    label: 'Low',    color: '#78716c', bg: 'bg-stone-100 dark:bg-stone-700' },
          { value: 'medium', label: 'Medium', color: '#5B6DC4', bg: 'bg-indigo-50 dark:bg-indigo-900/20' },
          { value: 'high',   label: 'High',   color: '#10b981', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
        ];
        const updateConviction = (level) => {
          const entry = { date: new Date().toISOString(), level };
          const updated = {
            ...deal,
            convictionLog: [...convictionLog, entry].slice(-12),
          };
          onUpdate(updated);
        };
        return (
          <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300">Conviction</h3>
              </div>
              {current && (
                <span className="text-xs text-stone-400">updated {formatRelativeTime(current.date)}</span>
              )}
            </div>
            <div className="flex items-center gap-2 mb-3">
              {LEVELS.map(lv => (
                <button
                  key={lv.value}
                  onClick={() => updateConviction(lv.value)}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all border-2 ${
                    current?.level === lv.value
                      ? 'border-current text-white'
                      : 'border-transparent bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400 hover:opacity-80'
                  }`}
                  style={current?.level === lv.value ? { backgroundColor: lv.color, borderColor: lv.color, color: 'white' } : {}}
                >
                  {lv.label}
                </button>
              ))}
            </div>
            {convictionLog.length >= 2 && (() => {
              // Mini conviction sparkline
              const W2 = 200; const H2 = 28; const PAD2 = 3;
              const levelToNum = { low: 1, medium: 2, high: 3 };
              const pts2 = convictionLog.map((e, i) => {
                const x = PAD2 + (i / (convictionLog.length - 1)) * (W2 - PAD2 * 2);
                const y = PAD2 + ((3 - levelToNum[e.level]) / 2) * (H2 - PAD2 * 2);
                return [x, y, e.level];
              });
              const poly2 = pts2.map(([x, y]) => `${x},${y}`).join(' ');
              const currentColor = LEVELS.find(l => l.value === current?.level)?.color || '#78716c';
              const first = convictionLog[0];
              const last = convictionLog[convictionLog.length - 1];
              const changed = first.level !== last.level;
              return (
                <div>
                  <svg width="100%" viewBox={`0 0 ${W2} ${H2}`} style={{ maxHeight: '28px' }}>
                    {['low','medium','high'].map((lv, i) => {
                      const ly = PAD2 + ((2 - i) / 2) * (H2 - PAD2 * 2);
                      return <line key={lv} x1={PAD2} y1={ly} x2={W2-PAD2} y2={ly} stroke="#f5f5f4" strokeWidth="1"/>;
                    })}
                    <polyline points={poly2} fill="none" stroke={currentColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
                    <circle cx={pts2[pts2.length-1][0]} cy={pts2[pts2.length-1][1]} r="2.5" fill={currentColor}/>
                  </svg>
                  <p className="text-xs text-stone-400 mt-1">
                    {convictionLog.length} update{convictionLog.length > 1 ? 's' : ''}
                    {changed ? ` · ${first.level} → ${last.level}` : ' · unchanged'}
                    {' · '}{new Date(first.date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })} – now
                  </p>
                </div>
              );
            })()}
            {convictionLog.length < 2 && (
              <p className="text-xs text-stone-400">Set your conviction level above each time you revisit — this builds a record of how your view changes over time.</p>
            )}
          </div>
        );
      })()}

      {/* External signals from agent */}
      {(signals.length > 0 || agentSummary) && (
        <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300">Latest signals</h3>
            </div>
            {agentFetchedAt && <span className="text-xs text-stone-400">{formatRelativeTime(agentFetchedAt)}</span>}
          </div>
          {agentSummary && <p className="text-sm text-stone-600 dark:text-stone-400 mb-3 leading-relaxed">{agentSummary}</p>}
          <div className="space-y-2">
            {signals.slice(0, 4).map((s, i) => (
              <div key={i} className={`flex items-start gap-2.5 p-2.5 rounded-lg ${s.sentiment === 'positive' ? 'bg-emerald-50 dark:bg-emerald-900/20' : s.sentiment === 'negative' ? 'bg-red-50 dark:bg-red-900/20' : 'bg-stone-50 dark:bg-stone-700/50'}`}>
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${s.sentiment === 'positive' ? 'bg-emerald-500' : s.sentiment === 'negative' ? 'bg-red-500' : 'bg-stone-400'}`}/>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-stone-800 dark:text-stone-200">{s.title}</p>
                  <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">{s.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};


// ── HEALTH TREND SPARKLINE ─────────────────────────────────────────────────
// Pure SVG — no charting library needed. Shows health score over time.
const HealthTrendChart = ({ healthHistory = [], currentScore, currentLabel, color }) => {
  if (healthHistory.length < 2) {
    return (
      <div className="flex items-center gap-2 py-2">
        <svg width="80" height="24" className="opacity-30">
          <line x1="0" y1="12" x2="80" y2="12" stroke={color} strokeWidth="1.5" strokeDasharray="3,3"/>
        </svg>
        <span className="text-xs text-stone-400">Not enough history yet — add updates to build trend</span>
      </div>
    );
  }

  const all = [...healthHistory, { score: currentScore, date: new Date().toISOString() }];
  const W = 220; const H = 52; const PAD_X = 4; const PAD_Y = 6; const LABEL_H = 14;
  const chartH = H - LABEL_H;
  const minS = Math.max(0, Math.min(...all.map(p => p.score)) - 8);
  const maxS = Math.min(100, Math.max(...all.map(p => p.score)) + 8);
  const range = maxS - minS || 1;

  const pts = all.map((p, i) => {
    const x = PAD_X + (i / (all.length - 1)) * (W - PAD_X * 2);
    const y = PAD_Y + ((maxS - p.score) / range) * (chartH - PAD_Y * 2);
    return [x, y, p.score, p.date];
  });

  const polyline = pts.map(([x, y]) => `${x},${y}`).join(' ');
  const areaPath = `M${pts[0][0]},${chartH} ` + pts.map(([x, y]) => `L${x},${y}`).join(' ') + ` L${pts[pts.length-1][0]},${chartH} Z`;

  const delta = all[all.length - 1].score - all[0].score;
  const trend = delta > 3 ? '↑' : delta < -3 ? '↓' : '→';
  const trendColor = delta > 3 ? '#10b981' : delta < -3 ? '#ef4444' : '#78716c';

  const fmtShort = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  const spanDays = Math.round((new Date(all[all.length-1].date) - new Date(all[0].date)) / 86400000);
  const spanLabel = spanDays < 30 ? `${spanDays}d` : spanDays < 365 ? `${Math.round(spanDays/30)}mo` : `${(spanDays/365).toFixed(1)}yr`;

  return (
    <div className="w-full" style={{ maxWidth: '400px' }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
        <defs>
          <linearGradient id={`grad-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.2"/>
            <stop offset="100%" stopColor={color} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {/* Threshold lines at 62 (Investigate) and 80 (On Track) */}
        {[{ v: 62, label: 'Investigate' }, { v: 80, label: 'On Track' }].map(({ v, label }) => {
          const ty = PAD_Y + ((maxS - v) / range) * (chartH - PAD_Y * 2);
          return ty > 0 && ty < chartH ? (
            <g key={v}>
              <line x1={PAD_X} y1={ty} x2={W - PAD_X} y2={ty} stroke="#d6d3d1" strokeWidth="1" strokeDasharray="3,3"/>
              <text x={W - PAD_X - 2} y={ty - 2} fontSize="7" fill="#a8a29e" textAnchor="end">{label}</text>
            </g>
          ) : null;
        })}
        <path d={areaPath} fill={`url(#grad-${color.replace('#','')})`}/>
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
        {/* First and last dots with dates */}
        <circle cx={pts[0][0]} cy={pts[0][1]} r="2.5" fill={color} opacity="0.5"/>
        <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="3" fill={color}/>
        {/* X-axis date labels */}
        <text x={PAD_X} y={H - 1} fontSize="8" fill="#a8a29e">{fmtShort(all[0].date)}</text>
        <text x={W - PAD_X} y={H - 1} fontSize="8" fill="#a8a29e" textAnchor="end">Now</text>
      </svg>
      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold" style={{ color }}>{currentLabel}</span>
          <span className="text-sm font-bold" style={{ color: trendColor }}>{trend}</span>
          <span className="text-xs text-stone-400 ml-1">{Math.abs(delta) > 0 ? `${delta > 0 ? '+' : ''}${Math.round(delta)} pts` : 'stable'}</span>
        </div>
        <span className="text-[10px] text-stone-400">{spanLabel} of history · {all.length - 1} snapshot{all.length > 2 ? 's' : ''}</span>
      </div>
    </div>
  );
};


const InvestedView = ({ deal, onUpdate, setToast }) => {
  const inv = deal.investment || {};
  const [showUpdateLog, setShowUpdateLog] = useState(false);
  const [showAddUpdate, setShowAddUpdate] = useState(false);
  const [newUpdateNote, setNewUpdateNote] = useState('');

  // Update log nudge logic
  const lastUpdate = inv.lastUpdateReceived || deal.lastUpdateReceived;
  const nextExpected = inv.nextUpdateExpected || deal.nextUpdateExpected;
  const daysSinceUpdate = lastUpdate ? Math.floor((Date.now() - new Date(lastUpdate).getTime()) / 86400000) : null;
  const daysUntilNext = nextExpected ? Math.floor((new Date(nextExpected).getTime() - Date.now()) / 86400000) : null;
  const updateOverdue = daysUntilNext !== null && daysUntilNext < -7;
  const updateDueSoon = daysUntilNext !== null && daysUntilNext >= -7 && daysUntilNext <= 14;

  // Update log entries from milestones typed as 'update'
  const updateEntries = (deal.milestones || [])
    .filter(m => m.type === 'update' || m.type === 'investor-update')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const handleAddUpdate = () => {
    if (!newUpdateNote.trim()) return;
    const now = new Date().toISOString();
    // Parse the note for health signals immediately — gives instant health feedback
    const parsedSignals = parseUpdateForSignals(newUpdateNote.trim(), now);
    const hasNegative = parsedSignals.some(s => s.sentiment === 'negative');
    const hasPositive = parsedSignals.some(s => s.sentiment === 'positive');
    // Snapshot current health score for trend tracking
    const currentHealth = calcDealHealth(deal, getAgentCache()[deal.id]?.signals || []);
    const healthSnapshot = { date: now, score: currentHealth.score, label: currentHealth.label };
    const updated = {
      ...deal,
      milestones: [...(deal.milestones || []), {
        id: `u-${Date.now()}`,
        type: 'update',
        title: (() => {
          const t = newUpdateNote.trim().toLowerCase();
          if (/email|update from|founder said|called|spoke with|meeting/.test(t)) return 'Founder update';
          if (/raised|funding|closed round|new round/.test(t)) return 'Funding event';
          if (/customer|signed|offtake|loi|contract/.test(t)) return 'Customer signal';
          if (/hired|new cto|new cfo|joined/.test(t)) return 'Team update';
          return 'Investor note';
        })(),
        description: newUpdateNote.trim(),
        date: now,
        parsedSignalCount: parsedSignals.length,
      }],
      lastUpdateReceived: now,
      // Append health snapshot to trend history
      healthHistory: [...(deal.healthHistory || []), healthSnapshot].slice(-24), // keep last 24 snapshots
    };
    onUpdate(updated);
    setNewUpdateNote('');
    setShowAddUpdate(false);
    setShowUpdateLog(true); // auto-open so user sees what was just logged
    const msg = parsedSignals.length > 0
      ? `Update logged · ${parsedSignals.length} signal${parsedSignals.length > 1 ? 's' : ''} extracted${hasNegative ? ' — health flags updated' : ''}`
      : 'Update logged';
    if (setToast) setToast({ message: msg, type: hasNegative ? 'warning' : 'success' });
  };

  return (
    <div className="space-y-4">
      {/* Company Header */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#10b981' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-xl font-bold text-stone-900 dark:text-white">{deal.companyName}</h2>
              {deal.website && (
                <a href={deal.website} target="_blank" rel="noopener noreferrer" className="text-stone-400 hover:text-stone-600">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                </a>
              )}
            </div>
            <p className="text-sm text-stone-500 dark:text-stone-400">{deal.stage} · {deal.industry}</p>
          </div>
        </div>

        {deal.overview && (
          <p className="mt-4 text-stone-600 dark:text-stone-300 text-sm leading-relaxed">{deal.overview}</p>
        )}

        {deal.founders && deal.founders.length > 0 && (
          <div className="flex items-center gap-2 mt-4 pt-4 border-t border-stone-100 dark:border-stone-700">
            <span className="text-sm text-stone-500">Founders:</span>
            <div className="flex items-center gap-3">
              {deal.founders.map((founder, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <div className="w-6 h-6 rounded-full bg-stone-200 dark:bg-stone-700 flex items-center justify-center text-xs font-medium text-stone-600 dark:text-stone-300">
                    {founder.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-sm text-stone-700 dark:text-stone-300">{founder.name}</span>
                  <span className="text-xs text-stone-400">({founder.role})</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Investment Summary + Valuation + Health */}
      {(() => {
        const method = getValuationMethod(deal);
        const implied = calcImpliedValue(deal);
        const moic = calcMOIC(deal);
        // Read agent cache and merge with update log signals inside calcDealHealth
        const agentCache = getAgentCache();
        const health = calcDealHealth(deal, agentCache[deal.id]?.signals || []);
        const staleness = getMarkStaleness(deal);
        const stalenessColors = { fresh: '#10b981', ok: '#5B6DC4', stale: '#f59e0b', 'very-stale': '#ef4444', unknown: '#78716c' };
        return (
          <>
            {/* Deal terms row */}
            <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="18"/>
                    <path d="M15 9.5c0-1.5-1.5-2.5-3-2.5s-3 .5-3 2.5c0 1.5 1.5 2 3 2.5s3 1 3 2.5c0 1.5-1.5 2.5-3 2.5s-3-1-3-2.5"/>
                  </svg>
                  <h3 className="font-medium text-stone-900 dark:text-white">Investment</h3>
                </div>
                {/* Health badge */}
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold" style={{ backgroundColor: health.color + '18', color: health.color }} title={`Health score: ${health.score}/100`}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: health.color }}/>
                  {health.label}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {inv.amount && (
                  <div>
                    <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Amount in</p>
                    <p className="text-lg font-semibold text-stone-900 dark:text-stone-100">{formatCurrency(inv.amount)}</p>
                  </div>
                )}
                {hasSeparateCostBasis(inv) && (
                  <div>
                    <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Cost basis</p>
                    <p className="text-lg font-semibold text-stone-900 dark:text-stone-100">{formatCurrency(getEffectiveCostBasis(inv))}</p>
                  </div>
                )}
                {inv.vehicle && (
                  <div>
                    <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Vehicle</p>
                    <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{inv.vehicle}</p>
                  </div>
                )}
                {inv.ownershipPercent && (
                  <div>
                    <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Ownership</p>
                    <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{inv.ownershipPercent}%</p>
                  </div>
                )}
                {inv.date && (
                  <div>
                    <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Date</p>
                    <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{new Date(inv.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</p>
                  </div>
                )}
              </div>

            </div>

            {/* Health trend */}
            <div className="bg-white dark:bg-stone-800 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                  <span className="text-sm font-medium text-stone-700 dark:text-stone-300">Health trend</span>
                </div>
                <span className="text-xs text-stone-400">since investment</span>
              </div>
              <HealthTrendChart
                healthHistory={deal.healthHistory || []}
                currentScore={health.score}
                currentLabel={health.label}
                color={health.color}
              />
            </div>

            {/* Valuation card */}
            <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                  <h3 className="font-medium text-stone-900 dark:text-white">Valuation</h3>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400">{getValuationLabel(method)}</span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Cost basis</p>
                  <p className="text-lg font-bold text-stone-900 dark:text-white">{formatCurrency(getEffectiveCostBasis(inv))}</p>
                </div>
                <div>
                  <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Implied value</p>
                  {method === 'mark-at-cost' ? (
                    <p className="text-lg font-bold text-stone-400 dark:text-stone-500">—</p>
                  ) : (
                    <p className="text-lg font-bold" style={{ color: implied >= getEffectiveCostBasis(inv) ? '#10b981' : '#ef4444' }}>{formatCurrency(implied)}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">MOIC</p>
                  {method === 'mark-at-cost' ? (
                    <p className="text-lg font-bold text-stone-400 dark:text-stone-500">1.0x</p>
                  ) : moic !== null ? (
                    <p className="text-lg font-bold" style={{ color: moic >= 1.5 ? '#10b981' : moic >= 1.0 ? '#5B6DC4' : '#ef4444' }}>{moic.toFixed(2)}x</p>
                  ) : (
                    <p className="text-lg font-bold text-stone-400">—</p>
                  )}
                </div>
              </div>
              {method === 'mark-at-cost' && (
                <div className="mt-3 pt-3 border-t border-stone-100 dark:border-stone-700">
                  <p className="text-xs text-stone-400 dark:text-stone-500 italic mb-2">
                    {health.maturity === 'lab' ? 'Lab/bench stage — marked at cost. MOIC is not meaningful pre-demonstration.' : 'Pilot stage — marked at cost until next priced round or valuation event.'}
                  </p>
                  {/* SAFE conversion context — only shown for unconverted SAFEs with a cap */}
                  {inv.vehicle === 'SAFE' && deal.terms?.cap && (() => {
                      const cap = deal.terms.cap;
                      const invested = getEffectiveCostBasis(inv);
                      const pct = cap > 0 ? ((invested / (cap + invested)) * 100) : null;
                      const extras = [deal.terms?.discount ? `${deal.terms.discount}% discount` : null, deal.terms?.mfn ? 'MFN' : null].filter(Boolean);
                      return (
                        <div className="bg-stone-50 dark:bg-stone-700/50 rounded-xl px-4 py-3">
                          <p className="text-sm text-stone-700 dark:text-stone-300">
                            At your <span className="font-semibold">{formatCurrency(cap)}</span> cap, you'd own approximately{' '}
                            <span className="font-semibold text-[#5B6DC4]">~{pct?.toFixed(2)}%</span> on conversion
                            {extras.length > 0 && <span className="text-stone-500"> · {extras.join(', ')}</span>}.
                          </p>
                          <p className="text-xs text-stone-400 mt-1.5">Pre-dilution from option pool. Exact % confirmed at next priced round.</p>
                        </div>
                      );
                  })()}
                </div>
              )}
              {method !== 'mark-at-cost' && inv.lastValuationDate && (
                <div className="mt-3 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: stalenessColors[staleness] }}/>
                  <p className="text-xs" style={{ color: stalenessColors[staleness] }}>
                    Mark from {new Date(inv.lastValuationDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                    {staleness === 'stale' ? ' — consider refreshing' : staleness === 'very-stale' ? ' — mark is outdated' : ''}
                  </p>
                </div>
              )}
            </div>

            {/* Health breakdown — transparent, plain-language explanation */}
            {(() => {
              const topNegative = health.factors.find(f => f.type === 'negative');
              const topWarning = health.factors.find(f => f.type === 'warning');
              const topPositive = health.factors.find(f => f.type === 'positive');
              const leadFactor = topNegative || topWarning || topPositive;
              const trlLabel = {'lab': 'Lab · TRL 1–3', 'pilot': 'Pilot · TRL 4–6', 'scale': 'Commercial · TRL 7–8', 'deploy': 'Deploy · TRL 9', 'fund': 'LP Fund'}[health.maturity] || health.maturity;

              // Plain-language summary of what this means for the investor
              const actionSentence = health.label === 'Investigate'
                ? `Something specific needs your attention — ${health.checkInReason || 'review the signals below'}.`
                : health.label === 'Critical'
                ? `Multiple compounding issues detected. This warrants a direct conversation with the founder soon.`
                : health.label === 'On Track'
                ? `Signals are positive. No action needed — just stay informed.`
                : `No urgent issues. Keep monitoring on schedule.`;

              return (
                <div className={`rounded-2xl overflow-hidden ${health.bg}`}>
                  {/* Header with plain-language verdict */}
                  <div className="px-5 pt-5 pb-3">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={health.color} strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                        <span className="text-sm font-semibold text-stone-800 dark:text-stone-200">Why {health.label}</span>
                      </div>
                      <span className="text-xs text-stone-400 dark:text-stone-500">{trlLabel}</span>
                    </div>
                    <p className="text-sm text-stone-700 dark:text-stone-300 leading-relaxed">{actionSentence}</p>
                  </div>

                  {/* Factor breakdown */}
                  <div className="px-5 pb-4 space-y-2 border-t border-stone-200/40 dark:border-stone-600/40 pt-3">
                    {health.factors.filter(f => f.type !== 'info').map((f, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <span className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${
                          f.type === 'positive' ? 'bg-emerald-500' :
                          f.type === 'negative' ? 'bg-red-500' :
                          f.type === 'warning' ? 'bg-amber-500' : 'bg-stone-300'
                        }`}/>
                        <span className="text-sm text-stone-600 dark:text-stone-400 flex-1 leading-snug">{f.label}</span>
                        <span className={`text-xs font-semibold flex-shrink-0 ${
                          f.impact > 0 ? 'text-emerald-600 dark:text-emerald-400' :
                          f.impact < 0 ? 'text-red-500' : 'text-stone-400'
                        }`}>
                          {f.impact > 0 ? '+' : ''}{f.impact !== 0 ? f.impact : ''}
                        </span>
                      </div>
                    ))}
                    {health.factors.filter(f => f.type === 'info').map((f, i) => (
                      <div key={'info-'+i} className="flex items-center gap-2 opacity-60">
                        <span className="w-2 h-2 rounded-full bg-stone-300 flex-shrink-0"/>
                        <span className="text-xs text-stone-500 dark:text-stone-500">{f.label}</span>
                      </div>
                    ))}
                  </div>

                  {/* Check-in CTA — only when action is needed */}
                  {health.shouldCheckIn && (
                    <div className="mx-5 mb-4 px-4 py-3 rounded-xl flex items-center gap-3" style={{ backgroundColor: 'rgba(255,255,255,0.6)', border: `1px solid ${health.color}30` }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={health.color} strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                      <div>
                        <p className="text-xs font-semibold" style={{ color: health.color }}>Suggested action</p>
                        <p className="text-xs text-stone-600 dark:text-stone-400 mt-0.5">{health.checkInReason} — reach out to the founder for an update.</p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        );
      })()}

      {/* Update Log */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl overflow-hidden">
        {/* Nudge banner */}
        {updateOverdue && (
          <div className="px-5 py-3 flex items-center gap-3" style={{ backgroundColor: '#FEF3C7', borderBottom: '1px solid #FDE68A' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p className="text-sm text-amber-800">
              Update overdue by {Math.abs(daysUntilNext)} days — worth nudging the founder?
            </p>
          </div>
        )}
        {updateDueSoon && !updateOverdue && (
          <div className="px-5 py-3 flex items-center gap-3" style={{ backgroundColor: '#F0FDF4', borderBottom: '1px solid #BBF7D0' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <p className="text-sm text-emerald-800">
              {daysUntilNext > 0 ? `Update expected in ${daysUntilNext} days` : 'Update expected today'}
            </p>
          </div>
        )}

        <button
          onClick={() => setShowUpdateLog(!showUpdateLog)}
          className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50 dark:hover:bg-stone-700/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#78716c" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">Update log</span>
            {updateEntries.length > 0 && (
              <span className="text-xs text-stone-400">({updateEntries.length})</span>
            )}
            {daysSinceUpdate !== null && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${updateOverdue ? 'bg-amber-100 text-amber-700' : 'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400'}`}>
                Last {daysSinceUpdate}d ago
              </span>
            )}
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="2"
            className={`transition-transform ${showUpdateLog ? 'rotate-180' : ''}`}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        {showUpdateLog && (
          <div className="px-5 pb-5 border-t border-stone-100 dark:border-stone-700">
            <div className="pt-4 space-y-3">
              {updateEntries.length === 0 && !showAddUpdate && (
                <p className="text-sm text-stone-400 dark:text-stone-500 text-center py-2">No updates logged yet</p>
              )}
              {updateEntries.map(entry => {
                const entrySignals = parseUpdateForSignals(entry.description, entry.date);
                const hasNeg = entrySignals.some(s => s.sentiment === 'negative');
                const hasPos = entrySignals.some(s => s.sentiment === 'positive');
                return (
                  <div key={entry.id} className="flex gap-3">
                    <div className={`w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 ${hasNeg ? 'bg-amber-400' : hasPos ? 'bg-emerald-400' : 'bg-stone-300 dark:bg-stone-600'}`} />
                    <div className="flex-1">
                      <p className="text-sm text-stone-700 dark:text-stone-300">{entry.description}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <p className="text-xs text-stone-400">
                          {new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                        {entrySignals.length > 0 && (
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${hasNeg ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                            {entrySignals.length} signal{entrySignals.length > 1 ? 's' : ''} extracted
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {showAddUpdate ? (
                <div className="space-y-2 pt-1">
                  <textarea
                    value={newUpdateNote}
                    onChange={e => setNewUpdateNote(e.target.value)}
                    placeholder="Paste a founder email, or write what you observed. e.g. 'Joey called — runway is 14 months, raising Series A in Q3. Meta pilot still on track, second data center customer in LOI stage.'"
                    rows={4}
                    className="w-full p-3 text-sm border border-stone-200 dark:border-stone-600 rounded-xl bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:border-[#5B6DC4] resize-none"
                    autoFocus
                  />
                  {/* Live signal preview — shows what will be extracted before saving */}
                  {newUpdateNote.length > 20 && (() => {
                    const preview = parseUpdateForSignals(newUpdateNote, new Date().toISOString());
                    if (preview.length === 0) return null;
                    const hasNeg = preview.some(s => s.sentiment === 'negative');
                    return (
                      <div className={`px-3 py-2 rounded-lg text-xs ${hasNeg ? 'bg-amber-50 border border-amber-200' : 'bg-emerald-50 border border-emerald-200'}`}>
                        <span className={`font-semibold ${hasNeg ? 'text-amber-700' : 'text-emerald-700'}`}>
                          {preview.length} signal{preview.length > 1 ? 's' : ''} detected:
                        </span>
                        <span className={`ml-1 ${hasNeg ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {preview.map(s => s.title).join(' · ')}
                        </span>
                        <span className="text-stone-400 ml-1">— will update health score</span>
                      </div>
                    );
                  })()}
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddUpdate}
                      disabled={newUpdateNote.trim().length < 10}
                      className="flex-1 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40 transition-all"
                      style={{ backgroundColor: '#5B6DC4' }}
                    >
                      Log update
                    </button>
                    <button
                      onClick={() => { setShowAddUpdate(false); setNewUpdateNote(''); }}
                      className="px-4 py-2 text-sm text-stone-500 hover:text-stone-700 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowAddUpdate(true)}
                  className="text-sm text-[#5B6DC4] hover:text-[#4a5ba8] transition-colors"
                >
                  + Log update
                </button>
              )}
            </div>
          </div>
        )}
      </div>



    </div>
  );
};

// Monitoring View
// Passed View

// Portfolio Monitor Page - Health tracking and news feed for invested companies
// Main App (internal, wrapped by auth)
// ── Deal list card components — defined at module level so React reconciler is stable ──

// Aliases so preview components work in production context
const fmtC = formatCurrency;
const dAgo = daysAgo;
const genId = generateId;
const dUntil = daysUntil;
const STAGE_MAT = STAGE_MATURITY;

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
  const dSinceUpd=lastUpd?dAgo(lastUpd):999;
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

// Toast defined above

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
  const [showReadings, setShowReadings] = useState(null); // key of expanded readings

  const logEntry = (key, isRevenue=false) => {
    if (!inputVal || isNaN(Number(inputVal))) return;
    const entry = { v: Number(inputVal), date: new Date(inputDate).toISOString() };
    const updated = isRevenue
      ? { ...deal, revenueLog: [...revenue, entry].sort((a,b)=>new Date(a.date)-new Date(b.date)) }
      : { ...deal, metricsLog: { ...log, [key]: [...(log[key]||[]), entry].sort((a,b)=>new Date(a.date)-new Date(b.date)) }};
    onUpdate(updated);
    setActive(null); setInputVal(''); setInputDate(new Date().toISOString().slice(0,10));
  };

  const deleteReading = (key, idx, isRevenue=false) => {
    if (isRevenue) {
      onUpdate({...deal, revenueLog: revenue.filter((_,i)=>i!==idx)});
    } else {
      const updated = [...(log[key]||[])];
      updated.splice(idx,1);
      onUpdate({...deal, metricsLog:{...log,[key]:updated}});
    }
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
          <div>
            <MiniLine readings={revenue} color="#10b981" wide={true}/>
            <button onClick={()=>setShowReadings(showReadings==='__revenue__'?null:'__revenue__')} style={{marginTop:6,fontSize:11,color:'#9ca3af',background:'none',border:'none',cursor:'pointer',padding:0}}>{showReadings==='__revenue__'?'Hide readings':'Edit readings ({revenue.length})'}</button>
            {showReadings==='__revenue__'&&<div style={{marginTop:8,display:'flex',flexDirection:'column',gap:4}}>
              {revenue.map((r,i)=>(
                <div key={i} style={{display:'flex',alignItems:'center',gap:8,padding:'4px 8px',background:'#f9fafb',borderRadius:8}}>
                  <span style={{fontSize:12,color:'#374151',flex:1}}>{fmtC(r.v)} · {new Date(r.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>
                  <button onClick={()=>deleteReading('__revenue__',i,true)} style={{color:'#d1d5db',background:'none',border:'none',cursor:'pointer',padding:2,fontSize:11}}>✕</button>
                </div>
              ))}
            </div>}
          </div>
        ):(
          <p style={{fontSize:12,color:'#d1d5db',fontStyle:'italic'}}>No revenue logged yet — add a reading once the company starts generating revenue</p>
        )}
      </div>

      {/* Traction metrics — pre-revenue proxies, hidden once revenue exists */}
      {metrics.length>0&&!hasRevenue&&<div style={{borderTop:'1px solid #f3f4f6',paddingTop:14}}>
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
                          <button onClick={()=>deleteReading(metric,ri,false)} style={{color:'#d1d5db',background:'none',border:'none',cursor:'pointer',padding:2,fontSize:11}}>✕</button>
                        </div>
                      ))}
                    </div>}
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

const SignalsSection = ({deal}) => {
  const allMilestones = (deal.milestones||[])
    .filter(m => ['fundraising','partnership','product','update'].includes(m.type))
    .sort((a,b) => new Date(b.date)-new Date(a.date));
  if (!allMilestones.length) return null;
  const TYPE_CFG = {
    fundraising:{color:'#5B6DC4',bg:'#FFFBEC',label:'Funding'},
    partnership:{color:'#10b981',bg:'#f0fdf4',label:'Partnership'},
    product:{color:'#f59e0b',bg:'#fffbeb',label:'Product'},
    update:{color:'#78716c',bg:'#f5f5f4',label:'Update'},
  };
  return (
    <div style={{background:'white',borderRadius:16,padding:20,marginBottom:12}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Signals</span>
        <span style={{fontSize:12,color:'#9ca3af'}}>{allMilestones.length} logged</span>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {allMilestones.slice(0,6).map((s,i)=>{
          const cfg=TYPE_CFG[s.type]||TYPE_CFG.update;
          return <div key={s.id||i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'10px 12px',borderRadius:12,background:cfg.bg}}>
            <div style={{flexShrink:0,marginTop:2}}>
              <Pill color={cfg.color} bg={cfg.color+'18'}>{cfg.label}</Pill>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <p style={{fontSize:13,fontWeight:500,color:'#111827',marginBottom:2}}>{s.title}</p>
              {s.description&&<p style={{fontSize:12,color:'#6b7280',lineHeight:1.5}}>{s.description}</p>}
            </div>
            <span style={{fontSize:11,color:'#9ca3af',flexShrink:0,marginTop:2}}>{dAgo(s.date)}d ago</span>
          </div>;
        })}
      </div>
    </div>
  );
};

// ── INVESTMENT MEMO ───────────────────────────────────────────────────────────
// Written once at the moment of decision. The thesis. Editable anytime.
const InvestmentMemo = ({deal, onUpdate, setToast}) => {
  const isWatching = deal.status === 'watching';
  const label = isWatching ? 'Why I am watching' : 'Investment memo';
  const placeholder = isWatching
    ? 'Why are you watching this company? What would move you to invest? What risks are you tracking?'
    : 'Why did you invest? What is your thesis? What are the key risks? What would make this a winner?';
  const memo = deal.memo || '';
  const [editing, setEditing] = useState(!memo);
  const [draft, setDraft] = useState(memo);
  const [open, setOpen] = useState(true);

  const save = () => {
    onUpdate({...deal, memo:draft.trim()});
    setEditing(false);
    setToast('Memo saved');
  };

  return (
    <div style={{background:'white',borderRadius:16,overflow:'hidden',marginBottom:12}}>
      <button onClick={()=>setOpen(v=>!v)} style={{width:'100%',padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'none',border:'none',cursor:'pointer'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>{label}</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          {memo&&!editing&&open&&<button onClick={e=>{e.stopPropagation();setDraft(memo);setEditing(true);}} style={{fontSize:12,color:'#5B6DC4',background:'none',border:'none',cursor:'pointer',padding:'2px 8px'}}>Edit</button>}
          {!memo&&<span style={{fontSize:12,color:'#9ca3af'}}>Not written yet</span>}
          <span style={{color:'#9ca3af',fontSize:11}}>{open?'▲':'▼'}</span>
        </div>
      </button>
      {open&&<div style={{padding:'0 20px 20px',borderTop:'1px solid #f3f4f6'}}>
        {editing?(
          <div style={{paddingTop:14}}>
            <textarea value={draft} onChange={e=>setDraft(e.target.value)} placeholder={placeholder} rows={6}
              style={{width:'100%',padding:'10px 12px',border:'1px solid #5B6DC4',borderRadius:12,fontSize:13,resize:'vertical',outline:'none',boxSizing:'border-box',fontFamily:'inherit',lineHeight:1.7}}
              autoFocus/>
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <button onClick={save} disabled={draft.trim().length<5} style={{flex:1,padding:'8px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',opacity:draft.trim().length>=5?1:.4}}>Save memo</button>
              {memo&&<button onClick={()=>setEditing(false)} style={{padding:'8px 14px',background:'none',border:'none',color:'#6b7280',fontSize:13,cursor:'pointer'}}>Cancel</button>}
            </div>
          </div>
        ):memo?(
          <p style={{fontSize:13,color:'#374151',lineHeight:1.8,whiteSpace:'pre-wrap',paddingTop:12}}>{memo}</p>
        ):null}
      </div>}
    </div>
  );
};

// ── FOUNDER UPDATES ───────────────────────────────────────────────────────────
// Recurring log of founder communications. Paste text or upload file.
// Signal extraction runs on each entry and surfaces tags.
const FounderUpdates = ({deal, onUpdate, setToast, inv={}, overdue=false, dUntilNext=null, dSinceUpd=null}) => {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [fileInfo, setFileInfo] = useState(null); // {name, type}
  const fileRef = useState(null);

  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const updates = (deal.founderUpdates||[]).sort((a,b)=>new Date(b.date)-new Date(a.date));

  const deleteUpdate = (id) => onUpdate({...deal, founderUpdates:(deal.founderUpdates||[]).filter(u=>u.id!==id)});

  const saveEdit = (id) => {
    const now = new Date().toISOString();
    const sigs = parseNote(editDraft.trim(), now);
    onUpdate({...deal, founderUpdates:(deal.founderUpdates||[]).map(u=>
      u.id===id ? {...u, content:editDraft.trim(), signals:sigs.map(s=>s.type), editedAt:now} : u
    )});
    setEditingId(null); setEditDraft('');
  };

  const addText = () => {
    if(draft.trim().length < 5) return;
    const now = new Date().toISOString();
    const sigs = parseNote(draft.trim(), now);
    const entry = {id:genId(), type:'text', content:draft.trim(), date:now, signals:sigs.map(s=>s.type)};
    onUpdate({...deal,
      founderUpdates:[...(deal.founderUpdates||[]), entry],
      investment:{...inv, lastUpdateReceived:now}
    });
    setDraft(''); setAdding(false);
    const hasFundingSig = sigs.some(s=>s.type==='funding_signal');
    if (hasFundingSig && deal.monitoring?.fundraisingStatus !== 'raising') {
      setToast('Funding signal detected — consider adding an active raise entry');
    } else {
      setToast(sigs.length ? `Update logged · ${sigs.length} signal${sigs.length>1?'s':''} detected` : 'Update logged');
    }
  };

  const addFile = (file) => {
    if(!file) return;
    const now = new Date().toISOString();
    const entry = {id:genId(), type:'file', fileName:file.name, fileType:file.type, date:now, signals:[]};
    onUpdate({...deal,
      founderUpdates:[...(deal.founderUpdates||[]), entry],
      investment:{...inv, lastUpdateReceived:now}
    });
    setFileInfo(null); setAdding(false);
    setToast(`${file.name} uploaded`);
  };

  const SIG_COLORS = {
    funding_signal:{l:'Funding',c:'#5B6DC4',bg:'#FFFBEC'},
    hardware_milestone:{l:'Milestone',c:'#f59e0b',bg:'#fffbeb'},
    offtake:{l:'Customer',c:'#10b981',bg:'#f0fdf4'},
    team_risk:{l:'Team risk',c:'#ef4444',bg:'#fef2f2'},
    policy_risk:{l:'Policy risk',c:'#ef4444',bg:'#fef2f2'},
    policy_positive:{l:'Policy',c:'#10b981',bg:'#f0fdf4'},
    risk:{l:'Risk',c:'#f59e0b',bg:'#fffbeb'},
  };

  // Detect if any update mentions revenue/traction — prompt to log metric
  const hasRevenueSignal = updates.some(u => u.type==='text' && /revenue|arr|mrr|\$\d|million|customers|users/i.test(u.content));
  const hasRecentMetric = (deal.metricsToWatch||[]).some(m=>(deal.metricsLog||{})[m]?.some(e=>dAgo(e.date)<=90));
  const hasRecentRevenue = (deal.revenueLog||[]).some(e=>dAgo(e.date)<=90);
  const showMetricPrompt = hasRevenueSignal && !hasRecentMetric && !hasRecentRevenue;
  const hasFundingUpdate = updates.some(u => u.type==='text' && u.signals?.includes('funding_signal'));

  return (
    <div style={{background:'white',borderRadius:16,overflow:'hidden',marginBottom:12}}>
      {overdue&&<div style={{padding:'9px 16px',background:'#fffbeb',borderBottom:'1px solid #fde68a',display:'flex',gap:8,alignItems:'center'}}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p style={{fontSize:12,color:'#92400e'}}>Founder update overdue by {Math.abs(dUntilNext)} days</p>
      </div>}
      <button onClick={()=>setOpen(v=>!v)} style={{width:'100%',padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'none',border:'none',cursor:'pointer'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          <span style={{fontWeight:600,fontSize:14,color:'#111827'}}>Founder updates</span>
          {updates.length>0&&<span style={{fontSize:12,color:'#9ca3af'}}>({updates.length})</span>}
          {dSinceUpd!==null&&<Pill color={overdue?'#b45309':'#6b7280'} bg={overdue?'#fef3c7':'#f5f5f4'}>Last {dSinceUpd}d ago</Pill>}
        </div>
        <span style={{color:'#9ca3af',fontSize:11}}>{open?'▲':'▼'}</span>
      </button>

      {open&&<div style={{padding:'0 20px 20px',borderTop:'1px solid #f3f4f6'}}>
        {/* Prompts */}
        {showMetricPrompt&&<div style={{margin:'12px 0',padding:'10px 14px',background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:12,display:'flex',gap:10,alignItems:'center'}}>
          <span style={{fontSize:14}}>📊</span>
          <p style={{fontSize:13,color:'#166534',flex:1}}>A recent update mentions revenue or customers — log a metric reading to track progress</p>
        </div>}
        {hasFundingUpdate&&deal.monitoring?.fundraisingStatus!=='raising'&&<div style={{margin:'12px 0',padding:'10px 14px',background:'#FFFBEC',border:'1px solid #c7d2fe',borderRadius:12,display:'flex',gap:10,alignItems:'center'}}>
          <span style={{fontSize:14}}>💰</span>
          <p style={{fontSize:13,color:'#5B6DC4',flex:1}}>A recent update mentions a fundraise — add an active raise entry to track dilution</p>
        </div>}

        {/* Update entries */}
        {updates.length===0&&!adding&&<p style={{fontSize:13,color:'#9ca3af',textAlign:'center',padding:'12px 0'}}>No updates yet — paste a founder email or upload a PDF</p>}
          {updates.map((u,i)=>{
          const sigs = u.type==='text' ? parseNote(u.content, u.date) : [];
          const hasNeg = sigs.some(s=>s.sentiment==='negative');
          const isEditing = editingId === u.id;
          return (
            <div key={u.id} style={{paddingTop:12,marginTop:i===0?4:0,borderTop:i===0?'none':'1px solid #f3f4f6'}}>
              {u.type==='file'?(
                <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:'#f9fafb',borderRadius:10}}>
                  <span style={{fontSize:16}}>{u.fileType?.includes('pdf')?'📄':'📝'}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{fontSize:13,fontWeight:500,color:'#374151',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{u.fileName}</p>
                    <p style={{fontSize:11,color:'#9ca3af',marginTop:2}}>{new Date(u.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</p>
                  </div>
                  <button onClick={()=>deleteUpdate(u.id)} style={{color:'#d1d5db',background:'none',border:'none',cursor:'pointer',padding:4}}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                  </button>
                </div>
              ):isEditing?(
                <div>
                  <textarea value={editDraft} onChange={e=>setEditDraft(e.target.value)} rows={4}
                    style={{width:'100%',padding:'10px 12px',border:'1px solid #5B6DC4',borderRadius:12,fontSize:13,resize:'none',outline:'none',boxSizing:'border-box',fontFamily:'inherit',lineHeight:1.6}}
                    autoFocus/>
                  <div style={{display:'flex',gap:8,marginTop:8}}>
                    <button onClick={()=>saveEdit(u.id)} disabled={editDraft.trim().length<5} style={{flex:1,padding:'7px',background:'#5B6DC4',color:'white',border:'none',borderRadius:9,fontWeight:600,fontSize:13,cursor:'pointer',opacity:editDraft.trim().length>=5?1:.4}}>Save</button>
                    <button onClick={()=>setEditingId(null)} style={{padding:'7px 12px',background:'none',border:'none',color:'#6b7280',fontSize:13,cursor:'pointer'}}>Cancel</button>
                  </div>
                </div>
              ):(
                <div>
                  <p style={{fontSize:13,color:'#374151',lineHeight:1.7}}>{u.content}</p>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginTop:6,flexWrap:'wrap'}}>
                    <span style={{fontSize:11,color:'#9ca3af'}}>{new Date(u.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}{u.editedAt&&<span style={{color:'#d1d5db'}}> · edited</span>}</span>
                    {sigs.map((s,si)=>{
                      const cfg=SIG_COLORS[s.type]||{l:s.type,c:'#78716c',bg:'#f5f5f4'};
                      return <span key={si} style={{fontSize:10,fontWeight:700,color:cfg.c,background:cfg.bg,padding:'2px 7px',borderRadius:99}}>{cfg.l}</span>;
                    })}
                    {hasNeg&&<span style={{fontSize:10,color:'#ef4444',fontWeight:600}}>⚠ needs attention</span>}
                    <div style={{marginLeft:'auto',display:'flex',gap:6}}>
                      <button onClick={()=>{setEditingId(u.id);setEditDraft(u.content);}} style={{fontSize:11,color:'#9ca3af',background:'none',border:'none',cursor:'pointer',padding:0}}>Edit</button>
                      <button onClick={()=>deleteUpdate(u.id)} style={{fontSize:11,color:'#d1d5db',background:'none',border:'none',cursor:'pointer',padding:0}}>Delete</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Add entry */}
        {adding?(
          <div style={{marginTop:14,paddingTop:14,borderTop:'1px solid #f3f4f6'}}>
            <textarea value={draft} onChange={e=>setDraft(e.target.value)}
              placeholder="Paste the founder email, quarterly update, or summarize what they shared..."
              rows={5} style={{width:'100%',padding:'10px 12px',border:'1px solid #e5e7eb',borderRadius:12,fontSize:13,resize:'none',outline:'none',boxSizing:'border-box',fontFamily:'inherit',lineHeight:1.6}}
              autoFocus/>
            <div style={{display:'flex',alignItems:'center',gap:8,marginTop:10}}>
              <button onClick={addText} disabled={draft.trim().length<5} style={{flex:1,padding:'8px',background:'#5B6DC4',color:'white',border:'none',borderRadius:10,fontWeight:600,fontSize:13,cursor:'pointer',opacity:draft.trim().length>=5?1:.4}}>Log update</button>
              <span style={{fontSize:12,color:'#9ca3af'}}>or</span>
              <label style={{padding:'8px 14px',border:'1px solid #e5e7eb',borderRadius:10,fontSize:13,color:'#374151',cursor:'pointer',background:'white',fontWeight:500}}>
                Upload file
                <input type="file" accept=".pdf,.doc,.docx" style={{display:'none'}} onChange={e=>{const f=e.target.files[0];if(f)addFile(f);}}/>
              </label>
              <button onClick={()=>{setAdding(false);setDraft('');}} style={{padding:'8px 12px',background:'none',border:'none',color:'#9ca3af',fontSize:13,cursor:'pointer'}}>Cancel</button>
            </div>
          </div>
        ):(
          <button onClick={()=>setAdding(true)} style={{marginTop:12,background:'none',border:'none',color:'#5B6DC4',fontSize:13,fontWeight:500,cursor:'pointer',padding:0,display:'flex',alignItems:'center',gap:6}}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add founder update
          </button>
        )}
      </div>}
    </div>
  );
};

// ── PROMOTE TO INVESTED MODAL ─────────────────────────────────────────────────
const PromoteModal = ({deal, onClose, onPromote}) => {
  const [f, setF] = useState({amount:'', vehicle:'SAFE', date:new Date().toISOString().slice(0,10), notes:''});
  const inp = {width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:10, fontSize:13, boxSizing:'border-box'};
  const lbl = {fontSize:12, color:'#6b7280', display:'block', marginBottom:4};

  const submit = () => {
    if (!f.amount) return;
    const now = new Date(f.date).toISOString();
    const promoted = {
      ...deal,
      status: 'invested',
      statusEnteredAt: now,
      investment: {
        amount: Number(f.amount),
        costBasis: Number(f.amount),
        vehicle: f.vehicle,
        date: now,
        lastUpdateReceived: now,
      },
      // Append invest note to memo if provided
      memo: f.notes.trim()
        ? (deal.memo ? `${deal.memo}\n\n---\nInvestment note (${new Date(f.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}): ${f.notes.trim()}` : f.notes.trim())
        : deal.memo || '',
      monitoring: {...(deal.monitoring||{}), fundraisingStatus:'not-raising'},
    };
    onPromote(promoted);
    onClose();
  };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:'white',borderRadius:20,width:'100%',maxWidth:400,overflow:'hidden'}}>
        <div style={{padding:'14px 20px',borderBottom:'1px solid #f3f4f6',display:'flex',justifyContent:'space-between',alignItems:'center',background:'#5B6DC4'}}>
          <div>
            <p style={{fontWeight:700,fontSize:15,color:'white'}}>Invest in {deal.companyName}</p>
            <p style={{fontSize:12,color:'rgba(255,255,255,.75)',marginTop:2}}>Converts to portfolio company — all notes and history preserved</p>
          </div>
          <button onClick={onClose} style={{background:'rgba(255,255,255,.2)',border:'none',cursor:'pointer',color:'white',borderRadius:8,padding:'4px 8px'}}>✕</button>
        </div>
        <div style={{padding:20,display:'flex',flexDirection:'column',gap:14}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <div>
              <label style={lbl}>Amount ($) *</label>
              <input type="number" value={f.amount} onChange={e=>setF(p=>({...p,amount:e.target.value}))} placeholder="25000" style={inp} autoFocus/>
            </div>
            <div>
              <label style={lbl}>Vehicle</label>
              <select value={f.vehicle} onChange={e=>setF(p=>({...p,vehicle:e.target.value}))} style={inp}>
                <option value="SAFE">SAFE</option>
                <option value="Convertible Note">Conv. Note</option>
                <option value="Equity">Equity</option>
              </select>
            </div>
          </div>
          <div>
            <label style={lbl}>Investment date</label>
            <input type="date" value={f.date} onChange={e=>setF(p=>({...p,date:e.target.value}))} style={inp}/>
          </div>
          <div>
            <label style={lbl}>Investment note <span style={{fontWeight:400,color:'#9ca3af'}}>(optional — appended to memo)</span></label>
            <textarea value={f.notes} onChange={e=>setF(p=>({...p,notes:e.target.value}))}
              placeholder="Why you decided to invest now, what changed your mind..."
              rows={3} style={{...inp,resize:'none',outline:'none',fontFamily:'inherit',lineHeight:1.6}}/>
          </div>
        </div>
        <div style={{padding:'12px 20px',borderTop:'1px solid #f3f4f6',display:'flex',gap:8}}>
          <button onClick={submit} disabled={!f.amount} style={{flex:1,padding:'11px',background:'#5B6DC4',color:'white',border:'none',borderRadius:12,fontWeight:700,fontSize:14,cursor:'pointer',opacity:f.amount?1:.4}}>
            Invest — move to portfolio
          </button>
        </div>
      </div>
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
  const [showInvDetails,setShowInvDetails]=useState(false);
  const dSinceUpd=inv.lastUpdateReceived?dAgo(inv.lastUpdateReceived):null;
  const dUntilNext=inv.nextUpdateExpected?dUntil(inv.nextUpdateExpected):null;
  const overdue=dUntilNext!==null&&dUntilNext<-7;
  const health=calcHealth(deal,[]);

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

        {/* Notes */}
        <InvestmentMemo deal={deal} onUpdate={onUpdate} setToast={setToast}/>

        <FounderUpdates deal={deal} onUpdate={onUpdate} setToast={setToast}/>

        {/* Signals */}
        <SignalsSection deal={deal}/>

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

      {/* Proactive prompts — grounded in real data gaps */}
      {(()=>{
        const prompts=[];
        const allMetrics=deal.metricsToWatch||[];
        const hasRecentMetric=allMetrics.some(m=>(deal.metricsLog||{})[m]?.some(e=>dAgo(e.date)<=90));
        const hasRecentRevenue=(deal.revenueLog||[]).some(e=>dAgo(e.date)<=90);
        if(allMetrics.length>0&&!hasRecentMetric&&!hasRecentRevenue) prompts.push({icon:'📊',text:'No metrics logged in 90+ days — log a reading after your next founder call'});
        const staleness=getStaleness(deal);
        if(staleness==='very-stale'&&getMethod(deal)!=='mark-at-cost') prompts.push({icon:'📅',text:'Valuation mark is over a year old — worth refreshing with the founder'});
        if(!prompts.length) return null;
        return <div style={{marginBottom:12,display:'flex',flexDirection:'column',gap:8}}>
          {prompts.map((p,i)=>(
            <div key={i} style={{padding:'10px 14px',background:'#f9fafb',border:'1px solid #e5e7eb',borderRadius:12,display:'flex',alignItems:'center',gap:10}}>
              <span style={{fontSize:15,flexShrink:0}}>{p.icon}</span>
              <p style={{fontSize:13,color:'#374151',flex:1,lineHeight:1.5}}>{p.text}</p>
            </div>
          ))}
        </div>;
      })()}

      <InvestmentMemo deal={deal} onUpdate={onUpdate} setToast={setToast}/>

      <FounderUpdates deal={deal} onUpdate={onUpdate} setToast={setToast} inv={inv} overdue={overdue} dUntilNext={dUntilNext} dSinceUpd={dSinceUpd}/>

      <SignalsSection deal={deal}/>

      <CoInvestorsSection deal={deal} onUpdate={onUpdate} setToast={setToast}/>
      <FundraiseHistory deal={deal} onUpdate={onUpdate} setToast={setToast}/>
      <div style={{marginTop:12}}><LiquiditySection deal={deal} onUpdate={onUpdate} setToast={setToast}/></div>
      <div style={{marginTop:12}}><DocumentsSection deal={deal} onUpdate={onUpdate} setToast={setToast}/></div>
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
        <CompanyLogo name={deal.companyName} website={deal.website} size={44} radius={12} fallbackBg="#f59e0b" fallbackColor="white"/>
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

// ── APP SHELL ─────────────────────────────────────────────────────────────────

function ConvexApp({ userMenu, syncStatus, user }) {
  const [page, setPage] = useState('list');
  const [deals, setDeals] = useState([]);
  const [dealsLoading, setDealsLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [toast, setToastRaw] = useState(null);
  const setToast = (msg) => {
    if (typeof msg === 'string') setToastRaw({ message: msg, type: 'success' });
    else setToastRaw(msg);
  };
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('health');
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const [showAddPortfolio, setShowAddPortfolio] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  

  // Theme effect - applies dark class to html element
  useEffect(() => {
    const applyTheme = () => {
      const root = document.documentElement;
      const body = document.body;
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const shouldBeDark = settings.appearance === 'dark' || (settings.appearance === 'auto' && prefersDark);
      
      if (shouldBeDark) {
        root.classList.add('dark');
        root.style.colorScheme = 'dark';
        body.style.backgroundColor = '#1c1917'; // stone-900
        body.style.color = '#fafaf9'; // stone-50
      } else {
        root.classList.remove('dark');
        root.style.colorScheme = 'light';
        body.style.backgroundColor = '#fafaf9'; // stone-50
        body.style.color = '#1c1917'; // stone-900
      }
    };

    applyTheme();

    // Listen for system preference changes when in auto mode
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (settings.appearance === 'auto') {
        applyTheme();
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [settings.appearance]);

  useEffect(() => {
    if (!user?.id) return;
    let mounted = true;
    const loadDeals = async () => {
      try {
        const { data, error } = await supabase
          .from('deals')
          .select('id, data')
          .eq('user_id', user.id);

        if (!mounted) return;

        if (error) {
          console.error('Error loading deals:', error);
          setDealsLoading(false);
          return;
        }

        if (data && data.length > 0) {
          setDeals(data.map(row => ({ ...row.data, id: row.id })));
          setDealsLoading(false);
        } else {
          // New user — seed demo data
          const demo = createDemoDeals();
          if (mounted) {
            setDeals(demo);
            setDealsLoading(false);
          }
          // Write demo deals in background without blocking
          for (const deal of demo) {
            const { id, ...dealData } = deal;
            await supabase.from('deals').insert({
              id,
              user_id: user.id,
              company_name: deal.companyName,
              status: deal.status,
              data: dealData
            });
          }
        }
      } catch (e) {
        console.error('loadDeals error:', e);
        if (mounted) setDealsLoading(false);
      }
    };
    loadDeals();
    return () => { mounted = false; };
  }, [user?.id]);

  // Invested deals — used for health scoring and portfolio summary
  const portfolioDeals = deals.filter(d => d.status === 'invested');
  // All tracked deals — invested + watching + passed
  const allTrackedDeals = deals;

  // Sort helper shared by both sections
  const sortDeals = (base) => {
    const agentCache = getAgentCache();
    return [...base].sort((a, b) => {
      if (sortBy === 'health') {
        // Watching/passed deals have no health score — push them after invested
        if (a.status !== 'invested' && b.status === 'invested') return 1;
        if (a.status === 'invested' && b.status !== 'invested') return -1;
        // calcDealHealth internally merges update log signals — consistent with card and detail view
        const ha = calcDealHealth(a, agentCache[a.id]?.signals || []).score;
        const hb = calcDealHealth(b, agentCache[b.id]?.signals || []).score;
        return ha - hb;
      }
      if (sortBy === 'newest') return new Date(b.statusEnteredAt || b.createdAt).getTime() - new Date(a.statusEnteredAt || a.createdAt).getTime();
      if (sortBy === 'oldest') return new Date(a.statusEnteredAt || a.createdAt).getTime() - new Date(b.statusEnteredAt || b.createdAt).getTime();
      if (sortBy === 'alphabetical') return a.companyName.localeCompare(b.companyName);
      if (sortBy === 'industry') return (a.industry || 'zzz').localeCompare(b.industry || 'zzz');
      if (sortBy === 'stage') {
        const stageOrder = { 'pre-seed': 1, 'seed': 2, 'series-a': 3, 'series-b': 4, 'series-c': 5, 'growth': 6 };
        return (stageOrder[a.stage] || 99) - (stageOrder[b.stage] || 99);
      }
      if (sortBy === 'deployed') return (b.investment?.amount || 0) - (a.investment?.amount || 0);
      return 0;
    });
  };

  // Filter and sort — used for both sections
  const getFilteredDeals = () => {
    let base = allTrackedDeals;
    if (search) base = base.filter(d => d.companyName.toLowerCase().includes(search.toLowerCase()));
    return sortDeals(base);
  };

  const filtered = getFilteredDeals();

  const updateDeal = async (updated) => {
    const now = new Date().toISOString();
    const { id, ...dealData } = { ...updated, lastActivity: now };
    // Optimistic update first
    setDeals(prev => prev.map(d => d.id === id ? { id, ...dealData } : d));
    setSelected({ id, ...dealData });
    // Persist in background
    const { error } = await supabase.from('deals')
      .update({ data: dealData, company_name: updated.companyName, status: updated.status, updated_at: now })
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) console.error('Failed to update deal:', error);
  };

  const addDeal = async (newDeal) => {
    // Optimistically update UI immediately
    setDeals(prev => [newDeal, ...prev]);

    // Persist to Supabase
    const { id, ...dealData } = newDeal;
    const { error } = await supabase.from('deals').insert({
      id,
      user_id: user.id,
      company_name: newDeal.companyName,
      status: newDeal.status,
      data: dealData
    });

    if (error) {
      console.error('Failed to save deal to Supabase:', error);
      setToast({ message: `Saved locally — sync failed: ${error.message}`, type: 'error' });
    } else {
      const statusLabel = STATUS_CONFIG[newDeal.status]?.label || newDeal.status;
      setToast({ message: `${newDeal.companyName} added as ${statusLabel}`, type: 'success' });
    }
  };

  const toggleEngagement = (dealId) => {
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, engagement: d.engagement === 'active' ? 'inactive' : 'active', lastActivity: new Date().toISOString() } : d));
    setSelected(prev => prev ? { ...prev, engagement: prev.engagement === 'active' ? 'inactive' : 'active' } : null);
  };



  // Settings page
  if (page === 'settings') return (
    <ThemeContext.Provider value={{ theme: settings.appearance, setTheme: (t) => setSettings(prev => ({ ...prev, appearance: t })) }}>
      <SettingsPage settings={settings} onUpdate={setSettings} onClose={() => setPage('list')} />
    </ThemeContext.Provider>
  );



  // Login/Landing - Thesis design with animated orbs
  if (page === 'login') {
    // Generate orbs with different positions, sizes, speeds, and opacities
    const orbs = [
      // Top left cluster
      { id: 1, x: 5, y: 8, size: 24, opacity: 0.3, duration: 18, delay: 0 },
      { id: 2, x: 12, y: 4, size: 12, opacity: 0.2, duration: 22, delay: 2 },
      { id: 3, x: 3, y: 18, size: 8, opacity: 0.15, duration: 15, delay: 1 },
      // Top right cluster
      { id: 4, x: 88, y: 6, size: 16, opacity: 0.25, duration: 20, delay: 3 },
      { id: 5, x: 94, y: 14, size: 10, opacity: 0.2, duration: 17, delay: 0 },
      { id: 6, x: 82, y: 3, size: 6, opacity: 0.15, duration: 25, delay: 4 },
      // Left side
      { id: 7, x: 2, y: 35, size: 14, opacity: 0.2, duration: 19, delay: 2 },
      { id: 8, x: 6, y: 50, size: 20, opacity: 0.25, duration: 23, delay: 1 },
      { id: 9, x: 4, y: 65, size: 8, opacity: 0.15, duration: 16, delay: 3 },
      // Right side
      { id: 10, x: 95, y: 40, size: 18, opacity: 0.2, duration: 21, delay: 0 },
      { id: 11, x: 92, y: 55, size: 10, opacity: 0.25, duration: 18, delay: 2 },
      { id: 12, x: 97, y: 70, size: 14, opacity: 0.2, duration: 24, delay: 4 },
      // Bottom left cluster
      { id: 13, x: 8, y: 85, size: 16, opacity: 0.2, duration: 20, delay: 1 },
      { id: 14, x: 3, y: 92, size: 12, opacity: 0.25, duration: 17, delay: 3 },
      { id: 15, x: 15, y: 95, size: 8, opacity: 0.15, duration: 22, delay: 0 },
      // Bottom right cluster
      { id: 16, x: 90, y: 88, size: 20, opacity: 0.2, duration: 19, delay: 2 },
      { id: 17, x: 85, y: 94, size: 10, opacity: 0.3, duration: 16, delay: 1 },
      { id: 18, x: 96, y: 82, size: 6, opacity: 0.15, duration: 21, delay: 4 },
      // Bottom center
      { id: 19, x: 45, y: 96, size: 8, opacity: 0.15, duration: 18, delay: 2 },
      { id: 20, x: 55, y: 94, size: 10, opacity: 0.2, duration: 23, delay: 0 },
    ];

    return (
      <div className="min-h-screen bg-stone-100 dark:bg-stone-900 relative overflow-hidden">
        {/* Animated Orbs */}
        <style>{`
          @keyframes float {
            0%, 100% { transform: translate(0, 0); }
            25% { transform: translate(10px, -15px); }
            50% { transform: translate(-5px, 10px); }
            75% { transform: translate(-15px, -5px); }
          }
        `}</style>
        {orbs.map(orb => (
          <div
            key={orb.id}
            className="absolute rounded-full"
            style={{
              left: `${orb.x}%`,
              top: `${orb.y}%`,
              width: `${orb.size}px`,
              height: `${orb.size}px`,
              backgroundColor: '#5B6DC4',
              opacity: orb.opacity,
              animation: `float ${orb.duration}s ease-in-out infinite`,
              animationDelay: `${orb.delay}s`,
            }}
          />
        ))}

        {/* Content */}
        <div className="relative z-10 min-h-screen flex flex-col">
          {/* Header */}
          <header className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#4A1942' }}>
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
              <span className="font-semibold text-stone-900 dark:text-stone-100">Thesis</span>
            </div>
            <button className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200">
              Log in
            </button>
          </header>

          {/* Main Content */}
          <main className="flex-1 flex flex-col items-center justify-center px-6">
            <h1 className="text-3xl md:text-4xl font-bold text-stone-900 dark:text-stone-100 text-center mb-4 max-w-lg">
              A decision system for angel investors.
            </h1>
            <p className="text-stone-500 dark:text-stone-400 text-center mb-10 max-w-md">
              Thesis isn't about finding better deals. It's about becoming a better decision-maker over time.
            </p>

            {/* CTA Button */}
            <button 
              onClick={() => setPage('login')} 
              style={{ backgroundColor: '#5B6DC4' }} 
              className="px-8 py-3 text-white rounded-xl font-medium hover:opacity-90 transition-all shadow-lg mb-16"
            >
              Get Started
            </button>

            {/* Three pillars - horizontal row */}
            <div className="flex items-start justify-center gap-12 mb-8">
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-3 flex items-center justify-center rounded-2xl bg-[#5B6DC4]/10">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="1.5">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400">Record decisions,<br/>not just outcomes</p>
              </div>
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-3 flex items-center justify-center rounded-2xl bg-[#5B6DC4]/10">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="9"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400">See how your thinking<br/>evolves over years</p>
              </div>
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-3 flex items-center justify-center rounded-2xl bg-[#5B6DC4]/10">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="1.5">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="15 8 19 12 15 16"/>
                  </svg>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400">Compare conviction<br/>to reality</p>
              </div>
            </div>
            
            <p className="text-stone-400 dark:text-stone-500 text-center text-sm">
              For operators investing alongside demanding careers — quickly and confidently.
            </p>
          </main>

          {/* Bottom decoration line */}
          <div className="flex justify-center pb-8">
            <div className="w-12 h-1 rounded-full bg-stone-300 dark:bg-stone-700 opacity-50"></div>
          </div>
        </div>
      </div>
    );
  }

  // Onboarding

  // Show minimal skeleton while deals are loading — prevents blank screen after OAuth
  if (dealsLoading) return (
    <div className="min-h-screen bg-stone-100 dark:bg-stone-900 flex items-center justify-center">
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 40, height: 40, background: '#4A1942', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <svg width="20" height="20" viewBox="0 0 38 38" fill="none">
            <circle cx="19" cy="19" r="4.5" fill="#F5DFA0"/>
            <line x1="19" y1="3" x2="19" y2="10" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="19" y1="28" x2="19" y2="35" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="3" y1="19" x2="10" y2="19" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="28" y1="19" x2="35" y2="19" stroke="#F5DFA0" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </div>
        <p style={{ color: '#78716c', fontSize: 14 }}>Loading your portfolio…</p>
      </div>
    </div>
  );

  // Detail
  if (page === 'detail' && selected) {
    const config = STATUS_CONFIG[selected.status] || STATUS_CONFIG['invested'];

    return (
      <div className="min-h-screen bg-stone-100 dark:bg-stone-900">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700">
          <div className="flex items-center justify-between px-6 py-4">
            <button onClick={() => setPage('list')} className="flex items-center gap-1 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              <span className="text-sm font-medium">Portfolio</span>
            </button>
            <div className="flex items-center gap-2">

              <button 
                onClick={() => toggleEngagement(selected.id)}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                  selected.engagement === 'active' 
                    ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' 
                    : 'bg-stone-200 dark:bg-stone-700 text-stone-500 dark:text-stone-400'
                }`}
              >
                {selected.engagement === 'active' ? 'Active' : 'Inactive'}
              </button>
            </div>
          </div>
        </header>
        <main className="px-6 py-6">
          <DetailView deal={selected} onUpdate={updateDeal} setToast={setToast} />
        </main>
        {toast && <Toast message={typeof toast === "string" ? toast : toast.message} type={typeof toast === "string" ? "success" : (toast.type || "success")} onClose={() => setToastRaw(null)} />}
      </div>
    );
  }

  const emptyState = { title: 'No investments yet', subtitle: 'When you invest, your portfolio builds here.' };

  return (
    <div className="min-h-screen bg-stone-100 dark:bg-stone-900">
      {/* Header */}
      <header className="bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700" style={{position:'relative', zIndex:50, overflow:'visible'}}>
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#5B6DC4' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                </svg>
              </div>
              <span className="font-semibold text-stone-900 dark:text-stone-100" style={{letterSpacing:'-0.3px'}}>Lucero</span>
            </div>
            {/* Sync Status */}
            {syncStatus}
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setPage('settings')}
              className="p-2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
              title="Settings"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <button 
              onClick={() => setShowAddPortfolio(true)}
              style={{ backgroundColor: '#5B6DC4' }}
              className="px-4 py-2 text-white text-sm font-medium rounded-xl hover:opacity-90 transition-colors flex items-center gap-1.5"
            >
              <span className="text-lg leading-none">+</span> Add Company
            </button>
            {/* User Menu */}
            {userMenu}
          </div>
        </div>

        {/* Tab Navigation - removed, portfolio only */}
      </header>

      {/* Content */}
      <div className="px-6 py-6">

        {/* ── PORTFOLIO DASHBOARD ─────────────────────────────────────── */}
        {portfolioDeals.length > 0 && (() => {
          const agentCache = getAgentCache();
          const signalsByDeal = Object.fromEntries(Object.entries(agentCache).map(([id, d]) => [id, d.signals || []]));
          const portfolioHealth = calcPortfolioHealth(deals, signalsByDeal);
          const dealHealthScores = portfolioDeals.map(d => ({ deal: d, health: calcDealHealth(d, signalsByDeal[d.id] || []) }));
          const checkInDeals = dealHealthScores.filter(({ health }) => health.shouldCheckIn).sort((a, b) => a.health.score - b.health.score);
          const totalDeployed = portfolioDeals.reduce((sum, d) => sum + getEffectiveCostBasis(d.investment || {}), 0);
          const totalImplied = portfolioDeals.reduce((sum, d) => sum + calcImpliedValue(d), 0);
          const portfolioMOIC = totalDeployed > 0 ? totalImplied / totalDeployed : null;
          const industries = [...new Set(portfolioDeals.map(d => d.industry))];

          return (
            <div className="mb-6 space-y-4">

              {/* ── Performance summary row ── */}
              <div className="bg-white dark:bg-stone-800 rounded-2xl p-5 border border-stone-200 dark:border-stone-700">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">Portfolio</h2>
                    <p className="text-xs text-stone-400 mt-0.5">{portfolioDeals.length} {portfolioDeals.length === 1 ? 'company' : 'companies'} · {industries.slice(0,2).join(', ')}{industries.length > 2 ? ` +${industries.length-2}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-semibold" style={{ backgroundColor: portfolioHealth.color + '18', color: portfolioHealth.color }} title={`Portfolio health score: ${portfolioHealth.score}/100 — weighted by cost basis`}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: portfolioHealth.color }}/>
                    {portfolioHealth.label}
                    <span className="text-xs font-normal opacity-60">{portfolioHealth.score}/100</span>
                  </div>
                </div>

                {/* 4-stat grid */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-stone-50 dark:bg-stone-700/50 rounded-xl p-3">
                    <p className="text-[10px] text-stone-400 uppercase tracking-wide mb-1">Deployed</p>
                    <p className="text-base font-bold text-stone-900 dark:text-stone-100">{formatCurrency(totalDeployed)}</p>
                    <p className="text-[10px] text-stone-400 mt-0.5">cost basis</p>
                  </div>
                  <div className="bg-stone-50 dark:bg-stone-700/50 rounded-xl p-3">
                    <p className="text-[10px] text-stone-400 uppercase tracking-wide mb-1">Implied</p>
                    <p className="text-base font-bold" style={{ color: totalImplied >= totalDeployed ? '#10b981' : '#ef4444' }}>{formatCurrency(totalImplied)}</p>
                    <p className="text-[10px] text-stone-400 mt-0.5">marked value</p>
                  </div>
                  <div className="bg-stone-50 dark:bg-stone-700/50 rounded-xl p-3">
                    <p className="text-[10px] text-stone-400 uppercase tracking-wide mb-1">Port. MOIC</p>
                    <p className="text-base font-bold" style={{ color: portfolioMOIC >= 1.5 ? '#10b981' : portfolioMOIC >= 1.0 ? '#5B6DC4' : '#ef4444' }}>
                      {portfolioMOIC !== null ? `${portfolioMOIC.toFixed(2)}x` : '—'}
                    </p>
                    <p className="text-[10px] text-stone-400 mt-0.5">blended</p>
                  </div>
                  <div className="bg-stone-50 dark:bg-stone-700/50 rounded-xl p-3">
                    <p className="text-[10px] text-stone-400 uppercase tracking-wide mb-1">Check-ins</p>
                    <p className="text-base font-bold" style={{ color: checkInDeals.length > 0 ? '#f59e0b' : '#10b981' }}>{checkInDeals.length}</p>
                    <p className="text-[10px] text-stone-400 mt-0.5">need action</p>
                  </div>
                </div>


              </div>

              {/* ── Check-in queue — the main action surface ── */}
              {checkInDeals.length > 0 && (
                <div className="rounded-2xl overflow-hidden border border-amber-200 dark:border-amber-800/60">
                  <div className="px-5 py-3 bg-amber-50 dark:bg-amber-900/20 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                      <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                        {checkInDeals.length} {checkInDeals.length === 1 ? 'company needs' : 'companies need'} your attention
                      </span>
                    </div>
                    <span className="text-xs text-amber-600 dark:text-amber-400">as investor you may be able to help</span>
                  </div>
                  <div className="divide-y divide-amber-100 dark:divide-amber-900/30 bg-white dark:bg-stone-800">
                    {checkInDeals.map(({ deal, health }) => {
                      const implied = calcImpliedValue(deal);
                      const moic = calcMOIC(deal);
                      const method = getValuationMethod(deal);
                      // Classify the reason into action type
                      const reason = health.checkInReason || '';
                      const isPolicy = reason.toLowerCase().includes('policy');
                      const isHardware = reason.toLowerCase().includes('hardware') || reason.toLowerCase().includes('pilot');
                      const isSilence = reason.toLowerCase().includes('silence') || reason.toLowerCase().includes('overdue');
                      const isFinancial = reason.toLowerCase().includes('moic') || reason.toLowerCase().includes('mark') || reason.toLowerCase().includes('runway');
                      const actionTag = isPolicy ? { label: 'Policy risk', color: '#7c3aed', bg: '#ede9fe' }
                        : isHardware ? { label: 'Technical risk', color: '#dc2626', bg: '#fee2e2' }
                        : isSilence ? { label: 'Check in', color: '#d97706', bg: '#fef3c7' }
                        : isFinancial ? { label: 'Financial signal', color: '#5B6DC4', bg: '#eef2ff' }
                        : { label: 'Review', color: '#78716c', bg: '#f5f5f4' };

                      return (
                        <div
                          key={deal.id}
                          onClick={() => { setSelected(deal); setPage('detail'); }}
                          className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-700/30 transition-colors"
                        >
                          {/* Logo */}
                          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                            style={{ backgroundColor: health.color }}>
                            {deal.companyName.charAt(0)}
                          </div>

                          {/* Company + reason */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="font-semibold text-stone-900 dark:text-stone-100 text-sm">{deal.companyName}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: actionTag.bg, color: actionTag.color }}>{actionTag.label}</span>
                            </div>
                            <p className="text-xs text-stone-500 dark:text-stone-400">{health.checkInReason}</p>
                            {/* Top 2 health factors */}
                            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                              {health.factors.filter(f => f.type !== 'info').slice(0, 2).map((f, i) => (
                                <span key={i} className="flex items-center gap-1 text-xs text-stone-400">
                                  <span className={`w-1.5 h-1.5 rounded-full ${f.type === 'negative' ? 'bg-red-400' : f.type === 'warning' ? 'bg-amber-400' : 'bg-emerald-400'}`}/>
                                  {f.label}
                                </span>
                              ))}
                            </div>
                          </div>

                          {/* Score + valuation */}
                          <div className="text-right flex-shrink-0 space-y-1">
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="w-16 h-1.5 rounded-full bg-stone-100 dark:bg-stone-700 overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${health.score}%`, backgroundColor: health.color }}/>
                              </div>
                              <span className="text-xs font-semibold w-16 text-right" style={{ color: health.color }}>{health.label}</span>
                            </div>
                            {method !== 'mark-at-cost' && moic !== null && (
                              <p className="text-xs font-medium" style={{ color: moic >= 1.0 ? '#10b981' : '#ef4444' }}>{moic.toFixed(2)}x MOIC</p>
                            )}
                            {method === 'mark-at-cost' && (
                              <p className="text-xs text-stone-400">at cost</p>
                            )}
                          </div>

                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="2" className="flex-shrink-0"><polyline points="9 18 15 12 9 6"/></svg>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Companies list header ─────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-medium text-stone-500 dark:text-stone-400">
            {allTrackedDeals.length} {allTrackedDeals.length === 1 ? 'company' : 'companies'} tracked
          </p>
        </div>

        {/* Search and Filters - single row like screenshot */}
        <div className="mb-5">
          <div className="flex items-center gap-3 bg-white dark:bg-stone-800 rounded-2xl p-2 border border-stone-200 dark:border-stone-700">
            <div className="flex-1 relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input 
                type="search" 
                placeholder="Search companies, sectors, founders..." 
                value={search} 
                onChange={e => setSearch(e.target.value)} 
                className="w-full bg-transparent py-2 pl-10 pr-4 text-sm text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none" 
              />
            </div>
            
            {/* Sort dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowSortDropdown(!showSortDropdown)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="18" x2="12" y2="18"/>
                </svg>
                Sort: {sortBy === 'health' ? 'Needs Attention' : sortBy === 'newest' ? 'Newest' : sortBy === 'oldest' ? 'Oldest' : sortBy === 'alphabetical' ? 'A-Z' : sortBy === 'industry' ? 'Industry' : sortBy === 'stage' ? 'Stage' : sortBy === 'deployed' ? 'Deployed' : 'Needs Attention'}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              
              {showSortDropdown && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowSortDropdown(false)} />
                  <div className="absolute right-0 top-full mt-1 bg-white dark:bg-stone-800 rounded-xl shadow-lg border border-stone-200 dark:border-stone-700 py-1 z-20 min-w-[160px]">
                    {[
                      { key: 'health', label: 'Needs Attention first', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg> },
                      { key: 'newest', label: 'Newest First', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
                      { key: 'oldest', label: 'Oldest First', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 8 14"/></svg> },
                      { key: 'alphabetical', label: 'Name (A-Z)', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/></svg> },
                      { key: 'deployed', label: 'Most Deployed', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg> },
                      { key: 'stage', label: 'Stage', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg> },
                      { key: 'industry', label: 'Industry', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg> },
                    ].map(option => (
                      <button
                        key={option.key}
                        onClick={() => { setSortBy(option.key); setShowSortDropdown(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                          sortBy === option.key 
                            ? 'bg-stone-100 dark:bg-stone-700 text-stone-900 dark:text-white font-medium' 
                            : 'text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-700/50'
                        }`}
                      >
                        {option.icon}
                        {option.label}
                        {sortBy === option.key && (
                          <svg className="ml-auto" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            
            {/* Filter pills - removed (portfolio only) */}
          </div>
        </div>

        {/* ── Two-section deal list: Invested then Watching ── */}
        {(() => {
          const investedDeals = filtered.filter(d => d.status === 'invested');
          const watchingDeals = filtered.filter(d => d.status === 'watching');
          const passedDeals   = filtered.filter(d => d.status === 'passed');
          return (
            <div className="space-y-6">
              {/* ── INVESTED ── */}
              {investedDeals.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"/>
                    <p className="text-xs font-semibold text-stone-500 dark:text-stone-400 uppercase tracking-wide">Invested · {investedDeals.length}</p>
                  </div>
                  <div className="space-y-3">
                    {investedDeals.map(deal => (
                      <InvestedCard key={deal.id} deal={deal} onClick={() => { setSelected(deal); setPage('detail'); }} />
                    ))}
                  </div>
                </div>
              )}
              {/* ── WATCHING ── */}
              {watchingDeals.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2 h-2 rounded-full bg-stone-400"/>
                    <p className="text-xs font-semibold text-stone-500 dark:text-stone-400 uppercase tracking-wide">Watching · {watchingDeals.length}</p>
                    <span className="text-xs text-stone-400 font-normal normal-case tracking-normal">— tracking but not yet invested</span>
                  </div>
                  <div className="space-y-3">
                    {watchingDeals.map(deal => (
                      <WatchingCard key={deal.id} deal={deal} onClick={() => { setSelected(deal); setPage('detail'); }} />
                    ))}
                  </div>
                </div>
              )}
              {/* ── PASSED ── */}
              {passedDeals.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2 h-2 rounded-full bg-stone-300"/>
                    <p className="text-xs font-semibold text-stone-400 uppercase tracking-wide">Passed · {passedDeals.length}</p>
                  </div>
                  <div className="space-y-2 opacity-60">
                    {passedDeals.map(deal => (
                      <WatchingCard key={deal.id} deal={deal} onClick={() => { setSelected(deal); setPage('detail'); }} />
                    ))}
                  </div>
                </div>
              )}
              {filtered.length === 0 && (
                <div className="text-center py-16">
                  <p className="text-stone-500 dark:text-stone-400 font-medium mb-1">No companies yet</p>
                  <p className="text-sm text-stone-400 dark:text-stone-500">Add your first investment or company you're tracking.</p>
                </div>
              )}
            </div>
          );
        })()}

        {/* Footer */}
        {filtered.length > 0 && (
          <div className="mt-8 text-center">
            <p className="text-sm text-stone-400 dark:text-stone-500">
              {portfolioDeals.length} {portfolioDeals.length === 1 ? 'investment' : 'investments'} · health scores update every 6h
            </p>
          </div>
        )}
      </div>

      {/* Modals */}
      {showAddPortfolio && <AddModal onClose={() => setShowAddPortfolio(false)} onAdd={addDeal} />}
      {toast && <Toast message={typeof toast === "string" ? toast : toast.message} type={typeof toast === "string" ? "success" : (toast.type || "success")} onClose={() => setToastRaw(null)} />}
    </div>
  );
}

// ============================================================================
// ROOT APP WITH PROVIDERS
// ============================================================================

const App = () => {
  const { user, isLoading, isAuthenticated, signInWithProvider, signOut } = useAuth();

  const handleLogin = async () => {
    await signInWithProvider('google');
  };

  const handleLogout = async () => {
    await signOut();
  };

  if (isLoading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafaf9' }}>
      <div style={{ width: '32px', height: '32px', border: '3px solid #e7e5e4', borderTopColor: '#5B6DC4', borderRadius: '50%', animation: 'spin 1s linear infinite' }}/>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (!isAuthenticated) return <SimpleLoginPage onLogin={handleLogin} />;

  return (
    <ConvexApp
      userMenu={<SimpleUserMenu user={user} onLogout={handleLogout} />}
      syncStatus={null}
      user={user}
    />
  );
};

// ============================================================================
// ONBOARDING FLOW (for new signups)
// ============================================================================

// Simple Login Page (standalone, no context needed)
const SimpleLoginPage = ({ onLogin }) => {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    await onLogin();
  };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(to bottom right, #fafaf9, #e7e5e4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ width: '72px', height: '72px', background: '#4A1942', borderRadius: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', boxShadow: '0 20px 40px rgba(74,25,66,.25), 0 4px 12px rgba(74,25,66,.15)' }}>
            <svg width="38" height="38" viewBox="0 0 38 38" fill="none">
              <circle cx="19" cy="19" r="4.5" fill="#F5DFA0"/>
              <line x1="19" y1="3" x2="19" y2="10" stroke="#F5DFA0" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="19" y1="28" x2="19" y2="35" stroke="#F5DFA0" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="3" y1="19" x2="10" y2="19" stroke="#F5DFA0" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="28" y1="19" x2="35" y2="19" stroke="#F5DFA0" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="7.1" y1="7.1" x2="12.1" y2="12.1" stroke="#F5DFA0" strokeWidth="1.8" strokeLinecap="round" opacity=".8"/>
              <line x1="25.9" y1="25.9" x2="30.9" y2="30.9" stroke="#F5DFA0" strokeWidth="1.8" strokeLinecap="round" opacity=".8"/>
              <line x1="30.9" y1="7.1" x2="25.9" y2="12.1" stroke="#F5DFA0" strokeWidth="1.8" strokeLinecap="round" opacity=".8"/>
              <line x1="12.1" y1="25.9" x2="7.1" y2="30.9" stroke="#F5DFA0" strokeWidth="1.8" strokeLinecap="round" opacity=".8"/>
            </svg>
          </div>
          <h1 style={{ fontSize: '28px', fontWeight: '800', color: '#1c1917', marginBottom: '6px', letterSpacing: '-0.5px' }}>Lucero</h1>
          <p style={{ color: '#78716c', fontSize: '15px' }}>Your angel portfolio, all in one place</p>
        </div>

        <div style={{ background: 'white', borderRadius: '16px', padding: '32px', border: '1px solid #e7e5e4', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
          <button
            onClick={handleClick}
            disabled={loading}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: '12px', padding: '12px 16px', borderRadius: '12px',
              border: '1px solid #d1d5db', background: 'white', color: '#374151',
              fontWeight: '500', fontSize: '15px', cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1
            }}
          >
            {loading ? (
              <div style={{ width: '20px', height: '20px', border: '2px solid #d1d5db', borderTopColor: '#374151', borderRadius: '50%', animation: 'spin 1s linear infinite' }}/>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            )}
            Continue with Google
          </button>
          <p style={{ fontSize: '12px', color: '#a8a29e', textAlign: 'center', marginTop: '16px' }}>
            Access is invite-only
          </p>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

// Simple User Menu (standalone, no context needed)
const SimpleUserMenu = ({ user, onLogout }) => {
  const [isOpen, setIsOpen] = useState(false);
  const ref = React.useRef(null);

  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setIsOpen(false); };
    if (isOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  if (!user) return null;

  const displayName = user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'User';
  const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=5B6DC4&color=fff`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 p-1.5 rounded-full hover:bg-stone-100 transition-colors"
        style={{cursor:'pointer'}}
      >
        <img src={avatarUrl} alt={displayName} className="w-8 h-8 rounded-full" />
        <span style={{fontSize:13,color:'#374151',fontWeight:500,maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{displayName.split(' ')[0]}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      {isOpen && (
        <div style={{position:'absolute',right:0,top:'calc(100% + 8px)',width:220,background:'white',borderRadius:14,boxShadow:'0 10px 25px rgba(0,0,0,.12)',border:'1px solid #e5e7eb',zIndex:999,overflow:'hidden'}}>
          <div style={{padding:'12px 16px',borderBottom:'1px solid #f3f4f6'}}>
            <p style={{fontWeight:600,fontSize:13,color:'#111827',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{displayName}</p>
            <p style={{fontSize:12,color:'#9ca3af',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user.email}</p>
          </div>
          <button
            onClick={() => { setIsOpen(false); onLogout(); }}
            style={{width:'100%',padding:'10px 16px',textAlign:'left',fontSize:13,color:'#ef4444',background:'none',border:'none',cursor:'pointer',display:'flex',alignItems:'center',gap:8}}
            onMouseEnter={e=>e.currentTarget.style.background='#fef2f2'}
            onMouseLeave={e=>e.currentTarget.style.background='none'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
