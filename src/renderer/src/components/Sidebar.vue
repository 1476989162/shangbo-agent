<script setup lang="ts">
import { computed, ref } from 'vue'
import { useChatStore } from '../stores/chat'
import logoImg from '../assets/logo.png'

const emit = defineEmits<{ openSettings: [tab?: string] }>()
const store = useChatStore()

const pendingDeleteId = ref<string | null>(null)
const searchQuery = ref('')
const moreOpen = ref(false)
const userMenuOpen = ref(false)

const filteredGroups = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return store.projectGroups

  return store.projectGroups
    .map((group) => ({
      ...group,
      conversations: group.conversations.filter((c) =>
        c.title.toLowerCase().includes(query) || group.name.toLowerCase().includes(query)
      )
    }))
    .filter((group) => group.conversations.length > 0)
})

const hasProvidersConfigured = computed(() => store.usableProviders.length > 0)

async function confirmDelete(id: string): Promise<void> {
  await store.removeConversation(id)
  pendingDeleteId.value = null
}

function handleCreateNew(): void {
  void store.createConversation({
    workingDir: store.activeConversation?.workingDir ?? null
  })
}

function handleCreateInProject(dir: string | null): void {
  void store.createConversation({ workingDir: dir })
}

function openTab(tab: string): void {
  userMenuOpen.value = false
  emit('openSettings', tab)
}
</script>

