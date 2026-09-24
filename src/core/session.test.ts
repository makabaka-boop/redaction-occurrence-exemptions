import { afterEach, describe, expect, it, vi } from 'vitest'

// 故障注入：遮蔽/计数阶段（maskText）按用例需要抛错，其余符号走真实实现。
// loadSession/applyChange 必须把它归一为 COUNT_FAILED 且保留旧快照。
// 工厂里用真实 maskText 作为 mock 的默认实现；mockClear 只清调用记录、
// 不重置实现，因此各用例默认仍走真实算法。
vi.mock('./masker', async () => {
  const actual = await vi.importActual<typeof import('./masker')>('./masker')
  return {
    ...actual,
    maskText: vi.fn(actual.maskText),
  }
})

import {
  COUNT_FAILED,
  INVALID_INPUT,
  INVALID_PATTERN,
  INVALID_EXEMPTION,
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
  applyChange,
  countByEntry,
  exemptionsByEntry,
  loadSession,
  recompute,
  removePattern,
  rollback,
  sameExemptions,
  setPatternEnabled,
  toExemptionRefs,
  updatePattern,
  type Exemption,
  type Snapshot,
} from './session'
import { filterEntries } from './patternList'

const mockedMaskText = vi.mocked(maskText)

function file(text: string, patterns: string[]): string {
  return JSON.stringify({ text, patterns })
}

function load(text = 'alpha alpha beta', patterns = ['alpha', 'beta']) {
  return loadSession(file(text, patterns))
}

afterEach(() => {
  // mockClear 清调用记录但保留工厂给定的真实 maskText 默认实现
  mockedMaskText.mockClear()
})

describe('载入', () => {
  it('合法文件：快照包含工作集、预览与同序计数', () => {
    const { session, snapshot } = load('aaaa', ['a', 'aa'])
    expect(session.initial.map((e) => e.value)).toEqual(['a', 'aa'])
    expect(snapshot.entries.map((e) => e.enabled)).toEqual([true, true])
    expect(snapshot.result.counts[0]).toBe(4)
    expect(snapshot.result.counts[1]).toBe(3)
    expect(snapshot.result.masked).toBe('####')
  })

  it('非法文件：INVALID_INPUT 向上抛，由页面清会话', () => {
    expect(() => loadSession('not json')).toThrow(MaskError)
    try {
      loadSession(JSON.stringify({ text: 'a', patterns: ['a', 'a'] }))
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as MaskError).code).toBe(INVALID_INPUT)
    }
  })

  it('载入期重算抛错 → COUNT_FAILED（非法文件路径不被误归为 COUNT_FAILED）', () => {
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom in build')
    })
    try {
      loadSession(file('abc', ['a']))
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(MaskError)
      expect((e as MaskError).code).toBe(COUNT_FAILED)
    }
  })
})

describe('原子提交：重算异常保留上一次成功快照', () => {
  it('增改时 maskText 抛错 → COUNT_FAILED，工作集/预览/计数/采纳稿不变', () => {
    const { snapshot } = load('aaaa', ['a', 'aa'])
    const before = snapshot
    const beforeCounts = [...before.result.counts]

    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('count exploded')
    })

    try {
      addPattern(before, 'aaa')
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as MaskError).code).toBe(COUNT_FAILED)
    }
    // 旧快照引用与内容原样保留（调用方据此不替换状态）
    expect(before.entries.map((e) => e.value)).toEqual(['a', 'aa'])
    expect([...before.result.counts]).toEqual(beforeCounts)
    expect(before.result.masked).toBe('####')
  })

  it('故障后下一次正常编辑仍可成功提交（自动恢复）', () => {
    const { snapshot } = load('aaaa', ['a'])
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('transient')
    })
    expect(() => addPattern(snapshot, 'aa')).toThrow(MaskError)
    // 下一次调用走真实实现：成功
    const next = addPattern(snapshot, 'aaa')
    expect(next.entries.map((e) => e.value)).toEqual(['a', 'aaa'])
    expect(next.result.counts[0]).toBe(4)
    expect(next.result.counts[1]).toBe(2)
  })

  it('INVALID_PATTERN（空串/重复/越界）不计入 COUNT_FAILED 且不触发重算', () => {
    const { snapshot } = load('abc', ['a'])
    // load 本身做过一次成功重算；记录基线，之后三次失败都不应再调用 maskText
    const callsAtLoad = mockedMaskText.mock.calls.length
    expect(() => addPattern(snapshot, 'a')).toThrow(MaskError)
    expect(() => addPattern(snapshot, '')).toThrow(MaskError)
    expect(() => updatePattern(snapshot, 9, 'z')).toThrow(MaskError)
    expect(mockedMaskText.mock.calls.length).toBe(callsAtLoad)
  })

  it('已是 MaskError 的异常原样传播，不被重复包装', () => {
    const { snapshot } = load('abc', ['a'])
    const code = COUNT_FAILED
    mockedMaskText.mockImplementationOnce(() => {
      throw new MaskError(code)
    })
    try {
      recompute('abc', snapshot.entries)
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(MaskError)
      expect((e as MaskError).code).toBe(COUNT_FAILED)
    }
  })
})

