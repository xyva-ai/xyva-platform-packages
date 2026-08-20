export interface SwarmSummary {
  totalFindings: number
  bySeverity: Record<string, number>
  byType: Record<string, number>
  byAgent: Record<string, number>
  byParty: Record<'first-party' | 'third-party', number>
  byAction: Record<'fix-now' | 'review' | 'monitor' | 'ignore-expected', number>
  pagesScanned: number
  aiSummary?: string
  plainSummary?: string
  runAssessment?: 'looks-good' | 'usable-with-issues' | 'serious-problems-found'
  topIssues: string[]
  score: number
  aiEnriched: boolean
}
