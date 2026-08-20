import { URL } from 'node:url'
import type { KnowledgeExtractorInput, KnownCta, KnownFlow, KnownForm, KnownRoute, NormalizedFinding, RunKnowledge, Severity } from '../../contracts'

const severityOrder: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

function toPath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return u.pathname || '/'
  } catch {
    return rawUrl
  }
}

function toOrigin(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return u.origin
  } catch {
    return ''
  }
}

function topSeverity(findings: NormalizedFinding[]): Severity | null {
  if (!findings.length) return null
  return findings.reduce((acc, cur) => (severityOrder[cur.severity] > severityOrder[acc] ? cur.severity : acc), findings[0].severity)
}

export class KnowledgeExtractor {
  extract(input: KnowledgeExtractorInput): RunKnowledge {
    const { run } = input
    const now = new Date().toISOString()

    const routeMap = new Map<string, NormalizedFinding[]>()
    for (const finding of run.findings) {
      const p = toPath(finding.pageUrl || finding.url)
      const arr = routeMap.get(p) || []
      arr.push(finding)
      routeMap.set(p, arr)
    }

    const routes: KnownRoute[] = [...routeMap.entries()].map(([path, findings]) => {
      const sample = findings[0]
      const hasForm = findings.some((f) => f.type === 'form-error')
      const hasCta = findings.some((f) => f.type === 'blocked-flow')
      return {
        url: sample.pageUrl || sample.url,
        path,
        origin: toOrigin(sample.pageUrl || sample.url),
        firstSeenRunId: run.id,
        lastSeenRunId: run.id,
        firstSeenAt: run.startedAt,
        lastSeenAt: run.completedAt || now,
        visitCount: 1,
        lastStatus: findings.some((f) => ['http-error', 'network-failure', 'broken-link'].includes(f.type)) ? 'error' : 'ok',
        findingCount: findings.length,
        highestSeverity: topSeverity(findings),
        hasForm,
        hasCta,
        isAuthGated: /login|signin|auth/i.test(path) || findings.some((f) => /auth|login/i.test(f.title)),
        stabilityScore: findings.some((f) => ['critical', 'high'].includes(f.severity)) ? 0.5 : 1,
        tags: [
          ...(hasForm ? ['form'] : []),
          ...(hasCta ? ['cta'] : []),
          ...(findings.some((f) => ['critical', 'high'].includes(f.severity)) ? ['error-prone'] : []),
        ],
      }
    })

    const forms: KnownForm[] = run.findings
      .filter((f) => f.type === 'form-error')
      .map((f) => ({
        id: `form-${toPath(f.pageUrl)}-${String(f.selector || 'submit').replace(/[^a-z0-9]+/gi, '-')}`,
        pageUrl: f.pageUrl,
        pagePath: toPath(f.pageUrl),
        action: 'unknown',
        method: 'unknown',
        fields: [],
        hasSubmitButton: true,
        submitSelector: f.selector || null,
        lastTestedRunId: run.id,
        lastTestedAt: run.completedAt || now,
        lastResult: 'error',
        errorCount: 1,
        firstSeenRunId: run.id,
      }))

    const ctas: KnownCta[] = run.findings
      .filter((f) => f.type === 'blocked-flow')
      .map((f) => ({
        id: `cta-${toPath(f.pageUrl)}-${String(f.selector || f.title).replace(/[^a-z0-9]+/gi, '-')}`,
        pageUrl: f.pageUrl,
        pagePath: toPath(f.pageUrl),
        selector: f.selector || 'unknown',
        text: f.title,
        tagName: 'button',
        href: null,
        lastTestedRunId: run.id,
        lastTestedAt: run.completedAt || now,
        lastResult: 'error',
        errorCount: 1,
        firstSeenRunId: run.id,
      }))

    const flows: KnownFlow[] = []
    for (const finding of run.findings) {
      if (finding.url && finding.pageUrl && finding.url !== finding.pageUrl) {
        const fromPath = toPath(finding.pageUrl)
        const toPathValue = toPath(finding.url)
        flows.push({
          id: `flow-${fromPath}->${toPathValue}`,
          fromPath,
          toPath: toPathValue,
          fromUrl: finding.pageUrl,
          toUrl: finding.url,
          discoveredByAgent: finding.foundByAgents[0],
          firstSeenRunId: run.id,
          lastSeenRunId: run.id,
          traversalCount: 1,
          hasErrors: ['critical', 'high'].includes(finding.severity),
        })
      }
    }

    const hotspots = [...new Set(run.findings.filter((f) => ['critical', 'high'].includes(f.severity)).map((f) => toPath(f.pageUrl || f.url)))]

    return {
      runId: run.id,
      extractedAt: now,
      routes,
      forms,
      ctas,
      flows,
      hotspots,
    }
  }
}
