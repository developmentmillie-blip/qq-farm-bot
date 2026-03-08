<script setup lang="ts">
import { ref, watch } from 'vue'
import api from '@/api'

const props = defineProps<{
  show: boolean
  account?: any
}>()

const emit = defineEmits(['close', 'saved'])

const name = ref('')
const loading = ref(false)
const errorMessage = ref('')

watch(() => props.show, (val) => {
  errorMessage.value = ''
  if (val && props.account) {
    name.value = props.account.name || ''
  }
})

async function save() {
  if (!props.account)
    return
  loading.value = true
  errorMessage.value = ''
  try {
    const payload = {
      ...props.account,
      name: name.value,
    }
    delete payload.nick

    const res = await api.post('/api/accounts', payload)
    if (res.data.ok) {
      emit('saved')
      emit('close')
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div v-if="show" class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-box" style="width: 380px;" @click.stop>
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
        <div class="modal-title" style="margin:0;">
          <i class="fa-solid fa-pen" style="color: var(--accent);" />
          修改备注
        </div>
        <button class="btn btn-ghost btn-sm" style="width:30px;height:30px;padding:0;" @click="$emit('close')">
          <i class="fa-solid fa-xmark" />
        </button>
      </div>

      <div class="remark-body">
        <div v-if="errorMessage" class="remark-error">
          {{ errorMessage }}
        </div>
        <div class="form-group">
          <label class="form-label">备注名称</label>
          <input
            v-model="name"
            class="form-input"
            placeholder="请输入备注名称"
            @keyup.enter="save"
          >
        </div>
        <div class="remark-footer">
          <button class="btn btn-ghost" @click="$emit('close')">
            取消
          </button>
          <button class="btn btn-primary" :disabled="loading" @click="save">
            <i v-if="loading" class="fa-solid fa-spinner fa-spin" />
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remark-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.remark-error {
  background: rgba(240,111,104,0.1);
  border: 1px solid rgba(240,111,104,0.3);
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 0.85rem;
  color: #f06f68;
}

.remark-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 4px;
}
</style>
