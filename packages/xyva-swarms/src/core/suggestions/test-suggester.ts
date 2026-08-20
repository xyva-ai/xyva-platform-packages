import type { CoverageGap, SuggestedTest, SuggestedTestType } from '../../contracts'

function priorityForType(type: SuggestedTestType): 'high' | 'medium' | 'low' {
  if (type === 'regression') return 'high'
  if (type === 'smoke' || type === 'accessibility') return 'medium'
  return 'low'
}

function hintsForGap(gap: CoverageGap) {
  const route = gap.relatedRoute || '/'
  switch (gap.suggestedTestType) {
    case 'smoke':
      return [
        { action: 'goto' as const, url: route, comment: 'Open route' },
        { action: 'expect-no-errors' as const, comment: 'No console/server errors expected' },
      ]
    case 'accessibility':
      return [
        { action: 'goto' as const, url: route, comment: 'Open route' },
        { action: 'axe-check' as const, comment: 'Run accessibility check' },
      ]
    case 'regression':
      return [
        { action: 'goto' as const, url: route, comment: 'Open route and reproduce issue path' },
        { action: 'expect-no-errors' as const, comment: 'Ensure previous regression does not reoccur' },
      ]
    case 'negative':
      return [
        { action: 'goto' as const, url: route, comment: 'Open form route' },
        { action: 'click' as const, selector: 'button[type="submit"]', comment: 'Submit empty/invalid form' },
        { action: 'expect-visible' as const, selector: '.error, [role="alert"]', comment: 'Validation must appear' },
      ]
    default:
      return [
        { action: 'goto' as const, url: route, comment: 'Open route' },
      ]
  }
}

export class TestSuggester {
  suggest(gaps: CoverageGap[], existing: SuggestedTest[] = []): SuggestedTest[] {
    const existingMap = new Map(existing.map((s) => [s.sourceGapId, s]))

    const next = gaps.map((gap) => {
      const prev = existingMap.get(gap.id)
      if (prev) {
        return {
          ...prev,
          title: gap.title,
          description: gap.description,
          confidence: gap.confidence,
          priority: priorityForType(gap.suggestedTestType),
          sourceGapId: gap.id,
          targetRoute: gap.relatedRoute,
        }
      }

      return {
        id: `suggest-${gap.id}`,
        type: gap.suggestedTestType,
        title: gap.title,
        description: gap.description,
        rationale: `${gap.type} detected with confidence ${Math.round(gap.confidence * 100)}%`,
        confidence: gap.confidence,
        priority: priorityForType(gap.suggestedTestType),
        status: 'pending' as const,
        sourceGapId: gap.id,
        sourceFindings: gap.relatedFindings,
        targetRoute: gap.relatedRoute,
        targetSelector: null,
        suggestedAt: new Date().toISOString(),
        dismissedAt: null,
        dismissReason: null,
        generatedFilePath: null,
        testSteps: hintsForGap(gap).map((h) => h.comment),
        playwrightHints: hintsForGap(gap),
      }
    })

    return next
  }
}
