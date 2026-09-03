/** review 双半共享的常量与薄类型（防 host/client 字面量漂移，ADR-0005 同款）。 */

/** git 只读路由：GET /dsh-desktop/review/git?sessionId=&scope= */
export const GIT_ROUTE = '/dsh-desktop/review/git'

/** 撤销单文件路由：POST /dsh-desktop/review/restore {sessionId, path} */
export const RESTORE_ROUTE = '/dsh-desktop/review/restore'

/** git status --porcelain 的单文件条目（xy + 相对路径；重命名带 oldPath）。 */
export interface GitStatusEntry {
  x: string
  y: string
  path: string
  oldPath?: string
}
