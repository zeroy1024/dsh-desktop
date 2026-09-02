import { describe, expect, it } from 'vitest'
import {
  absoluteFilePath, createFileOpenMailbox, FILE_OPEN_MAILBOX_MAX, isExternalFilePath,
  toWorkspaceRelativePath,
} from '../src/client/file-open.ts'

const input = (path: string, id?: string) => ({
  id,
  sessionId: 'session-1',
  cwd: '/repo',
  path,
  relPath: path,
})

describe('toWorkspaceRelativePath', () => {
  it('accepts safe relative paths and absolute paths inside the workspace', () => {
    expect(toWorkspaceRelativePath('src/app.ts', '/repo')).toBe('src/app.ts')
    expect(toWorkspaceRelativePath('/repo/src/app.ts', '/repo')).toBe('src/app.ts')
    expect(toWorkspaceRelativePath('/repo/src/app.ts', '/repo/')).toBe('src/app.ts')
    expect(toWorkspaceRelativePath('/repo/a', '/')).toBe('repo/a')
  })

  it('enforces the workspace boundary by path component', () => {
    expect(toWorkspaceRelativePath('/repo2/secret.txt', '/repo')).toBeUndefined()
    expect(toWorkspaceRelativePath('/other/repo/file.txt', '/repo')).toBeUndefined()
    expect(toWorkspaceRelativePath('/repo', '/repo')).toBeUndefined()
  })

  it('rejects empty, dot, traversal, malformed, and platform-specific paths', () => {
    const bad = ['', '.', './src/a.ts', 'src/./a.ts', '../secret', 'src/../secret',
      'src//a.ts', 'src/a.ts/', 'src\\a.ts', 'src\0a.ts', 'C:/repo/a.ts',
      'C:repo/a.ts', '//server/share/a.ts']
    for (const path of bad) expect(toWorkspaceRelativePath(path, '/repo')).toBeUndefined()

    for (const cwd of ['', 'repo', 'C:/repo', '\\\\server\\share', '//server/share', '/repo/./sub', '/repo/../sub']) {
      expect(toWorkspaceRelativePath('file.txt', cwd)).toBeUndefined()
    }
  })
})

describe('absoluteFilePath / isExternalFilePath', () => {
  it('normalizes absolute forms to a slash-separated canonical path', () => {
    expect(absoluteFilePath('/Users/z/.dsh/settings.yaml')).toBe('/Users/z/.dsh/settings.yaml')
    expect(absoluteFilePath('//repo//a//b.ts')).toBe('//repo/a/b.ts')
    expect(absoluteFilePath('C:\\Users\\z\\n.txt')).toBe('C:/Users/z/n.txt')
    expect(absoluteFilePath('C:/Users/z/n.txt')).toBe('C:/Users/z/n.txt')
    expect(absoluteFilePath('\\\\srv\\share\\f.txt')).toBe('//srv/share/f.txt')
  })

  it('rejects relative, traversal, and malformed forms', () => {
    const bad = ['', '.', './a', 'rel/file.txt', 'src/../secret', 'a/./b',
      'C:relative', 'src\\a.ts', 'a\0b', '/a/../b', '/a/./b', '..']
    for (const path of bad) expect(absoluteFilePath(path)).toBeUndefined()
  })

  it('domain test: external keys are disjoint from workspace relPaths', () => {
    // 工作区 relPath 的合法域（toWorkspaceRelativePath 的输出）永远不是外部键。
    for (const rel of ['a.ts', 'src/app.ts', 'a/b/c.md']) {
      expect(isExternalFilePath(rel)).toBe(false)
      expect(toWorkspaceRelativePath(rel, '/repo')).toBe(rel)
    }
    expect(isExternalFilePath('/etc/hosts')).toBe(true)
    expect(isExternalFilePath('C:/x')).toBe(true)
    expect(isExternalFilePath('')).toBe(false)
  })
})

describe('FileOpenMailbox', () => {
  it('is observable, keeps snapshots stable, and acknowledges by id', () => {
    const mailbox = createFileOpenMailbox({ idFactory: () => 'request' })
    let notifications = 0
    const unsubscribe = mailbox.subscribe(() => { notifications += 1 })
    const initial = mailbox.getSnapshot()
    const first = mailbox.enqueue(input('a.txt'))
    const afterEnqueue = mailbox.getSnapshot()

    expect(afterEnqueue).not.toBe(initial)
    expect(afterEnqueue).toEqual([first])
    expect(mailbox.ack(first.id)).toBe(true)
    expect(mailbox.getSnapshot()).toEqual([])
    expect(mailbox.ack(first.id)).toBe(false)
    expect(notifications).toBe(2)

    unsubscribe()
    mailbox.enqueue(input('b.txt'))
    expect(notifications).toBe(2)
  })

  it('does not coalesce repeated paths and assigns independent ids', () => {
    const mailbox = createFileOpenMailbox({ idFactory: () => 'same' })
    const first = mailbox.enqueue(input('same.txt'))
    const second = mailbox.enqueue(input('same.txt'))
    expect(second.id).not.toBe(first.id)
    expect(mailbox.getSnapshot().map(request => request.path)).toEqual(['same.txt', 'same.txt'])
  })

  it('retains the newest 32 requests and drops the oldest in FIFO order', () => {
    const mailbox = createFileOpenMailbox({ idFactory: () => '' })
    for (let index = 0; index < FILE_OPEN_MAILBOX_MAX + 3; index += 1) {
      mailbox.enqueue(input(`file-${index}.txt`))
    }
    expect(mailbox.getSnapshot().map(request => request.path)).toEqual(
      Array.from({ length: FILE_OPEN_MAILBOX_MAX }, (_, index) => `file-${index + 3}.txt`),
    )
  })

  it('drains all pending requests once and emits one change', () => {
    const mailbox = createFileOpenMailbox({ idFactory: () => 'request' })
    let notifications = 0
    mailbox.subscribe(() => { notifications += 1 })
    const first = mailbox.enqueue(input('a.txt'))
    const second = mailbox.enqueue(input('b.txt'))
    notifications = 0

    expect(mailbox.drain()).toEqual([first, second])
    expect(mailbox.getSnapshot()).toEqual([])
    expect(notifications).toBe(1)
    expect(mailbox.drain()).toEqual([])
    expect(notifications).toBe(1)
  })
})