describe('停用再启用：计数随同一原文重算恢复', () => {
  it('停用项不参与遮蔽且计数映射为 null；重新启用后计数与预览恢复', () => {
    const { snapshot } = load('aaaa', ['a', 'aa'])
    // 停用 'a'（下标 0）
    const off = setPatternEnabled(snapshot, 0, false)
    expect(off.entries[0].enabled).toBe(false)
    expect(off.result.counts).toHaveLength(1) // 只剩 'aa' 参与
    expect(off.result.counts[0]).toBe(3)
    expect(off.result.masked).toBe('####') // 'aa' 仍全覆盖

    const mapped = countByEntry(off.entries, off.result)
    expect(mapped[0]).toBeNull() // 停用 → 未统计
    expect(mapped[1]).toBe(3)

    // 重新启用：从同一原文重算，两条计数恢复，且与首次相同
    const on = setPatternEnabled(off, 0, true)
    expect(on.result.counts.length).toBe(2)
    expect(on.result.counts[0]).toBe(4)
    expect(on.result.counts[1]).toBe(3)
    expect(on.result.masked).toBe(snapshot.result.masked)
  })

  it('全部停用时遮蔽为原文、计数数组为空，映射全部 null', () => {
    const { snapshot } = load('abc', ['a'])
    const off = setPatternEnabled(snapshot, 0, false)
    expect(off.result.masked).toBe('abc')
    expect(off.result.counts).toHaveLength(0)
    expect(countByEntry(off.entries, off.result)).toEqual([null])
  })
})

describe('筛选后编辑：原始下标保证计数与条目对应', () => {
  it('筛到窗口外唯一条目后，按原始下标启停/删除/修改仍作用于正确条目', () => {
    const { snapshot } = load('abcdef', ['aa', 'bc', 'cde', 'x'])
    // 模拟页面：先对全集筛选，结果携带原始下标
    const filtered = filterEntries(snapshot.entries, 'cde')
    expect(filtered).toHaveLength(1)
    const originalIndex = filtered[0].index
    expect(originalIndex).toBe(2)

    // 用原始下标停用 'cde'
    const off = setPatternEnabled(snapshot, originalIndex, false)
    const mapped = countByEntry(off.entries, off.result)
    expect(mapped[2]).toBeNull()
    expect(mapped[1]).toBe(1) // 'bc' 仍统计
    // 'cde' 停用后只剩 'bc' 遮蔽位置 1..2：a##def
    expect(off.result.masked).toBe('a##def')
    expect(off.result.coveredCount).toBe(2)

    // 用原始下标删除
    const removed = removePattern(off, originalIndex)
    expect(removed.entries.map((e) => e.value)).toEqual(['aa', 'bc', 'x'])

    // 用原始下标修改另一条（'bc' 下标 1）
    const updated = updatePattern(snapshot, 1, 'BC')
    expect(updated.entries[1].value).toBe('BC')
    expect(updated.result.counts[1]).toBe(0) // 区分大小写：BC 在原文零命中
  })

  it('筛选后新增的条目携带正确全集中下标，计数随之出现', () => {
    const { snapshot } = load('aaaa', ['a'])
    const next = addPattern(snapshot, 'aa')
    // 在筛选视图里找 'aa'：其原始下标应为 1（而非显示序号错位）
    const filtered = filterEntries(next.entries, 'aa')
    const idx = filtered.find((r) => r.entry.value === 'aa')!.index
    expect(idx).toBe(1)
    expect(countByEntry(next.entries, next.result)[idx]).toBe(3)
  })
})

describe('采纳只固化下载稿与快照，后续统计不改变采纳稿', () => {
  it('采纳后再增改/停用/删除，已采纳稿字符串与格式逐字符不变', () => {
    // 选部分覆盖文本，使后续编辑确实改变工作预览，才能区分“预览变了、采纳稿没变”
    const { snapshot } = load('aXaY', ['X'])
    const draft = adopt(snapshot)
    const frozen = draft.masked
    expect(frozen).toBe('a#aY')

    let s = addPattern(snapshot, 'Y')
    s = setPatternEnabled(s, 0, false) // 停用 'X'，只剩 'Y' 遮蔽
    expect(s.result.masked).toBe('aXa#') // 工作预览确实变了
    s = removePattern(s, 1) // 再删掉 'Y' → 无启用短语，预览回到原文
    expect(s.result.masked).toBe('aXaY')
    // 采纳稿仍是当时字符串与长度（格式不变），不受任何后续统计影响
    expect(draft.masked).toBe(frozen)
    expect(draft.masked.length).toBe(4)
    expect(draft.entries.map((e) => e.value)).toEqual(['X']) // 快照停在采纳时
  })

  it('放弃改动回滚到已采纳稿（或载入态）并重算计数', () => {
    const { session, snapshot } = load('aaaa', ['a'])
    let s = addPattern(snapshot, 'aa')
    expect(s.entries).toHaveLength(2)
    // 无采纳稿 → 回滚到文件载入态
    const rolled = rollback(session.text, session.initial)
    expect(rolled.entries.map((e) => e.value)).toEqual(['a'])
    expect(rolled.result.counts[0]).toBe(4)
  })
})

describe('applyChange 泛型变更与计数顺序', () => {
  it('计数永远与启用短语同序（停用造成的压缩不影响映射）', () => {
    const { snapshot } = load('abcabcabc', ['abc', 'bca', 'cab'])
    // 停掉中间 'bca'
    const off = applyChange(snapshot, (es) =>
      es.map((e, i) => (i === 1 ? { ...e, enabled: false } : e)),
    )
    expect([...off.result.counts]).toEqual([3, 2]) // abc, cab
    const mapped = countByEntry(off.entries, off.result)
    expect(mapped).toEqual([3, null, 2])
  })
})

