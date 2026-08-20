export interface Transport {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  subscribe(channel: string, callback: (data: unknown) => void): () => void
  readonly connected: boolean
  onStatusChange(callback: (connected: boolean) => void): () => void
  connect(url: string, token: string): void
  disconnect(): void
}
