<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { drawQr } from '../../lib/qrcode'

const emit = defineEmits<{
  feedback: [value: { ok: boolean; message: string }]
}>()

/* ------------------------------------------------------------------ */
/* 手机远程：开关 / 中转地址 / 审批策略 / 配对 / 设备管理               */
/* （自 SettingsDialog.vue 迁出，逻辑与模板逐字搬运）                  */
/* ------------------------------------------------------------------ */
interface RemoteDevice {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
}
const remoteEnabled = ref(false)
const remoteRelayUrl = ref('')
const remoteAccessKey = ref('')
const remoteApprovalPolicy = ref<'allow-all' | 'confirm-high' | 'read-only'>('allow-all')
const remoteStatusText = ref('未开启')
const remotePairing = ref<{ qrText: string; code: string; expiresAt: number; fingerprint: string } | null>(null)
const remoteDevices = ref<RemoteDevice[]>([])
const remoteIdentityFp = ref('')
const remoteBusy = ref(false)
interface RemotePendingPairing {
  deviceName: string
  phonePubB64: string
  phoneToken: string
  fingerprint: string
  receivedAt: number
}
const remotePending = ref<RemotePendingPairing[]>([])
const remotePairingBusy = ref(false)
/** 待确认配对轮询：只在手机远程页挂载时跑，卸载即停。 */
let remotePendingTimer: ReturnType<typeof setInterval> | null = null
/** 配对二维码画布：生成配对码后绘制 qrText，手机扫码直达配对页。 */
const qrCanvas = ref<HTMLCanvasElement | null>(null)
const qrFailed = ref(false)

async function loadRemote(): Promise<void> {
  try {
    const st = await window.shangbo.remote.status()
    remoteEnabled.value = st.enabled
    remoteStatusText.value = st.enabled ? `状态：${st.status}${st.detail ? `（${st.detail}）` : ''}` : '未开启'
  } catch {
    remoteStatusText.value = '读取失败'
  }
  try {
    remoteDevices.value = await window.shangbo.remote.devices()
    try {
      remotePending.value = await window.shangbo.remote.pending()
    } catch {
      remotePending.value = []
    }
  } catch {
    remoteDevices.value = []
  }
  try {
    // 本机身份指纹：填到中转 RELAY_ALLOWED_DESKTOPS 后，中转只服务这一台桌面
    remoteIdentityFp.value = (await window.shangbo.remote.identity()).fingerprint
  } catch {
    remoteIdentityFp.value = ''
  }
}

async function toggleRemoteEnabled(): Promise<void> {
  await window.shangbo.settings.set('remote.enabled', remoteEnabled.value)
  emit('feedback', {
    ok: true,
    message: remoteEnabled.value ? '手机远程已开启：桌面开始连接中转' : '手机远程已关闭：不再产生任何外网连接'
  })
  await loadRemote()
}

async function saveRemoteRelayUrl(): Promise<void> {
  await window.shangbo.settings.set('remote.relayUrl', remoteRelayUrl.value.trim())
  emit('feedback', { ok: true, message: '中转地址已保存' })
}

async function saveRemoteAccessKey(): Promise<void> {
  await window.shangbo.settings.set('remote.accessKey', remoteAccessKey.value.trim())
  emit('feedback', {
    ok: true,
    message: remoteAccessKey.value.trim()
      ? '准入密钥已保存：中转必须设置同一个 RELAY_ACCESS_KEY，否则会被拒绝'
      : '准入密钥已清空：该中转对任何拿到地址的人开放'
  })
}

async function saveRemotePolicy(): Promise<void> {
  await window.shangbo.settings.set('remote.approvalPolicy', remoteApprovalPolicy.value)
  emit('feedback', { ok: true, message: '远程审批策略已更新' })
}

