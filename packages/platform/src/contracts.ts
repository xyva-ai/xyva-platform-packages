export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'
export type EntitlementState = 'active' | 'suspended' | 'expired' | 'revoked'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Public, transport-safe descriptor for a registered product adapter. */
export interface ProductAdapterDescriptorV1 {
  readonly schemaVersion: 1
  readonly productId: string
  readonly adapterVersion: string
  readonly capabilities: readonly string[]
}

/** Request envelope shared by product-to-product integrations. */
export interface ProductIntegrationRequestV1 {
  readonly schemaVersion: 1
  readonly workspaceId: string
  readonly productId: string
  readonly adapterVersion: string
  readonly integrationId: string
  readonly capability: string
  readonly correlationId: string
  readonly requestId: string
}

export interface PlatformIdentityV1 {
  readonly userId: string
  readonly issuer: string
  readonly subject: string
}

export interface WorkspaceV1 {
  readonly workspaceId: string
  readonly name: string
  readonly membershipRole: WorkspaceRole
}

export interface ProductEntitlementV1 {
  readonly workspaceId: string
  readonly productId: string
  readonly capability: string
  readonly state: EntitlementState
  readonly validUntil: string | null
}

export interface IntegrationGrantV1 {
  readonly workspaceId: string
  readonly integrationId: string
  readonly version: string
  readonly scopes: readonly string[]
  readonly state: 'active' | 'revoked'
}

export interface PlatformJobV1 {
  readonly jobId: string
  readonly state: JobState
  readonly createdAt: string
  readonly correlationId: string
  readonly resultReference: string | null
}

export interface PlatformEventV1 {
  readonly eventId: string
  readonly type: string
  readonly schemaVersion: 1
  readonly workspaceId: string
  readonly occurredAt: string
  readonly correlationId: string
}
