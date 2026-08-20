# Contributing

This is a curated public package source repository. Keep changes narrow,
reviewable, and compatible with Apache-2.0 distribution.

Before opening a pull request, use a clean Node.js 22 or 24 checkout and run:

```sh
npm install --global npm@11.5.1
npm ci
npm run verify:public
```

Do not commit secrets, credentials, private keys, customer data, production
artifacts, runtime logs, personal filesystem paths, or operational infrastructure
details. Use synthetic fixtures and redact issue or pull-request descriptions.

Changes that alter package surfaces, dependency provenance, release metadata, or
provider behavior require a maintainer review. Do not publish packages from a
fork or pull request.
