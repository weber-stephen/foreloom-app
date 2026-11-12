export function fitTree(positions: Iterable<{ x: number; y: number }>, width: number, height: number, nodeWidth = 156, nodeHeight = 188) {
  const points = [...positions]
  if (!points.length || !width || !height) return { x: width / 2, y: height / 2, zoom: 1 }
  const left = Math.min(...points.map(point => point.x)) - nodeWidth / 2
  const right = Math.max(...points.map(point => point.x)) + nodeWidth / 2
  const top = Math.min(...points.map(point => point.y)) - nodeHeight / 2
  const bottom = Math.max(...points.map(point => point.y)) + nodeHeight / 2
  const zoom = Math.min(1, (width - 80) / (right - left), (height - 80) / (bottom - top))
  return { x: width / 2 - (left + right) / 2 * zoom, y: height / 2 - (top + bottom) / 2 * zoom, zoom }
}
