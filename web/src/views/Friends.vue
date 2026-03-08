<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandCard from '@/components/LandCard.vue'
import { useAccountStore } from '@/stores/account'
import { useFriendStore } from '@/stores/friend'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const friendStore = useFriendStore()
const statusStore = useStatusStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { friends, loading, friendLands, friendLandsLoading, blacklist } = storeToRefs(friendStore)
const { status, loading: statusLoading, realtimeConnected } = storeToRefs(statusStore)

const showConfirm = ref(false)
const confirmMessage = ref('')
const confirmLoading = ref(false)
const pendingAction = ref<(() => Promise<void>) | null>(null)
const avatarErrorKeys = ref<Set<string>>(new Set())

function confirmAction(msg: string, action: () => Promise<void>) {
  confirmMessage.value = msg
  pendingAction.value = action
  showConfirm.value = true
}

async function onConfirm() {
  if (pendingAction.value) {
    try {
      confirmLoading.value = true
      await pendingAction.value()
      pendingAction.value = null
      showConfirm.value = false
    }
    finally {
      confirmLoading.value = false
    }
  }
  else {
    showConfirm.value = false
  }
}

const expandedFriends = ref<Set<string>>(new Set())

async function loadFriends() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return
    if (!realtimeConnected.value)
      await statusStore.fetchStatus(currentAccountId.value)
    if (acc.running && status.value?.connection?.connected) {
      avatarErrorKeys.value.clear()
      friendStore.fetchFriends(currentAccountId.value)
      friendStore.fetchBlacklist(currentAccountId.value)
    }
  }
}

useIntervalFn(() => {
  for (const gid in friendLands.value) {
    if (friendLands.value[gid]) {
      friendLands.value[gid] = friendLands.value[gid].map((l: any) =>
        l.matureInSec > 0 ? { ...l, matureInSec: l.matureInSec - 1 } : l,
      )
    }
  }
}, 1000)

onMounted(() => { loadFriends() })
watch(currentAccountId, () => {
  expandedFriends.value.clear()
  loadFriends()
})
useIntervalFn(() => { loadFriends() }, 30000)

function toggleFriend(friendId: string) {
  if (expandedFriends.value.has(friendId)) {
    expandedFriends.value.delete(friendId)
  }
  else {
    expandedFriends.value.clear()
    expandedFriends.value.add(friendId)
    if (currentAccountId.value && currentAccount.value?.running && status.value?.connection?.connected) {
      friendStore.fetchFriendLands(currentAccountId.value, friendId)
    }
  }
}

async function handleOp(friendId: string, type: string, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return
  confirmAction('确定执行此操作吗?', async () => {
    await friendStore.operate(currentAccountId.value!, friendId, type)
  })
}

async function handleToggleBlacklist(friend: any, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return
  await friendStore.toggleBlacklist(currentAccountId.value, Number(friend.gid))
}

function getFriendStatusText(friend: any) {
  const p = friend.plant || {}
  const info = []
  if (p.stealNum) info.push(`偷${p.stealNum}`)
  if (p.dryNum) info.push(`水${p.dryNum}`)
  if (p.weedNum) info.push(`草${p.weedNum}`)
  if (p.insectNum) info.push(`虫${p.insectNum}`)
  return info.length ? info.join(' ') : '无操作'
}

function getFriendAvatar(friend: any) {
  const direct = String(friend?.avatarUrl || friend?.avatar_url || '').trim()
  if (direct) return direct
  const uin = String(friend?.uin || '').trim()
  if (uin) return `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=100`
  return ''
}

function getFriendAvatarKey(friend: any) {
  const key = String(friend?.gid || friend?.uin || '').trim()
  return key || String(friend?.name || '').trim()
}

function canShowFriendAvatar(friend: any) {
  const key = getFriendAvatarKey(friend)
  if (!key) return false
  return !!getFriendAvatar(friend) && !avatarErrorKeys.value.has(key)
}

function handleFriendAvatarError(friend: any) {
  const key = getFriendAvatarKey(friend)
  if (!key) return
  avatarErrorKeys.value.add(key)
}
</script>

