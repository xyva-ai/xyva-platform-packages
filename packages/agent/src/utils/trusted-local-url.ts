export function isTrustedLocalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false
    }

    const host = parsed.hostname.toLowerCase()
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    const ipv4InRange = (value: string, prefix: '10' | '192.168') => {
      const parts = value.split('.').map((part) => Number.parseInt(part, 10))
      if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
        return false
      }

      if (prefix === '10') {
        return parts[0] === 10
      }

      return parts[0] === 192 && parts[1] === 168
    }

    if (host === 'localhost' || host === '127.0.0.1') {
      return true
    }

    if (host.endsWith('.home') || host.endsWith('.local')) {
      return true
    }

    if (isIpv4 && (ipv4InRange(host, '10') || ipv4InRange(host, '192.168'))) {
      return true
    }

    return false
  } catch {
    return false
  }
}
