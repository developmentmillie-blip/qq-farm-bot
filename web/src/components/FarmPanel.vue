<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandCard from '@/components/LandCard.vue'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useStatusStore } from '@/stores/status'

const farmStore = useFarmStore()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const { lands, summary, loading } = storeToRefs(farmStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, loading: statusLoading, realtimeConnected } = storeToRefs(statusStore)

const operating = ref(false)
const confirmVisible = ref(false)
const confirmConfig = ref({
  title: '',
  message: '',
  opType: '',
})

async function executeOperate() {
  if (!currentAccountId.value || !confirmConfig.value.opType)
    return
  confirmVisible.value = false
  operating.value = true
  try {
    await farmStore.operate(currentAccountId.value, confirmConfig.value.opType)
  }
  finally {
    operating.value = false
  }
}

function handleOperate(opType: string) {
  if (!currentAccountId.value)
    return

  const confirmMap: Record<string, string> = {
    harvest: '确定要收获所有成熟作物吗？',
    clear: '确定要一键除草/除虫吗？',
    plant: '确定要一键种植吗？(根据策略配置)',
    upgrade: '确定要升级所有可升级的土地吗？(消耗金币)',
    all: '确定要一键全收吗？(包含收获、除草/除虫，不会自动种植)',
  }

  confirmConfig.value = {
    title: '确认操作',
    message: confirmMap[opType] || '确定执行此操作吗？',
    opType,
  }
  confirmVisible.value = true
}

const operations = [
  { type: 'harvest', label: '收获', icon: 'fa-solid fa-wheat-awn', color: 'op-harvest' },
  { type: 'clear', label: '除草/虫', icon: 'fa-solid fa-broom', color: 'op-clear' },
  { type: 'plant', label: '种植', icon: 'fa-solid fa-seedling', color: 'op-plant' },
  { type: 'upgrade', label: '升级土地', icon: 'fa-solid fa-arrow-up', color: 'op-upgrade' },
  { type: 'all', label: '一键全收', icon: 'fa-solid fa-bolt', color: 'op-all' },
]

async function refresh() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }

    if (acc.running && status.value?.connection?.connected) {
      farmStore.fetchLands(currentAccountId.value)
    }
  }
}

watch(currentAccountId, () => {
  refresh()
})

const { pause, resume } = useIntervalFn(() => {
  if (lands.value) {
    lands.value = lands.value.map((l: any) =>
      l.matureInSec > 0 ? { ...l, matureInSec: l.matureInSec - 1 } : l,
    )
  }
}, 1000)

const { pause: pauseRefresh, resume: resumeRefresh } = useIntervalFn(refresh, 60000)

onMounted(() => {
  refresh()
  resume()
  resumeRefresh()
})

onUnmounted(() => {
  pause()
  pauseRefresh()
})
</script>

<template>
  <div class="farm-panel">
    <div class="card">
      <!-- Header with Title and Actions -->
      <div class="farm-header">
        <h3 class="farm-title">
          <i class="fa-solid fa-border-all" />
          土地详情
        </h3>
        <div class="farm-ops">
          <button
            v-for="op in operations"
            :key="op.type"
            class="farm-op-btn"
            :class="op.color"
            :disabled="operating"
            @click="handleOperate(op.type)"
          >
            <i :class="op.icon" />
            {{ op.label }}
          </button>
        </div>
      </div>

      <!-- Summary -->
      <div class="farm-summary">
        <span class="farm-tag tag-harvest">
          <i class="fa-solid fa-basket-shopping" />
          可收: {{ summary?.harvestable || 0 }}
        </span>
        <span class="farm-tag tag-grow">
          <i class="fa-solid fa-seedling" />
          生长: {{ summary?.growing || 0 }}
        </span>
        <span class="farm-tag tag-empty">
          <i class="fa-solid fa-square" />
          空闲: {{ summary?.empty || 0 }}
        </span>
        <span class="farm-tag tag-dead">
          <i class="fa-solid fa-triangle-exclamation" />
          枯萎: {{ summary?.dead || 0 }}
        </span>
      </div>

      <!-- Grid -->
      <div class="farm-grid-wrap">
        <div v-if="loading || statusLoading" class="farm-loading">
          <i class="fa-solid fa-spinner fa-spin" style="font-size:2rem; color: var(--accent);" />
        </div>

        <div v-else-if="!status?.connection?.connected" class="farm-empty">
          <i class="fa-solid fa-plug-circle-xmark" style="font-size:2rem; color: var(--text-muted);" />
          <div>
            <div class="farm-empty-title">账号未登录</div>
            <div class="farm-empty-sub">请先运行账号或检查网络连接</div>
          </div>
        </div>

        <div v-else-if="!lands || lands.length === 0" class="farm-empty">
          暂无土地数据
        </div>

        <div v-else class="lands-grid">
          <LandCard
            v-for="land in lands"
            :key="land.id"
            :land="land"
          />
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="confirmVisible"
      :title="confirmConfig.title"
      :message="confirmConfig.message"
      @confirm="executeOperate"
      @cancel="confirmVisible = false"
    />
  </div>
</template>

<style scoped>
.farm-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.farm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}

.farm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}

.farm-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.farm-op-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
}

.farm-op-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.farm-op-btn:not(:disabled):hover {
  opacity: 0.85;
  transform: translateY(-1px);
}

.op-harvest { background: #4ab1ff; }
.op-clear   { background: #18a06f; }
.op-plant   { background: #30c87a; }
.op-upgrade { background: #a78bfa; }
.op-all     { background: #f2bc54; color: #1a1a1a; }

.farm-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}

.farm-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: 600;
}

.tag-harvest { background: rgba(242,188,84,0.15); color: #f2bc54; }
.tag-grow    { background: rgba(24,160,111,0.15); color: #18a06f; }
.tag-empty   { background: rgba(160,160,160,0.1); color: var(--text-muted); }
.tag-dead    { background: rgba(240,111,104,0.15); color: #f06f68; }

.farm-grid-wrap {
  padding: 16px;
}

.farm-loading,
.farm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  text-align: center;
  color: var(--text-muted);
}

.farm-empty-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-sub);
  margin-bottom: 4px;
}

.farm-empty-sub {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.lands-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 12px;
}
</style>
