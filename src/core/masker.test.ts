import { describe, expect, it } from 'vitest'
import {
  INVALID_INPUT,
  INVALID_PATTERN,
  LIMITS_EXCEEDED,
  LIMITS,
  MaskError,
  addEntry,
  assertWorksetLimits,
  buildAutomaton,
  checkPatternValue,
  maskText,
  parseInput,
  removeEntry,
  toggleEntry,
  updateEntry,
  type PatternEntry,
} from './masker'

// ---------------------------------------------------------------------------
// 朴素预言机：直接按定义做。故意写成最直白、与实现无关的方式：对每条短语
// indexOf 逐位置找出全部完整匹配（允许重叠），再取覆盖区间的并集。
// 区间用差分数组累加（O(命中数 + |text|)，仍完全独立于生产实现），
// 预期值一律在运行时由此生成，不提交任何固定结果文件。
// ---------------------------------------------------------------------------
function oracleCoverage(text: string, patterns: readonly string[]): Uint8Array {
  const delta = new Int32Array(text.length + 1)
  for (const p of patterns) {
    if (p.length === 0) continue
    let from = 0
    for (;;) {
      const idx = text.indexOf(p, from)
      if (idx === -1) break
      delta[idx] += 1
      delta[idx + p.length] -= 1
      from = idx + 1 // 允许重叠，逐位置推进
    }
  }
  const cover = new Uint8Array(text.length)
  let open = 0
  for (let i = 0; i < text.length; i++) {
    open += delta[i]
    cover[i] = open > 0 ? 1 : 0
  }
  return cover
}

function oracleMask(text: string, patterns: readonly string[]): string {
  const cover = oracleCoverage(text, patterns)
  let out = ''
  for (let i = 0; i < text.length; i++) out += cover[i] === 1 ? '#' : text[i]
  return out
}

function oracleCoveredCount(text: string, patterns: readonly string[]): number {
  const cover = oracleCoverage(text, patterns)
  let n = 0
  for (const b of cover) if (b === 1) n++
  return n
}

// 独立计数预言机：与生产实现完全无关地对**每条**短语用 indexOf 逐位置
// 枚举完整匹配（from = idx + 1 → 允许自重叠）。indexOf 天然区分大小写，
// 且短语不含换行，故绝不会匹配跨换行的出现——与约定逐条对应。
function oracleCounts(text: string, patterns: readonly string[]): number[] {
  return patterns.map((p) => {
    let n = 0
    let from = 0
    for (;;) {
      const idx = text.indexOf(p, from)
      if (idx === -1) break
      n++
      from = idx + 1
    }
    return n
  })
}

/** 逐行计数预言机：显式在每个换行处切开，进一步坐实“不跨换行”。 */
function oracleCountsPerLine(text: string, patterns: readonly string[]): number[] {
  const lines = text.split('\n')
  return patterns.map((p) => {
    let n = 0
    for (const line of lines) {
      let from = 0
      for (;;) {
        const idx = line.indexOf(p, from)
        if (idx === -1) break
        n++
        from = idx + 1
      }
    }
    return n
  })
}

/** counts（Uint32Array）与预言机数组按启用短语顺序逐位相同。 */
function expectCounts(result: { counts: ArrayLike<number> }, expected: readonly number[]): void {
  expect(result.counts.length).toBe(expected.length)
  for (let k = 0; k < expected.length; k++) {
    expect(result.counts[k]).toBe(expected[k])
  }
}

// 确定性伪随机（固定种子，保证可复现，但仍非固定结果）
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

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.'

function randomString(rng: () => number, maxLen: number, alphabet = ALPHA): string {
  const len = 1 + Math.floor(rng() * maxLen)
  let s = ''
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)]
  return s
}

function expectMaskError(code: string, fn: () => unknown): void {
  try {
    fn()
    throw new Error('应当抛出异常')
  } catch (e) {
    expect(e).toBeInstanceOf(MaskError)
    expect((e as MaskError).code).toBe(code)
  }
}

