<template>
  <section class="page" data-module="leakdetect">
    <header class="page-head">
      <div>
        <h2>管网探漏管理</h2>
        <p class="page-desc">
          缺项记录照常列出并标明缺哪一格；数值异常单独标出。漏点数量只算本次探测，复探不累加；重复报送只记一次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记探漏记录</button>
        <button class="btn" type="button" @click="exportRows">导出管网探漏清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table leak-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>数据核查</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-missing': row.missingFields.length > 0, 'row-abnormal': row.abnormalFields.length > 0 }"
        >
          <td v-for="column in columns" :key="column">
            <template v-if="column === countField">
              <span :class="{ 'cell-abnormal': row.abnormalFields.includes(column) }">
                {{ row.leakCount === null ? '—' : row.leakCount }}
              </span>
              <span v-if="row.abnormalFields.includes(column)" class="badge badge-abnormal" :title="reasonOf(row, column)">
                数值异常
              </span>
            </template>
            <template v-else-if="row.missingFields.includes(column)">
              <span class="cell-missing" :title="reasonOf(row, column)">待补</span>
              <span class="badge badge-missing" :title="reasonOf(row, column)">缺·{{ column }}</span>
            </template>
            <template v-else>
              {{ isBlankCell(row[column]) ? '—' : row[column] }}
            </template>
          </td>
          <td class="check-cell">
            <span v-if="!row.hasIssue && !row.mergedIds.length" class="badge badge-ok">数据正常</span>
            <ul v-else class="issue-list">
              <li v-for="item in row.issues" :key="`${item.kind}-${item.field}`">
                <span :class="['badge', item.kind === 'missing' ? 'badge-missing' : 'badge-abnormal']">
                  {{ item.kind === 'missing' ? `缺·${item.field}` : '数值异常' }}
                </span>
                <span class="issue-reason">{{ item.reason }}</span>
              </li>
              <li v-if="row.mergedIds.length">
                <span class="badge badge-dup">重复报送</span>
                <span class="issue-reason">合并 {{ row.mergedIds.length }} 条重复报送，只保留本条一条</span>
              </li>
            </ul>
          </td>
          <td>
            {{ row.status }}
            <span v-if="row.repeatCount > 1" class="repeat-tag">已探 {{ row.repeatCount }} 次</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
            <button
              v-if="String(row.status) === leakStatus.STATUS_PENDING || String(row.status) === leakStatus.STATUS_RECHECK"
              class="link"
              type="button"
              @click="openSubmit(row)"
            >
              {{ String(row.status) === leakStatus.STATUS_RECHECK ? '提交复探结果' : '提交探测' }}
            </button>
            <button
              v-if="String(row.status) === leakStatus.STATUS_DETECTING"
              class="link"
              type="button"
              @click="openSubmit(row)"
            >
              补报/更正
            </button>
            <button
              v-if="String(row.status) !== leakStatus.STATUS_HANDLED"
              class="link"
              type="button"
              @click="runAction('确认处理', row)"
            >
              确认处理
            </button>
            <button
              v-if="String(row.status) !== leakStatus.STATUS_RECHECK && String(row.status) !== leakStatus.STATUS_HANDLED"
              class="link"
              type="button"
              @click="runAction('要求复探', row)"
            >
              要求复探
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无管网探漏数据，可先登记探漏记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条探漏记录 · 本月（{{ statsMonth }}）漏点合计 {{ monthCount }}（缺项/异常数量不计入）
      </span>
      <span v-if="errorMessage" :class="['error-text', { 'warn-text': lastDeduped }]">{{ errorMessage }}</span>
    </footer>

    <!-- 登记探漏记录 -->
    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3>登记探漏记录</h3>
        <p class="modal-tip">先把待探测的管段登记进来；探测方法、漏点数量等结果类字段现场探测后再补报。</p>
        <form class="modal-form" @submit.prevent="submitCreate">
          <label>
            <span>探漏编号 *</span>
            <input v-model="createForm.code" placeholder="如 LEAK-0008" />
          </label>
          <label>
            <span>探测管段 *</span>
            <input v-model="createForm.segment" placeholder="如 建设路一次网DN300" />
          </label>
          <label>
            <span>计划探测日期</span>
            <input v-model="createForm.date" type="date" />
          </label>
          <p v-if="createError" class="error-text">{{ createError }}</p>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="closeCreate">取消</button>
            <button class="btn primary" type="submit">登记</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 提交探测 / 复探结果 -->
    <div v-if="submitOpen" class="modal-mask" @click.self="closeSubmit">
      <div class="modal">
        <h3>{{ submitTarget?.status === leakStatus.STATUS_RECHECK ? '提交复探结果' : '提交探测结果' }}</h3>
        <p class="modal-tip">
          漏点数量只按本次填报计入，{{ submitTarget?.repeatCount ? `复探不会与上次（${previousCountText}）累加；` : '' }}
          本次没发现漏点请填 0，空着会被挡下。
        </p>
        <form class="modal-form" @submit.prevent="submitResult">
          <label>
            <span>探测方法 *</span>
            <input v-model="submitForm.method" placeholder="如 听音法 / 相关分析法 / 气体追踪法" />
          </label>
          <label>
            <span>本次漏点数量 *（非负整数，0 表示未发现漏点）</span>
            <input v-model="submitForm.countText" inputmode="numeric" placeholder="如 0、1、2" />
          </label>
          <label>
            <span>漏点位置 *（无漏点填“未发现漏点”）</span>
            <input v-model="submitForm.location" placeholder="如 XX阀井东侧3米" />
          </label>
          <label>
            <span>探测日期 *</span>
            <input v-model="submitForm.date" type="date" />
          </label>
          <label>
            <span>处理建议</span>
            <input v-model="submitForm.advice" placeholder="如 降压实测后开挖换管" />
          </label>
          <p v-if="submitError" class="error-text">{{ submitError }}</p>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="closeSubmit">取消</button>
            <button class="btn primary" type="submit">报送本次结果</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 详情 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal modal-wide">
        <h3>探漏记录详情 · {{ detailRow[codeField] }}</h3>
        <table class="data-table detail-table">
          <tbody>
            <tr v-for="column in columns" :key="column">
              <th>{{ column }}</th>
              <td v-if="column === countField">
                <span :class="{ 'cell-abnormal': detailRow.abnormalFields.includes(column) }">
                  {{ detailRow.leakCount === null ? '未报送' : detailRow.leakCount }}
                </span>
                <span v-if="detailRow.abnormalFields.includes(column)" class="badge badge-abnormal">数值异常</span>
                <span v-else-if="detailRow.missingFields.includes(column)" class="badge badge-missing">缺项</span>
              </td>
              <td v-else-if="detailRow.missingFields.includes(column)">
                <span class="cell-missing">待补</span>
                <span class="badge badge-missing">缺项</span>
              </td>
              <td v-else>{{ isBlankCell(detailRow[column]) ? '—' : detailRow[column] }}</td>
            </tr>
            <tr>
              <th>本次漏点数量（统一口径）</th>
              <td>{{ detailRow.leakCount === null ? '不计入统计' : detailRow.leakCount }}</td>
            </tr>
            <tr v-if="detailRow['上次漏点数量'] !== undefined && detailRow['上次漏点数量'] !== ''">
              <th>上一次漏点数量（仅对照，不累加）</th>
              <td>{{ detailRow['上次漏点数量'] }}</td>
            </tr>
            <tr>
              <th>累计探测次数</th>
              <td>{{ detailRow.repeatCount }} 次（每次数量独立，不做累加）</td>
            </tr>
          </tbody>
        </table>
        <div class="detail-check">
          <p v-if="!detailRow.hasIssue && !detailRow.mergedIds.length" class="ok-text">数据核查：本记录各格齐全、数值正常。</p>
          <ul v-else class="issue-list">
            <li v-for="item in detailRow.issues" :key="`d-${item.kind}-${item.field}`">
              <span :class="['badge', item.kind === 'missing' ? 'badge-missing' : 'badge-abnormal']">
                {{ item.kind === 'missing' ? `缺·${item.field}` : '数值异常' }}
              </span>
              <span class="issue-reason">{{ item.reason }}</span>
            </li>
            <li v-if="detailRow.mergedIds.length">
              <span class="badge badge-dup">重复报送</span>
              <span class="issue-reason">已合并 {{ detailRow.mergedIds.length }} 条重复报送，只记本条一次。</span>
            </li>
          </ul>
        </div>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="detailRow = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  confirmHandled,
  createLeakEntry,
  downloadLeakEntries,
  getLeakEntry,
  leakFields,
  leakStats,
  listLeakEntries,
  requestRecheck,
  submitLeakResult,
} from '@/api/leak-service'
import type { LeakViewRow } from '@/data/types'

