import { MODULE_BY_KEY } from '@/data/modules'
import { listRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  LeakDraftInput,
  LeakReportInput,
  LeakRow,
  LeakViewRow,
} from '@/data/types'

/**
 * 管网探漏领域规则（只服务 leakdetect，其他模块仍走通用 local-service）：
 * - 缺项记录照常列出，标明缺哪一格与原因，漏点数量为 0 是有效值不得丢；
 * - 数值异常（负数、非整数、非数字）单独标出，不参与漏点统计；
 * - 漏点数量只记本次探测，复探是覆盖不是累加；
 * - 重复提交（同编号登记、重复报送）只留一条；
 * - 列表 / 详情 / 导出 / 统计共用同一个视图模型，数量口径一致；
 * - 报送时漏点数量缺失先挡下；
 * - 有效漏点同步到抢修处置的「待复核清单」，同一探漏记录幂等只同步一条。
 */

export const LEAK_KEY = 'leakdetect'
export const EMERGENCY_KEY = 'emergencyrepair'

export const LEAK_STATUSES = ['待探测', '探测中', '需复探', '已处理'] as const

export const REVIEW_STATUS = '待复核'
export const REVIEW_SOURCE_PREFIX = '探漏上报'

// 报送结果时必须给出的格子（探测方法、漏点位置在探测后要补齐）。
const REPORT_REQUIRED_FIELDS = ['探测方法', '漏点位置'] as const
// 清单里允许缺项的格子，以及缺了之后给值班人员的原因说明。
const MISSING_REASONS: Record<string, string> = {
  探测方法: '本月探测未实施，方法尚未填报',
  漏点位置: '漏点位置待现场核实补录',
  漏点数量: '漏点数量未填报，需按本次探测补录',
  处理建议: '处理建议待出具',
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

/** 漏点数量解析：空 → 缺项；非负整数 → 有效；其余（负数、小数、非数字）→ 数值异常。0 是有效值。 */
export function parseLeakCount(value: unknown): {
  kind: 'missing' | 'valid' | 'invalid'
  count: number | null
} {
  if (isBlank(value)) {
    return { kind: 'missing', count: null }
  }
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) {
    return { kind: 'invalid', count: null }
  }
  return { kind: 'valid', count: Number(text) }
}

function missingFieldsOf(row: LeakRow): string[] {
  const missing: string[] = REPORT_REQUIRED_FIELDS.filter((field) => isBlank(row[field]))
  if (parseLeakCount(row.漏点数量).kind === 'missing') {
    missing.push('漏点数量')
  }
  return missing
}

function missingNoteOf(missing: string[]): string {
  if (missing.length === 0) {
    return ''
  }
  return missing.map((field) => `缺「${field}」：${MISSING_REASONS[field] ?? '该格未填报'}`).join('；')
}

function abnormalOf(row: LeakRow, countInvalid: boolean, missing: string[]): string[] {
  const reasons: string[] = []
  if (countInvalid) {
    reasons.push(`漏点数量数值异常（原值：${String(row.漏点数量 ?? '').trim()}），须为非负整数`)
  }
  // 数量与位置互相打架：填了位置却说没有漏点，或数量为正却没有位置。
  const parsed = parseLeakCount(row.漏点数量)
  const hasLocation = !isBlank(row.漏点位置)
  if (parsed.kind === 'valid') {
    const count = parsed.count ?? 0
    if (count === 0 && hasLocation) {
      reasons.push('漏点数量为 0 却填写了漏点位置，请核对本次探测结果')
    }
    if (count > 0 && !hasLocation) {
      reasons.push('漏点数量大于 0 但漏点位置缺失，无法定位')
    }
  }
  // 已处理记录不应带着缺项关单。
  if (String(row.status) === '已处理' && missing.length > 0) {
    reasons.push('已处理记录仍存在缺项，不应关单')
  }
  if (row.abnormal && reasons.length === 0) {
    reasons.push('记录被标记为异常态')
  }
  return reasons
}

