// 模拟无视 SIGTERM 的顽固 dsh web（触发 stop 的 SIGKILL 兜底路径）。
console.log('dsh web: http://127.0.0.1:4569/?token=stubborn-token')
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
