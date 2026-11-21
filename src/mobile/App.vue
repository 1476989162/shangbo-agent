<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { MobileLink, type MobileCredentials } from './link'
import { createPairingSession, type PairingSession } from './pairing'

/* 尚搏远程手机端：与桌面同一套会话/消息/审批，只是装进口袋。
 * 布局按手机优先：会话横滑切换、消息气泡、底部输入、审批置顶。 */

interface ChatMessage {
  id: string
  role: string
  blocks: { type: string; text?: string; name?: string; input?: unknown; content?: string; isError?: boolean; image?: { dataUrl?: string } }[]
  status?: string
}

interface Conversation {
  id: string
  title: string
  updatedAt: number
}

interface PendingApproval {
  runId: string
  toolUseId: string
  conversationId: string
  toolName: string
  input: unknown
  reason: string
  remainingMs: number
  severity?: 'normal' | 'critical'
}

const DB_KEY = 'shangbo-remote-creds'

function loadCreds(): MobileCredentials | null {
  try {
    const raw = localStorage.getItem(DB_KEY)
    return raw ? (JSON.parse(raw) as MobileCredentials) : null
  } catch {
    return null
  }
}

function saveCreds(c: MobileCredentials): void {
  localStorage.setItem(DB_KEY, JSON.stringify(c))
}

const screen = ref<'pair' | 'main'>('pair')
const relayUrl = ref('')
const pairCode = ref('')
const desktopPub = ref('')
const desktopFingerprint = ref('')
const status = ref('未连接')
const online = computed(() => status.value === 'online' || status.value.startsWith('online'))
const conversations = ref<Conversation[]>([])
const activeId = ref<string | null>(null)
const messages = ref<ChatMessage[]>([])
const input = ref('')
const approvals = ref<PendingApproval[]>([])
const busy = ref(false)
const sending = ref(false)
const opError = ref('')
const confirmHigh = ref<{ a: PendingApproval } | null>(null)
const msgsBox = ref<HTMLElement | null>(null)
let link: MobileLink | null = null
let pairingSession: PairingSession | null = null
let msgTimer: number | null = null

const activeConv = computed(() => conversations.value.find((c) => c.id === activeId.value) ?? null)

/** 构建标识：取当前 JS 文件名里的 hash，核对手机装的是不是最新包。 */
const buildTag = computed(() => {
  try {
    const m = /index-([A-Za-z0-9_-]+)\.js/.exec(import.meta.url)
    return m ? m[1] : 'dev'
  } catch {
    return 'dev'
  }
})

function setStatus(s: string, d?: string): void {
  status.value = d ? `${s}（${d}）` : s
}

function showError(e: unknown, fallback: string): void {
  opError.value = e instanceof Error ? `${fallback}：${e.message}` : `${fallback}`
}

function scrollBottom(): void {
  void nextTick(() => {
    const el = msgsBox.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(messages, () => scrollBottom())

async function ensureLink(creds: MobileCredentials, announcePairing = false): Promise<MobileLink> {
  if (link) link.disconnect()
  link = new MobileLink(creds, announcePairing)
  link.onStatus = setStatus
  link.onPush = (event: unknown) => {
    const e = event as {
      type?: string
      conversationId?: string
      messageId?: string
      text?: string
    } | null
    if (!e || typeof e !== 'object') return
    if ((e.type === 'text_delta' || e.type === 'reasoning_delta') && e.messageId) {
      const m = messages.value.find((x) => x.id === e.messageId)
      if (m) {
        const last = m.blocks[m.blocks.length - 1]
        if (last?.type === 'text' && e.type === 'text_delta') last.text = (last.text ?? '') + (e.text ?? '')
        else m.blocks.push({ type: 'text', text: e.text ?? '' })
        scrollBottom()
      } else if (e.conversationId === activeId.value) {
        void openConversation(activeId.value!, true)
      }
    } else if (e.type === 'approval_required') {
      void refreshApprovals()
    } else if (e.type === 'message_done' || e.type === 'run_end') {
      if (e.conversationId === activeId.value) void openConversation(activeId.value!, true)
      void refreshApprovals()
    }
  }
  await link.connect()
  if (announcePairing) {
    if (link.wasPairAcknowledged()) setStatus('online', '配对完成')
    else setStatus('已提交配对信息', '等待桌面确认')
  }
  return link
}

async function pair(): Promise<void> {
  busy.value = true
  opError.value = ''
  try {
    const url = relayUrl.value.trim()
    const code = pairCode.value.trim()
    if (!/^wss:\/\//i.test(url)) throw new Error('中转地址必须为 wss://')
    if (!code) throw new Error('请输入配对码')
    if (!desktopPub.value) throw new Error('请扫描桌面二维码或填写桌面公钥')
    pairingSession = createPairingSession(desktopPub.value)
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    const token: { roomId: string; phoneToken: string } = await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        ws.close()
        reject(new Error('配对超时'))
      }, 15000)
      ws.onopen = () => ws.send(JSON.stringify({ op: 'pair-redeem', code, phoneName: '手机' }))
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { ok?: boolean; data?: { roomId: string; phoneToken: string }; error?: string }
          clearTimeout(timer)
          if (msg.ok && msg.data) resolve(msg.data)
          else reject(new Error(msg.error || '配对失败'))
        } catch (e) {
          clearTimeout(timer)
          reject(e instanceof Error ? e : new Error('配对失败'))
        }
      }
      ws.onerror = () => {
        clearTimeout(timer)
        ws.close()
        reject(new Error('连接失败'))
      }
    })
    ws.close()
    const creds: MobileCredentials = {
      relayUrl: url,
      phoneToken: token.phoneToken,
      sessionKeyB64: pairingSession.sessionKeyB64,
      deviceName: '手机',
      phonePubB64: pairingSession.phonePublicKeyB64
    }
    await boot(creds, true)
    saveCreds(creds)
    desktopPub.value = ''
    pairCode.value = ''
  } catch (e) {
    showError(e, '配对失败')
  } finally {
    busy.value = false
  }
}

