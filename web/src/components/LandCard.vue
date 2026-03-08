<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  land: any
}>()

const land = computed(() => props.land)

function getLandLevelClass(level: number) {
  const map: Record<number, string> = {
    0: 'land-level-0',
    1: 'land-level-1',
    2: 'land-level-2',
    3: 'land-level-3',
    4: 'land-level-4',
  }
  return map[level] || 'land-level-0'
}

function formatTime(sec: number) {
  if (sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h > 0 ? `${h}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function getSafeImageUrl(url: string) {
  if (!url) return ''
  if (url.startsWith('http://')) return url.replace('http://', 'https://')
  return url
}

function getLandTypeName(level: number) {
  const typeMap: Record<number, string> = {
    0: '普通', 1: '黄土地', 2: '红土地', 3: '黑土地', 4: '金土地',
  }
  return typeMap[Number(level) || 0] || ''
}
</script>

<template>
  <div
    class="land-cell"
    :class="[
      getLandLevelClass(Number(land.level) || 0),
      {
        'land-locked': land.status === 'locked',
        'land-dead': land.status === 'dead',
        'land-harvestable': land.status === 'harvestable',
        'land-stealable': land.status === 'stealable',
      },
    ]"
  >
    <!-- 编号 -->
    <div class="land-id">#{{ land.id }}</div>

    <!-- 图片 -->
    <div class="land-img">
      <img
        v-if="land.seedImage"
        :src="getSafeImageUrl(land.seedImage)"
        loading="lazy"
        referrerpolicy="no-referrer"
      >
      <i v-else class="fa-solid fa-seedling" style="color: var(--sub);" />
    </div>

    <!-- 植物名称 -->
    <div class="land-plant-name" :title="land.plantName">
      {{ land.plantName || '-' }}
    </div>

    <!-- 状态/时间 -->
    <div class="land-time">
      <span v-if="land.matureInSec > 0" style="color: var(--warn);">
        {{ formatTime(land.matureInSec) }}
      </span>
      <span v-else>
        {{ land.phaseName || (land.status === 'locked' ? '未解锁' : '未开垦') }}
      </span>
    </div>

    <!-- 土地类型 -->
    <div class="land-type">{{ getLandTypeName(land.level) }}</div>

    <!-- 状态标签 -->
    <div class="land-badges">
      <span v-if="land.needWater" class="land-badge water">水</span>
      <span v-if="land.needWeed" class="land-badge weed">草</span>
      <span v-if="land.needBug" class="land-badge bug">虫</span>
      <span v-if="land.status === 'harvestable'" class="land-badge harvest">偷</span>
    </div>
  </div>
</template>

<style scoped>
.land-cell {
  position: relative;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 4px 4px;
  transition: box-shadow 0.15s;
}
.land-cell:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.3); }

.land-id {
  position: absolute;
  top: 3px;
  left: 4px;
  font-size: 10px;
  color: var(--sub);
  font-variant-numeric: tabular-nums;
}

.land-img {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 10px;
}
.land-img img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.land-plant-name {
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 2px;
  color: var(--text);
}

.land-time {
  font-size: 10px;
  text-align: center;
  color: var(--sub);
}

.land-type {
  font-size: 10px;
  color: var(--sub);
  opacity: 0.7;
}

.land-badges {
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: auto;
}
.land-badge {
  border-radius: 3px;
  padding: 0 3px;
  font-size: 10px;
  font-weight: 600;
}
.land-badge.water  { background: rgba(74,177,255,0.15); color: #4ab1ff; }
.land-badge.weed   { background: rgba(86,212,160,0.15); color: var(--primary); }
.land-badge.bug    { background: rgba(240,111,104,0.15); color: var(--danger); }
.land-badge.harvest { background: rgba(242,188,84,0.15); color: var(--warn); }

/* 状态叠加 */
.land-locked { opacity: 0.5; }
.land-dead { filter: grayscale(0.8); }
.land-harvestable { box-shadow: 0 0 0 2px var(--warn) !important; }
.land-stealable { box-shadow: 0 0 0 2px #bca9ff !important; }
</style>
