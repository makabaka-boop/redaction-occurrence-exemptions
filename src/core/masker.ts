/**
 * 敏感短语遮蔽核心算法。
 *
 * 代码单元语义（务必先阅读 README「代码单元语义」一节）：
 * - 合法 text 仅含 U+000A（换行）与 U+0020..U+007E（可打印 ASCII）。
 * - 这些字符在 UTF-16 中全部以单个代码单元编码，因此索引、长度、字符
 *   三者在合法输入上完全一致；代理项（surrogate）等会被判为非法输入。
 * - 匹配区分大小写；匹配不跨越换行（扫描到换行时状态回到根）。
 * - 任意短语的任一完整匹配所覆盖的代码单元全部替换为 '#'，
 *   多个匹配交叠时取覆盖位置的并集，其余代码单元原位保留。
 *
 * 性能：Aho-Corasick 自动机 + 线性两遍扫描，复杂度 O(|text| + 总长(patterns)
 * + trie 边数)，不为每个命中展开任何对象，因此命中数再多（乃至每个位置
 * 都有数十上百个嵌套命中）也不会按命中数放大内存或耗时。
 *
 * 计数：每条启用短语的“完整匹配次数”与遮蔽同一次扫描产出——扫描只累计
 * 到达状态次数，再按构建顺序逆向汇入失败链父节点，最后从模式终止节点取数，
 * 不遍历输出链、不逐短语重扫；资源消耗只随 |text|、trie 节点数与模式数
 * 线性增长，不为命中分配任何对象。
 *
 * 单次豁免（引文保留）：调用方可以为个别**完整命中**登记一次性豁免。豁免
 * 引用某条启用短语在原文中的起始代码单元（同一行内的完整命中），只放过这
 * 一处命中：该命中区间不再贡献遮蔽（但其他短语在同一区域的遮蔽保留），该
 * 短语的“有效命中次数”也只减这一处；同词的其他命中照常遮蔽与计数。豁免
 * 数量有硬上限（LIMITS.maxExemptions），因此其额外开销只随豁免数 × 最大
 * 短语长（≤ 200）增长，与全文命中总数无关：不会为全文命中建立任何对象
 * 列表，只在豁免命中的终点处沿失败链行走（≤ 200 步）求“到此结束的最长
 * 非豁免匹配”。
 */

export const LIMITS = {
  /** text 最多二百万个 UTF-16 代码单元 */
  maxTextCodeUnits: 2_000_000,
  /** patterns 最少 1 项、最多 50000 项 */
  minPatterns: 1,
  maxPatterns: 50_000,
  /** 每个短语长 1..200 */
  minPatternLength: 1,
  maxPatternLength: 200,
  /** 全部短语长度总和不超过三十万 */
  maxTotalPatternLength: 300_000,
  /**
   * 单次豁免（引文保留）的总会话硬上限。豁免是逐条人工操作，数量保持很小；
   * 有了这道上界，豁免相关的额外工作（终点集合、按终点失败链行走）只随
   * 豁免数 × 最大短语长（≤ 200）增长，绝不随全文命中数增长，也不可能被
   * 用来登记全文每一处命中而退化。
   */
  maxExemptions: 1_000,
} as const

export const INVALID_INPUT = 'INVALID_INPUT'
export const INVALID_PATTERN = 'INVALID_PATTERN'
/** 自动机构建、遮蔽或计数阶段异常；此时保留上一次成功的工作集/预览/计数/采纳稿 */
export const COUNT_FAILED = 'COUNT_FAILED'
/**
 * 编辑后的工作集违反**聚合约束**（条目数 1..50,000 或总长 > 300,000）。
 * 与文件导入同源同一组约束：越界动作在重算之前被拒绝，绝不重建自动机、
 * 绝不提交快照。数量低于最小数量（删除唯一短语）同样用本错误码。
 */
