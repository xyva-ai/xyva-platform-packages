import AxeBuilder from '@axe-core/playwright'
import { BaseSwarmAgent } from './base-agent'

export class A11yScoutAgent extends BaseSwarmAgent {
  async execute(targetUrl: string): Promise<void> {
    const pagesToAudit = await this.discoverPages(targetUrl)

    for (const url of pagesToAudit) {
      this.checkBudget()
      await this.auditPage(url)
    }
  }

  private async discoverPages(startUrl: string): Promise<string[]> {
    await this.safeGoto(startUrl)
    const origin = new URL(startUrl).origin
    const links = await this.page.evaluate((o) =>
      [...new Set(
        [...document.querySelectorAll('a[href]')]
          .map(a => (a as HTMLAnchorElement).href)
          .filter(h => h.startsWith(o)),
      )].slice(0, 6), origin)
    return [startUrl, ...links.slice(0, this.budgets.maxPagesPerAgent - 1)]
  }

  private async auditPage(url: string): Promise<void> {
    await this.safeGoto(url)

    try {
      const results = await new AxeBuilder({ page: this.page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      for (const v of results.violations) {
        for (const node of v.nodes) {
          this.addFinding({
            type: 'a11y-violation',
            title: `${v.impact}: ${v.id} - ${v.help}`,
            description: v.description,
            url,
            pageUrl: url,
            selector: node.target?.[0] as string | undefined,
            element: node.html?.slice(0, 200),
            axeImpact: v.impact as any,
            axeRuleId: v.id,
            wcagCriteria: v.tags?.find((t: string) => t.startsWith('wcag'))?.replace('wcag', '') ?? undefined,
            evidence: [{
              type: 'axe-result',
              label: v.id,
              data: { impact: v.impact, target: node.target, html: node.html?.slice(0, 300) },
            }],
          })
        }
      }
    } catch {
      // continue with manual checks
    }

    const headingIssues = await this.page.evaluate(() => {
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      const issues: string[] = []
      for (let i = 1; i < headings.length; i++) {
        const prev = Number.parseInt(headings[i - 1].tagName[1], 10)
        const curr = Number.parseInt(headings[i].tagName[1], 10)
        if (curr > prev + 1) issues.push(`${headings[i - 1].tagName}->${headings[i].tagName}`)
      }
      return issues
    })

    for (const issue of headingIssues) {
      const [from, to] = issue.split('->')
      this.addFinding({
        type: 'a11y-violation',
        title: `Heading skip: ${issue}`,
        description: `Heading hierarchy jumps from ${from} to ${to}`,
        url,
        pageUrl: url,
        axeImpact: 'minor',
        wcagCriteria: '1.3.1',
        evidence: [{ type: 'dom-snapshot', label: 'Heading order', data: { skip: issue } }],
      })
    }

    const missingAlts = await this.page.evaluate(() =>
      [...document.querySelectorAll('img:not([alt])')].map(img => ({
        src: (img as HTMLImageElement).src?.slice(0, 200),
        selector: img.closest('[id]')?.id ? `#${img.closest('[id]')!.id} img` : 'img',
      })),
    )

    if (missingAlts.length > 0) {
      this.addFinding({
        type: 'a11y-violation',
        title: `${missingAlts.length} images without alt text`,
        description: `Found ${missingAlts.length} <img> elements without alt attribute`,
        url,
        pageUrl: url,
        axeImpact: 'serious',
        wcagCriteria: '1.1.1',
        evidence: [{ type: 'dom-snapshot', label: 'Missing alts', data: { count: missingAlts.length, samples: missingAlts.slice(0, 5) } }],
      })
    }
  }
}