/** 单条记录 → 统一视图模型；列表、详情、导出都只准从这里取值。 */
export function toLeakView(row: LeakRow): LeakViewRow {
  const parsed = parseLeakCount(row.漏点数量)
  const missingFields = missingFieldsOf(row)
  const abnormalReasons = abnormalOf(row, parsed.kind === 'invalid', missingFields)
  const status = String(row.status)
  return {
    ...row,
    探漏编号: String(row.探漏编号 ?? ''),
    探测管段: String(row.探测管段 ?? ''),
    探测方法: String(row.探测方法 ?? ''),
    漏点位置: String(row.漏点位置 ?? ''),
    处理建议: String(row.处理建议 ?? ''),
    探测日期: String(row.探测日期 ?? ''),
    探漏状态: String(row.探漏状态 ?? ''),
    leakCountText: parsed.kind === 'missing' ? '缺项' : String(row.漏点数量),
    missingFields,
    missingNote: missingNoteOf(missingFields),
    countInvalid: parsed.kind === 'invalid',
    rowAbnormal: abnormalReasons.length > 0,
    abnormalReasons,
    canSubmit: status === '待探测' || status === '需复探',
    canRequireRepeat: status === '探测中',
    canConfirm:
      status === '探测中' &&
      parsed.kind === 'valid' &&
      abnormalReasons.length === 0 &&
      missingFields.length === 0,
  }
}

function leakRows(): LeakRow[] {
  return listRows(LEAK_KEY) as LeakRow[]
}