describe('朴素预言机一致性（随机性质测试）', () => {
  it('随机文本 + 随机短语，覆盖并集与预言机逐字符相同', () => {
    const rng = mulberry32(0xc0ffee)
    for (let round = 0; round < 200; round++) {
      const text = randomString(rng, 120)
      const count = 1 + Math.floor(rng() * 20)
      const patterns = new Set<string>()
      for (let i = 0; i < count; i++) {
        patterns.add(randomString(rng, 1 + Math.floor(rng() * 8)))
      }
      const list = [...patterns]
      const result = maskText(text, list)
      expect(result.masked).toBe(oracleMask(text, list))
      expect(result.coveredCount).toBe(oracleCoveredCount(text, list))
      expectCounts(result, oracleCounts(text, list))
    }
  })

  it('含换行：匹配不跨换行，且与逐行预言机一致', () => {
    const rng = mulberry32(0xbeef)
    for (let round = 0; round < 100; round++) {
      const lines: string[] = []
      const lineCount = 1 + Math.floor(rng() * 5)
      for (let i = 0; i < lineCount; i++) lines.push(randomString(rng, 40))
      const text = lines.join('\n')
      const patterns = new Set<string>()
      for (let i = 0; i < 8; i++) patterns.add(randomString(rng, 6))
      // 再注入会“骑”在换行两侧的短语：预言机 indexOf 同样不会命中含换行结构，
      // 因为短语不含换行；这里专门构造跨行拼接词，确保两边都不误伤。
      patterns.add(lines[0].slice(-2) + lines[Math.min(1, lineCount - 1)].slice(0, 2))
      patterns.delete('')
      const list = [...patterns]
      const result = maskText(text, list)
      expect(result.masked).toBe(oracleMask(text, list))
      // 计数同样不跨换行：全文 indexOf（短语不含换行，天然不跨行）
      expectCounts(result, oracleCounts(text, list))
      // 与“逐行切开后分别计数”的预言机完全一致——显式坐实换行边界
      expectCounts(result, oracleCountsPerLine(text, list))
      // 换行永远原样保留
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 0x0a) expect(result.masked[i]).toBe('\n')
      }
    }
  })

  it('区分大小写：仅大小写不同的短语彼此独立', () => {
    const text = 'abc ABC Abc aBc'
    const patterns = ['abc', 'ABC']
    const result = maskText(text, patterns)
    expect(result.masked).toBe(oracleMask(text, patterns))
    // 仅前两个 token 被遮蔽：遮蔽数与预言机统计一致
    expect(result.coveredCount).toBe(oracleCoveredCount(text, patterns))
  })

  it('大量嵌套与交叠：只取覆盖并集，不漏字符', () => {
    const rng = mulberry32(0xabad1dea)
    for (let round = 0; round < 50; round++) {
      // 共同前缀制造深嵌套：aaaa... 的每一种长度都作为短语
      const depth = 2 + Math.floor(rng() * 30)
      const patterns = new Set<string>()
      for (let len = 1; len <= depth; len++) patterns.add('a'.repeat(len))
      const text = 'a'.repeat(depth * 3) + ' b ' + 'a'.repeat(Math.floor(depth / 2))
      const list = [...patterns]
      const result = maskText(text, list)
      expect(result.masked).toBe(oracleMask(text, list))
      expect(result.coveredCount).toBe(oracleCoveredCount(text, list))
      // 深嵌套：每个 a 游程中长 L 的 a 短语出现次数为 run-L+1；indexOf 预言机
      // 在本规模（depth ≤ 31）仍然便宜，直接逐条核对自重叠计数
      expectCounts(result, oracleCounts(text, list))
    }
  })

  it('间隔重叠（先短后长、先长后短、部分相交、恰好相接）', () => {
    const cases: Array<[string, string[]]> = [
      ['abcdef', ['abc', 'cde']], // 在 c 处相交
      ['abcdef', ['bc', 'abcdef']], // 包含
      ['abcdef', ['abcdef', 'bc']],
      ['abcdef', ['ab', 'cd', 'ef']], // 恰好相接，全覆盖
      ['abcdef', ['ab', 'de']], // 不相交
      ['aaaaaa', ['aaa', 'aaa']], // 短语集合自动去重由调用方保证，这里单例
      ['aaaaaa', ['aa', 'aaa', 'aaaa']],
      ['abcabcabc', ['abc', 'bca', 'cab']],
    ]
    for (const [text, patternsRaw] of cases) {
      const patterns = [...new Set(patternsRaw)]
      const result = maskText(text, patterns)
      expect(result.masked).toBe(oracleMask(text, patterns))
      expect(result.coveredCount).toBe(oracleCoveredCount(text, patterns))
      // 长度与非换行原位保留不变
      expect(result.masked.length).toBe(text.length)
      for (let i = 0; i < text.length; i++) {
        if (result.masked[i] !== '#') expect(result.masked[i]).toBe(text[i])
      }
    }
  })

  it('空文本 / 空启用集 / 空数组等边界', () => {
    expect(maskText('', ['a']).masked).toBe('')
    expect(maskText('abc', []).masked).toBe('abc')
    expect(maskText('', []).masked).toBe('')
    const r = maskText('\n\n', ['a'])
    expect(r.masked).toBe('\n\n')
    expect(r.coveredCount).toBe(0)
    // 空文本零命中仍按启用短语顺序给出 0；空启用集计数数组长度为 0
    expectCounts(maskText('', ['a', 'aa']), [0, 0])
    expect(maskText('abc', []).counts).toHaveLength(0)
    expectCounts(r, [0])
  })
})

describe('完整匹配计数（自重叠 / 嵌套 / 顺序 / 换行边界）', () => {
  it('aaaa 对 a、aa、aaa 分别为 4、3、2（允许自重叠）', () => {
    const text = 'aaaa'
    // 验收点名断言：固定短语顺序下的自重叠完整匹配次数
    const result = maskText(text, ['a', 'aa', 'aaa'])
    expectCounts(result, [4, 3, 2])
    // 与独立 indexOf 预言机逐条一致
    expectCounts(result, oracleCounts(text, ['a', 'aa', 'aaa']))
  })

  it('计数与启用短语同序，重排短语后计数随之重排（值不依赖字典序）', () => {
    const text = 'aaaa'
    expectCounts(maskText(text, ['aaa', 'a', 'aa']), [2, 4, 3])
    expectCounts(maskText(text, ['aa', 'aaa', 'a']), [3, 2, 4])
  })

  it('零命中显示 0；计数不因别的短语命中而改变', () => {
    const result = maskText('aaaa', ['a', 'zzz'])
    expectCounts(result, [4, 0])
  })

  it('区分大小写：abc 与 ABC 分别计数', () => {
    const text = 'abc ABC abc'
    const result = maskText(text, ['abc', 'ABC', 'Abc'])
    expectCounts(result, [2, 1, 0])
    expectCounts(result, oracleCounts(text, ['abc', 'ABC', 'Abc']))
  })

  it('自重叠跨不同游程：aaaaa 对 aa、aaa 为 4、3', () => {
    const text = 'aaaaa'
    expectCounts(maskText(text, ['aa', 'aaa']), [4, 3])
  })

  it('不跨换行：骑在换行两侧的模式计数为 0，行内出现照常计数', () => {
    // 'ab' 恰好骑在 "ab|ab" 的换行上一次（跨行），行内另有两次
    const text = 'ab\nab'
    const r1 = maskText(text, ['ab'])
    expectCounts(r1, [2]) // 跨行的那次不算
    // 单字符模式不受换行影响，但换行位置本身绝不匹配
    expectCounts(maskText(text, ['a', 'b', '\n']), [2, 2, 0])
    // 三字符骑界：a + 换行 + a，'aa' 不可能跨行
    expectCounts(maskText('aaa\naaa', ['aaa', 'aa', 'a']), [2, 4, 6])
    // 与逐行预言机一致
    const pats = ['ab', 'a', 'b']
    expectCounts(maskText(text, pats), oracleCountsPerLine(text, pats))
  })

  it('分隔的多段游程计数为各段之和', () => {
    const text = 'aaa x aaaa'
    // 'aaa'：第一段 1 次，第二段（aaaa）自重叠 2 次 → 3
    // 'aa'：第一段 2 次，第二段 3 次 → 5
    expectCounts(maskText(text, ['aaa', 'aa']), [3, 5])
    expectCounts(maskText(text, ['aaa', 'aa']), oracleCounts(text, ['aaa', 'aa']))
  })

  it('相邻/包含模式互不干扰计数', () => {
    const text = 'abcabcabc'
    const patterns = ['abc', 'bca', 'cab']
    expectCounts(maskText(text, patterns), [3, 2, 2])
    expectCounts(maskText(text, patterns), oracleCounts(text, patterns))
  })
})