export const LIMITS_EXCEEDED = 'LIMITS_EXCEEDED'
/**
 * 单次豁免引用无效：位置不是整数 / 越界 / 落在换行上 / 引用的短语停用或
 * 下标越界 / 该位置不是这条短语在同一行内的完整命中 / 对同一命中重复豁免。
 * 与其他编辑错误一样发生在重算之前：不提交快照，保留上次有效预览与采纳稿。
 */
export const INVALID_EXEMPTION = 'INVALID_EXEMPTION'

export class MaskError extends Error {
  readonly code:
    | typeof INVALID_INPUT
    | typeof INVALID_PATTERN
    | typeof COUNT_FAILED
    | typeof LIMITS_EXCEEDED
    | typeof INVALID_EXEMPTION
  constructor(
    code:
      | typeof INVALID_INPUT
      | typeof INVALID_PATTERN
      | typeof COUNT_FAILED
      | typeof LIMITS_EXCEEDED
      | typeof INVALID_EXEMPTION,
  ) {
    super(code)
    this.name = 'MaskError'
    this.code = code
  }
}

/** U+000A 换行；其余只允许 U+0020..U+007E。代理项等一律非法。 */
export function isAllowedTextCode(code: number): boolean {
  return code === 0x0a || (code >= 0x20 && code <= 0x7e)
}

/** 短语只能含 U+0020..U+007E（不允许换行）。 */
export function isAllowedPatternCode(code: number): boolean {
  return code >= 0x20 && code <= 0x7e
}

export interface RawInput {
  text: string
  patterns: string[]
}

/**
 * 解析并校验 JSON 输入。根对象必须且仅含 text 与 patterns 两个键。
 * 任何结构、类型、长度、字符集或重复违规都抛 INVALID_INPUT。
 */
export function parseInput(jsonText: string): RawInput {
  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch {
    throw new MaskError(INVALID_INPUT)
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MaskError(INVALID_INPUT)
  }
  const root = data as Record<string, unknown>
  const keys = Object.keys(root)
  if (keys.length !== 2 || !('text' in root) || !('patterns' in root)) {
    throw new MaskError(INVALID_INPUT)
  }

  const { text, patterns } = root

  if (typeof text !== 'string' || text.length > LIMITS.maxTextCodeUnits) {
    throw new MaskError(INVALID_INPUT)
  }
  for (let i = 0; i < text.length; i++) {
    if (!isAllowedTextCode(text.charCodeAt(i))) {
      throw new MaskError(INVALID_INPUT)
    }
  }

  if (!Array.isArray(patterns)) {
    throw new MaskError(INVALID_INPUT)
  }
  // 数量下界 / 上界先查；总长在逐条循环中累计后与编辑流共用同一处断言
  if (patterns.length < LIMITS.minPatterns || patterns.length > LIMITS.maxPatterns) {
    throw new MaskError(INVALID_INPUT)
  }

  let total = 0
  const seen = new Set<string>()
  for (const p of patterns) {
    if (typeof p !== 'string') {
      throw new MaskError(INVALID_INPUT)
    }
    if (p.length < LIMITS.minPatternLength || p.length > LIMITS.maxPatternLength) {
      throw new MaskError(INVALID_INPUT)
    }
    for (let i = 0; i < p.length; i++) {
      if (!isAllowedPatternCode(p.charCodeAt(i))) {
        throw new MaskError(INVALID_INPUT)
      }
    }
    total += p.length
    // 短语必须互不重复（区分大小写）
    if (seen.has(p)) {
      throw new MaskError(INVALID_INPUT)
    }
    seen.add(p)
  }

  // 聚合约束（总长）与编辑流程共用同一处检查：导入与所有编辑成功后的
  // 工作集始终满足同一组约束（数量 1..50,000、总长 ≤ 300,000）。
  assertWorksetLimits(patterns.length, total, INVALID_INPUT)

  return { text, patterns: patterns as string[] }
}