function findLeak(id: number): LeakRow | undefined {
  return leakRows().find((row) => Number(row.id) === id)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function matches(row: LeakRow, filters: Record<string, string>): boolean {
  return Object.entries(filters)
    .filter(([, value]) => value.trim() !== '')
    .every(([field, value]) => String(row[field] ?? '').includes(value.trim()))
}

/** 清单查询：缺项、0 漏点的记录一律照常列出，绝不因空格子被过滤掉。 */
export function listLeakEntries(
  filters: Record<string, string> = {},
): { items: LeakViewRow[]; total: number } {
  const items = leakRows()
    .filter((row) => matches(row, filters))
    .map(toLeakView)
  return { items, total: items.length }
}

export function getLeakView(id: number): LeakViewRow | undefined {
  const row = findLeak(id)
  return row ? toLeakView(row) : undefined
}

/** 登记探漏记录：编号唯一，重复提交只留一条。探测未实施时漏点数量允许先空着（缺项照列）。 */
export function createLeakEntry(input: LeakDraftInput): ActionResult & { id?: number } {
  const code = input.探漏编号.trim()
  const segment = input.探测管段.trim()
  const date = input.探测日期.trim()
  if (!code) {
    return { ok: false, message: '探漏编号不能为空，缺漏点数量可以先登记，但编号必须有' }
  }
  if (!segment) {
    return { ok: false, message: '探测管段不能为空' }
  }
  if (!date) {
    return { ok: false, message: '探测日期不能为空' }
  }
  const rows = leakRows()
  if (rows.some((row) => String(row.探漏编号) === code)) {
    return { ok: false, message: `探漏编号 ${code} 已登记，重复提交只记一次，未新增记录` }
  }
  const count = input.漏点数量?.trim()
  if (count !== undefined && count !== '') {
    const parsed = parseLeakCount(count)
    if (parsed.kind === 'invalid') {
      return { ok: false, message: '漏点数量必须是非负整数（0 表示本月未发现漏点），请核对后再登记' }
    }
  }
  const id = nextId(rows)
  const row: LeakRow = {
    id,
    status: '待探测',
    pending: true,
    abnormal: false,
    探漏编号: code,
    探测管段: segment,
    探测方法: input.探测方法?.trim() ?? '',
    漏点数量: count ?? '',
    漏点位置: input.漏点位置?.trim() ?? '',
    处理建议: input.处理建议?.trim() ?? '',
    探测日期: date,
    探漏状态: '待探测',
    复探轮次: 0,
  }
  saveRows(LEAK_KEY, [...rows, row])
  return { ok: true, message: count ? `探漏记录 ${code} 已登记` : `探漏记录 ${code} 已登记，漏点数量待本次探测后补报`, id }
}

/**
 * 报送探测结果 / 复探结果：
 * - 漏点数量缺失先挡下；0 必须显式填报（表示本次未发现漏点）；
 * - 漏点数量只算本次探测，复探直接覆盖上次值，绝不累加；
 * - 同一轮重复报送只保留一条（覆盖为最新内容，不新增、不加数量）。
 */
export function reportLeakResult(id: number, input: LeakReportInput): ActionResult {
  const row = findLeak(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的探漏记录` }
  }
  const status = String(row.status)
  if (status !== '待探测' && status !== '需复探') {
    return { ok: false, message: `当前状态为「${status}」，探测结果已报送，重复报送不累加数量` }
  }
  const method = input.探测方法.trim()
  const location = input.漏点位置?.trim() ?? ''
  const advice = input.处理建议?.trim() ?? ''
  const date = input.探测日期.trim()
  if (!method) {
    return { ok: false, message: '探测方法为必填项，缺项记录补报时请先补齐' }
  }
  const rawCount = input.漏点数量
  if (isBlank(rawCount)) {
    return { ok: false, message: '漏点数量缺失，报送已拦下：请填写本次探测发现的漏点数（未发现请填 0）' }
  }
  const parsed = parseLeakCount(rawCount)
  if (parsed.kind === 'invalid') {
    return { ok: false, message: '漏点数量数值异常，必须是非负整数（未发现漏点请填 0），报送未保存' }
  }
  if (!date) {
    return { ok: false, message: '探测日期不能为空' }
  }
  if ((parsed.count ?? 0) > 0 && !location) {
    return { ok: false, message: '本次探测发现漏点但漏点位置缺失，请补全位置后再报送' }
  }

  const repeatRound = status === '需复探' ? Number(row.复探轮次 ?? 0) + 1 : 0
  const rows = leakRows()
  const next: LeakRow = {
    ...row,
    status: '探测中',
    pending: true,
    abnormal: false,
    探测方法: method,
    // 只记本次探测数量：复探也是直接覆盖，历史值不参与累加。
    漏点数量: parsed.count ?? '',
    漏点位置: location,
    处理建议: advice,
    探测日期: date,
    最近探测日期: date,
    探漏状态: '探测中',
    复探轮次: repeatRound,
  }
  saveRows(LEAK_KEY, rows.map((item) => (Number(item.id) === id ? next : item)))

  // 有效漏点同步到抢修处置待复核清单；同一探漏记录幂等只留一条。
  let message = repeatRound > 0 ? `第 ${repeatRound} 轮复探结果已报送，漏点数量按本次计为 ${parsed.count}，未累加` : `探测结果已报送，本次漏点数量 ${parsed.count}`
  if ((parsed.count ?? 0) === 0) {
    const withdrawn = withdrawReview(id)
    message = withdrawn
      ? '本次探测未发现漏点（数量 0），已撤下抢修待复核清单中的旧条目'
      : '本次探测未发现漏点（数量 0），按零漏点正常记录'
  } else {
    message += `，已同步到抢修处置待复核清单；${syncToReview(next).message}`
  }
  return { ok: true, message }
}

/** 要求复探：只流转状态，不动漏点数量；复探报送时再整体覆盖。 */
export function requireRepeat(id: number): ActionResult {
  const row = findLeak(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的探漏记录` }
  }
  const status = String(row.status)
  if (status === '需复探') {
    return { ok: false, message: '该记录已在复探队列，不要重复提交复探要求' }
  }
  if (status !== '探测中') {
    return { ok: false, message: `当前状态为「${status}」，只有已报送探测结果的记录能要求复探` }
  }
  const rows = leakRows()
  const next: LeakRow = {
    ...row,
    status: '需复探',
    pending: true,
    探漏状态: '需复探',
    复探轮次: Number(row.复探轮次 ?? 0),
  }
  saveRows(LEAK_KEY, rows.map((item) => (Number(item.id) === id ? next : item)))
  return { ok: true, message: '已列入复探，复探报送时漏点数量按本次重新计算，不与上次累加' }
}

