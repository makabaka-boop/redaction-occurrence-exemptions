/**
 * 单次豁免的核心算法验收。
 *
 * 预言机与生产实现完全无关：逐条短语用 indexOf 逐位置枚举**全部完整命中**
 * （允许自重叠、不跨换行），把“未被豁免”的命中区间写进差分数组求覆盖
 * 并集；每条短语的有效命中次数 = 其全部命中数 − 落在豁免集合内的命中数。
 * 预期一律在运行时由此生成，不使用任何写死的遮蔽串。
 *
 * 覆盖点（对应需求逐条）：
 * - 只放过指定的这一次命中，同词其他位置仍遮蔽；
 * - 豁免某命中不抹掉其他短语在同一区域的遮蔽（重叠 / 嵌套）；
 * - 自重叠命中可逐个豁免（aaaa + aa 的 0/1/2 号命中）；
 * - 同终点命中（长词与短后缀在同一位置结束）正确分流；
 * - 不跨换行：骑界位置不可豁免，行内位置正常；
 * - 无效位置（非整数 / 越界 / 换行 / 不是命中 / 下标越界 / 重复）防御性忽略；
 * - 无豁免流程与原 maskText(text, patterns) 逐位相同（回归）；
 * - 密集命中（大量豁免）结果仍与预言机一致。
 */
import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  maskText,
  type ExemptionHit,
} from './masker'

// ---------------------------------------------------------------------------
// 预言机：枚举全部命中，按豁免集合剔除后再求覆盖并集与有效计数
// ---------------------------------------------------------------------------

interface OracleResult {
  masked: string
  coveredCount: number
  counts: number[]
  /** 真实生效（命中确实存在）的豁免数，按启用短语顺序 */
  exemptCounts: number[]
}

function oracleWithExemptions(
  text: string,
  patterns: readonly string[],
  exemptions: ReadonlySet<string>,
): OracleResult {
  const delta = new Int32Array(text.length + 1)
  const counts = patterns.map(() => 0)
  const exemptCounts = patterns.map(() => 0)
  patterns.forEach((p, k) => {
    let from = 0
    for (;;) {
      const idx = text.indexOf(p, from)
      if (idx === -1) break
      counts[k]++
      if (exemptions.has(`${k}:${idx}`)) {
        exemptCounts[k]++
      } else {
        delta[idx] += 1
        delta[idx + p.length] -= 1
      }
      from = idx + 1
    }
  })
  const cover = new Uint8Array(text.length)
  let open = 0
  let coveredCount = 0
  for (let i = 0; i < text.length; i++) {
    open += delta[i]
    if (open > 0) {
      cover[i] = 1
      coveredCount++
    }
  }
  let masked = ''
  for (let i = 0; i < text.length; i++) masked += cover[i] === 1 ? '#' : text[i]
  return {
    masked,
    coveredCount,
    counts: counts.map((c, k) => c - exemptCounts[k]),
    exemptCounts,
  }
}

function keySet(list: ReadonlyArray<readonly [number, number]>): Set<string> {
  return new Set(list.map(([k, s]) => `${k}:${s}`))
}

function expectMatchesOracle(
  text: string,
  patterns: readonly string[],
  exemptList: ReadonlyArray<readonly [number, number]>,
) {
  const exemptions: ExemptionHit[] = exemptList.map(([pattern, start]) => ({ pattern, start }))
  const result = maskText(text, patterns, exemptions)
  const expected = oracleWithExemptions(text, patterns, keySet(exemptList))
  expect(result.masked).toBe(expected.masked)
  expect(result.masked.length).toBe(text.length)
  expect(result.coveredCount).toBe(expected.coveredCount)
  expect(result.counts.length).toBe(patterns.length)
  expect(result.exemptCounts.length).toBe(patterns.length)
  for (let k = 0; k < patterns.length; k++) {
    expect(result.counts[k]).toBe(expected.counts[k])
    expect(result.exemptCounts[k]).toBe(expected.exemptCounts[k])
  }
  // 长度守恒 + 非 # 原位保留
  for (let i = 0; i < text.length; i++) {
    if (result.masked[i] !== '#') expect(result.masked[i]).toBe(text[i])
  }
}

// 确定性伪随机（固定种子，可复现）
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 预言机枚举某条短语的全部命中起点（供测试挑选“第 j 个命中”）。 */
function hitStarts(text: string, p: string): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const idx = text.indexOf(p, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + 1
  }
  return out
}

