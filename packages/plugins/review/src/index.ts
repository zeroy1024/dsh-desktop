/**
 * review 的 node 半（P1 起）：把 git 改动源挂进 agent webserver——
 *   GET  /dsh-desktop/review/git      只读（status + unified diff）
 *   POST /dsh-desktop/review/restore  撤销单文件（唯一写路径，见 git-handler）
 * 会话模式的改动聚合不经过 host 半（纯 client RPC 回放）。
 *
 * 根目录解析与 file-browser 同链：活跃会话读 SessionStore 内存头，冷会话
 * 兜底落盘 header 索引；依赖以 cordis fiber inject 声明。@dsh-desktop/bridge
 * 以源码打进 lib/index.js（同 file-browser，不用 packages:'external'）。
 */
import { createGitRoutes } from './git-handler'

/** 使用到的 cordis 上下文面（最小结构镜像，只声明本插件触碰的切片）。 */
interface ReviewContext {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
    }): () => void
  }
  sessions: {
    get(id: string): { header?: { cwd?: string } } | undefined
  }
  /** 落盘会话头索引（冷会话不在内存里，cwd 只在这里有）。 */
  sessionPersistence: {
    list(): Promise<Array<{ id?: string; cwd?: string } | undefined>>
  }
}

/** 插件名（cordis 自注册 + client-hmr 观察的 id，与 package.json name 尾段一致约定）。 */
export const name = 'review'

/** fiber 依赖：路由载体与 session→cwd 解析（desktop composition 必然在场）。 */
export const inject = ['webServer', 'sessions', 'sessionPersistence']

/**
 * 激活：注册 git 只读 + restore 两条 exact 路由，effect disposer 负责摘除。
 * @param raw - cordis 根上下文。
 */
export function apply(raw: unknown): void {
  const context = raw as unknown as ReviewContext
  const resolveRoot = async (sessionId: string): Promise<string | undefined> => {
    const live = context.sessions.get(sessionId)?.header?.cwd
    if (typeof live === 'string' && live !== '') return live
    try {
      const headers = await context.sessionPersistence.list()
      const cold = headers.find(header => header?.id === sessionId)
      const cwd = cold?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    } catch {
      return undefined
    }
  }
  // 路由生命周期随 fiber（同 file-browser：注册返回的 disposer 不单独管理）。
  for (const route of createGitRoutes({ resolveRoot })) {
    context.webServer.register({ kind: 'exact', path: route.path, handler: route.handler })
  }
}
