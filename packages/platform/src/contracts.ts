export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'
export type EntitlementState = 'active' | 'trialing' | 'suspended' | 'expired' | 'revoked'
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

/** Minimal entitlement view used by the central product switcher. */
export interface ProductAccessV1 {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly membershipRole: WorkspaceRole
  readonly productId: string
  readonly state: 'active' | 'trialing'
  readonly validUntil?: string
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

export interface StartPlatformJobRequestV1 {
  readonly workspaceId: string
  readonly productId: string
  readonly integrationId: string
  readonly capability: string
  readonly idempotencyKey: string
  readonly requestReference?: string
  readonly correlationId?: string
}

/** First product-to-product capability: Flow requests a QA Studio validation run. */
export interface QaValidationRequestV1 {
  readonly schemaVersion: 1
  readonly workspaceId: string
  readonly flowRunId: string
  readonly testPlanReference: string
  readonly environment: 'staging'
  readonly contractVersion: string
  readonly capability: 'qa.validation.run'
  readonly correlationId: string
  readonly idempotencyKey: string
}

export interface PlatformJobCommandResponseV1 {
  readonly job: PlatformJobV1
}

export interface PlatformEventV1 {
  readonly eventId: string
  readonly type: string
  readonly schemaVersion: 1
  readonly workspaceId: string
  readonly occurredAt: string
  readonly correlationId: string
}
