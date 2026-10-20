import { spawn } from 'node:child_process'

import type { CliProcessResult, CliProcessRunner } from './cli-types.js'

function boundedCollector(limit: number): { append(chunk: Buffer): void; value(): string } {
  const chunks: Buffer[] = []
  let length = 0
  return {
    append(chunk) {
      if (length >= limit) return
      const bounded = chunk.subarray(0, Math.max(0, limit - length))
      chunks.push(bounded)
      length += bounded.length
    },
    value: () => Buffer.concat(chunks).toString('utf8'),
  }
}

/** Runs an allowlisted executable without a shell and enforces output/lifetime limits. */
export class SpawnCliProcessRunner implements CliProcessRunner {
  public async run(input: Parameters<CliProcessRunner['run']>[0]): Promise<CliProcessResult> {
    return new Promise((resolve) => {
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const stdout = boundedCollector(input.maxOutputBytes)
      const stderr = boundedCollector(input.maxOutputBytes)
      let settled = false
      let timedOut = false
      let cancelled = false
      let killTimer: NodeJS.Timeout | undefined
      const terminate = (reason: 'timeout' | 'cancel') => {
        if (reason === 'timeout') timedOut = true
        else cancelled = true
        try { child.kill('SIGTERM') } catch { /* process may already be gone */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* best effort */ } }, 2_000)
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
        resolve({ exitCode, stdout: stdout.value(), stderr: stderr.value(), timedOut, cancelled })
      }
      input.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))
      child.on('error', () => finish(1))
      child.on('close', (code) => finish(code))
      if (input.stdin) child.stdin.end(input.stdin)
      else child.stdin.end()
    })
  }
}
