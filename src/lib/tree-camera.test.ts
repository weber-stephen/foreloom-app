import { describe, expect, it } from 'vitest'
import { fitTree } from './tree-camera'

describe('fitTree', () => {
  it('fits parents and children within the viewport', () => {
    const camera = fitTree([{ x: -220, y: -300 }, { x: 0, y: 0 }, { x: 220, y: 300 }], 900, 700)
    expect(camera.zoom).toBeLessThan(1)
    expect((-300 - 94) * camera.zoom + camera.y).toBeGreaterThanOrEqual(0)
    expect((300 + 94) * camera.zoom + camera.y).toBeLessThanOrEqual(700)
  })
})
