// 模拟 ready 后输出一条 160 KiB 无换行「巨型行」（测试残留缓冲上限：
// 应分段落盘、进程保持健康，主进程堆不被撑爆）。
console.log('dsh web: http://127.0.0.1:4568/?token=big-line-secret')
const chunk = 'x'.repeat(16 * 1024)
for (let i = 0; i < 10; i++) process.stdout.write(chunk)
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)