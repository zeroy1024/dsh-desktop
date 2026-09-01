/**
 * file-browser 的 node 半：在 agent webserver 上注册只读文件浏览路由
 * `/dsh-file-browser/*`（list/read 两 op）。
 *
 * 设计约束（见 fs-handler.ts 头注释）：
 * - 根目录不信任客户端：sessionId → ctx.sessions 的 header.cwd（store 已校验
 *   绝对路径）服务端独立解析；未知 session 一律 404。
 * - 服务依赖声明走 cordis 的 fiber inject：'webServer' 在 web/desktop profile
 *   必装（bundle/web-app 层），'sessions' 由 core/session 提供。类型不 import
 *   上游 src（铁律 4），此处按使用面手写最小结构镜像（activity-group 的
 *   ambient 镜像先例），运行期形状与上游 lib 一致。
 * - @dsh-desktop/bridge 以源码被 esbuild 打进 lib/index.js；node 半不使用
 *   packages:'external'，否则 workspace 裸包名会残留成打包态运行时依赖。
 */
import { createFsHandler, FS_ROUTE_PREFIX } from './fs-handler'

/** 使用到的 cordis 上下文面（最小结构镜像，只声明本插件触碰的切片）。 */
interface BrowserContext {
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
  /** 落盘会话头索引（冷会话不在 SessionStore 内存里，cwd 只在这里有）。 */
  sessionPersistence: {
    list(): Promise<Array<{ id?: string; cwd?: string } | undefined>>
  }
}

/** 插件名（cordis 自注册 + client-hmr 观察的 id，与 package.json name 尾段一致约定）。 */
export const name = 'file-browser'

/**
 * fiber 依赖：路由载体与 session→cwd 解析。sessionPersistence 与
 * workspaceRegistry 同源（WorkspaceRegistry static inject 即含它），
 * 服务必然在 desktop composition 里。
 */
export const inject = ['webServer', 'sessions', 'sessionPersistence']

/**
 * 激活：注册 prefix 路由，effect disposer 负责摘除。
 * @param raw - cordis 根上下文（以 `ctx` 单例视角经 inject 保证三服务在场）。
 */
export function apply(raw: unknown): void {
  const context = raw as unknown as BrowserContext
  // sessionId → root：活跃会话读 SessionStore 内存头；冷会话（未被 attach）
  // 只在落盘 header 索引里——desktop 打开侧栏时未attach 的历史会话是常态，
  // 必须兜底，否则文件页对历史会话整树 404。
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
  const handler = createFsHandler({ resolveRoot })
  context.webServer.register({ kind: 'prefix', path: FS_ROUTE_PREFIX, handler })
}
