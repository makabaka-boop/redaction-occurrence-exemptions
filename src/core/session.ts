/**
 * 会话编排：把「工作短语集 + 单次豁免 + 从同一原文的重算结果」作为一个整体
 * 原子提交。
 *
 * 不变式：
 * - 载入合法文件，或任何增改 / 启停 / 删除 / 豁免，都从**同一原文**与候选
 *   工作集重新构建自动机并一次性产出遮蔽预览与每条启用短语的有效匹配次数；
 *   计数与启用短语同序，预览与计数来自同一次重算，绝不增量修补。
 * - 导入与所有编辑成功后的工作集始终遵守**同一组聚合约束**（数量
 *   1..50,000、总长 ≤ 300,000）：候选工作集在重算之前先过聚合闸门，
 *   越界增改或使数量低于最小数量的删除只抛 LIMITS_EXCEEDED 拒绝当前
 *   动作，绝不重建自动机、绝不提交候选快照。
 * - 重算以候选快照提交：先对候选工作集完成全部计算，成功后才替换当前快照；
 *   自动机构建、遮蔽或计数阶段抛出任何异常，都转换为 COUNT_FAILED 抛出，
 *   并保留上一次成功的工作集、预览、计数、豁免与已采纳稿（由调用方不替换
 *   Snapshot 实现）。
 * - “单次豁免”只放过某条启用短语在指定起始代码单元处的**一处完整命中**：
 *   该处命中不再遮蔽（其他短语的遮蔽保留）、该短语有效命中次数只减一；
 *   修改 / 停用 / 删除对应短语会清理随之失效的豁免（改值后新短语不继承），
 *   载入新文本清空全部豁免。豁免总数受 LIMITS.maxExemptions 硬上限约束。
 * - “采纳”固化当时的下载稿（遮蔽字符串）、短语快照与豁免快照；此后再调整
 *   短语或豁免触发的重算只产生新的预览/计数，不会改变已采纳稿或其格式。
 */

import {
  COUNT_FAILED,
  INVALID_EXEMPTION,
  LIMITS_EXCEEDED,
  LIMITS,
  MaskError,
  addEntry,
  assertWorksetLimits,
  isAllowedTextCode,
  maskText,
  parseInput,
  removeEntry,
  toggleEntry,
  updateEntry,
  type ExemptionRef,
  type MaskResult,
  type PatternEntry,
} from './masker'

/**
 * 会话层持有的单次豁免：entry 是短语在**完整工作集**中的下标（不是启用
 * 序列下标），start 是被豁免命中在原文中的起始 UTF-16 代码单元。
 * 重算时由 toExemptionRefs 翻译成 maskText 使用的启用序列下标。
 */
export interface Exemption {
  entry: number
  start: number
}

export interface Snapshot {
  /** 当前会话原文（载入后不再变化） */
  text: string
  /** 当前工作短语集（最近一次成功重算所对应的集合） */
  entries: PatternEntry[]
  /**
   * 当前生效的单次豁免（与 entries 下标对应；全部引用启用短语）。
   * 每处豁免只放过一处命中；随短语改 / 停 / 删清理，载入新文本时清空。
   */
  exemptions: Exemption[]
  /** 与 entries/exemptions 同一次重算的结果（遮蔽稿 + 每启用短语有效计数） */
  result: MaskResult
}

/** 载入态原始短语快照（放弃改动的回滚基线之一） */
export interface LoadedSession {
  text: string
  initial: PatternEntry[]
}

/**
 * 已采纳的下载稿：遮蔽字符串 + 当时的短语快照 + 当时的豁免快照。
 * 采纳之后继续调整短语 / 豁免只影响工作预览，不改变本稿；再次采纳才更新。
 */
export interface Draft {
  masked: string
  entries: PatternEntry[]
  exemptions: Exemption[]
}

