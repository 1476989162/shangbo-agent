<script setup lang="ts">
import { computed } from 'vue'
import type { ApprovalRequest } from '../stores/chat'
import {
  formatApprovalInput,
  isSecurityCriticalApproval as isCriticalApproval
} from './approvalPresentation'

const props = defineProps<{
  approval: ApprovalRequest
}>()

const emit = defineEmits<{
  decide: [approved: boolean, alwaysAllow: boolean]
}>()

const isSecurityCriticalApproval = computed(() => {
  return props.approval.severity === 'critical' || isCriticalApproval(props.approval.reason || '')
})

const canAlwaysAllow = computed(() => {
  return !isSecurityCriticalApproval.value && props.approval.autoApprovable
})

function prettyJson(value: unknown): string {
  return formatApprovalInput(value)
}
</script>

<template>
  <div class="approval" :class="{ 'critical-security-card': isSecurityCriticalApproval }">
    <div class="approval-head">
      <span class="approval-badge" :class="{ 'critical-badge': isSecurityCriticalApproval }">
        {{ isSecurityCriticalApproval ? '安全红线 · 必须人工确认' : '需要操作确认' }}
      </span>
      <span class="mono approval-tool">{{ approval.name }}</span>
    </div>
    <p class="approval-reason" :class="{ 'critical-text': isSecurityCriticalApproval }">
      {{ approval.reason }}
    </p>
    <pre class="approval-params mono">{{ prettyJson(approval.input) }}</pre>
    <div class="approval-actions">
      <button
        class="btn btn-primary"
        :class="{ 'btn-critical': isSecurityCriticalApproval }"
        @click="emit('decide', true, false)"
      >
        {{ isSecurityCriticalApproval ? '我已知晓风险，仍执行一次' : '允许这一次' }}
      </button>
      <button
        v-if="canAlwaysAllow"
        class="btn"
        @click="emit('decide', true, true)"
      >
        始终允许该工具
      </button>
      <button class="btn btn-danger" @click="emit('decide', false, false)">拒绝操作</button>
    </div>
  </div>
</template>

<style scoped>
.approval {
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
}

.approval-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.approval-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
}

.approval-tool {
  font-size: 12px;
}

.approval-reason {
  margin: 6px 0;
  font-size: 12px;
}

.approval-params {
  margin: 4px 0 8px;
  padding: 6px 8px;
  font-size: 11px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  max-height: 120px;
  overflow-y: auto;
}

.approval-actions {
  display: flex;
  gap: 8px;
}

.critical-security-card {
  border-color: #ef4444 !important;
  background: rgba(239, 68, 68, 0.08) !important;
  box-shadow: 0 4px 20px rgba(239, 68, 68, 0.15) !important;
}

.critical-badge {
  background: #ef4444 !important;
  color: #ffffff !important;
  padding: 2px 8px;
  border-radius: 4px;
}

.critical-text {
  color: #b91c1c !important;
  font-weight: 600;
}

.btn-critical {
  background: #ef4444 !important;
  border-color: #ef4444 !important;
  color: #ffffff !important;
}
</style>
