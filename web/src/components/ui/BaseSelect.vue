<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{
  label?: string
  options?: { label: string, value: string | number, disabled?: boolean }[]
  disabled?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'change', value: string | number): void
}>()

const model = defineModel<string | number>()
const isOpen = ref(false)
const containerRef = ref<HTMLElement | null>(null)

const selectedLabel = computed(() => {
  const selected = props.options?.find(opt => opt.value === model.value)
  return selected ? selected.label : (props.placeholder || '请选择')
})

function toggleDropdown() {
  if (props.disabled) return
  isOpen.value = !isOpen.value
}

function selectOption(value: string | number) {
  model.value = value
  isOpen.value = false
  emit('change', value)
}

function closeDropdown(e: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(e.target as Node))
    isOpen.value = false
}

onMounted(() => document.addEventListener('click', closeDropdown))
onUnmounted(() => document.removeEventListener('click', closeDropdown))
</script>

<template>
  <div ref="containerRef" class="base-select-wrap">
    <label v-if="label" class="base-select-label">{{ label }}</label>
    <div class="base-select-trigger" :class="{ open: isOpen, disabled }" @click="toggleDropdown">
      <span class="base-select-value">{{ selectedLabel }}</span>
      <i class="fa-solid fa-chevron-down base-select-arrow" :class="{ rotated: isOpen }" />
    </div>

    <Transition name="dropdown">
      <div v-if="isOpen" class="base-select-dropdown">
        <template v-if="options?.length">
          <div
            v-for="opt in options"
            :key="opt.value"
            class="base-select-option"
            :class="{
              active: model === opt.value,
              disabled: opt.disabled,
            }"
            @click="!opt.disabled && selectOption(opt.value)"
          >
            <slot name="option" :option="opt" :selected="model === opt.value">
              {{ opt.label }}
            </slot>
          </div>
        </template>
        <div v-else class="base-select-empty">暂无选项</div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.base-select-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
}
.base-select-label {
  font-size: calc(13px * var(--font-scale));
  color: var(--sub);
  font-weight: 500;
}
.base-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 12px;
  cursor: pointer;
  min-height: 36px;
  transition: border-color 0.15s;
  user-select: none;
  color: var(--text);
  font-size: calc(14px * var(--font-scale));
}
.base-select-trigger.open { border-color: var(--primary); }
.base-select-trigger.disabled { opacity: 0.55; cursor: not-allowed; }
.base-select-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.base-select-arrow {
  color: var(--sub);
  font-size: 11px;
  transition: transform 0.2s;
  flex-shrink: 0;
  margin-left: 6px;
}
.base-select-arrow.rotated { transform: rotate(180deg); }

.base-select-dropdown {
  position: absolute;
  top: calc(100% + 3px);
  left: 0;
  right: 0;
  z-index: 500;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  max-height: 220px;
  overflow-y: auto;
  box-shadow: 0 6px 20px rgba(0,0,0,0.3);
}
.base-select-option {
  padding: 8px 12px;
  font-size: calc(14px * var(--font-scale));
  cursor: pointer;
  color: var(--text);
  transition: background 0.1s;
}
.base-select-option:hover:not(.disabled) { background: var(--panel); }
.base-select-option.active { color: var(--primary); background: rgba(24,160,111,0.08); }
.base-select-option.disabled { color: var(--sub); opacity: 0.5; cursor: not-allowed; }
.base-select-empty {
  padding: 10px 12px;
  text-align: center;
  color: var(--sub);
  font-size: calc(13px * var(--font-scale));
}

/* Dropdown 动画 */
.dropdown-enter-active, .dropdown-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.dropdown-enter-from, .dropdown-leave-to {
  opacity: 0;
  transform: scaleY(0.95);
  transform-origin: top;
}
</style>
