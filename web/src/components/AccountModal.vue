<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const activeTab = ref('qr') // qr, manual
const loading = ref(false)
const qrData = ref<{ image?: string, code: string, qrcode?: string, url?: string } | null>(null)
const qrStatus = ref('')
const errorMessage = ref('')

const form = reactive({
  name: '',
  code: '',
  platform: 'qq',
})

const { pause: stopQRCheck, resume: startQRCheck } = useIntervalFn(async () => {
  if (!qrData.value)
    return
  try {
    const res = await api.post('/api/qr/check', { code: qrData.value.code })
    if (res.data.ok) {
      const status = res.data.data.status
      if (status === 'OK') {
        // Login success
        stopQRCheck()
        qrStatus.value = '登录成功!'
        // Auto fill form and submit
        const { uin, code: authCode, nickname } = res.data.data

        // Use name from form if provided, otherwise default
        let accName = form.name.trim()
        if (!accName) {
          // 优先使用 nickname，其次使用 uin
          accName = nickname || (uin ? String(uin) : '扫码账号')
        }

        // We need to add account with this data
        try {
          await addAccount({
            id: props.editData?.id,
            uin,
            code: authCode,
            loginType: 'qr',
            name: props.editData ? (props.editData.name || accName) : accName,
            platform: 'qq',
          })
        }
        catch {
          qrStatus.value = '账号保存失败，请重试'
        }
      }
      else if (status === 'Used') {
        qrStatus.value = '二维码已失效' // Consistent text
        stopQRCheck()
      }
      else if (status === 'Wait') {
        qrStatus.value = '等待扫码...'
      }
      else {
        qrStatus.value = `错误: ${res.data.data.error}`
      }
    }
  }
  catch (e) {
    console.error(e)
  }
}, 1000, { immediate: false })

// QR Code Logic
async function loadQRCode() {
  if (activeTab.value !== 'qr')
    return
  loading.value = true
  qrStatus.value = '正在获取二维码'
  errorMessage.value = ''
  try {
    const res = await api.post('/api/qr/create')
    if (res.data.ok) {
      qrData.value = res.data.data
      qrStatus.value = '请使用手机QQ扫码'
      startQRCheck()
    }
    else {
      qrStatus.value = `获取失败: ${res.data.error}`
    }
  }
  catch (e) {
    qrStatus.value = '获取失败'
    console.error(e)
  }
  finally {
    loading.value = false
  }
}

const isMobile = computed(() => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent))

function openQRCodeLoginUrl() {
  if (!qrData.value?.url)
    return

  const url = qrData.value.url
  if (!isMobile.value) {
    window.open(url, '_blank')
    return
  }

  // Mobile Deep Link logic
  try {
    const b64 = btoa(unescape(encodeURIComponent(url)))
    const qqDeepLink = `mqqapi://forward/url?url_prefix=${encodeURIComponent(b64)}&version=1&src_type=web`
    window.location.href = qqDeepLink
  }
  catch (e) {
    console.error('Deep link error:', e)
    window.location.href = url
  }
}

async function addAccount(data: any) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
      if (activeTab.value === 'qr')
        qrStatus.value = '账号保存失败，请重试'
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
    if (activeTab.value === 'qr')
      qrStatus.value = '账号保存失败，请重试'
  }
  finally {
    loading.value = false
  }
}

async function submitManual() {
  errorMessage.value = ''
  if (!form.code) {
    errorMessage.value = '请输入Code 或 先扫码'
    return
  }

  if (!form.name && props.editData) {
    errorMessage.value = '请输入名称'
    return
  }

  let code = form.code.trim()
  // Try to extract code from URL if present
  const match = code.match(/[?&]code=([^&]+)/i)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code // Update UI
  }

  const payload = {
    id: props.editData?.id, // If editing
    name: form.name,
    code,
    platform: form.platform,
    loginType: 'manual',
  }

  await addAccount(payload)
}

function close() {
  stopQRCheck()
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    if (props.editData) {
      // Edit mode: Default to QR refresh, load code
      activeTab.value = 'qr'
      form.name = props.editData.name
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
      loadQRCode()
    }
    else {
      // Add mode: Default to QR
      activeTab.value = 'qr'
      form.name = ''
      form.code = ''
      form.platform = 'qq'
      loadQRCode()
    }
  }
  else {
    // Reset when closed
    stopQRCheck()
    qrData.value = null
    qrStatus.value = ''
  }
})
</script>

