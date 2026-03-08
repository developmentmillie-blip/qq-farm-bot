<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const bagStore = useBagStore()
const {
  status,
  logs: statusLogs,
  accountLogs: statusAccountLogs,
  realtimeConnected,
} = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { dashboardItems } = storeToRefs(bagStore)
const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const lastBagFetchAt = ref(0)

const allLogs = computed(() => {
  const sLogs = statusLogs.value || []
  const aLogs = (statusAccountLogs.value || []).map((l: any) => ({
    ts: new Date(l.time).getTime(),
    time: l.time,
    tag: l.action === 'Error' ? '错误' : '系统',
    msg: l.reason ? `${l.msg} (${l.reason})` : l.msg,
    isAccountLog: true,
  }))
  return [...sLogs, ...aLogs].sort((a: any, b: any) => a.ts - b.ts)
})

const filter = reactive({
  module: '',
  event: '',
  keyword: '',
  isWarn: '',
})

const hasActiveLogFilter = computed(() =>
  !!(filter.module || filter.event || filter.keyword || filter.isWarn),
)

const modules = [
  { label: '所有模块', value: '' },
  { label: '农场', value: 'farm' },
  { label: '好友', value: 'friend' },
  { label: '仓库', value: 'warehouse' },
  { label: '任务', value: 'task' },
  { label: '系统', value: 'system' },
]

const events = [
  { label: '所有事件', value: '' },
  { label: '农场巡查', value: 'farm_cycle' },
  { label: '收获作物', value: 'harvest_crop' },
  { label: '清理枯株', value: 'remove_plant' },
  { label: '种植种子', value: 'plant_seed' },
  { label: '施加化肥', value: 'fertilize' },
  { label: '土地推送', value: 'lands_notify' },
  { label: '选择种子', value: 'seed_pick' },
  { label: '购买种子', value: 'seed_buy' },
  { label: '购买化肥', value: 'fertilizer_buy' },
  { label: '开启礼包', value: 'fertilizer_gift_open' },
  { label: '获取任务', value: 'task_scan' },
  { label: '完成任务', value: 'task_claim' },
  { label: '免费礼包', value: 'mall_free_gifts' },
  { label: '分享奖励', value: 'daily_share' },
  { label: '会员礼包', value: 'vip_daily_gift' },
  { label: '月卡礼包', value: 'month_card_gift' },
  { label: '开服红包', value: 'open_server_gift' },
  { label: '图鉴奖励', value: 'illustrated_rewards' },
  { label: '邮箱领取', value: 'email_rewards' },
  { label: '出售成功', value: 'sell_success' },
  { label: '土地升级', value: 'upgrade_land' },
  { label: '土地解锁', value: 'unlock_land' },
  { label: '好友巡查', value: 'friend_cycle' },
  { label: '访问好友', value: 'visit_friend' },
]

const eventLabelMap: Record<string, string> = Object.fromEntries(
  events.filter(e => e.value).map(e => [e.value, e.label]),
)
function getEventLabel(event: string) {
  return eventLabelMap[event] || event
}

const logLevelOpts = [
  { label: '所有等级', value: '' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
]

const displayName = computed(() => {
  const gameName = status.value?.status?.name
  if (gameName)
    return gameName
  if (!status.value?.connection?.connected) {
    const account = accountStore.currentAccount
    return account?.name || account?.nick || '未登录'
  }
  const account = accountStore.currentAccount
  return account?.name || account?.nick || '未命名'
})

const expRate = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptimeVal = status.value?.uptime || 0
  if (!uptimeVal)
    return '0/时'
  const hours = uptimeVal / 3600
  const rate = hours > 0 ? (gain / hours) : 0
  return `${Math.floor(rate)}/时`
})

const timeToLevel = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptimeVal = status.value?.uptime || 0
  const current = status.value?.levelProgress?.current || 0
  const needed = status.value?.levelProgress?.needed || 0
  if (!needed || !uptimeVal || gain <= 0)
    return ''
  const hours = uptimeVal / 3600
  const ratePerHour = hours > 0 ? (gain / hours) : 0
  if (ratePerHour <= 0)
    return ''
  const expNeeded = needed - current
  const minsToLevel = expNeeded / (ratePerHour / 60)
  if (minsToLevel < 60)
    return `约 ${Math.ceil(minsToLevel)} 分钟后升级`
  return `约 ${(minsToLevel / 60).toFixed(1)} 小时后升级`
})

const fertilizerNormal = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 1011))
const fertilizerOrganic = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 1012))
const collectionNormal = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 3001))
const collectionRare = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 3002))

