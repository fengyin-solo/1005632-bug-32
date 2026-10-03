/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

// 探漏领域行：漏点数量允许为空（缺项），复探轮次与同步标记都落在记录上。
export type LeakRow = EntryRow & {
  漏点数量: number | string
  复探轮次?: number
  最近探测日期?: string
  待复核同步?: boolean
}

// 探漏清单的统一视图模型：列表、详情、导出、统计全部从这里取值，数量口径天然一致。
export interface LeakViewRow {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  探漏编号: string
  探测管段: string
  探测方法: string
  漏点数量: number | string
  漏点位置: string
  处理建议: string
  探测日期: string
  探漏状态: string
  复探轮次?: number
  最近探测日期?: string
  待复核同步?: boolean
  [field: string]: string | number | boolean | string[] | undefined
  leakCountText: string
  missingFields: string[]
  missingNote: string
  countInvalid: boolean
  rowAbnormal: boolean
  abnormalReasons: string[]
  canSubmit: boolean
  canRequireRepeat: boolean
  canConfirm: boolean
}

// 登记探漏记录时录入的字段。
export type LeakDraftInput = {
  探漏编号: string
  探测管段: string
  探测方法?: string
  漏点数量?: string
  漏点位置?: string
  处理建议?: string
  探测日期: string
}

// 报送/复探探测结果时录入的字段；漏点数量必须在表单层先挡住缺失。
export type LeakReportInput = {
  探测方法: string
  漏点数量: string
  漏点位置?: string
  处理建议?: string
  探测日期: string
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

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