/** 确认处理：缺项或数值异常的记录先挡下，不能带病关单。 */
export function confirmLeak(id: number): ActionResult {
  const row = findLeak(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的探漏记录` }
  }
  const view = toLeakView(row)
  if (String(row.status) === '已处理') {
    return { ok: false, message: '该记录已处理，无需重复确认' }
  }
  if (view.missingFields.length > 0) {
    return { ok: false, message: `还有缺项未补齐（${view.missingFields.join('、')}），补齐探测结果后才能确认处理` }
  }
  if (view.rowAbnormal) {
    return { ok: false, message: `记录存在数值异常：${view.abnormalReasons.join('；')}，请先更正再确认` }
  }
  if (String(row.status) !== '探测中') {
    return { ok: false, message: `当前状态为「${String(row.status)}」，须先报送探测结果` }
  }
  const rows = leakRows()
  const next: LeakRow = { ...row, status: '已处理', pending: false, abnormal: false, 探漏状态: '已处理' }
  saveRows(LEAK_KEY, rows.map((item) => (Number(item.id) === id ? next : item)))
  return { ok: true, message: '探漏记录已确认处理' }
}

// ---- 与抢修处置待复核清单的同步（幂等：同一条探漏记录永远只有一条待复核抢修单） ----

function reviewRef(id: number): string {
  return `${REVIEW_SOURCE_PREFIX}-${id}`
}

function findReviewIndex(repairRows: EntryRow[], leakId: number): number {
  const ref = reviewRef(leakId)
  return repairRows.findIndex((row) => String(row.来源探漏) === ref)
}

function syncToReview(leak: LeakRow): ActionResult {
  const repairRows = [...listRows(EMERGENCY_KEY)]
  const parsed = parseLeakCount(leak.漏点数量)
  const index = findReviewIndex(repairRows, Number(leak.id))
  const base: EntryRow = {
    id: index >= 0 ? repairRows[index].id : nextId(repairRows),
    status: REVIEW_STATUS,
    pending: true,
    abnormal: false,
    抢修编号: index >= 0 ? repairRows[index].抢修编号 : `EMER-RV-${String(leak.id).padStart(4, '0')}`,
    故障管段: String(leak.探测管段 ?? ''),
    故障类型: '管网漏损（探漏上报）',
    影响面积: '',
    抢修队: '',
    到场时间: '',
    恢复时间: '',
    抢修状态: REVIEW_STATUS,
    来源探漏: reviewRef(Number(leak.id)),
    漏点数量: parsed.kind === 'valid' ? parsed.count ?? 0 : '',
    漏点位置: String(leak.漏点位置 ?? ''),
  }
  if (index >= 0) {
    // 已经派修/恢复的复核单不再回改，避免覆盖抢修现场数据；仍在待复核则刷新。
    if (String(repairRows[index].status) !== REVIEW_STATUS) {
      return { ok: true, message: '待复核单已进入抢修流程，未重复建单' }
    }
    repairRows[index] = { ...repairRows[index], ...base, id: repairRows[index].id }
    saveRows(EMERGENCY_KEY, repairRows)
    return { ok: true, message: '待复核清单已按最新探测结果更新（仍只保留一条）' }
  }
  repairRows.unshift(base)
  saveRows(EMERGENCY_KEY, repairRows)
  return { ok: true, message: '待复核清单新增一条（同一探漏记录不重复建单）' }
}

/** 0 漏点复探 / 撤回报送时，把仍挂在待复核清单里的对应条目撤下。 */
function withdrawReview(leakId: number): boolean {
  const repairRows = [...listRows(EMERGENCY_KEY)]
  const index = findReviewIndex(repairRows, leakId)
  if (index < 0) {
    return false
  }
  if (String(repairRows[index].status) !== REVIEW_STATUS) {
    return false
  }
  repairRows.splice(index, 1)
  saveRows(EMERGENCY_KEY, repairRows)
  return true
}

/** 抢修待复核清单：只看待复核、且来源于探漏上报的记录。 */
export function listReviewQueue(): EntryRow[] {
  return listRows(EMERGENCY_KEY).filter(
    (row) => String(row.status) === REVIEW_STATUS && String(row.来源探漏 ?? '').startsWith(REVIEW_SOURCE_PREFIX),
  )
}

/**
 * 复核确认：待复核 → 待派修，进入既有抢修流程；
 * 复核退回：同步把探漏记录打回「需复探」，数量保持不动等待下一次复探覆盖。
 */
export function resolveReview(repairId: number, pass: boolean): ActionResult {
  const repairRows = [...listRows(EMERGENCY_KEY)]
  const index = repairRows.findIndex((row) => Number(row.id) === repairId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${repairId} 的抢修记录` }
  }
  const review = repairRows[index]
  if (String(review.status) !== REVIEW_STATUS) {
    return { ok: false, message: `该抢修单当前为「${String(review.status)}」，不在待复核清单里` }
  }
  if (pass) {
    repairRows[index] = {
      ...review,
      status: '待派修',
      pending: true,
      abnormal: false,
      抢修状态: '待派修',
    }
    saveRows(EMERGENCY_KEY, repairRows)
    return { ok: true, message: '复核确认，漏点已转入待派修清单' }
  }
  // 退回：撤销这条待复核单，并把探漏记录打回复探，数量保持不动，等复探重新报送覆盖。
  repairRows.splice(index, 1)
  saveRows(EMERGENCY_KEY, repairRows)
  const ref = String(review.来源探漏 ?? '')
  const leakId = Number(ref.slice(REVIEW_SOURCE_PREFIX.length + 1))
  if (Number.isFinite(leakId) && leakId > 0) {
    const rows = leakRows()
    const target = rows.find((row) => Number(row.id) === leakId)
    if (target) {
      saveRows(
        LEAK_KEY,
        rows.map((row) =>
          Number(row.id) === leakId
            ? { ...row, status: '需复探', pending: true, abnormal: true, 探漏状态: '需复探' }
            : row,
        ),
      )
      return { ok: true, message: '复核退回：已撤销该待复核单，探漏记录打回复探，数量不累加，待复探重新报送' }
    }
  }
  return { ok: true, message: '复核退回，已撤销该待复核单' }
}