/** 校验单条短语值；空串、越界长度、非法字符均判 INVALID_PATTERN。 */
export function checkPatternValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new MaskError(INVALID_PATTERN)
  }
  if (value.length < LIMITS.minPatternLength || value.length > LIMITS.maxPatternLength) {
    throw new MaskError(INVALID_PATTERN)
  }
  for (let i = 0; i < value.length; i++) {
    if (!isAllowedPatternCode(value.charCodeAt(i))) {
      throw new MaskError(INVALID_PATTERN)
    }
  }
}

export interface PatternEntry {
  value: string
  enabled: boolean
}

/**
 * 工作集**聚合约束**：与 parseInput 完全同源——条目数必须落在
 * 1..50,000，且全部短语长度总和 ≤ 300,000。导入用 INVALID_INPUT，
 * 编辑流程（增改 / 删除后的候选工作集）用 LIMITS_EXCEEDED：约束本身
 * 相同，区别只在“当前动作被拒绝”这一语义上。
 *
 * 注意：编辑流里单条长度（1..200）已由 checkPatternValue 保证，这里只做
 * 数量与总长这两项聚合量；数量下界覆盖“删除唯一短语”。
 */
export function assertWorksetLimits(
  count: number,
  totalLength: number,
  code: typeof INVALID_INPUT | typeof LIMITS_EXCEEDED,
): void {
  if (
    count < LIMITS.minPatterns ||
    count > LIMITS.maxPatterns ||
    totalLength > LIMITS.maxTotalPatternLength
  ) {
    throw new MaskError(code)
  }
}

/** 汇总候选工作集的短语总长（编辑流调用：单条长度此前已逐条校验）。 */
function totalPatternLength(entries: readonly PatternEntry[]): number {
  let total = 0
  for (const e of entries) total += e.value.length
  return total
}

/**
 * Aho-Corasick 自动机（记忆化完成转移 / completed-goto 变体）。
 *
 * edgeMap 是 goto 表：trie 构建期只放真实边，BFS 与扫描期按需补写
 * “完成转移”（缺失边直接指向失败链结果），因此：
 *   - 键为 (state << 7) | char：字符码 ≤ 0x7e < 2^7，复合键不冲突，
 *     最大键 ((300000 << 7) | 0x7e) ≈ 3.84e7 < 2^32，安全；
 *   - 任何 (state,char) 的失败链行走至多发生一次，构建与扫描都是线性
 *     摊销（短语长 ≤ 200，递归深度也以此为界）；
 *   - 补写条目数量有界（真实边 ≤ 300001，扫描期每字符至多补写一条）。
 * 子边邻接表（head/eChar/eTo/eNext）只用于构建期按“真实出边”做 BFS，
 * 完成转移混在 edgeMap 中不影响子边枚举。节点总数 ≤ 总长(patterns)+1。
 */
interface Automaton {
  go: (state: number, charCode: number) => number
  /** 该状态沿失败链可达的最长字典词长度，0 表示无匹配（≤ 200） */
  outLen: Uint16Array
  /**
   * 本状态自身终止的字典词长度，0 表示本节点不是任何模式终点。
   * 豁免处理沿失败链识别“到此结束的匹配”时需要它（outLen 只给最长值，
   * 无法区分被豁免后剩余的次长匹配）。
   */
  ownLen: Uint16Array
  /** 失败链：fail[u] 是 u 的最长真后缀状态（根为 0） */
  fail: Int32Array
  /** BFS 出队序（不含根）；失败链父节点必然排在子节点之前 */
  order: Int32Array
  /** 每条输入短语对应的终止 trie 节点（按入参顺序；重复短语共享同一节点） */
  terminal: Int32Array
  /** 实际节点数（分配数组按上界 maxNodes，有效下标为 [0, nodeCount)） */
  nodeCount: number
}

