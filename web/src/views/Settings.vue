<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'

const settingStore = useSettingStore()
const accountStore = useAccountStore()
const farmStore = useFarmStore()

const { settings, loading } = storeToRefs(settingStore)
const { currentAccountId, accounts } = storeToRefs(accountStore)
const { seeds } = storeToRefs(farmStore)

const saving = ref(false)
const passwordSaving = ref(false)
const offlineSaving = ref(false)
const theftKingSaving = ref(false)

const theftKingCfg = ref({ enabled: false, minPlantLevel: 10 })
const theftKingStatus = ref<any>(null)

const modalVisible = ref(false)
const modalConfig = ref({
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  isAlert: true,
})

function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = { title: type === 'danger' ? '错误' : '提示', message, type, isAlert: true }
  modalVisible.value = true
}

const currentAccountName = computed(() => {
  const acc = accounts.value.find((a: any) => a.id === currentAccountId.value)
  return acc ? (acc.name || acc.nick || acc.id) : null
})

const localSettings = ref({
  plantingStrategy: 'preferred',
  preferredSeedId: 0,
  intervals: { farmMin: 2, farmMax: 2, friendMin: 10, friendMax: 10 },
  friendQuietHours: { enabled: false, start: '23:00', end: '07:00' },
  automation: {
    farm: false, task: false, sell: false, friend: false,
    farm_push: false, land_upgrade: false, friend_steal: false,
    friend_help: false, friend_bad: false, friend_help_exp_limit: false,
    email: false, fertilizer_gift: false, fertilizer_buy: false,
    free_gifts: false, share_reward: false, vip_gift: false,
    month_card: false, open_server_gift: false, fertilizer: 'none',
  },
})

const localOffline = ref({
  channel: 'webhook',
  reloginUrlMode: 'none',
  endpoint: '',
  token: '',
  title: '',
  msg: '',
  offlineDeleteSec: 120,
})

const passwordForm = ref({ old: '', new: '', confirm: '' })

function syncLocalSettings() {
  if (settings.value) {
    localSettings.value = JSON.parse(JSON.stringify({
      plantingStrategy: settings.value.plantingStrategy,
      preferredSeedId: settings.value.preferredSeedId,
      intervals: settings.value.intervals,
      friendQuietHours: settings.value.friendQuietHours,
      automation: settings.value.automation,
    }))
    const defaults = {
      farm: false, task: false, sell: false, friend: false,
      farm_push: false, land_upgrade: false, friend_steal: false,
      friend_help: false, friend_bad: false, friend_help_exp_limit: false,
      email: false, fertilizer_gift: false, fertilizer_buy: false,
      free_gifts: false, share_reward: false, vip_gift: false,
      month_card: false, open_server_gift: false, fertilizer: 'none',
    }
    if (!localSettings.value.automation) {
      localSettings.value.automation = defaults
    }
    else {
      localSettings.value.automation = { ...defaults, ...localSettings.value.automation }
    }
    if (settings.value.offlineReminder) {
      localOffline.value = JSON.parse(JSON.stringify(settings.value.offlineReminder))
    }
  }
}

async function loadData() {
  if (currentAccountId.value) {
    await settingStore.fetchSettings(currentAccountId.value)
    syncLocalSettings()
    await farmStore.fetchSeeds(currentAccountId.value)
    // 加载天王配置
    try {
      const res = await api.get('/api/theft-king', { headers: { 'x-account-id': currentAccountId.value } })
      if (res.data.ok) theftKingCfg.value = { enabled: false, minPlantLevel: 10, ...res.data.data }
    } catch { /* ignore */ }
  }
}

async function loadTheftKingStatus() {
  if (!currentAccountId.value) return
  try {
    const res = await api.get('/api/theft-king/status', { headers: { 'x-account-id': currentAccountId.value } })
    if (res.data.ok) theftKingStatus.value = res.data.data
  } catch { /* ignore */ }
}

async function saveTheftKingCfg() {
  if (!currentAccountId.value) return
  theftKingSaving.value = true
  try {
    const res = await api.post('/api/theft-king', theftKingCfg.value, { headers: { 'x-account-id': currentAccountId.value } })
    if (res.data.ok) {
      theftKingCfg.value = res.data.data
      showAlert('天王模式配置已保存')
      if (theftKingCfg.value.enabled) loadTheftKingStatus()
    } else {
      showAlert(`保存失败: ${res.data.error}`, 'danger')
    }
  } catch (e: any) {
    showAlert(`保存失败: ${e.message}`, 'danger')
  } finally {
    theftKingSaving.value = false
  }
}

