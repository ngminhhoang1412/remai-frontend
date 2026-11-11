import { describe, expect, it } from 'vitest'
import {
  DEFAULT_API_URL,
  assertSpaFallback,
  buildCsp,
  buildHeadersFile,
  resolveApiOrigin,
} from './write-headers.mjs'

/** Parses a Cloudflare `_headers` file into { path: { header: [values] } }, plus detached names. */
function parseHeaders(text) {
  const rules = {}
  let current = null
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue
    if (!line.startsWith(' ')) {
      current = rules[line.trim()] = { set: {}, detach: [] }
      continue
    }
    const entry = line.trim()
    if (entry.startsWith('!')) {
      current.detach.push(entry.slice(1).trim())
    } else {
      const i = entry.indexOf(':')
      current.set[entry.slice(0, i)] = entry.slice(i + 1).trim()
    }
  }
  return rules
}

function directives(csp) {
  return Object.fromEntries(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

describe('resolveApiOrigin', () => {
  it('uses the origin of VITE_API_URL, dropping path, trailing slash and default port', () => {
    expect(resolveApiOrigin('https://API.example.com:443/prod/')).toEqual({
      origin: 'https://api.example.com',
      usedDefault: false,
    })
    expect(resolveApiOrigin('http://localhost:18080')).toEqual({
      origin: 'http://localhost:18080',
      usedDefault: false,
    })
  })

  it('falls back to the same default as the app when VITE_API_URL is missing or empty', () => {
    expect(DEFAULT_API_URL).toBe('http://localhost:8080')
    for (const raw of [undefined, '', '   ']) {
      expect(resolveApiOrigin(raw)).toEqual({ origin: 'http://localhost:8080', usedDefault: true })
    }
  })

  it('rejects malformed values so the build fails', () => {
    expect(() => resolveApiOrigin('api.example.com')).toThrow(/valid absolute URL/)
    expect(() => resolveApiOrigin('https://')).toThrow(/valid absolute URL/)
    expect(() => resolveApiOrigin('ftp://api.example.com')).toThrow(/http or https/)
    expect(() => resolveApiOrigin('javascript:alert(1)')).toThrow(/http or https/)
    expect(() => resolveApiOrigin('https://user:pw@api.example.com')).toThrow(/credentials/)
  })

  it("can't inject extra CSP directives", () => {
    const { origin } = resolveApiOrigin("https://api.example.com/;script-src 'unsafe-inline'")
    expect(origin).toBe('https://api.example.com')
  })
})

describe('buildCsp', () => {
  it("allows scripts and styles only from 'self', connections to 'self' + the API, and forbids framing", () => {
    const d = directives(buildCsp('https://api.example.com'))
    expect(d['default-src']).toEqual(["'self'"])
    expect(d['script-src']).toEqual(["'self'"])
    expect(d['style-src']).toEqual(["'self'"])
    expect(d['connect-src']).toEqual(["'self'", 'https://api.example.com'])
    expect(d['frame-ancestors']).toEqual(["'none'"])
    expect(d['object-src']).toEqual(["'none'"])
    expect(buildCsp('https://api.example.com')).not.toMatch(/unsafe-|\*/)
  })
})

describe('buildHeadersFile', () => {
  it('Headers present: every path gets the CSP (with the API origin), nosniff and Referrer-Policy', () => {
    const rules = parseHeaders(buildHeadersFile('https://api.example.com'))
    const all = rules['/*'].set
    expect(all['Content-Security-Policy']).toContain("connect-src 'self' https://api.example.com")
    expect(all['X-Content-Type-Options']).toBe('nosniff')
    expect(all['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
  })

  it('New deploy takes effect: HTML is not cached, fingerprinted assets are cached immutably', () => {
    const rules = parseHeaders(buildHeadersFile('https://api.example.com'))
    expect(rules['/*'].set['Cache-Control']).toBe('no-cache')
    expect(rules['/assets/*'].detach).toEqual(['Cache-Control'])
    expect(rules['/assets/*'].set['Cache-Control']).toBe('public, max-age=31536000, immutable')
    expect(Object.keys(rules)).toEqual(['/*', '/assets/*'])
  })
})

describe('assertSpaFallback', () => {
  it('Reload a page URL: fails the build if a top-level 404.html would disable the SPA fallback', () => {
    expect(() => assertSpaFallback('dist', () => false)).not.toThrow()
    expect(() => assertSpaFallback('dist', (p) => /[\\/]dist[\\/]404\.html$/.test(p))).toThrow(
      /404\.html/,
    )
  })
})
