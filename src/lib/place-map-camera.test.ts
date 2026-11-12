import { describe, expect, it, vi } from 'vitest'
import { focusMapOnPlace, placeCameraOptions } from './place-map-camera'

const place = (level: string, longitude: number, latitude: number) => ({ level, longitude, latitude })

describe('placeCameraOptions', () => {
  it('centers a local place and uses the detailed zoom level', () => {
    expect(placeCameraOptions(place('locality', -3.19, 55.95))).toEqual({
      center: [-3.19, 55.95],
      zoom: 6,
      duration: 320,
      essential: true,
    })
  })

  it('uses a wider zoom level for countries', () => {
    expect(placeCameraOptions(place('country', -98, 39)).zoom).toBe(2.6)
  })
})

describe('focusMapOnPlace', () => {
  it('cancels an in-progress move before flying to the selected place', () => {
    const stop = vi.fn()
    const flyTo = vi.fn()

    focusMapOnPlace({ stop, flyTo }, place('region', 12.5, 41.9))

    expect(stop).toHaveBeenCalledOnce()
    expect(flyTo).toHaveBeenCalledWith({ center: [12.5, 41.9], zoom: 6, duration: 320, essential: true })
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(flyTo.mock.invocationCallOrder[0])
  })
})
