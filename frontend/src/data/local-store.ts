import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'district-heating:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 示例数据后续新增过缺项/异常场景：老缓存里没有这些行，按业务编号幂等补入，用户已改过的行不动。
function mergeSeedRows(saved: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const merged = clone(saved)
  const mergeBy = (key: string, identity: (row: EntryRow) => string) => {
    const seeds = SEED_ROWS[key] ?? []
    const existing = merged[key] ?? []
    const known = new Set(existing.map(identity))
    const additions = seeds.filter((row) => !known.has(identity(row)))
    if (additions.length > 0) {
      merged[key] = [...existing, ...additions]
    }
  }
  mergeBy('leakdetect', (row) => String(row.探漏编号 ?? row.id))
  mergeBy('emergencyrepair', (row) =>
    String(row.来源探漏 ?? row.抢修编号 ?? row.id),
  )
  return merged
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = mergeSeedRows(readStorage())
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
    }
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
