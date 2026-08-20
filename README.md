# XYVA Platform Packages

This repository is the public, historyless source home for shared XYVA npm packages.
The current contents are a review candidate and **are not published**. Do not rely
on them as a released package, compatibility promise, or service offer.

Before any public release, maintainers must enable GitHub Private Vulnerability
Reporting so the Security Advisories flow described in `SECURITY.md` is usable.

The candidate contains four publishable workspaces:

- `@xyva/contracts` — versioned product and provider contracts.
- `@xyva/bridge-types` — shared bridge protocol types and provider client pieces.
- `@xyva/bridge-browser` — browser WebSocket transport for the bridge protocol.
- `@xyva/agent` — a local test agent.

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

## Candidate verification

Use Node.js 22 or 24 and the exact npm version used by CI:

```sh
npm install --global npm@11.5.1
npm ci
npm run verify:public
```

Only test data and local configuration belong in a candidate checkout. Never add
credentials, production output, customer data, or runtime logs.

## License

The repository source is licensed under [Apache-2.0](LICENSE). Package-specific
notices remain alongside each package.