<template>
  <aside class="sidebar">
    <!-- 顶部导航控制条：折叠侧边栏、前进后退、模式切换 -->
    <header class="sidebar-top">
      <div class="nav-controls">
        <button
          class="nav-btn icon-only"
          title="折叠侧边栏"
          @click="store.sidebarCollapsed = !store.sidebarCollapsed"
        >
          <!-- 侧边栏折叠图标 [|] -->
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.3" />
            <line x1="6" y1="2" x2="6" y2="14" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </button>
        <button
          class="nav-btn icon-only"
          :disabled="!store.canGoBack"
          title="返回上一会话"
          @click="store.goBack()"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="nav-btn icon-only"
          :disabled="!store.canGoForward"
          title="前进至下一会话"
          @click="store.goForward()"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <!-- 协同 Cowork / 代码 Code 模式切换胶囊 -->
      <div class="mode-pill">
        <button
          class="mode-btn"
          :class="{ active: store.viewMode === 'cowork' }"
          title="协同助手模式：聚焦多轮对话与工具协作"
          @click="store.viewMode = 'cowork'"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3" />
            <path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          协同
        </button>
        <button
          class="mode-btn"
          :class="{ active: store.viewMode === 'code' }"
          title="代码模式：聚焦项目文件、终端命令与代码编写"
          @click="store.viewMode = 'code'"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M5.5 5L2.5 8L5.5 11M10.5 5L13.5 8L10.5 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          代码
        </button>
      </div>
    </header>

    <!-- 快捷操作项：+ 新建会话、提示词定制、更多操作 -->
    <div class="sidebar-actions">
      <button class="action-btn new-btn" @click="handleCreateNew">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <span>新建会话</span>
      </button>

      <div class="action-row">
        <button class="action-link" @click="emit('openSettings', 'preferences')">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 4h11M2.5 8h11M2.5 12h11M5 2.5v3M11 6.5v3M7 10.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          提示词定制
        </button>

        <button class="action-link more-toggle" @click="moreOpen = !moreOpen">
          <span>更多</span>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" :class="{ rotated: moreOpen }">
            <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <!-- 更多操作下拉菜单 -->
      <div v-if="moreOpen" class="more-menu">
        <button class="menu-item" @click="store.pickFolderAndCreate(); moreOpen = false">
          <span>📁 打开并绑定本地工程…</span>
        </button>
        <button class="menu-item" @click="store.createConversation(); moreOpen = false">
          <span>💬 新建空白会话</span>
        </button>
        <button class="menu-item" @click="store.exportConversation(); moreOpen = false">
          <span>📄 导出当前会话 Markdown</span>
        </button>
        <button class="menu-item" @click="emit('openSettings', 'usage'); moreOpen = false">
          <span>📊 查看 Token 用量统计</span>
        </button>
      </div>

      <!-- 搜索框 -->
      <div class="search-box">
        <svg class="search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
        <input
          v-model="searchQuery"
          class="search-input"
          type="search"
          placeholder="搜索项目与会话…"
          spellcheck="false"
        />
      </div>
    </div>

    <!-- 按工程项目分组的会话树 -->
    <nav class="project-tree">
      <p v-if="filteredGroups.length === 0" class="empty-hint subtle">
        {{ searchQuery.trim() ? '未找到匹配的会话' : '暂无会话，点击上方新建会话开始' }}
      </p>

      <div v-for="group in filteredGroups" :key="group.key" class="project-group">
        <!-- 项目标题行 -->
        <div class="project-header" @click="store.toggleProjectCollapse(group.key)">
          <div class="header-left">
            <svg
              class="chevron"
              :class="{ collapsed: store.collapsedProjects[group.key] }"
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
            >
              <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="project-name" :title="group.dir ?? '通用会话分组'">{{ group.name }}</span>
          </div>

          <div class="header-actions" @click.stop>
            <button
              class="group-add-btn icon-only"
              :title="`在「${group.name}」中新建会话`"
              @click="handleCreateInProject(group.dir)"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 项目下的会话列表 -->
        <div v-show="!store.collapsedProjects[group.key]" class="group-conversations">
          <div
            v-for="conv in group.conversations"
            :key="conv.id"
            class="tree-item"
            :class="{ active: conv.id === store.activeConversationId }"
            @click="store.openConversation(conv.id)"
          >
            <!-- 小圆圈 bullet -->
            <span class="bullet" :class="{ 'bullet-active': conv.id === store.activeConversationId }">
              <span class="bullet-inner" />
            </span>

            <span class="tree-title" :title="conv.title">{{ conv.title }}</span>

            <!-- 删除操作 -->
            <div v-if="pendingDeleteId === conv.id" class="confirm-box" @click.stop>
              <button class="btn btn-ghost tiny btn-danger" @click="confirmDelete(conv.id)">删除</button>
              <button class="btn btn-ghost tiny" @click="pendingDeleteId = null">取消</button>
            </div>
            <button
              v-else
              class="delete-btn icon-only"
              title="删除此会话"
              @click.stop="pendingDeleteId = conv.id"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.6 8h4.8l.6-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- 打开本地工程文件夹按钮 -->
      <div class="add-project-row">
        <button class="btn-add-project" @click="store.pickFolderAndCreate()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 4a1.5 1.5 0 011.5-1.5h3.2a1.5 1.5 0 011.06.44l1.24 1.24a1.5 1.5 0 001.06.44H12A1.5 1.5 0 0113.5 6v6A1.5 1.5 0 0112 13.5H4A1.5 1.5 0 012.5 12V4z" stroke="currentColor" stroke-width="1.2" />
            <path d="M8 7.5v4M6 9.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          <span>打开新工程目录…</span>
        </button>
      </div>
    </nav>

    <!-- 底部状态条 (图片2中文化菜单) -->
    <div class="footer-wrapper">
      <!-- 图片2对应的弹出式中文菜单 -->
      <div v-if="userMenuOpen" class="user-popup-menu" @click.stop>
        <div class="user-popup-header">
          <div class="popup-username">{{ store.userName }}</div>
          <div class="popup-gateway">本地推理网关 · {{ hasProvidersConfigured ? '正常运行' : '未就绪' }}</div>
        </div>

        <div class="menu-divider" />

        <button class="popup-item" @click="openTab('preferences')">
          <div class="item-left">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3" />
              <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <span>偏好设置</span>
          </div>
          <span class="item-shortcut">Ctrl+,</span>
        </button>

        <button class="popup-item" @click="openTab('preferences')">
          <div class="item-left">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2" />
              <path d="M2 8h12M8 2a9 9 0 000 12M8 2a9 9 0 010 12" stroke="currentColor" stroke-width="1.2" />
            </svg>
            <span>界面语言</span>
          </div>
          <span class="item-hint">简体中文</span>
        </button>

        <button class="popup-item" @click="openTab('providers')">
          <div class="item-left">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8.5 2L3 9h5l-1 5 6.5-7H8.5l1-5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>推理端点与网关配置</span>
          </div>
        </button>

        <div class="menu-divider" />

        <button class="popup-item" @click="openTab('usage')">
          <div class="item-left">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 13V9M7 13V6M11 13V3M15 13H1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <span>Token 用量统计</span>
          </div>
        </button>

        <button class="popup-item" @click="openTab('general')">
          <div class="item-left">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 3h10v10H3zM6 6h4M6 9h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
            <span>查看更新日志</span>
          </div>
        </button>

        <button class="popup-item" @click="openTab('privacy')">
          <div class="item-left">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2" />
              <path d="M8 5v.5M8 7.5v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
            <span>隐私与安全机制</span>
          </div>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        <div class="menu-divider" />

        <button class="popup-item text-danger" @click="store.createConversation(); userMenuOpen = false">
          <div class="item-left">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M6 13.5H3.5a1 1 0 01-1-1v-9a1 1 0 011-1H6M10.5 11.5L14 8l-3.5-3.5M14 8H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>重置当前工作区</span>
          </div>
        </button>
      </div>

      <!-- 底部条 -->
      <footer class="sidebar-footer" @click="userMenuOpen = !userMenuOpen">
        <div class="user-strip">
          <!-- 尚搏企业官方 Logo -->
          <img :src="logoImg" class="shangbo-brand-logo" alt="尚搏 Logo" />

          <span class="user-name">{{ store.userName }}</span>
          <span class="divider">·</span>
          <span class="gateway-tag">网关</span>
          <span
            class="status-dot"
            :class="{ online: hasProvidersConfigured }"
            :title="hasProvidersConfigured ? '网关就绪' : '未配置模型或密钥'"
          />
        </div>

        <button class="settings-chevron icon-only" title="用户与设置选项">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            :class="{ rotated: userMenuOpen }"
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </footer>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  user-select: none;
  position: relative;
}

