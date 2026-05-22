// lib/util/cn.ts — Tailwind クラス名連結 (clsx 互換最小版)
type ClassValue = string | number | null | undefined | false | ClassValue[] | { [k: string]: unknown }

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = []
  for (const v of inputs) {
    if (!v) continue
    if (typeof v === 'string' || typeof v === 'number') {
      out.push(String(v))
    } else if (Array.isArray(v)) {
      const sub = cn(...v)
      if (sub) out.push(sub)
    } else if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (val) out.push(k)
      }
    }
  }
  return out.join(' ')
}