describe('高重叠长文本（朴素预言机对照）', () => {
  it('高重叠长文本：约 12 万代码单元 + 1..120 全嵌套命中，结果与预言机一致', () => {
    // 文本：a 的长游程被少量分隔符切开；短语为 1..120 的全部 a 游程，
    // 每个位置都有上百个嵌套命中——逐词搜索会被命中数拖垮。
    const rng = mulberry32(1234)
    const segment = 4000
    const parts: string[] = []
    for (let s = 0; s < 30; s++) {
      parts.push('a'.repeat(segment - 20 + Math.floor(rng() * 20)))
      if (s < 29) parts.push('\nB.\n')
    }
    const text = parts.join('')
    expect(text.length).toBeGreaterThan(100_000)
    const patterns: string[] = []
    for (let len = 1; len <= 120; len++) patterns.push('a'.repeat(len))
    patterns.push('B')

    const t0 = Date.now()
    const result = maskText(text, patterns)
    const fastMs = Date.now() - t0

    // 预言机在此规模仍可承受（indexOf + 区间差分，定长数组）
    expect(result.masked).toBe(oracleMask(text, patterns))
    expect(result.coveredCount).toBe(oracleCoveredCount(text, patterns))
    // 计数抽查（稀疏，避免对全部 120 条跑 indexOf 预言机）：每个 a 游程 r
    // 中长 L 的 a^L 出现 r-L+1 次，总和即全局计数；换行分隔不跨段。
    const runs = text.split('\nB.\n').map((s) => s.length)
    const total = runs.reduce((a, b) => a + b, 0)
    const aIndex = (len: number) => len - 1 // patterns[0..119] 即 a^1..a^120
    for (const L of [1, 2, 3, 60, 120]) {
      const expected = runs.reduce((sum, r) => sum + Math.max(0, r - L + 1), 0)
      expect(result.counts[aIndex(L)]).toBe(expected)
    }
    expect(total).toBeGreaterThan(100_000)
    // 'B' 是最后一条：30 段之间 29 个 '\nB.\n'，各含一个 B
    expect(result.counts[patterns.length - 1]).toBe(29)
    // 不按命中数展开的实现应远快于朴素全量命中计数式做法；
    // 断言一个宽松上界，防止实现退化为逐命中展开
    expect(fastMs).toBeLessThan(500)
  })

  it('对抗式失败链：长公共前缀 + 失配流，构建期不被重复行走拖垮', () => {
    const patterns: string[] = []
    for (let i = 0; i < 400; i++) {
      patterns.push('a'.repeat(199) + String.fromCharCode(65 + (i % 26)) + 'x'.repeat(i % 7))
    }
    const unique = [...new Set(patterns)].slice(0, LIMITS.maxPatterns)
    const textChunks: string[] = []
    for (let i = 0; i < 2000; i++) {
      textChunks.push('a'.repeat(198) + String.fromCharCode(97 + (i % 26)) + 'y')
    }
    const text = textChunks.join('')
    const t0 = Date.now()
    const result = maskText(text, unique)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(result.masked).toBe(oracleMask(text, unique))
  })
})

describe('三秒预览时限（满规模）', () => {
  it('2,000,000 代码单元 text 与大短语集，3 秒内完成且不按命中数展开', () => {
    const rng = mulberry32(20260918)
    const alphabet = 'abcde' // 小字母表 → 命中与重叠极其密集
    const codes = new Uint16Array(LIMITS.maxTextCodeUnits)
    for (let i = 0; i < codes.length; i++) {
      codes[i] = alphabet.charCodeAt(Math.floor(rng() * alphabet.length))
    }
    const parts: string[] = []
    for (let i = 0; i < codes.length; i += 0x8000) {
      parts.push(String.fromCharCode.apply(null, codes.subarray(i, i + 0x8000) as unknown as number[]))
    }
    const text = parts.join('')

    const patterns = new Set<string>()
    // 随机短词（密集命中）+ 一批嵌套长词 a^1..a^200
    while (patterns.size < 1500) patterns.add(randomString(rng, 6, alphabet))
    for (let len = 1; len <= 200; len++) patterns.add('a'.repeat(len))
    const list = [...patterns]

    const t0 = Date.now()
    const result = maskText(text, list)
    const ms = Date.now() - t0
    // 硬性验收：三秒内
    expect(ms).toBeLessThan(3000)
    // 结果长度守恒；除 # 外全部原位保留
    expect(result.masked.length).toBe(text.length)
    for (let i = 0; i < result.masked.length; i += 997) {
      const m = result.masked[i]
      if (m !== '#') expect(m).toBe(text[i])
    }
    expect(result.coveredCount).toBeGreaterThan(0)
    expect(result.coveredCount).toBeLessThanOrEqual(text.length)
    // 计数与遮蔽同一次扫描：a^L 在满规模随机文本上的次数也被顺带产出，
    // 这里只断言其范围合理且顺序对齐（a^1..a^200 排在 1500 随机词之后），
    // 精确值由下方纯 a 游程门槛测试与 indexOf 预言机测试负责。
    const aBase = list.findIndex((p) => p === 'a')
    for (let L = 1; L <= 200; L++) {
      const c = result.counts[aBase + (L - 1)]
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(text.length)
    }
  })

  it('两百万个 a 与长度 1..200 的 a 短语：3 秒内完成，计数为 n-L+1', () => {
    // 验收点名：最极端的全自重叠/全嵌套输入。每个位置都有 200 个嵌套命中，
    // 逐短语重扫或为命中分配对象都会爆炸；本实现只做一次扫描 + 一次逆向汇入。
    const n = LIMITS.maxTextCodeUnits // 2_000_000
    const text = 'a'.repeat(n)
    const patterns: string[] = []
    for (let len = 1; len <= 200; len++) patterns.push('a'.repeat(len))

    const t0 = Date.now()
    const result = maskText(text, patterns)
    const ms = Date.now() - t0
    // 硬性门槛
    expect(ms).toBeLessThan(3000)
    // 遮蔽：全覆盖为 #，长度守恒
    expect(result.masked.length).toBe(n)
    expect(result.coveredCount).toBe(n)
    // 计数：a^L 在 n 个 a 的游程中完整出现 n-L+1 次（允许自重叠）
    expect(result.counts.length).toBe(200)
    for (let L = 1; L <= 200; L++) {
      expect(result.counts[L - 1]).toBe(n - L + 1)
    }
    // 与独立 indexOf 预言机在短样本上同分布（2M 上 indexOf 仅对单条可承受）
    const small = 'a'.repeat(2000)
    expectCounts(maskText(small, patterns), oracleCounts(small, patterns))
  })
})

