<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const bagStore = useBagStore()
const statusStore = useStatusStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { items, loading: bagLoading } = storeToRefs(bagStore)
const { status, loading: statusLoading, error: statusError, realtimeConnected } = storeToRefs(statusStore)

const imageErrors = ref<Record<string | number, boolean>>({})

async function loadBag() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }

    if (acc.running && status.value?.connection?.connected) {
      bagStore.fetchBag(currentAccountId.value)
    }
    imageErrors.value = {}
  }
}

onMounted(() => {
  loadBag()
})

watch(currentAccountId, () => {
  loadBag()
})

useIntervalFn(loadBag, 60000)
</script>

<template>
  <div class="bag-panel">
    <div class="bag-header">
      <h2 class="bag-title">
        <i class="fa-solid fa-box-open" />
        背包
      </h2>
      <div v-if="items.length" class="bag-count">
        共 {{ items.length }} 种物品
      </div>
    </div>

    <div v-if="bagLoading || statusLoading" class="bag-state">
      <i class="fa-solid fa-spinner fa-spin" style="font-size:2rem; color: var(--accent);" />
    </div>

    <div v-else-if="!currentAccountId" class="bag-state">
      请选择账号后查看背包
    </div>

    <div v-else-if="statusError" class="bag-state bag-error">
      <div class="bag-error-title">获取数据失败</div>
      <div class="bag-error-sub">{{ statusError }}</div>
    </div>

    <div v-else-if="!status?.connection?.connected" class="bag-state">
      <i class="fa-solid fa-plug-circle-xmark" style="font-size:2rem; color: var(--text-muted);" />
      <div>
        <div class="bag-offline-title">账号未登录</div>
        <div class="bag-offline-sub">请先运行账号或检查网络连接</div>
      </div>
    </div>

    <div v-else-if="items.length === 0" class="bag-state">
      无可展示物品
    </div>

    <div v-else class="bag-grid">
      <div
        v-for="item in items"
        :key="item.id"
        class="bag-item"
      >
        <div class="bag-item-id">#{{ item.id }}</div>

        <div
          class="bag-thumb"
          :data-fallback="(item.name || '物').slice(0, 1)"
        >
          <img
            v-if="item.image && !imageErrors[item.id]"
            :src="item.image"
            :alt="item.name"
            loading="lazy"
            @error="imageErrors[item.id] = true"
          >
          <span v-else class="bag-thumb-fallback">
            {{ (item.name || '物').slice(0, 1) }}
          </span>
        </div>

        <div class="bag-item-name" :title="item.name">
          {{ item.name || `物品${item.id}` }}
        </div>

        <div class="bag-item-meta">
          <span v-if="item.uid">UID: {{ item.uid }}</span>
          <span>
            类型: {{ item.itemType || 0 }}
            <span v-if="item.level > 0"> · Lv{{ item.level }}</span>
            <span v-if="item.price > 0"> · {{ item.price }}金</span>
          </span>
        </div>

        <div class="bag-item-count" :class="item.hoursText ? 'count-time' : 'count-num'">
          {{ item.hoursText || `x${item.count || 0}` }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bag-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.bag-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.bag-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}

.bag-count {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.bag-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  text-align: center;
  color: var(--text-muted);
  background: var(--panel);
  border-radius: 10px;
}

.bag-error {
  border: 1px solid rgba(240,111,104,0.4);
  background: rgba(240,111,104,0.08);
  color: #f06f68;
}

.bag-error-title {
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 4px;
}

.bag-error-sub {
  font-size: 0.8rem;
  opacity: 0.8;
}

.bag-offline-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-sub);
  margin-bottom: 4px;
}

.bag-offline-sub {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.bag-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}

.bag-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  transition: box-shadow 0.15s, border-color 0.15s;
}

.bag-item:hover {
  border-color: var(--accent);
  box-shadow: 0 2px 12px rgba(74,177,255,0.12);
}

.bag-item-id {
  position: absolute;
  top: 6px;
  left: 8px;
  font-size: 0.7rem;
  color: var(--text-muted);
  font-family: monospace;
}

.bag-thumb {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--panel-2);
  margin-top: 20px;
  margin-bottom: 8px;
  overflow: hidden;
}

.bag-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.bag-thumb-fallback {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
}

.bag-item-name {
  width: 100%;
  font-size: 0.8rem;
  font-weight: 700;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 4px;
  color: var(--text);
  margin-bottom: 4px;
}

.bag-item-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-bottom: 8px;
  text-align: center;
}

.bag-item-count {
  font-size: 0.85rem;
  font-weight: 600;
  margin-top: auto;
}

.count-time { color: var(--accent); }
.count-num  { color: var(--text-sub); }
</style>
