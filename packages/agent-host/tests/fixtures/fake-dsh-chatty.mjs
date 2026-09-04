// 模拟运行期持续产出日志的 dsh web（测试运行期中位轮转）。
// 心跳拉开间隔（而非一次性打满）：轮转判定依赖磁盘 flush 可见性，
// 持续小写才能让 mid-run 轮转稳定触发。
console.log('dsh web: http://127.0.0.1:4568/?token=chatty-secret')
let i = 0
const heartbeat = setInterval(() => {
  console.log(`[chatty] heartbeat line ${i} ${'z'.repeat(64)}`)
  i += 1
  if (i >= 200) clearInterval(heartbeat)
}, 5)
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)