describe('输入校验：非法文件一律 INVALID_INPUT', () => {
  const valid = JSON.stringify({ text: 'abc', patterns: ['a'] })

  it('接受合法最小输入', () => {
    expect(parseInput(valid)).toEqual({ text: 'abc', patterns: ['a'] })
  })

  const invalidFiles = [
    '',
    'not json',
    '{',
    'null',
    '[]',
    '42',
    '"abc"',
    JSON.stringify({ text: 'abc' }),
    JSON.stringify({ patterns: ['a'] }),
    JSON.stringify({ text: 'abc', patterns: ['a'], extra: 1 }),
    JSON.stringify({ text: 1, patterns: ['a'] }),
    JSON.stringify({ text: 'abc', patterns: 'a' }),
    JSON.stringify({ text: 'abc', patterns: [] }),
    JSON.stringify({ text: 'abc', patterns: [1] }),
    JSON.stringify({ text: 'abc', patterns: ['a', 'a'] }),
    JSON.stringify({ text: 'abc', patterns: [''] }),
    JSON.stringify({ text: 'abc', patterns: ['x'.repeat(LIMITS.maxPatternLength + 1)] }),
    JSON.stringify({ text: 'abc', patterns: ['bad\n'] }),
    JSON.stringify({ text: 'abc', patterns: ['bad\t'] }),
    JSON.stringify({ text: 'line1\r\nline2', patterns: ['a'] }), // CR 非法
    JSON.stringify({ text: 'tab\there', patterns: ['a'] }),
    JSON.stringify({ text: 'café', patterns: ['a'] }), // 非 ASCII 非法
    JSON.stringify({ text: 'a b', patterns: ['a'] }), // 控制字符
  ]

  for (const f of invalidFiles) {
    it(`拒绝非法文件：${JSON.stringify(f).slice(0, 48)}`, () => {
      expectMaskError(INVALID_INPUT, () => parseInput(f))
    })
  }

  it('text 超过 2,000,000 代码单元 → INVALID_INPUT', () => {
    const text = 'x'.repeat(LIMITS.maxTextCodeUnits + 1)
    expectMaskError(INVALID_INPUT, () => parseInput(JSON.stringify({ text, patterns: ['a'] })))
  })

  it('patterns 超过 50,000 条 → INVALID_INPUT', () => {
    const patterns: string[] = []
    for (let i = 0; i < LIMITS.maxPatterns + 1; i++) patterns.push(`p${i}`)
    expectMaskError(INVALID_INPUT, () => parseInput(JSON.stringify({ text: 'a', patterns })))
  })

  it('短语总长超过 300,000 → INVALID_INPUT', () => {
    // 1501 条各不相同、各长 200 的短语 → 总长 300200
    const patterns: string[] = []
    for (let i = 0; i < 1501; i++) {
      patterns.push(`${i}`.padStart(7, '0') + 'x'.repeat(193))
    }
    expect(patterns.length).toBe(1501)
    expect(patterns.reduce((s, p) => s + p.length, 0)).toBeGreaterThan(
      LIMITS.maxTotalPatternLength,
    )
    expectMaskError(INVALID_INPUT, () => parseInput(JSON.stringify({ text: 'a', patterns })))
  })

  it('边界长度恰好合法', () => {
    const text = 'a'.repeat(LIMITS.maxTextCodeUnits)
    expect(() => parseInput(JSON.stringify({ text, patterns: ['a'] }))).not.toThrow()
  })

  it('checkPatternValue 拒绝非字符串/空串/超长/含换行', () => {
    expectMaskError(INVALID_PATTERN, () => checkPatternValue(''))
    expectMaskError(INVALID_PATTERN, () => checkPatternValue('x'.repeat(201)))
    expectMaskError(INVALID_PATTERN, () => checkPatternValue('ab\nc'))
    expectMaskError(INVALID_PATTERN, () => checkPatternValue(42))
    expect(() => checkPatternValue('ok -_~')).not.toThrow()
  })
})

