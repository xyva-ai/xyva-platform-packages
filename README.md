# XYVA Platform Packages

This repository is the public, historyless source home for shared XYVA npm packages.
The reviewed Alpha package chain is publicly available from npm. It is an early
compatibility surface, not a hosted service or a stable-version promise. Pin the
exact versions below; do not use an unversioned install during the Alpha.

GitHub Private Vulnerability Reporting and the Security Advisories flow described
in `SECURITY.md` are enabled for responsible disclosure.

The candidate contains five publishable workspaces:

- `@xyva/contracts` — versioned product and provider contracts.
- `@xyva/bridge-types` — shared bridge protocol types and provider client pieces.
- `@xyva/bridge-browser` — browser WebSocket transport for the bridge protocol.
- `@xyva/agent` — a local test agent.
- `@xyva/platform` — the typed client entry point for the shared XYVA platform API.

It also retains the non-published `packages/xyva-swarms` source required to build
and test the curated package closure. That directory is not an npm package and is
not a release statement.

The provider abstractions are intended to support compatible cloud and local
providers. The Agent is local software; it does not make this repository a hosted
provider or disclose service credentials.

## Authorized test use

Run the Agent only against systems you own or are explicitly authorized to test.
Deep scans can enter synthetic security-test strings into forms and may submit
those forms. Use a disposable, non-production target with test accounts and
review the selected scan preset before execution.

## Alpha packages

The immutable Alpha chain was published in dependency order:

```sh
npm install @xyva/contracts@0.1.0
npm install @xyva/bridge-types@0.1.1
npm install @xyva/bridge-browser@0.1.0
npm install @xyva/agent@0.1.13
npm install @xyva/platform@0.1.1
```

The release workflow selected the `next` channel and never selected `latest`.
For the two newly created package names, npm also exposes its required initial
`latest` alias to the same sole version. Existing `latest` aliases for
`@xyva/bridge-types` and `@xyva/agent` were not moved. Alpha consumers must use
the exact versions above or explicitly select `next`.

## Source verification

Use Node.js 22 or 24 and the exact npm version used by CI:

```sh
npm install --global npm@11.5.1
npm ci
npm run verify:public
```

Only test data and local configuration belong in a checkout. Never add
credentials, production output, customer data, or runtime logs.

## License

The repository source is licensed under [Apache-2.0](LICENSE). Package-specific
notices remain alongside each package.
