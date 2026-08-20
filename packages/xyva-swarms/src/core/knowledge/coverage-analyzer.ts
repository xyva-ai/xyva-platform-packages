import type { CoverageAnalyzerInput, CoverageGap, Severity } from '../../contracts'

function pathTokens(path: string): string[] {
  return path.toLowerCase().split('/').filter(Boolean)
}

function findMatchingTests(path: string, tests: Array<{ file: string; tests: string[]; content?: string }>): string[] {
  const tokens = pathTokens(path)
  return tests
    .filter((t) => {
      const haystack = `${t.file} ${t.tests.join(' ')} ${t.content || ''}`.toLowerCase()
      return tokens.some((token) => token.length > 2 && haystack.includes(token))
    })
    .map((t) => t.file)
}

function nowIso(): string {
  return new Date().toISOString()
}

export class CoverageAnalyzer {
  analyze(input: CoverageAnalyzerInput): CoverageGap[] {
    const { snapshot, tests } = input
    const gaps: CoverageGap[] = []

    for (const route of snapshot.routes) {
      const matched = findMatchingTests(route.path, tests)
      if (matched.length === 0) {
        gaps.push({
          id: `gap-route-${route.path}`,
          type: 'untested-route',
          title: `Route ${route.path} has no test`,
          description: `No matching test file references the discovered route ${route.path}`,
          severity: route.highestSeverity || 'medium',
          confidence: 0.7,
          relatedRoute: route.path,
          relatedFindings: [],
          matchedTestFiles: [],
          suggestedTestType: 'smoke',
          detectedAt: nowIso(),
          acknowledged: false,
        })
      }
    }

    for (const form of snapshot.forms) {
      const matched = findMatchingTests(form.pagePath, tests)
      if (matched.length === 0) {
        gaps.push({
          id: `gap-form-${form.id}`,
          type: 'untested-form',
          title: `Form on ${form.pagePath} has no test`,
          description: `No test appears to cover the detected form on ${form.pagePath}`,
          severity: form.errorCount > 0 ? 'high' : ('medium' as Severity),
          confidence: 0.6,
          relatedRoute: form.pagePath,
          relatedFindings: [],
          matchedTestFiles: [],
          suggestedTestType: form.errorCount > 0 ? 'negative' : 'e2e',
          detectedAt: nowIso(),
          acknowledged: false,
        })
      }
    }

    for (const route of snapshot.routes) {
      if (route.highestSeverity && ['critical', 'high'].includes(route.highestSeverity)) {
        const matched = findMatchingTests(route.path, tests)
        if (matched.length === 0) {
          gaps.push({
            id: `gap-regression-${route.path}`,
            type: 'missing-regression-test',
            title: `High-risk route ${route.path} has no regression test`,
            description: `Route ${route.path} repeatedly surfaced high severity issues without dedicated tests.`,
            severity: 'high',
            confidence: 0.8,
            relatedRoute: route.path,
            relatedFindings: [],
            matchedTestFiles: [],
            suggestedTestType: 'regression',
            detectedAt: nowIso(),
            acknowledged: false,
          })
        }
      }
    }

    return gaps
  }
}