export function buildAutomaton(patterns: readonly string[]): Automaton {
  const maxNodes = patterns.reduce((s, p) => s + p.length, 0) + 1
  const edgeSlots = Math.max(1, maxNodes - 1)
  const head = new Int32Array(maxNodes).fill(-1)
  const eChar = new Uint16Array(edgeSlots)
  const eTo = new Int32Array(edgeSlots)
  const eNext = new Int32Array(edgeSlots).fill(-1)
  const edgeMap = new Map<number, number>()
  /** 终止于某节点的字典词长度（互不重复的模式至多一个值，保留防御） */
  const ownLen = new Uint16Array(maxNodes)
  const fail = new Int32Array(maxNodes)

  let nodeCount = 1
  let edgeCount = 0

  // ---- 构建 trie（仅真实边写入 edgeMap），并记录每条短语的终止节点 ----
  const terminal = new Int32Array(patterns.length)
  for (let k = 0; k < patterns.length; k++) {
    const p = patterns[k]
    let u = 0
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      const key = (u << 7) | c
      let v = edgeMap.get(key)
      if (v === undefined) {
        v = nodeCount++
        edgeMap.set(key, v)
        const e = edgeCount++
        eChar[e] = c
        eTo[e] = v
        eNext[e] = head[u]
        head[u] = e
      }
      u = v
    }
    terminal[k] = u
    if (p.length > ownLen[u]) ownLen[u] = p.length
  }

  // ---- 记忆化完成转移：缺失边等价于沿失败链转移，只算一次 ----
  const go = (u: number, c: number): number => {
    const key = (u << 7) | c
    const cached = edgeMap.get(key)
    if (cached !== undefined) return cached
    if (u === 0) {
      edgeMap.set(key, 0)
      return 0
    }
    const r = go(fail[u], c)
    edgeMap.set(key, r)
    return r
  }

  // ---- BFS 构建失败链；outLen[u] = 本状态及其失败链上最长字典词 ----
  // 同时保存 BFS 出队序 order：fail[u] 严格先于 u 入队，因此逆向遍历 order
  // 即“子节点先于其失败链父节点”，可把到达次数一次性汇入失败链。
  const outLen = new Uint16Array(nodeCount)
  const order = new Int32Array(Math.max(0, nodeCount - 1))
  const queue = new Int32Array(nodeCount)
  let qh = 0
  let qt = 0

  for (let e = head[0]; e !== -1; e = eNext[e]) {
    fail[eTo[e]] = 0
    queue[qt++] = eTo[e]
  }

  while (qh < qt) {
    const u = queue[qh++]
    order[qh - 1] = u
    outLen[u] = Math.max(ownLen[u], outLen[fail[u]])
    for (let e = head[u]; e !== -1; e = eNext[e]) {
      const v = eTo[e]
      fail[v] = go(fail[u], eChar[e])
      queue[qt++] = v
    }
  }

  return { go, outLen, ownLen, fail, order, terminal, nodeCount }
}

export interface MaskResult {
  masked: string
  /**
   * 被遮蔽的代码单元数（覆盖并集大小，不是命中次数）。豁免命中独占的
   * 代码单元不计入；被其他启用短语（含其他命中）覆盖的位置仍计入。
   */
  coveredCount: number
  /** 至少有一个**未被豁免**的短语在此代码单元处结束的位置数（诊断用） */
  endingCount: number
  /**
   * 每条启用短语在原文中的**有效**完整匹配次数（区分大小写、允许自重叠、
   * 不跨换行），顺序与 enabledPatterns 严格一致；等于总命中次数减去针对
   * 该短语登记的豁免数（每处豁免只减一处命中），零命中为 0。Uint32Array
   * 上界 2^32-1，而任一模式的命中数 ≤ |text| ≤ 2_000_000，绝不溢出。
   */
  counts: Uint32Array
}

/**
 * 对一处具体命中的单次豁免引用（“只放过这一处”）：
 * pattern 是该短语在**启用短语序列**中的下标（与 enabledPatterns 同序），
 * start 是该命中在原文中的起始 UTF-16 代码单元。会话层负责校验它确为该
 * 短语在同一行内的完整命中；这里只按引用扣除。引用必须有效（越界、停用
 * 短语等由会话层在重算之前拒绝）。
 */
