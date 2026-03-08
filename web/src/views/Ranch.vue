<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const ranchStore = useRanchStore()
const statusStore = useStatusStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { config, state, loadingConfig, loadingState } = storeToRefs(ranchStore)
const { status } = storeToRefs(statusStore)

const activeTab = ref('encyclopedia')
const tabs = [
  { key: 'encyclopedia', label: '图鉴', icon: 'fa-solid fa-book-open' },
  { key: 'mylivestock',  label: '我的牲畜', icon: 'fa-solid fa-paw' },
  { key: 'shop',        label: '商店', icon: 'fa-solid fa-store' },
  { key: 'education',   label: '答题', icon: 'fa-solid fa-graduation-cap' },
  { key: 'warehouse',   label: '仓库', icon: 'fa-solid fa-warehouse' },
  { key: 'mailbox',     label: '邮件', icon: 'fa-solid fa-envelope' },
]

// ---- 仓库/邮件（需要独立 fetch）
const warehouseData = ref<any>(null)
const mailboxData = ref<any>(null)
const warehouseLoading = ref(false)
const mailboxLoading = ref(false)

async function loadTab(tab: string) {
  activeTab.value = tab
  if (tab === 'warehouse') await loadWarehouse()
  if (tab === 'mailbox') await loadMailbox()
}

async function loadWarehouse() {
  warehouseLoading.value = true
  try {
    const res = await ranchStore.getWarehouse()
    if (res?.ok) warehouseData.value = res
  } finally {
    warehouseLoading.value = false
  }
}

async function loadMailbox() {
  mailboxLoading.value = true
  try {
    const res = await ranchStore.getMailbox()
    if (res?.ok) mailboxData.value = res
  } finally {
    mailboxLoading.value = false
  }
}

// ---- 答题弹窗
const quizVisible = ref(false)
const quizBreedName = ref('')
const quizBreedId = ref('')
const quizQuestions = ref<any[]>([])
const quizAnswers = ref<number[]>([])
const quizResults = ref<any[] | null>(null)

async function openQuiz(breedId: string) {
  const res = await ranchStore.getQuiz(breedId)
  if (!res?.ok) return
  quizBreedId.value = breedId
  quizBreedName.value = res.breedName
  quizQuestions.value = res.questions
  quizAnswers.value = new Array(res.questions.length).fill(-1)
  quizResults.value = null
  quizVisible.value = true
}

async function submitQuiz() {
  if (quizAnswers.value.some(a => a === -1)) {
    alert('请先完成所有题目')
    return
  }
  const res = await ranchStore.submitQuiz(quizBreedId.value, quizAnswers.value)
  if (res?.ok) {
    quizResults.value = res.results || null
    setTimeout(() => { quizVisible.value = false }, 2000)
  }
}

// ---- 品种详情弹窗
const detailVisible = ref(false)
const detailBreed = ref<any>(null)
const detailEntry = ref<any>(null)

function showBreedDetail(breedId: string) {
  const breed = config.value?.breeds?.find((b: any) => b.id === breedId)
  if (!breed) return
  detailBreed.value = breed
  detailEntry.value = state.value?.encyclopedia?.[breedId] || {}
  detailVisible.value = true
}

// ---- 赠书弹窗
const giftVisible = ref(false)
const giftBreedId = ref('')
const giftBreedName = ref('')
const giftAccounts = ref<any[]>([])
const giftSelectedId = ref('')
const giftSearch = ref('')
const giftLoading = ref(false)

const giftFilteredAccounts = computed(() => {
  const q = giftSearch.value.toLowerCase()
  if (!q) return giftAccounts.value
  return giftAccounts.value.filter((a: any) =>
    a.name.toLowerCase().includes(q) || String(a.uin || '').includes(q)
  )
})

async function openGiftBook(breedId: string) {
  const breed = config.value?.breeds?.find((b: any) => b.id === breedId)
  giftBreedId.value = breedId
  giftBreedName.value = breed?.name || breedId
  giftSelectedId.value = ''
  giftSearch.value = ''
  giftVisible.value = true
  giftLoading.value = true
  try {
    const res = await ranchStore.getAllAccounts()
    giftAccounts.value = (res?.accounts || []).filter((a: any) => String(a.id) !== String(currentAccountId.value))
  } finally {
    giftLoading.value = false
  }
}

async function confirmGiftBook() {
  if (!giftSelectedId.value) return
  const fromAccount = accountStore.accounts.find((a: any) => String(a.id) === String(currentAccountId.value))
  const fromName = fromAccount?.name || String(currentAccountId.value)
  await ranchStore.giftBook(giftBreedId.value, giftSelectedId.value, fromName)
  giftVisible.value = false
}

// ---- 商店购买数量
const shopQty = ref<Record<string, number>>({})

function getQty(itemId: string) {
  return shopQty.value[itemId] || 1
}

async function doBuy(itemId: string) {
  const qty = getQty(itemId)
  await ranchStore.buyItem(itemId, qty)
}

