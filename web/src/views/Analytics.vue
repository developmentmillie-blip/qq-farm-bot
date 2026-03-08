<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

const accountStore = useAccountStore()
const { currentAccountId } = storeToRefs(accountStore)

const loading = ref(false)
const list = ref<any[]>([])
const sortKey = ref('exp')
const imageErrors = ref<Record<string | number, boolean>>({})

const sortOptions = [
  { value: 'exp', label: '经验/小时' },
  { value: 'fert', label: '普通肥经验/小时' },
  { value: 'profit', label: '利润/小时' },
  { value: 'fert_profit', label: '普通肥利润/小时' },
  { value: 'level', label: '等级' },
]

async function loadAnalytics() {
  if (!currentAccountId.value)
    return
  loading.value = true
  try {
    const res = await api.get(`/api/analytics`, {
      params: { sort: sortKey.value },
      headers: { 'x-account-id': currentAccountId.value },
    })
    const data = res.data.data
    if (Array.isArray(data)) {
      list.value = data
    }
    else {
      list.value = []
    }
  }
  catch (e) {
    console.error(e)
    list.value = []
  }
  finally {
    loading.value = false
  }
}

onMounted(() => { loadAnalytics() })
watch([currentAccountId, sortKey], () => { loadAnalytics() })

function formatLv(level: any) {
  if (level === null || level === undefined || level === '' || Number(level) < 0)
    return '未知'
  return String(level)
}

function formatGrowTime(seconds: any) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return '0秒'
  if (s < 60) return `${s}秒`
  if (s < 3600) {
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return secs > 0 ? `${mins}分${secs}秒` : `${mins}分`
  }
  const hours = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  return mins > 0 ? `${hours}时${mins}分` : `${hours}时`
}
</script>

<template>
  <div class="analytics-page">
    <!-- 页头 -->
    <div class="page-header">
      <h2 class="page-title">
        <i class="fa-solid fa-chart-line" />
        数据分析
      </h2>
      <div class="analytics-sort">
        <label>排序方式：</label>
        <select v-model="sortKey" class="form-control" style="width: 160px; min-height: 36px;">
          <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="empty-state">
      <div class="loading-spin" />
    </div>

    <!-- 未选账号 -->
    <div v-else-if="!currentAccountId" class="card empty-state">
      请选择账号后查看数据分析
    </div>

    <!-- 无数据 -->
    <div v-else-if="list.length === 0" class="card empty-state">
      暂无数据
    </div>

    <!-- 表格 -->
    <div v-else class="card" style="padding: 0; overflow: hidden;">
      <div class="table-wrap">
        <table class="analytics-table">
          <thead>
            <tr>
              <th class="th-sticky">作物</th>
              <th>时间</th>
              <th class="text-right">经验/时</th>
              <th class="text-right">普通肥经验/时</th>
              <th class="text-right">净利润/时</th>
              <th class="text-right">普通肥净利润/时</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, idx) in list" :key="idx">
              <td class="td-sticky">
                <div class="seed-cell">
                  <div class="seed-img-wrap">
                    <img
                      v-if="item.image && !imageErrors[item.seedId]"
                      :src="item.image"
                      loading="lazy"
                      @error="imageErrors[item.seedId] = true"
                    >
                    <i v-else class="fa-solid fa-seedling" style="color: var(--sub);" />
                  </div>
                  <div>
                    <div class="seed-name">{{ item.name }}</div>
                    <div class="seed-meta">
                      <span class="seed-lv">Lv{{ formatLv(item.level) }}</span>
                      <span class="seed-id">ID:{{ item.seedId }}</span>
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <div class="analytics-val">{{ formatGrowTime(item.growTime) }}</div>
                <div class="analytics-sub">{{ item.seasons }}季</div>
              </td>
              <td class="text-right">
                <span class="analytics-val" style="color: #bca9ff;">{{ item.expPerHour }}</span>
              </td>
              <td class="text-right">
                <span class="analytics-val" style="color: #4ab1ff;">{{ item.normalFertilizerExpPerHour ?? '-' }}</span>
              </td>
              <td class="text-right">
                <span class="analytics-val" style="color: #f0b84f;">{{ item.profitPerHour ?? '-' }}</span>
              </td>
              <td class="text-right">
                <span class="analytics-val" style="color: #18a06f;">{{ item.normalFertilizerProfitPerHour ?? '-' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.analytics-page {
  padding: 14px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
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

.analytics-sort {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(14px * var(--font-scale));
  color: var(--sub);
}

.table-wrap {
  overflow-x: auto;
}

.text-right { text-align: right !important; }

.th-sticky,
.td-sticky {
  position: sticky;
  left: 0;
  background: var(--panel);
  z-index: 1;
}

.seed-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 160px;
}
.seed-img-wrap {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex-shrink: 0;
}
.seed-img-wrap img {
  width: 30px;
  height: 30px;
  object-fit: contain;
}
.seed-name {
  font-weight: 700;
  font-size: calc(14px * var(--font-scale));
  color: var(--text);
}
.seed-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.seed-lv {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: calc(11px * var(--font-scale));
  color: var(--sub);
}
.seed-id {
  font-size: calc(11px * var(--font-scale));
  color: var(--sub);
}

.analytics-val {
  font-weight: 700;
  font-size: calc(15px * var(--font-scale));
}
.analytics-sub {
  font-size: calc(12px * var(--font-scale));
  color: var(--sub);
}
</style>
