# @xyva/bridge-browser

Browser-only WebSocket transport for the versioned XYVA bridge protocol.

The package authenticates the socket before accepting calls, correlates pending
responses, enforces bounded call timeouts, forwards generic bridge events and
isolates reconnect work by connection generation. Replacing or disconnecting a
socket rejects every pending call so stale owners cannot receive later results.

```ts
import { WsTransport } from '@xyva/bridge-browser'

const transport = new WsTransport()
transport.connect(productBridgeUrl, sessionToken, refreshSessionToken)

transport.onStatusChange((connected) => {
  if (connected) void transport.call('status')
})
```

The session token is supplied by the product at runtime and is only used for the
bridge authentication frame. This package contains no provider adapters,
product methods, pairing or UI logic, embedded credentials, endpoint defaults,
or Node runtime imports.

Runtime dependency versions are exact so the protocol implementation cannot
silently drift from `@xyva/bridge-types`.
