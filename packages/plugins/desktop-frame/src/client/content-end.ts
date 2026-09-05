/** Measure the actual button/menu cluster, including locale and collapsed-state changes. */
export function observeContentEnd(
  container: HTMLElement,
  geometry: { current: { contentEnd: number } },
  apply: () => void,
): () => void {
  const selector = '[data-dsh-menubar], [data-dsh-cluster-button]'
  const observed = new Set<Element>()
  let raf = 0
  const measure = (): void => {
    raf = 0
    const origin = container.getBoundingClientRect().left
    let end = 0
    for (const node of container.querySelectorAll<HTMLElement>(selector)) {
      end = Math.max(end, node.getBoundingClientRect().right - origin)
    }
    if (end === geometry.current.contentEnd) return
    geometry.current.contentEnd = end
    document.documentElement.style.setProperty('--dsh-titleband-content-end', `${Math.round(end)}px`)
    apply()
  }
  const schedule = (): void => {
    if (raf === 0) raf = requestAnimationFrame(measure)
  }
  const ro = new ResizeObserver(schedule)
  const observeChildren = (): void => {
    const children = new Set<Element>([container, ...container.querySelectorAll(selector)])
    for (const node of observed) {
      if (!children.has(node)) { ro.unobserve(node); observed.delete(node) }
    }
    for (const node of children) {
      if (!observed.has(node)) { ro.observe(node); observed.add(node) }
    }
    schedule()
  }
  // Buttons can appear after the first mount without resizing their parent.
  const mutations = new MutationObserver(observeChildren)
  mutations.observe(container, { subtree: true, childList: true, characterData: true })
  observeChildren()
  if (raf !== 0) { cancelAnimationFrame(raf); raf = 0 }
  measure()
  return () => {
    if (raf !== 0) cancelAnimationFrame(raf)
    mutations.disconnect()
    ro.disconnect()
    document.documentElement.style.removeProperty('--dsh-titleband-content-end')
  }
}
