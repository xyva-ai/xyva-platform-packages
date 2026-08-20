// @vitest-environment node

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = path.resolve(__dirname, "..", "..")
const agentDist = path.join(repoRoot, "packages", "agent", "dist", "cli.js")
const tempHomes: string[] = []

afterEach(() => {
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

describe("agent CLI authentication gate", () => {
  it("refuses to start before login instead of creating local credentials", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "xyva-agent-no-login-"))
    tempHomes.push(tempHome)

    const result = await runAgent(["start", "--no-banner"], {
      HOME: tempHome,
      USERPROFILE: tempHome,
    })

    expect(result.code).toBe(1)
    expect(result.output).toContain("npx @xyva/agent login")
    expect(fs.existsSync(path.join(tempHome, ".xyva", "credentials.json"))).toBe(false)
  })

  it("supports environment credentials for disposable CI machines", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "xyva-agent-env-login-"))
    tempHomes.push(tempHome)

    const result = await runAgent(["login", "--portal-url", "http://127.0.0.1:1"], {
      HOME: tempHome,
      USERPROFILE: tempHome,
      XYVA_AGENT_TOKEN: "ci-secret-token",
      XYVA_AGENT_EMAIL: "windows-gate@xyva.example",
    })

    expect(result.code).toBe(0)
    expect(result.output).toContain("Logged in as windows-gate@xyva.example")
    expect(result.output).not.toContain("ci-secret-token")

    const credentials = JSON.parse(
      fs.readFileSync(path.join(tempHome, ".xyva", "credentials.json"), "utf8"),
    )
    expect(credentials).toMatchObject({
      email: "windows-gate@xyva.example",
      portalUrl: "http://127.0.0.1:1",
      version: 2,
    })
    expect(credentials.token).toMatch(/^sealed:v1:/)
    expect(fs.readFileSync(path.join(tempHome, ".xyva", "credentials.json"), "utf8")).not.toContain("ci-secret-token")
    expect(fs.statSync(path.join(tempHome, ".xyva", "credentials.json")).mode & 0o777).toBe(0o600)
  })
})

function runAgent(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [agentDist, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk.toString() })
    child.stderr.on("data", (chunk) => { output += chunk.toString() })
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code, output }))
  })
}
