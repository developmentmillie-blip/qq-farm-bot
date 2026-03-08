<script setup lang="ts">
import { ref } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'

const currentTab = ref<'farm' | 'bag' | 'task'>('farm')
</script>

<template>
  <div class="personal-page">
    <!-- Tab 切换栏 -->
    <div class="tab-bar">
      <button
        class="tab-btn"
        :class="{ active: currentTab === 'farm' }"
        @click="currentTab = 'farm'"
      >
        <i class="fa-solid fa-seedling" />
        <span>我的农场</span>
      </button>
      <button
        class="tab-btn"
        :class="{ active: currentTab === 'bag' }"
        @click="currentTab = 'bag'"
      >
        <i class="fa-solid fa-box-open" />
        <span>我的背包</span>
      </button>
      <button
        class="tab-btn"
        :class="{ active: currentTab === 'task' }"
        @click="currentTab = 'task'"
      >
        <i class="fa-solid fa-list-check" />
        <span>我的任务</span>
      </button>
    </div>

    <!-- Tab 内容 -->
    <div class="tab-content">
      <Transition
        name="tab-fade"
        mode="out-in"
      >
        <component
          :is="currentTab === 'farm' ? FarmPanel : (currentTab === 'bag' ? BagPanel : TaskPanel)"
          :key="currentTab"
        />
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.personal-page {
  padding: 14px;
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 0;
}

.tab-bar {
  flex-shrink: 0;
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin-top: 2px;
}

.tab-fade-enter-active,
.tab-fade-leave-active {
  transition: opacity 0.15s ease;
}
.tab-fade-enter-from,
.tab-fade-leave-to {
  opacity: 0;
}
</style>
