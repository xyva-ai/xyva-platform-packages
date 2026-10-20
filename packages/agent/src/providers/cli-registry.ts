import { createCliAdapters } from './cli-adapters.js'
import type { CliDiscoveryStatus, CliProviderAdapter, CliProviderId } from './cli-types.js'

/** Product-neutral registry. It exposes status only; it grants no product access. */
export class CliAdapterRegistry {
  readonly #adapters: ReadonlyMap<CliProviderId, CliProviderAdapter>

  public constructor(adapters: ReadonlyMap<CliProviderId, CliProviderAdapter> = createCliAdapters()) {
    this.#adapters = adapters
  }

  public async status(): Promise<CliDiscoveryStatus[]> {
    return Promise.all([...this.#adapters.values()].map((adapter) => adapter.discover()))
  }

  public get(providerId: CliProviderId): CliProviderAdapter | undefined { return this.#adapters.get(providerId) }
}
