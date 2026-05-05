// lib/alert-store.ts
'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Alert, AlertCondition } from '@/types/alert'

interface AlertStore {
  alerts: Alert[]
  addAlert: (condition: AlertCondition, options: Omit<Alert, 'id' | 'condition' | 'createdAt'>) => void
  removeAlert: (id: string) => void
  toggleAlert: (id: string) => void
  updateLastTriggered: (id: string) => void
}

export const useAlertStore = create<AlertStore>()(
  persist(
    (set) => ({
      alerts: [],

      addAlert: (condition, options) =>
        set((state) => ({
          alerts: [
            ...state.alerts,
            {
              ...options,
              id: crypto.randomUUID(),
              condition,
              createdAt: new Date().toISOString(),
            },
          ],
        })),

      removeAlert: (id) =>
        set((state) => ({
          alerts: state.alerts.filter((a) => a.id !== id),
        })),

      toggleAlert: (id) =>
        set((state) => ({
          alerts: state.alerts.map((a) =>
            a.id === id ? { ...a, enabled: !a.enabled } : a
          ),
        })),

      updateLastTriggered: (id) =>
        set((state) => ({
          alerts: state.alerts.map((a) =>
            a.id === id ? { ...a, lastTriggeredAt: new Date().toISOString() } : a
          ),
        })),
    }),
    {
      name: 'stockboard-alerts',
    }
  )
)
