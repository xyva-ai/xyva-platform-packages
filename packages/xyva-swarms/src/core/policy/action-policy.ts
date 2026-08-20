import type { ActionDecision, RiskLevel } from '../../contracts'

const FORBIDDEN_PATTERNS = [
  /\b(delete|remove|loeschen|löschen|entfernen)\b/i,
  /\b(logout|abmelden|sign.?out|log.?out)\b/i,
  /\b(konto|account).{0,10}(loeschen|löschen|delet)/i,
  /\b(bezahlen|pay now|purchase|bestellen.*verbindlich)\b/i,
  /\b(stornieren|cancel.{0,5}order|kuendigen|kündigen)\b/i,
]

export interface ElementInfo {
  tagName: string
  text: string
  type?: string
  href?: string
  classList?: string[]
  formAction?: string
}

export function classifyAction(el: ElementInfo): ActionDecision {
  const blob = `${el.text} ${el.formAction ?? ''} ${(el.classList ?? []).join(' ')}`

  for (const p of FORBIDDEN_PATTERNS) {
    if (p.test(blob)) {
      return { allowed: false, riskLevel: 4, reason: `Forbidden pattern: ${p.source}` }
    }
  }

  if ((el.classList ?? []).includes('btn-danger')) {
    return { allowed: false, riskLevel: 4, reason: 'btn-danger class' }
  }

  if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript:')) {
    return { allowed: true, riskLevel: 1, reason: 'Navigation link' }
  }

  if (el.type === 'submit') {
    return { allowed: true, riskLevel: 3, reason: 'Form submit' }
  }

  if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') {
    return { allowed: true, riskLevel: 2, reason: 'Interactive element' }
  }

  return { allowed: true, riskLevel: 0, reason: 'Safe read action' }
}

const AGENT_MAX_RISK: Record<string, RiskLevel> = {
  'link-patrol': 1,
  'http-guard': 0,
  'a11y-scout': 1,
  'smoke-flow': 3,
}

export function isAllowedForAgent(agentId: string, decision: ActionDecision): boolean {
  const max = AGENT_MAX_RISK[agentId] ?? 0
  return decision.allowed && decision.riskLevel <= max
}
