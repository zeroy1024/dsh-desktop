/**
 * 双半共享常量：node 半（webServer 路由）与浏览器半（同源 fetch）必须指向
 * 同一路径。独立成文件让两半经相对导入共享同一字面量，避免漂移。
 */
export const UNARCHIVE_PATH = '/dsh-desktop/archive-manager/unarchive'

/** 归档时间侧车只读路由（GET，返回 sessionId → 归档时刻的映射）。 */
export const TIMESTAMPS_PATH = '/dsh-desktop/archive-manager/timestamps'