const columns = [
  leakFields.FIELD_CODE,
  leakFields.FIELD_SEGMENT,
  leakFields.FIELD_METHOD,
  leakFields.FIELD_COUNT,
  leakFields.FIELD_LOCATION,
  leakFields.FIELD_ADVICE,
  leakFields.FIELD_DATE,
  '探漏状态',
]
const codeField = leakFields.FIELD_CODE
const countField = leakFields.FIELD_COUNT
const leakStatus = {
  STATUS_PENDING: leakFields.STATUS_PENDING,
  STATUS_DETECTING: leakFields.STATUS_DETECTING,
  STATUS_HANDLED: leakFields.STATUS_HANDLED,
  STATUS_RECHECK: leakFields.STATUS_RECHECK,
}
const statuses = [
  leakFields.STATUS_PENDING,
  leakFields.STATUS_DETECTING,
  leakFields.STATUS_HANDLED,
  leakFields.STATUS_RECHECK,
]

const rows = ref<LeakViewRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const lastDeduped = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const summary = computed(() => leakStats(rows.value))
const statsMonth = computed(() => summary.value.month)
const monthCount = computed(() => summary.value.monthLeakCount)
const stats = computed(() => [
  { label: '待探测管段', value: summary.value.pendingSegments },
  { label: '探测中/需复探管段', value: summary.value.detectingSegments },
  { label: `本月漏点数（${summary.value.month}）`, value: summary.value.monthLeakCount },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isBlankCell(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

function reasonOf(row: LeakViewRow, field: string): string {
  const found = row.issues.find((item) => item.field === field)
  return found ? found.reason : ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadLeakEntries()
}

function flash(message: string, deduped = false) {
  errorMessage.value = message
  lastDeduped.value = deduped
}

// ---- 登记 ----
const createOpen = ref(false)
const createError = ref('')
const createForm = reactive({ code: '', segment: '', date: '' })

function openCreate() {
  createForm.code = ''
  createForm.segment = ''
  createForm.date = ''
  createError.value = ''
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

function submitCreate() {
  const result = createLeakEntry({
    code: createForm.code,
    segment: createForm.segment,
    date: createForm.date,
  })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  createOpen.value = false
  flash(result.message, result.deduped)
  reload()
}

// ---- 提交探测/复探结果 ----
const submitOpen = ref(false)
const submitError = ref('')
const submitTarget = ref<LeakViewRow | null>(null)
const submitForm = reactive({ method: '', countText: '', location: '', advice: '', date: '' })

const previousCountText = computed(() => {
  const raw = submitTarget.value?.['上次漏点数量']
  return raw === undefined || raw === '' ? '未报送过' : String(raw)
})

function openSubmit(row: LeakViewRow) {
  const latest = getLeakEntry(Number(row.id)) ?? row
  submitTarget.value = latest
  submitForm.method = String(latest[leakFields.FIELD_METHOD] ?? '')
  submitForm.countText = latest.leakCount === null ? '' : String(latest.leakCount)
  submitForm.location = String(latest[leakFields.FIELD_LOCATION] ?? '')
  submitForm.advice = String(latest[leakFields.FIELD_ADVICE] ?? '')
  submitForm.date = String(latest[leakFields.FIELD_DATE] ?? '')
  submitError.value = ''
  submitOpen.value = true
}

function closeSubmit() {
  submitOpen.value = false
  submitTarget.value = null
}

function submitResult() {
  if (!submitTarget.value) {
    return
  }
  const result = submitLeakResult(Number(submitTarget.value.id), { ...submitForm })
  if (!result.ok) {
    submitError.value = result.message
    return
  }
  submitOpen.value = false
  submitTarget.value = null
  flash(result.message, result.deduped)
  reload()
}

// ---- 状态动作 ----
function runAction(action: '确认处理' | '要求复探', row: LeakViewRow) {
  const result = action === '确认处理'
    ? confirmHandled(Number(row.id))
    : requestRecheck(Number(row.id))
  flash(result.message, result.deduped)
  if (result.ok) {
    reload()
  }
}

// ---- 详情 ----
const detailRow = ref<LeakViewRow | null>(null)

function openDetail(row: LeakViewRow) {
  // 详情重新从同一份规范化数据里取，保证与列表/导出数量一致。
  detailRow.value = getLeakEntry(Number(row.id)) ?? row
}

function reload() {
  try {
    const payload = listLeakEntries(filters.value)
    rows.value = payload.items as LeakViewRow[]
    total.value = payload.total
  } catch (error) {
    flash(error instanceof Error ? error.message : '管网探漏列表读取失败')
  }
}

onMounted(reload)
</script>

<style scoped>
.badge {
  display: inline-block;
  border-radius: 4px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  margin-left: 4px;
  white-space: nowrap;
}
.badge-missing {
  background: #fff4e5;
  color: #b54708;
  border: 1px solid #fdc38a;
}
.badge-abnormal {
  background: #fef3f2;
  color: #b42318;
  border: 1px solid #fda29b;
}
.badge-dup {
  background: #eef4ff;
  color: #1849a9;
  border: 1px solid #9cc0ff;
}
.badge-ok {
  background: #ecfdf3;
  color: #027a48;
  border: 1px solid #86efac;
}
.cell-missing {
  color: #b54708;
}
.cell-abnormal {
  color: #b42318;
  font-weight: 700;
}
.row-missing {
  background: #fffaf3;
}
.row-abnormal {
  background: #fef7f6;
}
.check-cell {
  min-width: 240px;
}
.issue-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.issue-reason {
  font-size: 12px;
  color: #475467;
}
.repeat-tag {
  margin-left: 6px;
  font-size: 11px;
  color: #1849a9;
  background: #eef4ff;
  border-radius: 999px;
  padding: 0 8px;
}
.warn-text {
  color: #b54708;
}
.ok-text {
  color: #027a48;
  margin: 0;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 20px 24px;
  width: 460px;
  max-height: 86vh;
  overflow: auto;
}
.modal-wide {
  width: 680px;
}
.modal h3 {
  margin: 0 0 6px;
}
.modal-tip {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--muted);
}
.modal-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.modal-form label span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 2px;
}
.modal-form input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.detail-table th {
  width: 200px;
}
.detail-check {
  margin: 12px 0;
}
</style>