onMounted(() => { loadData() })
watch(currentAccountId, () => { loadData() })

const fertilizerOptions = [
  { label: '普通 + 有机', value: 'both' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '仅有机化肥', value: 'organic' },
  { label: '不施肥', value: 'none' },
]

const plantingStrategyOptions = [
  { label: '优先种植种子', value: 'preferred' },
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
]

const channelOptions = [
  { label: 'Webhook(自定义接口)', value: 'webhook' },
  { label: 'Qmsg 酱', value: 'qmsg' },
  { label: 'Server 酱', value: 'serverchan' },
  { label: 'Push Plus', value: 'pushplus' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip' },
  { label: '钉钉', value: 'dingtalk' },
  { label: '企业微信', value: 'wecom' },
  { label: 'Bark', value: 'bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp' },
  { label: 'OneBot', value: 'onebot' },
  { label: 'Atri', value: 'atri' },
  { label: 'PushDeer', value: 'pushdeer' },
  { label: 'iGot', value: 'igot' },
  { label: 'Telegram', value: 'telegram' },
  { label: '飞书', value: 'feishu' },
  { label: 'IFTTT', value: 'ifttt' },
  { label: '企业微信群机器人', value: 'wecombot' },
  { label: 'Discord', value: 'discord' },
  { label: 'WxPusher', value: 'wxpusher' },
]

const CHANNEL_DOCS: Record<string, string> = {
  qmsg: 'https://qmsg.zendee.cn/',
  serverchan: 'https://sct.ftqq.com/',
  pushplus: 'https://www.pushplus.plus/',
  pushplushxtrip: 'https://pushplus.hxtrip.com/',
  dingtalk: 'https://open.dingtalk.com/document/group/custom-robot-access',
  wecom: 'https://guole.fun/posts/626/',
  wecombot: 'https://developer.work.weixin.qq.com/document/path/91770',
  bark: 'https://github.com/Finb/Bark',
  gocqhttp: 'https://docs.go-cqhttp.org/api/',
  onebot: 'https://docs.go-cqhttp.org/api/',
  atri: 'https://blog.tianli0.top/',
  pushdeer: 'https://www.pushdeer.com/',
  igot: 'https://push.hellyw.com/',
  telegram: 'https://core.telegram.org/bots',
  feishu: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973',
  ifttt: 'https://ifttt.com/maker_webhooks',
  discord: 'https://discord.com/developers/docs/resources/webhook#execute-webhook',
  wxpusher: 'https://wxpusher.zjiecode.com/docs/#/',
}

// 各渠道字段说明
const CHANNEL_FIELD_INFO: Record<string, {
  endpointLabel?: string
  endpointPlaceholder?: string
  endpointDisabled?: boolean
  tokenLabel?: string
  tokenPlaceholder?: string
  tokenHint?: string
}> = {
  webhook:         { endpointLabel: '接口地址', endpointPlaceholder: 'https://your-webhook-url', endpointDisabled: false, tokenPlaceholder: '可选' },
  qmsg:            { endpointDisabled: true, tokenLabel: 'QQ号', tokenPlaceholder: '接收推送的QQ号', tokenHint: 'Qmsg酱 KEY 填入 Token，接收QQ号填入 Token 字段（格式：KEY|QQ）' },
  serverchan:      { endpointDisabled: true, tokenLabel: 'SendKey', tokenPlaceholder: 'SCT...' },
  pushplus:        { endpointDisabled: true, tokenLabel: 'Token', tokenPlaceholder: 'pushplus token' },
  pushplushxtrip:  { endpointDisabled: true, tokenLabel: 'Token', tokenPlaceholder: 'pushplus hxtrip token' },
  dingtalk:        { endpointLabel: 'Webhook 地址', endpointPlaceholder: 'https://oapi.dingtalk.com/robot/send?access_token=...', endpointDisabled: false, tokenLabel: '加签密钥', tokenPlaceholder: 'SEC...(可选)' },
  wecom:           { endpointDisabled: true, tokenLabel: 'Key', tokenPlaceholder: '企业微信机器人 Key' },
  wecombot:        { endpointLabel: 'Webhook 地址', endpointPlaceholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...', endpointDisabled: false },
  bark:            { endpointLabel: 'Bark 服务地址', endpointPlaceholder: 'https://api.day.app', endpointDisabled: false, tokenLabel: 'Device Key', tokenPlaceholder: 'Bark 设备 Key' },
  gocqhttp:        { endpointLabel: 'API 地址', endpointPlaceholder: 'http://127.0.0.1:5700', endpointDisabled: false, tokenLabel: 'QQ号', tokenPlaceholder: '接收消息的QQ号' },
  onebot:          { endpointLabel: 'API 地址', endpointPlaceholder: 'http://127.0.0.1:5700', endpointDisabled: false, tokenLabel: 'QQ号', tokenPlaceholder: '接收消息的QQ号' },
  atri:            { endpointLabel: 'API 地址', endpointPlaceholder: 'http://127.0.0.1:8080', endpointDisabled: false, tokenLabel: 'QQ号', tokenPlaceholder: '接收消息的QQ号' },
  pushdeer:        { endpointDisabled: true, tokenLabel: 'PushKey', tokenPlaceholder: 'PDU...' },
  igot:            { endpointDisabled: true, tokenLabel: 'Key', tokenPlaceholder: 'iGot Key' },
  telegram:        { endpointDisabled: true, tokenLabel: 'Bot Token | Chat ID', tokenPlaceholder: 'bot_token|chat_id' },
  feishu:          { endpointLabel: 'Webhook 地址', endpointPlaceholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...', endpointDisabled: false },
  ifttt:           { endpointDisabled: true, tokenLabel: 'Key', tokenPlaceholder: 'IFTTT Webhook Key' },
  discord:         { endpointLabel: 'Webhook 地址', endpointPlaceholder: 'https://discord.com/api/webhooks/...', endpointDisabled: false },
  wxpusher:        { endpointDisabled: true, tokenLabel: 'App Token | UID', tokenPlaceholder: 'AT_xxx|UID_xxx' },
}

const reloginUrlModeOptions = [
  { label: '不需要', value: 'none' },
  { label: '链接', value: 'qq_link' },
  { label: '二维码', value: 'qr_code' },
  { label: '二维码+链接', value: 'all' },
]

const currentChannelDocUrl = computed(() => {
  const key = String(localOffline.value.channel || '').trim().toLowerCase()
  return CHANNEL_DOCS[key] || ''
})

const currentChannelFieldInfo = computed(() => {
  const key = String(localOffline.value.channel || '').trim().toLowerCase()
  return CHANNEL_FIELD_INFO[key] || {}
})

function openChannelDocs() {
  const url = currentChannelDocUrl.value
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

const preferredSeedOptions = computed(() => {
  const options: any[] = [{ label: '自动选择', value: 0 }]
  if (seeds.value) {
    options.push(...seeds.value.map((seed: any) => ({
      label: seed.fromBag
        ? `${seed.name} (背包:${seed.bagCount ?? '?'}个)`
        : `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
      value: seed.seedId,
      disabled: seed.locked || seed.soldOut,
    })))
  }
  return options
})

const analyticsSortByMap: Record<string, string> = {
  max_exp: 'exp', max_fert_exp: 'fert', max_profit: 'profit', max_fert_profit: 'fert_profit',
}

const strategyPreviewLabel = ref<string | null>(null)

watchEffect(async () => {
  const strategy = localSettings.value.plantingStrategy
  if (strategy === 'preferred') { strategyPreviewLabel.value = null; return }
  if (!seeds.value || seeds.value.length === 0) { strategyPreviewLabel.value = null; return }
  const available = (seeds.value as any[]).filter((s: any) => !s.locked && !s.soldOut)
  if (available.length === 0) { strategyPreviewLabel.value = '暂无可用种子'; return }
  if (strategy === 'level') {
    const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel)[0]
    strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
    return
  }
  const sortBy = analyticsSortByMap[strategy]
  if (sortBy) {
    try {
      const res = await api.get(`/api/analytics?sort=${sortBy}`)
      const rankings: any[] = res.data.ok ? (res.data.data || []) : []
      const availableIds = new Set(available.map((s: any) => s.seedId))
      const match = rankings.find((r: any) => availableIds.has(Number(r.seedId)))
      if (match) {
        const seed = available.find((s: any) => s.seedId === Number(match.seedId))
        strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : null
      }
      else {
        strategyPreviewLabel.value = '暂无匹配种子'
      }
    }
    catch { strategyPreviewLabel.value = null }
  }
})

async function saveAccountSettings() {
  if (!currentAccountId.value) return
  saving.value = true
  try {
    const res = await settingStore.saveSettings(currentAccountId.value, localSettings.value)
    if (res.ok) showAlert('账号设置已保存')
    else showAlert(`保存失败: ${res.error}`, 'danger')
  }
  finally { saving.value = false }
}

async function handleChangePassword() {
  if (!passwordForm.value.old || !passwordForm.value.new) { showAlert('请填写完整', 'danger'); return }
  if (passwordForm.value.new !== passwordForm.value.confirm) { showAlert('两次密码输入不一致', 'danger'); return }
  if (passwordForm.value.new.length < 4) { showAlert('密码长度至少4位', 'danger'); return }
  passwordSaving.value = true
  try {
    const res = await settingStore.changeAdminPassword(passwordForm.value.old, passwordForm.value.new)
    if (res.ok) { showAlert('密码修改成功'); passwordForm.value = { old: '', new: '', confirm: '' } }
    else showAlert(`修改失败: ${res.error || '未知错误'}`, 'danger')
  }
  finally { passwordSaving.value = false }
}

async function handleSaveOffline() {
  offlineSaving.value = true
  try {
    const res = await settingStore.saveOfflineConfig(localOffline.value)
    if (res.ok) showAlert('下线提醒设置已保存')
    else showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
  }
  finally { offlineSaving.value = false }
}
</script>

<template>
  <div class="settings-page">
    <!-- 加载中 -->
    <div v-if="loading" class="empty-state" style="padding: 40px;">
      <div class="loading-spin" />
    </div>

    <div v-else class="settings-grid">
      <!-- ====== 左列：策略设置 + 自动控制 ====== -->
      <div v-if="currentAccountId" class="card settings-col">
        <!-- 策略设置 -->
        <div class="settings-section-title">
          <i class="fa-solid fa-sliders" />
          策略设置
          <span v-if="currentAccountName" class="section-subtitle">({{ currentAccountName }})</span>
        </div>

        <div class="form-group">
          <label>种植策略</label>
          <select v-model="localSettings.plantingStrategy" class="form-control">
            <option v-for="opt in plantingStrategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>

        <div v-if="localSettings.plantingStrategy === 'preferred'" class="form-group">
          <label>优先种植种子</label>
          <select v-model="localSettings.preferredSeedId" class="form-control">
            <option v-for="opt in preferredSeedOptions" :key="opt.value" :value="opt.value" :disabled="opt.disabled">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div v-else class="form-group">
          <label>策略选种预览</label>
          <div class="form-control" style="cursor:default; color: var(--text);">
            {{ strategyPreviewLabel ?? '加载中...' }}
          </div>
        </div>

        <div class="interval-grid">
          <div class="form-group">
            <label>农场巡查最小(秒)</label>
            <input v-model.number="localSettings.intervals.farmMin" type="number" min="1" max="86400" class="form-control">
          </div>
          <div class="form-group">
            <label>农场巡查最大(秒)</label>
            <input v-model.number="localSettings.intervals.farmMax" type="number" min="1" max="86400" class="form-control">
          </div>
          <div class="form-group">
            <label>好友巡查最小(秒)</label>
            <input v-model.number="localSettings.intervals.friendMin" type="number" min="1" max="86400" class="form-control">
          </div>
          <div class="form-group">
            <label>好友巡查最大(秒)</label>
            <input v-model.number="localSettings.intervals.friendMax" type="number" min="1" max="86400" class="form-control">
          </div>
        </div>

        <div class="quiet-hours-row">
          <div class="switch-item">
            <span>启用静默时段</span>
            <label class="switch-wrap">
              <input v-model="localSettings.friendQuietHours.enabled" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div v-if="localSettings.friendQuietHours.enabled" class="quiet-time-inputs">
            <input v-model="localSettings.friendQuietHours.start" type="time" class="form-control time-input">
            <span style="color:var(--sub);">—</span>
            <input v-model="localSettings.friendQuietHours.end" type="time" class="form-control time-input">
          </div>
        </div>

        <!-- 自动控制 -->
        <div class="settings-section-title" style="margin-top: 16px;">
          <i class="fa-solid fa-toggle-on" />
          自动控制
        </div>

        <div class="switches-list">
          <div class="switch-item">
            <span>自动种植收获</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.farm" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动做任务</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.task" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动卖果实</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.sell" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动好友互动</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.friend" type="checkbox">
              <span class="slider" />
            </label>
          </div>

          <!-- 好友子选项 -->
          <div v-if="localSettings.automation.friend" class="sub-switches">
            <div class="switch-item">
              <span>自动偷菜</span>
              <label class="switch-wrap">
                <input v-model="localSettings.automation.friend_steal" type="checkbox">
                <span class="slider" />
              </label>
            </div>
            <div class="switch-item">
              <span>自动帮忙</span>
              <label class="switch-wrap">
                <input v-model="localSettings.automation.friend_help" type="checkbox">
                <span class="slider" />
              </label>
            </div>
            <div class="switch-item">
              <span>自动捣乱</span>
              <label class="switch-wrap">
                <input v-model="localSettings.automation.friend_bad" type="checkbox">
                <span class="slider" />
              </label>
            </div>
            <div class="switch-item">
              <span>经验上限停止帮忙</span>
              <label class="switch-wrap">
                <input v-model="localSettings.automation.friend_help_exp_limit" type="checkbox">
                <span class="slider" />
              </label>
            </div>
          </div>

          <div class="switch-item">
            <span>推送触发巡田</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.farm_push" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动升级土地</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.land_upgrade" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动领取邮件</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.email" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动商城礼包</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.free_gifts" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动分享奖励</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.share_reward" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动VIP礼包</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.vip_gift" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动月卡奖励</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.month_card" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动开服红包</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.open_server_gift" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动填充化肥</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.fertilizer_gift" type="checkbox">
              <span class="slider" />
            </label>
          </div>
          <div class="switch-item">
            <span>自动购买化肥</span>
            <label class="switch-wrap">
              <input v-model="localSettings.automation.fertilizer_buy" type="checkbox">
              <span class="slider" />
            </label>
          </div>
        </div>

        <div class="form-group" style="margin-top: 12px;">
          <label>施肥策略</label>
          <select v-model="localSettings.automation.fertilizer" class="form-control">
            <option v-for="opt in fertilizerOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>

        <div class="card-save-row">
          <button class="btn btn-primary" :disabled="saving" @click="saveAccountSettings">
            <i v-if="saving" class="fa-solid fa-spinner fa-spin" />
            <i v-else class="fa-solid fa-floppy-disk" />
            保存策略与自动控制
          </button>
        </div>

        <!-- 天王模式 -->
        <div class="settings-section-title" style="margin-top: 16px;">
          <i class="fa-solid fa-crown" />
          超级偷菜（天王模式）
        </div>
        <div class="switch-item">
          <span>启用超级偷菜</span>
          <label class="switch-wrap">
            <input v-model="theftKingCfg.enabled" type="checkbox">
            <span class="slider" />
          </label>
        </div>
        <div v-if="theftKingCfg.enabled" class="form-group" style="margin-top: 8px;">
          <label>高级作物等级阈值（land_level ≥ 此值列入重点）</label>
          <input v-model.number="theftKingCfg.minPlantLevel" type="number" min="1" max="999" class="form-control">
        </div>
        <div class="card-save-row">
          <button class="btn btn-primary" :disabled="theftKingSaving" @click="saveTheftKingCfg">
            <i v-if="theftKingSaving" class="fa-solid fa-spinner fa-spin" />
            <i v-else class="fa-solid fa-floppy-disk" />
            保存天王配置
          </button>
        </div>
        <div v-if="theftKingCfg.enabled && theftKingStatus" class="theft-king-status">
          <span>重点: {{ theftKingStatus.focusCount }} 人</span>
          <span>蹲点: {{ theftKingStatus.campCount }} 人</span>
          <button class="btn btn-sm" style="margin-left: 8px;" @click="loadTheftKingStatus">刷新</button>
        </div>
      </div>

      <!-- 未选账号提示 -->
      <div v-else class="card empty-state">
        <i class="fa-solid fa-gear" style="font-size:40px; color:var(--sub); margin-bottom:16px;" />
        <div style="font-weight:700; margin-bottom:6px;">需要登录账号</div>
        <div style="color:var(--sub); font-size:calc(13px * var(--font-scale));">请先在侧边栏选择账号以配置策略</div>
      </div>

      <!-- ====== 右列：密码 + 下线提醒 ====== -->
      <div class="card settings-col">
        <!-- 密码 -->
        <div class="settings-section-title">
          <i class="fa-solid fa-lock" />
          管理密码
        </div>

        <div class="form-group">
          <label>当前密码</label>
          <input v-model="passwordForm.old" type="password" class="form-control" placeholder="当前管理密码">
        </div>
        <div class="form-group">
          <label>新密码</label>
          <input v-model="passwordForm.new" type="password" class="form-control" placeholder="至少 4 位">
        </div>
        <div class="form-group">
          <label>确认新密码</label>
          <input v-model="passwordForm.confirm" type="password" class="form-control" placeholder="再次输入新密码">
        </div>
        <div class="form-hint">建议修改默认密码 (admin)</div>
        <div class="card-save-row">
          <button class="btn btn-primary" :disabled="passwordSaving" @click="handleChangePassword">
            <i v-if="passwordSaving" class="fa-solid fa-spinner fa-spin" />
            <i v-else class="fa-solid fa-key" />
            修改管理密码
          </button>
        </div>

        <!-- 下线提醒 -->
        <div class="settings-section-title" style="margin-top: 20px;">
          <i class="fa-solid fa-bell" />
          下线提醒
        </div>

        <div class="form-group">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <label style="margin:0;">推送渠道</label>
            <button
              v-if="currentChannelDocUrl"
              class="btn btn-ghost btn-sm"
              @click="openChannelDocs"
            >
              <i class="fa-solid fa-arrow-up-right-from-square" /> 官网
            </button>
          </div>
          <select v-model="localOffline.channel" class="form-control">
            <option v-for="opt in channelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>

        <div class="form-group">
          <label>重登录链接</label>
          <select v-model="localOffline.reloginUrlMode" class="form-control">
            <option v-for="opt in reloginUrlModeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>

        <div class="form-group">
          <label>{{ currentChannelFieldInfo.endpointLabel || '接口地址' }}</label>
          <input
            v-model="localOffline.endpoint"
            type="text"
            class="form-control"
            :placeholder="currentChannelFieldInfo.endpointPlaceholder || ''"
            :disabled="currentChannelFieldInfo.endpointDisabled === true"
          >
        </div>

        <div class="form-group">
          <label>{{ currentChannelFieldInfo.tokenLabel || 'Token' }}</label>
          <input v-model="localOffline.token" type="text" class="form-control" :placeholder="currentChannelFieldInfo.tokenPlaceholder || '接收端 token'">
          <div v-if="currentChannelFieldInfo.tokenHint" class="form-hint" style="margin-top:4px;">{{ currentChannelFieldInfo.tokenHint }}</div>
        </div>

        <div class="interval-grid">
          <div class="form-group">
            <label>标题</label>
            <input v-model="localOffline.title" type="text" class="form-control" placeholder="提醒标题">
          </div>
          <div class="form-group">
            <label>离线删除账号(秒)</label>
            <input v-model.number="localOffline.offlineDeleteSec" type="number" min="1" class="form-control" placeholder="默认 120">
          </div>
        </div>

        <div class="form-group">
          <label>内容</label>
          <input v-model="localOffline.msg" type="text" class="form-control" placeholder="提醒内容">
        </div>

        <div class="card-save-row">
          <button class="btn btn-primary" :disabled="offlineSaving" @click="handleSaveOffline">
            <i v-if="offlineSaving" class="fa-solid fa-spinner fa-spin" />
            <i v-else class="fa-solid fa-floppy-disk" />
            保存下线提醒设置
          </button>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="modalVisible"
      :title="modalConfig.title"
      :message="modalConfig.message"
      :type="modalConfig.type"
      :is-alert="modalConfig.isAlert"
      confirm-text="知道了"
      @confirm="modalVisible = false"
      @cancel="modalVisible = false"
    />
  </div>
</template>

<style scoped>
.settings-page {
  padding: 14px;
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}

.settings-col {
  margin-bottom: 0;
}

.section-subtitle {
  font-size: calc(13px * var(--font-scale));
  color: var(--sub);
  font-weight: 400;
  margin-left: 6px;
}

.interval-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.quiet-hours-row {
  margin-bottom: 12px;
}
.quiet-time-inputs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.time-input {
  width: 120px;
}

.sub-switches {
  background: rgba(74,177,255,0.06);
  border: 1px solid rgba(74,177,255,0.2);
  border-radius: 8px;
  padding: 8px 12px;
  margin: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-hint {
  font-size: calc(12px * var(--font-scale));
  color: var(--sub);
  margin-bottom: 10px;
}

.card-save-row {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  margin-top: 12px;
}

@media (max-width: 980px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .interval-grid {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 480px) {
  .interval-grid {
    grid-template-columns: 1fr;
  }
}

.theft-king-status {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding: 8px 10px;
  background: var(--bg2, rgba(255,255,255,.05));
  border-radius: 6px;
  font-size: calc(13px * var(--font-scale));
  color: var(--sub);
}
</style>

