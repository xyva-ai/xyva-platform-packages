import { BaseSwarmAgent } from './base-agent'

interface WebVitals {
  lcp: number | null
  cls: number | null
  fid: number | null
  ttfb: number | null
  domContentLoaded: number | null
  fullyLoaded: number | null
}

const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  ttfb: { good: 800, poor: 1800 },
  domContentLoaded: { good: 3000, poor: 6000 },
  fullyLoaded: { good: 5000, poor: 10000 },
}

export class PerfSentinelAgent extends BaseSwarmAgent {
  async execute(targetUrl: string): Promise<void> {
    const pages = await this.discoverPages(targetUrl)

    for (const url of pages) {
      this.checkBudget()
      await this.auditPerformance(url)
    }
  }

  private async discoverPages(startUrl: string): Promise<string[]> {
    await this.safeGoto(startUrl)
    const origin = new URL(startUrl).origin
    const links = await this.page.evaluate((o) => {
      return [...new Set(
        [...document.querySelectorAll('a[href]')]
          .map(a => (a as HTMLAnchorElement).href)
          .filter(h => h.startsWith(o)),
      )].slice(0, 15)
    }, origin)

    return [startUrl, ...links.slice(0, this.budgets.maxPagesPerAgent - 1)]
  }

  private async auditPerformance(url: string): Promise<void> {
    const startTime = Date.now()
    const ok = await this.safeGoto(url)
    if (!ok) return

    // Wait for page to settle
    await this.page.waitForTimeout(2000)

    const vitals = await this.measureVitals()
    const loadTime = Date.now() - startTime
    const resources = await this.analyzeResources(url)

    // Check LCP
    if (vitals.lcp !== null && vitals.lcp > THRESHOLDS.lcp.good) {
      const severity = vitals.lcp > THRESHOLDS.lcp.poor ? 'high' : 'medium'
      this.addFinding({
        type: 'perf-issue',
        title: `Slow LCP: ${Math.round(vitals.lcp)}ms on ${url}`,
        description: `Largest Contentful Paint is ${Math.round(vitals.lcp)}ms (threshold: ${THRESHOLDS.lcp.good}ms). This impacts Core Web Vitals and SEO ranking.`,
        url,
        pageUrl: url,
        evidence: [{ type: 'perf-metric', label: 'LCP', data: { metric: 'LCP', value: vitals.lcp, threshold: THRESHOLDS.lcp.good, unit: 'ms' } }],
      })
    }

    // Check CLS
    if (vitals.cls !== null && vitals.cls > THRESHOLDS.cls.good) {
      const severity = vitals.cls > THRESHOLDS.cls.poor ? 'high' : 'medium'
      this.addFinding({
        type: 'perf-issue',
        title: `High CLS: ${vitals.cls.toFixed(3)} on ${url}`,
        description: `Cumulative Layout Shift is ${vitals.cls.toFixed(3)} (threshold: ${THRESHOLDS.cls.good}). Elements are shifting after load, causing poor UX.`,
        url,
        pageUrl: url,
        evidence: [{ type: 'perf-metric', label: 'CLS', data: { metric: 'CLS', value: vitals.cls, threshold: THRESHOLDS.cls.good, unit: 'score' } }],
      })
    }

    // Check TTFB
    if (vitals.ttfb !== null && vitals.ttfb > THRESHOLDS.ttfb.good) {
      this.addFinding({
        type: 'perf-issue',
        title: `Slow TTFB: ${Math.round(vitals.ttfb)}ms on ${url}`,
        description: `Time to First Byte is ${Math.round(vitals.ttfb)}ms (threshold: ${THRESHOLDS.ttfb.good}ms). Server response is slow.`,
        url,
        pageUrl: url,
        evidence: [{ type: 'perf-metric', label: 'TTFB', data: { metric: 'TTFB', value: vitals.ttfb, threshold: THRESHOLDS.ttfb.good, unit: 'ms' } }],
      })
    }

    // Check total load time
    if (loadTime > THRESHOLDS.fullyLoaded.good) {
      this.addFinding({
        type: 'slow-response',
        title: `Slow page load: ${Math.round(loadTime)}ms on ${url}`,
        description: `Total load time is ${Math.round(loadTime)}ms. Pages should load within ${THRESHOLDS.fullyLoaded.good / 1000}s for good UX.`,
        url,
        pageUrl: url,
        evidence: [{ type: 'perf-metric', label: 'Load Time', data: { metric: 'totalLoad', value: loadTime, threshold: THRESHOLDS.fullyLoaded.good, unit: 'ms' } }],
      })
    }

    // Check large resources
    for (const res of resources) {
      if (res.sizeKB > 500 && res.type === 'image') {
        this.addFinding({
          type: 'perf-issue',
          title: `Large image: ${res.name} (${Math.round(res.sizeKB)}KB)`,
          description: `Image ${res.url} is ${Math.round(res.sizeKB)}KB. Consider compressing or using WebP/AVIF format.`,
          url: res.url,
          pageUrl: url,
          evidence: [{ type: 'perf-metric', label: 'Resource Size', data: { resource: res.url, size: res.sizeKB, type: 'image', unit: 'KB' } }],
        })
      }
      if (res.sizeKB > 300 && (res.type === 'script' || res.type === 'stylesheet')) {
        this.addFinding({
          type: 'perf-issue',
          title: `Large ${res.type}: ${res.name} (${Math.round(res.sizeKB)}KB)`,
          description: `${res.type === 'script' ? 'JavaScript' : 'CSS'} bundle ${res.url} is ${Math.round(res.sizeKB)}KB. Consider code splitting or lazy loading.`,
          url: res.url,
          pageUrl: url,
          evidence: [{ type: 'perf-metric', label: 'Bundle Size', data: { resource: res.url, size: res.sizeKB, type: res.type, unit: 'KB' } }],
        })
      }
    }
  }

