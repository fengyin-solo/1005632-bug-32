import { filterRows, moduleMeta } from './local-service'
import { listRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  LeakIssue,
  LeakViewRow,
  PageResult,
} from '@/data/types'

// 管网探漏的业务规则集中在这里：
// 1) 缺项记录照常列出，并标明缺哪一格、原因；数值异常单独标出。
// 2) 漏点数量只认「本次探测」的填报值，复探直接覆盖，绝不沿用上一次累加。
// 3) 重复报送只记一条；列表、详情、导出共用同一份规范化结果，数量必然对得上。
// 4) 确认处理的结果同步到抢修处置的「待复核」清单。

const KEY = 'leakdetect'
const REPAIR_KEY = 'emergencyrepair'

const FIELD_CODE = '探漏编号'
const FIELD_SEGMENT = '探测管段'
const FIELD_METHOD = '探测方法'
const FIELD_COUNT = '漏点数量'
const FIELD_LOCATION = '漏点位置'
const FIELD_ADVICE = '处理建议'
const FIELD_DATE = '探测日期'

const RESULT_FIELDS = [FIELD_METHOD, FIELD_LOCATION, FIELD_ADVICE, FIELD_DATE]
const STATUS_PENDING = '待探测'
const STATUS_DETECTING = '探测中'
const STATUS_HANDLED = '已处理'
const STATUS_RECHECK = '需复探'
export const REVIEW_STATUS = '待复核'

const meta = moduleMeta(KEY)

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

function trimText(value: unknown): string {
  return isBlank(value) ? '' : String(value).trim()
}

// 解析「本次探测」的漏点数量：
// - 空值（包括数量为 0 之外的缺填）返回 null，由调用方按状态判定是否缺项；
// - 非负整数才算合法；负数、小数、非数字一律算数值异常，绝不当成 0 或沿用旧值。
function parseCount(value: unknown): { count: number | null; abnormal: boolean } {
  if (isBlank(value)) {
    return { count: null, abnormal: false }
  }
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) {
    return { count: null, abnormal: true }
  }
  const count = Number(text)
  if (!Number.isSafeInteger(count) || count < 0) {
    return { count: null, abnormal: true }
  }
  return { count, abnormal: false }
}

function issue(kind: LeakIssue['kind'], field: string, reason: string): LeakIssue {
  return { kind, field, reason }
}

// 逐条做数据核查：待探测记录还没报送结果，结果类空格不挑刺；
// 进入探测/处理/复探后，该报的格子空着就算缺项，数值不合法算异常。
function inspect(row: EntryRow): {
  count: number | null
  issues: LeakIssue[]
  countAbnormal: boolean
} {
  const issues: LeakIssue[] = []
  const status = String(row.status ?? '')
  const reported = status !== STATUS_PENDING

  if (isBlank(row[FIELD_CODE])) {
    issues.push(issue('missing', FIELD_CODE, '探漏编号缺失，无法唯一标识本条记录'))
  }
  if (isBlank(row[FIELD_SEGMENT])) {
    issues.push(issue('missing', FIELD_SEGMENT, '探测管段缺失，不清楚探的是哪一段管网'))
  }

  const parsed = parseCount(row[FIELD_COUNT])
  let countAbnormal = false
  if (parsed.abnormal) {
    countAbnormal = true
    issues.push(
      issue(
        'abnormal',
        FIELD_COUNT,
        `漏点数量「${String(row[FIELD_COUNT]).trim()}」不是非负整数，数值异常，统计时不予计入`,
      ),
    )
  } else if (reported && parsed.count === null) {
    issues.push(
      issue(
        'missing',
        FIELD_COUNT,
        '本次探测已报送但漏点数量缺失（数量为 0 时必须显式填 0，不允许空着）',
      ),
    )
  }

  if (reported) {
    if (isBlank(row[FIELD_METHOD])) {
      issues.push(issue('missing', FIELD_METHOD, '探测方法缺失，无法说明本次用什么手段探漏'))
    }
    if (isBlank(row[FIELD_LOCATION])) {
      if ((parsed.count ?? 0) > 0) {
        issues.push(
          issue('missing', FIELD_LOCATION, '本次探测发现漏点但漏点位置未填报，抢修无法定位'),
        )
      } else {
        issues.push(
          issue('missing', FIELD_LOCATION, '漏点位置未填报（无漏点时应注明“未发现漏点”）'),
        )
      }
    }
    if (isBlank(row[FIELD_DATE])) {
      issues.push(issue('missing', FIELD_DATE, '探测日期缺失，无法归属统计月份'))
    }
  }

  return { count: parsed.count, issues, countAbnormal }
}

