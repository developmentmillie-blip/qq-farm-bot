<script setup lang="ts">
defineProps<{
  placeholder?: string
  label?: string
  disabled?: boolean
  rows?: number
}>()
const model = defineModel<string>()
</script>

<template>
  <div class="base-textarea-wrap">
    <label v-if="label" class="base-textarea-label">{{ label }}</label>
    <textarea
      v-model="model"
      :rows="rows || 3"
      :placeholder="placeholder"
      :disabled="disabled"
      class="base-textarea"
    />
  </div>
</template>

<style scoped>
.base-textarea-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.base-textarea-label {
  font-size: calc(13px * var(--font-scale));
  color: var(--sub);
  font-weight: 500;
}
.base-textarea {
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
  resize: vertical;
}
.base-textarea:focus { border-color: var(--primary); }
.base-textarea::placeholder { color: var(--sub); opacity: 0.6; }
.base-textarea:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
