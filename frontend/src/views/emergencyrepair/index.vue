<template>
  <section class="page" data-module="emergencyrepair">
    <header class="page-head">
      <div>
        <h2>抢修处置管理</h2>
        <p class="page-desc">维护抢修记录，围绕抢修编号、故障管段、故障类型、影响面积做登记、筛选与状态流转；探漏上报的漏点先进入待复核清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记抢修记录</button>
        <button class="btn" type="button" @click="exportRows">导出抢修处置清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-warn': item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 探漏结果同步来的待复核清单：确认后进入既有抢修流程，退回则打回探漏复探 -->
    <section class="review-block">
      <h3 class="block-title">待复核清单（探漏上报）<span class="block-count">{{ reviewRows.length }} 条</span></h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>抢修编号</th>
            <th>来源探漏</th>
            <th>故障管段</th>
            <th>漏点数量</th>
            <th>漏点位置</th>
            <th>复核操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in reviewRows" :key="`review-${String(row.id)}`">
            <td>{{ row.抢修编号 }}</td>
            <td>{{ row.来源探漏 }}</td>
            <td>{{ row.故障管段 }}</td>
            <td>{{ row.漏点数量 ?? '—' }}</td>
            <td>{{ row.漏点位置 || '—' }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="resolve(Number(row.id), true)">复核确认（转待派修）</button>
              <button class="link link-danger" type="button" @click="resolve(Number(row.id), false)">复核退回（打回复探）</button>
            </td>
          </tr>
          <tr v-if="!reviewRows.length">
            <td colspan="6" class="empty-state">暂无待复核的探漏上报</td>
          </tr>
        </tbody>
      </table>
    </section>

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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-review': String(row.status) === '待复核' }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td><span class="status-pill" :class="`status-${String(row.status)}`">{{ row.status }}</span></td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
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
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
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
import { listReviewQueue, resolveReview } from '@/api/leak-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('emergencyrepair')
const columns = ['抢修编号', '故障管段', '故障类型', '影响面积', '抢修队', '到场时间', '恢复时间', '抢修状态']
const actions = ['派出抢修', '确认恢复', '上报升级']
const statuses = ['待复核', '待派修', '抢修中', '已恢复', '已升级']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const reviewRows = ref<EntryRow[]>([])

const stats = computed(() => [
  { label: '待复核漏点（探漏上报）', value: reviewRows.value.length, warn: reviewRows.value.length > 0 },
  { label: '待派修故障', value: rows.value.filter((row) => String(row.status) === '待派修').length, warn: false },
  { label: '抢修中故障', value: rows.value.filter((row) => String(row.status) === '抢修中').length, warn: false },
  {
    label: '本月恢复数',
    value: rows.value.filter((row) => String(row.status) === '已恢复' && String(row.恢复时间).startsWith(monthPrefix())).length,
    warn: false,
  },
])

function monthPrefix(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 待复核记录在主清单里不展示既有抢修动作（复核动作统一在待复核清单操作）。
function actionsFor(row: EntryRow): string[] {
  return String(row.status) === '待复核' ? [] : actions
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '抢修记录登记入口尚未接入审批流'
  successMessage.value = ''
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    successMessage.value = ''
    return
  }
  successMessage.value = result.message
  errorMessage.value = ''
  reload()
}

function resolve(id: number, pass: boolean) {
  const result = resolveReview(id, pass)
  if (!result.ok) {
    errorMessage.value = result.message
    successMessage.value = ''
    return
  }
  successMessage.value = result.message
  errorMessage.value = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    reviewRows.value = listReviewQueue()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '抢修处置列表读取失败'
  }
}

onMounted(reload)
</script>
