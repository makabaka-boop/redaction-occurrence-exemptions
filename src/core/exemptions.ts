/**
 * 单次豁免簿（per-entry 起始位置集合）及其生命周期。
 *
 * 语义（务必先阅读 README「单次豁免」一节）：
 * - 一次豁免只放过**一条启用短语在原文中一个起始代码单元上的完整命中**，
 *   绝不放过同词的其他位置，也不抹掉其他短语在同一区域造成的遮蔽。
 * - 豁免在加入前必须核实“该起始位置确为同一行内的完整命中”（短语不含
 *   换行，定长子串逐代码单元相等即蕴含同线内完整命中，不可能跨换行）。
 * - 豁免数量有限：单条短语 ≤ LIMITS.maxExemptionsPerEntry，工作集总数
 *   ≤ LIMITS.maxExemptionsTotal；越界抛 LIMITS_EXCEEDED。
 * - 修改、停用、删除对应短语时，其持有的豁免随之失效并被清理；载入新
 *   文本时全部清空；采纳则固化当时的豁免（与遮蔽结果成套）。
 *
 * 存储：与 PatternEntry 数组一一对应的 number[][]，每个内层数组为该条目
 * 的豁免起始位置，按升序保存、互不重复。规模有界（≤ 10,000 个数字），
 * 绝不按全文命中数展开。
 */

import {
  INVALID_PATTERN,
  INVALID_POSITION,
  LIMITS,
  LIMITS_EXCEEDED,
  MaskError,
  type PatternEntry,
} from './masker'

/** 与 PatternEntry[] 一一对应的豁免簿：第 i 项是条目 i 的豁免起始位置升序表 */
export type ExemptionMap = readonly (readonly number[])[]

/** 与新工作集等长、全部为空豁免槽的豁免簿 */
export function emptyExemptions(count: number): number[][] {
  return Array.from({ length: count }, () => [])
}

/** 深拷贝豁免簿（采纳固化 / 放弃回滚基线使用） */
export function cloneExemptions(map: ExemptionMap): number[][] {
  return map.map((slots) => slots.slice())
}

/** 两个豁免簿是否逐槽位相同（脏检查用） */
export function sameExemptions(a: ExemptionMap, b: ExemptionMap): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.length !== y.length) return false
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false
  }
  return true
}

/** 工作集豁免总数 */
export function totalExemptions(map: ExemptionMap): number {
  let n = 0
  for (const slots of map) n += slots.length
  return n
}

/**
 * 核实 start 是 text 中第 index 条（必须启用）短语的同一行内完整命中起点。
 * 失败一律抛 INVALID_POSITION（index 越界属 INVALID_PATTERN，沿用条目
 * 下标语义）。短语只含可打印 ASCII（无换行），定长子串相等即保证命中不
 * 跨换行：任何含换行的拼串都不可能与短语相等。
 */
export function assertHitAt(
  text: string,
  entries: readonly PatternEntry[],
  index: number,
  start: number,
): void {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new MaskError(INVALID_PATTERN)
  }
  const entry = entries[index]
  if (!entry.enabled) {
    // 停用短语不参与匹配，不可能存在“有效命中”可豁免
    throw new MaskError(INVALID_POSITION)
  }
  if (!Number.isInteger(start) || start < 0 || start + entry.value.length > text.length) {
    throw new MaskError(INVALID_POSITION)
  }
  for (let j = 0; j < entry.value.length; j++) {
    if (text.charCodeAt(start + j) !== entry.value.charCodeAt(j)) {
      throw new MaskError(INVALID_POSITION)
    }
  }
}

/**
 * 为第 index 条启用短语在 start 处加入一次单次豁免。
 * - index 越界 → INVALID_PATTERN；
 * - start 非整数 / 越界 / 跨换行 / 该处不是完整命中 / 条目停用
 *   → INVALID_POSITION；
 * - 单条超过 100 或全局超过 10,000 → LIMITS_EXCEEDED；
 * - 同一 (条目, start) 已豁免：幂等无变化（不重复计数）。
 * 返回新的豁免簿（不可变更新）。
 */
export function addEntryExemption(
  text: string,
  entries: readonly PatternEntry[],
  map: ExemptionMap,
  index: number,
  start: number,
): number[][] {
  assertHitAt(text, entries, index, start)
  const slots = map[index]
  // 升序表上的二分定位 + 重复幂等
  let lo = 0
  let hi = slots.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (slots[mid] < start) lo = mid + 1
    else hi = mid
  }
  if (lo < slots.length && slots[lo] === start) {
    // 已是同一豁免：幂等无变化。必须先于上界检查——在已达上界的簿上
    // 重复豁免同一命中不应被误报为越界（重复不占新名额）。
    return map.map((s) => s.slice())
  }
  if (slots.length >= LIMITS.maxExemptionsPerEntry) {
    throw new MaskError(LIMITS_EXCEEDED)
  }
  if (totalExemptions(map) >= LIMITS.maxExemptionsTotal) {
    throw new MaskError(LIMITS_EXCEEDED)
  }
  const next = map.map((s) => s.slice())
  const newSlots = next[index].slice()
  newSlots.splice(lo, 0, start)
  next[index] = newSlots
  return next
}

/**
 * 撤销第 index 条短语在 start 处的单次豁免。不存在（含 index 越界、该处
 * 本无豁免）是幂等无变化；index 越界仍按条目下标语义抛 INVALID_PATTERN。
 */
export function removeEntryExemption(
  map: ExemptionMap,
  index: number,
  start: number,
): number[][] {
  if (!Number.isInteger(index) || index < 0 || index >= map.length) {
    throw new MaskError(INVALID_PATTERN)
  }
  const slots = map[index]
  if (!slots.includes(start)) {
    return map.map((s) => s.slice())
  }
  const next = map.map((s) => s.slice())
  next[index] = slots.filter((x) => x !== start)
  return next
}

/** 清空第 index 条短语的全部豁免（停用时调用）。 */
export function clearEntryExemptions(map: ExemptionMap, index: number): number[][] {
  const next = map.map((s) => s.slice())
  next[index] = []
  return next
}

/** 在末尾追加一个空豁免槽（新增短语时）。 */
export function appendExemptionSlot(map: ExemptionMap): number[][] {
  return [...map.map((s) => s.slice()), []]
}

/** 删除第 index 条短语的整个豁免槽（删除短语时；其豁免随之失效）。 */
export function removeExemptionSlot(map: ExemptionMap, index: number): number[][] {
  return map.filter((_, i) => i !== index).map((s) => s.slice())
}
