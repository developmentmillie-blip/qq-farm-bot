import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from './account'
import { useToastStore } from './toast'

export const useRanchStore = defineStore('ranch', () => {
  const config = ref<any>(null)
  const state = ref<any>(null)
  const loadingConfig = ref(false)
  const loadingState = ref(false)

  async function fetchConfig() {
    if (config.value) return config.value
    loadingConfig.value = true
    try {
      const res = await api.get('/api/ranch/config')
      if (res.data?.ok) config.value = res.data.data
    }
    catch (e) { console.error('[Ranch] config err', e) }
    finally { loadingConfig.value = false }
    return config.value
  }
  async function fetchState() {
    const accountStore = useAccountStore()
    const id = accountStore.currentAccountId
    if (!id) return null
    loadingState.value = true
    try {
      const res = await api.get('/api/ranch/state', { headers: { 'x-account-id': id } })
      if (res.data?.ok) state.value = res.data.data
    }
    catch (e) { console.error('[Ranch] state err', e) }
    finally { loadingState.value = false }
    return state.value
  }

  async function loadAll() { await Promise.all([fetchConfig(), fetchState()]) }

  async function unlockBreed(breedId: string) {
    const toast = useToastStore()
    const id = useAccountStore().currentAccountId
    const res = await api.post('/api/ranch/unlock', { breedId }, { headers: { 'x-account-id': id } })
    toast.add(res.data?.msg || (res.data?.ok ? 'OK' : 'ERR'), res.data?.ok ? 'success' : 'error')
    if (res.data?.ok) await fetchState()
    return res.data
  }
  async function tryBreed(breedId: string) {
    const toast = useToastStore()
    const id = useAccountStore().currentAccountId
    const res = await api.post('/api/ranch/breed', { breedId }, { headers: { 'x-account-id': id } })
    const type = !res.data?.ok ? 'error' : res.data?.breedSuccess ? 'success' : res.data?.bred === false ? 'warning' : 'success'
    toast.add(res.data?.msg || 'Done', type)
    if (res.data?.ok) await fetchState()
    return res.data
  }

  async function feedBreed(breedId: string) {
    const toast = useToastStore()
    const id = useAccountStore().currentAccountId
    const res = await api.post('/api/ranch/feed', { breedId }, { headers: { 'x-account-id': id } })
    toast.add(res.data?.msg || (res.data?.ok ? 'OK' : 'ERR'), res.data?.ok ? 'success' : 'error')
    if (res.data?.ok) await fetchState()
    return res.data
  }

  async function treatBreed(breedId: string, medicineId: string) {
    const toast = useToastStore()
    const id = useAccountStore().currentAccountId
    const res = await api.post('/api/ranch/treat', { breedId, medicineId }, { headers: { 'x-account-id': id } })
    toast.add(res.data?.msg || (res.data?.ok ? 'OK' : 'ERR'), res.data?.ok ? 'success' : 'error')
    if (res.data?.ok) await fetchState()
    return res.data
  }
  async function buyItem(itemId: string, quantity: number) {
    const toast = useToastStore()
    const id = useAccountStore().currentAccountId
    const res = await api.post('/api/ranch/buy', { itemId, quantity }, { headers: { 'x-account-id': id } })
    toast.add(res.data?.msg || (res.data?.ok ? 'OK' : 'ERR'), res.data?.ok ? 'success' : 'error')
    if (res.data?.ok) await fetchState()
    return res.data
  }

  async function getQuiz(breedId: string) {
    const id = useAccountStore().currentAccountId
    const res = await api.get(`/api/ranch/quiz/${breedId}`, { headers: { 'x-account-id': id } })
    return res.data
  }

  async function submitQuiz(breedId: string, answers: number[]) {
    const toast = useToastStore()
    const id = useAccountStore().currentAccountId
    const res = await api.post(`/api/ranch/quiz/${breedId}`, { answers }, { headers: { 'x-account-id': id } })
    toast.add(res.data?.msg || 'Submitted', res.data?.allCorrect ? 'success' : 'warning')
    if (res.data?.ok) await fetchState()
    return res.data
  }

  async function getWarehouse() {
    const id = useAccountStore().currentAccountId
    const res = await api.get('/api/ranch/warehouse', { headers: { 'x-account-id': id } })
    return res.data
  }
  async function getMailbox() {
    const id = useAccountStore().currentAccountId
    const res = await api.get('/api/ranch/mailbox', { headers: { 'x-account-id': id } })
    return res.data
  }

  async function claimMail(mailId: string) {
    const toast = useToastStore()
    const id = useAccountStore().currentAccountId
    const res = await api.post('/api/ranch/mail/claim', { mailId }, { headers: { 'x-account-id': id } })
    toast.add(res.data?.msg || (res.data?.ok ? 'OK' : 'ERR'), res.data?.ok ? 'success' : 'error')
    if (res.data?.ok) await fetchState()
    return res.data
  }

  async function getAllAccounts() {
    const res = await api.get('/api/ranch/all-accounts')
    return res.data
  }

  async function giftBook(breedId: string, toAccountId: string, fromName: string) {
    const toast = useToastStore()
    const id = useAccountStore().currentAccountId
    const res = await api.post('/api/ranch/gift-book', { breedId, toAccountId, fromName }, { headers: { 'x-account-id': id } })
    toast.add(res.data?.msg || (res.data?.ok ? 'OK' : 'ERR'), res.data?.ok ? 'success' : 'error')
    if (res.data?.ok) await fetchState()
    return res.data
  }

  function resetState() { state.value = null }

  return { config, state, loadingConfig, loadingState, fetchConfig, fetchState, loadAll,
    resetState, unlockBreed, tryBreed, feedBreed, treatBreed, buyItem, getQuiz,
    submitQuiz, getWarehouse, getMailbox, claimMail, getAllAccounts, giftBook }
})
