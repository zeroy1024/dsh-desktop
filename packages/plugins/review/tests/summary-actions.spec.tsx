// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SummaryActions } from '../src/client/SummaryActions.tsx'

afterEach(cleanup)
it('keeps refresh direct and preserves sorting and reviewed actions in the menu', () => {
  const onSort = vi.fn(), onToggleReviewed = vi.fn(), onRefresh = vi.fn()
  const props = { sortMode: 'changes' as const, allReviewed: false, onSort, onToggleReviewed, onRefresh, t: (key: string) => key }
  const view = render(<SummaryActions {...props} />)
  expect(screen.getAllByRole('button')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'action.refresh' }))
  expect(onRefresh).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'summary.actions' }))
  expect(screen.getByRole('menuitem', { name: '✓ summary.sortByChanges' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'summary.sortByPath' }))
  expect(onSort).toHaveBeenCalledWith('path')
  expect(screen.queryByRole('menu')).toBeNull()
  view.rerender(<SummaryActions {...props} sortMode="path" allReviewed />)
  fireEvent.click(screen.getByRole('button', { name: 'summary.actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'summary.unmarkAll' }))
  expect(onToggleReviewed).toHaveBeenCalledOnce()
})
