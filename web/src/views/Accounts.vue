<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AccountModal from '@/components/AccountModal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import { useAccountStore } from '@/stores/account'

const router = useRouter()
const accountStore = useAccountStore()
const { accounts, loading } = storeToRefs(accountStore)

const showModal = ref(false)
const showDeleteConfirm = ref(false)
const deleteLoading = ref(false)
const editingAccount = ref<any>(null)
const accountToDelete = ref<any>(null)

onMounted(() => { accountStore.fetchAccounts() })

function openSettings(account: any) {
  accountStore.selectAccount(account.id)
  router.push('/settings')
}

function openAddModal() {
  editingAccount.value = null
  showModal.value = true
}

function openEditModal(account: any) {
  editingAccount.value = { ...account }
  showModal.value = true
}

async function handleDelete(account: any) {
  accountToDelete.value = account
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (accountToDelete.value) {
    try {
      deleteLoading.value = true
      await accountStore.deleteAccount(accountToDelete.value.id)
      accountToDelete.value = null
      showDeleteConfirm.value = false
    }
    finally {
      deleteLoading.value = false
    }
  }
}

async function toggleAccount(account: any) {
  if (account.running)
    await accountStore.stopAccount(account.id)
  else
    await accountStore.startAccount(account.id)
  await accountStore.fetchAccounts()
}

function handleSaved() {
  accountStore.fetchAccounts()
}
</script>

<template>
  <div class="accounts-page">
    <div class="page-header">
      <h2 class="page-title">
        <i class="fa-solid fa-user-gear" />
        账号管理
      </h2>
      <button class="btn btn-primary" @click="openAddModal">
        <i class="fa-solid fa-plus" /> 添加账号
      </button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading && accounts.length === 0" class="card empty-state">
      <div class="loading-spin" />
      <div style="margin-top: 12px;">加载中...</div>
    </div>

    <!-- 无账号 -->
    <div v-else-if="accounts.length === 0" class="card empty-state">
      <i class="fa-solid fa-user-slash" style="font-size: 40px; color: var(--sub); margin-bottom: 16px;" />
      <div style="color: var(--sub); margin-bottom: 14px;">暂无账号</div>
      <button class="btn btn-ghost" @click="openAddModal">立即添加</button>
    </div>

    <!-- 账号列表 -->
    <div v-else class="accounts-grid">
      <div
        v-for="acc in accounts"
        :key="acc.id"
        class="acc-item"
      >
        <div class="acc-header">
          <div class="acc-avatar">
            <img v-if="acc.uin" :src="`https://q1.qlogo.cn/g?b=qq&nk=${acc.uin}&s=100`">
            <i v-else class="fa-solid fa-user" style="font-size: 20px; color: var(--sub);" />
          </div>
          <div style="flex:1; min-width:0;">
            <div class="acc-name">{{ acc.name || acc.nick || acc.id }}</div>
            <div class="acc-uin">QQ: {{ acc.uin || '未绑定' }}</div>
          </div>
          <!-- 启动/停止 -->
          <button
            class="btn acc-toggle-btn"
            :class="acc.running ? 'btn-stop' : 'btn-primary'"
            @click="toggleAccount(acc)"
          >
            <i :class="acc.running ? 'fa-solid fa-stop' : 'fa-solid fa-play'" />
            {{ acc.running ? '停止' : '启动' }}
          </button>
        </div>

        <div class="acc-footer">
          <div class="acc-status">
            <span class="dot" :class="acc.running ? 'online' : 'offline'" />
            {{ acc.running ? '运行中' : '已停止' }}
          </div>
          <div class="acc-actions">
            <button class="btn btn-ghost btn-sm acc-icon-btn" title="设置" @click="openSettings(acc)">
              <i class="fa-solid fa-gear" />
            </button>
            <button class="btn btn-ghost btn-sm acc-icon-btn" title="编辑" @click="openEditModal(acc)">
              <i class="fa-solid fa-pen" />
            </button>
            <button class="btn btn-ghost btn-sm acc-icon-btn danger" title="删除" @click="handleDelete(acc)">
              <i class="fa-solid fa-trash" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <AccountModal
      :show="showModal"
      :edit-data="editingAccount"
      @close="showModal = false"
      @saved="handleSaved"
    />

    <ConfirmModal
      :show="showDeleteConfirm"
      :loading="deleteLoading"
      title="删除账号"
      :message="accountToDelete ? `确定要删除账号 ${accountToDelete.name || accountToDelete.id} 吗?` : ''"
      confirm-text="删除"
      type="danger"
      @close="!deleteLoading && (showDeleteConfirm = false)"
      @cancel="!deleteLoading && (showDeleteConfirm = false)"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.accounts-page {
  padding: 14px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.page-title {
  margin: 0;
  font-size: calc(22px * var(--font-scale));
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.page-title i { color: var(--primary); }

.accounts-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: flex-start;
}

.acc-item {
  width: 320px;
  max-width: 100%;
}

.acc-toggle-btn {
  min-width: 72px;
  flex-shrink: 0;
}

.acc-icon-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.acc-icon-btn.danger {
  color: var(--danger);
}
.acc-icon-btn.danger:hover {
  border-color: var(--danger);
  background: rgba(240,111,104,0.08);
}

@media (max-width: 640px) {
  .accounts-grid { flex-direction: column; }
  .acc-item { width: 100%; }
}
</style>
