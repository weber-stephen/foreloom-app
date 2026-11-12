import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities } from './text'

describe('decodeHtmlEntities', () => {
  it('decodes common named and numeric entities once as plain text', () => {
    expect(decodeHtmlEntities('Mary &quot;Nell&quot; Marsh&apos;s &amp; Co. &#169; &#x2014;')).toBe('Mary "Nell" Marsh\'s & Co. © —')
    expect(decodeHtmlEntities('&amp;quot;')).toBe('&quot;')
  })
})
