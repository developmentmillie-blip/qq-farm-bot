<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const { isDark } = storeToRefs(appStore)
</script>

<template>
  <button
    class="icon-btn"
    title="切换主题"
    @click="appStore.toggleDark()"
  >
    <i :class="isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon'" />
  </button>
</template>