<template>
  <div class="friends-page">
    <!-- 页头 -->
    <div class="page-header">
      <h2 class="page-title">
        <i class="fa-solid fa-users" />
        好友
      </h2>
      <span v-if="friends.length" class="page-subtitle">共 {{ friends.length }} 名好友</span>
    </div>

    <!-- 加载中 -->
    <div v-if="loading || statusLoading" class="empty-state">
      <div class="loading-spin" />
    </div>

    <!-- 未选账号 -->
    <div v-else-if="!currentAccountId" class="card empty-state">
      请选择账号后查看好友
    </div>

    <!-- 未连接 -->
    <div v-else-if="!status?.connection?.connected" class="card empty-state">
      <i class="fa-solid fa-circle-xmark" style="font-size: 32px; color: var(--sub); margin-bottom: 12px;" />
      <div style="font-size: calc(16px * var(--font-scale)); color: var(--text); font-weight: 600;">账号未登录</div>
      <div style="font-size: calc(13px * var(--font-scale)); color: var(--sub); margin-top: 4px;">请先运行账号或检查网络连接</div>
    </div>

    <!-- 无好友 -->
    <div v-else-if="friends.length === 0" class="card empty-state">
      暂无好友或数据加载失败
    </div>

    <!-- 好友列表 -->
    <div v-else>
      <div
        v-for="friend in friends"
        :key="friend.gid"
        class="friend-item"
        :class="{ blacklisted: blacklist.includes(Number(friend.gid)) }"
      >
        <div class="friend-header" @click="toggleFriend(friend.gid)">
          <!-- 头像 -->
          <div class="friend-avatar">
            <img
              v-if="canShowFriendAvatar(friend)"
              :src="getFriendAvatar(friend)"
              loading="lazy"
              @error="handleFriendAvatarError(friend)"
            >
            <i v-else class="fa-solid fa-user" style="color: var(--sub);" />
          </div>

          <!-- 信息 -->
          <div class="friend-info">
            <div class="friend-name">
              {{ friend.name && String(friend.name).trim() ? String(friend.name).trim() : `GID:${friend.gid}` }}
              <span v-if="blacklist.includes(Number(friend.gid))" class="blacklist-tag">已屏蔽</span>
            </div>
            <div class="friend-status" :class="{ 'has-ops': getFriendStatusText(friend) !== '无操作' }">
              {{ getFriendStatusText(friend) }}
            </div>
          </div>

          <!-- 操作按钮 -->
          <div class="friend-actions">
            <button class="btn btn-sm friend-op-btn steal" @click="handleOp(friend.gid, 'steal', $event)">
              <i class="fa-solid fa-hand" /> 偷取
            </button>
            <button class="btn btn-sm friend-op-btn water" @click="handleOp(friend.gid, 'water', $event)">
              <i class="fa-solid fa-droplet" /> 浇水
            </button>
            <button class="btn btn-sm friend-op-btn weed" @click="handleOp(friend.gid, 'weed', $event)">
              <i class="fa-solid fa-scissors" /> 除草
            </button>
            <button class="btn btn-sm friend-op-btn bug" @click="handleOp(friend.gid, 'bug', $event)">
              <i class="fa-solid fa-bug" /> 除虫
            </button>
            <button class="btn btn-sm friend-op-btn bad" @click="handleOp(friend.gid, 'bad', $event)">
              <i class="fa-solid fa-skull" /> 捣乱
            </button>
            <button
              class="btn btn-sm friend-op-btn"
              :class="blacklist.includes(Number(friend.gid)) ? 'unblock' : 'block'"
              @click="handleToggleBlacklist(friend, $event)"
            >
              <i :class="blacklist.includes(Number(friend.gid)) ? 'fa-solid fa-check' : 'fa-solid fa-ban'" />
              {{ blacklist.includes(Number(friend.gid)) ? '移出黑名单' : '加入黑名单' }}
            </button>
          </div>

          <i class="fa-solid fa-chevron-down expand-icon" :class="{ rotated: expandedFriends.has(friend.gid) }" />
        </div>

        <!-- 土地展开区 -->
        <div v-if="expandedFriends.has(friend.gid)" class="friend-lands">
          <div v-if="friendLandsLoading[friend.gid]" class="empty-state" style="padding: 16px;">
            <div class="loading-spin" />
          </div>
          <div v-else-if="!friendLands[friend.gid] || friendLands[friend.gid]?.length === 0" class="empty-state" style="padding: 12px;">
            无土地数据
          </div>
          <div v-else class="lands-grid">
            <LandCard
              v-for="land in friendLands[friend.gid]"
              :key="land.id"
              :land="land"
            />
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="showConfirm"
      :loading="confirmLoading"
      title="确认操作"
      :message="confirmMessage"
      @confirm="onConfirm"
      @cancel="!confirmLoading && (showConfirm = false)"
      @close="!confirmLoading && (showConfirm = false)"
    />
  </div>
</template>

<style scoped>
.friends-page {
  padding: 14px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.page-title {
  margin: 0;
  font-size: calc(22px * var(--font-scale));
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.page-title i { color: var(--accent); }
.page-subtitle {
  font-size: calc(13px * var(--font-scale));
  color: var(--sub);
}

.blacklist-tag {
  display: inline-block;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 0.78em;
  color: var(--sub);
  font-weight: 400;
  margin-left: 6px;
}

/* 操作按钮颜色 */
.friend-op-btn {
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 4px;
}
.friend-op-btn.steal  { color: #4ab1ff; border-color: rgba(74,177,255,0.3); }
.friend-op-btn.water  { color: #56d4a0; border-color: rgba(86,212,160,0.3); }
.friend-op-btn.weed   { color: #f2bc54; border-color: rgba(242,188,84,0.3); }
.friend-op-btn.bug    { color: #f06f68; border-color: rgba(240,111,104,0.3); }
.friend-op-btn.bad    { color: #ff9800; border-color: rgba(255,152,0,0.3); }
.friend-op-btn.block  { color: var(--sub); }
.friend-op-btn.unblock { color: var(--primary); border-color: rgba(24,160,111,0.3); }
.friend-op-btn:hover  { opacity: 0.85; }

/* 展开箭头 */
.expand-icon {
  color: var(--sub);
  font-size: 12px;
  transition: transform 0.2s;
  margin-left: 4px;
  flex-shrink: 0;
}
.expand-icon.rotated { transform: rotate(180deg); }
</style>