function formatBucketTime(item: any) {
  if (!item)
    return '0.0h'
  if (item.hoursText)
    return item.hoursText.replace('小时', 'h')
  const count = Number(item.count || 0)
  return `${(count / 3600).toFixed(1)}h`
}

const nextFarmCheck = ref('--')
const nextFriendCheck = ref('--')
const localUptime = ref(0)
let localNextFarmRemainSec = 0
let localNextFriendRemainSec = 0

function updateCountdowns() {
  if (status.value?.connection?.connected)
    localUptime.value++
  if (localNextFarmRemainSec > 0) {
    localNextFarmRemainSec--
    nextFarmCheck.value = formatDuration(localNextFarmRemainSec)
  }
  else {
    nextFarmCheck.value = '巡查中...'
  }
  if (localNextFriendRemainSec > 0) {
    localNextFriendRemainSec--
    nextFriendCheck.value = formatDuration(localNextFriendRemainSec)
  }
  else {
    nextFriendCheck.value = '巡查中...'
  }
}

watch(status, (newVal) => {
  if (newVal?.nextChecks) {
    localNextFarmRemainSec = newVal.nextChecks.farmRemainSec || 0
    localNextFriendRemainSec = newVal.nextChecks.friendRemainSec || 0
    updateCountdowns()
  }
  if (newVal?.uptime !== undefined)
    localUptime.value = newVal.uptime
}, { deep: true })