async function refreshConversations(silent = false): Promise<void> {
  if (!link) return
  try {
    const list = (await link.request<Conversation[]>('listConversations', {})) ?? []
    conversations.value = list
    if (!list.some((c) => c.id === activeId.value)) {
      activeId.value = list[0]?.id ?? null
      if (activeId.value) await openConversation(activeId.value, true)
      else messages.value = []
    }
    if (!silent) opError.value = ''
  } catch (e) {
    if (!silent) showError(e, '拉取会话失败')
  }
}

async function openConversation(id: string, silent = false): Promise<void> {
  if (!link) return
  activeId.value = id
  try {
    const data = (await link.request<{ messages: ChatMessage[] }>('getMessages', { conversationId: id })) as {
      messages: ChatMessage[]
    }
    messages.value = data.messages ?? []
    if (!silent) opError.value = ''
    scrollBottom()
  } catch (e) {
    if (!silent) showError(e, '读取记录失败')
  }
}

async function newConversation(): Promise<void> {
  if (!link || busy.value) return
  busy.value = true
  try {
    const conv = (await link.request<Conversation>('createConversation', { title: '手机新对话' })) as Conversation
    await refreshConversations(true)
    if (conv?.id) await openConversation(conv.id, true)
    opError.value = ''
  } catch (e) {
    showError(e, '新建会话失败')
  } finally {
    busy.value = false
  }
}

async function deleteConversation(): Promise<void> {
  if (!link || !activeId.value || busy.value) return
  if (!window.confirm(`删除会话「${activeConv.value?.title ?? ''}」？桌面端同步删除。`)) return
  busy.value = true
  try {
    await link.request('deleteConversation', { conversationId: activeId.value })
    activeId.value = null
    messages.value = []
    await refreshConversations(true)
    opError.value = ''
  } catch (e) {
    showError(e, '删除会话失败')
  } finally {
    busy.value = false
  }
}

async function send(): Promise<void> {
  if (!link || !activeId.value || !input.value.trim() || sending.value) return
  const content = input.value.trim()
  input.value = ''
  sending.value = true
  try {
    await link.request('send', { conversationId: activeId.value, parentMessageId: null, content })
    opError.value = ''
    await openConversation(activeId.value!, true)
  } catch (e) {
    input.value = content
    showError(e, '发送失败已帮你留住草稿')
  } finally {
    sending.value = false
  }
}

async function refreshApprovals(silent = true): Promise<void> {
  if (!link) return
  try {
    approvals.value = (await link.request<PendingApproval[]>('listApprovals', {})) ?? []
    if (!silent) opError.value = ''
  } catch (e) {
    if (!silent) showError(e, '拉取审批失败')
  }
}

function askApprove(a: PendingApproval): void {
  const highRisk = /^(run_command|write_file|patch_file|computer_|mcp__)/.test(a.toolName)
  if (highRisk || a.severity === 'critical') {
    confirmHigh.value = { a }
    return
  }
  void doApprove(a, true)
}

