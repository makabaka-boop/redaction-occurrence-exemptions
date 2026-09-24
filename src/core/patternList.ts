/**
 * 短语列表的筛选与窗口化（纯逻辑，供页面渲染与回归测试共用）。
 *
 * 不变式：
 * - 筛选作用于**完整**条目集，而不是当前渲染窗口；否则窗口之外
 *   唯一匹配的条目会显示为零结果，无法被定位和管理。
 * - 每条结果都携带其在原数组中的**原始下标**；增改、启停、删除
 *   一律按原始下标提交，绝不使用筛选/窗口内的显示序号。
 */

import type { PatternEntry } from './masker'

/** 行高（px）、视口高（px）与上下各缓冲的行数 */
export const ROW_HEIGHT = 34
export const VIEW_HEIGHT = 360
export const BUFFER = 8

/** 一次渲染的行数（视口行数 + 上下缓冲） */
export const VISIBLE_COUNT = Math.ceil(VIEW_HEIGHT / ROW_HEIGHT) + 2 * BUFFER

/** 带原始下标的条目：index 始终是其在完整 entries 数组中的位置 */
export interface IndexedEntry {
  entry: PatternEntry
  index: number
}

/**
 * 对全集做子串筛选（区分大小写，与界面约定一致），结果保留原始下标。
 * filter 为空串时返回全部条目。
 */
export function filterEntries(
  entries: readonly PatternEntry[],
  filter: string,
): IndexedEntry[] {
  const indexed = entries.map((entry, index) => ({ entry, index }))
  if (!filter) return indexed
  return indexed.filter(({ entry }) => entry.value.includes(filter))
}

/**
 * 由滚动位置计算窗口起点（含上缓冲），并收敛到合法范围：
 * 删除或筛选使列表变短、scrollTop 越界时，窗口不会越过末尾产生空窗。
 */
export function windowStart(scrollTop: number, total: number): number {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER)
  return Math.min(first, Math.max(0, total - VISIBLE_COUNT))
}
