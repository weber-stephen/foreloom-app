// This intentionally decodes one pass only. A note containing `&amp;quot;` stays
// as `&quot;`, rather than unexpectedly changing stored, literal text twice.
const named: Record<string, string> = {
  amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: '\u00a0',
  copy: '©', reg: '®', trade: '™', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  cent: '¢', pound: '£', euro: '€', yen: '¥', deg: '°', plusmn: '±',
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const base = body[1].toLowerCase() === 'x' ? 16 : 10
      const number = Number.parseInt(body.slice(base === 16 ? 2 : 1), base)
      if (Number.isInteger(number) && number >= 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)) {
        return String.fromCodePoint(number)
      }
      return entity
    }
    return named[body.toLowerCase()] || entity
  })
}
