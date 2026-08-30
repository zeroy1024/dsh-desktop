/**
 * ws-bridge.ts — 把渲染进程的 /api/events.* WebSocket 接到 agent。
 * 页面垫片经 preload 拿到同步 id，主进程用 Node WebSocket 连 loopback。
 */
import { ipcMain, type WebContents } from 'electron'
import { isAgentEventSocket, toAgentWsUrl } from '@dsh-desktop/bridge'
import { getAgentEndpoint } from './protocol'

interface SocketSlot {
  ws: WebSocket
  sender: WebContents
}

const sockets = new Map<string, SocketSlot>()

function sendEvent(
  sender: WebContents,
  payload: { id: string; type: 'open' | 'message' | 'close' | 'error'; data?: string },
): void {
  if (sender.isDestroyed()) return
  sender.send('dsh-bridge:ws-event', payload)
}

export function installWsBridge(): void {
  ipcMain.on('dsh-bridge:ws-open', (event, payload: { id: string; path: string }) => {
    const agent = getAgentEndpoint()
    if (agent === null) {
      sendEvent(event.sender, { id: payload.id, type: 'error' })
      sendEvent(event.sender, { id: payload.id, type: 'close' })
      return
    }
    const pathname = payload.path.split('?')[0] ?? payload.path
    if (!isAgentEventSocket(pathname)) {
      sendEvent(event.sender, { id: payload.id, type: 'error' })
      sendEvent(event.sender, { id: payload.id, type: 'close' })
      return
    }
    const ws = new WebSocket(toAgentWsUrl(payload.path, agent))
    sockets.set(payload.id, { ws, sender: event.sender })
    ws.addEventListener('open', () => {
      sendEvent(event.sender, { id: payload.id, type: 'open' })
    })
    ws.addEventListener('message', (message) => {
      sendEvent(event.sender, { id: payload.id, type: 'message', data: String(message.data) })
    })
    ws.addEventListener('error', () => {
      sendEvent(event.sender, { id: payload.id, type: 'error' })
    })
    ws.addEventListener('close', () => {
      sockets.delete(payload.id)
      sendEvent(event.sender, { id: payload.id, type: 'close' })
    })
  })

  ipcMain.on('dsh-bridge:ws-close', (_event, id: string) => {
    const slot = sockets.get(id)
    if (slot === undefined) return
    sockets.delete(id)
    if (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING) {
      slot.ws.close()
    }
  })
}

export function closeAllAgentSockets(): void {
  for (const [id, slot] of sockets) {
    sockets.delete(id)
    slot.ws.close()
  }
}
