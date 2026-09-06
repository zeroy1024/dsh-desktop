/** node 半路由路径与 client 半 fetch 的共享常量。 */

/** 跨会话用量汇总（只读；刻意 POST，同源 GET 无 Origin 头会被同源栅栏 403）。 */
export const USAGE_SUMMARY_PATH = '/dsh-desktop/usage/summary'