<template>
  <div v-if="show" class="modal-overlay">
    <div class="modal-box" style="width: 420px;" @click.stop>
      <!-- 标题栏 -->
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
        <div class="modal-title" style="margin:0;">
          <i class="fa-solid fa-user-plus" style="color: var(--primary);" />
          {{ editData ? '编辑账号' : '添加账号' }}
        </div>
        <button class="btn btn-ghost btn-sm" style="width:30px;height:30px;padding:0;" @click="close">
          <i class="fa-solid fa-xmark" />
        </button>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="error-banner">
        <i class="fa-solid fa-circle-exclamation" />
        {{ errorMessage }}
      </div>

      <!-- Tabs -->
      <div class="tab-bar" style="margin-bottom: 16px;">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'qr' }"
          @click="activeTab = 'qr'; loadQRCode()"
        >
          <i class="fa-solid fa-qrcode" />
          {{ editData ? '扫码更新' : '扫码登录' }}
        </button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'manual' }"
          @click="activeTab = 'manual'; stopQRCheck()"
        >
          <i class="fa-solid fa-keyboard" />
          手动填码
        </button>
      </div>

      <!-- 扫码 Tab -->
      <div v-if="activeTab === 'qr'" class="qr-section">
        <p style="text-align:center; color:var(--sub); margin-bottom:12px; font-size:calc(13px * var(--font-scale));">
          扫码默认使用QQ昵称
        </p>

        <div class="qr-img-wrap">
          <template v-if="qrData && (qrData.image || qrData.qrcode)">
            <img :src="qrData.image ? (qrData.image.startsWith('data:') ? qrData.image : `data:image/png;base64,${qrData.image}`) : qrData.qrcode" class="qr-img">
          </template>
          <div v-else class="qr-placeholder">
            <div v-if="loading" class="loading-spin" />
            <span v-else>二维码区域</span>
          </div>
        </div>

        <p style="text-align:center; color:var(--sub); margin:10px 0; font-size:calc(13px * var(--font-scale));">{{ qrStatus }}</p>

        <div style="display:flex; justify-content:center; gap:10px;">
          <button class="btn btn-ghost btn-sm" @click="loadQRCode">
            <i class="fa-solid fa-rotate" /> 刷新二维码
          </button>
          <button v-if="qrData?.url" class="btn btn-ghost btn-sm" @click="openQRCodeLoginUrl">
            <i class="fa-solid fa-arrow-up-right-from-square" /> 跳转QQ登录
          </button>
        </div>
      </div>

      <!-- 手动填码 Tab -->
      <div v-if="activeTab === 'manual'" class="manual-section">
        <div class="form-group">
          <label>备注名称</label>
          <input v-model="form.name" type="text" class="form-control" placeholder="留空默认账号X">
        </div>

        <div class="form-group">
          <label>Code</label>
          <textarea v-model="form.code" class="form-control" placeholder="请输入登录 Code" rows="3" style="resize:vertical;" />
        </div>

        <div class="form-group">
          <label>平台</label>
          <select v-model="form.platform" class="form-control">
            <option value="qq">QQ小程序</option>
            <option value="wx">微信小程序</option>
          </select>
        </div>

        <div class="modal-footer">
          <button class="btn btn-ghost" @click="close">取消</button>
          <BaseButton variant="primary" :loading="loading" @click="submitManual">
            {{ editData ? '保存' : '添加' }}
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.error-banner {
  background: rgba(240,111,104,0.1);
  border: 1px solid rgba(240,111,104,0.3);
  border-radius: 8px;
  padding: 10px 12px;
  color: var(--danger);
  font-size: calc(13px * var(--font-scale));
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.qr-section {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.qr-img-wrap {
  display: flex;
  justify-content: center;
}

.qr-img {
  width: 192px;
  height: 192px;
  border: 2px solid var(--line);
  border-radius: 8px;
  background: #fff;
  padding: 4px;
}

.qr-placeholder {
  width: 192px;
  height: 192px;
  border: 2px dashed var(--line);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sub);
  font-size: calc(13px * var(--font-scale));
}

.manual-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
