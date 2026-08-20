import type { SwarmRunHistoryEntry, SwarmRunRecord } from '@xyva/bridge-types'

import type { SwarmRun } from '../../../../xyva-swarms/src/contracts/run-events.js'

export function toBridgeSwarmRun(run: SwarmRun): SwarmRunRecord {
  return {
    id: run.id,
    targetUrl: run.targetUrl,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    duration: run.duration,
    status: run.status,
    config: run.config,
    agents: run.agents.map((agent) => ({
      agentId: agent.agentId,
      status: agent.status,
      pagesVisited: agent.pagesVisited,
      duration: agent.duration,
      findingsCount: agent.rawFindings.length,
      error: agent.error,
    })),
    findings: run.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      type: finding.type,
      severity: finding.severity,
      url: finding.url,
      pageUrl: finding.pageUrl,
      foundByAgents: finding.foundByAgents,
      plainLanguageSummary: finding.plainLanguageSummary,
      suggestedNextAction: finding.suggestedNextAction,
    })),
    summary: run.summary
      ? {
          totalFindings: run.summary.totalFindings,
          bySeverity: run.summary.bySeverity,
          byAction: run.summary.byAction,
          score: run.summary.score,
          aiEnriched: run.summary.aiEnriched,
          topIssues: run.summary.topIssues,
          plainSummary: run.summary.plainSummary,
        }
      : undefined,
    guardrailSkips: run.guardrailSkips,
  }
}

export function toBridgeSwarmHistoryEntry(run: SwarmRun): SwarmRunHistoryEntry {
  return {
    id: run.id,
    targetUrl: run.targetUrl,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    duration: run.duration,
    status: run.status,
    totalFindings: run.summary?.totalFindings ?? run.findings.length,
    criticalFindings: run.summary?.bySeverity?.critical ?? 0,
    score: typeof run.summary?.score === 'number' ? run.summary.score : null,
    presetId: run.config.presetId ?? null,
  }
}