describe('单次豁免：朴素逐项枚举预言机一致性', () => {
  it('只放过指定的一次命中，同词其他位置仍遮蔽', () => {
    const text = 'abc xx abc yy abc' // abc 起点 0 / 7 / 14
    const patterns = ['abc']
    const hits = hitStarts(text, 'abc')
    expect(hits).toEqual([0, 7, 14])
    // 豁免中间那次：两端仍是 #，中间还原
    expectMatchesOracle(text, patterns, [[0, hits[1]]])
    // 豁免第一次 / 最后一次
    expectMatchesOracle(text, patterns, [[0, hits[0]]])
    expectMatchesOracle(text, patterns, [[0, hits[2]]])
    // 豁免两次（仍留一次）
    expectMatchesOracle(text, patterns, [[0, hits[0]], [0, hits[2]]])
    // 全部三次豁免：该词不再遮蔽任何位置
    expectMatchesOracle(text, patterns, hits.map((s): [number, number] => [0, s]))
  })

  it('自重叠：aaaa 对 aa 的三个命中可逐个豁免，计数随之递减', () => {
    const text = 'aaaa'
    const patterns = ['aa']
    const hits = hitStarts(text, 'aa')
    expect(hits).toEqual([0, 1, 2])
    expectMatchesOracle(text, patterns, []) // 3 次、全覆盖
    expectMatchesOracle(text, patterns, [[0, 0]])
    expectMatchesOracle(text, patterns, [[0, 1]])
    expectMatchesOracle(text, patterns, [[0, 2]])
    expectMatchesOracle(text, patterns, [[0, 0], [0, 2]])
    // 三个自重叠命中全部豁免：覆盖并集为空，原文还原
    expectMatchesOracle(text, patterns, [[0, 0], [0, 1], [0, 2]])
    const r = maskText(text, patterns, [{ pattern: 0, start: 0 }, { pattern: 0, start: 1 }, { pattern: 0, start: 2 }])
    expect(r.masked).toBe('aaaa')
    expect([...r.counts]).toEqual([0])
    expect([...r.exemptCounts]).toEqual([3])
  })

  it('豁免长词命中，嵌套在其中的短词命中仍遮蔽（同终点 + 不同终点）', () => {
    const text = 'abcdef'
    // 'abcdef'(0..5) 与 'bc'(1..2)、'cde'(2..4) 交叠嵌套
    const patterns = ['abcdef', 'bc', 'cde']
    // 豁免整条长词：短词区间仍盖
    expectMatchesOracle(text, patterns, [[0, 0]])
    // 豁免短词 'bc'：长词仍全覆盖
    expectMatchesOracle(text, patterns, [[1, 1]])
    // 豁免长词 + 'cde'，只剩 'bc'
    expectMatchesOracle(text, patterns, [[0, 0], [2, 2]])
    // 三者同区域全豁免：各自区间还原
    expectMatchesOracle(text, patterns, [[0, 0], [1, 1], [2, 2]])
  })

  it('同终点命中：长词豁免后短后缀在该终点保留遮蔽，反之亦然', () => {
    const text = 'xxabcd'
    // 'abcd' 与 'cd' 都在位置 5 结束；'d' 也在 5 结束
    const patterns = ['abcd', 'cd', 'd']
    // 豁免最长者：cd/d 的遮蔽在尾部保留
    expectMatchesOracle(text, patterns, [[0, 2]])
    // 豁免 'cd'：abcd 仍覆盖全部
    expectMatchesOracle(text, patterns, [[1, 4]])
    // 豁免 abcd 与 cd，只留 d
    expectMatchesOracle(text, patterns, [[0, 2], [1, 4]])
    // 同终点三者全豁免：尾部还原
    expectMatchesOracle(text, patterns, [[0, 2], [1, 4], [2, 5]])
  })

  it('自重叠 + 嵌套混合：a^6 上 a^k 短语的任意豁免组合', () => {
    const text = 'aaaaaa'
    const patterns = ['a', 'aa', 'aaa', 'aaaa', 'aaaaa', 'aaaaaa']
    const cases: number[][] = [
      [0], // 豁免 'a' 在 0 处（但更长词仍覆盖，遮蔽不变）
      [5, 0], // 豁免最长命中（起点 0）
      [1, 0], [1, 1], // 豁免 aa 的部分自重叠命中
      [2, 0], [2, 2], [2, 4], // aaa 的三个命中
    ]
    for (const c of cases) {
      const list: Array<[number, number]> = []
      for (let i = 0; i < c.length; i += 2) list.push([c[i], c[i + 1]])
      expectMatchesOracle(text, patterns, list)
    }
    // 每个短语只豁免其“中间”那个自重叠命中
    expectMatchesOracle(
      text,
      patterns,
      patterns.map((_, k): [number, number] => [k, k === 0 ? 2 : 1]),
    )
  })

  it('部分重叠的等长命中（abc / bca / cab）逐个豁免', () => {
    const text = 'abcabcabc'
    const patterns = ['abc', 'bca', 'cab']
    const starts0 = hitStarts(text, 'abc')
    expect(starts0).toEqual([0, 3, 6])
    expectMatchesOracle(text, patterns, [[0, 3]]) // 只豁免中间 abc
    expectMatchesOracle(text, patterns, [[1, 1]]) // bca 起点 1
    expectMatchesOracle(text, patterns, [[2, 2], [0, 6]]) // 组合
    // 全部命中枚举后各豁免一半（按起点奇偶）
    const half: Array<[number, number]> = []
    patterns.forEach((p, k) => {
      hitStarts(text, p).forEach((s) => {
        if (s % 2 === 0) half.push([k, s])
      })
    })
    expectMatchesOracle(text, patterns, half)
  })

  it('不跨换行：豁免不能放过骑界命中，行内命中照常', () => {
    const text = 'ab\nab'
    const patterns = ['ab']
    // 行内两次命中（0 与 3）均可豁免
    expectMatchesOracle(text, patterns, [[0, 0]])
    expectMatchesOracle(text, patterns, [[0, 3]])
    expectMatchesOracle(text, patterns, [[0, 0], [0, 3]])
    // 骑界“命中”从位置 1 起（'b\na'）不存在：防御性忽略，遮蔽不变
    expectMatchesOracle(text, patterns, [[0, 1]])
    // 起点落在换行测（2）：不是命中
    expectMatchesOracle(text, patterns, [[0, 2]])
  })

  it('多段文本：豁免某行的命中不影响其他行的同词命中', () => {
    const rng = mulberry32(0x1234)
    const lines = Array.from({ length: 4 }, () => {
      let s = ''
      for (let i = 0; i < 12; i++) s += 'ab'[Math.floor(rng() * 2)]
      return s
    })
    const text = lines.join('\n')
    const patterns = ['ab', 'aba', 'b']
    // 每段各挑第一个命中豁免
    const list: Array<[number, number]> = []
    patterns.forEach((p, k) => {
      const hs = hitStarts(text, p)
      if (hs.length) list.push([k, hs[0]])
      if (hs.length > 2) list.push([k, hs[2]])
    })
    expectMatchesOracle(text, patterns, list)
  })

  it('随机性质测试：随机文本/短语/豁免组合与逐项枚举预言机一致', () => {
    const rng = mulberry32(0xe8e)
    const alphabet = 'abc' // 小字母表 → 密集重叠命中
    for (let round = 0; round < 300; round++) {
      const len = 1 + Math.floor(rng() * 40)
      let text = ''
      for (let i = 0; i < len; i++) {
        if (rng() < 0.12) text += '\n'
        else text += alphabet[Math.floor(rng() * alphabet.length)]
      }
      const patSet = new Set<string>()
      const pc = 1 + Math.floor(rng() * 5)
      for (let i = 0; i < pc; i++) {
        const pl = 1 + Math.floor(rng() * 4)
        let p = ''
        for (let j = 0; j < pl; j++) p += alphabet[Math.floor(rng() * alphabet.length)]
        patSet.add(p)
      }
      const patterns = [...patSet]
      // 从真实命中里随机挑豁免（再掺几个无效位置）
      const list: Array<[number, number]> = []
      patterns.forEach((p, k) => {
        const hs = hitStarts(text, p)
        for (const s of hs) if (rng() < 0.4) list.push([k, s])
      })
      for (let q = 0; q < 3; q++) {
        list.push([Math.floor(rng() * patterns.length), Math.floor(rng() * (text.length + 4))])
      }
      expectMatchesOracle(text, patterns, list)
    }
  })

  it('无效豁免一律防御性忽略（非整数/越界/下标越界/重复/对象畸形）', () => {
    const text = 'abcabc'
    const patterns = ['abc']
    const baseline = maskText(text, patterns)
    const r = maskText(text, patterns, [
      { pattern: 0, start: -1 },
      { pattern: 0, start: 6 }, // end 越界（6+3 > 6）
      { pattern: 0, start: 1 }, // 该处不是完整命中
      { pattern: 1, start: 0 }, // 短语下标越界
      { pattern: -1, start: 0 },
      // @ts-expect-error 故意畸形
      { pattern: 0 },
      // @ts-expect-error 故意畸形
      { start: 0 },
      { pattern: 0.5, start: 0 },
      { pattern: 0, start: 1.5 },
    ])
    expect(r.masked).toBe(baseline.masked)
    expect(r.coveredCount).toBe(baseline.coveredCount)
    expect([...r.counts]).toEqual([...baseline.counts])
    expect([...r.exemptCounts]).toEqual([0])

    // 重复豁免同一命中：只生效一次（幂等），计数只减一
    const once = maskText(text, patterns, [{ pattern: 0, start: 0 }])
    const twice = maskText(text, patterns, [
      { pattern: 0, start: 0 },
      { pattern: 0, start: 0 },
    ])
    expect(twice.masked).toBe(once.masked)
    expect([...twice.counts]).toEqual([...once.counts])
    expect([...twice.exemptCounts]).toEqual([1])
  })

  it('无豁免回归：与原双参调用逐位相同（空数组/undefined/空命中集）', () => {
    const cases: Array<[string, string[]]> = [
      ['aaaa', ['a', 'aa', 'aaa']],
      ['abcabcabc', ['abc', 'bca', 'cab']],
      ['ab\nab', ['ab', 'a']],
      ['', ['a']],
      ['abc', []],
    ]
    for (const [text, patterns] of cases) {
      const plain = maskText(text, patterns)
      for (const ex of [undefined, []] as const) {
        const r = maskText(text, patterns, ex)
        expect(r.masked).toBe(plain.masked)
        expect(r.coveredCount).toBe(plain.coveredCount)
        expect([...r.counts]).toEqual([...plain.counts])
        expect([...r.exemptCounts]).toEqual(new Array(patterns.length).fill(0))
      }
    }
  })

  it('空文本 / 空启用集：豁免不产生效果，结构正确', () => {
    expect(maskText('', ['a'], [{ pattern: 0, start: 0 }]).masked).toBe('')
    const r = maskText('abc', [], [])
    expect(r.masked).toBe('abc')
    expect(r.exemptCounts).toHaveLength(0)
  })
})