function decorate(row: EntryRow): LeakViewRow {
  const { count, issues } = inspect(row)
  const missingFields = issues.filter((item) => item.kind === 'missing').map((item) => item.field)
  const abnormalFields = issues
    .filter((item) => item.kind === 'abnormal')
    .map((item) => item.field)
  return {
    ...row,
    leakCount: count,
    issues,
    missingFields,
    abnormalFields,
    hasIssue: issues.length > 0,
    repeatCount: Number(row['探测次数']) || 0,
    mergedIds: [],
  }
}

// 重复报送去重：同一次探测（同管段 + 同方法 + 同日期 + 同漏点数量 + 同位置）只留一条。
// 重复条目不直接物理删除，而是合并到首条记录上做标注，列表、详情、导出拿到的永远是这一份。
function dedupe(rows: EntryRow[]): EntryRow[] {
  const kept = new Map<string, number>()
  const removedIds = new Set<number>()
  const mergedById = new Map<number, number[]>()

  rows.forEach((row) => {
    const parts = [
      trimText(row[FIELD_SEGMENT]),
      trimText(row[FIELD_METHOD]),
      trimText(row[FIELD_DATE]),
      trimText(row[FIELD_LOCATION]),
      trimText(row[FIELD_COUNT]),
    ]
    // 五个关键格全空的不参与去重，避免把待探测的新建记录误并掉。
    if (parts.every((part) => part === '')) {
      return
    }
    const signature = parts.join('|')
    const firstId = kept.get(signature)
    if (firstId === undefined) {
      kept.set(signature, Number(row.id))
      return
    }
    // 首条记录此前可能已经合并过别的重复报送，连同已有标记一起带下来，避免重复累积。
    const previous = mergedById.get(firstId) ?? parseMergedIds(rows, firstId)
    previous.push(Number(row.id))
    mergedById.set(firstId, previous)
    removedIds.add(Number(row.id))
  })

  if (removedIds.size === 0) {
    return rows
  }
  const survivors = rows.filter((row) => !removedIds.has(Number(row.id)))
  const result = survivors.map((row) => {
    const ids = mergedById.get(Number(row.id))
    if (!ids || ids.length === 0) {
      return row
    }
    const uniqueIds = [...new Set(ids)]
    return { ...row, 重复报送合并: uniqueIds.join(','), 合并条数: uniqueIds.length }
  })
  saveRows(KEY, result)
  return result
}

function parseMergedIds(rows: EntryRow[], id: number): number[] {
  const owner = rows.find((row) => Number(row.id) === id)
  const raw = owner ? trimText(owner['重复报送合并']) : ''
  return raw
    ? raw
        .split(',')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    : []
}

function normalize(rows: EntryRow[]): LeakViewRow[] {
  return dedupe(rows).map((row) => {
    const view = decorate(row)
    const merged = trimText(row['重复报送合并'])
    if (merged) {
      view.mergedIds = merged
        .split(',')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    }
    return view
  })
}

export function listLeakEntries(filters: Record<string, string> = {}): PageResult<LeakViewRow> {
  // 先在全量数据上去重并落盘，再按条件筛选，避免筛选视图把未展示的记录误删。
  const all = normalize(listRows(KEY))
  const items = filterRows(all, filters)
  return { items, total: items.length, page: 1, size: items.length }
}

