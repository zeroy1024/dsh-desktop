// 模拟正常启动的 dsh web：先打印噪声行，再打印 ready 行，然后常驻。
console.log('booting plugins...')
console.log('dsh web: http://127.0.0.1:4567/?token=test-token')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
