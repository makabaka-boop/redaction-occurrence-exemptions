/**
 * 会话编排：把「工作短语集 + 从同一原文的重算结果」作为一个整体原子提交。
 *
 * 不变式：
 * - 载入合法文件，或任何增改 / 启停 / 删除，都从**同一原文**与候选工作集
 *   重新构建自动机并一次性产出遮蔽预览与每条启用短语的完整匹配次数；
 *   计数与启用短语同序，预览与计数来自同一次重算，绝不增量修补。
 * - 导入与所有编辑成功后的工作集始终遵守**同一组聚合约束**（数量
 *   1..50,000、总长 ≤ 300,000）：候选工作集在重算之前先过聚合闸门，
 *   越界增改或使数量低于最小数量的删除只抛 LIMITS_EXCEEDED 拒绝当前
 *   动作，绝不重建自动机、绝不提交候选快照。
 * - 重算以候选快照提交：先对候选工作集完成全部计算，成功后才替换当前快照；
 *   自动机构建、遮蔽或计数阶段抛出任何异常，都转换为 COUNT_FAILED 抛出，
 *   并保留上一次成功的工作集、预览、计数与已采纳稿（由调用方不替换
 *   Snapshot 实现）。
 * - “采纳”只固化当时的下载稿（遮蔽字符串）与短语快照；此后再调整短语
 *   触发的重算只产生新的预览/计数，不会改变已采纳稿或其格式。
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
  type MaskResult,
  type PatternEntry,
} from './masker'

export interface Snapshot {
  /** 当前会话原文（载入后不再变化） */
  text: string
  /** 当前工作短语集（最近一次成功重算所对应的集合） */
  entries: PatternEntry[]
  /** 与 entries 同一次重算的结果（遮蔽稿 + 每启用短语计数） */
  result: MaskResult
}

/** 载入态原始短语快照（放弃改动的回滚基线之一） */
export interface LoadedSession {
  text: string
  initial: PatternEntry[]
}

/**
 * 从原文与候选工作集执行一次完整重算。
 * 任何异常（构建 / 遮蔽 / 计数）一律归一为 COUNT_FAILED，调用方据此
 * 保留上一次成功的快照。
 */
export function recompute(text: string, entries: readonly PatternEntry[]): MaskResult {
  const enabled: string[] = []
  for (const e of entries) if (e.enabled) enabled.push(e.value)
  try {
    return maskText(text, enabled)
  } catch (err) {
    if (err instanceof MaskError) throw err
    throw new MaskError(COUNT_FAILED)
  }
}

/**
 * 载入文件：解析校验（非法文件由 parseInput 抛 INVALID_INPUT）成功后，
 * 从载入态工作集做首次重算。重算本身失败抛 COUNT_FAILED，调用方应保留
 * 旧会话；只有本函数整体返回才代表新会话成立。
 */
export function loadSession(jsonText: string): { session: LoadedSession; snapshot: Snapshot } {
  // 先解析：失败直接抛 INVALID_INPUT，绝不触碰任何现有会话状态
  const parsed = parseInput(jsonText)
  const entries = parsed.patterns.map((value) => ({ value, enabled: true }))
  const result = recompute(parsed.text, entries)
  return {
    session: { text: parsed.text, initial: entries.map(cloneEntry) },
    snapshot: { text: parsed.text, entries, result },
  }
}

/**
 * 对候选工作集应用一次变更并完成重算，整体作为候选快照返回。
 * mutate 抛 INVALID_PATTERN（非法值/越界）或 LIMITS_EXCEEDED（聚合约束
 * 越界：数量 1..50,000、总长 ≤ 300,000）时原样向上抛；recompute 抛
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
): Snapshot {
  // 变更函数都是不可变更新，异常不会部分修改 snapshot.entries
  const entries = mutate(snapshot.entries)
  let totalLength = 0
  for (const e of entries) totalLength += e.value.length
  assertWorksetLimits(entries.length, totalLength, LIMITS_EXCEEDED)
  const result = recompute(snapshot.text, entries)
  return { text: snapshot.text, entries, result }
}

export const addPattern = (s: Snapshot, value: string): Snapshot =>
  applyChange(s, (entries) => addEntry(entries, value))

export const updatePattern = (s: Snapshot, index: number, value: string): Snapshot =>
  applyChange(s, (entries) => updateEntry(entries, index, value))

export const setPatternEnabled = (s: Snapshot, index: number, enabled: boolean): Snapshot =>
  applyChange(s, (entries) => toggleEntry(entries, index, enabled))

export const removePattern = (s: Snapshot, index: number): Snapshot =>
  applyChange(s, (entries) => removeEntry(entries, index))

/** 采纳：固化当前下载稿与其短语快照（深拷贝，之后重算不影响本稿）。 */
export function adopt(snapshot: Snapshot): { masked: string; entries: PatternEntry[] } {
  return {
    masked: snapshot.result.masked,
    entries: snapshot.entries.map(cloneEntry),
  }
}

/** 放弃改动：回滚到已采纳稿（无则回滚到文件载入态），并从原文重算。 */
export function rollback(
  text: string,
  basis: readonly PatternEntry[],
): Snapshot {
  const entries = basis.map(cloneEntry)
  return { text, entries, result: recompute(text, entries) }
}

/**
 * 计数映射回完整工作集：返回与 entries 等长、下标一一对应的数组，
 * 启用项为其在原文中的完整匹配次数（0 表示零命中），停用项为 null
 * （界面显示“未统计”）。筛选 / 窗口化只改变渲染顺序与可见性，调用方
 * 始终以原始下标取数，因此计数永远对应原条目。
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

function cloneEntry(e: PatternEntry): PatternEntry {
  return { value: e.value, enabled: e.enabled }
}