async function issueRemotePairing(): Promise<void> {
  if (!remoteEnabled.value) {
    emit('feedback', { ok: false, message: '请先开启手机远程' })
    return
  }
  remoteBusy.value = true
  try {
    remotePairing.value = await window.shangbo.remote.pair()
    emit('feedback', { ok: true, message: '配对码已生成：用手机扫码或手动输入配对码' })
    // 配对区 canvas 可能刚挂载，下一帧再画
    qrFailed.value = false
    await nextTick()
    const canvas = qrCanvas.value
    if (canvas && remotePairing.value) {
      qrFailed.value = !drawQr(canvas, remotePairing.value.qrText, 5)
    } else {
      qrFailed.value = true
    }
  } catch (error) {
    emit('feedback', { ok: false, message: error instanceof Error ? error.message : '配对失败' })
  } finally {
    remoteBusy.value = false
  }
}

async function revokeRemoteDevice(id: string): Promise<void> {
  if (!confirm('确定吊销这台手机？吊销后其连接立即断开。')) return
  const ok = await window.shangbo.remote.revoke(id)
  emit('feedback', ok ? { ok: true, message: '已吊销' } : { ok: false, message: '吊销失败' })
  await loadRemote()
}

async function refreshRemotePending(): Promise<void> {
  try {
    remotePending.value = await window.shangbo.remote.pending()
  } catch {
    /* 忽略轮询抖动，下次再试 */
  }
}

function startRemotePendingPoll(): void {
  stopRemotePendingPoll()
  void refreshRemotePending()
  remotePendingTimer = setInterval(() => {
    void refreshRemotePending()
  }, 3000)
}

function stopRemotePendingPoll(): void {
  if (remotePendingTimer) {
    clearInterval(remotePendingTimer)
    remotePendingTimer = null
  }
}

async function confirmRemotePairing(phoneToken: string): Promise<void> {
  remotePairingBusy.value = true
  try {
    await window.shangbo.remote.confirmPairing(phoneToken)
    emit('feedback', { ok: true, message: '已确认配对：手机马上就能连上' })
  } catch (error) {
    emit('feedback', { ok: false, message: error instanceof Error ? error.message : '确认配对失败' })
  } finally {
    remotePairingBusy.value = false
    await loadRemote()
  }
}

async function denyRemotePairing(phoneToken: string): Promise<void> {
  if (!confirm('拒绝这次配对请求？对方手机将立即断开。')) return
  try {
    await window.shangbo.remote.denyPairing(phoneToken)
    emit('feedback', { ok: true, message: '已拒绝配对请求' })
  } catch (error) {
    emit('feedback', { ok: false, message: error instanceof Error ? error.message : '拒绝失败' })
  } finally {
    await loadRemote()
  }
}

async function disconnectRemoteAll(): Promise<void> {
  if (!confirm('立即断开所有远程设备并关闭远程功能？')) return
  await window.shangbo.remote.disconnect()
  remoteEnabled.value = false
  remotePairing.value = null
  emit('feedback', { ok: true, message: '已断开所有远程设备并关闭远程功能' })
  await loadRemote()
}

onMounted(async () => {
  try {
    const settings = await window.shangbo.settings.getAll()
    remoteEnabled.value = (settings['remote.enabled'] as boolean) ?? false
    remoteRelayUrl.value = (settings['remote.relayUrl'] as string) ?? ''
    remoteAccessKey.value = (settings['remote.accessKey'] as string) ?? ''
    remoteApprovalPolicy.value =
      (settings['remote.approvalPolicy'] as 'allow-all' | 'confirm-high' | 'read-only') ?? 'allow-all'
  } catch {
    /* 读不到就用默认值 */
  }
  await loadRemote()
  startRemotePendingPoll()
})

onBeforeUnmount(() => {
  stopRemotePendingPoll()
})
</script>