describe('短语编辑：违规返回 INVALID_PATTERN 且不改动列表', () => {
  const base = (): PatternEntry[] => [
    { value: 'alpha', enabled: true },
    { value: 'beta', enabled: false },
  ]

  it('新增：合法追加且默认启用', () => {
    const next = addEntry(base(), 'gamma')
    expect(next).toEqual([
      { value: 'alpha', enabled: true },
      { value: 'beta', enabled: false },
      { value: 'gamma', enabled: true },
    ])
  })

  it('新增：空串 / 重复 / 超长 / 换行 → INVALID_PATTERN', () => {
    expectMaskError(INVALID_PATTERN, () => addEntry(base(), ''))
    expectMaskError(INVALID_PATTERN, () => addEntry(base(), 'alpha'))
    expectMaskError(INVALID_PATTERN, () => addEntry(base(), 'x'.repeat(LIMITS.maxPatternLength + 1)))
    expectMaskError(INVALID_PATTERN, () => addEntry(base(), 'ab\nc'))
  })

  it('大小写不同不算重复', () => {
    expect(() => addEntry(base(), 'ALPHA')).not.toThrow()
  })

  it('修改：重复 / 空 / 越界 → INVALID_PATTERN，原列表保持引用语义不变', () => {
    const b = base()
    expectMaskError(INVALID_PATTERN, () => updateEntry(b, 0, 'beta'))
    expectMaskError(INVALID_PATTERN, () => updateEntry(b, 0, ''))
    expectMaskError(INVALID_PATTERN, () => updateEntry(b, -1, 'z'))
    expectMaskError(INVALID_PATTERN, () => updateEntry(b, 2, 'z'))
    expect(updateEntry(b, 0, 'Alpha')[0].value).toBe('Alpha')
  })

  it('启停：越界 → INVALID_PATTERN；停用后不参与遮蔽', () => {
    const b: PatternEntry[] = [
      { value: 'alpha', enabled: true },
      { value: 'beta', enabled: true },
    ]
    expectMaskError(INVALID_PATTERN, () => toggleEntry(b, 5, true))
    const off = toggleEntry(b, 0, false)
    expect(off[0].enabled).toBe(false)
    const enabledValues = off.filter((e) => e.enabled).map((e) => e.value)
    const t = 'alpha beta'
    expect(maskText(t, enabledValues).masked).toBe(oracleMask(t, enabledValues))
  })

  it('删除：越界 → INVALID_PATTERN', () => {
    const b = base()
    expectMaskError(INVALID_PATTERN, () => removeEntry(b, 2))
    expect(removeEntry(b, 1).map((e) => e.value)).toEqual(['alpha'])
  })

  it('所有编辑均为不可变更新，不修改入参', () => {
    const b = base()
    const snapshot = JSON.stringify(b)
    addEntry(b, 'gamma')
    updateEntry(b, 0, 'ALPHA')
    toggleEntry(b, 0, false)
    removeEntry(b, 0)
    expect(JSON.stringify(b)).toBe(snapshot)
  })
})

