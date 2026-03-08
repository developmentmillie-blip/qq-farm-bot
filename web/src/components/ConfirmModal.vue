<script setup lang="ts">
import BaseButton from '@/components/ui/BaseButton.vue'

defineProps<{
  show: boolean
  title?: string
  message?: string
  confirmText?: string
  cancelText?: string
  type?: 'danger' | 'primary'
  isAlert?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'close'): void
}>()
</script>

<template>
  <div v-if="show" class="modal-overlay" @click="emit('cancel'); emit('close')">
    <div class="modal-box" style="max-width: 400px;" @click.stop>
      <div class="modal-title">
        <i v-if="type === 'danger'" class="fa-solid fa-triangle-exclamation" style="color: var(--danger);" />
        <i v-else class="fa-solid fa-circle-info" style="color: var(--primary);" />
        {{ title || '确认操作' }}
      </div>
      <p style="color: var(--sub); margin: 0 0 20px; line-height: 1.6;">
        {{ message || '确定要执行此操作吗？' }}
      </p>
      <div class="modal-footer">
        <BaseButton
          v-if="!isAlert"
          variant="secondary"
          :disabled="loading"
          @click="emit('cancel')"
        >
          {{ cancelText || '取消' }}
        </BaseButton>
        <BaseButton
          :variant="type === 'danger' ? 'danger' : 'primary'"
          :loading="loading"
          @click="emit('confirm')"
        >
          {{ confirmText || '确定' }}
        </BaseButton>
      </div>
    </div>
  </div>
</template>
