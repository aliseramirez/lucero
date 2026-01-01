import { useState, useEffect, useCallback } from 'react'
import { db } from '../lib/supabase'
import { useAuth } from './useAuth'

export function useDeals() {
  const { user, isAuthenticated } = useAuth()
  const [deals, setDeals] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [isSaving, setIsSaving] = useState(false)

  // Load deals
  const loadDeals = useCallback(async () => {
    if (!user) return
    
    setIsLoading(true)
    setError(null)
    
    try {
      const { data, error } = await db.getDeals(user.id)
      if (error) throw error
      
      // Transform data to match app format
      const transformedDeals = (data || []).map(transformDealFromDb)
      setDeals(transformedDeals)
    } catch (e) {
      console.error('Error loading deals:', e)
      setError(e.message)
    } finally {
      setIsLoading(false)
    }
  }, [user])

  // Load on mount and when user changes
  useEffect(() => {
    if (isAuthenticated) {
      loadDeals()
    } else {
      setDeals([])
      setIsLoading(false)
    }
  }, [isAuthenticated, loadDeals])

  // Create deal
  const createDeal = useCallback(async (dealData) => {
    if (!user) return { error: new Error('Not authenticated') }
    
    setIsSaving(true)
    
    try {
      const dbDeal = transformDealToDb(dealData)
      const { data, error } = await db.createDeal(user.id, dbDeal)
      if (error) throw error
      
      const newDeal = transformDealFromDb(data)
      setDeals(prev => [newDeal, ...prev])
      
      return { data: newDeal }
    } catch (e) {
      console.error('Error creating deal:', e)
      return { error: e }
    } finally {
      setIsSaving(false)
    }
  }, [user])

  // Update deal
  const updateDeal = useCallback(async (dealId, updates) => {
    setIsSaving(true)
    
    try {
      const dbUpdates = transformDealToDb(updates)
      const { data, error } = await db.updateDeal(dealId, dbUpdates)
      if (error) throw error
      
      const updatedDeal = transformDealFromDb(data)
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, ...updatedDeal } : d))
      
      return { data: updatedDeal }
    } catch (e) {
      console.error('Error updating deal:', e)
      return { error: e }
    } finally {
      setIsSaving(false)
    }
  }, [])

  // Delete deal
  const deleteDeal = useCallback(async (dealId) => {
    setIsSaving(true)
    
    try {
      const { error } = await db.deleteDeal(dealId)
      if (error) throw error
      
      setDeals(prev => prev.filter(d => d.id !== dealId))
      return { success: true }
    } catch (e) {
      console.error('Error deleting deal:', e)
      return { error: e }
    } finally {
      setIsSaving(false)
    }
  }, [])

  // Add founder
  const addFounder = useCallback(async (dealId, founder) => {
    if (!user) return { error: new Error('Not authenticated') }
    
    try {
      const { data, error } = await db.addFounder(dealId, user.id, founder)
      if (error) throw error
      
      setDeals(prev => prev.map(d => {
        if (d.id === dealId) {
          return { ...d, founders: [...(d.founders || []), data] }
        }
        return d
      }))
      
      return { data }
    } catch (e) {
      return { error: e }
    }
  }, [user])

  // Add milestone
  const addMilestone = useCallback(async (dealId, milestone) => {
    if (!user) return { error: new Error('Not authenticated') }
    
    try {
      const { data, error } = await db.addMilestone(dealId, user.id, milestone)
      if (error) throw error
      
      setDeals(prev => prev.map(d => {
        if (d.id === dealId) {
          return { ...d, milestones: [...(d.milestones || []), data] }
        }
        return d
      }))
      
      return { data }
    } catch (e) {
      return { error: e }
    }
  }, [user])

  // Get deal by ID
  const getDeal = useCallback((dealId) => {
    return deals.find(d => d.id === dealId)
  }, [deals])

  // Computed lists
  const screeningDeals = deals.filter(d => d.status === 'screening')
  const investedDeals = deals.filter(d => d.status === 'invested')
  const deferredDeals = deals.filter(d => d.status === 'deferred')
  const passedDeals = deals.filter(d => d.status === 'passed')

  return {
    deals,
    screeningDeals,
    investedDeals,
    deferredDeals,
    passedDeals,
    isLoading,
    isSaving,
    error,
    loadDeals,
    createDeal,
    updateDeal,
    deleteDeal,
    getDeal,
    addFounder,
    addMilestone
  }
}

