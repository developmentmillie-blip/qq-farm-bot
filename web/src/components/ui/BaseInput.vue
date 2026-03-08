<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  type?: string
  placeholder?: string
  label?: string
  disabled?: boolean
  clearable?: boolean
}>()
const emit = defineEmits<{
  (e: 'clear'): void
}>()
const model = defineModel<string | number>()
const showPassword = ref(false)
const inputType = computed(() => {
  if (props.type === 'password' && showPassword.value)
    return 'text'
  return props.type || 'text'
})
</script>

<template>
  <div class="base-input-wrap">
    <label v-if="label" class="base-input-label">{{ label }}</label>
    <div class="base-input-inner">
      <input
        v-model="model"
        :type="inputType"
        :placeholder="placeholder"
        :disabled="disabled"
        class="base-input"
        :class="{ 'has-icon': type === 'password' || (clearable && model) }"
      >
      <button
        v-if="type === 'password'"
        type="button"
        class="base-input-icon-btn"
        @click="showPassword = !showPassword"
      >
        <i :class="showPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'" />
      </button>
      <button
        v-else-if="clearable && model"
        type="button"
        class="base-input-icon-btn"
        @click="model = ''; emit('clear')"
      >
        <i class="fa-solid fa-xmark" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.base-input-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.base-input-label {
  font-size: calc(13px * var(--font-scale));
  color: var(--sub);
  font-weight: 500;
}
.base-input-inner {
  position: relative;
}
.base-input {
  width: 100%;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text);
  font-family: inherit;
  font-size: calc(14px * var(--font-scale));
  outline: none;
  transition: border-color 0.15s;
  min-height: 36px;
}
.base-input:focus { border-color: var(--primary); }
.base-input::placeholder { color: var(--sub); opacity: 0.6; }
.base-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.base-input.has-icon { padding-right: 36px; }

.base-input-icon-btn {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--sub);
  cursor: pointer;
  padding: 2px;
  font-size: 14px;
  transition: color 0.15s;
}
.base-input-icon-btn:hover { color: var(--text); }

/* 隐藏 IE 密码眼睛 */
.base-input::-ms-reveal,
.base-input::-ms-clear { display: none; }
</style>
