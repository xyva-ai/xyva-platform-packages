#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

const run = (command, args) => {
  execFileSync(command, args, { stdio: "inherit" })
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
run(npm, ["run", "verify:public"])
run("git", ["diff", "--check"])

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const lockfileSha256 = createHash("sha256")
  .update(readFileSync("package-lock.json"))
  .digest("hex")
const artifactDir = "artifacts/platform-packages"
mkdirSync(artifactDir, { recursive: true })

const packages = ["contracts", "bridge-types", "bridge-browser", "agent", "platform"]
const tarballs = []
for (const packageName of packages) {
  run(npm, ["pack", "--workspace", `@xyva/${packageName}`, "--pack-destination", artifactDir, "--ignore-scripts"])
  const manifest = JSON.parse(readFileSync(`packages/${packageName}/package.json`, "utf8"))
  const filename = `${manifest.name.replace(/^@/u, "").replace("/", "-")}-${manifest.version}.tgz`
  const file = `${artifactDir}/${filename}`
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex")
  tarballs.push({ name: manifest.name, version: manifest.version, file, sha256 })
}

writeFileSync(`${artifactDir}/SHA256SUMS`, `${tarballs.map(({ file, sha256 }) => `${sha256}  ${file}`).join("\n")}\n`)
writeFileSync(`${artifactDir}/package-lock.sha256`, `${lockfileSha256}  package-lock.json\n`)
writeFileSync(`${artifactDir}/commit.txt`, `${commit}\n`)
writeFileSync(
  `${artifactDir}/platform-packages-gates.json`,
  `${JSON.stringify({
    gate: "platform-packages",
    status: "passed",
    sourceCommit: commit,
    packageLockSha256: lockfileSha256,
    packages: tarballs,
  }, null, 2)}\n`,
)

console.log(`Platform package gates passed for ${commit}`)
