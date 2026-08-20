import type { KnownCta, KnownFlow, KnownForm, KnownRoute, RiskArea, RunKnowledge, SwarmKnowledgeSnapshot } from '../../contracts'

function mergeById<T extends { id: string }>(base: T[], incoming: T[], merge: (a: T, b: T) => T): T[] {
  const map = new Map<string, T>()
  for (const item of base) map.set(item.id, item)
  for (const item of incoming) {
    const existing = map.get(item.id)
    map.set(item.id, existing ? merge(existing, item) : item)
  }
  return [...map.values()]
}

function mergeRoutes(base: KnownRoute[], incoming: KnownRoute[]): KnownRoute[] {
  const map = new Map<string, KnownRoute>()
  for (const route of base) map.set(route.url, route)
  for (const route of incoming) {
    const existing = map.get(route.url)
    if (!existing) {
      map.set(route.url, route)
      continue
    }
    map.set(route.url, {
      ...existing,
      lastSeenRunId: route.lastSeenRunId,
      lastSeenAt: route.lastSeenAt,
      visitCount: existing.visitCount + 1,
      findingCount: existing.findingCount + route.findingCount,
      highestSeverity: route.highestSeverity || existing.highestSeverity,
      hasForm: existing.hasForm || route.hasForm,
      hasCta: existing.hasCta || route.hasCta,
      isAuthGated: existing.isAuthGated || route.isAuthGated,
      stabilityScore: Math.max(0, Math.min(1, (existing.stabilityScore + route.stabilityScore) / 2)),
      tags: [...new Set([...(existing.tags || []), ...(route.tags || [])])],
    })
  }
  return [...map.values()]
}

function buildRiskAreas(routes: KnownRoute[], run: RunKnowledge): RiskArea[] {
  return run.hotspots.map((path) => {
    const route = routes.find((r) => r.path === path)
    return {
      id: `risk-${path}`,
      path,
      url: route?.url || path,
      riskLevel: route?.highestSeverity === 'critical' ? 'critical' : 'high',
      reason: 'recurring-errors',
      findingFingerprints: [],
      affectedRuns: [run.runId],
      firstDetectedAt: run.extractedAt,
      lastDetectedAt: run.extractedAt,
      isRegression: false,
    }
  })
}

export class KnowledgeAggregator {
  createInitialSnapshot(projectPath: string): SwarmKnowledgeSnapshot {
    return {
      version: 1,
      projectPath,
      generatedAt: new Date().toISOString(),
      lastRunId: '',
      totalRunsAnalyzed: 0,
      routes: [],
      forms: [],
      ctas: [],
      flows: [],
      riskAreas: [],
      coverageGaps: [],
      suggestedTests: [],
      stats: {
        totalRoutes: 0,
        totalForms: 0,
        totalCtas: 0,
        totalFlows: 0,
        totalRiskAreas: 0,
        totalGaps: 0,
        totalSuggestions: 0,
        overallCoverageEstimate: 0,
      },
    }
  }

  update(snapshot: SwarmKnowledgeSnapshot, runKnowledge: RunKnowledge): SwarmKnowledgeSnapshot {
    const routes = mergeRoutes(snapshot.routes, runKnowledge.routes)
    const forms = mergeById<KnownForm>(snapshot.forms, runKnowledge.forms, (a, b) => ({
      ...a,
      lastTestedRunId: b.lastTestedRunId,
      lastTestedAt: b.lastTestedAt,
      lastResult: b.lastResult,
      errorCount: a.errorCount + b.errorCount,
    }))
    const ctas = mergeById<KnownCta>(snapshot.ctas, runKnowledge.ctas, (a, b) => ({
      ...a,
      lastTestedRunId: b.lastTestedRunId,
      lastTestedAt: b.lastTestedAt,
      lastResult: b.lastResult,
      errorCount: a.errorCount + b.errorCount,
    }))
    const flows = mergeById<KnownFlow>(snapshot.flows, runKnowledge.flows, (a, b) => ({
      ...a,
      lastSeenRunId: b.lastSeenRunId,
      traversalCount: a.traversalCount + b.traversalCount,
      hasErrors: a.hasErrors || b.hasErrors,
    }))

    const riskAreaMap = new Map<string, RiskArea>()
    for (const area of snapshot.riskAreas) riskAreaMap.set(area.id, area)
    for (const area of buildRiskAreas(routes, runKnowledge)) {
      const existing = riskAreaMap.get(area.id)
      if (!existing) {
        riskAreaMap.set(area.id, area)
      } else {
        riskAreaMap.set(area.id, {
          ...existing,
          lastDetectedAt: runKnowledge.extractedAt,
          affectedRuns: [...new Set([...existing.affectedRuns, runKnowledge.runId])],
        })
      }
    }

    const next: SwarmKnowledgeSnapshot = {
      ...snapshot,
      generatedAt: new Date().toISOString(),
      lastRunId: runKnowledge.runId,
      totalRunsAnalyzed: snapshot.totalRunsAnalyzed + 1,
      routes: routes.slice(0, 200),
      forms: forms.slice(0, 50),
      ctas: ctas.slice(0, 100),
      flows: flows.slice(0, 200),
      riskAreas: [...riskAreaMap.values()].slice(0, 100),
    }

    next.stats = {
      ...next.stats,
      totalRoutes: next.routes.length,
      totalForms: next.forms.length,
      totalCtas: next.ctas.length,
      totalFlows: next.flows.length,
      totalRiskAreas: next.riskAreas.length,
    }

    return next
  }
}
