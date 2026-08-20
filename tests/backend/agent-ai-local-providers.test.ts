// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentAiFacade } from '../../packages/agent/src/services/ai-facade.js'

let facade: AgentAiFacade

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  })
}

beforeEach(() => { facade = new AgentAiFacade() })
afterEach(() => vi.unstubAllGlobals())

describe('local AI providers', () => {
  it('uses the fixed Ollama endpoint for models and chat', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ models: [{ name: 'llama3.2' }] }))
      .mockResolvedValueOnce(json({ message: { content: 'local answer' }, prompt_eval_count: 2, eval_count: 3 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(facade.fetchOllamaModels()).resolves.toEqual({ ok: true, models: ['llama3.2'] })
    await expect(facade.chat([{ role: 'user', content: 'hello' }], {
      provider: 'ollama', model: 'llama3.2', key: 'must-not-leave-the-agent', aiProxyUrl: 'https://example.test', maxOutputTokens: 456,
    }))
      .resolves.toEqual({ ok: true, message: 'local answer', usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 5, source: 'reported' } })
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/tags')
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:11434/api/chat')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'error' })
    expect(String(fetchMock.mock.calls[1][1].body)).not.toContain('must-not-leave-the-agent')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({ options: { num_predict: 456 } })
  })

  it('uses the fixed LM Studio endpoint for models and chat', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ id: 'local-model' }] }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'studio answer' } }], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(facade.fetchLmStudioModels()).resolves.toEqual({ ok: true, models: ['local-model'] })
    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'lmstudio', model: 'local-model', maxOutputTokens: 789 }))
      .resolves.toEqual({ ok: true, message: 'studio answer', usage: { inputTokens: 4, outputTokens: 6, reasoningTokens: 0, totalTokens: 10, source: 'reported' } })
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:1234/v1/models')
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:1234/v1/chat/completions')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({ max_tokens: 789 })
  })

  it.each([0, -1, 8193, 1.5, Number.NaN])('rejects invalid local maxOutputTokens %s before fetching', async (maxOutputTokens) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'ollama', model: 'llama3.2', maxOutputTokens }))
      .resolves.toEqual({ ok: false, error: 'Local AI provider request failed.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'https://example.test', 'http://localhost:11434', 'http://127.0.0.1:11434/?x=1',
    'http://user:pass@127.0.0.1:11434', 'http://127.0.0.1:11434/#fragment',
  ])('rejects untrusted base URL %s before fetching', async (baseUrl) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(facade.fetchOllamaModels(baseUrl)).resolves.toEqual({ ok: false, error: 'Local AI provider request failed.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects redirects, non-JSON, oversized, malformed and invalid model responses', async () => {
    const cases = [
      new Response('{"models":[]}', { headers: { 'content-type': 'application/json' }, status: 302 }),
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      new Response('{"models":[]}', { headers: { 'content-type': 'application/json', 'content-length': String(600 * 1024) } }),
      new Response('not-json', { headers: { 'content-type': 'application/json' } }),
      json({ models: 'not-an-array' }),
    ]
    for (const response of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      await expect(facade.fetchOllamaModels()).resolves.toEqual({ ok: false, error: 'Local AI provider request failed.' })
      vi.unstubAllGlobals()
    }
  })

  it('normalizes timeout and chat schema failures without exposing a prompt', async () => {
    const prompt = 'never include this prompt in an error'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'AbortError')))
    await expect(facade.chat([{ role: 'user', content: prompt }], { provider: 'ollama', model: 'llama3.2' }))
      .resolves.toEqual({ ok: false, error: 'Local AI provider request failed.' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: {} })))
    const schemaResult = await facade.chat([{ role: 'user', content: prompt }], { provider: 'ollama', model: 'llama3.2' })
    expect(schemaResult).toEqual({ ok: false, error: 'Local AI provider request failed.' })
    expect(JSON.stringify(schemaResult)).not.toContain(prompt)
  })

  it('does not accept string or inconsistent local usage counters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ message: { content: 'ollama answer' }, prompt_eval_count: '2', eval_count: 3 }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: 'studio answer' } }],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 2 },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'ollama', model: 'llama3.2' }))
      .resolves.toEqual({
        ok: true,
        message: 'ollama answer',
        usage: { inputTokens: 2, outputTokens: 4, reasoningTokens: 0, totalTokens: 6, source: 'estimated' },
      })
    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'lmstudio', model: 'local-model' }))
      .resolves.toEqual({ ok: true, message: 'studio answer', usage: { inputTokens: 4, outputTokens: 6, reasoningTokens: 0, totalTokens: 10, source: 'reported' } })
  })

  it('separates LM Studio reasoning from visible output usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      choices: [{ message: { content: 'reasoned answer' } }],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 9,
        total_tokens: 13,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    })))

    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'lmstudio', model: 'local-model' }))
      .resolves.toEqual({
        ok: true,
        message: 'reasoned answer',
        usage: { inputTokens: 4, outputTokens: 4, reasoningTokens: 5, totalTokens: 13, source: 'reported' },
      })
  })

  it('limits parallel and per-minute local requests', async () => {
    const limited = new AgentAiFacade({ maxConcurrentRequests: 1, localRequestsPerMinute: 1 })
    let resolveFirst: ((value: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveFirst = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    const first = limited.chat([{ role: 'user', content: 'first' }], { provider: 'ollama', model: 'llama3.2' }, { requestId: 'local-first' })
    await Promise.resolve()
    await expect(limited.chat([{ role: 'user', content: 'second' }], { provider: 'ollama', model: 'llama3.2' }, { requestId: 'local-second' }))
      .resolves.toMatchObject({ ok: false, code: 'busy' })
    resolveFirst?.(json({ message: { content: 'done' }, prompt_eval_count: 1, eval_count: 1 }))
    await expect(first).resolves.toMatchObject({ ok: true, message: 'done' })
    await expect(limited.chat([{ role: 'user', content: 'third' }], { provider: 'ollama', model: 'llama3.2' }, { requestId: 'local-third' }))
      .resolves.toMatchObject({ ok: false, code: 'rate_limited' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('counts busy attempts toward the bounded local request window', async () => {
    const limited = new AgentAiFacade({ maxConcurrentRequests: 1, localRequestsPerMinute: 3 })
    let resolveFirst: ((value: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveFirst = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    const first = limited.chat([{ role: 'user', content: 'first' }], { provider: 'ollama', model: 'llama3.2' }, { requestId: 'count-first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await expect(limited.chat([{ role: 'user', content: 'busy one' }], { provider: 'ollama', model: 'llama3.2' }, { requestId: 'count-busy-1' }))
      .resolves.toMatchObject({ ok: false, code: 'busy' })
    await expect(limited.chat([{ role: 'user', content: 'busy two' }], { provider: 'ollama', model: 'llama3.2' }, { requestId: 'count-busy-2' }))
      .resolves.toMatchObject({ ok: false, code: 'busy' })
    resolveFirst?.(json({ message: { content: 'done' }, prompt_eval_count: 1, eval_count: 1 }))
    await first
    await expect(limited.chat([{ role: 'user', content: 'blocked after busy' }], { provider: 'ollama', model: 'llama3.2' }, { requestId: 'count-rate' }))
      .resolves.toMatchObject({ ok: false, code: 'rate_limited' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts local provider I/O and deduplicates an inference request id', async () => {
    const controller = new AbortController()
    const abortingFetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))
    }))
    vi.stubGlobal('fetch', abortingFetch)
    const cancelled = facade.chat([{ role: 'user', content: 'cancel me' }], { provider: 'ollama', model: 'llama3.2' }, {
      requestId: 'local-cancel', signal: controller.signal,
    })
    controller.abort()
    await expect(cancelled).resolves.toMatchObject({ ok: false, code: 'cancelled' })

    const fetchMock = vi.fn().mockResolvedValue(json({ message: { content: 'once' }, prompt_eval_count: 1, eval_count: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const options = { requestId: 'local-idempotent' }
    const [first, duplicate] = await Promise.all([
      facade.chat([{ role: 'user', content: 'same' }], { provider: 'ollama', model: 'llama3.2' }, options),
      facade.chat([{ role: 'user', content: 'same' }], { provider: 'ollama', model: 'llama3.2' }, options),
    ])
    expect(first).toMatchObject({ ok: true, message: 'once' })
    expect(duplicate).toMatchObject({ ok: false, code: 'conflict' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(facade.chat([{ role: 'user', content: 'same' }], { provider: 'ollama', model: 'llama3.2' }, options))
      .resolves.toEqual(first)
    await expect(facade.chat([{ role: 'user', content: 'different' }], { provider: 'ollama', model: 'llama3.2' }, options))
      .resolves.toMatchObject({ ok: false, code: 'conflict' })
  })
})