describe('单次豁免：密集命中与长文本', () => {
  it('密集自重叠：a 长游程上大量豁免（每条短语豁免多处）仍与预言机一致', () => {
    const run = 400
    const text = 'a'.repeat(run) + '\n' + 'a'.repeat(run)
    const patterns: string[] = []
    for (let len = 1; len <= 60; len++) patterns.push('a'.repeat(len))

    // 每 7 个命中豁免 1 个（每条约 run/7 个，总量仍远低于上界）
    const list: Array<[number, number]> = []
    patterns.forEach((p, k) => {
      const hs = hitStarts(text, p)
      for (let j = 0; j < hs.length; j += 7) list.push([k, hs[j]])
    })
    expect(list.length).toBeGreaterThan(1000)
    expectMatchesOracle(text, patterns, list)
  })

  it('密集嵌套：每个终点豁免“次长”匹配，最长与更短匹配的遮蔽分流正确', () => {
    const text = 'a'.repeat(300)
    const patterns: string[] = []
    for (let len = 1; len <= 200; len++) patterns.push('a'.repeat(len))
    // 对每个终点 i（≥2），豁免恰在该点结束的若干个长度（i-1 号短语等），
    // 逼出同终点失败链上的逐段分流
    const list: Array<[number, number]> = []
    for (let i = 2; i < 260; i++) {
      // 豁免在 i 处结束的长度 (i 偶) 或 (i-1)（i 奇）对应的短语
      const lenA = Math.min(i + 1, 200)
      list.push([lenA - 1, i - lenA + 1])
      if (i >= 3) {
        const lenB = Math.min(i - 1, 200)
        if (lenB >= 1) list.push([lenB - 1, i - lenB + 1])
      }
    }
    expectMatchesOracle(text, patterns, list)
  })

  it('满规模两百万 a + 1..200 短语 + 5,000 豁免：3 秒内完成', () => {
    const n = LIMITS.maxTextCodeUnits
    const text = 'a'.repeat(n)
    const patterns: string[] = []
    for (let len = 1; len <= 200; len++) patterns.push('a'.repeat(len))
    // 5,000 个豁免散布在不同短语 / 起点
    const exemptions: ExemptionHit[] = []
    for (let q = 0; q < 5000; q++) {
      const k = q % 200
      const start = Math.floor((q * 7919) % (n - 200))
      exemptions.push({ pattern: k, start })
    }
    const t0 = Date.now()
    const result = maskText(text, patterns, exemptions)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(result.masked.length).toBe(n)
    // 豁免命中都真实存在（a^k 在任何 start≤n-k 处命中），故全部生效
    let totalEx = 0
    for (const c of result.exemptCounts) totalEx += c
    expect(totalEx).toBe(5000)
    // 长度 1 的 'a' 被豁免的位置确实露出原文
    const aExStarts = new Set(
      exemptions.filter((h) => h.pattern === 0).map((h) => h.start),
    )
    for (const s of aExStarts) {
      // 注意：更长短语可能仍覆盖 s；s 露出当且仅当没有任何未豁免匹配覆盖。
      // 这里只校验长度守恒与计数范围，精确覆盖由上方小文本预言机测试负责。
      expect(result.masked[s] === '#' || result.masked[s] === 'a').toBe(true)
    }
    for (let k = 0; k < 200; k++) {
      expect(result.counts[k]).toBe(n - (k + 1) + 1 - result.exemptCounts[k])
    }
  })
})
