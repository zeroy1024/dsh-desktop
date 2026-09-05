/**
 * 浏览器客户端插件：以更低的 shadow priority 接管官方 model seat，
 * 但不复制官方目录/连接状态；官方 ui-model-selection 继续保持启用并
 * 在本注册项卸载或崩溃后自动成为 seat fallback。
 */
import type { ClientContext, ModelSelectionScope } from './types.ts'
import { ModelSelect } from './ModelSelect.tsx'
import { en, NS, zh } from './locales.ts'

/** locale 与 slots 是本插件装配时的根依赖；modelDirectories 通过 ctx.inject 等待官方服务。 */
export const inject = ['locale', 'slots']

/**
 * 注册本插件词典，并在 conversation.input.model 的声明出现时安装 shadow。
 * `ctx.inject` 让官方目录服务可以晚于本插件启动，仍能随服务生命周期装配。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-selection-direct: dictionaries')

  // Cordis 服务方法沿调用方作用域执行；directoryFor 首次建目录会读取
  // remote.session，必须声明它，否则 seat 崩溃并静默回退到官方菜单。
  ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'], (scope: ModelSelectionScope) => {
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      // 官方 ui-model-selection 使用默认 priority 0；更低者胜出，官方仍是 fallback。
      priority: -1,
      locale: NS,
      inject: (sessionId) => {
        const directory = scope.modelDirectories.directoryFor(sessionId)
        const available = scope.sessions.subagentAddress(sessionId) === undefined

        return {
          available,
          hooks: { modelDirectory: directory.store },
          load: () => {
            if (available) void directory.load().catch(() => { /* store carries the error */ })
          },
          getError: () => directory.store.getSnapshot().error,
          select: (selection) => available
            ? directory.select(selection).then(() => true, () => false)
            : Promise.resolve(false),
        }
      },
    }, ModelSelect))
  })
}