async function doApprove(a: PendingApproval, approved: boolean): Promise<void> {
  if (!link) return
  confirmHigh.value = null
  try {
    await link.approve(a.runId, a.toolUseId, approved, a.input)
    await refreshApprovals(true)
    if (activeId.value) await openConversation(activeId.value, true)
  } catch (e) {
    showError(e, '审批失败')
  }
}

function refreshAll(): void {
  opError.value = ''
  void refreshConversations()
  void refreshApprovals(false)
}

/** 解绑重配：清掉本机凭据回到配对页（桌面也去吊销旧手机，避免钥匙混乱）。 */
function unpair(): void {
  if (!window.confirm('解绑这台手机？之后需在桌面重新生成配对码再扫码。')) return
  link?.disconnect()
  link = null
  try {
    localStorage.removeItem(DB_KEY)
  } catch {}
  activeId.value = null
  conversations.value = []
  messages.value = []
  approvals.value = []
  screen.value = 'pair'
  setStatus('已解绑', '请在桌面重新生成配对码')
}

/** 粘贴配对链接一键解析：扫码后复制链接文本的兜底（原生 App 内无浏览器跳转）。 */
async function pastePairLink(): Promise<void> {
  opError.value = ''
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    text = window.prompt('粘贴桌面二维码里的链接', '') ?? ''
  }
  if (!text.trim()) return
  try {
    const u = new URL(text.trim())
    const p = u.searchParams
    if (p.get('v') !== '1' || !p.get('relay') || !p.get('code')) throw new Error('不是有效的配对链接')
    relayUrl.value = p.get('relay') ?? ''
    pairCode.value = p.get('code') ?? ''
    desktopPub.value = p.get('pub') ?? ''
    desktopFingerprint.value = p.get('fp') ?? ''
    setStatus('已读取配对链接', '核对指纹后点击配对')
  } catch (e) {
    showError(e, '链接解析失败请手动填写')
  }
}

async function boot(creds: MobileCredentials, announcePairing = false): Promise<void> {
  await ensureLink(creds, announcePairing)
  screen.value = 'main'
  await refreshConversations()
  await refreshApprovals(false)
  if (conversations.value[0] && !activeId.value) await openConversation(conversations.value[0].id, true)
  if (activeId.value) await openConversation(activeId.value, true)
  scrollBottom()
  if (msgTimer) window.clearInterval(msgTimer)
  msgTimer = window.setInterval(() => {
    if (activeId.value) void openConversation(activeId.value, true)
    void refreshApprovals(true)
  }, 10000)
}

onMounted(() => {
  const params = new URLSearchParams(location.search)
  const hasPairingParams = params.get('v') === '1'
  if (hasPairingParams) {
    screen.value = 'pair'
    relayUrl.value = params.get('relay') ?? relayUrl.value
    pairCode.value = params.get('code') ?? ''
    desktopPub.value = params.get('pub') ?? ''
    desktopFingerprint.value = params.get('fp') ?? ''
    setStatus('已读取桌面配对信息', '核对指纹后点击配对')
  } else {
    const creds = loadCreds()
    if (creds) {
      relayUrl.value = creds.relayUrl
      void boot(creds).catch((e: unknown) => {
        screen.value = 'pair'
        showError(e, '连接失败请重新扫码配对')
      })
    }
  }
  if (hasPairingParams) history.replaceState(null, '', location.pathname)
  // 原生壳（Capacitor）走本地包无需离线壳：跳过 SW，避免壳内缓存旧页面
  const isNative = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true
  if ('serviceWorker' in navigator && !isNative) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
})

onUnmounted(() => {
  link?.disconnect()
  if (msgTimer) window.clearInterval(msgTimer)
})
</script>

