// 模拟永不打印 ready 行的 dsh web（触发启动超时）；响应 SIGTERM，让超时清理能正常收尸。
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