describe('编辑聚合约束：与导入同源（数量 1..50,000、总长 ≤ 300,000）', () => {
  /** 生成 count 条等长（width 字符）、互不相同的合法短语。 */
  function fixedWidthPatterns(count: number, width: number): PatternEntry[] {
    const out: PatternEntry[] = []
    for (let i = 0; i < count; i++) {
      const tail = String(i).padStart(width - 1, '0')
      const value = 'p' + tail.slice(tail.length - (width - 1))
      out.push({ value, enabled: true })
    }
    // 等长构造必须确实互不相同且总长达标，否则用例本身无效
    expect(new Set(out.map((e) => e.value)).size).toBe(count)
    expect(out[0].value).toHaveLength(width)
    return out
  }

  /**
   * 卡在总长上界下方 1：1499 条长 200 + 一条长 199（共 1500 条，
   * 总长 299,999）。条目数远低于 50,000，因此本构造只逼近总长约束。
   */
  function nearTotalEntries(): PatternEntry[] {
    const out: PatternEntry[] = []
    for (let i = 0; i < 1499; i++) {
      out.push({ value: String(i).padStart(7, '0') + 'x'.repeat(193), enabled: true })
    }
    out.push({ value: 'y'.repeat(199), enabled: true })
    return out
  }

  function totalLen(entries: readonly PatternEntry[]): number {
    return entries.reduce((s, e) => s + e.value.length, 0)
  }

  it('assertWorksetLimits：恰在边界合法，越界按给定错误码拒绝', () => {
    expect(() =>
      assertWorksetLimits(LIMITS.maxPatterns, LIMITS.maxTotalPatternLength, LIMITS_EXCEEDED),
    ).not.toThrow()
    expect(() => assertWorksetLimits(LIMITS.minPatterns, 1, LIMITS_EXCEEDED)).not.toThrow()
    expectMaskError(LIMITS_EXCEEDED, () =>
      assertWorksetLimits(LIMITS.maxPatterns + 1, 1, LIMITS_EXCEEDED),
    )
    expectMaskError(LIMITS_EXCEEDED, () =>
      assertWorksetLimits(LIMITS.maxPatterns, LIMITS.maxTotalPatternLength + 1, LIMITS_EXCEEDED),
    )
    expectMaskError(LIMITS_EXCEEDED, () =>
      assertWorksetLimits(LIMITS.minPatterns - 1, 0, LIMITS_EXCEEDED),
    )
    // 同一处断言供导入路径使用 INVALID_INPUT
    expectMaskError(INVALID_INPUT, () =>
      assertWorksetLimits(LIMITS.maxPatterns + 1, 1, INVALID_INPUT),
    )
  })

  it('新增：恰好 50,000 条成功，第 50,001 条 → LIMITS_EXCEEDED', () => {
    // 6 字符等长：49,999 条总长 299,994；补 6 字符恰好落在双边界
    const entries = fixedWidthPatterns(LIMITS.maxPatterns - 1, 6)
    const atLimit = addEntry(entries, 'q'.repeat(6))
    expect(atLimit).toHaveLength(LIMITS.maxPatterns)
    expect(totalLen(atLimit)).toBe(LIMITS.maxTotalPatternLength)
    expectMaskError(LIMITS_EXCEEDED, () => addEntry(atLimit, 'z'.repeat(6)))
    // 被拒绝后候选不外泄，入参保持原样
    expect(entries).toHaveLength(LIMITS.maxPatterns - 1)
    expect(atLimit).toHaveLength(LIMITS.maxPatterns)
  })

  it('新增：数量不超（仍 50,000）但总长越过 300,000 → LIMITS_EXCEEDED（仅总长触发）', () => {
    // 49,999×6 = 299,994：加 6 字符合法（恰 300,000），加 7 字符总数仍为
    // 50,000（数量合法）但总长 300,001 → 纯粹的总长越界
    const entries = fixedWidthPatterns(LIMITS.maxPatterns - 1, 6)
    expect(totalLen(entries)).toBe(LIMITS.maxTotalPatternLength - 6)
    const atLimit = addEntry(entries, 'r'.repeat(6))
    expect(atLimit).toHaveLength(LIMITS.maxPatterns)
    expect(totalLen(atLimit)).toBe(LIMITS.maxTotalPatternLength)
    expectMaskError(LIMITS_EXCEEDED, () => addEntry(entries, 'r'.repeat(7)))
  })

  it('新增（数量有余）：49,999 条×6 时补 6 字符恰好双边界、补 7 字符纯总长越界', () => {
    const entries = fixedWidthPatterns(49_999, 6)
    expect(entries).toHaveLength(49_999)
    expect(totalLen(entries)).toBe(299_994)
    const atLimit = addEntry(entries, 'r'.repeat(6))
    expect(atLimit).toHaveLength(50_000)
    expect(totalLen(atLimit)).toBe(300_000)
    // 补 7 字符：数量仍 50,000（合法），总长 300,001 → 纯总长越界
    expectMaskError(LIMITS_EXCEEDED, () => addEntry(entries, 'r'.repeat(7)))
  })

  it('新增：1499×200 + 199（300,000-1，共 1500 条）时加 1 字符合法，加 2 字符 → LIMITS_EXCEEDED', () => {
    const entries = nearTotalEntries()
    expect(entries).toHaveLength(1500)
    expect(totalLen(entries)).toBe(LIMITS.maxTotalPatternLength - 1)
    const atLimit = addEntry(entries, 'z')
    expect(totalLen(atLimit)).toBe(LIMITS.maxTotalPatternLength)
    expectMaskError(LIMITS_EXCEEDED, () => addEntry(entries, 'zw'))
  })

  it('修改：把唯一的“短名额”补长使总长恰好 300,000 → 合法；再多 → LIMITS_EXCEEDED', () => {
    // 1499×200 + 一条 198 = 299,998（差 2 到上界，共 1500 条）
    const entries: PatternEntry[] = []
    for (let i = 0; i < 1499; i++) {
      entries.push({ value: String(i).padStart(7, '0') + 'x'.repeat(193), enabled: true })
    }
    entries.push({ value: 's'.repeat(198), enabled: true })
    expect(totalLen(entries)).toBe(LIMITS.maxTotalPatternLength - 2)
    const atLimit = updateEntry(entries, 1499, 't'.repeat(200))
    expect(totalLen(atLimit)).toBe(LIMITS.maxTotalPatternLength)
    // 从差 2 的快照把同一条也改成 200（与上面不同的值，避免“值未变”）同样合法；
    // 而改到 201 先被单条长度校验拦为 INVALID_PATTERN。真正越过总长只能靠新增。
    const alsoAtLimit = updateEntry(entries, 1499, 'u'.repeat(200))
    expect(totalLen(alsoAtLimit)).toBe(LIMITS.maxTotalPatternLength)
    expectMaskError(INVALID_PATTERN, () => updateEntry(entries, 1499, 'v'.repeat(201)))
    expectMaskError(LIMITS_EXCEEDED, () => addEntry(atLimit, 'z'))
  })

  it('删除：删除唯一短语 → LIMITS_EXCEEDED（空工作集永不成立）', () => {
    const only: PatternEntry[] = [{ value: 'alpha', enabled: true }]
    expectMaskError(LIMITS_EXCEEDED, () => removeEntry(only, 0))
    expect(only).toEqual([{ value: 'alpha', enabled: true }])
  })

  it('删除：两条删到一条合法（恰为最小数量）', () => {
    const two: PatternEntry[] = [
      { value: 'alpha', enabled: true },
      { value: 'beta', enabled: false },
    ]
    const one = removeEntry(two, 1)
    expect(one.map((e) => e.value)).toEqual(['alpha'])
  })

  it('启停：恰在 50,000 条上界停用 / 启用不触发聚合错误', () => {
    const entries = fixedWidthPatterns(LIMITS.maxPatterns, 6)
    expect(totalLen(entries)).toBe(LIMITS.maxTotalPatternLength)
    const off = toggleEntry(entries, 0, false)
    expect(off[0].enabled).toBe(false)
    const on = toggleEntry(off, 0, true)
    expect(on[0].enabled).toBe(true)
  })

  it('聚合错误优先于重算：所有越界编辑都是不可变更新，入参不被修改', () => {
    const only: PatternEntry[] = [{ value: 'alpha', enabled: true }]
    // 50,000×6 双边界：任何新增都越界（数量与总长同时）
    const full = fixedWidthPatterns(LIMITS.maxPatterns, 6)
    const nearCap = nearTotalEntries()
    for (const [label, fn] of [
      ['删唯一', () => removeEntry(only, 0)],
      ['新增超数量与总长', () => addEntry(full, 'z')],
      ['新增超总长', () => addEntry(nearCap, 'yz')],
    ] as const) {
      const target = label === '删唯一' ? only : label === '新增超数量与总长' ? full : nearCap
      const snapshot = JSON.stringify(target)
      expectMaskError(LIMITS_EXCEEDED, fn)
      expect(JSON.stringify(target)).toBe(snapshot)
    }
  })

  it('单条违规仍为 INVALID_PATTERN，不误报为聚合错误', () => {
    const entries = nearTotalEntries()
    // 与现有值重复：先报重复（INVALID_PATTERN），即便聚合上也无名额
    expectMaskError(INVALID_PATTERN, () => addEntry(entries, entries[0].value))
    expectMaskError(INVALID_PATTERN, () => updateEntry(entries, -1, 'z'))
    const only: PatternEntry[] = [{ value: 'alpha', enabled: true }]
    expectMaskError(INVALID_PATTERN, () => removeEntry(only, 5))
  })

  it('parseInput 与编辑共用同一聚合断言：边界文件行为不变', () => {
    // 数量 0 / 50001、总长 300000+1 的文件仍是 INVALID_INPUT（既有契约）
    expectMaskError(INVALID_INPUT, () =>
      parseInput(JSON.stringify({ text: 'a', patterns: [] })),
    )
    const tooMany = fixedWidthPatterns(LIMITS.maxPatterns + 1, 6).map((e) => e.value)
    expectMaskError(INVALID_INPUT, () =>
      parseInput(JSON.stringify({ text: 'a', patterns: tooMany })),
    )
    // 恰好边界（50,000×6 = 300,000）合法
    const atLimit = fixedWidthPatterns(LIMITS.maxPatterns, 6).map((e) => e.value)
    expect(() => parseInput(JSON.stringify({ text: 'a', patterns: atLimit }))).not.toThrow()
  })
})

