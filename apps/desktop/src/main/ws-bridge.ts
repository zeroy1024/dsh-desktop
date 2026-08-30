/**
 * ws-bridge.ts — 把渲染进程的 /api/events.* WebSocket 接到 agent。
 * 页面垫片经 preload 拿到同步 id，主进程用 Node WebSocket 连 loopback。
 */
import { ipcMain, type WebContents } from 'electron'
import { parseAgentEventPath, toAgentWsUrl } from '@dsh-desktop/bridge'
import { getAgentEndpoint } from './protocol'
import { isTrustedIpcSender } from './security'

interface SocketSlot {
  ws: WebSocket
  sender: WebContents
  closing: boolean
}

const sockets = new Map<string, SocketSlot>()
const senderSockets = new Map<number, Set<string>>()
const hookedSenders = new Set<number>()
const SOCKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function socketKey(sender: WebContents, id: string): string {
  return `${String(sender.id)}:${id}`
}

function forgetSocket(key: string, slot: SocketSlot): void {
  if (sockets.get(key) === slot) sockets.delete(key)
  const keys = senderSockets.get(slot.sender.id)
  keys?.delete(key)
  if (keys?.size === 0) senderSockets.delete(slot.sender.id)
}

function closeSlot(key: string, slot: SocketSlot): void {
  if (slot.closing) return
  slot.closing = true
  if (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING) {
    try {
      slot.ws.close()
    } catch {
      // socket 已由底层关闭。
    }
  }
}

function trackSender(sender: WebContents, key: string): void {
  let keys = senderSockets.get(sender.id)
  if (keys === undefined) {
    keys = new Set()
    senderSockets.set(sender.id, keys)
  }
  if (!hookedSenders.has(sender.id)) {
    hookedSenders.add(sender.id)
    sender.once('destroyed', () => {
      for (const ownedKey of senderSockets.get(sender.id) ?? []) {
        const slot = sockets.get(ownedKey)
        if (slot !== undefined) closeSlot(ownedKey, slot)
      }
      senderSockets.delete(sender.id)
      hookedSenders.delete(sender.id)
    })
  }
  keys.add(key)
}

function sendEvent(
  sender: WebContents,
  payload: { id: string; type: 'open' | 'message' | 'close' | 'error'; data?: string },
): void {
  if (sender.isDestroyed()) return
  sender.send('dsh-bridge:ws-event', payload)
}

export function installWsBridge(): void {
  ipcMain.on('dsh-bridge:ws-open', (event, payload: unknown) => {
    if (!isTrustedIpcSender(event) || typeof payload !== 'object' || payload === null) return
    const { id, path } = payload as { id?: unknown; path?: unknown }
    if (typeof id !== 'string' || !SOCKET_ID.test(id)) return
    const safePath = parseAgentEventPath(path)
    if (safePath === null) {
      sendEvent(event.sender, { id, type: 'error' })
      sendEvent(event.sender, { id, type: 'close' })
      return
    }
    const agent = getAgentEndpoint()
    if (agent === null) {
      sendEvent(event.sender, { id, type: 'error' })
      sendEvent(event.sender, { id, type: 'close' })
      return
    }
    const key = socketKey(event.sender, id)
    const existing = sockets.get(key)
    if (existing !== undefined) closeSlot(key, existing)
    let ws: WebSocket
    try {
      ws = new WebSocket(toAgentWsUrl(safePath, agent))
    } catch {
      sendEvent(event.sender, { id, type: 'error' })
      sendEvent(event.sender, { id, type: 'close' })
      return
    }
    const slot = { ws, sender: event.sender, closing: false }
    sockets.set(key, slot)
    trackSender(event.sender, key)
    ws.addEventListener('open', () => {
      if (sockets.get(key) !== slot) {
        try {
          ws.close()
        } catch {
          // 已取消的 CONNECTING socket 完成握手后立即关闭。
        }
        return
      }
      if (slot.closing) {
        ws.close()
        return
      }
      sendEvent(event.sender, { id, type: 'open' })
    })
    ws.addEventListener('message', (message) => {
      if (sockets.get(key) !== slot || slot.closing) return
      sendEvent(event.sender, { id, type: 'message', data: String(message.data) })
    })
    ws.addEventListener('error', () => {
      if (sockets.get(key) !== slot || slot.closing) return
      sendEvent(event.sender, { id, type: 'error' })
    })
    ws.addEventListener('close', () => {
      if (sockets.get(key) !== slot) return
      forgetSocket(key, slot)
      sendEvent(event.sender, { id, type: 'close' })
    })
  })

  ipcMain.on('dsh-bridge:ws-close', (event, id: unknown) => {
    if (!isTrustedIpcSender(event) || typeof id !== 'string' || !SOCKET_ID.test(id)) return
    const key = socketKey(event.sender, id)
    const slot = sockets.get(key)
    if (slot === undefined) return
    closeSlot(key, slot)
  })
}

export function closeAllAgentSockets(): void {
  for (const [key, slot] of sockets) closeSlot(key, slot)
  senderSockets.clear()
}