// ---------------------------------------------------------------------------
// 聚合约束：导入与所有编辑成功后的工作集始终同源同组约束
// （数量 1..50,000、总长 ≤ 300,000）。越界动作只拒绝自身，四类快照
// （列表、计数、预览、采纳稿）成套保留；恰在边界的增改、启停、筛选、
// 窗口化、合法下载保持兼容。
// ---------------------------------------------------------------------------

/** 等长互不相同短语（width 字符），count 条，全部启用。 */
function fixedEntries(count: number, width: number): PatternEntry[] {
  const out: PatternEntry[] = []
  for (let i = 0; i < count; i++) {
    const tail = String(i).padStart(width - 1, '0')
    out.push({ value: 'p' + tail.slice(tail.length - (width - 1)), enabled: true })
  }
  return out
}

function totalLen(entries: readonly PatternEntry[]): number {
  return entries.reduce((s, e) => s + e.value.length, 0)
}

/**
 * 与生产实现无关的遮蔽预言机：indexOf 枚举 + 区间覆盖；可纳入单次豁免
 * （工作集下标 + 起点的集合），被豁免命中从覆盖与计数中剔除。
 */
function oracleMask(
  text: string,
  patterns: readonly string[],
  exemptKeys: ReadonlySet<string> = new Set(),
  exemptByEnabled: ReadonlyMap<number, number> = new Map(),
): string {
  const cover = new Uint8Array(text.length)
  for (let k = 0; k < patterns.length; k++) {
    const p = patterns[k]
    let from = 0
    for (;;) {
      const idx = text.indexOf(p, from)
      if (idx === -1) break
      if (!exemptKeys.has(`${k}:${idx}`)) {
        for (let j = idx; j < idx + p.length; j++) cover[j] = 1
      }
      from = idx + 1
    }
  }
  let out = ''
  for (let i = 0; i < text.length; i++) out += cover[i] ? '#' : text[i]
  void exemptByEnabled
  return out
}

/** 把工作集下标的豁免翻译成启用序列下标的键集合（与会话实现独立）。 */
function enabledExemptionKeys(
  entries: readonly PatternEntry[],
  exemptions: readonly Exemption[],
): { keys: Set<string>; enabled: string[] } {
  const keys = new Set<string>()
  const enabled: string[] = []
  const enabledIndex = new Map<number, number>()
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].enabled) {
      enabledIndex.set(i, enabled.length)
      enabled.push(entries[i].value)
    }
  }
  for (const ex of exemptions) {
    const k = enabledIndex.get(ex.entry)
    if (k !== undefined) keys.add(`${k}:${ex.start}`)
  }
  return { keys, enabled }
}

/**
 * 四类快照成套一致：
 * 1) 列表（值与启停）；2) 计数映射；3) 工作预览（对照独立预言机，含豁免）；
 * 4) 已采纳稿（内容与采纳时短语 / 豁免快照）。拒绝后应与保留快照逐项相同。
 */
function expectCoherent(snapshot: Snapshot, draft: ReturnType<typeof adopt> | null) {
  const { keys, enabled } = enabledExemptionKeys(snapshot.entries, snapshot.exemptions)
  expect(snapshot.result.masked).toBe(oracleMask(snapshot.text, enabled, keys))
  expect(snapshot.result.masked).toHaveLength(snapshot.text.length)
  const mapped = countByEntry(snapshot.entries, snapshot.result)
  expect(mapped).toHaveLength(snapshot.entries.length)
  // 独立预言机的逐短语有效计数（总命中 − 该启用短语的豁免数）
  const exPerEnabled = new Map<number, number>()
  {
    let ki = 0
    const emap = new Map<number, number>()
    for (let i = 0; i < snapshot.entries.length; i++) {
      if (snapshot.entries[i].enabled) emap.set(i, ki++)
    }
    for (const ex of snapshot.exemptions) {
      const k = emap.get(ex.entry)
      if (k !== undefined) exPerEnabled.set(k, (exPerEnabled.get(k) ?? 0) + 1)
    }
  }
  let k = 0
  for (let i = 0; i < snapshot.entries.length; i++) {
    if (snapshot.entries[i].enabled) {
      // 用全文 indexOf 独立算总命中，再减豁免数
      const p = snapshot.entries[i].value
      let total = 0
      let from = 0
      for (;;) {
        const idx = snapshot.text.indexOf(p, from)
        if (idx === -1) break
        total++
        from = idx + 1
      }
      expect(snapshot.result.counts[k]).toBe(total - (exPerEnabled.get(k) ?? 0))
      expect(snapshot.result.counts[k]).toBe(mapped[i])
      k++
    } else {
      expect(mapped[i]).toBeNull()
    }
  }
  expect(k).toBe(snapshot.result.counts.length)
  // 豁免只引用存在且启用的工作集下标，且互不重复
  const exSeen = new Set<string>()
  for (const ex of snapshot.exemptions) {
    expect(Number.isInteger(ex.entry) && ex.entry >= 0 && ex.entry < snapshot.entries.length).toBe(true)
    expect(snapshot.entries[ex.entry].enabled).toBe(true)
    const key = `${ex.entry}:${ex.start}`
    expect(exSeen.has(key)).toBe(false)
    exSeen.add(key)
  }
  expect(snapshot.exemptions.length).toBeLessThanOrEqual(LIMITS.maxExemptions)
  // 工作集自身始终满足输入契约（可被原样重新载入）
  expect(snapshot.entries.length).toBeGreaterThanOrEqual(LIMITS.minPatterns)
  expect(snapshot.entries.length).toBeLessThanOrEqual(LIMITS.maxPatterns)
  expect(totalLen(snapshot.entries)).toBeLessThanOrEqual(LIMITS.maxTotalPatternLength)
  if (draft) {
    // 采纳稿是当时工作集 + 当时豁免对原文重算的遮蔽串
    const { keys: dKeys, enabled: dEnabled } = enabledExemptionKeys(draft.entries, draft.exemptions)
    expect(draft.masked).toBe(oracleMask(snapshot.text, dEnabled, dKeys))
  }
}

