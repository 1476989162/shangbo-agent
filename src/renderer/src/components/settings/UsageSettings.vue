<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { UsageSummaryStats } from '@shared/types'

const emit = defineEmits<{
  feedback: [value: { ok: boolean; message: string }]
}>()

const usageDays = ref<7 | 30 | 90>(30)
const realUsageStats = ref<UsageSummaryStats | null>(null)
const budgetTokens = ref(32000)
const toolConcurrency = ref(4)

async function loadRealUsage(): Promise<void> {
  try {
    realUsageStats.value = await window.shangbo.usage.getStats(usageDays.value)
  } catch (error) {
    console.error('加载真实 Token 统计失败:', error)
  }
}

function formatTokensNumber(tokens: number): string {
  if (!tokens || tokens === 0) return '0'
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return String(tokens)
}

const maxDailyTokens = computed(() => {
  if (!realUsageStats.value || realUsageStats.value.dailyList.length === 0) return 1
  const max = Math.max(...realUsageStats.value.dailyList.map((d) => d.totalTokens))
  return max > 0 ? max : 1
})

async function saveBudgetTokens(): Promise<void> {
  await window.shangbo.settings.set('agent.contextBudgetTokens', Number(budgetTokens.value))
  emit('feedback', {
    ok: true,
    message: `已保存上下文预算上限: ${Number(budgetTokens.value).toLocaleString()} tokens`
  })
}

async function saveToolConcurrency(): Promise<void> {
  const normalized = Math.max(1, Math.min(16, Math.floor(Number(toolConcurrency.value) || 4)))
  toolConcurrency.value = normalized
  await window.shangbo.settings.set('agent.toolConcurrency', normalized)
  emit('feedback', { ok: true, message: `已保存工具并发上限: ${normalized}` })
}

onMounted(async () => {
  const settings = await window.shangbo.settings.getAll()
  budgetTokens.value = (settings['agent.contextBudgetTokens'] as number) ?? 32000
  toolConcurrency.value = (settings['agent.toolConcurrency'] as number) ?? 4
  await loadRealUsage()
})

watch(usageDays, () => {
  void loadRealUsage()
})
</script>

