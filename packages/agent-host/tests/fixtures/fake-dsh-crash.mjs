// 模拟 ready 后随即崩溃的 dsh web（触发自动重启）。
console.log('dsh web: http://127.0.0.1:4568/?token=crash-token')
setTimeout(() => process.exit(1), 50)
