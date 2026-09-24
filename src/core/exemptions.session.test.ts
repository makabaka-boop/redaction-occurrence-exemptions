/**
 * 单次豁免的会话层验收：核实加入、幂等、有限数量上界、无效位置、随
 * 修改/停用/删除清理、载入清空、采纳固化、失败保留，以及预览/覆盖字符数/
 * 有效命中次数三者同源重算。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./masker', async () => {
  const actual = await vi.importActual<typeof import('./masker')>('./masker')
  return {
    ...actual,
    maskText: vi.fn(actual.maskText),
  }
})

import {
  COUNT_FAILED,
  INVALID_PATTERN,
  INVALID_POSITION,
  LIMITS,
  LIMITS_EXCEEDED,
  MaskError,
  maskText,
  type PatternEntry,
} from './masker'
import {
  addExemption,
  addPattern,
  adopt,
  countByEntry,
  exemptCountByEntry,
  loadSession,
  removeExemption,
  removePattern,
  rollback,
  setPatternEnabled,
  updatePattern,
} from './session'
import {
  addEntryExemption,
  appendExemptionSlot,
  clearEntryExemptions,
  cloneExemptions,
  emptyExemptions,
  removeEntryExemption,
  removeExemptionSlot,
  sameExemptions,
  totalExemptions,
} from './exemptions'

const mockedMaskText = vi.mocked(maskText)

function load(text: string, patterns: string[]) {
  return loadSession(JSON.stringify({ text, patterns }))
}

function expectError(code: string, fn: () => unknown): void {
  try {
    fn()
    throw new Error('应当抛错')
  } catch (e) {
    expect(e).toBeInstanceOf(MaskError)
    expect((e as MaskError).code).toBe(code)
  }
}

afterEach(() => {
  mockedMaskText.mockClear()
})

describe('豁免簿纯函数', () => {
  it('空簿 / 深拷贝 / 等价比较 / 总数 / 升序插入', () => {
    const m0 = emptyExemptions(3)
    expect(m0).toEqual([[], [], []])
    expect(totalExemptions(m0)).toBe(0)
    const m1 = addEntryExemptionSync(m0)
    expect(sameExemptions(m0, m1)).toBe(false)
    const copy = cloneExemptions(m1)
    expect(sameExemptions(copy, m1)).toBe(true)
    copy[0].push(99)
    expect(sameExemptions(copy, m1)).toBe(false) // 深拷贝隔离
    expect(totalExemptions(m1)).toBe(2)
  })

  function addEntryExemptionSync(map: number[][]) {
    // '..ab..ab' 中 'ab' 的起点为 2 与 6（验证升序插入）
    const text = '..ab..ab'
    const entries = [{ value: 'ab', enabled: true }]
    let m = addEntryExemption(text, entries, map, 0, 6)
    m = addEntryExemption(text, entries, m, 0, 2)
    expect(m[0]).toEqual([2, 6]) // 升序保存
    return m
  }

  it('槽位变换：追加 / 删除 / 清空', () => {
    const m: number[][] = [[1, 9], [3], []]
    expect(appendExemptionSlot(m)).toEqual([[1, 9], [3], [], []])
    expect(removeExemptionSlot(m, 1)).toEqual([[1, 9], []])
    expect(clearEntryExemptions(m, 0)).toEqual([[], [3], []])
    expect(removeEntryExemption(m, 0, 1)).toEqual([[9], [3], []])
    // 不可变：入参不被修改
    const snap = JSON.stringify(m)
    appendExemptionSlot(m)
    removeExemptionSlot(m, 0)
    clearEntryExemptions(m, 1)
    expect(JSON.stringify(m)).toBe(snap)
  })
})

describe('addExemption：核实、幂等、只放过这一次', () => {
  const text = 'abc xx abc yy abc' // abc @ 0,7,14

  it('加入前核实为同线内完整命中；预览/覆盖数/有效计数同源重算', () => {
    const { snapshot } = load(text, ['abc', 'x'])
    expect([...snapshot.result.counts]).toEqual([3, 2]) // abc 三次、x 两次
    // abc 覆盖 9 个字符、x 覆盖 2 个字符（位置 4、13），并集 11 个
    expect(snapshot.result.coveredCount).toBe(11)

    const s1 = addExemption(snapshot, 0, 7)
    expect(s1.exemptions[0]).toEqual([7])
    expect([...s1.result.counts]).toEqual([2, 2]) // 有效 abc 命中剩 2
    expect([...s1.result.exemptCounts]).toEqual([1, 0])
    expect(s1.result.masked[7]).toBe('a') // 只放过中间这次
    expect(s1.result.masked[0]).toBe('#') // 同词其他位置仍遮蔽
    expect(s1.result.masked[14]).toBe('#')
    // x 的遮蔽不受影响（"xx" 位于位置 4、5，仍是 #）
    expect(s1.result.masked[4]).toBe('#')
    expect(s1.result.masked[5]).toBe('#')
    expect(countByEntry(s1.entries, s1.result)[0]).toBe(2)
    expect(exemptCountByEntry(s1.entries, s1.result)[0]).toBe(1)
  })

  it('同一 (条目,起点) 重复豁免是幂等无变化，不重复计数', () => {
    const { snapshot } = load(text, ['abc'])
    const s1 = addExemption(snapshot, 0, 7)
    const s2 = addExemption(s1, 0, 7)
    expect(s2.exemptions[0]).toEqual([7])
    expect([...s2.result.exemptCounts]).toEqual([1])
    expect(s2.result.masked).toBe(s1.result.masked)
    expect(s2.result.coveredCount).toBe(s1.result.coveredCount)
  })

  it('撤销豁免后预览与计数恢复；撤销不存在的位置幂等', () => {
    const { snapshot } = load(text, ['abc'])
    const s1 = addExemption(snapshot, 0, 7)
    const s2 = removeExemption(s1, 0, 7)
    expect(s2.exemptions[0]).toEqual([])
    expect(s2.result.masked).toBe(snapshot.result.masked)
    expect([...s2.result.counts]).toEqual([3])
    // 撤销一个本不存在的豁免：不抛错，内容不变
    const s3 = removeExemption(s2, 0, 0)
    expect(s3.result.masked).toBe(snapshot.result.masked)
  })

  it('豁免不同位置可累积，起点表始终升序', () => {
    const { snapshot } = load(text, ['abc'])
    let s = addExemption(snapshot, 0, 14)
    s = addExemption(s, 0, 0)
    s = addExemption(s, 0, 7)
    expect(s.exemptions[0]).toEqual([0, 7, 14])
    expect([...s.result.counts]).toEqual([0]) // 三次全部豁免
    expect(s.result.masked).toBe(text)
    expect(s.result.coveredCount).toBe(0)
  })

  it('豁免某短语不抹掉其他短语在同一区域的遮蔽', () => {
    const t = 'abcabc'
    const { snapshot } = load(t, ['abc', 'bca', 'cab'])
    // 豁免 abc@0；bca@1、cab@2 的遮蔽仍覆盖位置 1..3
    const s = addExemption(snapshot, 0, 0)
    expect(s.result.masked[0]).toBe('a')
    expect(s.result.masked.slice(1, 4)).toBe('####'.slice(0, 3))
    expect(s.result.masked).toBe('a#####')
  })
})

describe('addExemption：无效位置 INVALID_POSITION / INVALID_PATTERN', () => {
  const text = 'abc\nabc'

  it('非命中位置 / 越界 / 负数 / 非整数 / 落在换行 → INVALID_POSITION', () => {
    const { snapshot } = load(text, ['abc'])
    expectError(INVALID_POSITION, () => addExemption(snapshot, 0, 1)) // 不是命中起点
    expectError(INVALID_POSITION, () => addExemption(snapshot, 0, 5)) // end 越界
    expectError(INVALID_POSITION, () => addExemption(snapshot, 0, -1))
    expectError(INVALID_POSITION, () => addExemption(snapshot, 0, 3)) // 换行位置
    expectError(INVALID_POSITION, () => addExemption(snapshot, 0, 1.5))
    expectError(INVALID_POSITION, () => addExemption(snapshot, 0, Number.NaN))
  })

  it('短语下标越界 → INVALID_PATTERN', () => {
    const { snapshot } = load(text, ['abc'])
    expectError(INVALID_PATTERN, () => addExemption(snapshot, 5, 0))
    expectError(INVALID_PATTERN, () => addExemption(snapshot, -1, 0))
    expectError(INVALID_PATTERN, () => removeExemption(snapshot, 9, 0))
  })

  it('停用短语的位置不可豁免 → INVALID_POSITION', () => {
    const { snapshot } = load(text, ['abc'])
    const off = setPatternEnabled(snapshot, 0, false)
    expectError(INVALID_POSITION, () => addExemption(off, 0, 0))
  })

  it('非法动作在重算之前被拒：maskText 不被调用，旧快照保留', () => {
    const { snapshot } = load(text, ['abc'])
    const calls = mockedMaskText.mock.calls.length
    const before = snapshot.result.masked
    expectError(INVALID_POSITION, () => addExemption(snapshot, 0, 1))
    expect(mockedMaskText.mock.calls.length).toBe(calls)
    expect(snapshot.result.masked).toBe(before)
    expect(snapshot.exemptions[0]).toEqual([])
  })
})

describe('单次豁免的有限数量上界', () => {
  it('单条豁免数达到上界后再加 → LIMITS_EXCEEDED（构造可重复豁免的文本）', () => {
    // 单字符短语 'a'，每处 a 都是一个独立命中；文本给足命中数
    const text = 'a'.repeat(LIMITS.maxExemptionsPerEntry + 5)
    const { snapshot } = load(text, ['a'])
    let s = snapshot
    for (let i = 0; i < LIMITS.maxExemptionsPerEntry; i++) {
      s = addExemption(s, 0, i)
    }
    expect(s.exemptions[0]).toHaveLength(LIMITS.maxExemptionsPerEntry)
    expectError(LIMITS_EXCEEDED, () => addExemption(s, 0, LIMITS.maxExemptionsPerEntry))
    // 被拒后簿与预览不变
    expect(s.exemptions[0]).toHaveLength(LIMITS.maxExemptionsPerEntry)
  })

  it('全局豁免总数上界：簿已满时新增真实命中被 LIMITS_EXCEEDED 拒绝', () => {
    // 纯函数契约：map 与条目数组等长；命中核实先于上界检查。全局上界
    // 只能由 ≥100 条共同填满（单条上界 100），这里用 100 条构造簿，
    // 其中仅前两条在文本中真实出现。
    const text = 'ab cd'
    const many: PatternEntry[] = [
      { value: 'ab', enabled: true },
      { value: 'cd', enabled: true },
    ]
    for (let i = 0; i < 98; i++) many.push({ value: `z${i}`, enabled: true })
    const full = emptyExemptions(many.length)
    // 每条都放 100 个互不相同的位置（无需真实命中：簿本身只存数字）。
    // 偏移 +10 避开前两条真实命中位置 0 与 3，防止与重复幂等路径混淆。
    for (let i = 0; i < many.length; i++) {
      full[i] = Array.from({ length: LIMITS.maxExemptionsPerEntry }, (_, j) => 1000 * i + j + 10)
    }
    expect(totalExemptions(full)).toBe(LIMITS.maxExemptionsTotal)
    // 第 0 条已满 100 个：加真实命中 start=0（与现有位置不重复）→
    // 条上界（与全局上界同一错误码 LIMITS_EXCEEDED）
    expectError(LIMITS_EXCEEDED, () => addEntryExemption(text, many, full, 0, 0))

    // 全局闸门的独立价值：100 条填满 10,000 后，第 101 条（自身为空）
    // 的真实命中也必须被拒绝——证明不是条上界在起作用。
    const plus: PatternEntry[] = [...many, { value: 'ef', enabled: true }]
    const fullPlus: number[][] = [...full.map((s) => s.slice()), []]
    expect(totalExemptions(fullPlus)).toBe(LIMITS.maxExemptionsTotal)
    expect(fullPlus[100]).toHaveLength(0) // 该条自身空，远未到条上界
    expectError(LIMITS_EXCEEDED, () => addEntryExemption('ef', plus, fullPlus, 100, 0))

    // 全局差 1（第 0 条 99、其余 99 条各 100 = 9999）时，真实命中可加入
    const almost = full.map((s) => s.slice())
    almost[0] = almost[0].slice(0, LIMITS.maxExemptionsPerEntry - 1) // 99 个
    expect(totalExemptions(almost)).toBe(LIMITS.maxExemptionsTotal - 1)
    const reached = addEntryExemption(text, many, almost, 0, 0)
    expect(reached[0]).toContain(0)
    expect(totalExemptions(reached)).toBe(LIMITS.maxExemptionsTotal)
  })

  it('到达上界的同一位置重复豁免仍幂等成功（不占新名额）', () => {
    const text = 'a'.repeat(LIMITS.maxExemptionsPerEntry)
    const { snapshot } = load(text, ['a'])
    let s = snapshot
    for (let i = 0; i < LIMITS.maxExemptionsPerEntry; i++) s = addExemption(s, 0, i)
    // 已存在的 (0,0) 再来一次：幂等，不报上界
    expect(() => addExemption(s, 0, 0)).not.toThrow()
  })
})

describe('豁免随短语生命周期清理', () => {
  const text = 'abc abc abc'

  it('修改短语值：旧值的豁免全部清空并按新工作集重算', () => {
    const { snapshot } = load(text, ['abc'])
    const ex = addExemption(snapshot, 0, 0)
    expect(ex.exemptions[0]).toEqual([0])
    const updated = updatePattern(ex, 0, 'b')
    expect(updated.exemptions[0]).toEqual([])
    // 新词 'b' 在原文有命中，正常计数
    expect([...updated.result.counts]).toEqual([3])
    expect(updated.result.masked).toBe('a#c a#c a#c')
  })

  it('停用短语：豁免清空；重新启用是空簿起步', () => {
    const { snapshot } = load(text, ['abc'])
    const ex = addExemption(snapshot, 0, 0)
    const off = setPatternEnabled(ex, 0, false)
    expect(off.exemptions[0]).toEqual([])
    expect(off.result.exemptCounts).toHaveLength(0)
    const on = setPatternEnabled(off, 0, true)
    expect(on.exemptions[0]).toEqual([])
    expect([...on.result.counts]).toEqual([3]) // 豁免未复活
    expect(on.result.masked).toBe(snapshot.result.masked)
  })

  it('删除短语：其豁免槽整体移除；其他条目的豁免随下标保留', () => {
    const { snapshot } = load(text, ['abc', 'b'])
    let s = addExemption(snapshot, 0, 4) // 豁免中间 abc
    s = addExemption(s, 1, 1) // 豁免第一个 b
    expect(s.exemptions).toEqual([[4], [1]])
    const removed = removePattern(s, 0) // 删掉 'abc'
    expect(removed.entries.map((e) => e.value)).toEqual(['b'])
    expect(removed.exemptions).toEqual([[1]]) // 原 'b' 的豁免跟随保留
    // 纯函数槽位删除也核对
    expect(removeExemptionSlot([[4], [1], [9]], 1)).toEqual([[4], [9]])
  })

  it('新增短语：末尾追加空豁免槽，不影响既有豁免', () => {
    const { snapshot } = load(text, ['abc'])
    const ex = addExemption(snapshot, 0, 0)
    const added = addPattern(ex, 'b')
    expect(added.exemptions[0]).toEqual([0])
    expect(added.exemptions[1]).toEqual([])
  })
})

describe('载入清空 / 采纳固化 / 放弃回滚', () => {
  it('载入新文本：旧豁免全部清空（即使新文本相似）', () => {
    const first = load('abc abc', ['abc'])
    let s = addExemption(first.snapshot, 0, 0)
    expect(s.exemptions[0]).toEqual([0])
    // 重新载入（页面会替换整个会话）
    const second = load('abc abc', ['abc'])
    expect(second.snapshot.exemptions[0]).toEqual([])
    expect(second.session.initialExemptions[0]).toEqual([])
    expect([...second.snapshot.result.counts]).toEqual([2])
    expect(s.result.masked).not.toBe(second.snapshot.result.masked)
  })

  it('采纳固化当时的豁免与遮蔽结果；之后增减豁免不改变已采纳稿', () => {
    const { snapshot } = load('abc xx abc yy abc', ['abc'])
    const ex = addExemption(snapshot, 0, 7)
    const draft = adopt(ex)
    expect(draft.exemptions[0]).toEqual([7])
    const frozenMasked = ex.result.masked
    // 采纳后再豁免另一处：工作预览变化，采纳稿不动
    const ex2 = addExemption(ex, 0, 0)
    expect(ex2.result.masked).not.toBe(frozenMasked)
    expect(draft.masked).toBe(frozenMasked)
    expect(draft.exemptions[0]).toEqual([7]) // 固化值不被后续改动影响
  })

  it('放弃改动：工作集与豁免簿一起回滚到基线（载入态或已采纳稿）', () => {
    const { session, snapshot } = load('abc abc', ['abc'])
    const ex = addExemption(snapshot, 0, 0)
    // 无采纳稿：回滚到载入态（豁免清空）
    const rolled = rollback(session.text, session.initial, session.initialExemptions)
    expect(rolled.exemptions[0]).toEqual([])
    expect(rolled.result.masked).toBe(snapshot.result.masked)

    // 有采纳稿：回滚到采纳时的豁免簿（再增加一处未采纳豁免后回滚）
    const draft = adopt(ex)
    const more = addExemption(ex, 0, 4)
    expect(more.exemptions[0]).toEqual([0, 4])
    const back = rollback(session.text, draft.entries, draft.exemptions)
    expect(back.exemptions[0]).toEqual([0])
    expect(back.result.masked).toBe(ex.result.masked)
  })

  it('dirty 语义：豁免增减属于未决改动（由 sameExemptions 支撑）', () => {
    const { snapshot } = load('abc abc', ['abc'])
    const ex = addExemption(snapshot, 0, 0)
    expect(sameExemptions(snapshot.exemptions, ex.exemptions)).toBe(false)
    const removed = removeExemption(ex, 0, 0)
    expect(sameExemptions(snapshot.exemptions, removed.exemptions)).toBe(true)
  })
})

describe('重算失败：保留上一次有效预览与已采纳稿', () => {
  it('加入豁免时 maskText 抛错 → COUNT_FAILED，豁免/预览/采纳稿成套保留', () => {
    const { snapshot } = load('abc abc', ['abc'])
    const draft = adopt(snapshot)
    const calls = mockedMaskText.mock.calls.length
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expectError(COUNT_FAILED, () => addExemption(snapshot, 0, 0))
    expect(mockedMaskText.mock.calls.length).toBe(calls + 1)
    // 旧快照原样（'abc abc' 的遮蔽稿保留中间空格）
    expect(snapshot.exemptions[0]).toEqual([])
    expect(snapshot.result.masked).toBe('### ###')
    expect(draft.masked).toBe('### ###')
  })

  it('故障恢复后豁免可正常加入', () => {
    const { snapshot } = load('abc abc', ['abc'])
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('transient')
    })
    expectError(COUNT_FAILED, () => addExemption(snapshot, 0, 0))
    const ok = addExemption(snapshot, 0, 0)
    expect(ok.exemptions[0]).toEqual([0])
    expect(ok.result.masked[0]).toBe('a')
  })
})