function expectError(code: string, fn: () => unknown): void {
  try {
    fn()
    throw new Error('应当抛出异常')
  } catch (e) {
    expect(e).toBeInstanceOf(MaskError)
    expect((e as MaskError).code).toBe(code)
  }
}

describe('编辑聚合约束：数量上界（50,000）', () => {
  it('已载 49,999 条：加到 50,000 合法，再加第 50,001 条被 LIMITS_EXCEEDED 拒绝', () => {
    // 6 字符等长：49,999 条总长 299,994
    const { snapshot } = loadSession(file('aaaa', fixedEntries(49_999, 6).map((e) => e.value)))
    const callsAtLoad = mockedMaskText.mock.calls.length

    const atLimit = addPattern(snapshot, 'q'.repeat(6))
    expect(atLimit.entries).toHaveLength(50_000)
    expect(totalLen(atLimit.entries)).toBe(300_000)
    expect(mockedMaskText.mock.calls.length).toBe(callsAtLoad + 1)
    expectCoherent(atLimit, null)

    // 越界：不重算（重算前的聚合闸门拦截）
    expectError(LIMITS_EXCEEDED, () => addPattern(atLimit, 'z'.repeat(6)))
    expect(mockedMaskText.mock.calls.length).toBe(callsAtLoad + 1)
    // 最近一次成功的四类快照原样保留
    expect(snapshot.entries).toHaveLength(49_999)
    expect(atLimit.entries).toHaveLength(50_000)
    expectCoherent(atLimit, null)
  })

  it('恰在 50,000 条上界：启停、筛选、窗口化、修改（不增量）均保持兼容', () => {
    const { snapshot } = loadSession(file('p00000', fixedEntries(50_000, 6).map((e) => e.value)))
    expect(snapshot.entries).toHaveLength(50_000)

    // 启停不改变聚合量：成功重算
    const off = setPatternEnabled(snapshot, 0, false)
    const on = setPatternEnabled(off, 0, true)
    expect(on.result.masked).toBe(snapshot.result.masked)

    // 筛选 + 原始下标编辑在边界规模上仍正确
    const hit = filterEntries(on.entries, 'p49999')
    expect(hit).toHaveLength(1)
    expect(hit[0].index).toBe(49_999)
    const updated = updatePattern(on, hit[0].index, 'q49999')
    expect(updated.entries[49_999].value).toBe('q49999')
    expect(updated.entries).toHaveLength(50_000)
    expectCoherent(updated, null)

    // 越界新增仍被拒（数量与总长同时到界）
    expectError(LIMITS_EXCEEDED, () => addPattern(updated, 'zzzzzz'))
  })
})

describe('编辑聚合约束：总长上界（300,000）', () => {
  it('1499×200+199（300,000-1，共 1500 条）：加 1 字符合法，加 2 字符被拒且不重算', () => {
    const patterns: string[] = []
    for (let i = 0; i < 1499; i++) {
      patterns.push(String(i).padStart(7, '0') + 'x'.repeat(193))
    }
    patterns.push('y'.repeat(199))
    const { snapshot } = loadSession(file('x', patterns))
    expect(snapshot.entries).toHaveLength(1500)
    expect(totalLen(snapshot.entries)).toBe(299_999)
    const callsAtLoad = mockedMaskText.mock.calls.length

    const atLimit = addPattern(snapshot, 'z')
    expect(totalLen(atLimit.entries)).toBe(300_000)
    expect(mockedMaskText.mock.calls.length).toBe(callsAtLoad + 1)
    expectCoherent(atLimit, null)

    // 在差 1 的候选上加 2 字符：越界，拒绝且不触发重算
    expectError(LIMITS_EXCEEDED, () => addPattern(snapshot, 'zw'))
    expect(mockedMaskText.mock.calls.length).toBe(callsAtLoad + 1)
    expectCoherent(atLimit, null)
  })

  it('改值使总长恰好 300,000 合法；之后任何新增都因总长越界被拒', () => {
    // 1499×200 + 一条 198 = 300,000 - 2
    const big: string[] = []
    for (let i = 0; i < 1499; i++) big.push(String(i).padStart(7, '0') + 'x'.repeat(193))
    big.push('s'.repeat(198))
    const { snapshot: near } = loadSession(file('x', big))
    expect(totalLen(near.entries)).toBe(300_000 - 2)

    const atLimit = updatePattern(near, 1499, 't'.repeat(200))
    expect(totalLen(atLimit.entries)).toBe(300_000)
    expectCoherent(atLimit, null)

    // 已在上界：新增 1 字符即总长越界（数量 1501 远未到 50,000 → 纯总长触发）
    expectError(LIMITS_EXCEEDED, () => addPattern(atLimit, 'z'))
    expectCoherent(atLimit, null)
  })
})

