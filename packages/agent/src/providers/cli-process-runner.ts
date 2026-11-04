import { spawn } from 'node:child_process'
import path from 'node:path'

import type { CliProcessResult, CliProcessRunner } from './cli-types.js'

function boundedCollector(limit: number): { append(chunk: Buffer): boolean; value(): string } {
  const chunks: Buffer[] = []
  let length = 0
  return {
    append(chunk) {
      if (length >= limit) return true
      const bounded = chunk.subarray(0, Math.max(0, limit - length))
      chunks.push(bounded)
      length += bounded.length
      return chunk.length > bounded.length
    },
    value: () => Buffer.concat(chunks).toString('utf8'),
  }
}

/** Runs an allowlisted executable without a shell and enforces output/lifetime limits. */
export class SpawnCliProcessRunner implements CliProcessRunner {
  public async run(input: Parameters<CliProcessRunner['run']>[0]): Promise<CliProcessResult> {
    return new Promise((resolve) => {
      if (input.signal?.aborted) { resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true }); return }
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
      const stdout = boundedCollector(input.maxStdoutBytes ?? input.maxOutputBytes ?? 0)
      const stderr = boundedCollector(input.maxStderrBytes ?? input.maxOutputBytes ?? 0)
      let settled = false
      let timedOut = false
      let cancelled = false
      let outputLimitExceeded = false
      let killTimer: NodeJS.Timeout | undefined
      const terminate = (reason: 'timeout' | 'cancel' | 'output_limit') => {
        if (settled || timedOut || cancelled || outputLimitExceeded) return
        if (reason === 'timeout') timedOut = true
        else if (reason === 'cancel') cancelled = true
        else outputLimitExceeded = true
        this.terminateProcess(child.pid, false)
        killTimer = setTimeout(() => this.terminateProcess(child.pid, true), 2_000)
        killTimer.unref()
      }
      const timeout = setTimeout(() => terminate('timeout'), input.timeoutMs)
      const onAbort = () => terminate('cancel')
      const finish = (exitCode: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        input.signal?.removeEventListener('abort', onAbort)
        resolve({ exitCode, stdout: stdout.value(), stderr: stderr.value(), timedOut, cancelled, outputLimitExceeded })
      }
      input.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => { if (stdout.append(chunk)) terminate('output_limit') })
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.append(chunk)) terminate('output_limit') })
      child.on('error', () => finish(1))
      child.on('close', (code) => finish(code))
      if (input.stdin) child.stdin.end(input.stdin)
      else child.stdin.end()
    })
  }

  private terminateProcess(pid: number | undefined, force: boolean): void {
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe')
        spawn(taskkill, ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], { shell: false, stdio: 'ignore', windowsHide: true })
      } else {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
      }
    } catch { /* process exited between lifecycle checks */ }
  }
}
