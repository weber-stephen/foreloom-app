import { describe, expect, it } from 'vitest'
import { countryFillExpression, mapPalette } from './map-theme'

describe('map theme palettes', () => {
  it('supplies every required map color for light and dark themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const palette = mapPalette(theme)
      expect(palette.countrySteps).toHaveLength(7)
      expect(Object.keys(palette.generations).sort()).toEqual(['1', '2', '3', '4', '5', '6+'])
      expect(Object.values(palette)).not.toContain('')
    }
  })

  it('builds a selected and count-tiered country fill expression from the active palette', () => {
    const palette = mapPalette('dark')
    const expression = (countryFillExpression(palette) as unknown as unknown[]).flat(Infinity)

    expect(expression).toContain(palette.countrySelected)
    expect(expression).toContain(palette.countryEmpty)
    palette.countrySteps.forEach(color => expect(expression).toContain(color))
  })
})
