import { describe, expect, it } from 'vitest'
import {
  BUFFER,
  ROW_HEIGHT,
  VISIBLE_COUNT,
  filterEntries,
  windowStart,
} from './patternList'
import type { PatternEntry } from './masker'

/** 生成 p000..pNNN 共 count 条启用条目 */
function makeEntries(count: number): PatternEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    value: `p${String(i).padStart(3, '0')}`,
    enabled: true,
  }))
}

describe('筛选作用于全集而非渲染窗口', () => {
  it('列表停在顶部时，命中窗口外唯一短语的筛选必须能找到它', () => {
    // 回归：先 slice 窗口再 filter 时，p079 在顶部窗口之外，结果为零条
    const entries = makeEntries(80)
    const first = windowStart(0, entries.length)
    const window = entries.slice(first, first + VISIBLE_COUNT)
    expect(window.some((e) => e.value === 'p079')).toBe(false) // 确认 p079 在窗口外

    const filtered = filterEntries(entries, 'p079')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].entry.value).toBe('p079')
    expect(filtered[0].index).toBe(79)
  })

  it('空筛选返回全部条目且下标即原始位置', () => {
    const filtered = filterEntries(makeEntries(80), '')
    expect(filtered).toHaveLength(80)
    expect(filtered[10].index).toBe(10)
  })
})

describe('筛选后的下标映射', () => {
  it('筛到只剩 p010 时，结果携带原始下标 10 而非显示序号 0', () => {
    // 回归：用显示序号 first+k 提交会把对 p010 的增改/启停/删除落到 p000 上
    const filtered = filterEntries(makeEntries(80), 'p010')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].index).toBe(10)
  })

  it('多条命中各自保留原始下标（区分大小写）', () => {
    const entries: PatternEntry[] = [
      { value: 'FooBar', enabled: true },
      { value: 'baz', enabled: false },
      { value: 'barista', enabled: true },
    ]
    // 大写 B 只命中 FooBar；小写 ba 命中 baz 与 barista；BA 不命中任何条目
    expect(filterEntries(entries, 'B').map((r) => r.index)).toEqual([0])
    expect(filterEntries(entries, 'ba').map((r) => r.index)).toEqual([1, 2])
    expect(filterEntries(entries, 'BA')).toHaveLength(0)
  })
})

describe('窗口起点收敛', () => {
  it('顶部为 0，中部含上缓冲', () => {
    expect(windowStart(0, 80)).toBe(0)
    const row = 30
    expect(windowStart(row * ROW_HEIGHT, 80)).toBe(row - BUFFER)
  })

  it('列表变短（删除/筛选）导致 scrollTop 越界时收敛到末尾，不产生空窗', () => {
    const entries = makeEntries(80)
    const deepScroll = 80 * ROW_HEIGHT // 原本滚到底的滚动量
    // 全集：起点收敛，窗口顶到最后一行
    expect(windowStart(deepScroll, entries.length)).toBe(80 - VISIBLE_COUNT)
    // 筛选后只剩 1 条：起点收敛为 0，这唯一一条必然被渲染
    const filtered = filterEntries(entries, 'p010')
    const first = windowStart(deepScroll, filtered.length)
    expect(first).toBe(0)
    expect(filtered.slice(first, first + VISIBLE_COUNT)).toHaveLength(1)
  })

  it('总数不足一屏时起点恒为 0', () => {
    expect(windowStart(9999, 3)).toBe(0)
  })
})