describe('编辑聚合约束：最小数量（删除唯一短语）', () => {
  it('只剩 1 条时删除 → LIMITS_EXCEEDED；列表/计数/预览/采纳稿成套保留', () => {
    const { snapshot } = load('aaaa', ['a'])
    const draft = adopt(snapshot)
    expect(draft.masked).toBe('####')
    const callsAtLoad = mockedMaskText.mock.calls.length

    expectError(LIMITS_EXCEEDED, () => removePattern(snapshot, 0))
    // 删除在重算之前被聚合闸门拦截：不重建自动机
    expect(mockedMaskText.mock.calls.length).toBe(callsAtLoad)
    // 四类快照成套不变
    expect(snapshot.entries.map((e) => e.value)).toEqual(['a'])
    expect([...snapshot.result.counts]).toEqual([4])
    expect(snapshot.result.masked).toBe('####')
    expect(draft.masked).toBe('####')
    expect(draft.entries.map((e) => e.value)).toEqual(['a'])
  })

  it('两条删到一条（恰为下界）成功，预览与计数成套重算', () => {
    const { snapshot } = load('aXaY', ['X', 'Y'])
    const one = removePattern(snapshot, 1)
    expect(one.entries).toHaveLength(1)
    expect(one.result.masked).toBe('a#aY')
    expectCoherent(one, null)
  })
})

describe('连续增删改：越界动作只拒绝自身，拒绝后下一次合法动作照常提交', () => {
  it('加至边界→越界新增被拒→改值成功→删一条→再新增回到边界，全程成套一致', () => {
    const { snapshot } = loadSession(file('aaaa', fixedEntries(49_998, 6).map((e) => e.value)))
    let s = addPattern(snapshot, 'q'.repeat(6))
    s = addPattern(s, 'r'.repeat(6))
    expect(s.entries).toHaveLength(50_000)
    expectCoherent(s, null)

    // 越界新增被拒
    expectError(LIMITS_EXCEEDED, () => addPattern(s, 'zzzzzz'))
    // 改值（不改变聚合量）成功
    s = updatePattern(s, 0, 'aaaaaa')
    expect(s.entries[0].value).toBe('aaaaaa')
    expectCoherent(s, null)
    // 删一条（数量降到 49,999，总长 299,994，合法）
    s = removePattern(s, 1)
    expect(s.entries).toHaveLength(49_999)
    expectCoherent(s, null)
    // 再新增 6 字符：数量 50,000、总长恰好 300,000，回到双边界
    s = addPattern(s, 'w'.repeat(6))
    expect(s.entries).toHaveLength(50_000)
    expect(totalLen(s.entries)).toBe(300_000)
    expectCoherent(s, null)
    // 再越界仍被拒
    expectError(LIMITS_EXCEEDED, () => addPattern(s, 'vvvvvv'))
  })

  it('INVALID_PATTERN 与 LIMITS_EXCEEDED 交错：各自独立拒绝，互不污染', () => {
    // 已在 50,000 / 300,000 双边界：任何新增都聚合越界；但单条违规仍先报
    const { snapshot } = loadSession(file('a', fixedEntries(50_000, 6).map((e) => e.value)))
    // 空串/重复 → INVALID_PATTERN（聚合闸门之前的单条校验）
    expectError(INVALID_PATTERN, () => addPattern(snapshot, ''))
    expectError(INVALID_PATTERN, () => addPattern(snapshot, snapshot.entries[0].value))
    // 合法单条值 → LIMITS_EXCEEDED（大写确保不与既有 p##### 重复）
    expectError(LIMITS_EXCEEDED, () => addPattern(snapshot, 'ZZZZZZ'))
    // 工作集仍是载入态
    expect(snapshot.entries).toHaveLength(50_000)
  })
})

describe('采纳交错：越界拒绝不改变已采纳稿；再次采纳只在合法快照上固化', () => {
  it('采纳后越界增删被拒，采纳稿与其快照不动；合法编辑后再次采纳才更新', () => {
    const { snapshot } = load('aXaY', ['X'])
    const draft = adopt(snapshot)
    const frozen = draft.masked
    expect(frozen).toBe('a#aY')

    // 删除唯一短语被拒：采纳稿不变
    expectError(LIMITS_EXCEEDED, () => removePattern(snapshot, 0))
    expect(draft.masked).toBe(frozen)
    expect(draft.entries.map((e) => e.value)).toEqual(['X'])

    // 合法新增后再次采纳：下载稿更新到新工作集
    const withTwo = addPattern(snapshot, 'Y')
    expect(withTwo.result.masked).toBe('a#a#')
    const draft2 = adopt(withTwo)
    expect(draft2.masked).toBe('a#a#')
    expect(draft2.entries.map((e) => e.value)).toEqual(['X', 'Y'])
    // 旧采纳对象本身不被原地修改
    expect(draft.masked).toBe(frozen)

    // 在两条的工作集上删除（剩一条，合法）不影响 draft2 快照
    const one = removePattern(withTwo, 0)
    expect(one.result.masked).toBe('aXa#')
    expect(draft2.masked).toBe('a#a#')
    // 再删唯一一条被拒
    expectError(LIMITS_EXCEEDED, () => removePattern(one, 0))
    expectCoherent(one, draft2)
  })
})

