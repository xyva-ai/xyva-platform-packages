#!/usr/bin/env bash
set -euo pipefail

# Publish the reviewed immutable chain idempotently. A prior interrupted run
# may have published a prefix of the chain; an existing version is accepted
# only when the registry's immutable shasum matches the exact local tarball.
publish_if_missing() {
  local package_name="$1"
  local package_version="$2"
  local tarball="$3"
  local published_version published_shasum local_shasum

  if published_version="$(npm view "${package_name}@${package_version}" version --registry=https://registry.npmjs.org 2>/dev/null)"; then
    test "$published_version" = "$package_version"
    published_shasum="$(npm view "${package_name}@${package_version}" dist.shasum --registry=https://registry.npmjs.org)"
    local_shasum="$(sha1sum "$tarball" | awk '{print $1}')"
    test "$published_shasum" = "$local_shasum"
    echo "already-published-and-matching ${package_name}@${package_version}"
    return
  fi

  npm publish "$tarball" --tag next --ignore-scripts
}

sha256sum --check SHA256SUMS
publish_if_missing @xyva/contracts 0.1.0 xyva-contracts-0.1.0.tgz
publish_if_missing @xyva/bridge-types 0.1.1 xyva-bridge-types-0.1.1.tgz
publish_if_missing @xyva/bridge-browser 0.1.0 xyva-bridge-browser-0.1.0.tgz
publish_if_missing @xyva/agent 0.1.13 xyva-agent-0.1.13.tgz
publish_if_missing @xyva/platform 0.1.1 xyva-platform-0.1.1.tgz
