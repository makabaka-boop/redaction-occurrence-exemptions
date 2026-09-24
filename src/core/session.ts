/**
 * 会话编排：把「工作短语集 + 单次豁免簿 + 从同一原文的重算结果」作为一个
 * 整体原子提交。
 *
 * 不变式：
 * - 载入合法文件，或任何增改 / 启停 / 删除 / 豁免增减，都从**同一原文**
 *   与候选工作集、候选豁免簿重新构建自动机并一次性产出遮蔽预览与每条启用
 *   短语的有效匹配次数；计数与启用短语同序，预览与计数来自同一次重算，
 *   绝不增量修补。
 * - 单次豁免只放过“某条启用短语在某起始代码单元上的这一个完整命中”：
 *   加入前核实该处确为同线内完整命中；预览、覆盖字符数与每条短语的有效
 *   命中次数全部从同一工作集（原文 + 启用短语 + 豁免簿）重算。豁免不抹
 *   掉其他短语在同一区域的遮蔽。
 * - 修改 / 停用 / 删除对应短语时清理其持有的豁免；载入新文本清空全部
 *   豁免；采纳固化当时的豁免与遮蔽结果。
 * - 导入与所有编辑成功后的工作集始终遵守**同一组聚合约束**（数量
 *   1..50,000、总长 ≤ 300,000），豁免数量亦受每条 / 全局上界约束：
 *   候选在重算之前先过闸门，越界动作只抛 LIMITS_EXCEEDED 拒绝当前动作，
 *   绝不重建自动机、绝不提交候选快照。
 * - 重算以候选快照提交：先对候选工作集完成全部计算，成功后才替换当前快照；
 *   自动机构建、遮蔽或计数阶段抛出任何异常，都转换为 COUNT_FAILED 抛出，
 *   并保留上一次成功的工作集、豁免、预览、计数与已采纳稿（由调用方不替换
 *   Snapshot 实现）。
 * - “采纳”只固化当时的下载稿（遮蔽字符串）、短语快照与豁免簿；此后再
 *   调整短语或豁免触发的重算只产生新的预览/计数，不会改变已采纳稿。
 */

import {
  COUNT_FAILED,
  LIMITS_EXCEEDED,
  MaskError,
  addEntry,
  assertWorksetLimits,
  maskText,
  parseInput,
  removeEntry,
  toggleEntry,
  updateEntry,
  type ExemptionHit,
  type MaskResult,
  type PatternEntry,
} from './masker'
import {
  addEntryExemption,
  appendExemptionSlot,
  clearEntryExemptions,
  cloneExemptions,
  emptyExemptions,
  removeEntryExemption,
  removeExemptionSlot,
  type ExemptionMap,
} from './exemptions'

export interface Snapshot {
  /** 当前会话原文（载入后不再变化） */
  text: string
  /** 当前工作短语集（最近一次成功重算所对应的集合） */
  entries: PatternEntry[]
  /**
   * 与 entries 一一对应的单次豁免簿（最近一次成功重算所用）。
   * 停用条目的豁免槽恒为空（停用时清理）。
   */
  exemptions: ExemptionMap
  /** 与 entries/exemptions 同一次重算的结果（遮蔽稿 + 每启用短语计数） */
  result: MaskResult
}

/** 载入态原始快照（放弃改动的回滚基线之一） */
export interface LoadedSession {
  text: string
  initial: PatternEntry[]
  /** 载入态豁免簿：恒为全空（载入新文本清空旧豁免） */
  initialExemptions: ExemptionMap
}

/**
 * 把工作集下标上的豁免簿折叠为 maskText 的启用序列豁免列表。
 * 停用条目的豁免槽按不变式恒为空，这里仍做一次防御性跳过。
 */
function toHits(entries: readonly PatternEntry[], exemptions: ExemptionMap): ExemptionHit[] {
  const hits: ExemptionHit[] = []
  let k = 0
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].enabled) {
      k++
      continue
    }
    for (const start of exemptions[i]) hits.push({ pattern: k, start })
    k++
  }
  return hits
}

/**
 * 从原文、候选工作集与候选豁免簿执行一次完整重算。
 * 任何异常（构建 / 遮蔽 / 计数）一律归一为 COUNT_FAILED，调用方据此
 * 保留上一次成功的快照。
 */
export function recompute(
  text: string,
  entries: readonly PatternEntry[],
  exemptions: ExemptionMap = emptyExemptions(entries.length),
): MaskResult {
  const enabled: string[] = []
  for (const e of entries) if (e.enabled) enabled.push(e.value)
  try {
    return maskText(text, enabled, toHits(entries, exemptions))
  } catch (err) {
    if (err instanceof MaskError) throw err
    throw new MaskError(COUNT_FAILED)
  }
}

/**
 * 载入文件：解析校验（非法文件由 parseInput 抛 INVALID_INPUT）成功后，
 * 从载入态工作集做首次重算。载入新文本即新会话：豁免簿全部为空。
 * 重算本身失败抛 COUNT_FAILED，调用方应保留旧会话；只有本函数整体返回
 * 才代表新会话成立。
 */
export function loadSession(jsonText: string): { session: LoadedSession; snapshot: Snapshot } {
  // 先解析：失败直接抛 INVALID_INPUT，绝不触碰任何现有会话状态
  const parsed = parseInput(jsonText)
  const entries = parsed.patterns.map((value) => ({ value, enabled: true }))
  const exemptions = emptyExemptions(entries.length)
  const result = recompute(parsed.text, entries, exemptions)
  return {
    session: {
      text: parsed.text,
      initial: entries.map(cloneEntry),
      initialExemptions: cloneExemptions(exemptions),
    },
    snapshot: { text: parsed.text, entries, exemptions, result },
  }
}

