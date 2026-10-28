import { createApp, computed, onMounted, onUnmounted, ref } from 'vue'
import { MobileLink, type MobileCredentials } from './link'
import { stableStringify, sha256Hex } from './crypto-web'
import { createPairingSession, type PairingSession } from './pairing'

/* PWA 主界面：配对 → 会话列表 → 消息流（含流式）→ 审批（批准/拒绝，高危二次确认）。
   不提供：设置修改、供应商/API Key 查看、文件选择、MCP 管理。 */

interface ChatMessage {
  id: string
  role: string
  blocks: { type: string; text?: string; name?: string; input?: unknown; content?: string; isError?: boolean }[]
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

const app = createApp({
  setup() {
    const screen = ref<'pair' | 'main'>('pair')
    const relayUrl = ref('')
    const pairCode = ref('')
    const desktopPub = ref('')
    const desktopFingerprint = ref('')
    const status = ref('未连接')
    const conversations = ref<Conversation[]>([])
    const activeId = ref<string | null>(null)
    const messages = ref<ChatMessage[]>([])
    const input = ref('')
    const approvals = ref<PendingApproval[]>([])
    const busy = ref(false)
    const confirmHigh = ref<{ a: PendingApproval } | null>(null)
    let link: MobileLink | null = null
    let pairingSession: PairingSession | null = null

    const activeConv = computed(() => conversations.value.find((c) => c.id === activeId.value) ?? null)

    function setStatus(s: string, d?: string): void {
      status.value = d ? `${s}（${d}）` : s
    }

    async function ensureLink(
      creds: MobileCredentials,
      announcePairing = false
    ): Promise<MobileLink> {
      if (link) link.disconnect()
      link = new MobileLink(creds, announcePairing)
      link.onStatus = setStatus
      link.onPush = (event: unknown) => {
        const e = event as { type?: string; conversationId?: string; messageId?: string; text?: string; name?: string; toolUseId?: string; input?: unknown; reason?: string; runId?: string; message_done?: unknown; status?: string } | null
        if (!e || typeof e !== 'object') return
        if ((e.type === 'text_delta' || e.type === 'reasoning_delta') && e.messageId) {
          const m = messages.value.find((x) => x.id === e.messageId)
          if (m) {
            const last = m.blocks[m.blocks.length - 1]
            if (last?.type === 'text' && e.type === 'text_delta') last.text = (last.text ?? '') + (e.text ?? '')
            else m.blocks.push({ type: 'text', text: e.text ?? '' })
          }
        } else if (e.type === 'approval_required') {
          void refreshApprovals()
        } else if (e.type === 'message_done' || e.type === 'run_end') {
          if (e.conversationId === activeId.value) void openConversation(activeId.value!)
          void refreshApprovals()
        }
      }
      await link.connect()
      if (announcePairing) setStatus('已提交配对信息', '等待桌面确认')
      return link
    }

    async function pair(): Promise<void> {
      busy.value = true
      try {
        const url = relayUrl.value.trim()
        const code = pairCode.value.trim()
        if (!/^wss:\/\//i.test(url)) throw new Error('中转地址必须为 wss://')
        if (!code) throw new Error('请输入配对码')
        if (!desktopPub.value) throw new Error('请扫描桌面二维码，或填写桌面公钥')
        // 每次点击配对都重新生成手机临时密钥，避免失败重试复用旧会话。
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
        // 用二维码中的桌面公钥做 X25519，手机只把公钥交给桌面。
        const sessionKeyB64 = pairingSession.sessionKeyB64
        const creds: MobileCredentials = {
          relayUrl: url,
          phoneToken: token.phoneToken,
          sessionKeyB64,
          deviceName: '手机',
          phonePubB64: pairingSession.phonePublicKeyB64
        }
        await boot(creds, true)
        // 只有桌面回 pair-ack、会话密钥真正可用后才持久化，失败重试不会留下半配对凭据。
        saveCreds(creds)
        // 配对握手（含桌面确认）完成后，清除扫码链接遗留的临时输入。
        desktopPub.value = ''
        pairCode.value = ''
      } catch (e) {
        setStatus('配对失败', e instanceof Error ? e.message : String(e))
      } finally {
        busy.value = false
      }
    }

    async function refreshConversations(): Promise<void> {
      if (!link) return
      try {
        conversations.value = (await link.request<Conversation[]>('listConversations', {})) ?? []
      } catch {}
    }

    async function openConversation(id: string): Promise<void> {
      if (!link) return
      activeId.value = id
      try {
        const data = (await link.request<{ messages: ChatMessage[] }>('getMessages', { conversationId: id })) as {
          messages: ChatMessage[]
        }
        messages.value = data.messages ?? []
      } catch {}
    }

    async function send(): Promise<void> {
      if (!link || !activeId.value || !input.value.trim()) return
      const content = input.value.trim()
      input.value = ''
      try {
        await link.request('send', { conversationId: activeId.value, parentMessageId: null, content })
        await openConversation(activeId.value)
      } catch (e) {
        setStatus('发送失败', e instanceof Error ? e.message : String(e))
      }
    }

    async function refreshApprovals(): Promise<void> {
      if (!link) return
      try {
        approvals.value = (await link.request<PendingApproval[]>('listApprovals', {})) ?? []
      } catch {}
    }

    function askApprove(a: PendingApproval): void {
      const highRisk = /^(run_command|write_file|patch_file|computer_|mcp__)/.test(a.toolName)
      if (highRisk) {
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
        await refreshApprovals()
      } catch (e) {
        setStatus('审批失败', e instanceof Error ? e.message : String(e))
      }
    }

    async function boot(creds: MobileCredentials, announcePairing = false): Promise<void> {
      await ensureLink(creds, announcePairing)
      screen.value = 'main'
      await refreshConversations()
      await refreshApprovals()
      if (conversations.value[0]) await openConversation(conversations.value[0].id)
      // 审批/锁屏推送：Web Push 二期；第一版用前台轮询（30s）+ 在线推送
      window.setInterval(() => {
        void refreshApprovals()
      }, 30000)
    }

    onMounted(() => {
      const params = new URLSearchParams(location.search)
      const hasPairingParams = params.get('v') === '1'
      if (hasPairingParams) {
        // 新扫码优先于旧凭据：否则已配对手机重扫新码时会被旧会话直接带进主界面。
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
          void boot(creds).catch(() => {
            screen.value = 'pair'
            setStatus('连接失败', '请重新扫码配对')
          })
        }
      }
      // 扫码链接只用于预填，配对完成后从地址栏移除敏感参数。
      if (hasPairingParams) history.replaceState(null, '', location.pathname)
      // PWA：注册 Service Worker（离线壳 + 推送底座，二期接 Web Push）
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {})
      }
    })

    onUnmounted(() => {
      link?.disconnect()
    })

    async function textHash(input: unknown): Promise<string> {
      return sha256Hex(stableStringify(input ?? null)).then((h) => h.slice(0, 16))
    }

    return {
      screen,
      relayUrl,
      pairCode,
      desktopPub,
      desktopFingerprint,
      status,
      conversations,
      activeId,
      activeConv,
      messages,
      input,
      approvals,
      busy,
      confirmHigh,
      pair,
      openConversation,
      refreshConversations,
      send,
      refreshApprovals,
      askApprove,
      doApprove,
      textHash
    }
  },
  template: `
  <div class="m-app">
    <header class="m-head">
      <span class="m-title">尚搏远程</span>
      <span class="m-status">{{ status }}</span>
    </header>
    <section v-if="screen === 'pair'" class="m-pair">
      <h2>配对桌面</h2>
      <p class="m-hint">在桌面「设置 → 手机远程」生成配对码，填入中转地址与配对码。</p>
      <input v-model="relayUrl" class="m-input" placeholder="wss://relay.example.com" inputmode="url" />
      <input v-model="pairCode" class="m-input" placeholder="6 位配对码" inputmode="numeric" />
      <input v-model="desktopPub" class="m-input mono" placeholder="桌面公钥（扫码自动填写）" />
      <p v-if="desktopFingerprint" class="m-hint">桌面公钥指纹：<strong class="mono">{{ desktopFingerprint }}</strong>，请与桌面显示一致。</p>
      <button class="m-btn primary" :disabled="busy" @click="pair">{{ busy ? '配对中…' : '配对并连接' }}</button>
    </section>
    <section v-else class="m-main">
      <div class="m-cols">
        <aside class="m-side">
          <div class="m-side-head">
            <span>会话</span>
            <button class="m-btn small" @click="refreshConversations">刷新</button>
          </div>
          <div v-for="c in conversations" :key="c.id" :class="['m-conv', { active: c.id === activeId }]" @click="openConversation(c.id)">
            {{ c.title }}
          </div>
          <div class="m-side-head" style="margin-top: 12px">
            <span>待审批（{{ approvals.length }}）</span>
            <button class="m-btn small" @click="refreshApprovals">刷新</button>
          </div>
          <div v-if="approvals.length === 0" class="m-empty">暂无待审批</div>
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
        </aside>
        <main class="m-chat">
          <div class="m-msgs">
            <div v-for="m in messages" :key="m.id" :class="['m-msg', 'role-' + m.role]">
              <div v-for="(b, i) in m.blocks" :key="i" class="m-block">
                <div v-if="b.type === 'text'" class="m-text">{{ b.text }}</div>
                <div v-else-if="b.type === 'tool_use'" class="m-tool">🔧 {{ b.name }}</div>
                <div v-else-if="b.type === 'tool_result'" :class="['m-result', { err: b.isError }]">{{ (b.content || '').slice(0, 500) }}</div>
              </div>
            </div>
          </div>
          <div class="m-input-row">
            <input v-model="input" class="m-input" placeholder="输入消息…" @keyup.enter="send" />
            <button class="m-btn primary" @click="send">发送</button>
          </div>
        </main>
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
  </div>`
})

app.mount('#app')
