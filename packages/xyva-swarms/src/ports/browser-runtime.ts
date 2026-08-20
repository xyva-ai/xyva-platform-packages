export interface SwarmBrowserLaunchOptions {
  headless: boolean
}

export interface SwarmBrowserContextOptions {
  storageState?: unknown
}

export interface SwarmBrowserPageHandle {}

export interface SwarmBrowserContextHandle {
  newPage(): Promise<SwarmBrowserPageHandle>
  close(): Promise<void>
}

export interface SwarmBrowserHandle {
  newContext(options: SwarmBrowserContextOptions): Promise<SwarmBrowserContextHandle>
  close(): Promise<void>
}

export interface SwarmBrowserRuntimePort {
  launch(options: SwarmBrowserLaunchOptions): Promise<SwarmBrowserHandle>
}