<template>
  <section class="content-pane">
    <div class="usage-head">
      <p class="usage-desc">
        本设备在对话协同与代码模式下的 Token 用量统计。实际费用按您配置的模型供应商官方费率结算。
      </p>
      <div class="days-toggle">
        <button
          class="day-btn"
          :class="{ active: usageDays === 7 }"
          @click="usageDays = 7"
        >
          7天
        </button>
        <button
          class="day-btn"
          :class="{ active: usageDays === 30 }"
          @click="usageDays = 30"
        >
          30天
        </button>
        <button
          class="day-btn"
          :class="{ active: usageDays === 90 }"
          @click="usageDays = 90"
        >
          90天
        </button>
      </div>
    </div>

    <!-- 真实三卡片统计展示 -->
    <div class="usage-metric-cards">
      <div class="metric-card">
        <div class="metric-title">协同模式 (Cowork)</div>
        <div class="metric-value">
          {{ formatTokensNumber(realUsageStats?.coworkTokens ?? 0) }}
          <span class="metric-unit">tokens</span>
        </div>
        <div class="metric-sub subtle">日常问答与多轮对话消耗</div>
      </div>

      <div class="metric-card">
        <div class="metric-title">代码模式 (Code)</div>
        <div class="metric-value">
          {{ formatTokensNumber(realUsageStats?.codeTokens ?? 0) }}
          <span class="metric-unit">tokens</span>
        </div>
        <div class="metric-sub subtle">
          {{ realUsageStats?.toolCallsCount ?? 0 }} 次工具与终端命令调用
        </div>
      </div>

      <div class="metric-card highlight-card">
        <div class="metric-title">近 {{ usageDays }} 天真实总消耗</div>
        <div class="metric-value">
          {{ formatTokensNumber(realUsageStats?.totalTokens ?? 0) }}
          <span class="metric-unit">tokens</span>
        </div>
        <div class="metric-sub subtle">
          输入: {{ formatTokensNumber(realUsageStats?.dailyList.reduce((acc, d) => acc + d.promptTokens, 0) ?? 0) }} ·
          输出: {{ formatTokensNumber(realUsageStats?.dailyList.reduce((acc, d) => acc + d.completionTokens, 0) ?? 0) }}
        </div>
      </div>
    </div>

    <!-- 每日用量图表 (Tokens per day) -->
    <div class="usage-chart-card">
      <div class="chart-header">
        <div class="chart-title-area">
          <h4 class="chart-heading">每日真实 Token 用量 (Tokens per day)</h4>
          <p class="chart-sub subtle">过去 {{ usageDays }} 天各模式输入与输出真实统计 (无任何虚拟数据)</p>
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-box cowork-box" /> 协同模式</span>
          <span class="legend-item"><span class="legend-box code-box" /> 代码模式</span>
        </div>
      </div>

      <!-- 直方柱状图 -->
      <div class="histogram-wrapper">
        <div class="histogram-bars">
          <div
            v-for="(day, index) in (realUsageStats?.dailyList ?? [])"
            :key="index"
            class="histogram-col"
            :title="`${day.fullDate} | 协同: ${day.coworkTokens} tokens, 代码: ${day.codeTokens} tokens (合计: ${day.totalTokens})`"
          >
            <div class="bar-stack">
              <div
                class="bar-segment code-segment"
                :style="{
                  height: `${day.codeTokens > 0 ? Math.max(3, Math.round((day.codeTokens / maxDailyTokens) * 95)) : 0}px`
                }"
              />
              <div
                class="bar-segment cowork-segment"
                :style="{
                  height: `${day.coworkTokens > 0 ? Math.max(3, Math.round((day.coworkTokens / maxDailyTokens) * 95)) : 0}px`
                }"
              />
              <!-- 当天无数据时的占位小底线 -->
              <div v-if="day.totalTokens === 0" class="bar-empty-dot" />
            </div>
            <span v-if="index % Math.ceil(usageDays / 8) === 0 || index === (realUsageStats?.dailyList.length ?? 0) - 1" class="date-label">
              {{ day.date }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 上下文 Token 预算与安全控制 (回答“能不能设置用了多少token”) -->
    <div class="section-block">
      <h4 class="pane-title">上下文 Token 预算与防耗控制</h4>
      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">单会话上下文预算上限 (Context Window Budget)</span>
          <span class="row-sub">当对话历史累积接近该阈值时，自动压缩早期的工具细节与中间推理，保护 Token 额度并防止溢出</span>
        </div>
        <select v-model="budgetTokens" class="select-control" @change="saveBudgetTokens">
          <option :value="16000">16,000 tokens (轻量经济)</option>
          <option :value="32000">32,000 tokens (标准默认)</option>
          <option :value="64000">64,000 tokens (中等代码库)</option>
          <option :value="128000">128,000 tokens (大型项目工程)</option>
          <option :value="200000">200,000 tokens (Claude 原生满血)</option>
          <option :value="1000000">1,000,000 tokens (1M 极限长文本)</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">只读工具并发上限</span>
          <span class="row-sub">
            同一批读取、搜索与目录列举可并行执行；写入与命令始终串行。范围 1-16，默认 4。
          </span>
        </div>
        <input
          v-model.number="toolConcurrency"
          class="submodal-input"
          type="number"
          min="1"
          max="16"
          @blur="saveToolConcurrency"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.content-pane {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.pane-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}

.section-block {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-sub {
  font-size: 12px;
  color: var(--text-subtle);
}

.select-control {
  padding: 6px 12px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text);
  outline: none;
}

.submodal-input {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text);
  box-sizing: border-box;
}

.submodal-input:focus {
  border-color: var(--primary, #d97757);
  outline: none;
}

.usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.usage-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-muted);
  max-width: 65%;
}

.days-toggle {
  display: inline-flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
}

.day-btn {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.day-btn.active {
  background: var(--bg-elevated);
  color: var(--text);
  font-weight: 600;
}

.usage-metric-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.metric-card {
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metric-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
}

.metric-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text);
}

.metric-unit {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-subtle);
}

.usage-chart-card {
  padding: 18px 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chart-heading {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}

.chart-sub {
  margin: 2px 0 0;
  font-size: 11px;
}

.chart-legend {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-muted);
}

.legend-box {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.cowork-box {
  background: #d97757;
}

.code-box {
  background: #2f7d5d;
}

.histogram-wrapper {
  height: 140px;
  display: flex;
  align-items: flex-end;
  border-bottom: 1px solid var(--border-strong);
  padding-bottom: 4px;
}

.histogram-bars {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  width: 100%;
  height: 100%;
  gap: 3px;
}

.histogram-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  position: relative;
}

.bar-stack {
  width: 100%;
  max-width: 14px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 1px;
}

.bar-segment {
  width: 100%;
  border-radius: 2px;
  min-height: 2px;
}

.code-segment {
  background: #2f7d5d;
}

.cowork-segment {
  background: #d97757;
}

.date-label {
  position: absolute;
  bottom: -18px;
  font-size: 9.5px;
  color: var(--text-subtle);
  white-space: nowrap;
}
</style>
