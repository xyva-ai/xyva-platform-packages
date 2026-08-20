export interface SwarmAuthConfig {
  enabled: boolean
  loginUrl: string
  usernameSelector: string
  passwordSelector: string
  submitSelector: string
  username: string
  password?: string
  successIndicator?: string
  waitAfterLoginMs: number
}

export interface SwarmAuthConfigPersisted {
  enabled: boolean
  loginUrl: string
  usernameSelector: string
  passwordSelector: string
  submitSelector: string
  username: string
  encryptedPassword: string
  successIndicator?: string
  waitAfterLoginMs: number
}
