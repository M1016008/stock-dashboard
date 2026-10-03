export const MOVING_AVERAGE_COLORS: Record<number, string> = {
  3: '#ec4899', // pink
  5: '#dc2626', // red
  12: '#dc2626',
  13: '#dc2626',
  24: '#2563eb',
  25: '#2563eb', // blue
  26: '#2563eb',
  52: '#16a34a',
  60: '#16a34a',
  75: '#16a34a', // green
  200: '#f97316', // orange
}

const MOVING_AVERAGE_FALLBACK_COLORS = ['#64748b', '#7c3aed', '#0f766e', '#b45309']

export function movingAverageColor(period: number | string, index = 0): string {
  const numericPeriod = typeof period === 'number' ? period : Number(period)
  if (Number.isFinite(numericPeriod) && MOVING_AVERAGE_COLORS[numericPeriod]) {
    return MOVING_AVERAGE_COLORS[numericPeriod]
  }
  return MOVING_AVERAGE_FALLBACK_COLORS[index % MOVING_AVERAGE_FALLBACK_COLORS.length]
}
