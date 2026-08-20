// @vitest-environment node

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { resolvePlaywrightCli } from "../../packages/agent/src/bootstrap.js"
import { resolvePlaywrightPackagePath } from "../../packages/agent/src/readiness.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("agent Playwright readiness resolution", () => {
  it("resolves the selected project's own Playwright CLI", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xyva-agent-project-cli-"))
    temporaryDirectories.push(root)
    const projectPath = path.join(root, "project")
    const cliPath = path.join(projectPath, "node_modules", "playwright", "cli.js")
    fs.mkdirSync(path.dirname(cliPath), { recursive: true })
    fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({ name: "fixture" }))
    fs.writeFileSync(path.join(projectPath, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright", main: "index.js" }))
    fs.writeFileSync(path.join(projectPath, "node_modules", "playwright", "index.js"), "")
    fs.writeFileSync(cliPath, "")

    expect(fs.realpathSync(resolvePlaywrightCli(projectPath)!)).toBe(fs.realpathSync(cliPath))
  })

  it("finds Playwright when npm hoists it beside the scoped agent package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xyva-agent-hoisted-"))
    temporaryDirectories.push(root)
    const agentModule = path.join(root, "node_modules", "@xyva", "agent", "dist", "index.js")
    const playwrightPackage = path.join(root, "node_modules", "playwright", "package.json")
    fs.mkdirSync(path.dirname(agentModule), { recursive: true })
    fs.mkdirSync(path.dirname(playwrightPackage), { recursive: true })
    fs.writeFileSync(agentModule, "")
    fs.writeFileSync(playwrightPackage, JSON.stringify({ name: "playwright", version: "1.58.0" }))

    expect(fs.realpathSync(resolvePlaywrightPackagePath(null, pathToFileURL(agentModule).href)!))
      .toBe(fs.realpathSync(playwrightPackage))
  })

  it("falls back to a project-local Playwright package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xyva-agent-project-"))
    temporaryDirectories.push(root)
    const isolatedAgentModule = path.join(root, "agent", "dist", "index.js")
    const projectPath = path.join(root, "project")
    const playwrightPackage = path.join(projectPath, "node_modules", "playwright", "package.json")
    fs.mkdirSync(path.dirname(isolatedAgentModule), { recursive: true })
    fs.mkdirSync(path.dirname(playwrightPackage), { recursive: true })
    fs.writeFileSync(isolatedAgentModule, "")
    fs.writeFileSync(playwrightPackage, JSON.stringify({ name: "playwright", version: "1.58.0" }))

    expect(fs.realpathSync(resolvePlaywrightPackagePath(projectPath, pathToFileURL(isolatedAgentModule).href)!))
      .toBe(fs.realpathSync(playwrightPackage))
  })
})
