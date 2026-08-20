import type { ScanPreset, ScanPresetId } from '../../contracts'

export const SCAN_PRESETS: Record<ScanPresetId, ScanPreset> = {
  'quick-smoke': {
    id: 'quick-smoke',
    label: 'Quick Smoke',
    description: 'Fast surface scan - links & CTAs only. Ideal for CI.',
    agents: ['link-patrol', 'smoke-flow'],
    budgets: { maxTotalTimeMs: 60_000, maxPagesPerAgent: 5, maxScreenshots: 10, maxAiTokens: 0 },
    headless: true,
    crawlDepth: 1,
  },
  standard: {
    id: 'standard',
    label: 'Standard Scan',
    description: 'Balanced scan with all agents. Default for sprint QA.',
    agents: ['link-patrol', 'http-guard', 'a11y-scout', 'smoke-flow', 'perf-sentinel', 'seo-recon'],
    budgets: { maxTotalTimeMs: 180_000, maxPagesPerAgent: 20, maxScreenshots: 50, maxAiTokens: 10_000 },
    headless: true,
    crawlDepth: 2,
  },
  'deep-audit': {
    id: 'deep-audit',
    label: 'Deep Audit',
    description: 'Thorough crawl with full AI enrichment. For release candidates.',
    agents: ['link-patrol', 'http-guard', 'a11y-scout', 'smoke-flow', 'perf-sentinel', 'seo-recon', 'form-fuzzer', 'api-health'],
    budgets: { maxTotalTimeMs: 420_000, maxPagesPerAgent: 50, maxScreenshots: 100, maxAiTokens: 25_000 },
    headless: true,
    crawlDepth: 3,
  },
}

export const DEFAULT_PRESET_ID: ScanPresetId = 'standard'
