<template>
  <section class="page" data-module="leakdetect">
    <header class="page-head">
      <div>
        <h2>管网探漏管理</h2>
        <p class="page-desc">探漏编号、探测管段、探测方法、漏点数量登记与流转；缺项照常列出并标明缺格与原因，异常数值单独标注，复探不累加，重复报送只记一次。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记探漏记录</button>
        <button class="btn" type="button" @click="exportRows">导出管网探漏清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-warn': item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-missing">缺项记录：{{ stats[3].value }}</span>
      <span class="legend-item legend-abnormal">数值异常：{{ stats[4].value }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>异常筛选</span>
        <select v-model="abnormalFilter">
          <option value="">全部记录</option>
          <option value="missing">只看缺项</option>
          <option value="abnormal">只看异常</option>
          <option value="zero">只看零漏点</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table leak-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>缺项/异常说明</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)" :class="{ 'row-abnormal': row.rowAbnormal }">
          <td v-for="column in columns" :key="column" :class="cellClass(row, column)">
            <template v-if="column === '漏点数量'">
              <span v-if="row.countInvalid" class="tag tag-abnormal" :title="`原值：${row.漏点数量}`">异常 {{ row.漏点数量 }}</span>
              <span v-else-if="row.missingFields.includes('漏点数量')" class="tag tag-missing">缺项</span>
              <span v-else :class="{ 'count-zero': parseCount(row.漏点数量) === 0 }">{{ row.漏点数量 }}</span>
            </template>
            <template v-else-if="isMissingCell(row, column)">
              <span class="tag tag-missing">缺项</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span class="status-pill" :class="`status-${String(row.status)}`">{{ row.status }}</span>
            <span v-if="Number(row.复探轮次) > 0" class="repeat-badge" title="复探后漏点数量按本次覆盖，不累加">复探×{{ row.复探轮次 }}</span>
          </td>
          <td class="note-cell">
            <div v-if="row.missingNote" class="note-missing">缺项：{{ row.missingNote }}</div>
            <div v-for="reason in row.abnormalReasons" :key="reason" class="note-abnormal">异常：{{ reason }}</div>
            <span v-if="!row.missingNote && !row.abnormalReasons.length" class="note-ok">完整</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
            <button v-if="row.canSubmit" class="link" type="button" @click="openReport(row)">
              {{ String(row.status) === '需复探' ? '复探报送' : '报送结果' }}
            </button>
            <button v-if="row.canRequireRepeat" class="link" type="button" @click="doAction('repeat', row)">要求复探</button>
            <button v-if="row.canConfirm" class="link" type="button" @click="doAction('confirm', row)">确认处理</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的管网探漏记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条探漏记录（缺项、零漏点记录均正常列出）；列表、详情与导出清单的漏点数量口径一致</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <!-- 登记探漏记录 -->
    <div v-if="createOpen" class="modal-mask" @click.self="closeModals">
      <form class="modal" @submit.prevent="submitCreate">
        <h3>登记探漏记录</h3>
        <p class="modal-tip">探测尚未实施时，探测方法、漏点位置、漏点数量可先空着，记录会以缺项形式照常列出；编号重复将被拦截。</p>
        <label class="form-line"><span>探漏编号 *</span><input v-model="createForm.探漏编号" placeholder="如 LEAK-202610-05" /></label>
        <label class="form-line"><span>探测管段 *</span><input v-model="createForm.探测管段" /></label>
        <label class="form-line"><span>探测方法</span><input v-model="createForm.探测方法" placeholder="如听音杆普查、相关仪检测" /></label>
        <label class="form-line">
          <span>漏点数量</span>
          <input v-model="createForm.漏点数量" placeholder="可留空待报；未发现漏点请填 0" />
        </label>
        <label class="form-line"><span>漏点位置</span><input v-model="createForm.漏点位置" /></label>
        <label class="form-line"><span>处理建议</span><input v-model="createForm.处理建议" /></label>
        <label class="form-line"><span>探测日期 *</span><input v-model="createForm.探测日期" type="date" /></label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeModals">取消</button>
          <button class="btn primary" type="submit">登记</button>
        </div>
      </form>
    </div>

    <!-- 报送/复探探测结果 -->
    <div v-if="reportTarget" class="modal-mask" @click.self="closeModals">
      <form class="modal" @submit.prevent="submitReport">
        <h3>{{ isRepeatReport ? '复探报送' : '报送探测结果' }} · {{ reportTarget.探漏编号 }}</h3>
        <p class="modal-tip">
          漏点数量必填，缺失会被拦下；未发现漏点请填 <strong>0</strong>。
          <template v-if="isRepeatReport">复探数量只算本次，提交后覆盖上次数值（上次数 {{ lastCountText }}），<strong>不累加</strong>。</template>
        </p>
        <label class="form-line"><span>探测方法 *</span><input v-model="reportForm.探测方法" /></label>
        <label class="form-line">
          <span>本次漏点数量 *</span>
          <input v-model="reportForm.漏点数量" placeholder="非负整数；0 = 本次无漏点" />
        </label>
        <label class="form-line"><span>漏点位置</span><input v-model="reportForm.漏点位置" placeholder="数量大于 0 时必填" /></label>
        <label class="form-line"><span>处理建议</span><input v-model="reportForm.处理建议" /></label>
        <label class="form-line"><span>探测日期 *</span><input v-model="reportForm.探测日期" type="date" /></label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeModals">取消</button>
          <button class="btn primary" type="submit">提交报送</button>
        </div>
      </form>
    </div>

    <!-- 详情 -->
    <div v-if="detail" class="modal-mask" @click.self="closeModals">
      <div class="modal">
        <h3>探漏详情 · {{ detail.探漏编号 }}</h3>
        <table class="detail-table">
          <tbody>
            <tr v-for="column in columns" :key="column">
              <th>{{ column }}</th>
              <td :class="cellClass(detail, column)">
                <template v-if="column === '漏点数量'">
                  <span v-if="detail.countInvalid" class="tag tag-abnormal">数值异常：{{ detail.漏点数量 }}</span>
                  <span v-else-if="detail.missingFields.includes('漏点数量')" class="tag tag-missing">缺项（待补报）</span>
                  <span v-else>{{ detail.漏点数量 }}</span>
                </template>
                <template v-else-if="isMissingCell(detail, column)">
                  <span class="tag tag-missing">缺项</span>
                </template>
                <template v-else>{{ detail[column] || '—' }}</template>
              </td>
            </tr>
            <tr><th>当前状态</th><td>{{ detail.status }}（复探轮次 {{ detail.复探轮次 ?? 0 }}）</td></tr>
            <tr><th>缺项说明</th><td>{{ detail.missingNote || '无缺项' }}</td></tr>
            <tr>
              <th>异常说明</th>
              <td>
                <div v-for="reason in detail.abnormalReasons" :key="reason" class="note-abnormal">{{ reason }}</div>
                <span v-if="!detail.abnormalReasons.length">无</span>
              </td>
            </tr>
            <tr><th>数量口径</th><td>漏点数量为本次探测结果（{{ detail.leakCountText }}），复探不累加；与清单、导出一致</td></tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="closeModals">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmLeak,
  createLeakEntry,
  exportLeakEntries,
  leakStats,
  listLeakEntries,
  parseLeakCount,
  reportLeakResult,
  requireRepeat,
} from '@/api/leak-service'
import type { LeakDraftInput, LeakReportInput, LeakViewRow } from '@/data/types'