describe('自动机结构性质', () => {
  it('节点数 ≤ 总短语长 + 1；长模式长度可达 200', () => {
    const patterns = ['abc', 'abd', 'ab', 'x']
    const auto = buildAutomaton(patterns)
    // trie: root, a, ab, abc, abd, x = 6 个节点
    expect(auto.outLen.length).toBe(6)
    // 状态 ab 的最长链上词典 = 2（'ab'）；abc = 3
  })
})

// ---------------------------------------------------------------------------
// 单次豁免（引文保留）：朴素预言机独立枚举每处命中，把被豁免的命中从
// 覆盖与计数中剔除，再与 maskText 的输出逐字符、逐短语核对。
// ---------------------------------------------------------------------------

/** 豁免以“启用短语下标 + 起始代码单元”标识一处具体命中。 */
interface ExHit {
  pattern: number
  start: number
}

/**
 * 豁免预言机：与生产实现无关地 indexOf 枚举每条短语的全部完整命中
 * （逐位置推进，允许自重叠、短语不含换行天然不跨行），跳过被豁免集合中的
 * 命中，其余用区间差分求覆盖并集。
 */
function oracleWithExemptions(
  text: string,
  patterns: readonly string[],
  exempt: ReadonlySet<string>,
): { masked: string; coveredCount: number; counts: number[] } {
  const delta = new Int32Array(text.length + 1)
  const counts = new Array<number>(patterns.length).fill(0)
  for (let k = 0; k < patterns.length; k++) {
    const p = patterns[k]
    let from = 0
    for (;;) {
      const idx = text.indexOf(p, from)
      if (idx === -1) break
      if (!exempt.has(`${k}:${idx}`)) {
        delta[idx] += 1
        delta[idx + p.length] -= 1
        counts[k]++
      }
      from = idx + 1
    }
  }
  let coveredCount = 0
  let out = ''
  let open = 0
  for (let i = 0; i < text.length; i++) {
    open += delta[i]
    const on = open > 0
    if (on) coveredCount++
    out += on ? '#' : text[i]
  }
  return { masked: out, coveredCount, counts }
}

function exSet(hits: readonly ExHit[]): Set<string> {
  return new Set(hits.map((h) => `${h.pattern}:${h.start}`))
}

/** 枚举全部命中（与豁免预言机同定义），供随机测试挑选有效豁免点。 */
function enumerateHits(text: string, patterns: readonly string[]): ExHit[] {
  const hits: ExHit[] = []
  for (let k = 0; k < patterns.length; k++) {
    const p = patterns[k]
    let from = 0
    for (;;) {
      const idx = text.indexOf(p, from)
      if (idx === -1) break
      hits.push({ pattern: k, start: idx })
      from = idx + 1
    }
  }
  return hits
}

function expectMaskWithEx(
  text: string,
  patterns: readonly string[],
  exempt: readonly ExHit[],
) {
  const refs = exempt.map((h) => ({ pattern: h.pattern, start: h.start }))
  const result = maskText(text, patterns, refs)
  const oracle = oracleWithExemptions(text, patterns, exSet(exempt))
  expect(result.masked).toBe(oracle.masked)
  expect(result.coveredCount).toBe(oracle.coveredCount)
  expectCounts(result, oracle.counts)
  return result
}

describe('单次豁免：朴素预言机一致性（随机性质测试）', () => {
  it('随机文本 + 随机短语 + 随机豁免子集，覆盖并集与有效计数逐项一致', () => {
    const rng = mulberry32(0xe8e8710)
    for (let round = 0; round < 200; round++) {
      const text = randomString(rng, 120)
      const count = 1 + Math.floor(rng() * 12)
      const patternSet = new Set<string>()
      for (let i = 0; i < count; i++) patternSet.add(randomString(rng, 1 + Math.floor(rng() * 6)))
      const patterns = [...patternSet]
      const hits = enumerateHits(text, patterns)
      // 随机豁免一个子集（含“豁免全部命中”这一极端）
      const exempt = hits.filter(() => rng() < 0.4)
      expectMaskWithEx(text, patterns, exempt)
    }
  })

  it('含换行文本：行内命中可豁免，骑跨换行本就不是命中，其他行不受影响', () => {
    const rng = mulberry32(0x11ee7)
    for (let round = 0; round < 100; round++) {
      const lines: string[] = []
      for (let i = 0; i < 1 + Math.floor(rng() * 4); i++) lines.push(randomString(rng, 40))
      const text = lines.join('\n')
      const ps = new Set<string>()
      for (let i = 0; i < 6; i++) ps.add(randomString(rng, 5))
      const patterns = [...ps]
      const hits = enumerateHits(text, patterns)
      const exempt = hits.filter(() => rng() < 0.5)
      const result = expectMaskWithEx(text, patterns, exempt)
      // 换行永远原样保留
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 0x0a) expect(result.masked[i]).toBe('\n')
      }
    }
  })

  it('深嵌套 a^1..L：豁免若干层后，露出位置与预言机逐字符相同', () => {
    const rng = mulberry32(0xaaa1)
    for (let round = 0; round < 40; round++) {
      const depth = 2 + Math.floor(rng() * 30)
      const patterns: string[] = []
      for (let L = 1; L <= depth; L++) patterns.push('a'.repeat(L))
      const text = 'a'.repeat(depth * 3)
      const hits = enumerateHits(text, patterns)
      // 集中豁免在同一终点（同终点嵌套命中）与分散豁免各覆盖
      const exempt = hits.filter(() => rng() < 0.3)
      expectMaskWithEx(text, patterns, exempt)
    }
  })
})