  private async measureVitals(): Promise<WebVitals> {
    return this.page.evaluate(() => {
      const vitals: any = { lcp: null, cls: null, fid: null, ttfb: null, domContentLoaded: null, fullyLoaded: null }

      try {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
        if (nav) {
          vitals.ttfb = nav.responseStart - nav.requestStart
          vitals.domContentLoaded = nav.domContentLoadedEventEnd - nav.startTime
          vitals.fullyLoaded = nav.loadEventEnd - nav.startTime
        }
      } catch {}

      try {
        const lcpEntries = performance.getEntriesByType('largest-contentful-paint')
        if (lcpEntries.length > 0) {
          vitals.lcp = lcpEntries[lcpEntries.length - 1].startTime
        }
      } catch {}

      try {
        const clsEntries = performance.getEntriesByType('layout-shift') as any[]
        let clsScore = 0
        for (const entry of clsEntries) {
          if (!entry.hadRecentInput) clsScore += entry.value
        }
        vitals.cls = clsScore
      } catch {}

      return vitals
    })
  }

  private async analyzeResources(pageUrl: string): Promise<Array<{ url: string; name: string; sizeKB: number; type: string }>> {
    return this.page.evaluate(() => {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      return entries
        .filter(e => e.transferSize > 0)
        .map(e => {
          const url = e.name
          const name = url.split('/').pop()?.split('?')[0] || url
          const sizeKB = e.transferSize / 1024
          let type = 'other'
          if (e.initiatorType === 'img' || /\.(png|jpg|jpeg|gif|webp|avif|svg|ico)(\?|$)/i.test(url)) type = 'image'
          else if (e.initiatorType === 'script' || /\.js(\?|$)/i.test(url)) type = 'script'
          else if (e.initiatorType === 'css' || /\.css(\?|$)/i.test(url)) type = 'stylesheet'
          else if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) type = 'font'
          return { url, name, sizeKB, type }
        })
        .filter(r => r.sizeKB > 50)
        .sort((a, b) => b.sizeKB - a.sizeKB)
        .slice(0, 20)
    })
  }
}