const columns = ['探漏编号', '探测管段', '探测方法', '漏点数量', '漏点位置', '处理建议', '探测日期', '探漏状态']
const statuses = ['待探测', '探测中', '需复探', '已处理']
const filterFields = columns.slice(0, 3)

const rows = ref<LeakViewRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const abnormalFilter = ref('')

const stats = computed(() => {
  const s = leakStats(rows.value)
  return [
    { label: '待探测管段', value: s.waiting, warn: false },
    { label: '探测中管段', value: s.detecting, warn: false },
    { label: '本月漏点数（本次口径，异常不计）', value: s.monthCount, warn: false },
    { label: '缺项记录', value: s.missing, warn: s.missing > 0 },
    { label: '数值异常', value: s.abnormal, warn: s.abnormal > 0 },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 缺项/异常筛选也不能把记录"丢"掉：这里只做显式筛选，默认全部列出。
const filteredRows = computed(() => {
  if (abnormalFilter.value === 'missing') {
    return rows.value.filter((row) => row.missingFields.length > 0)
  }
  if (abnormalFilter.value === 'abnormal') {
    return rows.value.filter((row) => row.rowAbnormal)
  }
  if (abnormalFilter.value === 'zero') {
    return rows.value.filter((row) => parseLeakCount(row.漏点数量).count === 0)
  }
  return rows.value
})

function parseCount(value: unknown): number | null {
  return parseLeakCount(value).count
}

function isMissingCell(row: LeakViewRow, column: string): boolean {
  if (column === '探漏状态') {
    return false
  }
  const value = row[column]
  return value === undefined || value === null || String(value).trim() === ''
}

function cellClass(row: LeakViewRow, column: string): Record<string, boolean> {
  return {
    'cell-missing': isMissingCell(row, column),
    'cell-abnormal':
      (column === '漏点数量' && row.countInvalid) ||
      (row.rowAbnormal && (column === '漏点数量' || column === '漏点位置')),
  }
}

function resetFilters() {
  filters.value = {}
  abnormalFilter.value = ''
  reload()
}

function exportRows() {
  // 导出与页面共用领域服务，缺项/异常标注一并带出，数量逐行一致。
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

function flash(message: string, ok: boolean) {
  if (ok) {
    successMessage.value = message
    errorMessage.value = ''
  } else {
    errorMessage.value = message
    successMessage.value = ''
  }
}

// ---- 登记 ----
const createOpen = ref(false)
const formError = ref('')
const emptyDraft = (): LeakDraftInput => ({
  探漏编号: '',
  探测管段: '',
  探测方法: '',
  漏点数量: '',
  漏点位置: '',
  处理建议: '',
  探测日期: new Date().toISOString().slice(0, 10),
})
const createForm = ref<LeakDraftInput>(emptyDraft())

function openCreate() {
  createForm.value = emptyDraft()
  formError.value = ''
  createOpen.value = true
}

function submitCreate() {
  const result = createLeakEntry(createForm.value)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  closeModals()
  reload()
  flash(result.message, true)
}

// ---- 报送 / 复探 ----
const reportTarget = ref<LeakViewRow | null>(null)
const reportForm = ref<LeakReportInput>({ 探测方法: '', 漏点数量: '', 漏点位置: '', 处理建议: '', 探测日期: '' })

const isRepeatReport = computed(() => String(reportTarget.value?.status) === '需复探')
const lastCountText = computed(() => reportTarget.value?.leakCountText ?? '缺项')

function openReport(row: LeakViewRow) {
  reportTarget.value = row
  reportForm.value = {
    探测方法: String(row.探测方法 ?? ''),
    // 数量刻意不预填：复探必须按本次重新填报，避免沿用上一次造成"累加"错觉。
    漏点数量: '',
    漏点位置: String(row.漏点位置 ?? ''),
    处理建议: String(row.处理建议 ?? ''),
    探测日期: new Date().toISOString().slice(0, 10),
  }
  formError.value = ''
}

function submitReport() {
  if (!reportTarget.value) {
    return
  }
  const result = reportLeakResult(Number(reportTarget.value.id), reportForm.value)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  closeModals()
  reload()
  flash(result.message, true)
}

function doAction(kind: 'repeat' | 'confirm', row: LeakViewRow) {
  const result = kind === 'repeat' ? requireRepeat(Number(row.id)) : confirmLeak(Number(row.id))
  flash(result.message, result.ok)
  if (result.ok) {
    reload()
  }
}

// ---- 详情 ----
const detail = ref<LeakViewRow | null>(null)

function openDetail(row: LeakViewRow) {
  detail.value = row
}

function closeModals() {
  createOpen.value = false
  reportTarget.value = null
  detail.value = null
  formError.value = ''
}

function reload() {
  errorMessage.value = ''
  successMessage.value = ''
  const payload = listLeakEntries(filters.value)
  rows.value = payload.items
  total.value = payload.total
}

onMounted(reload)
</script>