// Transform deal from database format to app format
function transformDealFromDb(dbDeal) {
  if (!dbDeal) return null
  
  return {
    id: dbDeal.id,
    companyName: dbDeal.company_name,
    logoUrl: dbDeal.logo_url,
    website: dbDeal.website,
    industry: dbDeal.industry,
    stage: dbDeal.stage,
    status: dbDeal.status,
    statusEnteredAt: dbDeal.status_entered_at,
    engagement: dbDeal.engagement,
    needsAttention: dbDeal.needs_attention,
    source: dbDeal.source_type ? {
      type: dbDeal.source_type,
      name: dbDeal.source_name
    } : null,
    investment: dbDeal.investment_amount ? {
      amount: dbDeal.investment_amount,
      date: dbDeal.investment_date,
      vehicle: dbDeal.investment_vehicle,
      whyYes: dbDeal.investment_why_yes
    } : null,
    terms: dbDeal.terms || {},
    deferData: dbDeal.defer_type ? {
      type: dbDeal.defer_type,
      reason: dbDeal.defer_reason,
      revisitType: dbDeal.defer_revisit_type,
      revisitDetail: dbDeal.defer_revisit_detail,
      revisitDate: dbDeal.defer_revisit_date
    } : null,
    passed: dbDeal.pass_reasons ? {
      reasons: dbDeal.pass_reasons,
      whyPass: dbDeal.pass_why,
      keepTracking: dbDeal.pass_keep_tracking
    } : null,
    portfolioMetrics: dbDeal.portfolio_mrr ? {
      mrr: dbDeal.portfolio_mrr,
      mrrChange: dbDeal.portfolio_mrr_change,
      arr: dbDeal.portfolio_arr,
      headcount: dbDeal.portfolio_headcount,
      runwayMonths: dbDeal.portfolio_runway_months,
      lastContact: dbDeal.portfolio_last_contact
    } : null,
    loiDue: dbDeal.loi_due,
    notes: dbDeal.notes || [],
    workingNotes: dbDeal.working_notes || [],
    founders: dbDeal.founders || [],
    milestones: dbDeal.milestones || [],
    attachments: dbDeal.attachments || [],
    createdAt: dbDeal.created_at,
    updatedAt: dbDeal.updated_at,
    lastActivity: dbDeal.last_activity
  }
}

// Transform deal from app format to database format
function transformDealToDb(deal) {
  const dbDeal = {}
  
  if (deal.companyName !== undefined) dbDeal.company_name = deal.companyName
  if (deal.logoUrl !== undefined) dbDeal.logo_url = deal.logoUrl
  if (deal.website !== undefined) dbDeal.website = deal.website
  if (deal.industry !== undefined) dbDeal.industry = deal.industry
  if (deal.stage !== undefined) dbDeal.stage = deal.stage
  if (deal.status !== undefined) dbDeal.status = deal.status
  if (deal.statusEnteredAt !== undefined) dbDeal.status_entered_at = deal.statusEnteredAt
  if (deal.engagement !== undefined) dbDeal.engagement = deal.engagement
  if (deal.needsAttention !== undefined) dbDeal.needs_attention = deal.needsAttention
  if (deal.loiDue !== undefined) dbDeal.loi_due = deal.loiDue
  if (deal.notes !== undefined) dbDeal.notes = deal.notes
  if (deal.workingNotes !== undefined) dbDeal.working_notes = deal.workingNotes
  if (deal.terms !== undefined) dbDeal.terms = deal.terms
  
  // Source
  if (deal.source) {
    dbDeal.source_type = deal.source.type
    dbDeal.source_name = deal.source.name
  }
  
  // Investment
  if (deal.investment) {
    dbDeal.investment_amount = deal.investment.amount
    dbDeal.investment_date = deal.investment.date
    dbDeal.investment_vehicle = deal.investment.vehicle
    dbDeal.investment_why_yes = deal.investment.whyYes
  }
  
  // Defer data
  if (deal.deferData) {
    dbDeal.defer_type = deal.deferData.type
    dbDeal.defer_reason = deal.deferData.reason
    dbDeal.defer_revisit_type = deal.deferData.revisitType
    dbDeal.defer_revisit_detail = deal.deferData.revisitDetail
    dbDeal.defer_revisit_date = deal.deferData.revisitDate
  }
  
  // Pass data
  if (deal.passed) {
    dbDeal.pass_reasons = deal.passed.reasons
    dbDeal.pass_why = deal.passed.whyPass
    dbDeal.pass_keep_tracking = deal.passed.keepTracking
  }
  
  // Portfolio metrics
  if (deal.portfolioMetrics) {
    dbDeal.portfolio_mrr = deal.portfolioMetrics.mrr
    dbDeal.portfolio_mrr_change = deal.portfolioMetrics.mrrChange
    dbDeal.portfolio_arr = deal.portfolioMetrics.arr
    dbDeal.portfolio_headcount = deal.portfolioMetrics.headcount
    dbDeal.portfolio_runway_months = deal.portfolioMetrics.runwayMonths
    dbDeal.portfolio_last_contact = deal.portfolioMetrics.lastContact
  }
  
  return dbDeal
}

export default useDeals
