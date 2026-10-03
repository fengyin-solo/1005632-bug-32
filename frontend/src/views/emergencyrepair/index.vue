<template>
  <section class="page" data-module="emergencyrepair">
    <header class="page-head">
      <div>
        <h2>抢修处置管理</h2>
        <p class="page-desc">维护抢修记录，围绕抢修编号、故障管段、故障类型、影响面积做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记抢修记录</button>
        <button class="btn" type="button" @click="exportRows">导出抢修处置清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="review-panel">
      <h3>待复核清单（管网探漏处理结果同步）</h3>
      <p class="review-desc">探漏确认处理且发现漏点的记录自动同步到这里，复核通过后转入「待派修」，走既有抢修流程。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>抢修编号</th>
            <th>来源探漏编号</th>
            <th>故障管段</th>
            <th>故障类型</th>
            <th>探漏漏点数量</th>
            <th>探漏位置</th>
            <th>同步时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reviewRows" :key="String(item.id)">
            <td>{{ item['抢修编号'] }}</td>
            <td>{{ item['来源探漏编号'] }}</td>
            <td>{{ item['故障管段'] }}</td>
            <td>{{ item['故障类型'] }}</td>
            <td>{{ item['探漏漏点数量'] }}</td>
            <td>{{ item['探漏位置'] }}</td>
            <td>{{ item['同步时间'] }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="approveReview(item)">复核通过</button>
            </td>
          </tr>
          <tr v-if="!reviewRows.length">
            <td colspan="8" class="empty-state">暂无探漏同步的待复核记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无抢修处置数据，可先登记抢修记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条抢修处置记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { approveRepairReview, listRepairReviews, REVIEW_STATUS } from '@/api/leak-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('emergencyrepair')
const columns = ["抢修编号", "故障管段", "故障类型", "影响面积", "抢修队", "到场时间", "恢复时间", "抢修状态"]
const actions = ["派出抢修", "确认恢复", "上报升级"]
const statuses = ["待复核", "待派修", "抢修中", "已恢复", "已升级"]
const stats = [{"label": "待复核（探漏同步）", "value": 0}, {"label": "待派修故障", "value": 0}, {"label": "抢修中故障", "value": 0}]

const rows = ref<EntryRow[]>([])
const reviewRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const reviewCount = computed(() => reviewRows.value.length)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count:
      status === REVIEW_STATUS
        ? reviewCount.value
        : rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const statCards = computed(() => [
  { label: '待复核（探漏同步）', value: reviewCount.value },
  {
    label: '待派修故障',
    value: rows.value.filter((row) => String(row.status) === '待派修').length,
  },
  {
    label: '抢修中故障',
    value: rows.value.filter((row) => String(row.status) === '抢修中').length,
  },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '抢修记录登记入口尚未接入审批流'
}

function approveReview(item: EntryRow) {
  errorMessage.value = ''
  const result = approveRepairReview(Number(item.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    reviewRows.value = listRepairReviews()
    // 待复核记录单独成区，主清单只呈现已进入抢修流程的记录，两处数量不重复计。
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items.filter((row) => String(row.status) !== REVIEW_STATUS)
    total.value = rows.value.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '抢修处置列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.review-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.review-panel h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.review-desc {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--muted);
}
</style>