export interface ExemptionRef {
  pattern: number
  start: number
}

const HASH = '#'.charCodeAt(0)
const NL = 0x0a
/** fromCharCode 分块大小，远低于各引擎参数个数上限 */
const CHUNK = 0x8000

/**
 * 从原文与当前启用的短语重算遮蔽结果与每条短语的有效完整匹配次数。
 *
 * 遮蔽（线性两遍法，额外内存 O(|text|)，不按命中数展开）：
 *   第一遍正向扫描 AC 自动机，在每个代码单元末尾记录“覆盖该位置的
 *   最长匹配长度” mark[i]（Uint16Array，短语 ≤ 200）；换行处状态回根，
 *   从语义上保证不跨换行。
 *   第二遍自右向左，把“到此结束的最长匹配”归并为覆盖并集。活跃的右侧
 *   覆盖段记为 [reach, R]（reach 为其左沿，R > i 是某个已处理位置）：
 *     - 无活跃段（reach === -1）或本段与其之间有缺口（i < reach）：
 *       另开新段，仅覆盖 [start, i]；
 *     - 相交（i ≥ reach）且向左延伸（start < reach）：补覆盖
 *       [start, reach-1]，左沿前移；
 *     - 被包含：什么也不做。
 *   每个位置至多被写入一次，整段仍是 O(n)。
 *
 * 豁免（不为全文命中建立对象列表，额外工作只随豁免数 × ≤200 增长）：
 *   豁免只可能改变“恰好有豁免命中结束”的终点。在这些终点 i，第一遍额外
 *   沿当前状态的失败链下行，跳过所有“恰在此处结束且被豁免”的匹配长度，
 *   取第一个未被豁免的终止词长度，写入 exMark[i]（mark[i] 仍保留全部
 *   匹配的最长值）；覆盖并集第二遍在普通终点用 mark[i]、在豁免终点用
 *   exMark[i]。这样被豁免命中**独占**的位置露出原文，而其他短语（或同一
 *   短语的其他命中、嵌套/同终点命中）在同一区域造成的遮蔽全部保留。
 * *   非豁免终点不做任何失败链行走，因此无豁免时扫描期不增加任何计算
 *   （仅多一个与 mark 同阶的定长整型数组，与既有 cover/codes 数组同量级）。
 *
 * 计数（与遮蔽同一遍扫描产出，逐短语 O(1) 取数，不逐短语重扫）：
 *   arrive[u] 只累计扫描过程中“到达状态 u”的次数，沿失败链完成的匹配
 *   不在此行走输出链。扫描结束后按构建顺序（BFS 序）逆向遍历，把每个
 *   状态的到达次数一次性汇入其失败链父节点：fail 父在 BFS 序中必早于子，
 *   故逆序保证子（及其后缀）先汇入完毕。此后 arrive[terminal[k]] 恰为
 *   第 k 条短语的全部完整出现次数（包含自重叠；换行已把状态重置为根，
 *   故不跨换行），再减去针对该短语登记的豁免数即“有效命中次数”。全程只
 *   新增 O(节点数) 的定长整型数组，不为命中分配对象。
 */
