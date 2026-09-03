/**
 * orphan-reaper.ts — 主进程被强杀后残留的 dsh agent 收割：启动时读 pid 文件，核身进程命令行后整组终止。
 *
 * before-quit 在 SIGKILL/崩溃下不执行，而 supervisor 以 detached 拉起子进程
 * 反而保证它独活：残留的 dsh web 继续持有 ~/.dsh 与 API key。这里用
 * 「pid 文件 + 下次启动收割」兜底。pid 会被系统复用，发信号前必须核对
 * 进程命令行确为 dsh CLI 入口——核身失败宁可不杀。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/** pid 文件内容：agent 子进程 pid + 启动它的 CLI 入口绝对路径（收割核身用）。 */
export interface AgentPidRecord {
  pid: number
  cliEntry: string
}

/** 读取 pid 文件；文件缺失、坏 JSON 或字段非法一律视为无记录。 */
export function readAgentPidRecord(path: string): AgentPidRecord | null {
  try {
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { pid, cliEntry } = parsed as Partial<AgentPidRecord>
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    if (typeof cliEntry !== 'string' || cliEntry.length === 0) return null
    return { pid, cliEntry }
  } catch {
    return null
  }
}

/** 原子写 pid 文件（temp + rename，与 window-state.ts 同一写法）。 */
export function writeAgentPidRecord(path: string, record: AgentPidRecord): void {
  const temporary = `${path}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    // 写盘失败只意味着下次启动无法收割，不能阻断 agent 启动
    console.warn('[agent] 写入 agent pid 文件失败', error)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** 删除 pid 文件；仅当文件内 pid 匹配才删，避免误删新一代 agent 刚写入的记录。 */
export function removeAgentPidRecord(path: string, pid: number): void {
  try {
    const record = readAgentPidRecord(path)
    if (record === null || record.pid !== pid) return
    rmSync(path, { force: true })
  } catch {
    // 删除失败只留下陈旧记录，下次启动收割时核身会兜底
  }
}

/** reapOrphanedAgent 的外部依赖，全部注入便于单测。 */
export interface ReapDeps {
  /** 返回进程完整命令行；进程不存在或无法探测时返回 null。 */
  probeCmdline: (pid: number) => Promise<string | null>
  /** 结束进程；group=true 时 POSIX 下对整组（负 pid）发信号。 */
  kill: (pid: number, group: boolean, sig: 'SIGTERM' | 'SIGKILL') => void
  sleep: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

/** SIGTERM 后的探活间隔与总预算：agent 正常退出是亚秒级，2s 足够。 */
const TERM_POLL_MS = 200
const TERM_TIMEOUT_MS = 2_000

/**
 * 收割上一代残留的 agent。
 *
 * @returns 'none' 无记录或进程已自行退出；'reaped' 已整组终止；
 *          'skipped' pid 被复用或探测异常——核身失败宁可不杀。
 */
export async function reapOrphanedAgent(
  pidPath: string,
  cliEntry: string,
  deps: ReapDeps,
): Promise<'none' | 'reaped' | 'skipped'> {
  const record = readAgentPidRecord(pidPath)
  if (record === null) return 'none'
  try {
    const cmdline = await deps.probeCmdline(record.pid)
    if (cmdline === null) {
      removeAgentPidRecord(pidPath, record.pid)
      return 'none'
    }
    if (!cmdline.includes(cliEntry)) {
      deps.log?.(`[agent] pid ${record.pid} 命令行不含 dsh CLI 入口，pid 已被复用，不收割`)
      removeAgentPidRecord(pidPath, record.pid)
      return 'skipped'
    }
    deps.kill(record.pid, true, 'SIGTERM')
    let waited = 0
    while (waited < TERM_TIMEOUT_MS) {
      await deps.sleep(TERM_POLL_MS)
      waited += TERM_POLL_MS
      if ((await deps.probeCmdline(record.pid)) === null) {
        removeAgentPidRecord(pidPath, record.pid)
        return 'reaped'
      }
    }
    deps.kill(record.pid, true, 'SIGKILL')
    removeAgentPidRecord(pidPath, record.pid)
    return 'reaped'
  } catch (error) {
    deps.log?.(`[agent] 收割残留 agent 失败（pid=${record.pid}）：${error instanceof Error ? error.message : String(error)}`)
    return 'skipped'
  }
}

/** 进程是否存活：kill(pid, 0) 的 ESRCH 表示已死，EPERM 表示活着但无权发信号。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 取进程命令行；命令失败、超时（5s）或输出为空一律返回 null（按已死处理）。 */
function probeCmdlineVia(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000 }, (error, stdout) => {
      if (error !== null) {
        resolve(null)
        return
      }
      const cmdline = stdout.trim()
      resolve(cmdline.length > 0 ? cmdline : null)
    })
  })
}

/** 生产实现：ps/powershell 取命令行核身，process.kill 整组发信号。 */
export function defaultReapDeps(): ReapDeps {
  return {
    probeCmdline: (pid) => {
      if (!isProcessAlive(pid)) return Promise.resolve(null)
      return process.platform === 'win32'
        ? probeCmdlineVia('powershell', [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
          ])
        : probeCmdlineVia('ps', ['-o', 'args=', '-p', String(pid)])
    },
    kill: (pid, group, sig) => {
      try {
        // detached 子进程自成进程组，负 pid 整组发信号（与 supervisor.signal 同理）
        if (group && process.platform !== 'win32') process.kill(-pid, sig)
        else process.kill(pid, sig)
      } catch (error) {
        // 进程刚好已退出时 kill 抛 ESRCH，忽略；其余错误上交调用方按核身失败处理
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (msg) => {
      console.warn(msg)
    },
  }
}
