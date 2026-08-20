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
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('cloud AI providers', () => {
  it.each([
    ['openai', 'openai', 'https://api.openai.com/v1/models', { data: [{ id: 'gpt-5' }] }],
    ['codex', 'openai', 'https://api.openai.com/v1/models', { data: [{ id: 'gpt-5' }] }],
    ['claude', 'claude', 'https://api.anthropic.com/v1/models', { data: [{ id: 'claude-sonnet' }] }],
    ['anthropic', 'claude', 'https://api.anthropic.com/v1/models', { data: [{ id: 'claude-sonnet' }] }],
    ['gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta/models', { models: [{ name: 'models/gemini-2.5-flash' }] }],
    ['google', 'gemini', 'https://generativelanguage.googleapis.com/v1beta/models', { models: [{ name: 'models/gemini-2.5-flash' }] }],
  ])('lists models via the fixed %s endpoint', async (alias, _provider, expectedUrl, payload) => {
    const fetchMock = vi.fn().mockResolvedValue(json(payload))
    vi.stubGlobal('fetch', fetchMock)

    const result = await facade.listModels({ provider: alias, key: `${alias}-key` })
    expect(result).toEqual({ ok: true, models: [alias === 'gemini' || alias === 'google' ? 'gemini-2.5-flash' : alias === 'claude' || alias === 'anthropic' ? 'claude-sonnet' : 'gpt-5'] })
    expect(fetchMock.mock.calls[0][0]).toBe(expectedUrl)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  })

  it('uses only the matching credential header for every cloud provider', async () => {
    const cases = [
      { provider: 'openai', key: 'openai-secret', header: 'Authorization', value: 'Bearer openai-secret' },
      { provider: 'claude', key: 'claude-secret', header: 'x-api-key', value: 'claude-secret' },
      { provider: 'gemini', key: 'gemini-secret', header: 'x-goog-api-key', value: 'gemini-secret' },
    ]
    for (const entry of cases) {
      const fetchMock = vi.fn().mockResolvedValue(json(entry.provider === 'gemini' ? { models: [] } : { data: [] }))
      vi.stubGlobal('fetch', fetchMock)
      await facade.listModels({ provider: entry.provider, key: entry.key })
      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
      expect(headers[entry.header]).toBe(entry.value)
      for (const secret of cases.map((candidate) => candidate.key).filter((key) => key !== entry.key)) {
        expect(JSON.stringify(headers)).not.toContain(secret)
      }
      vi.unstubAllGlobals()
    }
  })

  it('runs non-streaming inference and normalizes provider usage', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ output: [{ content: [{ type: 'output_text', text: 'openai ' }, { type: 'output_text', text: 'answer' }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 1 } }))
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'claude answer' }], usage: { input_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 1, output_tokens: 5 } }))
      .mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 16 } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(facade.chat([{ role: 'system', content: 'be concise' }, { role: 'user', content: 'hello' }], {
      provider: 'codex', key: 'openai-key', model: 'gpt-5', maxOutputTokens: 77,
    })).resolves.toEqual({ ok: true, message: 'openai answer', usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 5, source: 'reported' } })
    await expect(facade.chat([{ role: 'user', content: 'hello' }], {
      provider: 'anthropic', key: 'claude-key', model: 'claude-sonnet', systemInstructions: 'review', maxOutputTokens: 88,
    })).resolves.toEqual({ ok: true, message: 'claude answer', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 0, totalTokens: 12, source: 'reported' } })
    await expect(facade.chat([{ role: 'user', content: 'hello' }], {
      provider: 'google', key: 'gemini-key', model: 'gemini-2.5-flash', systemInstructions: 'ground rules', maxOutputTokens: 99,
    })).resolves.toEqual({ ok: true, message: 'gemini answer', usage: { inputTokens: 6, outputTokens: 7, reasoningTokens: 3, totalTokens: 16, source: 'reported' } })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ store: false, instructions: 'be concise', max_output_tokens: 77 })
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({ system: 'review', max_tokens: 88, stream: false })
    expect(fetchMock.mock.calls[2][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toMatchObject({ generationConfig: { maxOutputTokens: 99 } })
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toHaveProperty('systemInstruction', { parts: [{ text: 'ground rules' }] })
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).not.toHaveProperty('system_instruction')
  })

  it('requires the canonical OpenAI output-text shape and excludes unsafe usage values', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ output: [{ content: [{ output_text: 'legacy-shaped text' }] }] }))
      .mockResolvedValueOnce(json({ output: [{ content: [{ type: 'output_text', text: 'safe answer' }] }], usage: { input_tokens: '2', output_tokens: 3, total_tokens: 5 } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'openai', key: 'openai-key', model: 'gpt-5' }))
      .resolves.toEqual({ ok: false, error: 'AI provider request failed.' })
    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'openai', key: 'openai-key', model: 'gpt-5' }))
      .resolves.toEqual({
        ok: true,
        message: 'safe answer',
        usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 5, source: 'estimated' },
      })
  })

  it('does not undercount Gemini thoughts when total usage is inconsistent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 11, totalTokenCount: 5 },
    })))
    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'gemini', key: 'gemini-key', model: 'gemini-2.5-flash' }))
      .resolves.toEqual({ ok: true, message: 'answer', usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 11, totalTokens: 16, source: 'reported' } })
  })

  it('separates OpenAI reasoning from visible output usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      output: [{ content: [{ type: 'output_text', text: 'answer' }] }],
      usage: {
        input_tokens: 2,
        output_tokens: 8,
        total_tokens: 10,
        output_tokens_details: { reasoning_tokens: 5 },
      },
    })))

    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'openai', key: 'openai-key', model: 'gpt-5' }))
      .resolves.toEqual({
        ok: true,
        message: 'answer',
        usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 5, totalTokens: 10, source: 'reported' },
      })
  })

  it('rejects missing keys and does not fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(facade.listModels({ provider: 'openai' })).resolves.toEqual({ ok: false, error: 'AI provider request failed.' })
    await expect(facade.chat([{ role: 'user', content: 'hello' }], { provider: 'gemini', model: 'gemini-2.5-flash' }))
      .resolves.toEqual({ ok: false, error: 'AI provider request failed.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('redacts malformed, non-JSON, oversized and timeout failures', async () => {
    const prompt = 'do not expose this prompt or cloud-key'
    const failures = [
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      new Response('{"data":[]}', { headers: { 'content-type': 'application/json', 'content-length': String(600 * 1024) } }),
      new Response('invalid-json', { headers: { 'content-type': 'application/json' } }),
    ]
    for (const response of failures) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      await expect(facade.listModels({ provider: 'openai', key: 'cloud-key' })).resolves.toEqual({ ok: false, error: 'AI provider request failed.' })
      vi.unstubAllGlobals()
    }
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = facade.chat([{ role: 'user', content: prompt }], { provider: 'openai', key: 'cloud-key', model: 'gpt-5' })
    await vi.advanceTimersByTimeAsync(120_000)
    const result = await pending
    expect(result).toEqual({ ok: false, error: 'AI provider request failed.' })
    expect(JSON.stringify(result)).not.toContain(prompt)
    expect(JSON.stringify(result)).not.toContain('cloud-key')
  })
})
