import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME
if (!home) process.exit(3)
mkdirSync(home, { recursive: true })
const marker = join(home, 'started-once')
if (existsSync(marker)) {
  process.exit(2)
}
writeFileSync(marker, '1')
console.log('dsh web: http://127.0.0.1:4567/?token=restart-secret')
setTimeout(() => process.exit(1), 30)
