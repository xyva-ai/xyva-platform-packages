import { BaseSwarmAgent } from './base-agent'

export class SmokeFlowAgent extends BaseSwarmAgent {
  async execute(targetUrl: string): Promise<void> {
    await this.safeGoto(targetUrl)

    const ctas = await this.page.evaluate(() => {
      const buildStableSelector = (el: Element, fallbackIndex: number): string => {
        const id = (el as HTMLElement).id
        if (id) return `#${CSS.escape(id)}`

        const testId = el.getAttribute('data-testid')
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`

        const name = el.getAttribute('name')
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`

        const aria = el.getAttribute('aria-label')
        if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`

        const parts: string[] = []
        let curr: Element | null = el
        while (curr && curr.parentElement) {
          const tag = curr.tagName.toLowerCase()
          const siblings = [...curr.parentElement.children].filter((c) => c.tagName === curr!.tagName)
          const idx = siblings.indexOf(curr) + 1
          parts.unshift(`${tag}:nth-of-type(${idx})`)
          curr = curr.parentElement
          if (curr.tagName.toLowerCase() === 'body') break
        }
        if (parts.length > 0) return parts.join(' > ')
        return `${el.tagName.toLowerCase()}:nth-of-type(${fallbackIndex + 1})`
      }

      const elements = [
        ...document.querySelectorAll('button, a[role="button"], [data-testid], input[type="submit"], .cta, .btn-primary'),
      ]
      return elements.slice(0, 15).map((el, i) => ({
        index: i,
        selector: buildStableSelector(el, i),
        text: (el as HTMLElement).innerText?.trim().slice(0, 80) ?? '',
        tagName: el.tagName,
        type: (el as HTMLInputElement).type ?? undefined,
        href: (el as HTMLAnchorElement).href ?? undefined,
        classList: [...el.classList],
      }))
    })

    for (const cta of ctas) {
      this.checkBudget()
      await this.testCta(targetUrl, cta)
    }

    await this.testForms(targetUrl)
  }

  private async testCta(originUrl: string, cta: any): Promise<void> {
    await this.safeGoto(originUrl)

    const clicked = await this.safeClick(cta.selector)
    if (!clicked) return

    await this.page.waitForTimeout(2000)

    const urlAfter = this.page.url()
    const hasNetworkError = await this.checkForErrors()

    if (hasNetworkError) {
      const shot = await this.screenshot(`cta-error-${cta.index}`)
      this.addFinding({
        type: 'blocked-flow',
        title: `CTA '${cta.text}' triggers error`,
        description: `Clicking '${cta.text}' caused a network error or server error`,
        url: urlAfter,
        pageUrl: originUrl,
        selector: cta.selector,
        element: `<${String(cta.tagName).toLowerCase()}>${cta.text}</${String(cta.tagName).toLowerCase()}>`,
        flowBlocked: true,
        flowType: 'primary',
        evidence: [
          ...(shot ? [shot] : []),
          { type: 'dom-snapshot', label: 'CTA element', data: cta },
        ],
      })
    }
  }

  private async testForms(startUrl: string): Promise<void> {
    await this.safeGoto(startUrl)

    const origin = new URL(startUrl).origin
    const formPages = await this.page.evaluate((o) => {
      const links = [...document.querySelectorAll('a[href]')]
        .map(a => (a as HTMLAnchorElement).href)
        .filter(h => h.startsWith(o))
      return [...new Set(links)].slice(0, 5)
    }, origin)

    for (const pageUrl of [startUrl, ...formPages]) {
      this.checkBudget()
      await this.safeGoto(pageUrl)

      const hasForms = await this.page.evaluate(() => document.querySelectorAll('form').length > 0)
      if (!hasForms) continue

      await this.page.evaluate(() => {
        document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])').forEach((input, i) => {
          const el = input as HTMLInputElement
          if (el.type === 'email') el.value = 'test@example.com'
          else el.value = `TestData${i}`
          el.dispatchEvent(new Event('input', { bubbles: true }))
        })
        document.querySelectorAll('textarea').forEach((ta) => {
          ;(ta as HTMLTextAreaElement).value = 'Test comment'
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        })
      })

      const clicked = await this.safeClick('button[type="submit"], input[type="submit"], form button:last-of-type')
      if (!clicked) continue

      await this.page.waitForTimeout(3000)
      const hasError = await this.checkForErrors()

      if (hasError) {
        const shot = await this.screenshot(`form-error-${pageUrl.split('/').pop() ?? 'page'}`)
        this.addFinding({
          type: 'form-error',
          title: `Form submission error on ${pageUrl}`,
          description: `Form submit on ${pageUrl} resulted in an error response`,
          url: pageUrl,
          pageUrl,
          flowBlocked: true,
          flowType: 'secondary',
          evidence: shot ? [shot] : [],
        })
      }
    }
  }

  private async checkForErrors(): Promise<boolean> {
    return this.page.evaluate(() => {
      const text = (document.body?.innerText ?? '').toLowerCase()
      const hasErrorText =
        /\binternal server error\b/i.test(text) ||
        /\bserver error\b/i.test(text) ||
        /\bhttp\s*500\b/i.test(text) ||
        /\b500\s+(error|fehler)\b/i.test(text)
      if (hasErrorText) return true
      if (document.querySelector('.error, .error-page, [data-error]')) return true
      if (document.querySelector('[role="alert"], [aria-live="assertive"], .alert-danger, .server-error')) return true
      const title = (document.title ?? '').toLowerCase()
      if (/\b(500|error|fehler)\b/.test(title)) return true
      return false
    })
  }
}