describe('重算故障与越界的交错', () => {
  it('接近上界时：先注入 COUNT_FAILED（保留），恢复后恰好到边界成功；越界始终不重算', () => {
    const { snapshot } = loadSession(file('aaaa', fixedEntries(49_999, 6).map((e) => e.value)))
    const callsAtLoad = mockedMaskText.mock.calls.length

    // 下一次新增的重算故障：候选（50,000 条、总长恰好 300,000）合法但重算抛错
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom near limit')
    })
    expectError(COUNT_FAILED, () => addPattern(snapshot, 'q'.repeat(6)))
    expect(mockedMaskText.mock.calls.length).toBe(callsAtLoad + 1)
    // 故障只拒绝自身：工作集仍 49,999 条
    expect(snapshot.entries).toHaveLength(49_999)

    // 恢复：恰好加到 50,000 成功
    const atLimit = addPattern(snapshot, 'q'.repeat(6))
    expect(atLimit.entries).toHaveLength(50_000)
    expectCoherent(atLimit, null)

    // 越界新增在重算之前被拒：用调用计数证明 maskText 完全没被走到
    const callsBeforeReject = mockedMaskText.mock.calls.length
    expectError(LIMITS_EXCEEDED, () => addPattern(atLimit, 'z'.repeat(6)))
    expect(mockedMaskText.mock.calls.length).toBe(callsBeforeReject)
  })

  it('聚合闸门在泛型 applyChange 上同样生效（自定义 mutate 也无法越界）', () => {
    const { snapshot } = load('aaaa', ['a'])
    // 直接构造一个清空工作集的 mutate：聚合闸门拦截，不调用 maskText
    const calls = mockedMaskText.mock.calls.length
    expectError(LIMITS_EXCEEDED, () => applyChange(snapshot, () => []))
    expect(mockedMaskText.mock.calls.length).toBe(calls)
    // 构造超长候选（基线 + 50,000×6 条）同样被拦
    const huge: PatternEntry[] = fixedEntries(50_000, 6)
    expect(totalLen(huge)).toBe(300_000)
    expectError(LIMITS_EXCEEDED, () =>
      applyChange(snapshot, (es) => [...es, ...huge]),
    )
    expect(mockedMaskText.mock.calls.length).toBe(calls)
    // 合法的泛型 mutate 照常重算
    const next = applyChange(snapshot, (es) => [...es, { value: 'aa', enabled: false }])
    expect(next.entries).toHaveLength(2)
    expectCoherent(next, null)
  })
})

// ---------------------------------------------------------------------------
// 单次豁免（引文保留）：登记 / 校验 / 计数与遮蔽成套重算 / 改停用删清理 /
// 采纳固化 / 放弃回滚 / 故障保留。
// ---------------------------------------------------------------------------
describe('单次豁免：登记与重算', () => {
  it('登记一处有效命中：只放过这一处，同词其他命中与其他短语遮蔽保留', () => {
    const { snapshot } = load('xxx xxx xxx', ['xxx'])
    expect(snapshot.exemptions).toEqual([])
    const ex = addExemption(snapshot, 0, 4) // 中间那处
    expect(ex.exemptions).toEqual([{ entry: 0, start: 4 }])
    expect(ex.result.masked).toBe('### xxx ###')
    expect(ex.result.coveredCount).toBe(6)
    expect(ex.result.counts[0]).toBe(2) // 3 - 1
    expectCoherent(ex, null)
    // 原快照不被修改
    expect(snapshot.exemptions).toEqual([])
    expect(snapshot.result.masked).toBe('### ### ###')
  })

  it('豁免后“该短语有效命中次数”只减豁免数；豁免数可到命中总数', () => {
    const { snapshot } = load('aaaa', ['aa']) // 命中 0,1,2 共 3 次
    let s = addExemption(snapshot, 0, 0)
    s = addExemption(s, 0, 1)
    expect(s.result.counts[0]).toBe(1)
    s = addExemption(s, 0, 2)
    expect(s.result.counts[0]).toBe(0)
    // 全部豁免：无覆盖
    expect(s.result.masked).toBe('aaaa')
    expect(s.result.coveredCount).toBe(0)
    expectCoherent(s, null)
  })

  it('豁免不抹掉其他短语在同一区域的遮蔽（嵌套 / 交叠）', () => {
    const { snapshot } = load('abcdef', ['abc', 'bc'])
    const ex = addExemption(snapshot, 0, 0) // 豁免 'abc'
    // 'bc' 仍覆盖位置 1..2
    expect(ex.result.masked).toBe('a##def')
    expect(ex.result.counts[0]).toBe(0) // abc 唯一命中被豁免
    expect(ex.result.counts[1]).toBe(1) // bc 计数不受影响
    expectCoherent(ex, null)
  })
})

describe('单次豁免：无效位置一律 INVALID_EXEMPTION 且不重算', () => {
  function loadBase() {
    return load('abc abc\nabc', ['abc'])
  }

  it('非整数 / 越界下标 / 负数起点 / 非命中位置', () => {
    const { snapshot } = loadBase()
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, -1))
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, 11))
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, 100))
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, 1.5))
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, NaN))
    // 文本中有 'abc' 出现，但位置 1 不是起始完整命中（中间字符）
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, 1))
    // 起区间越过文本末尾（start=8 处 'abc' 到 10，合法；start=9 则越界）
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, 9))
    // 条目下标越界
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 5, 0))
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, -1, 0))
  })

  it('骑跨换行的起点与区间：短语不含换行，出现换行即非同一行完整命中', () => {
    const { snapshot } = loadBase() // 'abc abc\nabc'，换行在位置 7
    // 换行位置本身不能作为起点
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, 7))
    // 位置 8 是第二行行首的真实命中，合法
    const ok = addExemption(snapshot, 0, 8)
    expect(ok.exemptions).toEqual([{ entry: 0, start: 8 }])
  })

  it('停用条目不能豁免；重新启用后才可', () => {
    const { snapshot } = loadBase()
    const off = setPatternEnabled(snapshot, 0, false)
    expectError(INVALID_EXEMPTION, () => addExemption(off, 0, 0))
    const on = setPatternEnabled(off, 0, true)
    expect(() => addExemption(on, 0, 0)).not.toThrow()
  })

  it('同一命中重复豁免 → INVALID_EXEMPTION', () => {
    const { snapshot } = loadBase()
    const once = addExemption(snapshot, 0, 0)
    expectError(INVALID_EXEMPTION, () => addExemption(once, 0, 0))
    // 同词的另一处命中仍可豁免
    expect(() => addExemption(once, 0, 4)).not.toThrow()
  })

  it('无效豁免不触发重算：maskText 调用数不增加，旧快照保留', () => {
    const { snapshot } = loadBase()
    const calls = mockedMaskText.mock.calls.length
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, 1))
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, -1))
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 5, 0))
    expect(mockedMaskText.mock.calls.length).toBe(calls)
    expect(snapshot.exemptions).toEqual([])
  })
})

