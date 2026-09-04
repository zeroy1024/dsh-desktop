// 模拟 ready 后随即崩溃的 dsh web（触发自动重启）。
// FAKE_DSH_CRASH_AFTER_MS 可覆盖崩溃延迟（稳定性边界测试调参用）。
const crashAfterMs = Number(process.env.FAKE_DSH_CRASH_AFTER_MS ?? 50)
console.log('dsh web: http://127.0.0.1:4568/?token=crash-token')
setTimeout(() => process.exit(1), crashAfterMs)