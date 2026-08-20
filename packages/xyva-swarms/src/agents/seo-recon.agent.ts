import { BaseSwarmAgent } from './base-agent'

interface SeoMeta {
  title: string | null
  titleLength: number
  description: string | null
  descriptionLength: number
  canonical: string | null
  ogTitle: string | null
  ogDescription: string | null
  ogImage: string | null
  robots: string | null
  h1Count: number
  h1Text: string | null
  lang: string | null
  hasViewport: boolean
  hasCharset: boolean
  structuredData: number
  imgWithoutAlt: number
  totalImages: number
}

export class SeoReconAgent extends BaseSwarmAgent {
  private checkedRobots = false
  private checkedSitemap = false
  private seenTitles = new Map<string, string[]>()

  async execute(targetUrl: string): Promise<void> {
    const origin = new URL(targetUrl).origin

    // Check robots.txt and sitemap first
    await this.checkRobotsTxt(origin)
    await this.checkSitemap(origin)

    // Crawl pages
    const pages = await this.discoverPages(targetUrl)
    for (const url of pages) {
      this.checkBudget()
      await this.auditPage(url)
    }

    // Check for duplicate titles
    this.checkDuplicateTitles()
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

  private async checkRobotsTxt(origin: string): Promise<void> {
    if (this.checkedRobots) return
    this.checkedRobots = true

    try {
      const resp = await fetch(`${origin}/robots.txt`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XYVA-QA/1.0)' },
      })

      if (!resp.ok) {
        this.addFinding({
          type: 'seo-issue',
          title: 'Missing robots.txt',
          description: `No robots.txt found at ${origin}/robots.txt (HTTP ${resp.status}). Search engines need this to understand crawl rules.`,
          url: `${origin}/robots.txt`,
          pageUrl: origin,
          evidence: [{ type: 'seo-meta', label: 'robots.txt', data: { status: resp.status, exists: false } }],
        })
      }
    } catch {
      this.addFinding({
        type: 'seo-issue',
        title: 'robots.txt unreachable',
        description: `Could not fetch ${origin}/robots.txt.`,
        url: `${origin}/robots.txt`,
        pageUrl: origin,
        evidence: [],
      })
    }
  }

  private async checkSitemap(origin: string): Promise<void> {
    if (this.checkedSitemap) return
    this.checkedSitemap = true

    try {
      const resp = await fetch(`${origin}/sitemap.xml`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XYVA-QA/1.0)' },
      })

      if (!resp.ok) {
        this.addFinding({
          type: 'seo-issue',
          title: 'Missing sitemap.xml',
          description: `No sitemap.xml found at ${origin}/sitemap.xml. A sitemap helps search engines discover and index all pages.`,
          url: `${origin}/sitemap.xml`,
          pageUrl: origin,
          evidence: [{ type: 'seo-meta', label: 'sitemap.xml', data: { status: resp.status, exists: false } }],
        })
      }
    } catch { /* ignore timeout */ }
  }

  private async auditPage(url: string): Promise<void> {
    const ok = await this.safeGoto(url)
    if (!ok) return

    await this.page.waitForTimeout(1000)

    const meta = await this.extractMeta()

    // Track title for duplicate check
    if (meta.title) {
      const existing = this.seenTitles.get(meta.title) || []
      existing.push(url)
      this.seenTitles.set(meta.title, existing)
    }

    // Missing or bad title
    if (!meta.title || meta.titleLength === 0) {
      this.addFinding({
        type: 'seo-issue',
        title: `Missing <title> on ${url}`,
        description: 'Page has no title tag. This is critical for SEO — every page needs a unique, descriptive title.',
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'title', data: { title: null } }],
      })
    } else if (meta.titleLength < 10) {
      this.addFinding({
        type: 'seo-issue',
        title: `Title too short (${meta.titleLength} chars) on ${url}`,
        description: `Title "${meta.title}" is only ${meta.titleLength} characters. Recommended: 30-60 characters.`,
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'title', data: { title: meta.title, length: meta.titleLength } }],
      })
    } else if (meta.titleLength > 60) {
      this.addFinding({
        type: 'seo-issue',
        title: `Title too long (${meta.titleLength} chars) on ${url}`,
        description: `Title will be truncated in search results. Current: ${meta.titleLength} chars. Recommended: 30-60 characters.`,
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'title', data: { title: meta.title, length: meta.titleLength } }],
      })
    }

    // Missing meta description
    if (!meta.description || meta.descriptionLength === 0) {
      this.addFinding({
        type: 'seo-issue',
        title: `Missing meta description on ${url}`,
        description: 'No meta description tag found. Search engines use this as the snippet in results.',
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'description', data: { description: null } }],
      })
    } else if (meta.descriptionLength > 160) {
      this.addFinding({
        type: 'seo-issue',
        title: `Meta description too long (${meta.descriptionLength} chars) on ${url}`,
        description: `Description will be truncated. Current: ${meta.descriptionLength} chars. Recommended: 120-160 characters.`,
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'description', data: { description: meta.description?.slice(0, 200), length: meta.descriptionLength } }],
      })
    }

    // Missing Open Graph
    if (!meta.ogTitle && !meta.ogDescription && !meta.ogImage) {
      this.addFinding({
        type: 'seo-issue',
        title: `Missing Open Graph tags on ${url}`,
        description: 'No og:title, og:description, or og:image found. Social media shares will look generic without these.',
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'Open Graph', data: { ogTitle: null, ogDescription: null, ogImage: null } }],
      })
    }

    // Missing canonical
    if (!meta.canonical) {
      this.addFinding({
        type: 'seo-issue',
        title: `Missing canonical URL on ${url}`,
        description: 'No <link rel="canonical"> found. This can cause duplicate content issues in search engines.',
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'canonical', data: { canonical: null } }],
      })
    }

    // H1 issues
    if (meta.h1Count === 0) {
      this.addFinding({
        type: 'seo-issue',
        title: `Missing H1 heading on ${url}`,
        description: 'No <h1> element found. Every page should have exactly one H1 describing the main content.',
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'H1', data: { h1Count: 0 } }],
      })
    } else if (meta.h1Count > 1) {
      this.addFinding({
        type: 'seo-issue',
        title: `Multiple H1 headings (${meta.h1Count}) on ${url}`,
        description: `Found ${meta.h1Count} H1 elements. Best practice is exactly one H1 per page.`,
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'H1', data: { h1Count: meta.h1Count, h1Text: meta.h1Text } }],
      })
    }

    // Missing lang attribute
    if (!meta.lang) {
      this.addFinding({
        type: 'seo-issue',
        title: `Missing lang attribute on ${url}`,
        description: 'The <html> element has no lang attribute. This helps search engines and screen readers determine the page language.',
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'lang', data: { lang: null } }],
      })
    }

    // Images without alt
    if (meta.imgWithoutAlt > 0) {
      this.addFinding({
        type: 'seo-issue',
        title: `${meta.imgWithoutAlt} image(s) without alt text on ${url}`,
        description: `${meta.imgWithoutAlt} of ${meta.totalImages} images lack alt attributes. Alt text improves SEO and accessibility.`,
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'img alt', data: { withoutAlt: meta.imgWithoutAlt, total: meta.totalImages } }],
      })
    }

    // No structured data
    if (meta.structuredData === 0) {
      this.addFinding({
        type: 'seo-issue',
        title: `No structured data on ${url}`,
        description: 'No JSON-LD or microdata found. Structured data enables rich snippets in search results.',
        url, pageUrl: url,
        evidence: [{ type: 'seo-meta', label: 'Structured Data', data: { count: 0 } }],
      })
    }
  }

  private async extractMeta(): Promise<SeoMeta> {
    return this.page.evaluate(() => {
      const getMeta = (name: string) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)
        return el?.getAttribute('content') || null
      }
      const title = document.title || null
      const description = getMeta('description')
      const h1s = document.querySelectorAll('h1')
      const imgs = document.querySelectorAll('img')
      const imgWithoutAlt = [...imgs].filter(i => !i.getAttribute('alt')?.trim()).length
      const structuredData = document.querySelectorAll('script[type="application/ld+json"]').length

      return {
        title,
        titleLength: title?.length || 0,
        description,
        descriptionLength: description?.length || 0,
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || null,
        ogTitle: getMeta('og:title'),
        ogDescription: getMeta('og:description'),
        ogImage: getMeta('og:image'),
        robots: getMeta('robots'),
        h1Count: h1s.length,
        h1Text: h1s[0]?.textContent?.trim()?.slice(0, 100) || null,
        lang: document.documentElement.lang || null,
        hasViewport: !!document.querySelector('meta[name="viewport"]'),
        hasCharset: !!document.querySelector('meta[charset]'),
        structuredData,
        imgWithoutAlt,
        totalImages: imgs.length,
      }
    })
  }

  private checkDuplicateTitles(): void {
    for (const [title, urls] of this.seenTitles) {
      if (urls.length > 1) {
        this.addFinding({
          type: 'seo-issue',
          title: `Duplicate title across ${urls.length} pages: "${title.slice(0, 60)}"`,
          description: `The title "${title}" appears on: ${urls.join(', ')}. Each page needs a unique title.`,
          url: urls[0],
          pageUrl: urls[0],
          evidence: [{ type: 'seo-meta', label: 'Duplicate Title', data: { title, urls } }],
        })
      }
    }
  }
}
