const ALLOWED_EXTERNAL_HOSTS = new Set([
  'xyva.ai',
  'www.xyva.ai',
  'github.com',
  'www.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'docs.github.com',
  'learn.microsoft.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'openai.com',
  'platform.openai.com',
  'nodejs.org',
  'www.nodejs.org',
  'playwright.dev',
  'www.playwright.dev',
  'cypress.io',
  'www.cypress.io',
  'docs.cypress.io',
  'youtrack.cloud',
  'www.youtrack.cloud',
])

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') {
      return false
    }

    return ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}
