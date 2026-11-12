import type * as maplibregl from 'maplibre-gl'

export type Theme = 'light' | 'dark'

export type MapPalette = {
  water: string
  countryEmpty: string
  countrySteps: string[]
  countrySelected: string
  countryOutline: string
  placeCore: string
  markerStroke: string
  originFill: string
  originStroke: string
  generations: Record<string, string>
}

const light: MapPalette = {
  water: '#dce9ed',
  countryEmpty: '#e9eee6',
  countrySteps: ['#d2e5d7', '#acd1b7', '#78ac83', '#4f874e', '#356c3d', '#245638', '#183c2c'],
  countrySelected: '#b78248',
  countryOutline: '#aab9a6',
  placeCore: '#315844',
  markerStroke: '#fff9ea',
  originFill: '#fff9ea',
  originStroke: '#7a4935',
  generations: { '1': '#b45f3d', '2': '#b78b39', '3': '#668c55', '4': '#3e7d73', '5': '#4e6f9b', '6+': '#725886' },
}

const dark: MapPalette = {
  water: '#1f2328',
  countryEmpty: '#292e33',
  countrySteps: ['#344138', '#40513f', '#4d634a', '#5c7756', '#6f8c65', '#83a077', '#9ab48b'],
  countrySelected: '#d1a867',
  countryOutline: '#596167',
  placeCore: '#b8c9ad',
  markerStroke: '#1f2328',
  originFill: '#e9e4d8',
  originStroke: '#c77d61',
  generations: { '1': '#c97b65', '2': '#c99f61', '3': '#8ca871', '4': '#6fa094', '5': '#829fc2', '6+': '#a385ad' },
}

export const mapPalette = (theme: Theme): MapPalette => theme === 'dark' ? dark : light

export const countryFillExpression = (palette: MapPalette) => [
  'case',
  ['boolean', ['get', 'selected'], false], palette.countrySelected,
  ['step', ['coalesce', ['get', 'count'], 0], palette.countryEmpty,
    1, palette.countrySteps[0], 2, palette.countrySteps[1], 6, palette.countrySteps[2],
    10, palette.countrySteps[3], 30, palette.countrySteps[4], 80, palette.countrySteps[5], 200, palette.countrySteps[6]],
] as unknown as maplibregl.ExpressionSpecification
