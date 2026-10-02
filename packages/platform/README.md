# @xyva/platform

Typed, dependency-free client contracts for the XYVA platform API.

The package is intentionally read-only in its first release. It contains no
credentials, product data access, billing webhooks, agent runtime or browser
automation. Product authorization remains server-side.

```ts
import { createPlatformClient } from '@xyva/platform'

const platform = createPlatformClient({ baseUrl: 'https://api.xyva.ai' })
const workspaces = await platform.listWorkspaces()
```
