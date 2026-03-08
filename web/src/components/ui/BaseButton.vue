<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps<{
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'outline' | 'text' | 'stop'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  disabled?: boolean
  block?: boolean
  to?: string
  href?: string
  type?: 'button' | 'submit' | 'reset'
}>()

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void
}>()

const componentTag = computed(() => {
  if (props.to)
    return RouterLink
  if (props.href)
    return 'a'
  return 'button'
})
</script>

<template>
  <component
    :is="componentTag"
    :to="to"
    :href="href"
    :type="!to && !href ? (type || 'button') : undefined"
    :disabled="disabled || loading"
    class="base-btn"
    :class="[
      `variant-${variant || 'primary'}`,
      `size-${size || 'md'}`,
      { 'w-full': block },
    ]"
    v-bind="$attrs"
    @click="!disabled && !loading && emit('click', $event)"
  >
    <i v-if="loading" class="fa-solid fa-spinner fa-spin" style="margin-right:6px;" />
    <slot />
  </component>
</template>

<style scoped>
.base-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  font-weight: 600;
  font-family: inherit;
  text-decoration: none;
  transition: opacity 0.15s, background 0.15s, border-color 0.15s;
  white-space: nowrap;
  outline: none;
}
.base-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.base-btn:not(:disabled):hover { opacity: 0.88; }
.base-btn:not(:disabled):active { opacity: 0.72; }

/* Variants */
.variant-primary  { background: var(--btn-primary-bg); color: #fff; }
.variant-stop     { background: var(--btn-stop-bg); color: #fff; }
.variant-danger   { background: var(--btn-danger-bg); color: #fff; }
.variant-success  { background: var(--primary); color: #fff; }
.variant-secondary {
  background: var(--panel-2);
  border-color: var(--line);
  color: var(--text);
}
.variant-ghost {
  background: transparent;
  border-color: var(--line);
  color: var(--sub);
}
.variant-ghost:not(:disabled):hover {
  color: var(--text);
  border-color: var(--primary);
  background: var(--panel-2);
  opacity: 1;
}
.variant-outline {
  background: transparent;
  border-color: var(--line);
  color: var(--text);
}
.variant-text {
  background: transparent;
  border-color: transparent;
  color: var(--accent);
  padding: 0 !important;
}
.variant-text:not(:disabled):hover { opacity: 0.75; text-decoration: underline; }

/* Sizes */
.size-sm { padding: 4px 10px; font-size: calc(12px * var(--font-scale)); }
.size-md { padding: 7px 14px; font-size: calc(14px * var(--font-scale)); }
.size-lg { padding: 10px 20px; font-size: calc(16px * var(--font-scale)); }
</style>
