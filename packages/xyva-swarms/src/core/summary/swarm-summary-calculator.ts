import type { AgentResult, NormalizedFinding, Severity, SwarmSummary } from '../../contracts'

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export class SwarmSummaryCalculator {
  generateSummary(findings: NormalizedFinding[], agents: AgentResult[], aiEnriched: boolean): SwarmSummary {
    const bySeverity: Record<string, number> = {}
    const byType: Record<string, number> = {}
    const byAgent: Record<string, number> = {}
    const byParty: Record<'first-party' | 'third-party', number> = { 'first-party': 0, 'third-party': 0 }
    const byAction: Record<'fix-now' | 'review' | 'monitor' | 'ignore-expected', number> = {
      'fix-now': 0,
      review: 0,
      monitor: 0,
      'ignore-expected': 0,
    }

    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
      byType[f.type] = (byType[f.type] ?? 0) + 1
      byParty[f.party] = (byParty[f.party] ?? 0) + 1
      byAction[f.actionCategory] = (byAction[f.actionCategory] ?? 0) + 1
      for (const a of f.foundByAgents) {
        byAgent[a] = (byAgent[a] ?? 0) + 1
      }
    }

    const pagesScanned = agents.reduce((sum, a) => sum + a.pagesVisited, 0)
    const score = this.calculateScore(findings)
    const runAssessment = this.deriveAssessment(findings)

    return {
      totalFindings: findings.length,
      bySeverity,
      byType,
      byAgent,
      byParty,
      byAction,
      pagesScanned,
      aiSummary: undefined,
      plainSummary: this.createPlainSummary(findings, byParty, runAssessment),
      runAssessment,
      topIssues: findings
        .slice()
        .sort((a, b) => {
          if (a.party !== b.party) return a.party === 'first-party' ? -1 : 1
          return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
        })
        .slice(0, 3)
        .map(f => f.title),
      score,
      aiEnriched,
    }
  }

  private calculateScore(findings: NormalizedFinding[]): number {
    let penalty = 0

    for (const f of findings) {
      const base = this.baseSeverityPenalty(f.severity)
      const multiplier = f.party === 'third-party' ? 0.35 : 1
      const confidenceFactor = Math.max(0.5, Math.min(1, f.confidence))
      const groupedFactor = 1 + Math.min(0.8, Math.log10(Math.max(1, f.groupedCount)))
      const protectedFactor = f.protectedResource ? 0.2 : 1
      const inconclusiveFactor = f.type === 'inconclusive-link' ? 0.2 : 1

      penalty += base * multiplier * confidenceFactor * groupedFactor * protectedFactor * inconclusiveFactor
    }

    return Math.max(0, Math.round(100 - penalty))
  }

  private baseSeverityPenalty(severity: Severity): number {
    switch (severity) {
      case 'critical': return 18
      case 'high': return 9
      case 'medium': return 4
      case 'low': return 1.5
      default: return 0.5
    }
  }

  private deriveAssessment(findings: NormalizedFinding[]): 'looks-good' | 'usable-with-issues' | 'serious-problems-found' {
    const firstPartyCritical = findings.filter((f) => f.party === 'first-party' && f.severity === 'critical').length
    const firstPartyHigh = findings.filter((f) => f.party === 'first-party' && f.severity === 'high').length

    if (firstPartyCritical > 0 || firstPartyHigh >= 3) return 'serious-problems-found'
    if (firstPartyHigh > 0 || findings.length > 0) return 'usable-with-issues'
    return 'looks-good'
  }

  private createPlainSummary(
    findings: NormalizedFinding[],
    byParty: Record<'first-party' | 'third-party', number>,
    assessment: 'looks-good' | 'usable-with-issues' | 'serious-problems-found',
  ): string {
    const actionCounts = findings.reduce((acc, f) => {
      acc[f.actionCategory] = (acc[f.actionCategory] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
    const topType = Object.entries(findings.reduce((acc, f) => {
      acc[f.type] = (acc[f.type] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)).sort((a, b) => b[1] - a[1])[0]?.[0]

    const firstParty = byParty['first-party'] || 0
    const thirdParty = byParty['third-party'] || 0

    if (assessment === 'looks-good') {
      return 'No major first-party issues were detected. The scanned pages look stable in this run.'
    }

    return `Detected ${firstParty} first-party issue(s) and ${thirdParty} external issue(s). Fix now: ${actionCounts['fix-now'] ?? 0}, review: ${actionCounts.review ?? 0}, monitor: ${actionCounts.monitor ?? 0}. Most frequent category: ${topType ?? 'n/a'}. Overall status: ${assessment.replace(/-/g, ' ')}.`
  }
}
