export function shouldAllowPortalPrivateNetworkAccess(
  origin: string | string[] | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  return typeof origin === 'string' && allowedOrigins.has(origin)
}
