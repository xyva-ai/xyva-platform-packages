const PRODUCTION_ACCOUNT_ORIGINS = new Set([
  'https://xyva.ai',
  'https://www.xyva.ai',
  'https://qa.xyva.ai',
])

export type AgentProductCapability = 'qa-studio.full-bridge' | 'provider-bridge.v1'

const PRODUCTION_QA_ORIGINS = new Set([
  'https://xyva.ai',
  'https://www.xyva.ai',
  'https://qa.xyva.ai',
])

const PRODUCTION_FLOW_ORIGIN = 'https://flow.xyva.ai'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function normalizeProductOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`Invalid product origin: ${value}`)
  }

  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new TypeError(`Product origin must use HTTPS outside loopback: ${value}`)
  }
  if (
    url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.hostname.includes('*')
  ) {
    throw new TypeError(`Product origin must be an exact origin without credentials, path, query, fragment, or wildcard: ${value}`)
  }

  return url.origin
}

export function resolveAgentProductOrigins(
  portalUrl: string,
  configuredOrigins: string | readonly string[] | undefined = process.env.XYVA_AGENT_PRODUCT_ORIGINS,
  configuredQaOrigins: string | readonly string[] | undefined = process.env.XYVA_AGENT_QA_ORIGINS,
  configuredFlowOrigins: string | readonly string[] | undefined = process.env.XYVA_AGENT_FLOW_ORIGINS,
): ReadonlySet<string> {
  const portalOrigin = normalizeProductOrigin(portalUrl)
  const origins = new Set([portalOrigin])

  // This exact allowlist is the bounded apex -> QA migration path. It does not
  // authorize arbitrary xyva.ai subdomains and is not used for staging hosts.
  if (PRODUCTION_ACCOUNT_ORIGINS.has(portalOrigin)) {
    origins.add('https://qa.xyva.ai')
    origins.add(PRODUCTION_FLOW_ORIGIN)
  }

  for (const configured of [configuredOrigins, configuredQaOrigins, configuredFlowOrigins]) {
    for (const value of configuredOriginValues(configured)) origins.add(normalizeProductOrigin(value))
  }

  return origins
}

/**
 * Resolves the immutable capability profile for a browser origin. The legacy
 * XYVA_AGENT_PRODUCT_ORIGINS allowlist intentionally does not grant a profile;
 * operators must classify additional origins explicitly as QA or Flow.
 */
export function resolveAgentProductCapability(
  origin: string | null,
  portalUrl: string,
  configuredQaOrigins: string | readonly string[] | undefined = process.env.XYVA_AGENT_QA_ORIGINS,
  configuredFlowOrigins: string | readonly string[] | undefined = process.env.XYVA_AGENT_FLOW_ORIGINS,
): AgentProductCapability | null {
  if (origin === null) return 'qa-studio.full-bridge'

  let normalizedOrigin: string
  try {
    normalizedOrigin = normalizeProductOrigin(origin)
  } catch {
    return null
  }

  const portalOrigin = normalizeProductOrigin(portalUrl)
  const qaOrigins = new Set(configuredOriginValues(configuredQaOrigins).map(normalizeProductOrigin))
  const flowOrigins = new Set(configuredOriginValues(configuredFlowOrigins).map(normalizeProductOrigin))

  // The narrower Flow profile always wins, including when a user configured
  // the Flow product itself as the login portal or accidentally classified an
  // origin in both sets. A portal match must never widen Flow into QA access.
  if (normalizedOrigin === PRODUCTION_FLOW_ORIGIN || flowOrigins.has(normalizedOrigin)) {
    return 'provider-bridge.v1'
  }
  if (normalizedOrigin === portalOrigin) return 'qa-studio.full-bridge'
  if (PRODUCTION_ACCOUNT_ORIGINS.has(portalOrigin)) {
    if (PRODUCTION_QA_ORIGINS.has(normalizedOrigin)) return 'qa-studio.full-bridge'
  }

  if (qaOrigins.has(normalizedOrigin)) return 'qa-studio.full-bridge'
  return null
}

function configuredOriginValues(value: string | readonly string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : String(value || '').split(',')
  return values.map((candidate) => candidate.trim()).filter(Boolean)
}

export function isAllowedProductOrigin(
  origin: string | string[] | undefined,
  allowedOrigins: ReadonlySet<string>,
): origin is string {
  return typeof origin === 'string' && allowedOrigins.has(origin)
}