export function getLeakEntry(id: number): LeakViewRow | null {
  return normalize(listRows(KEY)).find((row) => Number(row.id) === id) ?? null
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function fail(message: string, deduped = false): ActionResult {
  return { ok: false, deduped, message }
}

// 登记探漏记录（还没去现场）：只录编号与管段，结果类格子留空属于正常做法。
// 同一探漏编号重复登记的，只记一次。
export function createLeakEntry(input: {
  code: string
  segment: string
  method?: string
  date?: string
}): ActionResult {
  const code = input.code.trim()
  const segment = input.segment.trim()
  if (!code) {
    return fail('探漏编号必填，缺编号的记录无法登记')
  }
  if (!segment) {
    return fail('探测管段必填，缺管段的记录无法登记')
  }
  const rows = listRows(KEY)
  if (rows.some((row) => trimText(row[FIELD_CODE]) === code)) {
    return fail(`探漏编号 ${code} 已报送过，重复报送只记一次，未再生成新记录`, true)
  }
  const row: EntryRow = {
    id: nextId(rows),
    status: STATUS_PENDING,
    pending: true,
    abnormal: false,
    [FIELD_CODE]: code,
    [FIELD_SEGMENT]: segment,
    [FIELD_METHOD]: input.method?.trim() ?? '',
    [FIELD_COUNT]: '',
    [FIELD_LOCATION]: '',
    [FIELD_ADVICE]: '',
    [FIELD_DATE]: input.date?.trim() ?? '',
    探漏状态: STATUS_PENDING,
    探测次数: 0,
  }
  saveRows(KEY, [...rows, row])
  return { ok: true, message: `探漏记录 ${code} 已登记，状态「${STATUS_PENDING}」` }
}

type SubmitInput = {
  method: string
  countText: string
  location: string
  advice?: string
  date: string
}

// 提交（或复探后再次提交）探测结果。
// 漏点数量缺失先挡下：数量为 0 也必须显式填 0。
// 复探不累加：直接用本次填报值覆盖上一次的数量。
export function submitLeakResult(id: number, input: SubmitInput): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的探漏记录`)
  }
  const current = rows[index]

  const method = input.method.trim()
  const location = input.location.trim()
  const advice = (input.advice ?? '').trim()
  const date = input.date.trim()
  const countText = input.countText.trim()

  if (countText === '') {
    return fail('漏点数量缺失，先挡下本次报送：本次没发现漏点请填 0，不允许空着')
  }
  const parsed = parseCount(countText)
  if (parsed.abnormal) {
    return fail(`漏点数量「${countText}」不是非负整数，数值异常，请核实后重新报送`)
  }
  if (!method) {
    return fail('探测方法缺失，先补全探测方法再报送')
  }
  if (!date) {
    return fail('探测日期缺失，先补全探测日期再报送')
  }
  if (!location) {
    return fail('漏点位置缺失，先补全位置（未发现漏点时填“未发现漏点”）再报送')
  }

  // 同一条记录把完全相同的探测结果再报一遍（重复点击、网络重发）只记一次。
  const sameAsCurrent =
    trimText(current[FIELD_METHOD]) === method &&
    trimText(current[FIELD_COUNT]) === countText &&
    trimText(current[FIELD_LOCATION]) === location &&
    trimText(current[FIELD_DATE]) === date
  if (sameAsCurrent) {
    return fail('本次报送内容与已登记的探测结果完全相同，重复报送只记一次，未重复入库', true)
  }

  // 与库内其他记录的探测结果核心要素完全相同（复探后同格重报、网络重发）只记一次。
  // 处理建议属于备注性质，不参与判定，避免补个备注就绕过去重。
  const duplicate = rows.find(
    (row) =>
      Number(row.id) !== id &&
      trimText(row[FIELD_SEGMENT]) === trimText(current[FIELD_SEGMENT]) &&
      trimText(row[FIELD_METHOD]) === method &&
      trimText(row[FIELD_DATE]) === date &&
      trimText(row[FIELD_COUNT]) === countText &&
      trimText(row[FIELD_LOCATION]) === location,
  )
  if (duplicate) {
    return fail(
      `本次报送与探漏记录 ${trimText(duplicate[FIELD_CODE])} 内容完全相同，重复报送只记一次，未重复入库`,
      true,
    )
  }

  const previous = parseCount(current[FIELD_COUNT]).count
  const repeatCount = (Number(current['探测次数']) || 0) + 1
  const updated: EntryRow = {
    ...current,
    status: STATUS_DETECTING,
    pending: true,
    abnormal: false,
    [FIELD_METHOD]: method,
    [FIELD_COUNT]: parsed.count,
    [FIELD_LOCATION]: location,
    [FIELD_ADVICE]: advice,
    [FIELD_DATE]: date,
    探漏状态: STATUS_DETECTING,
    探测次数: repeatCount,
    上次漏点数量: previous ?? '',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)

  const repeatNote =
    repeatCount > 1 && previous !== null
      ? `本次为第 ${repeatCount} 次探测（含复探），漏点数量只按本次 ${parsed.count} 计，不与上次 ${previous} 累加`
      : `本次探测漏点数量 ${parsed.count} 已登记`
  return { ok: true, message: `${repeatNote}，当前状态「${STATUS_DETECTING}」` }
}

// 要求复探：只改状态，不动漏点数量；等复探结果报上来时再整体覆盖。
export function requestRecheck(id: number): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的探漏记录`)
  }
  const current = rows[index]
  if (String(current.status) === STATUS_RECHECK) {
    return { ok: true, deduped: true, message: '该记录已经在「需复探」，重复要求只记一次，状态未变' }
  }
  if (String(current.status) === STATUS_HANDLED) {
    return fail('该记录已确认处理，如需重新探测请先联系值班安排')
  }
  const updated: EntryRow = {
    ...current,
    status: STATUS_RECHECK,
    pending: true,
    abnormal: false,
    探漏状态: STATUS_RECHECK,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)
  return { ok: true, message: `已要求复探，当前状态「${STATUS_RECHECK}」，复探结果按本次数量重新计` }
}

