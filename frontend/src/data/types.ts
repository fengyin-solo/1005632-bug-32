/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | null
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult<T = EntryRow> = {
  items: T[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  // true 表示命中重复报送：只记一次，不新增、不覆盖，页面按“未重复入库”提示。
  deduped?: boolean
}

// 探漏数据核查：缺项（该填的格子空着）与数值异常分开标注。
export type LeakIssueKind = 'missing' | 'abnormal'

export type LeakIssue = {
  kind: LeakIssueKind
  field: string
  reason: string
}

export type LeakViewRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: unknown
} & {
  // 本次探测的漏点数量；待探测未报送或无法解析时为 null，绝不沿用上一次的数值。
  leakCount: number | null
  issues: LeakIssue[]
  missingFields: string[]
  abnormalFields: string[]
  hasIssue: boolean
  repeatCount: number
  // 重复报送被合并掉的记录 id，只保留当前这一条。
  mergedIds: number[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
