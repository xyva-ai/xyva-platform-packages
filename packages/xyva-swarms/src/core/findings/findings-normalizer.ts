import { randomUUID } from 'node:crypto'

import type { NormalizedFinding, RawFinding, Severity, SwarmAgentId } from '../../contracts'

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

export function mapRawFindingSeverity(finding: RawFinding): Severity {
  // Explicit axe impact mapping (a11y)
  if (finding.axeImpact) {
    switch (finding.axeImpact) {
      case 'critical': return 'critical'
      case 'serious': return 'high'
      case 'moderate': return 'medium'
      case 'minor': return 'low'
    }
  }

  // HTTP status based
  if (finding.statusCode) {
    if (finding.statusCode >= 500) return 'high'
    if (finding.statusCode >= 400) return 'medium'
  }

  // Type-based defaults
  switch (finding.type) {
    case 'http-error': return 'medium'
    case 'network-failure': return 'high'
    case 'console-error': return 'low'
    case 'a11y-violation': return 'medium'
    case 'blocked-flow': return 'critical'
    case 'form-error': return 'high'
    case 'form-validation-issue': return 'medium'
    case 'broken-link': return 'medium'
    case 'redirect-chain': return 'low'
    case 'slow-response': return 'low'
    case 'inconclusive-link': return 'info'
    case 'perf-issue': return 'low'
    case 'seo-issue': return 'low'
    case 'api-health-issue': return 'medium'
  }

  return 'info'
}

function deriveActionCategory(severity: Severity, party: 'first-party' | 'third-party'): 'fix-now' | 'review' | 'monitor' | 'ignore-expected' {
  if (party === 'third-party') return 'monitor'
  switch (severity) {
    case 'critical':
    case 'high': return 'fix-now'
    case 'medium': return 'review'
    case 'low': return 'monitor'
    default: return 'ignore-expected'
  }
}

function deriveCategory(type: string): string {
  if (type.includes('http') || type.includes('network') || type === 'api-health-issue') return 'network'
  if (type.includes('a11y')) return 'accessibility'
  if (type.includes('form')) return 'forms'
  if (type.includes('link') || type.includes('redirect')) return 'navigation'
  if (type.includes('perf') || type === 'slow-response') return 'performance'
  if (type.includes('seo')) return 'seo'
  if (type === 'console-error') return 'javascript'
  if (type === 'blocked-flow') return 'ux-flow'
  return 'other'
}

export class FindingsNormalizer {
  private targetOrigin: string

  constructor(targetUrl?: string) {
    try {
      this.targetOrigin = new URL(targetUrl || '').origin
    } catch {
      this.targetOrigin = ''
    }
  }

  private isFirstParty(url: string): boolean {
    if (!this.targetOrigin) return true
    try {
      return new URL(url).origin === this.targetOrigin
    } catch {
      return true
    }
  }

  normalize(raw: RawFinding[], sourceAgentIds: SwarmAgentId[]): NormalizedFinding[] {
    const out: NormalizedFinding[] = raw.map((finding) => {
      const severity = mapRawFindingSeverity(finding)
      const party = this.isFirstParty(finding.url || finding.pageUrl) ? 'first-party' : 'third-party'
      const actionCategory = deriveActionCategory(severity, party)
      let hostname = ''
      try { hostname = new URL(finding.url || finding.pageUrl).hostname } catch { /* */ }

      const fingerprint = `${finding.type}|${finding.url ?? ''}|${finding.selector ?? ''}|${finding.title}`

      const normalized: NormalizedFinding = {
        id: randomUUID(),
        type: finding.type,
        category: deriveCategory(finding.type),
        fingerprint,
        party,
        hostname,
        groupedCount: 1,
        protectedResource: false,
        actionCategory,
        severity,
        confidence: finding.needsManualCheck ? 0.6 : 0.9,
        needsReview: finding.needsManualCheck ?? false,
        title: finding.title,
        description: finding.description || finding.title,
        url: finding.url,
        pageUrl: finding.pageUrl || finding.url,
        selector: finding.selector,
        element: finding.element,
        foundByAgents: [...sourceAgentIds],
        timestamp: new Date().toISOString(),
        reproducible: true,
        evidence: finding.evidence ?? [],
        sourceEvidenceSummary: (finding.evidence ?? []).map(e => e.label).join(', ') || finding.title,
        wcagCriteria: finding.wcagCriteria,
        axeRuleId: finding.axeRuleId,
      }

      return normalized
    })

    return this.dedupe(out).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  }

  dedupe(findings: NormalizedFinding[]): NormalizedFinding[] {
    const map = new Map<string, NormalizedFinding>()
    for (const finding of findings) {
      const key = finding.fingerprint || `${finding.type}|${finding.url ?? ''}|${finding.selector ?? ''}|${finding.title}`
      const existing = map.get(key)
      if (!existing) {
        map.set(key, finding)
        continue
      }

      const merged: NormalizedFinding = {
        ...existing,
        foundByAgents: Array.from(new Set([...existing.foundByAgents, ...finding.foundByAgents])),
        evidence: [...existing.evidence, ...finding.evidence].slice(0, 10),
        groupedCount: existing.groupedCount + 1,
      }

      if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[existing.severity]) {
        merged.severity = finding.severity
      }

      map.set(key, merged)
    }

    return [...map.values()]
  }
}
