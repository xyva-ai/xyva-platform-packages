export interface SwarmCredentialPayload {
  username: string
  password: string
}

export interface SwarmStoredCredentialsState {
  hasCredentials: boolean
}

export interface SwarmCredentialStorePort {
  save(projectPath: string, credentials: SwarmCredentialPayload): Promise<{ ok: boolean; error?: string }>
  has(projectPath: string): Promise<{ ok: boolean; hasCredentials: boolean; error?: string }>
  clear(projectPath: string): Promise<{ ok: boolean; error?: string }>
  loadPassword(projectPath: string): Promise<string | null>
}