/**
 * 把工作集下标形式的豁免翻译成 maskText 使用的“启用短语序列下标”，并按
 * (启用下标, 起点) 去重。调用到这里时豁免保证只引用启用短语（停用 / 删除 /
 * 改值已在产生候选时清理）；翻译表随 entries 线性建立。
 */
export function toExemptionRefs(
  entries: readonly PatternEntry[],
  exemptions: readonly Exemption[],
): ExemptionRef[] {
  const enabledIndex = new Int32Array(entries.length).fill(-1)
  let k = 0
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].enabled) enabledIndex[i] = k++
  }
  const refs: ExemptionRef[] = []
  const seen = new Set<number>()
  for (const ex of exemptions) {
    const p = enabledIndex[ex.entry]
    if (p < 0) continue // 防御：不应出现（清理在候选构造时已完成）
    const key = p * 0x100000000 + ex.start
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ pattern: p, start: ex.start })
  }
  return refs
}

/**
 * 从原文与候选工作集 / 豁免执行一次完整重算。
 * 任何异常（构建 / 遮蔽 / 计数）一律归一为 COUNT_FAILED，调用方据此
 * 保留上一次成功的快照。
 */
export function recompute(
  text: string,
  entries: readonly PatternEntry[],
  exemptions: readonly Exemption[] = [],
): MaskResult {
  const enabled: string[] = []
  for (const e of entries) if (e.enabled) enabled.push(e.value)
  try {
    return maskText(text, enabled, toExemptionRefs(entries, exemptions))
  } catch (err) {
    if (err instanceof MaskError) throw err
    throw new MaskError(COUNT_FAILED)
  }
}

/**
 * 载入文件：解析校验（非法文件由 parseInput 抛 INVALID_INPUT）成功后，
 * 从载入态工作集做首次重算（无豁免）。重算本身失败抛 COUNT_FAILED，调用方
 * 应保留旧会话；只有本函数整体返回才代表新会话成立。
 */
export function loadSession(jsonText: string): { session: LoadedSession; snapshot: Snapshot } {
  // 先解析：失败直接抛 INVALID_INPUT，绝不触碰任何现有会话状态
  const parsed = parseInput(jsonText)
  const entries = parsed.patterns.map((value) => ({ value, enabled: true }))
  const result = recompute(parsed.text, entries, [])
  return {
    session: { text: parsed.text, initial: entries.map(cloneEntry) },
    snapshot: { text: parsed.text, entries, exemptions: [], result },
  }
}

/**
 * 短语增删改时把豁免映射到新工作集：
 * - 保位（改值 / 启停，mode 'keep'）：位置 < changed 的不动；== changed 的
 *   豁免——改值后旧词不再匹配，或停用后该条不参与——一律清理；其余保留。
 * - 追加（mode 'append'）：既有豁免全部保留（新条目在末尾，没有旧豁免引用它）。
 * - 删除（mode 'removeAt'）：删掉引用该条的豁免；其后的豁免下标前移一位。
 */
function remapExemptions(
  exemptions: readonly Exemption[],
  mode: 'keep' | 'append' | 'removeAt',
  changed: number,
): Exemption[] {
  if (mode === 'append') return exemptions.map(cloneExemption)
  const out: Exemption[] = []
  for (const ex of exemptions) {
    if (mode === 'keep') {
      if (ex.entry === changed) continue
      out.push({ entry: ex.entry, start: ex.start })
    } else {
      // removeAt
      if (ex.entry === changed) continue
      out.push({ entry: ex.entry > changed ? ex.entry - 1 : ex.entry, start: ex.start })
    }
  }
  return out
}

