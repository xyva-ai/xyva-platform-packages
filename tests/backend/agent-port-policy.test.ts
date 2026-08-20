// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  isAllowedAgentPort,
  parseAllowedAgentPort,
  resolveAllowedAgentPorts,
} from '../../packages/agent/src/agent-port-policy'

describe('Agent port policy', () => {
  it('uses the shared QA and Flow defaults', () => {
    expect(resolveAllowedAgentPorts(undefined)).toEqual([7900, 7901, 7902])
    expect(isAllowedAgentPort(7900, [7900, 7901, 7902])).toBe(true)
    expect(isAllowedAgentPort(7903, [7900, 7901, 7902])).toBe(false)
  })

  it('accepts only canonical unique ports from a bounded explicit list', () => {
    expect(resolveAllowedAgentPorts('7900,7902,17900')).toEqual([7900, 7902, 17900])
    for (const value of ['', '7900x', '07900', '80', '65536', '7900,7900', '7900, 7901', '7900,7901,7902,7903,7904,7905,7906,7907,7908']) {
      expect(() => resolveAllowedAgentPorts(value)).toThrow('XYVA_AGENT_ALLOWED_PORTS is invalid')
    }
  })

  it('parses a CLI port only when it is canonical and explicitly allowed', () => {
    expect(parseAllowedAgentPort('7901', [7900, 7901, 7902])).toBe(7901)
    for (const value of ['7900x', '07900', '7903', '80', '65536', 7900]) {
      expect(() => parseAllowedAgentPort(value, [7900, 7901, 7902])).toThrow('Invalid Agent port')
    }
  })
})