<template>
  <div class="m-app">
    <header class="m-head">
      <span class="m-title">尚搏远程</span>
      <span class="m-status" :class="{ ok: online }">{{ status }}</span>
    </header>

    <section v-if="screen === 'pair'" class="m-pair">
      <h2>配对桌面</h2>
      <p class="m-hint">在桌面「设置 → 手机远程」点「生成配对码」并确认，填入中转地址与配对码。</p>
      <input v-model="relayUrl" class="m-input" placeholder="wss://relay.example.com" inputmode="url" />
      <input v-model="pairCode" class="m-input" placeholder="6 位配对码" inputmode="numeric" />
      <input v-model="desktopPub" class="m-input mono" placeholder="桌面公钥（扫码自动填写）" />
      <p v-if="desktopFingerprint" class="m-hint">桌面公钥指纹：<strong class="mono">{{ desktopFingerprint }}</strong>，请与桌面显示一致。</p>
      <button class="m-btn primary m-block" :disabled="busy" @click="pair">{{ busy ? '配对中…' : '配对并连接' }}</button>
      <button class="m-btn m-block" @click="pastePairLink">粘贴配对链接</button>
      <p v-if="opError" class="m-err">{{ opError }}</p>
      <p class="m-build">构建 {{ buildTag }}</p>
    </section>

    <section v-else class="m-main">
      <div class="m-toolbar">
        <button class="m-btn small" :disabled="busy" @click="refreshAll">刷新</button>
        <button class="m-btn small" :disabled="busy" @click="newConversation">＋新会话</button>
        <button class="m-btn small" @click="unpair">解绑重配</button>
        <span class="m-build-inline">{{ buildTag }}</span>
        <span v-if="opError" class="m-err-inline">{{ opError }}</span>
      </div>

      <div class="m-convbar">
        <button
          v-for="c in conversations"
          :key="c.id"
          :class="['m-chip', { active: c.id === activeId }]"
          @click="openConversation(c.id)"
        >
          {{ c.title || '未命名' }}
        </button>
        <span v-if="conversations.length === 0" class="m-empty">暂无会话，点右上新建</span>
      </div>

      <div v-if="activeConv" class="m-convtitle">
        <strong>{{ activeConv.title || '未命名' }}</strong>
        <button class="m-btn small danger" :disabled="busy" @click="deleteConversation">删除</button>
      </div>

      <div v-if="approvals.length > 0" class="m-apprzone">
        <div class="m-side-head"><span>待审批（{{ approvals.length }}）</span></div>
        <div v-for="a in approvals" :key="a.runId + ':' + a.toolUseId" class="m-approval">
          <div v-if="a.severity === 'critical'" class="m-appr-critical">安全红线 · 必须本人确认</div>
          <div class="m-appr-name">{{ a.toolName }}</div>
          <div class="m-appr-reason">{{ a.reason }}</div>
          <div class="m-appr-input">{{ JSON.stringify(a.input).slice(0, 200) }}</div>
          <div class="m-appr-row">
            <button class="m-btn danger" @click="doApprove(a, false)">拒绝</button>
            <button class="m-btn primary" @click="askApprove(a)">批准</button>
          </div>
        </div>
      </div>

      <div ref="msgsBox" class="m-msgs">
        <div v-if="messages.length === 0" class="m-empty">暂无消息，在下面输入框直接开聊，和桌面完全同步。</div>
        <div v-for="m in messages" :key="m.id" :class="['m-msg', 'role-' + m.role]">
          <div v-for="(b, i) in m.blocks" :key="i" class="m-block">
            <div v-if="b.type === 'text'" class="m-text">{{ b.text }}</div>
            <div v-else-if="b.type === 'tool_use'" class="m-tool">🔧 {{ b.name }}</div>
            <div v-else-if="b.type === 'tool_result'" :class="['m-result', { err: b.isError }]">
              <img v-if="b.image?.dataUrl" :src="b.image.dataUrl" alt="工具结果图片" />{{ (b.content || '').slice(0, 2000) }}
            </div>
            <div v-else class="m-result">{{ JSON.stringify(b).slice(0, 500) }}</div>
          </div>
        </div>
      </div>

      <div class="m-input-row">
        <input
          v-model="input"
          class="m-input"
          :placeholder="activeId ? '输入消息，和桌面同步…' : '先新建或选一个会话'"
          :disabled="!activeId || sending"
          @keyup.enter="send"
        />
        <button class="m-btn primary" :disabled="!activeId || sending || !input.trim()" @click="send">
          {{ sending ? '发送中' : '发送' }}
        </button>
      </div>
    </section>

    <div v-if="confirmHigh" class="m-modal-mask">
      <div class="m-modal">
        <h3>{{ confirmHigh.a.severity === 'critical' ? '安全红线 · 二次确认' : '高危操作二次确认' }}</h3>
        <p>{{ confirmHigh.a.toolName }}：{{ confirmHigh.a.reason }}</p>
        <p class="m-appr-input">{{ JSON.stringify(confirmHigh.a.input).slice(0, 300) }}</p>
        <div class="m-appr-row">
          <button class="m-btn danger" @click="doApprove(confirmHigh.a, false)">拒绝</button>
          <button class="m-btn primary" @click="doApprove(confirmHigh.a, true)">确认批准</button>
        </div>
      </div>
    </div>
  </div>
</template>