/**
 * 对候选工作集应用一次变更并完成重算，整体作为候选快照返回。
 * mutate 抛 INVALID_PATTERN（非法值/越界）或 LIMITS_EXCEEDED（聚合约束
 * 越界：数量 1..50,000、总长 ≤ 300,000）时原样向上抛；recompute 抛
 * COUNT_FAILED 时同样向上抛——两种情况下调用方都保留旧快照不变。
 *
 * remap 决定本次变更如何清理 / 迁移豁免：改值与启停使被操作条目的豁免失效
 * （旧命中不再成立或该条已停用），删除同时做下标迁移，追加不影响旧豁免。
 *
 * 聚合约束在**重算之前**有一道集中闸门：任何路径（包括直接传入的泛型
 * mutate）产出的候选工作集，只要数量或总长越界，立即抛 LIMITS_EXCEEDED，
 * 绝不重建自动机、绝不产出快照。导入与所有编辑成功后的工作集因此始终
 * 遵守同一组聚合约束。
 */
export function applyChange(
  snapshot: Snapshot,
  mutate: (entries: readonly PatternEntry[]) => PatternEntry[],
  remap: { mode: 'keep' | 'append' | 'removeAt'; index: number } = { mode: 'keep', index: -1 },
): Snapshot {
  // 变更函数都是不可变更新，异常不会部分修改 snapshot.entries
  const entries = mutate(snapshot.entries)
  let totalLength = 0
  for (const e of entries) totalLength += e.value.length
  assertWorksetLimits(entries.length, totalLength, LIMITS_EXCEEDED)
  const exemptions = remapExemptions(snapshot.exemptions, remap.mode, remap.index)
  const result = recompute(snapshot.text, entries, exemptions)
  return { text: snapshot.text, entries, exemptions, result }
}

export const addPattern = (s: Snapshot, value: string): Snapshot =>
  applyChange(s, (entries) => addEntry(entries, value), { mode: 'append', index: s.entries.length })

export const updatePattern = (s: Snapshot, index: number, value: string): Snapshot =>
  applyChange(s, (entries) => updateEntry(entries, index, value), { mode: 'keep', index })

export const setPatternEnabled = (s: Snapshot, index: number, enabled: boolean): Snapshot =>
  // 停用：该条豁免随命中资格一起失效（'keep' 清理 index 处豁免）；重新启用
  // 不会恢复它们——停用当时已被清理，'keep' 对“无豁免的条目”是恒等映射。
  applyChange(s, (entries) => toggleEntry(entries, index, enabled), { mode: 'keep', index })

export const removePattern = (s: Snapshot, index: number): Snapshot =>
  applyChange(s, (entries) => removeEntry(entries, index), { mode: 'removeAt', index })

/**
 * 登记一次单次豁免：只放过 entry 这条启用短语在 start 处的一处完整命中。
 * 在重算之前逐项校验（任一不过 → INVALID_EXEMPTION，不提交、保留上次有效
 * 预览与采纳稿）：
 *   - start 为 [0, n-1] 内的整数；
 *   - entry 是存在且**启用**的工作集下标（停用 / 越界短语不能豁免）；
 *   - 命中完整落在同一行内：起点不是换行，区间不越界，且区间内无换行；
 *   - text[start..start+len) 与短语逐代码单元相同（即确为完整命中）；
 *   - 同一命中（entry, start）尚未被豁免（不重复登记）。
 * 全部豁免数有硬上限 LIMITS.maxExemptions：越过 → LIMITS_EXCEEDED。
 * 校验通过后从同一原文与同一工作集（含新豁免）重算；重算异常 →
 * COUNT_FAILED，旧快照保留。
 */
