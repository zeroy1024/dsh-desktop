/**
 * 注入到 index.html 的 WebSocket 垫片：把 /api/events.* 转到 preload 暴露的 IPC。
 * 必须在官方 ModuleLoader 脚本之前执行。
 *
 * 页面侧先登记 socket 再 ipc，避免主进程下行帧早于 then() 到达而丢消息。
 */
export const WS_SHIM_SCRIPT = `<script>
(function () {
  var api = window.dshDesktop
  if (!api || typeof api.wsOpen !== 'function') return
  var NativeWS = window.WebSocket
  window.__dshSockets = Object.create(null)
  api.onWsEvent(function (ev) {
    var sock = window.__dshSockets[ev.id]
    if (!sock) return
    if (ev.type === 'open') {
      sock.readyState = 1
      sock._emit('open', new Event('open'))
    } else if (ev.type === 'message') {
      sock._emit('message', new MessageEvent('message', { data: ev.data }))
    } else if (ev.type === 'close') {
      sock.readyState = 3
      sock._emit('close', new CloseEvent('close'))
      delete window.__dshSockets[ev.id]
    } else if (ev.type === 'error') {
      sock._emit('error', new Event('error'))
    }
  })
  function DshSocket(url) {
    this.readyState = 0
    this.bufferedAmount = 0
    this.extensions = ''
    this.protocol = ''
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    this._listeners = { open: [], message: [], close: [], error: [] }
    var parsed = new URL(String(url), location.href)
    this._id = api.wsOpen(parsed.pathname + parsed.search)
    window.__dshSockets[this._id] = this
  }
  DshSocket.prototype._emit = function (type, event) {
    var handler = this['on' + type]
    if (typeof handler === 'function') handler.call(this, event)
    var list = this._listeners[type] || []
    for (var i = 0; i < list.length; i++) list[i].call(this, event)
  }
  DshSocket.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = []
    this._listeners[type].push(fn)
  }
  DshSocket.prototype.removeEventListener = function (type, fn) {
    var list = this._listeners[type]
    if (!list) return
    this._listeners[type] = list.filter(function (x) { return x !== fn })
  }
  DshSocket.prototype.send = function () {}
  DshSocket.prototype.close = function () {
    if (this._id && this.readyState < 2) {
      this.readyState = 2
      api.wsClose(this._id)
    }
    this.readyState = 3
  }
  window.WebSocket = function (url, proto) {
    try {
      var parsed = new URL(String(url), location.href)
      if (parsed.pathname === '/api/events.mux' || parsed.pathname === '/api/events.host') {
        return new DshSocket(url)
      }
    } catch (err) {}
    return proto === undefined ? new NativeWS(url) : new NativeWS(url, proto)
  }
  window.WebSocket.CONNECTING = 0
  window.WebSocket.OPEN = 1
  window.WebSocket.CLOSING = 2
  window.WebSocket.CLOSED = 3
  window.WebSocket.prototype = NativeWS.prototype
})()
</script>`

/** 把垫片插进 HTML head（已注入则跳过）。 */
export function injectWsShim(html: string): string {
  if (html.includes('__dshSockets')) return html
  const head = html.match(/<head[^>]*>/i)
  if (head?.index === undefined) return WS_SHIM_SCRIPT + html
  const at = head.index + head[0].length
  return html.slice(0, at) + WS_SHIM_SCRIPT + html.slice(at)
}