// 确认处理：漏点数量缺失/异常先挡下；有漏点的结果同步到抢修处置「待复核」清单。
export function confirmHandled(id: number): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的探漏记录`)
  }
  const current = rows[index]
  const { count, countAbnormal } = inspect(current)
  if (count === null) {
    if (countAbnormal) {
      return fail('漏点数量数值异常，先核实更正后再确认处理')
    }
    return fail('漏点数量缺失，先挡下：本次没发现漏点请补填 0 后再确认处理')
  }

  const updated: EntryRow = {
    ...current,
    status: STATUS_HANDLED,
    pending: false,
    abnormal: false,
    探漏状态: STATUS_HANDLED,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)

  let syncNote = ''
  if (count > 0) {
    syncRepairReview(updated)
    syncNote = `；本次 ${count} 个漏点已同步到抢修处置「待复核」清单`
  }
  return { ok: true, message: `探漏记录已确认处理，漏点数量按本次 ${count} 计${syncNote}` }
}

// 同步到抢修处置待复核清单：同一探漏编号只维护一条，已进入抢修流程的不再回改。
function syncRepairReview(leak: EntryRow): void {
  const repairs = listRows(REPAIR_KEY)
  const sourceCode = trimText(leak[FIELD_CODE])
  const count = parseCount(leak[FIELD_COUNT]).count ?? 0
  const method = trimText(leak[FIELD_METHOD])
  const existingIndex = repairs.findIndex(
    (row) => trimText(row['来源探漏编号']) === sourceCode,
  )

  if (existingIndex >= 0) {
    const existing = repairs[existingIndex]
    if (String(existing.status) === REVIEW_STATUS) {
      const updated: EntryRow = {
        ...existing,
        故障管段: trimText(leak[FIELD_SEGMENT]),
        故障类型: `探漏发现漏点（${method || '方法未填'}）`,
        探漏漏点数量: count,
        探漏位置: trimText(leak[FIELD_LOCATION]),
        同步时间: new Date().toISOString().slice(0, 10),
      }
      const next = [...repairs]
      next[existingIndex] = updated
      saveRows(REPAIR_KEY, next)
    }
    return
  }

  const review: EntryRow = {
    id: repairs.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
    status: REVIEW_STATUS,
    pending: true,
    abnormal: false,
    抢修编号: `REV-${sourceCode || `LEAK-${Date.now()}`}`,
    故障管段: trimText(leak[FIELD_SEGMENT]),
    故障类型: `探漏发现漏点（${method || '方法未填'}）`,
    影响面积: '',
    抢修队: '',
    到场时间: '',
    恢复时间: '',
    抢修状态: REVIEW_STATUS,
    来源探漏编号: sourceCode,
    探漏漏点数量: count,
    探漏位置: trimText(leak[FIELD_LOCATION]),
    同步时间: new Date().toISOString().slice(0, 10),
  }
  saveRows(REPAIR_KEY, [...repairs, review])
}

export function listRepairReviews(): EntryRow[] {
  return listRows(REPAIR_KEY).filter((row) => String(row.status) === REVIEW_STATUS)
}

// 抢修侧复核通过：待复核 → 待派修，沿用既有抢修派修流程。
export function approveRepairReview(id: number): ActionResult {
  const rows = listRows(REPAIR_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的待复核记录`)
  }
  const current = rows[index]
  if (String(current.status) !== REVIEW_STATUS) {
    return fail('该记录已复核，无需重复操作', true)
  }
  const updated: EntryRow = {
    ...current,
    status: '待派修',
    pending: true,
    abnormal: false,
    抢修状态: '待派修',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(REPAIR_KEY, next)
  return { ok: true, message: '探漏同步记录复核通过，已转入「待派修」清单' }
}

