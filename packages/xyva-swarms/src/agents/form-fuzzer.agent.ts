import { BaseSwarmAgent } from './base-agent'

interface FormInfo {
  index: number
  action: string
  method: string
  fields: Array<{
    name: string
    type: string
    required: boolean
    selector: string
    placeholder: string
    maxLength: number | null
    pattern: string | null
  }>
  submitSelector: string | null
  hasSubmitButton: boolean
}

// Fuzzing payloads — safe, non-destructive test strings
const FUZZ_PAYLOADS = {
  empty: '',
  whitespace: '   ',
  long: 'A'.repeat(5000),
  special: '<script>alert(1)</script>',
  sqlProbe: "' OR '1'='1",
  xssBasic: '"><img src=x onerror=alert(1)>',
  unicode: '日本語テスト 🚀 ñ ü ä ö',
  negative: '-1',
  overflow: '99999999999999999999',
  email: 'not-an-email',
}

export class FormFuzzerAgent extends BaseSwarmAgent {
  async execute(targetUrl: string): Promise<void> {
    const pages = await this.discoverPages(targetUrl)

    for (const url of pages) {
      this.checkBudget()
      await this.auditForms(url)
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

  private async auditForms(url: string): Promise<void> {
    const ok = await this.safeGoto(url)
    if (!ok) return

    await this.page.waitForTimeout(1000)

    const forms = await this.discoverForms()
    if (forms.length === 0) return

    for (const form of forms) {
      this.checkBudget()

      // Test 1: Submit empty required fields
      await this.testEmptySubmit(url, form)

      // Test 2: Fuzz individual fields
      await this.fuzzFields(url, form)

      // Test 3: Check for missing error feedback
      await this.checkErrorFeedback(url, form)
    }
  }

  private async discoverForms(): Promise<FormInfo[]> {
    return this.page.evaluate(() => {
      const forms = document.querySelectorAll('form')
      return [...forms].map((form, index) => {
        const inputs = [...form.querySelectorAll('input, textarea, select')]
          .filter(el => {
            const type = (el as HTMLInputElement).type
            return type !== 'hidden' && type !== 'submit' && type !== 'button'
          })

        const fields = inputs.map((el, i) => ({
          name: (el as HTMLInputElement).name || (el as HTMLInputElement).id || `field-${i}`,
          type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
          required: (el as HTMLInputElement).required,
          selector: el.id ? `#${el.id}` : `form:nth-of-type(${index + 1}) ${el.tagName.toLowerCase()}:nth-of-type(${i + 1})`,
          placeholder: (el as HTMLInputElement).placeholder || '',
          maxLength: (el as HTMLInputElement).maxLength > 0 ? (el as HTMLInputElement).maxLength : null,
          pattern: (el as HTMLInputElement).pattern || null,
        }))

        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')

        return {
          index,
          action: form.action || '',
          method: form.method || 'GET',
          fields,
          submitSelector: submitBtn
            ? (submitBtn.id ? `#${submitBtn.id}` : `form:nth-of-type(${index + 1}) button`)
            : null,
          hasSubmitButton: !!submitBtn,
        }
      }).filter(f => f.fields.length > 0)
    })
  }

  private async testEmptySubmit(pageUrl: string, form: FormInfo): Promise<void> {
    const requiredFields = form.fields.filter(f => f.required)
    if (requiredFields.length === 0) return

    // Clear all required fields and try to submit
    for (const field of requiredFields) {
      try {
        await this.page.fill(field.selector, '', { timeout: 2000 })
      } catch { /* field may not be fillable */ }
    }

    if (form.submitSelector) {
      try {
        await this.page.click(form.submitSelector, { timeout: 3000 })
        await this.page.waitForTimeout(500)

        // Check if form was actually submitted (URL changed or network request fired)
        const newUrl = this.page.url()
        if (newUrl !== pageUrl && !newUrl.includes('#')) {
          this.addFinding({
            type: 'form-validation-issue',
            title: `Form submitted with empty required fields on ${pageUrl}`,
            description: `Form with ${requiredFields.length} required field(s) was successfully submitted without filling them. Client-side validation may be missing.`,
            url: pageUrl,
            pageUrl,
            evidence: [{ type: 'dom-snapshot', label: 'Empty Submit', data: { requiredFields: requiredFields.map(f => f.name), formAction: form.action } }],
          })

          // Navigate back for further tests
          await this.safeGoto(pageUrl)
          await this.page.waitForTimeout(1000)
        }
      } catch { /* click may fail if button is disabled — that's good */ }
    }
  }

  private async fuzzFields(pageUrl: string, form: FormInfo): Promise<void> {
    for (const field of form.fields) {
      // Only fuzz text-like inputs
      if (!['text', 'email', 'password', 'search', 'url', 'tel', 'number', 'textarea'].includes(field.type)) continue

      // Test XSS payload
      await this.testPayload(pageUrl, form, field, 'xss', FUZZ_PAYLOADS.special)

      // Test SQL injection probe
      await this.testPayload(pageUrl, form, field, 'sql', FUZZ_PAYLOADS.sqlProbe)

      // Test very long input
      if (!field.maxLength) {
        await this.testPayload(pageUrl, form, field, 'overflow', FUZZ_PAYLOADS.long)
      }

      // Test email fields with invalid email
      if (field.type === 'email') {
        await this.testPayload(pageUrl, form, field, 'invalid-email', FUZZ_PAYLOADS.email)
      }

      // Test number fields with negative/overflow
      if (field.type === 'number') {
        await this.testPayload(pageUrl, form, field, 'negative', FUZZ_PAYLOADS.negative)
        await this.testPayload(pageUrl, form, field, 'overflow', FUZZ_PAYLOADS.overflow)
      }
    }
  }

  private async testPayload(pageUrl: string, form: FormInfo, field: FormInfo['fields'][0], testName: string, payload: string): Promise<void> {
    try {
      // Reload page to reset form state
      await this.safeGoto(pageUrl)
      await this.page.waitForTimeout(500)

      // Fill the field with fuzz payload
      await this.page.fill(field.selector, payload, { timeout: 2000 })

      // Check if the page reacted badly (console errors, crashes)
      const errors: string[] = []
      const onConsole = (msg: any) => {
        if (msg.type() === 'error') errors.push(msg.text())
      }
      this.page.on('console', onConsole)

      // Submit if possible
      if (form.submitSelector) {
        try {
          await this.page.click(form.submitSelector, { timeout: 3000 })
          await this.page.waitForTimeout(1000)
        } catch { /* expected for invalid input */ }
      }

      this.page.off('console', onConsole)

      // Check for XSS reflection
      if (testName === 'xss') {
        const reflected = await this.page.evaluate((p) => {
          return document.body.innerHTML.includes(p)
        }, payload)

        if (reflected) {
          this.addFinding({
            type: 'form-validation-issue',
            title: `Potential XSS: input reflected in DOM on ${pageUrl}`,
            description: `The payload "${payload.slice(0, 40)}" entered in field "${field.name}" was reflected in the page HTML without sanitization.`,
            url: pageUrl,
            pageUrl,
            evidence: [{ type: 'dom-snapshot', label: 'XSS Reflection', data: { field: field.name, payload: payload.slice(0, 100), reflected: true } }],
          })
        }
      }

      // Check for console errors triggered by fuzzing
      if (errors.length > 0) {
        this.addFinding({
          type: 'form-validation-issue',
          title: `Console errors after fuzzing "${field.name}" on ${pageUrl}`,
          description: `Filling field "${field.name}" with ${testName} payload caused ${errors.length} console error(s). The app may not handle edge-case input gracefully.`,
          url: pageUrl,
          pageUrl,
          evidence: [{ type: 'console-log', label: 'Fuzz Errors', data: { field: field.name, testName, errors: errors.slice(0, 5) } }],
        })
      }
    } catch { /* field may not be interactable */ }
  }

  private async checkErrorFeedback(pageUrl: string, form: FormInfo): Promise<void> {
    const requiredFields = form.fields.filter(f => f.required)
    if (requiredFields.length === 0) return

    try {
      await this.safeGoto(pageUrl)
      await this.page.waitForTimeout(500)

      if (!form.submitSelector) return
      await this.page.click(form.submitSelector, { timeout: 3000 })
      await this.page.waitForTimeout(500)

      // Check if error messages are visible
      const hasVisibleErrors = await this.page.evaluate(() => {
        const errorIndicators = [
          '[role="alert"]',
          '.error', '.error-message', '.field-error',
          '.invalid-feedback', '.form-error',
          '[aria-invalid="true"]',
          ':invalid',
        ]
        for (const sel of errorIndicators) {
          try {
            if (document.querySelector(sel)) return true
          } catch { /* :invalid may throw in some contexts */ }
        }
        return false
      })

      if (!hasVisibleErrors && requiredFields.length > 0) {
        this.addFinding({
          type: 'form-validation-issue',
          title: `No visible error feedback on form submit (${pageUrl})`,
          description: `Form with ${requiredFields.length} required field(s) shows no visible error messages after empty submit. Users need clear feedback about what went wrong.`,
          url: pageUrl,
          pageUrl,
          evidence: [{ type: 'dom-snapshot', label: 'Missing Error Feedback', data: { requiredFields: requiredFields.map(f => f.name) } }],
        })
      }

      // Check if errors are accessible (ARIA)
      const hasAccessibleErrors = await this.page.evaluate(() => {
        return !!document.querySelector('[role="alert"], [aria-invalid="true"], [aria-describedby]')
      })

      if (hasVisibleErrors && !hasAccessibleErrors) {
        this.addFinding({
          type: 'form-validation-issue',
          title: `Form errors not accessible on ${pageUrl}`,
          description: 'Error messages are visible but lack ARIA attributes (role="alert", aria-invalid). Screen readers cannot announce these errors.',
          url: pageUrl,
          pageUrl,
          evidence: [{ type: 'dom-snapshot', label: 'Inaccessible Errors', data: { hasVisibleErrors: true, hasAriaErrors: false } }],
        })
      }
    } catch { /* form interaction may fail */ }
  }
}
