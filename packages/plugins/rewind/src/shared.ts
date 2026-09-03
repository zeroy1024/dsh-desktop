/**
 * 双半共享常量。事件类型字面量与 patches/0012（dsh-session 声明）及
 * patches/0013（client runtime 折叠）保持一致；刻意本地字面量，不 import
 * 上游构建产物，避免解析时序耦合。
 */
export const REWIND_EVENT_TYPE = 'dsh-desktop/session-rewind'

/** host 半挂进 webServer 的恢复路由（client 同源 fetch 同一路径）。 */
export const REWIND_EXECUTE_PATH = '/dsh-desktop/rewind/execute'