/* 顶部栏 */
.sidebar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  gap: 8px;
  flex: none;
  -webkit-app-region: drag;
}

.nav-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  -webkit-app-region: no-drag;
}

.nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition: all 0.12s ease;
}

.nav-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.nav-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

/* 模式切换胶囊 */
.mode-pill {
  display: flex;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  padding: 2px;
  gap: 2px;
  -webkit-app-region: no-drag;
}

.mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11.5px;
  font-weight: 500;
  border-radius: var(--radius-full);
  color: var(--text-muted);
  transition: all 0.15s ease;
}

.mode-btn:hover {
  color: var(--text);
}

.mode-btn.active {
  background: var(--bg-elevated);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

/* 快捷操作项 */
.sidebar-actions {
  display: flex;
  flex-direction: column;
  padding: 4px 12px 10px;
  gap: 6px;
  flex: none;
}

.new-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s ease;
}

.new-btn:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px;
}

.action-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  transition: all 0.12s ease;
}

.action-link:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.more-toggle svg {
  transition: transform 0.15s ease;
}

.more-toggle svg.rotated {
  transform: rotate(180deg);
}

.more-menu {
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  gap: 2px;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  font-size: 12px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text);
  transition: background 0.12s ease;
}

.menu-item:hover {
  background: var(--surface-hover);
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  margin-top: 2px;
}

.search-icon {
  position: absolute;
  left: 9px;
  color: var(--text-subtle);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 5px 8px 5px 28px;
  font-size: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s ease;
}

.search-input:focus {
  border-color: var(--border-strong);
}

/* 项目树 */
.project-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-hint {
  padding: 16px 8px;
  font-size: 12px;
  text-align: center;
}

.project-group {
  display: flex;
  flex-direction: column;
}

.project-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  transition: color 0.12s ease;
}

.project-header:hover {
  color: var(--text);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.chevron {
  flex: none;
  transition: transform 0.15s ease;
}

.chevron.collapsed {
  transform: rotate(-90deg);
}

.project-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono), var(--font-sans);
  letter-spacing: -0.2px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.group-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--text-subtle);
  transition: all 0.12s ease;
}

.group-add-btn:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.group-conversations {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: 10px;
  margin-top: 2px;
}

.tree-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
  transition: background 0.12s ease;
}

.tree-item:hover {
  background: var(--surface-hover);
}

.tree-item.active {
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--border);
  font-weight: 500;
}

.bullet {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  flex: none;
}

.bullet-inner {
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  border: 1px solid var(--text-subtle);
}

.bullet.bullet-active .bullet-inner {
  border-color: var(--accent);
  background: var(--accent);
}

.tree-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  opacity: 0;
  color: var(--text-subtle);
  transition: all 0.12s ease;
  flex: none;
}

.tree-item:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  color: var(--danger);
  background: var(--danger-soft);
}

.confirm-box {
  display: flex;
  gap: 2px;
  flex: none;
}

.tiny {
  padding: 1px 4px;
  font-size: 10px;
  border-radius: var(--radius-sm);
}

.add-project-row {
  margin-top: 8px;
  padding: 0 4px;
}

.btn-add-project {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border);
  transition: all 0.12s ease;
}

.btn-add-project:hover {
  color: var(--text);
  border-color: var(--border-strong);
  background: var(--surface-hover);
}

/* 底部状态条与图片2中文弹窗 */
.footer-wrapper {
  position: relative;
  flex: none;
}

.user-popup-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 8px;
  right: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 200;
}

.user-popup-header {
  padding: 6px 10px 8px;
}

.popup-username {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.popup-gateway {
  font-size: 11px;
  color: var(--text-subtle);
  margin-top: 2px;
}

.menu-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.popup-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text);
  border-radius: var(--radius-sm);
  transition: background 0.12s ease;
}

.popup-item:hover {
  background: var(--surface-hover);
}

.item-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.item-shortcut,
.item-hint {
  font-size: 11px;
  color: var(--text-subtle);
}

.text-danger {
  color: var(--danger);
}

.text-danger:hover {
  background: var(--danger-soft);
}

.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.12s ease;
}

.sidebar-footer:hover {
  background: var(--surface-hover);
}

.user-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
}

.shangbo-brand-logo {
  width: 18px;
  height: 18px;
  object-fit: contain;
  border-radius: 4px;
  flex: none;
}

.user-name {
  font-weight: 500;
}

.divider {
  color: var(--text-subtle);
}

.gateway-tag {
  color: var(--text-muted);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--text-subtle);
  flex: none;
}

.status-dot.online {
  background: var(--success);
}

.settings-chevron svg {
  color: var(--text-subtle);
  transition: transform 0.15s ease;
}

.settings-chevron svg.rotated {
  transform: rotate(180deg);
}
</style>