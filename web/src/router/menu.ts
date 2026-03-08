export interface MenuItem {
  path: string
  name: string
  label: string
  icon: string
  component: () => Promise<any>
}

export const menuRoutes: MenuItem[] = [
  {
    path: '',
    name: 'dashboard',
    label: '概览',
    icon: 'fa-solid fa-chart-pie',
    component: () => import('@/views/Dashboard.vue'),
  },
  {
    path: 'personal',
    name: 'personal',
    label: '个人',
    icon: 'fa-solid fa-user',
    component: () => import('@/views/Personal.vue'),
  },
  {
    path: 'friends',
    name: 'friends',
    label: '好友',
    icon: 'fa-solid fa-users',
    component: () => import('@/views/Friends.vue'),
  },
  {
    path: 'ranch',
    name: 'ranch',
    label: '牧场',
    icon: 'fa-solid fa-horse',
    component: () => import('@/views/Ranch.vue'),
  },
  {
    path: 'analytics',
    name: 'analytics',
    label: '分析',
    icon: 'fa-solid fa-chart-bar',
    component: () => import('@/views/Analytics.vue'),
  },
  {
    path: 'accounts',
    name: 'accounts',
    label: '账号',
    icon: 'fa-solid fa-users-gear',
    component: () => import('@/views/Accounts.vue'),
  },
  {
    path: 'settings',
    name: 'Settings',
    label: '设置',
    icon: 'fa-solid fa-sliders',
    component: () => import('@/views/Settings.vue'),
  },
]

