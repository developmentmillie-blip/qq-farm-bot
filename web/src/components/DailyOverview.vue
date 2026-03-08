<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  dailyGifts: any
}>()

const GIFT_ICONS: Record<string, string> = {
  task_claim:       'fa-solid fa-list-check',
  email_rewards:    'fa-solid fa-envelope',
  mall_free_gifts:  'fa-solid fa-bag-shopping',
  daily_share:      'fa-solid fa-share-nodes',
  vip_daily_gift:   'fa-solid fa-star',
  month_card_gift:  'fa-solid fa-calendar-days',
  open_server_gift: 'fa-solid fa-gift',
}

function getGiftIcon(key: string) {
  return GIFT_ICONS[key] || 'fa-solid fa-gift'
}

const hasDailyData = computed(() => !!props.dailyGifts)
const gifts = computed(() => props.dailyGifts?.gifts || [])

function formatTime(timestamp: number) {
  if (!timestamp)
    return '未领取'
  const d = new Date(timestamp)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function getGiftStatusText(gift: any) {
  if (!gift)
    return '未知'
  if (gift.key === 'vip_daily_gift' && gift.hasGift === false)
    return '未开通'
  if (gift.key === 'month_card_gift' && gift.hasCard === false)
    return '未开通'
  if (gift.doneToday)
    return '今日已完成'
  if (gift.enabled)
    return '等待执行'
  return '未开启'
}

function formatGiftSubText(gift: any) {
  if (!gift)
    return ''
  if (gift.key === 'vip_daily_gift' && gift.hasGift === false)
    return '未开通QQ会员或无每日礼包'
  if (gift.key === 'month_card_gift' && gift.hasCard === false)
    return '未购买月卡或已过期'
  const ts = Number(gift.lastAt || 0)
  if (!ts)
    return ''
  if (gift.doneToday)
    return `完成时间 ${formatTime(ts)}`
  if (gift.enabled)
    return `上次执行 ${formatTime(ts)}`
  return `上次检测 ${formatTime(ts)}`
}

function formatGiftProgress(gift: any) {
  if (!gift)
    return ''
  const total = Number(gift.totalCount || 0)
  const current = Number(gift.completedCount || 0)
  if (!total)
    return ''
  return `进度：${current}/${total}`
}
</script>

<template>
  <div class="daily-overview">
    <div class="card">
      <h3 class="daily-title">
        <i class="fa-solid fa-gift" style="color: #f472b6;" />
        每日礼包 &amp; 任务
      </h3>

      <div
        v-if="!hasDailyData"
        class="daily-empty"
      >
        请登录账号后查看
      </div>
      <div
        v-else-if="!gifts.length"
        class="daily-empty"
      >
        暂无每日礼包与任务数据
      </div>
      <div v-else class="daily-grid">
        <div
          v-for="gift in gifts"
          :key="gift.key"
          class="gift-item"
        >
          <div class="gift-top">
            <div
              class="gift-icon-wrap"
              :class="gift.doneToday ? 'icon-done' : (gift.enabled ? 'icon-active' : 'icon-idle')"
            >
              <i
                :class="[getGiftIcon(gift.key), gift.doneToday ? 'text-done' : (gift.enabled ? 'text-active' : 'text-idle')]"
              />
            </div>
            <span class="gift-label">{{ gift.label }}</span>
          </div>

          <div class="gift-bottom">
            <span
              class="gift-status"
              :class="gift.doneToday ? 'text-done' : (gift.enabled ? 'text-active' : 'text-idle')"
            >
              {{ getGiftStatusText(gift) }}
            </span>
            <div class="gift-meta">
              <span v-if="formatGiftProgress(gift)" class="gift-progress">
                {{ formatGiftProgress(gift) }}
              </span>
              <span v-if="formatGiftSubText(gift)" class="gift-sub">
                {{ formatGiftSubText(gift) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.daily-overview {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.daily-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 16px 0;
}

.daily-empty {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 24px;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-muted);
}

.daily-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}

.gift-item {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  gap: 10px;
  transition: border-color 0.15s;
}

.gift-item:hover {
  border-color: var(--accent);
}

.gift-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gift-icon-wrap {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  flex-shrink: 0;
}

.icon-done   { background: rgba(24,160,111,0.15); }
.icon-active { background: rgba(74,177,255,0.12); }
.icon-idle   { background: var(--border); }

.text-done   { color: #18a06f; }
.text-active { color: var(--accent); }
.text-idle   { color: var(--text-muted); }

.gift-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-sub);
  line-height: 1.3;
}

.gift-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}

.gift-status {
  font-size: 0.78rem;
  font-weight: 600;
}

.gift-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.gift-progress {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-weight: 700;
}

.gift-sub {
  font-size: 0.68rem;
  color: var(--text-muted);
  margin-top: 2px;
}
</style>
