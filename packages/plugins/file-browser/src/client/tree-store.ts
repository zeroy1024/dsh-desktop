/**
 * 文件树状态模型（纯函数层，可脱离 React 单测）。
 *
 * 状态形状：`dirs` 记录「已加载过的目录」（relPath → 目录状态），未加载的
 * 目录不在表内——展开动作先置 loading 再异步填充，这就是懒加载的事实来源；
 * `expanded` 记录用户的展开集。渲染行序列由 flattenTree 推导（O(已见节点)；
 * 面板宽度下万级条目可接受）。relPath 是 POSIX 风格相对会话根的路径，'' 即根。
 *
 * 筛选语义（第一档）：只作用于已加载且已展开的层——名字命中的行保留，目录
 * 行在「自身命中」或「任一（展开的）后代命中」时保留；不主动拉取未加载层。
 */
import type { FsEntry, FsErrorCode } from './api.ts'

/** 目录加载状态机：未出现在 dirs 表 = 从未加载。 */
export interface DirState {
  status: 'loading' | 'ready' | 'error'
  entries?: FsEntry[]
  truncated?: boolean
  error?: FsErrorCode
}

export interface TreeState {
  /** '' 为会话根；键为 relPath。 */
  dirs: ReadonlyMap<string, DirState>
  /** 展开的目录 relPath 集（根恒展开，不在集内也无妨——渲染硬编码）。 */
  expanded: ReadonlySet<string>
}

export const emptyTree: TreeState = { dirs: new Map(), expanded: new Set() }

/** 渲染行：flattenTree 的产物，FileTree 按固定行高虚拟化。 */
export interface TreeRow {
  /** relPath（key 唯一性来源）。 */
  key: string
  name: string
  kind: 'dir' | 'file'
  depth: number
  /** dir 行：当前是否展开。 */
  expanded: boolean
  /** dir 行：子级加载状态（未加载过 = 'idle'，chevron 不显 spinner）。 */
  status?: 'idle' | DirState['status']
  /** dir 行：子级列表被服务端截断（仅展开层可见）。 */
  truncated?: boolean
  /** 该行为「截断提示行」（紧随被截断目录的子级末尾，渲染弱化）。 */
  isTruncatedNote?: boolean
}

/** 大小写不敏感子串匹配；空筛选恒真。 */
function nameMatches(name: string, filter: string): boolean {
  return filter === '' || name.toLowerCase().includes(filter)
}

/**
 * 深度优先展平为行序列。filter 非空时按 keep 判据自底向上收集：
 * keep(entry) = 自身命中 ||（目录且展开且任一后代 keep）。未展开的目录无法
 * 展示命中后代（懒加载现实），其自身命中即可。
 */
export function flattenTree(state: TreeState, filter: string): TreeRow[] {
  const rows: TreeRow[] = []

  /** 收集 dirRel 的子级行；返回是否有行被保留（keep）。 */
  const walkChildren = (dirRel: string, depth: number, out: TreeRow[]): boolean => {
    const dir = state.dirs.get(dirRel)
    if (dir === undefined || dir.entries === undefined) return false
    let anyKeep = false
    for (const entry of dir.entries) {
      const selfHit = nameMatches(entry.name, filter)
      if (entry.kind === 'dir') {
        const expanded = state.expanded.has(entry.relPath)
        const nested: TreeRow[] = []
        // 先递归探子树（命中的孙行进 nested），再决定本目录行去留。
        const childKeep = expanded && walkChildren(entry.relPath, depth + 1, nested)
        if (selfHit || childKeep) {
          anyKeep = true
          const childDir = state.dirs.get(entry.relPath)
          out.push({
            key: entry.relPath, name: entry.name, kind: 'dir', depth: depth + 1, expanded,
            status: childDir?.status ?? 'idle', truncated: childDir?.truncated,
          })
          out.push(...nested)
          // 展开且被服务端截断的目录：子级末尾挂一条提示行（虚拟化下的真实行）。
          if (expanded && childDir?.truncated === true) {
            out.push({ key: `${entry.relPath}\0trunc`, name: '', kind: 'dir', depth: depth + 2, expanded: false, isTruncatedNote: true })
          }
        }
      } else if (selfHit) {
        anyKeep = true
        out.push({ key: entry.relPath, name: entry.name, kind: 'file', depth: depth + 1, expanded: false })
      }
    }
    return anyKeep
  }

  const root = state.dirs.get('')
  // 根行恒在：加载/错误/空筛选都以它为锚（筛选无命中时 FileTree 出空提示）。
  rows.push({ key: '', name: '', kind: 'dir', depth: 0, expanded: true, status: root?.status ?? 'loading', truncated: root?.truncated })
  const anyKept = walkChildren('', 0, rows)
  if (root?.truncated === true && (filter === '' || anyKept)) {
    rows.push({ key: '\0trunc', name: '', kind: 'dir', depth: 1, expanded: false, isTruncatedNote: true })
  }
  return rows
}