describe('单次豁免：总数硬上限', () => {
  it('达到 LIMITS.maxExemptions 后再登记 → LIMITS_EXCEEDED，旧快照保留', () => {
    // 文本为足够多的 'a'，短语 'a' 在每个位置命中；豁免按起点计数
    const n = LIMITS.maxExemptions + 10
    const { snapshot } = loadSession(file('a'.repeat(n), ['a']))
    let s = snapshot
    for (let i = 0; i < LIMITS.maxExemptions; i++) s = addExemption(s, 0, i)
    expect(s.exemptions).toHaveLength(LIMITS.maxExemptions)
    expectCoherent(s, null)
    expectError(LIMITS_EXCEEDED, () => addExemption(s, 0, LIMITS.maxExemptions))
    // 被拒后数量不变
    expect(s.exemptions).toHaveLength(LIMITS.maxExemptions)
  })
})

describe('单次豁免：随短语修改 / 停用 / 删除清理与下标迁移', () => {
  it('修改短语值：该条豁免被清理（新短语不继承），其他条豁免保留', () => {
    const { snapshot } = load('abcXabc', ['abc', 'X'])
    const withEx = addExemption(snapshot, 0, 4) // 豁免第二处 abc
    const updated = updatePattern(withEx, 0, 'abcx') // 改值（文本中零命中）
    expect(updated.exemptions).toEqual([])
    expect(updated.result.counts[0]).toBe(0)
    expectCoherent(updated, null)

    // 其他条豁免保留：给 X 加豁免，再改第 0 条
    const withTwo = addExemption(addExemption(snapshot, 0, 0), 1, 3)
    expect(withTwo.exemptions).toHaveLength(2)
    const upd = updatePattern(withTwo, 0, 'zzz')
    expect(upd.exemptions).toEqual([{ entry: 1, start: 3 }])
    expectCoherent(upd, null)
  })

  it('停用清理该条豁免；重新启用不恢复；其他条豁免与下标不动', () => {
    const { snapshot } = load('abcdef', ['abc', 'def'])
    let s = addExemption(snapshot, 0, 0)
    s = addExemption(s, 1, 3)
    expect(s.exemptions).toHaveLength(2)
    const off = setPatternEnabled(s, 0, false)
    expect(off.exemptions).toEqual([{ entry: 1, start: 3 }])
    expectCoherent(off, null)
    // 重新启用不恢复豁免
    const on = setPatternEnabled(off, 0, true)
    expect(on.exemptions).toEqual([{ entry: 1, start: 3 }])
    expectCoherent(on, null)
    // 停用另一条（下标 1）则其豁免也被清理，最终为空
    const off2 = setPatternEnabled(on, 1, false)
    expect(off2.exemptions).toEqual([])
    expectCoherent(off2, null)
  })

  it('删除：移除该条豁免，其后条目的豁免下标前移一位', () => {
    const { snapshot } = load('abc def ghi', ['abc', 'def', 'ghi'])
    let s = addExemption(snapshot, 0, 0)
    s = addExemption(s, 1, 4)
    s = addExemption(s, 2, 8)
    // 删除中间 'def'：其豁免消失，'ghi' 的豁免下标 2 → 1，start 不变
    const removed = removePattern(s, 1)
    expect(removed.entries.map((e) => e.value)).toEqual(['abc', 'ghi'])
    expect(removed.exemptions).toEqual([
      { entry: 0, start: 0 },
      { entry: 1, start: 8 },
    ])
    expectCoherent(removed, null)
    // 删除第一条：后续全部前移
    const removedFirst = removePattern(s, 0)
    expect(removedFirst.exemptions).toEqual([
      { entry: 0, start: 4 },
      { entry: 1, start: 8 },
    ])
    expectCoherent(removedFirst, null)
  })

  it('追加新短语：既有豁免原样保留（新条目在末尾，无旧豁免引用）', () => {
    const { snapshot } = load('abc', ['abc'])
    const withEx = addExemption(snapshot, 0, 0)
    const added = addPattern(withEx, 'xyz')
    expect(added.exemptions).toEqual([{ entry: 0, start: 0 }])
    expectCoherent(added, null)
  })
})

