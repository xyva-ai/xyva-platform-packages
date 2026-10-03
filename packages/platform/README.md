# @xyva/platform

Typed, dependency-free client contracts for the XYVA platform API.

The package contains typed workspace reads and tenant-bound job commands. It
contains no credentials, product data access, billing webhooks, agent runtime
or browser automation. Product authorization remains server-side.

```ts
import { createPlatformClient } from '@xyva/platform'

const platform = createPlatformClient({ baseUrl: 'https://api.xyva.ai' })
const workspaces = await platform.listWorkspaces()
```