/** 展开/收起目录（'' 恒展开，调用方不应对根调用）。 */
export function withExpanded(state: TreeState, relPath: string, on: boolean): TreeState {
  const expanded = new Set(state.expanded)
  if (on) expanded.add(relPath)
  else expanded.delete(relPath)
  return { dirs: state.dirs, expanded }
}

/** 写目录状态；undefined 删除（重拉时回退成未加载态）。 */
export function withDirState(state: TreeState, relPath: string, dir: DirState | undefined): TreeState {
  const dirs = new Map(state.dirs)
  if (dir === undefined) dirs.delete(relPath)
  else dirs.set(relPath, dir)
  return { dirs, expanded: state.expanded }
}

/** 已加载过的目录集（联动刷新的重拉对象）。 */
export function loadedPaths(state: TreeState): string[] {
  return [...state.dirs.keys()]
}

/** 路径的祖先目录链（不含自身，根 '' 恒含于尾）；用于 reveal 展开与面包屑。 */
export function ancestorsOf(relPath: string): string[] {
  const out: string[] = []
  let at = relPath.lastIndexOf('/')
  while (at >= 0) {
    out.push(relPath.slice(0, at))
    at = relPath.lastIndexOf('/', at - 1)
  }
  out.push('')
  return out
}

/** 确保 relPath 的全部祖先在展开集（reveal 定位用）。 */
export function withAncestorsExpanded(state: TreeState, relPath: string): TreeState {
  let next = state
  for (const dir of ancestorsOf(relPath)) {
    if (dir !== '') next = withExpanded(next, dir, true)
  }
  return next
}

/** 读目录错误码（FileTree 行内提示用）。 */
export function dirError(state: TreeState, relPath: string): FsErrorCode | undefined {
  return state.dirs.get(relPath)?.error
}

/** 选择模式：单击替换 / ⌘(⌃) 切换 / ⇧ 范围（与 Finder 语义一致）。 */
export type SelectMode = 'replace' | 'toggle' | 'range'

/**
 * 计算一次行点击后的选集（纯函数，便于单测）。
 * @param rows 展平行序列（范围选择按序）。
 * @param selection 当前选集。
 * @param anchorKey 上次单点/切换的锚（范围选以它为端点）；不在 rows 内则忽略锚。
 * @param key 被点击的行 key。
 * @param mode 点击模式。
 * @returns 新选集与新锚（range 不挪锚——连续 ⇧ 扩缩容都相对同一锚）。
 */
export function applySelection(
  rows: readonly TreeRow[],
  selection: ReadonlySet<string>,
  anchorKey: string | null,
  key: string,
  mode: SelectMode,
): { selection: Set<string>; anchor: string | null } {
  const index = rows.findIndex(row => row.key === key)
  if (index < 0) return { selection: new Set(selection), anchor: anchorKey }
  if (mode === 'replace') return { selection: new Set([key]), anchor: key }
  if (mode === 'toggle') {
    const next = new Set(selection)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return { selection: next, anchor: key }
  }
  // range：锚到目标的闭区间；无锚退化为单选。
  const anchorIndex = anchorKey === null ? -1 : rows.findIndex(row => row.key === anchorKey)
  if (anchorIndex < 0) return { selection: new Set([key]), anchor: key }
  const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex]
  return { selection: new Set(rows.slice(from, to + 1).map(row => row.key)), anchor: anchorKey }
}