<template>
  <section class="content-pane">
    <div class="section-block">
      <h3 class="pane-title">手机远程</h3>
      <p class="row-sub">
        在外网用手机查看会话、发消息、批准高危命令。桌面主动外连中转服务，两边都不用开放端口；
        所有业务经端到端加密，中转只转发密文。默认关闭，开启后才产生外网连接。
      </p>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">开启手机远程</span>
          <span class="row-sub">{{ remoteStatusText }}</span>
        </div>
        <label class="switch-control">
          <input v-model="remoteEnabled" type="checkbox" @change="toggleRemoteEnabled" />
          <span class="switch-slider" />
        </label>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">中转地址</span>
          <span class="row-sub">wss:// 开头。留空则不连接；可填自己的自建中转（relay/docker-compose.yml 一键启动）。</span>
        </div>
      </div>
      <div class="setting-row">
        <input
          v-model="remoteRelayUrl"
          type="text"
          class="select-control mono"
          placeholder="wss://relay.example.com"
          style="flex: 1"
        />
        <button class="btn btn-ghost tiny" @click="saveRemoteRelayUrl">保存</button>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">中转准入密钥</span>
          <span class="row-sub">
            与中转服务器的 <code class="mono">RELAY_ACCESS_KEY</code> 一致。设置后，别人即使知道你的中转地址也注册不了房间，用不了你的公网。
            留空 = 你的中转对任何拿到地址的人开放（只建议本机调试）。
          </span>
        </div>
      </div>
      <div class="setting-row">
        <input
          v-model="remoteAccessKey"
          type="password"
          class="select-control mono"
          placeholder="留空表示不设准入"
          style="flex: 1"
          autocomplete="new-password"
        />
        <button class="btn btn-ghost tiny" @click="saveRemoteAccessKey">保存</button>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">只允许本机使用（推荐）</span>
          <span class="row-sub">
            本机身份指纹：<strong class="mono">{{ remoteIdentityFp || '读取中…' }}</strong>
            <br />
            把它填到中转服务器的 <code class="mono">RELAY_ALLOWED_DESKTOPS</code>，中转就只接受这一台桌面。
            别人即使知道地址、抄走公钥，没有私钥也签不出有效签名，连注册都过不去。
          </span>
        </div>
      </div>
      <div class="setting-row">
        <div class="row-text">
          <span class="row-sub">
            中转端设置：<code class="mono">RELAY_ALLOWED_DESKTOPS={{ remoteIdentityFp || '本机指纹' }}</code>
            ，重启中转生效。指纹是公钥摘要，可以安全外露。
          </span>
        </div>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">远程审批策略</span>
          <span class="row-sub">允许所有 / 高危回桌面确认 / 完全只读（只能看不能操作）。</span>
        </div>
        <select v-model="remoteApprovalPolicy" class="select-control" @change="saveRemotePolicy">
          <option value="allow-all">允许所有审批</option>
          <option value="confirm-high">高危必须回桌面确认</option>
          <option value="read-only">完全只读</option>
        </select>
      </div>
    </div>

    <div class="divider" />

    <div class="section-block">
      <h3 class="pane-title">配对新手机</h3>
      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">一次性配对码</span>
          <span class="row-sub">5 分钟有效、只能用一次。手机扫码会打开配对页并自动填写地址、配对码与桌面公钥。</span>
        </div>
        <button class="btn btn-primary tiny" :disabled="remoteBusy || !remoteEnabled" @click="issueRemotePairing">
          {{ remoteBusy ? '生成中…' : '生成配对码' }}
        </button>
      </div>
      <div v-if="remotePairing" class="remote-pair-box">
        <div class="remote-qr">
          <canvas ref="qrCanvas" class="remote-qr-canvas" />
          <p v-if="qrFailed" class="row-sub">二维码绘制失败，请手动输入配对码。</p>
        </div>
        <div class="info-grid">
          <div class="info-item"><span class="info-k">配对码:</span> <span class="info-v mono remote-code">{{ remotePairing.code }}</span></div>
          <div class="info-item"><span class="info-k">桌面公钥指纹:</span> <span class="info-v mono">{{ remotePairing.fingerprint }}</span></div>
          <div class="info-item"><span class="info-k">有效期至:</span> <span class="info-v">{{ new Date(remotePairing.expiresAt).toLocaleString() }}</span></div>
        </div>
      </div>
    </div>

    <div class="divider" />

    <div class="section-block">
      <h3 class="pane-title">待确认的配对请求（{{ remotePending.length }}）</h3>
      <p class="row-sub">手机扫码后在这里点确认，对方才能连上。5 分钟有效先核对手机上显示的公钥指纹再点。</p>
      <div v-if="remotePending.length === 0" class="row-sub">暂无待确认请求。</div>
      <div v-for="p in remotePending" :key="p.phoneToken" class="setting-row">
        <div class="row-text">
          <span class="setting-label">{{ p.deviceName || '未命名手机' }}</span>
          <span class="row-sub">指纹 <code class="mono">{{ p.fingerprint }}</code> · {{ new Date(p.receivedAt).toLocaleString() }}</span>
        </div>
        <button class="btn btn-ghost tiny btn-danger" :disabled="remotePairingBusy" @click="denyRemotePairing(p.phoneToken)">拒绝</button>
        <button class="btn btn-primary tiny" :disabled="remotePairingBusy" @click="confirmRemotePairing(p.phoneToken)">确认配对</button>
      </div>
    </div>

    <div class="divider" />

    <div class="section-block">
      <h3 class="pane-title">已配对手机（{{ remoteDevices.length }}）</h3>
      <div v-if="remoteDevices.length === 0" class="row-sub">暂无已配对手机。</div>
      <div v-for="d in remoteDevices" :key="d.id" class="setting-row">
        <div class="row-text">
          <span class="setting-label">{{ d.name || '未命名手机' }}</span>
          <span class="row-sub">配对 {{ new Date(d.createdAt).toLocaleString() }} · 上次在线 {{ d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '从未' }}</span>
        </div>
        <button class="btn btn-ghost tiny btn-danger" @click="revokeRemoteDevice(d.id)">吊销</button>
      </div>
      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">一键断开</span>
          <span class="row-sub">立即断开所有远程设备并关闭远程功能。</span>
        </div>
        <button class="btn btn-ghost tiny btn-danger" @click="disconnectRemoteAll">立即断开</button>
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