// ---- 统计与导出：全部基于视图模型，保证与列表、详情口径一致 ----

export function leakStats(rows: LeakViewRow[] = listLeakEntries().items): {
  waiting: number
  detecting: number
  monthCount: number
  missing: number
  abnormal: number
} {
  const month = currentMonth()
  const validThisMonth = rows.filter(
    (row) => !row.countInvalid && String(row.最近探测日期 ?? row.探测日期 ?? '').startsWith(month),
  )
  return {
    waiting: rows.filter((row) => String(row.status) === '待探测').length,
    detecting: rows.filter((row) => String(row.status) === '探测中').length,
    // 本月漏点数：只累加有效非负整数（异常值、缺项不参与），每条记录只算本次探测的数量。
    monthCount: validThisMonth.reduce(
      (sum, row) => sum + (parseLeakCount(row.漏点数量).count ?? 0),
      0,
    ),
    missing: rows.filter((row) => row.missingFields.length > 0).length,
    abnormal: rows.filter((row) => row.rowAbnormal).length,
  }
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出管网探漏清单：与页面同一份数据（含缺项、异常标注），列表与导出数量逐行一致。 */
export function exportLeakEntries(): { filename: string; content: string } {
  const meta = MODULE_BY_KEY.get(LEAK_KEY)
  const header = ['编号', ...(meta?.fields ?? []), '当前状态', '缺项说明', '异常说明', '复探轮次']
  const lines = [header.map(csvCell).join(',')]
  for (const row of listLeakEntries().items) {
    const values: Array<string | number> = [row.id]
    for (const field of meta?.fields ?? []) {
      if (field === '漏点数量') {
        values.push(row.leakCountText)
      } else {
        values.push(String(row[field] ?? ''))
      }
    }
    values.push(row.status, row.missingNote, row.abnormalReasons.join('；'), row.复探轮次 ?? 0)
    lines.push(values.map(csvCell).join(','))
  }
  return { filename: `${meta?.name ?? '管网探漏'}-清单.csv`, content: `﻿${lines.join('\n')}` }
}
