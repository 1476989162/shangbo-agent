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

const hasLegacyUsage = computed(() => (realUsageStats.value?.legacyTokens ?? 0) > 0)
const hasFallbackUsage = computed(() => (realUsageStats.value?.fallbackUsageRows ?? 0) > 0)
const hasZeroInputUsage = computed(() => (realUsageStats.value?.zeroInputUsageRows ?? 0) > 0)

function barHeight(tokens: number): number {
  if (tokens <= 0) return 0
  return Math.max(2, Math.round((tokens / maxDailyTokens.value) * 95))
}

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
        本设备从本地会话数据库聚合的真实 Token 用量。累计输入包含多步工具循环中重复发送的上下文，
        与单次请求的上下文规模不是同一个指标；实际费用按模型供应商官方费率结算。
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

    <!-- 统一采用“整轮累计输入 + 输出”的计费口径，三个数字可以直接相加核对 -->
    <div class="usage-metric-cards">
      <div class="metric-card highlight-card">
        <div class="metric-title">近 {{ usageDays }} 天累计消耗</div>
        <div class="metric-value">
          {{ formatTokensNumber(realUsageStats?.totalTokens ?? 0) }}
          <span class="metric-unit">tokens</span>
        </div>
        <div class="metric-sub subtle">
          {{ realUsageStats?.toolCallsCount ?? 0 }} 次工具调用 · 输入与输出合计
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-title">累计输入</div>
        <div class="metric-value">
          {{ formatTokensNumber(realUsageStats?.promptTokens ?? 0) }}
          <span class="metric-unit">tokens</span>
        </div>
        <div class="metric-sub subtle">多步工具循环中的上下文重发已计入</div>
      </div>

      <div class="metric-card">
        <div class="metric-title">累计输出</div>
        <div class="metric-value">
          {{ formatTokensNumber(realUsageStats?.completionTokens ?? 0) }}
          <span class="metric-unit">tokens</span>
        </div>
        <div class="metric-sub subtle">模型实际生成的正文、思考与工具参数</div>
      </div>
    </div>

    <!-- 模式分类只使用发送时真实落库的 viewMode；旧数据不猜，单独列出 -->
    <div class="mode-breakdown">
      <div class="mode-item">
        <span class="mode-label"><span class="legend-box cowork-box" /> 协同模式</span>
        <strong>{{ formatTokensNumber(realUsageStats?.coworkTokens ?? 0) }}</strong>
      </div>
      <div class="mode-item">
        <span class="mode-label"><span class="legend-box code-box" /> 代码模式</span>
        <strong>{{ formatTokensNumber(realUsageStats?.codeTokens ?? 0) }}</strong>
      </div>
      <div v-if="hasLegacyUsage" class="mode-item">
        <span class="mode-label"><span class="legend-box legacy-box" /> 旧记录未分类</span>
        <strong>{{ formatTokensNumber(realUsageStats?.legacyTokens ?? 0) }}</strong>
      </div>
    </div>

    <p v-if="hasLegacyUsage" class="data-note">
      有 {{ realUsageStats?.legacyModeRows ?? 0 }} 条历史消息产生于模式记录上线前，无法可靠还原当时选择的是协同还是代码，
      因此单列为“旧记录未分类”，不会强行计入任一模式。之后的新消息会按发送时的真实模式统计。
    </p>
    <p v-if="hasFallbackUsage" class="data-note">
      另有 {{ realUsageStats?.fallbackUsageRows ?? 0 }} 条旧消息缺少完整的整轮输入 / 输出拆分，
      已按现有末次请求数据回退统计；因此历史总量可能低于实际计费量。
    </p>
    <p v-if="hasZeroInputUsage" class="data-note">
      有 {{ realUsageStats?.zeroInputUsageRows ?? 0 }} 条记录只有输出、输入为 0。若供应商未返回输入用量，
      应用无法凭空补算，这部分只会显示已知的输出。
    </p>

    <!-- 每日累计用量图表 (Tokens per day) -->
    <div class="usage-chart-card">
      <div class="chart-header">
        <div class="chart-title-area">
          <h4 class="chart-heading">每日累计 Token 用量</h4>
          <p class="chart-sub subtle">
            过去 {{ usageDays }} 天按整轮输入 + 输出聚合，单位 tokens
          </p>
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-box cowork-box" /> 协同模式</span>
          <span class="legend-item"><span class="legend-box code-box" /> 代码模式</span>
          <span v-if="hasLegacyUsage" class="legend-item">
            <span class="legend-box legacy-box" /> 旧记录未分类
          </span>
        </div>
      </div>

      <!-- 直方柱状图 -->
      <div class="histogram-wrapper">
        <div class="histogram-bars">
          <div
            v-for="(day, index) in (realUsageStats?.dailyList ?? [])"
            :key="index"
            class="histogram-col"
            :title="`${day.fullDate} | 输入: ${day.promptTokens}, 输出: ${day.completionTokens}, 合计: ${day.totalTokens} tokens`"
          >
            <div class="bar-stack">
              <div
                class="bar-segment code-segment"
                :style="{
                  height: `${barHeight(day.codeTokens)}px`
                }"
              />
              <div
                class="bar-segment cowork-segment"
                :style="{
                  height: `${barHeight(day.coworkTokens)}px`
                }"
              />
              <div
                class="bar-segment legacy-segment"
                :style="{
                  height: `${barHeight(day.legacyTokens)}px`
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
  border-color: var(--primary);
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

@media (max-width: 900px) {
  .usage-metric-cards {
    grid-template-columns: 1fr;
  }
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

.highlight-card {
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--primary) 10%, transparent), transparent 70%),
    var(--surface);
  border-color: color-mix(in srgb, var(--primary) 34%, var(--border));
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

.mode-breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.mode-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.mode-item strong {
  color: var(--text);
  font-size: 13px;
}

.mode-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.data-note {
  margin: -8px 0 0;
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  border-left: 2px solid var(--border-strong);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
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
  background: var(--accent);
}

.code-box {
  background: #2f7d5d;
}

.legacy-box {
  background: #8a8f98;
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
  background: var(--accent);
}

.legacy-segment {
  background: #8a8f98;
}

.bar-empty-dot {
  width: 100%;
  height: 2px;
  border-radius: 2px;
  background: var(--border);
}

.date-label {
  position: absolute;
  bottom: -18px;
  font-size: 9.5px;
  color: var(--text-subtle);
  white-space: nowrap;
}
</style>
