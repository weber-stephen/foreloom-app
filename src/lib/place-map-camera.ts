import type { PlaceBucket } from './types'

type FocusablePlace = Pick<PlaceBucket, 'latitude' | 'longitude' | 'level'>

export type PlaceCameraOptions = {
  center: [number, number]
  zoom: number
  duration: number
  essential: true
}

export type PlaceMapCamera = {
  stop: () => unknown
  flyTo: (options: PlaceCameraOptions) => unknown
}

export function placeCameraOptions(place: FocusablePlace): PlaceCameraOptions {
  return {
    center: [place.longitude, place.latitude],
    zoom: place.level === 'country' ? 2.6 : 6,
    duration: 320,
    essential: true,
  }
}

export function focusMapOnPlace(map: PlaceMapCamera, place: FocusablePlace) {
  map.stop()
  map.flyTo(placeCameraOptions(place))
}