export function maskText(
  text: string,
  enabledPatterns: readonly string[],
  exemptions: readonly ExemptionRef[] = [],
): MaskResult {
  const n = text.length
  const counts = new Uint32Array(enabledPatterns.length)

  if (enabledPatterns.length === 0 || n === 0) {
    return { masked: text, coveredCount: 0, endingCount: 0, counts }
  }

  const { go, outLen, ownLen, fail, order, terminal, nodeCount } = buildAutomaton(enabledPatterns)
  const mark = new Uint16Array(n)
  /** 到达次数：先只记“扫描直达”，再逆向汇入失败链 */
  const arrive = new Uint32Array(nodeCount)

  // ---- 豁免索引：按“命中终点 = start + 短语长 - 1”组织，仅在这些终点行走失败链 ----
  // exEnds 升序、exLens 为对应命中长度（同终点可有多个：自重叠 / 嵌套 / 同终点
  // 命中各自一条）。exByPattern 累计每短语的豁免数，计数阶段逐条扣减。
  // 豁免总数 ≤ LIMITS.maxExemptions：这里的排序与集合开销与全文命中数无关。
  const exCount = exemptions.length
  const exEnds = new Int32Array(exCount)
  const exLens = new Uint16Array(exCount)
  const exByPattern = new Uint32Array(enabledPatterns.length)
  const sorted =
    exCount <= 1
      ? exemptions
      : Array.from(exemptions).sort((a, b) => {
          const ea = a.start + enabledPatterns[a.pattern].length
          const eb = b.start + enabledPatterns[b.pattern].length
          return ea - eb
        })
  for (let t = 0; t < exCount; t++) {
    const ref = sorted[t]
    const lenP = enabledPatterns[ref.pattern].length
    exEnds[t] = ref.start + lenP - 1
    exLens[t] = lenP
    exByPattern[ref.pattern]++
  }

  let state = 0
  let endingCount = 0
  /** exMark：仅在豁免终点写入“到此结束的最长非豁免匹配长度”（0 = 全被豁免） */
  const exMark = new Uint16Array(n)
  /** 下一个尚未消费的豁免终点（exEnds 升序，随 i 单调前移） */
  let exCursor = 0

  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    if (c === NL) {
      state = 0
      continue
    }
    state = go(state, c)
    arrive[state]++
    const len = outLen[state]
    mark[i] = len
    if (len !== 0) endingCount++

    // 该终点有豁免命中：收集在此结束的被豁免匹配长度，再沿失败链找最长的
    // “未被豁免”的终止词。失败链自上而下（终止词由长到短），第一个未跳过
    // 的终止状态即最长非豁免匹配；走到根（chosen=0）表示全部被豁免。
    if (exCursor < exCount && exEnds[exCursor] === i) {
      const skipped = new Set<number>()
      while (exCursor < exCount && exEnds[exCursor] === i) {
        skipped.add(exLens[exCursor])
        exCursor++
      }
      let u = state
      let chosen = 0
      while (u !== 0) {
        const ol = ownLen[u]
        if (ol !== 0 && !skipped.has(ol)) {
          chosen = ol
          break
        }
        u = fail[u]
      }
      exMark[i] = chosen
      // 该终点的所有匹配都被豁免：不计入“有未豁免短语结束”的诊断计数
      if (chosen === 0) endingCount--
    }
  }

  // ---- 计数：按 BFS 序逆向，把到达次数汇入失败链父节点（每节点一次） ----
  for (let k = order.length - 1; k >= 0; k--) {
    const u = order[k]
    arrive[fail[u]] += arrive[u]
  }
  for (let k = 0; k < enabledPatterns.length; k++) {
    // 有效命中 = 全部完整出现 − 针对本短语的豁免（每处豁免只放过一处命中）
    counts[k] = arrive[terminal[k]] - exByPattern[k]
  }

  // ---- 第二遍：覆盖并集；豁免终点改用“最长非豁免匹配” ----
  // exEnds 升序：倒序扫描时用游标 ec 单调前移，O(n + 豁免数) 即可识别
  // 豁免终点，不需要按 |text| 的终点位图。
  const cover = new Uint8Array(n)
  let coveredCount = 0
  let reach = -1
  let ec = exCount - 1
  for (let i = n - 1; i >= 0; i--) {
    while (ec >= 0 && exEnds[ec] > i) ec--
    const isExEnd = ec >= 0 && exEnds[ec] === i
    const activeLen = isExEnd ? exMark[i] : mark[i]
    if (activeLen === 0) continue
    const start = i - activeLen + 1
    if (reach === -1 || i < reach) {
      for (let j = start; j <= i; j++) cover[j] = 1
      coveredCount += activeLen
      reach = start
    } else if (start < reach) {
      for (let j = start; j < reach; j++) cover[j] = 1
      coveredCount += reach - start
      reach = start
    }
  }

  // ---- 生成结果：以 Uint16 分块 fromCharCode 避免巨型参数列表 ----
  const codes = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    codes[i] = cover[i] === 1 ? HASH : text.charCodeAt(i)
  }
  const parts: string[] = []
  for (let i = 0; i < n; i += CHUNK) {
    const slice = codes.subarray(i, Math.min(i + CHUNK, n))
    parts.push(String.fromCharCode.apply(null, slice as unknown as number[]))
  }

  return { masked: parts.join(''), coveredCount, endingCount, counts }
}