export function addExemption(snapshot: Snapshot, entry: number, start: number): Snapshot {
  const { text, entries, exemptions } = snapshot
  const n = text.length
  if (!Number.isInteger(start) || start < 0 || start >= n) {
    throw new MaskError(INVALID_EXEMPTION)
  }
  if (
    !Number.isInteger(entry) ||
    entry < 0 ||
    entry >= entries.length ||
    !entries[entry].enabled
  ) {
    throw new MaskError(INVALID_EXEMPTION)
  }
  const value = entries[entry].value
  const len = value.length
  const end = start + len
  if (end > n) throw new MaskError(INVALID_EXEMPTION)
  // 起点不能是换行；区间内不能出现换行（短语不含换行，出现即非同行完整命中）。
  // 短语字符全部 ≥ 0x20，故只需检查 text 一侧的换行。
  if (text.charCodeAt(start) === 0x0a) throw new MaskError(INVALID_EXEMPTION)
  for (let j = start; j < end; j++) {
    if (text.charCodeAt(j) === 0x0a || !isAllowedTextCode(text.charCodeAt(j))) {
      throw new MaskError(INVALID_EXEMPTION)
    }
  }
  for (let j = 0; j < len; j++) {
    if (text.charCodeAt(start + j) !== value.charCodeAt(j)) {
      throw new MaskError(INVALID_EXEMPTION)
    }
  }
  for (const ex of exemptions) {
    if (ex.entry === entry && ex.start === start) throw new MaskError(INVALID_EXEMPTION)
  }
  if (exemptions.length >= LIMITS.maxExemptions) {
    throw new MaskError(LIMITS_EXCEEDED)
  }
  const nextExemptions = [...exemptions, { entry, start }]
  const result = recompute(text, entries, nextExemptions)
  return { text, entries, exemptions: nextExemptions, result }
}

/**
 * 采纳：固化当前下载稿、短语快照与豁免快照（深拷贝，之后重算不影响本稿）。
 * 采纳稿中的遮蔽与有效计数正是当时豁免作用后的结果，三者成套固化。
 */
export function adopt(snapshot: Snapshot): Draft {
  return {
    masked: snapshot.result.masked,
    entries: snapshot.entries.map(cloneEntry),
    exemptions: snapshot.exemptions.map(cloneExemption),
  }
}

/**
 * 放弃改动：回滚到已采纳稿（无则回滚到文件载入态），并从原文重算。
 * 豁免一并回滚：有采纳稿时恢复采纳时固化的豁免，无采纳稿时回到载入态
 * （没有任何豁免）。回滚基线来自上次成功状态，重算理论上不会失败。
 */
export function rollback(
  text: string,
  basis: readonly PatternEntry[],
  basisExemptions: readonly Exemption[] = [],
): Snapshot {
  const entries = basis.map(cloneEntry)
  const exemptions = basisExemptions.map(cloneExemption)
  return { text, entries, exemptions, result: recompute(text, entries, exemptions) }
}

/** 两个豁免集合（作为无序集合）是否完全相同，用于脏检查。 */
export function sameExemptions(a: readonly Exemption[], b: readonly Exemption[]): boolean {
  if (a.length !== b.length) return false
  const keys = new Set<number>()
  for (const ex of a) keys.add(ex.entry * 0x100000000 + ex.start)
  for (const ex of b) {
    if (!keys.has(ex.entry * 0x100000000 + ex.start)) return false
  }
  return true
}

/** 每条工作集短语当前持有的豁免数（与 entries 等长；停用项恒为 0）。 */
export function exemptionsByEntry(
  entries: readonly PatternEntry[],
  exemptions: readonly Exemption[],
): number[] {
  const out = new Array<number>(entries.length).fill(0)
  for (const ex of exemptions) {
    if (ex.entry >= 0 && ex.entry < entries.length && entries[ex.entry].enabled) {
      out[ex.entry]++
    }
  }
  return out
}

/**
 * 计数映射回完整工作集：返回与 entries 等长、下标一一对应的数组，
 * 启用项为其在原文中的**有效**匹配次数（总命中减本短语豁免，0 表示零
 * 有效命中），停用项为 null（界面显示“未统计”）。筛选 / 窗口化只改变
 * 渲染顺序与可见性，调用方始终以原始下标取数，因此计数永远对应原条目。
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

function cloneExemption(ex: Exemption): Exemption {
  return { entry: ex.entry, start: ex.start }
}