.divider {
  height: 1px;
  background: var(--border);
  margin: 6px 0;
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

.switch-control {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
}


.switch-control input {
  opacity: 0;
  width: 0;
  height: 0;
}


.switch-slider {
  position: absolute;
  inset: 0;
  background: var(--border-strong);
  border-radius: 20px;
  transition: 0.2s;
}


.switch-slider:before {
  position: absolute;
  content: '';
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background: white;
  border-radius: 50%;
  transition: 0.2s;
}


.switch-control input:checked + .switch-slider {
  background: var(--accent);
}


.switch-control input:checked + .switch-slider:before {
  transform: translateX(16px);
}


.field-label {
  font-size: 12px;
  font-weight: 500;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 12px;
  background: var(--surface);
  border-radius: var(--radius);
  font-size: 12.5px;
}


.info-item {
  display: flex;
  gap: 6px;
}


.info-k {
  color: var(--text-muted);
}


.submodal-spacer {
  flex: 1;
}

.switch-control {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  cursor: pointer;
}


.switch-control input {
  opacity: 0;
  width: 0;
  height: 0;
}


.switch-slider {
  position: absolute;
  inset: 0;
  background: var(--border-strong);
  border-radius: 20px;
  transition: all 0.2s ease;
}


.switch-slider::before {
  position: absolute;
  content: '';
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background: #ffffff;
  border-radius: 50%;
  transition: all 0.2s ease;
}


.switch-control input:checked + .switch-slider {
  background: var(--success);
}


.switch-control input:checked + .switch-slider::before {
  transform: translateX(16px);
}

.submodal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
}


.submodal-card {
  width: 480px;
  max-width: 90vw;
  background: var(--bg-elevated, #ffffff);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 20px 22px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
  animation: popupSlideUp 0.15s ease-out;
}


.submodal-wide {
  width: 580px;
}


.submodal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}


.submodal-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}


.btn-submodal-close {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-muted);
  line-height: 1;
}


.btn-submodal-close:hover {
  color: var(--text);
}


.submodal-tip {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 14px 0;
  line-height: 1.45;
}


.submodal-textarea {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12.5px;
  color: var(--text);
  resize: vertical;
  font-family: inherit;
  margin-bottom: 16px;
  box-sizing: border-box;
}


.submodal-textarea:focus,

.submodal-input:focus {
  border-color: var(--primary);
  outline: none;
}


.submodal-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}


.submodal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}


.field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
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


.submodal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}


.wish-field .submodal-textarea,

.wish-field .submodal-input {
  margin-bottom: 0;
}


.wish-path-row .submodal-input {
  flex: 1;
  min-width: 0;
}
</style>
