// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  isAllowedProductOrigin,
  normalizeProductOrigin,
  resolveAgentProductCapability,
  resolveAgentProductOrigins,
} from '../../packages/agent/src/product-origins'
import { isExpectedLicenseIssuer } from '../../packages/agent/src/license-signature'

describe('shared Agent product origins', () => {
  it('adds only the exact QA and Flow production origins during the apex migration', () => {
    const origins = resolveAgentProductOrigins('https://xyva.ai', [])

    expect([...origins].sort()).toEqual([
      'https://flow.xyva.ai',
      'https://qa.xyva.ai',
      'https://xyva.ai',
    ])
    expect(isAllowedProductOrigin('https://qa.xyva.ai', origins)).toBe(true)
    expect(isAllowedProductOrigin('https://flow.xyva.ai', origins)).toBe(true)
    expect(isAllowedProductOrigin('https://evil.xyva.ai', origins)).toBe(false)
    expect(isAllowedProductOrigin('null', origins)).toBe(false)
  })

  it('keeps staging isolated unless each additional product origin is explicit', () => {
    const origins = resolveAgentProductOrigins(
      'https://staging.example.test',
      ['https://qa.staging.example.test', 'http://127.0.0.1:3000'],
    )

    expect([...origins].sort()).toEqual([
      'http://127.0.0.1:3000',
      'https://qa.staging.example.test',
      'https://staging.example.test',
    ])
    expect(origins.has('https://flow.xyva.ai')).toBe(false)
  })

  it('binds QA and Flow origins to separate capability profiles', () => {
    expect(resolveAgentProductCapability('https://qa.xyva.ai', 'https://xyva.ai', [], []))
      .toBe('qa-studio.full-bridge')
    expect(resolveAgentProductCapability('https://flow.xyva.ai', 'https://xyva.ai', [], []))
      .toBe('provider-bridge.v1')
    expect(resolveAgentProductCapability('https://evil.xyva.ai', 'https://xyva.ai', [], []))
      .toBeNull()
  })

  it('never widens a Flow product origin when it is also the configured portal', () => {
    expect(resolveAgentProductCapability(
      'https://flow.xyva.ai',
      'https://flow.xyva.ai',
      [],
      [],
    )).toBe('provider-bridge.v1')
    expect(resolveAgentProductCapability(
      'https://flow-preview.example.test',
      'https://flow-preview.example.test',
      ['https://flow-preview.example.test'],
      ['https://flow-preview.example.test'],
    )).toBe('provider-bridge.v1')
  })

  it('requires additional origins to be explicitly classified instead of inheriting bridge access', () => {
    const legacyOnly = resolveAgentProductOrigins(
      'https://staging.example.test',
      ['https://unclassified.example.test'],
      [],
      [],
    )
    expect(legacyOnly.has('https://unclassified.example.test')).toBe(true)
    expect(resolveAgentProductCapability(
      'https://unclassified.example.test',
      'https://staging.example.test',
      [],
      [],
    )).toBeNull()
    expect(resolveAgentProductCapability(
      'https://qa-preview.example.test',
      'https://staging.example.test',
      ['https://qa-preview.example.test'],
      [],
    )).toBe('qa-studio.full-bridge')
    expect(resolveAgentProductCapability(
      'http://127.0.0.1:5173',
      'https://staging.example.test',
      [],
      ['http://127.0.0.1:5173'],
    )).toBe('provider-bridge.v1')
  })

  it.each([
    'http://qa.xyva.ai',
    'https://*.xyva.ai',
    'https://qa.xyva.ai/path',
    'https://user:secret@qa.xyva.ai',
    'https://qa.xyva.ai?next=flow',
    'not-an-origin',
  ])('rejects non-exact or unsafe product origin %s', (origin) => {
    expect(() => normalizeProductOrigin(origin)).toThrow(/origin|HTTPS/i)
  })
})

describe('QA license issuer migration', () => {
  const beforeSunset = Date.parse('2027-02-28T23:59:59.000Z')
  const atSunset = Date.parse('2027-03-01T00:00:00.000Z')

  it('allows only the explicit apex and QA issuer pair before the sunset', () => {
    expect(isExpectedLicenseIssuer(
      'https://xyva.ai',
      'https://qa.xyva.ai',
      'xyva-prod-2026-01',
      beforeSunset,
    )).toBe(true)
    expect(isExpectedLicenseIssuer(
      'https://qa.xyva.ai',
      'https://xyva.ai',
      'xyva-prod-2026-01',
      beforeSunset,
    )).toBe(true)
    expect(isExpectedLicenseIssuer(
      'https://qa.xyva.ai',
      'https://evil.xyva.ai',
      'xyva-prod-2026-01',
      beforeSunset,
    )).toBe(false)
    expect(isExpectedLicenseIssuer(
      'https://qa.xyva.ai',
      'https://xyva.ai',
      'unknown-key',
      beforeSunset,
    )).toBe(false)
  })

  it('stops accepting the legacy apex issuer at the compiled sunset', () => {
    expect(isExpectedLicenseIssuer(
      'https://qa.xyva.ai',
      'https://xyva.ai',
      'xyva-prod-2026-01',
      atSunset,
    )).toBe(false)
    expect(isExpectedLicenseIssuer(
      'https://qa.xyva.ai',
      'https://qa.xyva.ai',
      'xyva-prod-2026-01',
      atSunset,
    )).toBe(true)
  })
})
