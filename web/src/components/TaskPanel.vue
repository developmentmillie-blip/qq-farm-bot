<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, watch } from 'vue'
import DailyOverview from '@/components/DailyOverview.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const { status, dailyGifts, realtimeConnected } = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const growth = computed(() => dailyGifts.value?.growth || null)

async function refresh() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }
    if (acc.running && status.value?.connection?.connected) {
      statusStore.fetchDailyGifts(currentAccountId.value)
    }
  }
}

onMounted(() => {
  refresh()
})

watch(currentAccountId, () => {
  refresh()
})

function formatTaskProgress(task: any) {
  if (!task)
    return '未开始'
  const rawCurrent = task.progress ?? task.current
  const rawTarget = task.totalProgress ?? task.target

  const current = Number.isFinite(rawCurrent)
    ? rawCurrent
    : (rawCurrent ? Number(rawCurrent) || 0 : 0)

  const target = Number.isFinite(rawTarget)
    ? rawTarget
    : (rawTarget ? Number(rawTarget) || 0 : 0)

  if (!current && !target)
    return '未开始'

  if (target && current >= target)
    return '已完成'

  return `进度：${current}/${target}`
}
</script>

<template>
  <div class="task-panel">
    <!-- Daily Overview -->
    <DailyOverview :daily-gifts="dailyGifts" />

    <!-- Growth Task -->
    <div class="card">
      <div class="task-card-header">
        <h3 class="task-card-title">
          <i class="fa-solid fa-arrow-trend-up" style="color: var(--primary);" />
          成长任务
        </h3>
        <span
          v-if="growth"
          class="task-badge"
          :class="growth.doneToday ? 'badge-done' : 'badge-progress'"
        >
          {{ growth.doneToday ? '今日已完成' : `${growth.completedCount}/${growth.totalCount}` }}
        </span>
      </div>

      <div
        v-if="!currentAccountId"
        class="task-empty"
      >
        <i class="fa-solid fa-user" style="font-size:1.5rem; opacity:0.4;" />
        <span>请选择账号查看任务详情</span>
      </div>
      <div
        v-else-if="!status?.connection?.connected"
        class="task-empty"
      >
        <i class="fa-solid fa-plug-circle-xmark" style="font-size:1.5rem; color: var(--text-muted);" />
        <div>
          <div class="task-offline-title">账号未登录</div>
          <div class="task-offline-sub">请先运行账号或检查网络连接</div>
        </div>
      </div>
      <div
        v-else-if="growth && growth.tasks && growth.tasks.length"
        class="task-list"
      >
        <div
          v-for="(task, idx) in growth.tasks"
          :key="idx"
          class="task-row"
        >
          <span class="task-desc">{{ task.desc || task.name }}</span>
          <span class="task-progress">{{ formatTaskProgress(task) }}</span>
        </div>
      </div>
      <div v-else class="task-empty-text">
        暂无任务详情
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.task-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.task-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}

.task-badge {
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 700;
}

.badge-done {
  background: rgba(24,160,111,0.15);
  color: #18a06f;
}

.badge-progress {
  background: rgba(74,177,255,0.12);
  color: var(--accent);
}

.task-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 16px;
  text-align: center;
  color: var(--text-muted);
  background: var(--panel-2);
  border-radius: 8px;
  font-size: 0.85rem;
}

.task-offline-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-sub);
  margin-bottom: 4px;
}

.task-offline-sub {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.85rem;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}

.task-row:last-child {
  border-bottom: none;
}

.task-desc {
  color: var(--text-sub);
}

.task-progress {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.task-empty-text {
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-muted);
  padding: 16px 0;
}
</style>
