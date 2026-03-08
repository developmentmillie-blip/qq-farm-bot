<script setup lang="ts">
import { storeToRefs } from 'pinia'
import Sidebar from '@/components/Sidebar.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const { sidebarOpen } = storeToRefs(appStore)
</script>

<template>
  <div class="app-shell">
    <!-- 移动端侧边栏遮罩 -->
    <div
      class="sidebar-overlay"
      :class="{ show: sidebarOpen }"
      @click="appStore.closeSidebar"
    />

    <!-- Sidebar 组件自身包含：侧边栏 + 移动端顶部栏 -->
    <Sidebar />

    <!-- 主内容区 -->
    <div class="app-main">
      <div class="page-wrap">
        <RouterView v-slot="{ Component, route }">
          <Transition name="page-fade" mode="out-in">
            <component :is="Component" :key="route.path" />
          </Transition>
        </RouterView>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.page-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.page-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