/**
 * 对候选工作集应用一次变更并完成重算，整体作为候选快照返回。
 * mutate 产出候选工作集，mapExemptions 同步把豁免簿变换到候选形状
 * （改值/启停保位清理、追加发空槽、删除整槽）。mutate 抛
 * INVALID_PATTERN（非法值/越界）或 LIMITS_EXCEEDED（聚合约束越界：
 * 数量 1..50,000、总长 ≤ 300,000）时原样向上抛；recompute 抛
 * COUNT_FAILED 时同样向上抛——两种情况下调用方都保留旧快照不变。
 *
 * 聚合约束在**重算之前**有一道集中闸门：任何路径（包括直接传入的泛型
 * mutate）产出的候选工作集，只要数量或总长越界，立即抛 LIMITS_EXCEEDED，
 * 绝不重建自动机、绝不产出快照。导入与所有编辑成功后的工作集因此始终
 * 遵守同一组聚合约束。
 */
export function applyChange(
  snapshot: Snapshot,
  mutate: (entries: readonly PatternEntry[]) => PatternEntry[],
  mapExemptions: (map: ExemptionMap) => ExemptionMap = (m) => m,
): Snapshot {
  // 变更函数都是不可变更新，异常不会部分修改 snapshot
  const entries = mutate(snapshot.entries)
  const exemptions = mapExemptions(snapshot.exemptions)
  let totalLength = 0
  for (const e of entries) totalLength += e.value.length
  assertWorksetLimits(entries.length, totalLength, LIMITS_EXCEEDED)
  const result = recompute(snapshot.text, entries, exemptions)
  return { text: snapshot.text, entries, exemptions, result }
}

export const addPattern = (s: Snapshot, value: string): Snapshot =>
  applyChange(
    s,
    (entries) => addEntry(entries, value),
    (map) => appendExemptionSlot(map),
  )

export const updatePattern = (s: Snapshot, index: number, value: string): Snapshot =>
  // 改值即换词：旧值持有的豁免全部失效并清理（保位槽，内容清空）
  applyChange(
    s,
    (entries) => updateEntry(entries, index, value),
    (map) => clearEntryExemptions(map, index),
  )

export const setPatternEnabled = (s: Snapshot, index: number, enabled: boolean): Snapshot =>
  // 停用时清理该条豁免（停用项不参与匹配，豁免无意义）；重新启用是空簿起步
  applyChange(
    s,
    (entries) => toggleEntry(entries, index, enabled),
    (map) => (enabled ? map : clearEntryExemptions(map, index)),
  )

export const removePattern = (s: Snapshot, index: number): Snapshot =>
  applyChange(
    s,
    (entries) => removeEntry(entries, index),
    (map) => removeExemptionSlot(map, index),
  )

/**
 * 加入一次单次豁免：先在旧工作集上核实“同线内完整命中”与数量上界
 * （重算之前；非法位置抛 INVALID_POSITION、越界抛 LIMITS_EXCEEDED），
 * 再从同一原文与候选豁免簿重算。工作集形状不变（保位）。
 */
export function addExemption(s: Snapshot, index: number, start: number): Snapshot {
  const exemptions = addEntryExemption(s.text, s.entries, s.exemptions, index, start)
  const result = recompute(s.text, s.entries, exemptions)
  return { text: s.text, entries: s.entries, exemptions, result }
}

/** 撤销一次单次豁免（不存在为幂等无变化），随后从同一工作集重算。 */
export function removeExemption(s: Snapshot, index: number, start: number): Snapshot {
  const exemptions = removeEntryExemption(s.exemptions, index, start)
  const result = recompute(s.text, s.entries, exemptions)
  return { text: s.text, entries: s.entries, exemptions, result }
}

/**
 * 采纳：固化当前下载稿、短语快照与豁免簿（深拷贝，之后重算不影响本稿）。
 */
export function adopt(snapshot: Snapshot): {
  masked: string
  entries: PatternEntry[]
  exemptions: ExemptionMap
} {
  return {
    masked: snapshot.result.masked,
    entries: snapshot.entries.map(cloneEntry),
    exemptions: cloneExemptions(snapshot.exemptions),
  }
}

/** 放弃改动：回滚到基线（已采纳稿或文件载入态，含其豁免簿）并从原文重算。 */
export function rollback(
  text: string,
  basis: readonly PatternEntry[],
  basisExemptions: ExemptionMap = emptyExemptions(basis.length),
): Snapshot {
  const entries = basis.map(cloneEntry)
  const exemptions = cloneExemptions(basisExemptions)
  return { text, entries, exemptions, result: recompute(text, entries, exemptions) }
}

/**
 * 计数映射回完整工作集：返回与 entries 等长、下标一一对应的数组，
 * 启用项为其在原文中的有效命中次数（完整匹配数减去被单次豁免的命中数，
 * 0 表示零有效命中），停用项为 null（界面显示“未统计”）。筛选 /
 * 窗口化只改变渲染顺序与可见性，调用方始终以原始下标取数，因此计数
 * 永远对应原条目。
 */
export function countByEntry(
  entries: readonly PatternEntry[],
  result: MaskResult,
): Array<number | null> {
  const out: Array<number | null> = new Array(entries.length)
  let k = 0
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].enabled) out[i] = result.counts[k++]
    else out[i] = null
  }
  return out
}

/** 与 countByEntry 同构：每条启用短语在本次重算中实际生效的豁免数。 */
export function exemptCountByEntry(
  entries: readonly PatternEntry[],
  result: MaskResult,
): number[] {
  const out: number[] = new Array(entries.length).fill(0)
  let k = 0
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].enabled) out[i] = result.exemptCounts[k++]
  }
  return out
}

function cloneEntry(e: PatternEntry): PatternEntry {
  return { value: e.value, enabled: e.enabled }
}