// ---------------------------------------------------------------------------
// 短语编辑：所有变更从原文重算由调用方（页面）负责；这里只做不可变更新与
// 校验。单条违规（空串/重复/超长/非法字符/下标越界）抛 INVALID_PATTERN，
// 候选工作集违反聚合约束（数量 1..50,000、总长 ≤ 300,000）抛
// LIMITS_EXCEEDED；函数式语义保证调用方状态不会被部分修改——“不覆盖已采纳
// 稿”由页面在捕获异常后不提交状态实现。
// ---------------------------------------------------------------------------

function assertIndex(entries: readonly PatternEntry[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new MaskError(INVALID_PATTERN)
  }
}

function assertNotDuplicate(entries: readonly PatternEntry[], value: string, except?: number): void {
  // Set 查重：短语规模可达 5 万，避免连续增改时的 O(n^2)
  const values = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    if (i !== except) values.add(entries[i].value)
  }
  if (values.has(value)) throw new MaskError(INVALID_PATTERN)
}

/** 新增短语：空串/非法字符/超长/重复 → INVALID_PATTERN；数量/总长越界 → LIMITS_EXCEEDED。 */
export function addEntry(entries: readonly PatternEntry[], value: string): PatternEntry[] {
  checkPatternValue(value)
  assertNotDuplicate(entries, value)
  const next = [...entries, { value, enabled: true }]
  // 聚合约束在构造候选之后、返回之前：与导入同源；越界则不返回任何候选
  assertWorksetLimits(next.length, totalPatternLength(entries) + value.length, LIMITS_EXCEEDED)
  return next
}

/**
 * 修改短语：空串/非法字符/超长/重复/下标越界 → INVALID_PATTERN；
 * 修改后总长越界 → LIMITS_EXCEEDED。
 */
export function updateEntry(
  entries: readonly PatternEntry[],
  index: number,
  value: string,
): PatternEntry[] {
  assertIndex(entries, index)
  checkPatternValue(value)
  assertNotDuplicate(entries, value, index)
  const total = totalPatternLength(entries) - entries[index].value.length + value.length
  const next = entries.map((e, i) => (i === index ? { ...e, value } : e))
  assertWorksetLimits(next.length, total, LIMITS_EXCEEDED)
  return next
}

/** 启用/停用单条；下标越界 → INVALID_PATTERN。 */
export function toggleEntry(
  entries: readonly PatternEntry[],
  index: number,
  enabled: boolean,
): PatternEntry[] {
  assertIndex(entries, index)
  return entries.map((e, i) => (i === index ? { ...e, enabled } : e))
}

/**
 * 删除单条；下标越界 → INVALID_PATTERN；删除后数量低于最小数量
 * （删除唯一短语）→ LIMITS_EXCEEDED。
 */
export function removeEntry(entries: readonly PatternEntry[], index: number): PatternEntry[] {
  assertIndex(entries, index)
  const next = entries.filter((_, i) => i !== index)
  // 数量下界（至少 1 条）与导入契约一致：空工作集永不成立
  assertWorksetLimits(next.length, totalPatternLength(entries) - entries[index].value.length, LIMITS_EXCEEDED)
  return next
}