// 漏点数量统计口径：只计本次探测值；缺失、异常不计入。
// 列表、详情、导出、看板都走这里，保证多处看到的数量对得上。
export function leakStats(rows: LeakViewRow[]): {
  pendingSegments: number
  detectingSegments: number
  monthLeakCount: number
  month: string
} {
  const month = new Date().toISOString().slice(0, 7)
  const monthLeakCount = rows.reduce((sum, row) => {
    const date = trimText(row[FIELD_DATE])
    if (date.slice(0, 7) !== month) {
      return sum
    }
    return sum + (row.leakCount ?? 0)
  }, 0)
  return {
    pendingSegments: rows.filter((row) => String(row.status) === STATUS_PENDING).length,
    detectingSegments: rows.filter((row) =>
      [STATUS_DETECTING, STATUS_RECHECK].includes(String(row.status)),
    ).length,
    monthLeakCount,
    month,
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出与列表共用同一份规范化结果：数量、缺项、异常、去重标记完全一致。
export function exportLeakEntries(): { filename: string; content: string } {
  const rows = normalize(listRows(KEY))
  const header = [...meta.fields, '数据核查', '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    const notes: string[] = []
    if (row.issues.length > 0) {
      notes.push(
        ...row.issues.map(
          (item) => `[${item.kind === 'missing' ? '缺项' : '异常'}·${item.field}] ${item.reason}`,
        ),
      )
    }
    if (row.mergedIds.length > 0) {
      notes.push(`重复报送合并：${row.mergedIds.length} 条重复记录只保留本条`)
    }
    if (!notes.length) {
      notes.push('数据正常')
    }
    lines.push(
      [
        ...meta.fields.map((field) => {
          if (field === FIELD_COUNT) {
            return row.leakCount === null ? '' : String(row.leakCount)
          }
          const value = row[field]
          return value === undefined || value === null ? '' : String(value)
        }),
        notes.join('；'),
        row.status,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  const { month, monthLeakCount } = leakStats(rows)
  lines.push(
    ['', '', '', '', '', '', '', `本月（${month}）漏点合计`, monthLeakCount, '']
      .map(csvCell)
      .join(','),
  )
  return {
    filename: `${meta.name}-清单.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

export function downloadLeakEntries(): void {
  const { filename, content } = exportLeakEntries()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export const leakFields = {
  FIELD_CODE,
  FIELD_SEGMENT,
  FIELD_METHOD,
  FIELD_COUNT,
  FIELD_LOCATION,
  FIELD_ADVICE,
  FIELD_DATE,
  RESULT_FIELDS,
  STATUS_PENDING,
  STATUS_DETECTING,
  STATUS_HANDLED,
  STATUS_RECHECK,
}