describe('单次豁免：采纳固化、放弃回滚、载入清空', () => {
  it('采纳固化当时豁免与遮蔽；之后继续增删豁免不改采纳稿，再次采纳才更新', () => {
    const { snapshot } = load('xxx xxx', ['xxx'])
    const d1 = adopt(addExemption(snapshot, 0, 0)) // 豁免第一处
    expect(d1.masked).toBe('xxx ###')
    expect(d1.exemptions).toEqual([{ entry: 0, start: 0 }])

    // 在工作快照上再豁免第二处：工作预览变，采纳稿不变
    const both = addExemption(addExemption(snapshot, 0, 0), 0, 4)
    expect(both.result.masked).toBe('xxx xxx')
    expect(d1.masked).toBe('xxx ###')
    expect(d1.exemptions).toEqual([{ entry: 0, start: 0 }])

    const d2 = adopt(both)
    expect(d2.masked).toBe('xxx xxx')
    expect(d2.exemptions).toHaveLength(2)
  })

  it('放弃：有采纳稿时回滚到采纳时的短语与豁免并从原文重算', () => {
    const { snapshot } = load('xxx xxx xxx', ['xxx'])
    const adopted = addExemption(snapshot, 0, 0)
    const d = adopt(adopted)
    // 继续：再加两处豁免并新增短语
    let s = addExemption(adopted, 0, 4)
    s = addPattern(s, 'yyy')
    expect(s.exemptions).toHaveLength(2)
    const rolled = rollback(snapshot.text, d.entries, d.exemptions)
    expect(rolled.entries.map((e) => e.value)).toEqual(['xxx'])
    expect(rolled.exemptions).toEqual([{ entry: 0, start: 0 }])
    expect(rolled.result.masked).toBe('xxx ### ###')
    expectCoherent(rolled, null)
  })

  it('放弃：无采纳稿时回到载入态（豁免清空）', () => {
    const { session, snapshot } = load('xxx xxx', ['xxx'])
    addExemption(snapshot, 0, 0)
    const rolled = rollback(session.text, session.initial, [])
    expect(rolled.exemptions).toEqual([])
    expect(rolled.result.masked).toBe('### ###')
  })

  it('载入新文本：旧豁免全部清空（由页面以全新会话替换；loadSession 恒为空豁免）', () => {
    const first = loadSession(file('abc', ['abc']))
    expect(first.snapshot.exemptions).toEqual([])
    const withEx = addExemption(first.snapshot, 0, 0)
    expect(withEx.exemptions).toHaveLength(1)
    // 载入另一份合法文件：得到的新会话豁免为空
    const second = loadSession(file('zzz', ['zzz']))
    expect(second.snapshot.exemptions).toEqual([])
    expect(second.snapshot.text).toBe('zzz')
  })
})

describe('单次豁免：故障注入与工具函数', () => {
  it('登记豁免时重算抛错 → COUNT_FAILED，豁免与上次预览/采纳稿保留', () => {
    const { snapshot } = load('abc abc', ['abc'])
    const d = adopt(snapshot)
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom during exemption recompute')
    })
    expectError(COUNT_FAILED, () => addExemption(snapshot, 0, 0))
    expect(snapshot.exemptions).toEqual([])
    expect(snapshot.result.masked).toBe('### ###')
    expect(d.masked).toBe('### ###')
    // 恢复后登记成功
    const ok = addExemption(snapshot, 0, 0)
    expect(ok.exemptions).toEqual([{ entry: 0, start: 0 }])
    expect(ok.result.masked).toBe('abc ###')
  })

  it('toExemptionRefs：工作集下标→启用序列下标，停用项被剔除，重复去重', () => {
    const entries: PatternEntry[] = [
      { value: 'a', enabled: true },
      { value: 'b', enabled: false },
      { value: 'c', enabled: true },
    ]
    const refs = toExemptionRefs(entries, [
      { entry: 0, start: 3 },
      { entry: 2, start: 7 },
      { entry: 1, start: 9 }, // 停用：剔除
      { entry: 0, start: 3 }, // 重复：去重
    ])
    expect(refs).toEqual([
      { pattern: 0, start: 3 },
      { pattern: 1, start: 7 }, // 'c' 是启用序列第 1 条
    ])
  })

  it('sameExemptions 作为无序集合比较；exemptionsByEntry 按下标计数且停用为 0', () => {
    const a: Exemption[] = [
      { entry: 0, start: 1 },
      { entry: 1, start: 2 },
    ]
    expect(sameExemptions(a, [{ entry: 1, start: 2 }, { entry: 0, start: 1 }])).toBe(true)
    expect(sameExemptions(a, [{ entry: 0, start: 1 }])).toBe(false)
    expect(sameExemptions(a, [
      { entry: 0, start: 1 },
      { entry: 1, start: 99 },
    ])).toBe(false)
    const entries: PatternEntry[] = [
      { value: 'a', enabled: true },
      { value: 'b', enabled: false },
      { value: 'c', enabled: true },
    ]
    expect(exemptionsByEntry(entries, a)).toEqual([1, 0, 0])
    const withC: Exemption[] = [
      { entry: 0, start: 1 },
      { entry: 2, start: 5 },
    ]
    expect(exemptionsByEntry(entries, withC)).toEqual([1, 0, 1])
  })

  it('重算故障时无效位置不进入重算（先校验后重算）', () => {
    const { snapshot } = load('abc', ['abc'])
    const calls = mockedMaskText.mock.calls.length
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('should not be called')
    })
    expectError(INVALID_EXEMPTION, () => addExemption(snapshot, 0, 2))
    // 校验在重算之前：mock 未被消耗
    expect(mockedMaskText.mock.calls.length).toBe(calls)
  })
})
