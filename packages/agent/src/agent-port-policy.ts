const DEFAULT_AGENT_PORTS = Object.freeze([7900, 7901, 7902] as const)
const MAXIMUM_ALLOWED_PORTS = 8
const MINIMUM_AGENT_PORT = 1_024
const MAXIMUM_AGENT_PORT = 65_535

function parsePort(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(value)) return null
  const port = Number(value)
  return Number.isSafeInteger(port) && port >= MINIMUM_AGENT_PORT && port <= MAXIMUM_AGENT_PORT
    ? port
    : null
}

export function resolveAllowedAgentPorts(value = process.env.XYVA_AGENT_ALLOWED_PORTS): readonly number[] {
  if (value === undefined) return DEFAULT_AGENT_PORTS
  const parts = value.split(',')
  if (parts.length === 0 || parts.length > MAXIMUM_ALLOWED_PORTS) {
    throw new Error('XYVA_AGENT_ALLOWED_PORTS is invalid')
  }
  const ports = parts.map((part) => parsePort(part))
  if (ports.some((port) => port === null)) throw new Error('XYVA_AGENT_ALLOWED_PORTS is invalid')
  const unique = [...new Set(ports as number[])]
  if (unique.length !== ports.length) throw new Error('XYVA_AGENT_ALLOWED_PORTS is invalid')
  return Object.freeze(unique)
}

export function parseAllowedAgentPort(value: unknown, allowedPorts = resolveAllowedAgentPorts()): number {
  const port = typeof value === 'string' ? parsePort(value) : null
  if (port === null || !allowedPorts.includes(port)) throw new Error('Invalid Agent port')
  return port
}

export function isAllowedAgentPort(port: unknown, allowedPorts = resolveAllowedAgentPorts()): port is number {
  return typeof port === 'number' && Number.isSafeInteger(port) && allowedPorts.includes(port)
}
