<script setup lang="ts">
defineProps<{
  label?: string
}>()
const model = defineModel<boolean>()
</script>

<template>
  <label class="base-switch">
    <input v-model="model" type="checkbox" class="switch-input">
    <span class="slider" />
    <span v-if="label" class="switch-label">{{ label }}</span>
  </label>
</template>

<style scoped>
.base-switch {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}

.switch-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  display: block;
  position: relative;
  width: 40px;
  height: 22px;
  background: var(--line);
  border-radius: 999px;
  flex-shrink: 0;
  transition: background 0.2s;
}
.slider::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 999px;
  transition: transform 0.2s;
}
.switch-input:checked + .slider { background: var(--primary); }
.switch-input:checked + .slider::after { transform: translateX(18px); }

.switch-label {
  font-size: calc(14px * var(--font-scale));
  color: var(--text);
}
</style>