// ---- 工具函数
function fmtSec(sec: number): string {
  if (sec <= 0) return '0s'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h${m > 0 ? m + 'm' : ''}`
  if (m > 0) return `${m}m${s > 0 ? s + 's' : ''}`
  return `${s}s`
}

function stars(n: number, max = 5): string {
  return '★'.repeat(Math.max(0, Math.min(n, max))) + '☆'.repeat(Math.max(0, max - n))
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// @ts-ignore
function mailboxUnread(mails: any[]): number {
  return (mails || []).filter((m: any) => !m.claimed).length
}

// ---- 加载
async function refresh() {
  if (!currentAccountId.value)
    return
  if (!currentAccount.value?.running || !status.value?.connection?.connected)
    return
  ranchStore.resetState()
  await ranchStore.loadAll()
  if (activeTab.value === 'warehouse') loadWarehouse()
  if (activeTab.value === 'mailbox') loadMailbox()
}

onMounted(() => { refresh() })
watch(currentAccountId, () => { refresh() })
</script>

<template>
  <div class="ranch-page">
    <!-- 头部 -->
    <div class="card ranch-header">
      <div class="ranch-brand">
        <i class="fa-solid fa-horse" style="color: var(--primary); font-size:1.4rem;" />
        <span class="ranch-title">牧场</span>
        <span v-if="state" class="ranch-gold">
          <i class="fa-solid fa-coins" style="color:#f2bc54;" />
          {{ (state.gold || 0).toLocaleString() }} 金币
        </span>
      </div>

      <!-- Tab Bar -->
      <div class="tab-bar ranch-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab-btn"
          :class="{ active: activeTab === tab.key }"
          @click="loadTab(tab.key)"
        >
          <i :class="tab.icon" />
          {{ tab.label }}
          <span
            v-if="tab.key === 'mailbox' && state?.mailUnread > 0"
            class="mail-badge"
          >{{ state.mailUnread > 9 ? '9+' : state.mailUnread }}</span>
        </button>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loadingConfig || loadingState" class="ranch-loading-wrap">
      <i class="fa-solid fa-spinner fa-spin" style="font-size:2rem; color:var(--accent);" />
      <span>加载中...</span>
    </div>

    <!-- 未选账号 -->
    <div v-else-if="!currentAccountId" class="ranch-empty-wrap">
      <i class="fa-solid fa-user-slash" style="font-size:2rem; opacity:.4;" />
      <span>请先选择账号</span>
    </div>

    <!-- 未连接 -->
    <div v-else-if="!currentAccount?.running || !status?.connection?.connected" class="ranch-empty-wrap">
      <i class="fa-solid fa-circle-xmark" style="font-size:2rem; color:#f06f68;" />
      <span>账号未登录，请先运行账号</span>
    </div>

    <!-- 配置加载失败 -->
    <div v-else-if="!config" class="ranch-empty-wrap">
      <i class="fa-solid fa-circle-exclamation" style="font-size:2rem; color:#f06f68;" />
      <span>品种配置加载失败，请检查服务器是否已重启</span>
    </div>

    <!-- 内容区 -->
    <template v-else>

      <!-- ===== 图鉴 ===== -->
      <div v-if="activeTab === 'encyclopedia'" class="ranch-content">
        <div v-for="cat in config.categories" :key="cat.id" class="ranch-cat-block">
          <div class="ranch-cat-title">
            <span>{{ cat.icon }}</span>
            <span>{{ cat.name }}</span>
          </div>
          <div class="ranch-breed-grid">
            <div
              v-for="breed in (config.breeds || []).filter((b:any) => b.categoryId === cat.id).sort((a:any,b:any) => a.unlockOrder - b.unlockOrder)"
              :key="breed.id"
              class="breed-card"
              :class="state?.encyclopedia?.[breed.id]?.unlocked ? 'unlocked' : 'locked'"
            >
              <!-- 图片区 -->
              <div class="breed-img-wrap">
                <template v-if="state?.encyclopedia?.[breed.id]?.unlocked">
                  <img :src="breed.image" :alt="breed.name" loading="lazy" referrerpolicy="no-referrer" @error="($event.target as HTMLElement).style.display='none'">
                </template>
                <template v-else>
                  <div class="breed-lock-icon">
                    🔒
                    <div class="breed-lock-hint">
                      <template v-if="!breed.unlockRequires">点击解锁</template>
                      <template v-else-if="breed.unlockRequires.type === 'prevConserved'">
                        需「{{ (config.breeds || []).find((b:any) => b.id === breed.unlockRequires.breedId)?.name }}」保种✓
                      </template>
                      <template v-else-if="breed.unlockRequires.type === 'anyConserved'">
                        需任意{{ breed.unlockRequires.exactDiff || breed.unlockRequires.maxDiff || 2 }}★品种保种✓
                      </template>
                    </div>
                  </div>
                </template>
                <!-- 角标 -->
                <div class="breed-badges-wrap">
                  <span v-if="state?.encyclopedia?.[breed.id]?.breedSuccess" class="breed-badge badge-success">保种✓</span>
                  <span v-if="state?.encyclopedia?.[breed.id]?.bookOwned" class="breed-badge badge-book">📖</span>
                  <span v-if="state?.encyclopedia?.[breed.id]?.diseased" class="breed-badge badge-disease">病</span>
                  <span v-if="state?.encyclopedia?.[breed.id]?.needFeed && state?.encyclopedia?.[breed.id]?.unlocked" class="breed-badge badge-hungry" @click.stop="ranchStore.feedBreed(breed.id)">饿</span>
                </div>
              </div>
              <!-- 信息区 -->
              <div class="breed-body">
                <div class="breed-name">{{ breed.name }}</div>
                <div class="breed-diff">{{ stars(breed.breedDifficulty || 1) }}</div>
                <div class="breed-origin">📍{{ breed.origin }}</div>
                <div v-if="state?.encyclopedia?.[breed.id]?.unlocked" class="breed-progress-wrap">
                  <div class="breed-prog-bar">
                    <div class="breed-prog-fill" :style="`width:${Math.min(100, ((state.encyclopedia[breed.id]?.breedCount||0)/(breed.breedTarget||4))*100)}%`" />
                  </div>
                  <span class="breed-prog-text">{{ state.encyclopedia[breed.id]?.breedCount||0 }}/{{ breed.breedTarget||4 }}</span>
                </div>
                <div class="breed-actions">
                  <button v-if="!state?.encyclopedia?.[breed.id]?.unlocked" class="btn btn-primary btn-xs" @click="ranchStore.unlockBreed(breed.id)">解锁</button>
                  <button v-if="state?.encyclopedia?.[breed.id]?.unlocked && !state?.encyclopedia?.[breed.id]?.breedSuccess" class="btn btn-primary btn-xs" @click="ranchStore.tryBreed(breed.id)">繁殖</button>
                  <button v-if="state?.encyclopedia?.[breed.id]?.unlocked" class="btn btn-xs" @click="showBreedDetail(breed.id)">详情</button>
                  <button v-if="state?.encyclopedia?.[breed.id]?.unlocked" class="btn btn-xs" @click="openQuiz(breed.id)">答题</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 我的牲畜 ===== -->
      <div v-else-if="activeTab === 'mylivestock'" class="ranch-content">
        <template v-if="(config.breeds||[]).filter((b:any) => state?.encyclopedia?.[b.id]?.unlocked).length === 0">
          <div class="ranch-empty-wrap">还未解锁任何品种，前往「图鉴」解锁第一个品种吧！</div>
        </template>
        <template v-else>
          <div
            v-for="breed in (config.breeds||[]).filter((b:any) => state?.encyclopedia?.[b.id]?.unlocked)"
            :key="breed.id"
            class="livestock-card"
            :class="{ diseased: state?.disease?.[breed.id] && !state?.disease?.[breed.id]?.curedAt }"
          >
            <div class="livestock-head">
              <img :src="breed.image" :alt="breed.name" loading="lazy" referrerpolicy="no-referrer" class="livestock-avatar" @error="($event.target as HTMLElement).style.display='none'">
              <div class="livestock-info">
                <div class="livestock-name">
                  {{ (config.categories||[]).find((c:any) => c.id === breed.categoryId)?.icon || '' }}
                  {{ breed.name }}
                  <span v-if="state?.encyclopedia?.[breed.id]?.needFeed" class="breed-badge badge-hungry">饿</span>
                  <span v-if="state?.disease?.[breed.id] && !state?.disease?.[breed.id]?.curedAt" class="breed-badge badge-disease">病</span>
                </div>
                <div class="livestock-origin">📍{{ breed.origin }}</div>
                <div v-if="state?.disease?.[breed.id] && !state?.disease?.[breed.id]?.curedAt" class="livestock-disease">
                  ⚠️ 患病：{{ state.disease[breed.id].disease }}
                </div>
              </div>
            </div>
            <div class="livestock-stats">
              <div class="stat-row">
                <span class="stat-label">公 🐾 健康</span>
                <div class="health-bar"><div class="health-fill" :style="`width:${state?.encyclopedia?.[breed.id]?.male?.health||0}%`" /></div>
                <span class="stat-val">{{ state?.encyclopedia?.[breed.id]?.male?.health||0 }}%</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">母 🐾 健康</span>
                <div class="health-bar"><div class="health-fill female" :style="`width:${state?.encyclopedia?.[breed.id]?.female?.health||0}%`" /></div>
                <span class="stat-val">{{ state?.encyclopedia?.[breed.id]?.female?.health||0 }}%</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">繁殖进度</span>
                <div class="breed-prog-bar">
                  <div class="breed-prog-fill" :style="`width:${Math.min(100,((state?.encyclopedia?.[breed.id]?.breedCount||0)/(breed.breedTarget||4))*100)}%`" />
                </div>
                <span class="stat-val">{{ state?.encyclopedia?.[breed.id]?.breedCount||0 }}/{{ breed.breedTarget||4 }}</span>
              </div>
              <div v-if="(state?.encyclopedia?.[breed.id]?.growthBonus||0) > 0" class="stat-bonus">
                🚀 繁育加成 +{{ state.encyclopedia[breed.id].growthBonus }}%
              </div>
              <div v-if="state?.encyclopedia?.[breed.id]?.bookOwned" class="stat-bonus">
                📖 持有保种书籍（可赠出）
              </div>
            </div>
            <div class="livestock-actions">
              <!-- 喂食 -->
              <button class="btn btn-xs" @click="ranchStore.feedBreed(breed.id)">
                🌾 喂食
              </button>
              <!-- 治疗按钮 -->
              <template v-if="state?.disease?.[breed.id] && !state?.disease?.[breed.id]?.curedAt">
                <button
                  v-for="med in (config.medicines||[]).filter((m:any) => m.targetCategories?.includes(breed.categoryId))"
                  :key="med.id"
                  class="btn btn-xs btn-stop"
                  @click="ranchStore.treatBreed(breed.id, med.id)"
                >
                  {{ med.icon }} {{ med.name }}（库存{{ state?.inventory?.[med.id]||0 }}）
                </button>
              </template>
              <!-- 繁殖 -->
              <button
                v-if="!state?.encyclopedia?.[breed.id]?.breedSuccess"
                class="btn btn-xs btn-primary"
                :disabled="(state?.encyclopedia?.[breed.id]?.breedCdRemainSec||0) > 0"
                @click="ranchStore.tryBreed(breed.id)"
              >
                🐣 繁殖{{ (state?.encyclopedia?.[breed.id]?.breedCdRemainSec||0) > 0 ? `（冷却 ${fmtSec(state.encyclopedia[breed.id].breedCdRemainSec)}）` : '' }}
              </button>
              <span v-else class="breed-done-tag">✅ 保种完成</span>
              <!-- 答题 -->
              <button class="btn btn-xs" @click="openQuiz(breed.id)">📝 答题</button>
              <!-- 赠书 -->
              <button v-if="state?.encyclopedia?.[breed.id]?.bookOwned" class="btn btn-xs" @click="openGiftBook(breed.id)">🎁 赠书</button>
            </div>
          </div>
        </template>
      </div>

      <!-- ===== 商店 ===== -->
      <div v-else-if="activeTab === 'shop'" class="ranch-content">
        <div class="shop-gold-bar">
          <i class="fa-solid fa-coins" style="color:#f2bc54;" />
          当前牧场金币：<strong>{{ (state?.gold||0).toLocaleString() }}</strong>
        </div>
        <div class="shop-section-title">饲料</div>
        <div class="shop-grid">
          <div v-for="feed in (config.feeds||[])" :key="feed.id" class="shop-item">
            <div class="shop-item-icon">{{ feed.icon }}</div>
            <div class="shop-item-name">{{ feed.name }}</div>
            <div class="shop-item-desc">{{ feed.desc }}</div>
            <div class="shop-item-footer">
              <span class="shop-item-price"><i class="fa-solid fa-coins" style="color:#f2bc54;" /> {{ feed.price }}</span>
              <span class="shop-item-owned">库存 {{ state?.inventory?.[feed.id]||0 }}</span>
            </div>
            <div class="shop-item-buy">
              <input v-model.number="shopQty[feed.id]" type="number" class="form-input shop-qty" min="1" max="99" :placeholder="'1'">
              <button class="btn btn-primary btn-xs" @click="doBuy(feed.id)">购买</button>
            </div>
          </div>
        </div>
        <div class="shop-section-title" style="margin-top:20px;">兽药</div>
        <div class="shop-grid">
          <div v-for="med in (config.medicines||[])" :key="med.id" class="shop-item">
            <div class="shop-item-icon">{{ med.icon }}</div>
            <div class="shop-item-name">{{ med.name }}</div>
            <div class="shop-item-desc">{{ med.desc }}</div>
            <div class="shop-item-footer">
              <span class="shop-item-price"><i class="fa-solid fa-coins" style="color:#f2bc54;" /> {{ med.price }}</span>
              <span class="shop-item-owned">库存 {{ state?.inventory?.[med.id]||0 }}</span>
            </div>
            <div class="shop-item-buy">
              <input v-model.number="shopQty[med.id]" type="number" class="form-input shop-qty" min="1" max="99" :placeholder="'1'">
              <button class="btn btn-primary btn-xs" @click="doBuy(med.id)">购买</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 答题教育 ===== -->
      <div v-else-if="activeTab === 'education'" class="ranch-content">
        <div class="edu-list">
          <div
            v-for="breed in (config.breeds||[]).filter((b:any) => b.quiz && b.quiz.length > 0)"
            :key="breed.id"
            class="edu-item"
            :class="{ 'edu-locked': !state?.encyclopedia?.[breed.id]?.unlocked }"
          >
            <div class="edu-img">
              <template v-if="state?.encyclopedia?.[breed.id]?.unlocked">
                <img :src="breed.image" :alt="breed.name" loading="lazy" referrerpolicy="no-referrer" @error="($event.target as HTMLElement).style.display='none'">
              </template>
              <template v-else>
                <span class="edu-lock-icon">🔒</span>
              </template>
            </div>
            <div class="edu-info">
              <div class="edu-name">{{ state?.encyclopedia?.[breed.id]?.unlocked ? breed.name : '未解锁品种' }}</div>
              <div v-if="state?.encyclopedia?.[breed.id]?.unlocked" class="edu-meta">
                📍{{ breed.origin }} · {{ breed.quiz?.length }} 道题
              </div>
              <div v-if="state?.encyclopedia?.[breed.id]?.unlocked" class="edu-status">
                <span v-if="state?.encyclopedia?.[breed.id]?.quizPassed" class="edu-passed">✅ 已通关</span>
                <span v-else class="edu-notpass">待挑战</span>
                <span v-if="(state?.encyclopedia?.[breed.id]?.growthBonus||0) > 0" class="edu-bonus">
                  🚀 加成 +{{ state.encyclopedia[breed.id].growthBonus }}%
                </span>
              </div>
            </div>
            <div class="edu-action">
              <button
                v-if="state?.encyclopedia?.[breed.id]?.unlocked"
                class="btn btn-primary btn-xs"
                @click="openQuiz(breed.id)"
              >开始答题</button>
              <button v-else class="btn btn-xs" disabled>未解锁</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 仓库 ===== -->
      <div v-else-if="activeTab === 'warehouse'" class="ranch-content">
        <div v-if="warehouseLoading" class="ranch-loading-wrap">
          <i class="fa-solid fa-spinner fa-spin" />
        </div>
        <template v-else-if="warehouseData">
          <div class="warehouse-section-title">
            <i class="fa-solid fa-bag-shopping" /> 自购物品
          </div>
          <div v-if="!warehouseData.own?.length" class="ranch-empty-text">暂无物品，前往商店购买</div>
          <div v-else class="warehouse-grid">
            <div v-for="item in warehouseData.own" :key="item.itemId" class="warehouse-item">
              <div class="warehouse-item-icon">{{ item.icon }}</div>
              <div class="warehouse-item-name">{{ item.name }}</div>
              <div class="warehouse-item-count">x{{ item.count }}</div>
            </div>
          </div>
          <div class="warehouse-section-title" style="margin-top:20px;">
            <i class="fa-solid fa-book" /> 收到的保种书籍
          </div>
          <div v-if="!warehouseData.received?.length" class="ranch-empty-text">暂无收到的书籍</div>
          <div v-else class="warehouse-book-list">
            <div v-for="(book, i) in warehouseData.received" :key="i" class="warehouse-book-item">
              <div class="warehouse-book-icon">📖</div>
              <div class="warehouse-book-info">
                <div class="warehouse-book-name">《{{ book.breedName }}保种经验》</div>
                <div class="warehouse-book-from">
                  来自：{{ book.fromName }} · {{ new Date(book.receivedAt).toLocaleDateString() }}
                </div>
              </div>
              <div class="warehouse-book-bonus">+25%</div>
            </div>
          </div>
        </template>
      </div>

      <!-- ===== 邮件箱 ===== -->
      <div v-else-if="activeTab === 'mailbox'" class="ranch-content">
        <div v-if="mailboxLoading" class="ranch-loading-wrap">
          <i class="fa-solid fa-spinner fa-spin" />
        </div>
        <template v-else-if="mailboxData">
          <div v-if="!mailboxData.mails?.length" class="ranch-empty-wrap">
            <i class="fa-solid fa-envelope-open" style="font-size:2rem; opacity:.4;" />
            <span>暂无邮件</span>
          </div>
          <div v-else class="mailbox-list">
            <div
              v-for="mail in [...(mailboxData.mails||[])].reverse()"
              :key="mail.id"
              class="mail-item"
              :class="mail.claimed ? 'mail-claimed' : 'mail-unclaimed'"
            >
              <div class="mail-icon">{{ mail.type === 'book' ? '📖' : '📬' }}</div>
              <div class="mail-info">
                <div class="mail-title">
                  {{ mail.type === 'book' ? `《${mail.breedName}保种经验》` : mail.type }}
                </div>
                <div class="mail-from">
                  来自：{{ mail.fromName }} · {{ new Date(mail.sentAt).toLocaleDateString() }}
                </div>
                <div v-if="mail.type === 'book'" class="mail-desc">领取后该品种繁育加成 +25%</div>
              </div>
              <div class="mail-action">
                <span v-if="mail.claimed" class="mail-claimed-tag">已领取</span>
                <button v-else class="btn btn-primary btn-xs" @click="ranchStore.claimMail(mail.id).then(() => loadMailbox())">
                  领取
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>

    </template>

    <!-- ===== 答题弹窗 ===== -->
    <div v-if="quizVisible" class="modal-overlay" @click.self="quizVisible = false">
      <div class="modal-box" style="width:520px; max-height:80vh; overflow-y:auto;" @click.stop>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <div class="modal-title" style="margin:0;">📝 {{ quizBreedName }} · 知识测验</div>
          <button class="btn btn-ghost btn-sm" style="width:30px;height:30px;padding:0;" @click="quizVisible = false">
            <i class="fa-solid fa-xmark" />
          </button>
        </div>
        <div class="quiz-tip">全部答对可获得该品种繁育速度 +50% 加成（每2分钟可答一次）</div>
        <div v-for="(q, qi) in quizQuestions" :key="qi" class="quiz-question" :class="quizResults ? (quizResults[qi]?.correct ? 'quiz-correct' : 'quiz-wrong') : ''">
          <div class="quiz-q-text">{{ qi + 1 }}. {{ q.q }}</div>
          <div class="quiz-options">
            <label v-for="(opt, oi) in q.options" :key="oi" class="quiz-option">
              <input v-model="quizAnswers[qi]" type="radio" :value="oi">
              <span>{{ opt }}</span>
            </label>
          </div>
        </div>
        <div class="quiz-footer" v-if="!quizResults">
          <button class="btn btn-primary" @click="submitQuiz">提交答案</button>
          <button class="btn btn-ghost" @click="quizVisible = false">取消</button>
        </div>
      </div>
    </div>

    <!-- ===== 品种详情弹窗 ===== -->
    <div v-if="detailVisible" class="modal-overlay" @click.self="detailVisible = false">
      <div class="modal-box" style="width:500px; max-height:80vh; overflow-y:auto;" @click.stop>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <div class="modal-title" style="margin:0;">{{ detailBreed?.name }}</div>
          <button class="btn btn-ghost btn-sm" style="width:30px;height:30px;padding:0;" @click="detailVisible = false">
            <i class="fa-solid fa-xmark" />
          </button>
        </div>
        <div class="breed-detail-wrap">
          <div class="breed-detail-top">
            <img :src="detailBreed?.image" loading="lazy" referrerpolicy="no-referrer" class="breed-detail-img" @error="($event.target as HTMLElement).style.display='none'">
            <div class="breed-detail-meta">
              <div class="breed-detail-name">{{ detailBreed?.name }}</div>
              <div class="breed-detail-diff">繁育难度：<span class="diff-val">{{ stars(detailBreed?.breedDifficulty||1) }}</span></div>
              <div class="breed-detail-origin">📍 产地：{{ detailBreed?.origin }}</div>
              <div class="breed-detail-traits">
                <span v-for="t in (detailBreed?.traits||[])" :key="t" class="trait-tag">{{ t }}</span>
              </div>
              <a v-if="detailBreed?.wikiUrl" :href="detailBreed.wikiUrl" target="_blank" class="wiki-link">📖 查看百科</a>
            </div>
          </div>
          <div class="breed-detail-desc">{{ detailBreed?.desc }}</div>
          <div class="breed-detail-game">
            <div class="detail-stat"><span>繁殖冷却</span><strong>{{ detailBreed?.breedDays }} 天</strong></div>
            <div class="detail-stat"><span>保种目标</span><strong>{{ detailBreed?.breedTarget }} 次</strong></div>
            <div class="detail-stat"><span>每日饲料</span><strong>{{ detailBreed?.feedPerDay }} 份</strong></div>
            <div class="detail-stat"><span>当前繁殖</span><strong>{{ detailEntry?.breedCount||0 }}/{{ detailBreed?.breedTarget||4 }}</strong></div>
            <div class="detail-stat"><span>答题加成</span><strong>+{{ detailEntry?.quizBonus||0 }}%</strong></div>
            <div class="detail-stat"><span>笔记加成</span><strong>+{{ detailEntry?.bookBonus||0 }}%</strong></div>
            <div class="detail-stat"><span>总繁育加成</span><strong>+{{ detailEntry?.growthBonus||0 }}%</strong></div>
          </div>
          <div v-if="detailEntry?.bookOwned" class="breed-strategy-block" style="display:flex;align-items:center;justify-content:space-between;">
            <div>
              <div class="strategy-title">📖 持有保种书籍</div>
              <div class="strategy-text">可赠送给其他账号，对方领取后繁育加成 +25%</div>
            </div>
            <button class="btn btn-primary btn-xs" style="white-space:nowrap;margin-left:12px;" @click="detailVisible=false; openGiftBook(detailBreed.id)">赠送书籍</button>
          </div>
          <div v-if="detailBreed?.breedStrategy" class="breed-strategy-block">
            <div class="strategy-title">🌱 繁育要点</div>
            <div class="strategy-text">{{ detailBreed.breedStrategy }}</div>
          </div>
          <div v-if="detailBreed?.conserveStrategy" class="breed-strategy-block">
            <div class="strategy-title">🛡️ 保种策略</div>
            <div class="strategy-text">{{ detailBreed.conserveStrategy }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 赠书弹窗 ===== -->
    <div v-if="giftVisible" class="modal-overlay" @click.self="giftVisible = false">
      <div class="modal-box" style="width:420px;" @click.stop>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <div class="modal-title" style="margin:0;">🎁 赠送保种书籍</div>
          <button class="btn btn-ghost btn-sm" style="width:30px;height:30px;padding:0;" @click="giftVisible = false">
            <i class="fa-solid fa-xmark" />
          </button>
        </div>
        <div class="giftbook-breed-tag">📖 《{{ giftBreedName }}保种经验》</div>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">搜索账号</label>
          <input v-model="giftSearch" class="form-input" placeholder="输入账号名称或QQ号">
        </div>
        <div v-if="giftLoading" class="ranch-loading-wrap" style="padding:24px;">
          <i class="fa-solid fa-spinner fa-spin" />
        </div>
        <div v-else class="giftbook-list">
          <div
            v-for="acc in giftFilteredAccounts"
            :key="acc.id"
            class="giftbook-item"
            :class="{ selected: giftSelectedId === acc.id }"
            @click="giftSelectedId = acc.id"
          >
            <div class="giftbook-acc-name">{{ acc.name }}</div>
            <div v-if="acc.uin" class="giftbook-acc-uin">QQ: {{ acc.uin }}</div>
          </div>
          <div v-if="giftFilteredAccounts.length === 0" class="ranch-empty-text">没有其他账号</div>
        </div>
        <div class="modal-footer" style="margin-top:16px;">
          <button class="btn btn-ghost" @click="giftVisible = false">取消</button>
          <button class="btn btn-primary" :disabled="!giftSelectedId" @click="confirmGiftBook">确认赠送</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ranch-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ranch-header {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ranch-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ranch-title {
  font-size: 1.3rem;
  font-weight: 700;
  font-family: var(--font-brand);
  color: var(--text);
}

.ranch-gold {
  margin-left: auto;
  font-size: 0.9rem;
  font-weight: 700;
  color: #f2bc54;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ranch-tabs {
  flex-wrap: wrap;
  gap: 6px;
}

.mail-badge {
  background: #f06f68;
  color: #fff;
  border-radius: 10px;
  font-size: 0.65rem;
  font-weight: 700;
  padding: 1px 5px;
  margin-left: 4px;
}

.ranch-loading-wrap,
.ranch-empty-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.9rem;
}

.ranch-empty-text {
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-muted);
  padding: 12px 0;
}

.ranch-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 图鉴 */
.ranch-cat-block { display: flex; flex-direction: column; gap: 12px; }
.ranch-cat-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 1rem;
  color: var(--text);
  padding: 10px 14px;
  background: var(--panel);
  border-radius: 8px;
  border-left: 3px solid var(--primary);
}

.ranch-breed-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.breed-card {
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.breed-card:hover { border-color: var(--accent); box-shadow: 0 2px 12px rgba(74,177,255,0.1); }
.breed-card.locked { opacity: 0.65; }

.breed-img-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  background: var(--panel-2);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.breed-img-wrap img { max-width: 80%; max-height: 80%; object-fit: contain; }

.breed-lock-icon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 1.8rem;
  color: var(--text-muted);
}

.breed-lock-hint {
  font-size: 0.65rem;
  text-align: center;
  color: var(--text-muted);
  line-height: 1.3;
}

.breed-badges-wrap {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.breed-badge {
  font-size: 0.62rem;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  line-height: 1.5;
}

.badge-success { background: rgba(24,160,111,0.2); color: #18a06f; }
.badge-book    { background: rgba(74,177,255,0.15); color: var(--accent); }
.badge-disease { background: rgba(240,111,104,0.2); color: #f06f68; cursor: pointer; }
.badge-hungry  { background: rgba(242,188,84,0.2); color: #f2bc54; cursor: pointer; }

.breed-body { padding: 8px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
.breed-name { font-weight: 700; font-size: 0.82rem; color: var(--text); }
.breed-diff { font-size: 0.72rem; color: #f2bc54; letter-spacing: 1px; }
.breed-origin { font-size: 0.7rem; color: var(--text-muted); }

.breed-progress-wrap { display: flex; align-items: center; gap: 6px; }
.breed-prog-bar { flex: 1; height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; }
.breed-prog-fill { height: 100%; background: var(--primary); border-radius: 3px; transition: width 0.3s; }
.breed-prog-text { font-size: 0.65rem; color: var(--text-muted); white-space: nowrap; }

.breed-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.btn-xs { padding: 3px 8px; font-size: 0.72rem; border-radius: 5px; }

/* 我的牲畜 */
.livestock-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.livestock-card.diseased { border-color: rgba(240,111,104,0.5); }

.livestock-head { display: flex; align-items: flex-start; gap: 14px; }
.livestock-avatar { width: 60px; height: 60px; object-fit: contain; border-radius: 8px; background: var(--panel-2); }
.livestock-name { font-weight: 700; font-size: 0.95rem; color: var(--text); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.livestock-origin { font-size: 0.78rem; color: var(--text-muted); margin-top: 3px; }
.livestock-disease { font-size: 0.78rem; color: #f06f68; margin-top: 3px; }

.livestock-stats { display: flex; flex-direction: column; gap: 8px; }
.stat-row { display: flex; align-items: center; gap: 8px; }
.stat-label { font-size: 0.78rem; color: var(--text-muted); width: 80px; flex-shrink: 0; }
.health-bar { flex: 1; height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
.health-fill { height: 100%; background: var(--primary); border-radius: 4px; }
.health-fill.female { background: #f472b6; }
.stat-val { font-size: 0.78rem; color: var(--text-sub); width: 36px; text-align: right; }
.stat-bonus { font-size: 0.78rem; color: var(--accent); }

.livestock-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.breed-done-tag { font-size: 0.78rem; color: var(--primary); font-weight: 700; padding: 4px 0; }

/* 商店 */
.shop-gold-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--panel);
  border-radius: 8px;
  font-size: 0.9rem;
  color: var(--text-sub);
}

.shop-section-title {
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--text-sub);
  margin-bottom: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}

.shop-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}

.shop-item {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.shop-item-icon { font-size: 1.8rem; text-align: center; }
.shop-item-name { font-weight: 700; font-size: 0.85rem; color: var(--text); text-align: center; }
.shop-item-desc { font-size: 0.72rem; color: var(--text-muted); text-align: center; min-height: 30px; }
.shop-item-footer { display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem; }
.shop-item-price { color: #f2bc54; font-weight: 700; display: flex; align-items: center; gap: 4px; }
.shop-item-owned { color: var(--text-muted); }
.shop-item-buy { display: flex; gap: 6px; align-items: center; }
.shop-qty { width: 52px; padding: 4px 6px; font-size: 0.8rem; text-align: center; }

/* 答题 */
.edu-list { display: flex; flex-direction: column; gap: 8px; }
.edu-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.edu-item.edu-locked { opacity: 0.55; }
.edu-img { width: 48px; height: 48px; flex-shrink: 0; border-radius: 6px; background: var(--panel-2); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.edu-img img { max-width: 100%; max-height: 100%; object-fit: contain; }
.edu-lock-icon { font-size: 1.4rem; }
.edu-info { flex: 1; }
.edu-name { font-weight: 700; font-size: 0.85rem; color: var(--text); }
.edu-meta { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
.edu-status { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.edu-passed { font-size: 0.75rem; color: var(--primary); }
.edu-notpass { font-size: 0.75rem; color: var(--text-muted); }
.edu-bonus { font-size: 0.75rem; color: var(--accent); }
.edu-action { flex-shrink: 0; }

/* 仓库 */
.warehouse-section-title {
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--text-sub);
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}

.warehouse-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 10px;
}

.warehouse-item {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}

.warehouse-item-icon { font-size: 1.6rem; }
.warehouse-item-name { font-size: 0.75rem; color: var(--text-sub); font-weight: 600; }
.warehouse-item-count { font-size: 0.78rem; color: var(--accent); font-weight: 700; }

.warehouse-book-list { display: flex; flex-direction: column; gap: 8px; }
.warehouse-book-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.warehouse-book-icon { font-size: 1.5rem; }
.warehouse-book-name { font-size: 0.85rem; font-weight: 700; color: var(--text); }
.warehouse-book-from { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
.warehouse-book-bonus { margin-left: auto; font-size: 0.85rem; font-weight: 700; color: var(--primary); }

/* 邮件箱 */
.mailbox-list { display: flex; flex-direction: column; gap: 8px; }
.mail-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.mail-item.mail-unclaimed { border-color: rgba(74,177,255,0.4); }
.mail-item.mail-claimed { opacity: 0.6; }
.mail-icon { font-size: 1.5rem; }
.mail-info { flex: 1; }
.mail-title { font-size: 0.85rem; font-weight: 700; color: var(--text); }
.mail-from { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
.mail-desc { font-size: 0.72rem; color: var(--accent); margin-top: 2px; }
.mail-action { flex-shrink: 0; }
.mail-claimed-tag { font-size: 0.75rem; color: var(--text-muted); }

/* 答题弹窗 */
.quiz-tip {
  font-size: 0.8rem;
  color: var(--text-muted);
  background: var(--panel-2);
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 14px;
}

.quiz-question {
  padding: 12px;
  border-radius: 8px;
  background: var(--panel-2);
  margin-bottom: 10px;
  border: 1px solid var(--border);
  transition: border-color 0.2s;
}

.quiz-question.quiz-correct { border-color: var(--primary); background: rgba(24,160,111,0.08); }
.quiz-question.quiz-wrong   { border-color: #f06f68; background: rgba(240,111,104,0.08); }

.quiz-q-text { font-size: 0.88rem; font-weight: 600; color: var(--text); margin-bottom: 10px; }
.quiz-options { display: flex; flex-direction: column; gap: 8px; }
.quiz-option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.83rem;
  color: var(--text-sub);
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 6px;
  transition: background 0.15s;
}
.quiz-option:hover { background: var(--border); }
.quiz-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }

/* 品种详情 */
.breed-detail-wrap { display: flex; flex-direction: column; gap: 14px; }
.breed-detail-top { display: flex; gap: 16px; align-items: flex-start; }
.breed-detail-img { width: 100px; height: 100px; object-fit: contain; border-radius: 8px; background: var(--panel-2); flex-shrink: 0; }
.breed-detail-meta { display: flex; flex-direction: column; gap: 5px; flex: 1; }
.breed-detail-name { font-weight: 700; font-size: 1.1rem; color: var(--text); }
.breed-detail-diff { font-size: 0.82rem; color: var(--text-muted); }
.diff-val { color: #f2bc54; }
.breed-detail-origin { font-size: 0.82rem; color: var(--text-muted); }
.breed-detail-traits { display: flex; flex-wrap: wrap; gap: 5px; }
.trait-tag { background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 0.72rem; color: var(--text-muted); }
.wiki-link { font-size: 0.8rem; color: var(--accent); }
.breed-detail-desc { font-size: 0.83rem; color: var(--text-muted); line-height: 1.6; }
.breed-detail-game { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
.detail-stat {
  background: var(--panel-2);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.detail-stat strong { color: var(--text); font-size: 0.88rem; }

.breed-strategy-block {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 10px 14px;
}
.strategy-title { font-weight: 700; font-size: 0.85rem; color: var(--text); margin-bottom: 5px; }
.strategy-text { font-size: 0.8rem; color: var(--text-muted); line-height: 1.6; }

/* 赠书 */
.giftbook-breed-tag {
  background: rgba(74,177,255,0.1);
  border: 1px solid rgba(74,177,255,0.3);
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 0.85rem;
  color: var(--accent);
  font-weight: 600;
}

.giftbook-list {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 2px;
}

.giftbook-item {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.giftbook-item:hover { border-color: var(--accent); }
.giftbook-item.selected { border-color: var(--primary); background: rgba(24,160,111,0.08); }
.giftbook-acc-name { font-size: 0.85rem; font-weight: 700; color: var(--text); }
.giftbook-acc-uin { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }

.modal-footer { display: flex; justify-content: flex-end; gap: 10px; }
</style>
