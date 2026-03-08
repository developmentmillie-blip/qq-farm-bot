<script setup lang="ts">
import { useDateFormat, useIntervalFn, useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api'
import AccountModal from '@/components/AccountModal.vue'
import RemarkModal from '@/components/RemarkModal.vue'

import { menuRoutes } from '@/router/menu'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const appStore = useAppStore()
const route = useRoute()

const { accounts, currentAccount } = storeToRefs(accountStore)
const { status, realtimeConnected } = storeToRefs(statusStore)
const { sidebarOpen, isDark } = storeToRefs(appStore)

const showAccountDropdown = ref(false)
const showAccountModal = ref(false)
const showRemarkModal = ref(false)
const accountToEdit = ref<any>(null)
const wsErrorNotifiedAt = ref<Record<string, number>>({})

const systemConnected = ref(true)
const serverUptimeBase = ref(0)
const serverVersion = ref('')
const lastPingTime = ref(Date.now())
const now = useNow()
const formattedTime = useDateFormat(now, 'HH:mm:ss')

async function checkConnection() {
  try {
    const res = await api.get('/api/ping')
    systemConnected.value = true
    if (res.data.ok && res.data.data) {
      if (res.data.data.uptime) {
        serverUptimeBase.value = res.data.data.uptime
        lastPingTime.value = Date.now()
      }
      if (res.data.data.version) {
        serverVersion.value = res.data.data.version
      }
    }
    const accountRef = currentAccount.value?.id || currentAccount.value?.uin
    if (accountRef) {
      statusStore.connectRealtime(String(accountRef))
    }
  }
  catch {
    systemConnected.value = false
  }
}

async function refreshStatusFallback() {
  if (realtimeConnected.value)
    return
  const accountRef = currentAccount.value?.id || currentAccount.value?.uin
  if (accountRef) {
    await statusStore.fetchStatus(String(accountRef))
  }
}

async function handleAccountSaved() {
  await accountStore.fetchAccounts()
  await refreshStatusFallback()
  showAccountModal.value = false
  showRemarkModal.value = false
}

function openRemarkModal(acc: any) {
  accountToEdit.value = acc
  showRemarkModal.value = true
  showAccountDropdown.value = false
}

onMounted(() => {
  accountStore.fetchAccounts()
  checkConnection()
})

onBeforeUnmount(() => {
  statusStore.disconnectRealtime()
})

useIntervalFn(checkConnection, 30000)
useIntervalFn(() => {
  refreshStatusFallback()
  accountStore.fetchAccounts()
}, 10000)

watch(() => currentAccount.value?.id || currentAccount.value?.uin || '', () => {
  const accountRef = currentAccount.value?.id || currentAccount.value?.uin
  statusStore.connectRealtime(String(accountRef || ''))
  refreshStatusFallback()
}, { immediate: true })

watch(() => status.value?.wsError, (wsError: any) => {
  if (!wsError || Number(wsError.code) !== 400 || !currentAccount.value)
    return
  const errAt = Number(wsError.at) || 0
  const accId = String(currentAccount.value.id || currentAccount.value.uin || '')
  const lastNotified = wsErrorNotifiedAt.value[accId] || 0
  if (errAt <= lastNotified)
    return
  wsErrorNotifiedAt.value[accId] = errAt
  accountToEdit.value = currentAccount.value
  showAccountModal.value = true
}, { deep: true })

const uptime = computed(() => {
  const diff = Math.floor(serverUptimeBase.value + (now.value.getTime() - lastPingTime.value) / 1000)
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  return `${h}h ${m}m ${s}s`
})

const displayName = computed(() => {
  const acc = currentAccount.value
  if (!acc)
    return '选择账号'
  const liveName = status.value?.status?.name
  if (liveName && liveName !== '未登录')
    return liveName
  if (acc.name)
    return acc.name
  if (acc.nick)
    return acc.nick
  return acc.uin
})

const connectionDot = computed(() => {
  if (!systemConnected.value)
    return 'offline'
  if (!currentAccount.value?.id)
    return 'idle'
  return status.value?.connection?.connected ? 'online' : 'offline'
})

const connectionText = computed(() => {
  if (!systemConnected.value)
    return '系统离线'
  if (!currentAccount.value?.id)
    return '请添加账号'
  return status.value?.connection?.connected ? '运行中' : '未连接'
})

const navItems = menuRoutes.map(item => ({
  path: item.path ? `/${item.path}` : '/',
  label: item.label,
  faIcon: navFaIcon(item.name),
}))

function navFaIcon(name: string) {
  const map: Record<string, string> = {
    dashboard: 'fa-solid fa-chart-pie',
    personal: 'fa-solid fa-seedling',
    friends: 'fa-solid fa-users',
    analytics: 'fa-solid fa-chart-bar',
    accounts: 'fa-solid fa-users-gear',
    Settings: 'fa-solid fa-sliders',
    ranch: 'fa-solid fa-horse',
  }
  return map[name] || 'fa-solid fa-circle'
}

function selectAccount(acc: any) {
  accountStore.setCurrentAccount(acc)
  showAccountDropdown.value = false
}

const version = __APP_VERSION__

watch(
  () => route.path,
  () => {
    if (window.innerWidth < 981)
      appStore.closeSidebar()
  },
)
</script>

<template>
  <aside class="app-sidebar" :class="{ open: sidebarOpen }">
    <!-- 品牌 -->
    <div class="brand">
      <i class="fa-solid fa-leaf brand-icon" />
      <span>农场助手</span>
      <!-- 移动端关闭按钮 -->
      <button
        class="mobile-close-btn"
        @click="appStore.closeSidebar"
      >
        <i class="fa-solid fa-xmark" />
      </button>
    </div>

    <!-- 账号选择 -->
    <div class="account-selector-wrap">
      <button class="current-account" @click="showAccountDropdown = !showAccountDropdown">
        <div class="acc-sel-inner">
          <div class="acc-sel-avatar">
            <img
              v-if="currentAccount?.uin"
              :src="`https://q1.qlogo.cn/g?b=qq&nk=${currentAccount.uin}&s=100`"
              @error="(e) => (e.target as HTMLImageElement).style.display = 'none'"
            >
            <i v-else class="fa-solid fa-user" />
          </div>
          <div class="acc-sel-meta">
            <span class="acc-sel-name">{{ displayName }}</span>
            <span class="acc-sel-uin">{{ currentAccount?.uin || currentAccount?.id || '未选择' }}</span>
          </div>
        </div>
        <i class="fa-solid fa-chevron-down acc-sel-chevron" :class="{ rotate: showAccountDropdown }" />
      </button>

      <!-- 下拉菜单 -->
      <div v-if="showAccountDropdown" class="account-dropdown show">
        <template v-if="accounts.length > 0">
          <div
            v-for="acc in accounts"
            :key="acc.id || acc.uin"
            class="account-option"
            :class="{ active: currentAccount?.id === acc.id }"
            @click="selectAccount(acc)"
          >
            <div class="acc-opt-avatar">
              <img
                v-if="acc.uin"
                :src="`https://q1.qlogo.cn/g?b=qq&nk=${acc.uin}&s=100`"
                @error="(e) => (e.target as HTMLImageElement).style.display = 'none'"
              >
              <i v-else class="fa-solid fa-user" />
            </div>
            <div class="acc-opt-info">
              <span class="acc-opt-name">{{ acc.name || acc.nick || acc.uin }}</span>
              <span class="acc-opt-uin">{{ acc.uin || acc.id }}</span>
            </div>
            <button class="acc-opt-edit-btn" title="修改备注" @click.stop="openRemarkModal(acc)">
              <i class="fa-solid fa-pen" />
            </button>
            <i v-if="currentAccount?.id === acc.id" class="fa-solid fa-check acc-opt-check" />
          </div>
        </template>
        <div v-else class="account-option" style="color: var(--sub); cursor: default;">
          暂无账号
        </div>
        <div class="acc-dropdown-footer">
          <button class="acc-dropdown-action" @click="showAccountModal = true; showAccountDropdown = false">
            <i class="fa-solid fa-plus" /> 添加账号
          </button>
          <router-link to="/accounts" class="acc-dropdown-action" @click="showAccountDropdown = false">
            <i class="fa-solid fa-list" /> 管理账号
          </router-link>
        </div>
      </div>
    </div>

    <!-- 导航 -->
    <nav class="nav-list" style="flex:1; overflow-y: auto; min-height: 0;">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :active-class="item.path === '/' ? '' : 'active'"
        :exact-active-class="item.path === '/' ? 'active' : ''"
      >
        <i class="nav-icon" :class="item.faIcon" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- 底部状态 -->
    <div class="sidebar-foot">
      <div class="conn">
        <span class="dot" :class="connectionDot" />
        <span>{{ connectionText }}</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <p class="system-time">{{ formattedTime }}</p>
        <button
          class="icon-btn theme-toggle-btn"
          title="切换主题"
          @click="appStore.toggleDark()"
        >
          <i :class="isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon'" />
        </button>
      </div>
    </div>

    <!-- 菜单遮罩（点击外部关闭下拉） -->
    <div
      v-if="showAccountDropdown"
      style="position:fixed; inset:0; z-index:49;"
      @click="showAccountDropdown = false"
    />
  </aside>

  <!-- 顶部栏（移动端） -->
  <div class="mobile-topbar">
    <button class="icon-btn" @click="appStore.toggleSidebar">
      <i class="fa-solid fa-bars" />
    </button>
    <span class="mobile-topbar-title" style="font-family: var(--font-brand); font-size: 1.2rem;">农场助手</span>
    <div style="width:36px;" />
  </div>

  <!-- 弹窗 -->
  <AccountModal
    :show="showAccountModal"
    :edit-data="accountToEdit"
    @close="showAccountModal = false; accountToEdit = null"
    @saved="handleAccountSaved"
  />

  <RemarkModal
    :show="showRemarkModal"
    :account="accountToEdit"
    @close="showRemarkModal = false"
    @saved="handleAccountSaved"
  />
</template>

<style scoped>
/* 账号选择区 */
.account-selector-wrap {
  position: relative;
  flex-shrink: 0;
}
.acc-sel-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}
.acc-sel-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--sub);
}
.acc-sel-avatar img { width: 100%; height: 100%; object-fit: cover; }
.acc-sel-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.acc-sel-name {
  font-weight: 700;
  font-size: calc(14px * var(--font-scale));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.acc-sel-uin {
  font-size: calc(11px * var(--font-scale));
  color: var(--sub);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.acc-sel-chevron {
  color: var(--sub);
  font-size: 12px;
  transition: transform 0.2s;
  flex-shrink: 0;
}
.acc-sel-chevron.rotate { transform: rotate(180deg); }

/* 下拉菜单定位 */
.account-dropdown.show {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 100;
  display: block;
}
.acc-opt-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--sub);
  font-size: 12px;
}
.acc-opt-avatar img { width: 100%; height: 100%; object-fit: cover; }
.acc-opt-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.acc-opt-name {
  font-size: calc(13px * var(--font-scale));
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.acc-opt-uin {
  font-size: calc(11px * var(--font-scale));
  color: var(--sub);
}
.acc-opt-edit-btn {
  background: none;
  border: none;
  color: var(--sub);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 11px;
  transition: color 0.15s;
}
.acc-opt-edit-btn:hover { color: var(--accent); }
.acc-opt-check {
  color: var(--primary);
  font-size: 12px;
  flex-shrink: 0;
}
.acc-dropdown-footer {
  border-top: 1px solid var(--line);
  padding: 4px 0;
}
.acc-dropdown-action {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  background: none;
  border: none;
  color: var(--primary);
  font-size: calc(13px * var(--font-scale));
  cursor: pointer;
  text-decoration: none;
  transition: background 0.15s;
  font-family: inherit;
}
.acc-dropdown-action:hover { background: var(--panel); }

/* 移动端关闭按钮 */
.mobile-close-btn {
  display: none;
  margin-left: auto;
  background: none;
  border: none;
  color: var(--sub);
  cursor: pointer;
  font-size: 18px;
  padding: 4px;
}

/* 移动端顶部栏 */
.mobile-topbar {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--topbar-height);
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  z-index: 150;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
}

/* 主题切换按钮 */
.theme-toggle-btn {
  width: 28px;
  height: 28px;
  font-size: 14px;
}

@media (max-width: 980px) {
  .mobile-close-btn { display: flex; align-items: center; justify-content: center; }
  .mobile-topbar { display: flex; }

  /* 在移动端时 app-main 要留出 topbar 高度 */
  :deep(.app-main) {
    padding-top: var(--topbar-height);
    grid-template-rows: minmax(0, 1fr);
  }
}
</style>
