#!/usr/bin/env node

const REPOSITORY = "xyva-ai/xyva-platform-packages"
const SENTINELS = new Map([
  ["npm-bootstrap", "xyva-npm-bootstrap-v1"],
  ["npm-publish", "xyva-npm-publish-v1"],
])

export function validatePublicNpmEnvironmentPolicy(environment, branchPolicies, { environmentName, actor } = {}) {
  const sentinel = SENTINELS.get(environmentName)
  if (!sentinel || environment?.name !== environmentName) throw new Error("GitHub Environment identity does not match npm publication authority")
  const reviewers = (environment.protection_rules ?? []).filter((rule) => rule?.type === "required_reviewers")
  const reviewerRule = reviewers.length === 1 ? reviewers[0] : null
  if (!reviewerRule || reviewerRule.prevent_self_review !== true || !Array.isArray(reviewerRule.reviewers)) {
    throw new Error("Public npm environment must require reviewers and prevent_self_review")
  }
  const normalizedActor = String(actor || "").toLowerCase()
  if (!normalizedActor || !reviewerRule.reviewers.some((entry) => entry?.type === "Team" || (entry?.type === "User" && String(entry.reviewer?.login || "").toLowerCase() !== normalizedActor))) {
    throw new Error("Public npm environment must have an independent reviewer")
  }
  if (environment.can_admins_bypass !== false) throw new Error("Public npm environment must disable administrator bypass")
  if (environment.deployment_branch_policy?.protected_branches !== false || environment.deployment_branch_policy?.custom_branch_policies !== true
    || branchPolicies?.total_count !== 1 || branchPolicies?.branch_policies?.length !== 1 || branchPolicies.branch_policies[0]?.name !== "main") {
    throw new Error("Public npm environment must allow only main")
  }
  return sentinel
}

async function main() {
  const environmentName = process.env.GITHUB_ENVIRONMENT_NAME || ""
  const guard = process.env.XYVA_NPM_ENVIRONMENT_GUARD || ""
  const token = process.env.GITHUB_TOKEN || ""
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error("Unexpected public package repository")
  if (SENTINELS.get(environmentName) !== guard) throw new Error("GitHub Environment is missing its exact sentinel")
  if (!token) throw new Error("Read-only GITHUB_TOKEN is required for environment verification")
  const base = `https://api.github.com/repos/${REPOSITORY}/environments/${encodeURIComponent(environmentName)}`
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" }
  const get = async (url) => { const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`GitHub API request failed: ${response.status}`); return response.json() }
  validatePublicNpmEnvironmentPolicy(await get(base), await get(`${base}/deployment-branch-policies?per_page=100`), { environmentName, actor: process.env.GITHUB_ACTOR })
}

if (process.argv[1]?.endsWith("verify-npm-environment-policy.mjs")) await main()