function formatDuration(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (d > 0)
    return `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function getExpPercent(p: any) {
  if (!p || !p.needed)
    return 0
  return Math.min(100, Math.max(0, (p.current / p.needed) * 100))
}

function formatLogTime(timeStr: string) {
  if (!timeStr)
    return ''
  const parts = timeStr.split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}

function getLogRowClass(log: any) {
  if (log.tag === '错误')
    return 'error'
  if (log.tag === '警告')
    return 'warn'
  return ''
}

const OP_META: Record<string, { label: string, faIcon: string, color: string }> = {
  harvest: { label: '收获', faIcon: 'fa-solid fa-wheat-awn', color: '#18a06f' },
  water: { label: '浇水', faIcon: 'fa-solid fa-droplet', color: '#4ab1ff' },
  weed: { label: '除草', faIcon: 'fa-solid fa-scissors', color: '#f2bc54' },
  bug: { label: '除虫', faIcon: 'fa-solid fa-bug', color: '#f06f68' },
  fertilize: { label: '施肥', faIcon: 'fa-solid fa-flask', color: '#18a06f' },
  plant: { label: '种植', faIcon: 'fa-solid fa-seedling', color: '#56d4a0' },
  upgrade: { label: '土地升级', faIcon: 'fa-solid fa-arrow-up', color: '#bca9ff' },
  levelUp: { label: '账号升级', faIcon: 'fa-solid fa-star', color: '#f2bc54' },
  steal: { label: '偷菜', faIcon: 'fa-solid fa-hand', color: '#ff9800' },
  helpWater: { label: '帮浇水', faIcon: 'fa-solid fa-droplet', color: '#4ab1ff' },
  helpWeed: { label: '帮除草', faIcon: 'fa-solid fa-scissors', color: '#f2bc54' },
  helpBug: { label: '帮除虫', faIcon: 'fa-solid fa-bug', color: '#f06f68' },
  taskClaim: { label: '任务', faIcon: 'fa-solid fa-check-circle', color: '#bca9ff' },
  sell: { label: '出售', faIcon: 'fa-solid fa-cart-shopping', color: '#4ab1ff' },
}

function getOpName(key: string | number) {
  return OP_META[String(key)]?.label || String(key)
}
function getOpFaIcon(key: string | number) {
  return OP_META[String(key)]?.faIcon || 'fa-solid fa-circle'
}
function getOpColor(key: string | number) {
  return OP_META[String(key)]?.color || 'var(--sub)'
}

async function refreshBag(force = false) {
  if (!currentAccountId.value)
    return
  if (!currentAccount.value?.running)
    return
  if (!status.value?.connection?.connected)
    return
  const now = Date.now()
  if (!force && now - lastBagFetchAt.value < 2500)
    return
  lastBagFetchAt.value = now
  await bagStore.fetchBag(currentAccountId.value)
}

async function refresh() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return
    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
      await statusStore.fetchAccountLogs()
    }
    if (hasActiveLogFilter.value || !realtimeConnected.value) {
      await statusStore.fetchLogs(currentAccountId.value, {
        module: filter.module || undefined,
        event: filter.event || undefined,
        keyword: filter.keyword || undefined,
        isWarn: filter.isWarn === 'warn' ? true : filter.isWarn === 'info' ? false : undefined,
      })
    }
    await refreshBag()
  }
}

watch(currentAccountId, () => { refresh() })
watch(() => status.value?.connection?.connected, (connected) => {
  if (connected)
    refreshBag(true)
})
watch(() => JSON.stringify(status.value?.operations || {}), (next, prev) => {
  if (!realtimeConnected.value || next === prev)
    return
  refreshBag()
})
watch(hasActiveLogFilter, (enabled) => {
  statusStore.setRealtimeLogsEnabled(!enabled)
  // 切换过滤时不立即清空日志，待 refresh() 拿到新数据后覆盖，避免空窗 flash
  refresh()
})

function onLogScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el)
    return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 50
}
watch(allLogs, () => {
  nextTick(() => {
    if (logContainer.value && autoScroll.value)
      logContainer.value.scrollTop = logContainer.value.scrollHeight
  })
}, { deep: true })

onMounted(() => {
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  refresh()
})
useIntervalFn(refresh, 10000)
useIntervalFn(updateCountdowns, 1000)
</script>

<template>
  <div class="dashboard-wrap">
    <!-- 状态卡片行 -->
    <div class="compact-status">
      <!-- 账号信息 -->
      <div class="status-item stretch">
        <div class="status-head">
          <i class="si total fa-solid fa-circle-user" />
          <span class="k">账号</span>
        </div>
        <div class="v" style="font-size: calc(18px * var(--font-scale)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="displayName">
          {{ displayName }}
        </div>
        <div class="s">Lv.{{ status?.status?.level || 0 }}</div>
      </div>

      <!-- 金币 -->
      <div class="status-item stretch">
        <div class="status-head">
          <i class="si coin fa-solid fa-coins" />
          <span class="k">金币</span>
        </div>
        <div class="v" style="color: #f0b84f;">{{ status?.status?.gold || 0 }}</div>
        <div
          v-if="(status?.sessionGoldGained || 0) !== 0"
          class="s"
          :style="{ color: (status?.sessionGoldGained || 0) > 0 ? 'var(--primary)' : 'var(--danger)' }"
        >
          {{ (status?.sessionGoldGained || 0) > 0 ? '+' : '' }}{{ status?.sessionGoldGained || 0 }}
        </div>
      </div>

      <!-- 点券 -->
      <div class="status-item">
        <div class="status-head">
          <i class="si exp fa-solid fa-ticket" />
          <span class="k">点券</span>
        </div>
        <div class="v" style="color: #4ab1ff;">{{ status?.status?.coupon || 0 }}</div>
        <div
          v-if="(status?.sessionCouponGained || 0) !== 0"
          class="s"
          :style="{ color: (status?.sessionCouponGained || 0) > 0 ? 'var(--primary)' : 'var(--danger)' }"
        >
          {{ (status?.sessionCouponGained || 0) > 0 ? '+' : '' }}{{ status?.sessionCouponGained || 0 }}
        </div>
      </div>

      <!-- 经验 -->
      <div class="status-item stretch">
        <div class="status-head">
          <i class="si exp fa-solid fa-bolt" />
          <span class="k">经验</span>
        </div>
        <div class="v" style="color: #4ab1ff; font-size: calc(16px * var(--font-scale));">
          {{ status?.levelProgress?.current || 0 }} / {{ status?.levelProgress?.needed || '?' }}
        </div>
        <div class="progress" style="margin-top: 5px;">
          <div class="progress-fill exp" :style="{ width: `${getExpPercent(status?.levelProgress)}%` }" />
        </div>
        <div class="s" style="display:flex; justify-content:space-between;">
          <span>{{ expRate }}</span>
          <span v-if="timeToLevel" style="color: var(--accent);">{{ timeToLevel }}</span>
        </div>
      </div>

      <!-- 普通肥 -->
      <div class="status-item">
        <div class="status-head">
          <i class="si rate fa-solid fa-flask" />
          <span class="k">普通肥</span>
        </div>
        <div class="v">{{ formatBucketTime(fertilizerNormal) }}</div>
      </div>

      <!-- 有机肥 -->
      <div class="status-item">
        <div class="status-head">
          <i class="si rate fa-solid fa-vial" />
          <span class="k">有机肥</span>
        </div>
        <div class="v">{{ formatBucketTime(fertilizerOrganic) }}</div>
      </div>

      <!-- 收藏点 -->
      <div class="status-item">
        <div class="status-head">
          <i class="si level fa-solid fa-star" />
          <span class="k">普通收藏</span>
        </div>
        <div class="v">{{ collectionNormal?.count || 0 }}</div>
      </div>

      <!-- 典藏点 -->
      <div class="status-item">
        <div class="status-head">
          <i class="si coin fa-solid fa-gem" />
          <span class="k">典藏</span>
        </div>
        <div class="v">{{ collectionRare?.count || 0 }}</div>
      </div>
    </div>

    <!-- 主内容网格 -->
    <div class="dashboard-grid">
      <!-- 日志卡片 -->
      <div class="card logs-card">
        <div class="card-head">
          <h3>
            <i class="fa-solid fa-scroll" />
            运行日志
          </h3>
          <div class="log-filters">
            <select v-model="filter.module" class="log-filter-select" @change="refresh">
              <option v-for="m in modules" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <select v-model="filter.event" class="log-filter-select" @change="refresh">
              <option v-for="e in events" :key="e.value" :value="e.value">{{ e.label }}</option>
            </select>
            <select v-model="filter.isWarn" class="log-filter-select" @change="refresh">
              <option v-for="l in logLevelOpts" :key="l.value" :value="l.value">{{ l.label }}</option>
            </select>
            <input
              v-model="filter.keyword"
              class="log-filter-input"
              placeholder="关键词..."
              @keyup.enter="refresh"
            >
            <button class="btn btn-primary btn-sm" @click="refresh">
              <i class="fa-solid fa-search" />
            </button>
          </div>
        </div>

        <div
          ref="logContainer"
          class="logs-container"
          @scroll="onLogScroll"
        >
          <div v-if="!allLogs.length" class="empty-state">暂无日志</div>
          <div
            v-for="log in allLogs"
            :key="log.ts + log.msg"
            class="log-row"
            :class="getLogRowClass(log)"
          >
            <span class="log-time">{{ formatLogTime(log.time) }}</span>
            <span class="log-tag">{{ log.tag }}</span>
            <span v-if="log.meta?.event" class="log-event">{{ getEventLabel(log.meta.event) }}</span>
            <span class="log-msg">{{ log.msg }}</span>
          </div>
        </div>
      </div>

      <!-- 右侧栏 -->
      <div class="side-stack">
        <!-- 倒计时卡片 -->
        <div class="card">
          <div class="card-head">
            <h3>
              <i class="fa-solid fa-hourglass-half" />
              下次巡查
            </h3>
          </div>
          <div class="next-check-item">
            <span class="label">
              <i class="fa-solid fa-seedling" style="color: var(--primary);" />
              农场
            </span>
            <span class="value">{{ nextFarmCheck }}</span>
          </div>
          <div class="next-check-item">
            <span class="label">
              <i class="fa-solid fa-users" style="color: var(--accent);" />
              好友
            </span>
            <span class="value">{{ nextFriendCheck }}</span>
          </div>
          <div class="next-check-item" style="border-bottom:none; padding-top:8px;">
            <span class="label">
              <i class="fa-solid fa-clock" style="color: var(--sub);" />
              运行时长
            </span>
            <span class="value" style="font-size: calc(14px * var(--font-scale));">{{ formatDuration(localUptime) }}</span>
          </div>
        </div>

        <!-- 今日统计卡片 -->
        <div class="card" style="flex:1; min-height:0; overflow:hidden; display:flex; flex-direction:column;">
          <div class="card-head" style="flex-shrink:0;">
            <h3>
              <i class="fa-solid fa-chart-column" />
              今日统计
            </h3>
          </div>
          <div class="ops-list">
            <div v-if="!Object.keys(status?.operations || {}).length" class="empty-state" style="padding: 16px;">
              暂无数据
            </div>
            <div
              v-for="(val, key) in (status?.operations || {})"
              :key="key"
              class="op-stat"
            >
              <span class="label">
                <i :class="getOpFaIcon(key)" :style="{ color: getOpColor(key) }" />
                {{ getOpName(key) }}
              </span>
              <span class="count">{{ val }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.compact-status {
  flex-shrink: 0;
}

.dashboard-grid {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.logs-card {
  height: 100%;
  overflow: hidden;
}

.side-stack {
  height: 100%;
  overflow: hidden;
}

@media (max-width: 980px) {
  .dashboard-wrap {
    height: auto;
    overflow: visible;
  }
  .dashboard-grid {
    overflow: visible;
    height: auto;
  }
  .logs-card {
    height: auto;
  }
  .side-stack {
    height: auto;
    overflow: visible;
  }
}
</style>
