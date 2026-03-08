<script setup lang="ts">
import { useStorage } from '@vueuse/core'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api'

const router = useRouter()
const password = ref('')
const error = ref('')
const loading = ref(false)
const showPassword = ref(false)
const token = useStorage('admin_token', '')

async function handleLogin() {
  if (!password.value) {
    error.value = '请输入密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await api.post('/api/login', { password: password.value })
    if (res.data.ok) {
      token.value = res.data.data.token
      router.push('/')
    }
    else {
      error.value = res.data.error || '登录失败'
    }
  }
  catch (e: any) {
    error.value = e.response?.data?.error || e.message || '登录异常'
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-overlay">
    <div class="login-card">
      <div class="login-logo">
        <i class="fa-solid fa-seedling" />
      </div>
      <div class="login-title">悠闲农场</div>
      <div class="login-sub">登录面板</div>

      <form @submit.prevent="handleLogin">
        <div class="password-wrap">
          <input
            v-model="password"
            class="login-input"
            :type="showPassword ? 'text' : 'password'"
            placeholder="管理密码"
            autofocus
          >
          <button
            class="password-toggle"
            type="button"
            :aria-pressed="showPassword"
            aria-label="显示密码"
            @click="showPassword = !showPassword"
          >
            <i :class="showPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'" />
          </button>
        </div>

        <div v-if="error" class="login-error">{{ error }}</div>

        <button class="btn btn-primary login-btn" type="submit" :disabled="loading">
          <i v-if="loading" class="fa-solid fa-spinner fa-spin" />
          <span>{{ loading ? '登录中...' : '登录' }}</span>
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg, #0f1117);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.login-card {
  background: var(--panel, #1a1d2e);
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  border-radius: 16px;
  padding: 40px 36px 36px;
  width: 100%;
  max-width: 380px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.4);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}

.login-logo {
  width: 64px;
  height: 64px;
  background: var(--primary, #4caf7d);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: #fff;
  margin-bottom: 16px;
  box-shadow: 0 4px 20px rgba(76, 175, 125, 0.4);
}

.login-title {
  font-family: 'ZCOOL KuaiLe', var(--font-brand, sans-serif);
  font-size: 28px;
  font-weight: 700;
  color: var(--text, #e8eaf6);
  margin-bottom: 4px;
  letter-spacing: 2px;
}

.login-sub {
  font-size: 14px;
  color: var(--text-sub, #9ca3af);
  margin-bottom: 28px;
}

.password-wrap {
  position: relative;
  width: 100%;
  margin-bottom: 12px;
}

.login-input {
  width: 100%;
  padding: 11px 44px 11px 14px;
  background: var(--panel-2, #252840);
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  border-radius: 8px;
  color: var(--text, #e8eaf6);
  font-size: 15px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

.login-input:focus {
  border-color: var(--primary, #4caf7d);
}

.login-input::placeholder {
  color: var(--text-muted, #555);
}

.password-toggle {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--text-sub, #9ca3af);
  cursor: pointer;
  font-size: 14px;
  padding: 4px;
  display: flex;
  align-items: center;
}

.password-toggle:hover {
  color: var(--primary, #4caf7d);
}

.login-error {
  color: #f06f68;
  font-size: 13px;
  margin-bottom: 10px;
  width: 100%;
  text-align: center;
}

.btn.btn-primary.login-btn {
  width: 100%;
  padding: 12px;
  background: var(--primary, #4caf7d);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.2s, opacity 0.2s;
  font-family: inherit;
}

.btn.btn-primary.login-btn:hover:not(:disabled) {
  background: var(--accent, #56d4a0);
}

.btn.btn-primary.login-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 亮色主题适配 */
:global(body.light-theme) .login-overlay {
  background: #f0f2f5;
}
:global(body.light-theme) .login-card {
  background: #fff;
  border-color: #e0e0e0;
  box-shadow: 0 4px 24px rgba(0,0,0,0.1);
}
:global(body.light-theme) .login-input {
  background: #f5f7fa;
  border-color: #dde1e7;
  color: #1a1d2e;
}
:global(body.light-theme) .login-title {
  color: #1a1d2e;
}
</style>