describe('单次豁免：语义点名场景', () => {
  it('只放过这一处：同词的其他命中仍遮蔽，计数只减一', () => {
    const text = 'xxx xxx xxx'
    const patterns = ['xxx']
    // 豁免中间那处（start=4）
    const result = expectMaskWithEx(text, patterns, [{ pattern: 0, start: 4 }])
    expect(result.masked).toBe('### xxx ###')
    expect(result.counts[0]).toBe(2) // 3 - 1
    expect(result.coveredCount).toBe(6)
  })

  it('豁免一处不抹掉其他短语在同一区域的遮蔽', () => {
    // 'abcdef'：'abc' 与 'bc' 都覆盖位置 1..2；豁免 'abc'（start=0）后，
    // 位置 0 露出，但 1..2 仍被 'bc' 覆盖
    expectMaskWithEx('abcdef', ['abc', 'bc'], [{ pattern: 0, start: 0 }])
    // 反向：豁免短词 'bc'，长词 'abc' 仍全覆盖
    expectMaskWithEx('abcdef', ['abc', 'bc'], [{ pattern: 1, start: 1 }])
  })

  it('同终点嵌套：豁免最长词后取次长匹配；全部豁免才露出', () => {
    const text = 'abcd'
    const patterns = ['a', 'ab', 'abc', 'abcd']
    // 只豁免最长 'abcd'：终点 3 改取 'abc'，位置 3 露出
    expectMaskWithEx(text, patterns, [{ pattern: 3, start: 0 }])
    // 豁免 abcd 与 abc：取 'ab'
    expectMaskWithEx(text, patterns, [
      { pattern: 3, start: 0 },
      { pattern: 2, start: 0 },
    ])
    // 同终点四个词全部豁免：整个区间露出，计数各减一
    const result = expectMaskWithEx(
      text,
      patterns,
      [0, 1, 2, 3].map((k) => ({ pattern: k, start: 0 })),
    )
    expect(result.masked).toBe('abcd')
    expect(result.coveredCount).toBe(0)
    expect([...result.counts]).toEqual([0, 0, 0, 0])
  })

  it('自重叠：豁免其中一处重叠命中，其余重叠照常', () => {
    const text = 'aaaa'
    // 'aa' 命中 start 0,1,2；豁免 start=1，剩 0 与 2 覆盖 {0,1}∪{2,3}=全覆盖，
    // 故遮蔽不变但计数 3→2
    const result = expectMaskWithEx(text, ['aa'], [{ pattern: 0, start: 1 }])
    expect(result.masked).toBe('####')
    expect(result.counts[0]).toBe(2)
    // 豁免 start=0：只剩 {1,2} 与 {2,3} → 位置 0 露出
    expectMaskWithEx(text, ['aa'], [{ pattern: 0, start: 0 }])
  })

  it('不同词在同终点结束：豁免其一，另一词继续覆盖', () => {
    // 'zabc'：'abc'(1..3) 与 'bc'(2..3) 同终点 3。
    const text = 'zabc'
    const patterns = ['abc', 'bc']
    // 豁免 'abc'（start=1）：'bc' 仍盖 2..3，位置 1 的 'a' 露出
    const r1 = expectMaskWithEx(text, patterns, [{ pattern: 0, start: 1 }])
    expect(r1.masked).toBe('za##')
    // 豁免 'bc'（start=2）：'abc' 仍盖 1..3
    const r2 = expectMaskWithEx(text, patterns, [{ pattern: 1, start: 2 }])
    expect(r2.masked).toBe('z###')
  })

  it('豁免后计数与遮蔽来自同一工作集：零有效命中显示 0', () => {
    const text = 'abc'
    const result = maskText(text, ['abc'], [{ pattern: 0, start: 0 }])
    expect(result.counts[0]).toBe(0)
    expect(result.masked).toBe('abc')
    // 诊断计数：该终点所有匹配被豁免，endingCount 为 0
    expect(result.endingCount).toBe(0)
  })

  it('每个豁免引用扣一次（去重契约在会话层 toExemptionRefs）', () => {
    // maskText 按引用计数：同一命中传入两个引用会扣两次。会话层保证不会
    // 重复登记（addExemption 拒绝重复、toExemptionRefs 再按集合去重），
    // 这里锁定底层语义，避免两层之间产生“扣几次”的歧义。
    const text = 'abcabc'
    const once = maskText(text, ['abc'], [{ pattern: 0, start: 0 }])
    const twice = maskText(
      text,
      ['abc'],
      [
        { pattern: 0, start: 0 },
        { pattern: 0, start: 0 },
      ],
    )
    expect(once.counts[0]).toBe(1)
    expect(twice.counts[0]).toBe(0)
    // 遮蔽预言机只把“该命中是否仍覆盖”视为布尔：扣两次也只露出这一处
    expect(twice.masked).toBe(oracleWithExemptions(text, ['abc'], exSet([{ pattern: 0, start: 0 }])).masked)
  })
})

describe('单次豁免：密集命中性能（不为全文命中建立对象列表）', () => {
  it('满规模 a 游程 + a^1..200：登记 1000 处豁免仍在时限内，计数 n-L+1-豁免数', () => {
    const n = LIMITS.maxTextCodeUnits
    const text = 'a'.repeat(n)
    const patterns: string[] = []
    for (let L = 1; L <= 200; L++) patterns.push('a'.repeat(L))
    // 对 a^200 豁免前 1000 个不同起点（同终点分布在 1000 个终点）
    const exempt: ExHit[] = []
    for (let s = 0; s < 1000; s++) exempt.push({ pattern: 199, start: s })
    const refs = exempt.map((h) => ({ pattern: h.pattern, start: h.start }))
    const t0 = Date.now()
    const result = maskText(text, patterns, refs)
    expect(Date.now() - t0).toBeLessThan(3000)
    // 全覆盖依旧（每处仍有 a^199 等其他词覆盖）
    expect(result.coveredCount).toBe(n)
    // a^200 的有效命中减少 1000；其余不变
    expect(result.counts[199]).toBe(n - 200 + 1 - 1000)
    expect(result.counts[0]).toBe(n) // a^1 未豁免
  })

  it('全部豁免集中于同一终点（同终点 200 层嵌套）：失败链行走正确且不按命中数展开', () => {
    const text = 'a'.repeat(5000)
    const patterns: string[] = []
    for (let L = 1; L <= 200; L++) patterns.push('a'.repeat(L))
    // 在终点 4999 豁免所有 200 层：该位置露出到 200 长度以外
    const end = 4999
    const exempt: ExHit[] = []
    for (let k = 0; k < patterns.length; k++) {
      exempt.push({ pattern: k, start: end - patterns[k].length + 1 })
    }
    expectMaskWithEx(text, patterns, exempt)
  })
})
