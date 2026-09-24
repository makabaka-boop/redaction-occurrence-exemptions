import { useCallback, useMemo, useRef, useState } from 'react'
import {
  COUNT_FAILED,
  INVALID_INPUT,
  LIMITS,
  MaskError,
  type PatternEntry,
} from './core/masker'
import {
  adopt,
  addExemption,
  addPattern,
  countByEntry,
  exemptCountByEntry,
  loadSession,
  removeExemption,
  removePattern,
  rollback,
  setPatternEnabled,
  updatePattern,
  type LoadedSession,
  type Snapshot,
} from './core/session'
import {
  ROW_HEIGHT,
  VIEW_HEIGHT,
  VISIBLE_COUNT,
  filterEntries,
  windowStart,
} from './core/patternList'
import { newRowId, patchEntryIds, reconcileEntryIds, type EntryIdPatch } from './core/rowIdentity'
import { sameExemptions, totalExemptions } from './core/exemptions'

interface Draft {
  masked: string
  entries: PatternEntry[]
  /** 采纳时固化的豁免簿（与 masked、entries 成套） */
  exemptionSlots: number[][]
}

export default function App() {
  const [session, setSession] = useState<LoadedSession | null>(null)
  // snapshot 是最近一次成功重算的原子快照（工作集 + 预览 + 计数同源）
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState<number>(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 权威快照引用：一次连续交互中，文本框失焦提交（focusout）与随后的
  // 点击（click：启停/删除/添加/采纳）会在两个事件阶段先后触发。React 的
  // state 在闭包里按渲染时取值，后一个事件若仍读到提交前的快照，就会
  // 静默覆盖前一个已成功动作。所有变更都必须以“最近一次完整成功”的
  // snapshotRef 为唯一输入，成功才推进它；任何失败只拒绝自身，ref 仍指
  // 向最近一次完整成功状态。
  const snapshotRef = useRef<Snapshot | null>(null)
  // 已采纳稿的同步镜像，供跨事件阶段的动作读取最新权威值。
  const draftRef = useRef<Draft | null>(null)
  // 与 snapshot.entries 一一对应的稳定行 ID（见 core/rowIdentity）
  const [rowIds, setRowIds] = useState<string[]>([])
  const rowIdsRef = useRef<string[]>([])

  const commitSnapshot = useCallback(
    (next: Snapshot, prevEntries: PatternEntry[] | null, idPatch?: EntryIdPatch) => {
      // 先推进权威 ref（同步、在任何后续事件阶段之前），再请求渲染
      snapshotRef.current = next
      if (prevEntries === null) {
        rowIdsRef.current = next.entries.map(newRowId)
      } else if (idPatch) {
        rowIdsRef.current = patchEntryIds(rowIdsRef.current, idPatch)
      } else {
        rowIdsRef.current = reconcileEntryIds(
          prevEntries,
          rowIdsRef.current,
          next.entries,
        )
      }
      setSnapshot(next)
      setRowIds(rowIdsRef.current)
    },
    [],
  )

  // 当前工作集相对已采纳稿（无采纳稿时相对文件载入态）是否有未决改动
  const basis = draft?.entries ?? session?.initial ?? []
  const basisExemptions = draft?.exemptionSlots ?? session?.initialExemptions ?? []
  const dirty = useMemo(() => {
    if (!snapshot) return false
    const entries = snapshot.entries
    if (entries.length !== basis.length) return true
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].value !== basis[i].value || entries[i].enabled !== basis[i].enabled) return true
    }
    // 豁免簿也是工作集的一部分：豁免增减同样属于未决改动
    return !sameExemptions(snapshot.exemptions, basisExemptions)
  }, [snapshot, basis, basisExemptions])

  const handleFile = useCallback(async (file: File) => {
    let raw: string
    try {
      raw = await file.text()
    } catch {
      setNotice(INVALID_INPUT)
      return
    }
    try {
      const { session: loaded, snapshot: first } = loadSession(raw)
      // 合法文件 + 首次重算成功才作为候选快照整体提交
      setSession(loaded)
      // 同步重置权威引用，使紧随其后的任何事件阶段都看到新会话
      snapshotRef.current = first
      rowIdsRef.current = first.entries.map(newRowId)
      draftRef.current = null
      setSnapshot(first)
      setRowIds(rowIdsRef.current)
      setDraft(null)
      setElapsed(0)
      setNotice(null)
    } catch (err) {
      if (err instanceof MaskError && err.code === INVALID_INPUT) {
        // 非法文件：显示 INVALID_INPUT 并清除整个会话（含已采纳稿）
        snapshotRef.current = null
        rowIdsRef.current = []
        draftRef.current = null
        setSession(null)
        setSnapshot(null)
        setRowIds([])
        setDraft(null)
        setElapsed(0)
      }
      // COUNT_FAILED（载入后的重算异常）：不替换任何状态，保留上次成功快照
      setNotice(err instanceof MaskError ? err.code : INVALID_INPUT)
    }
  }, [])

  /**
   * 对当前工作集做一次「变更 + 从原文重算」。候选快照只有整体成功才提交；
   * INVALID_PATTERN（非法值/越界）或 COUNT_FAILED（重算异常）时，工作集、
   * 预览、计数与已采纳稿全部保持上一次成功的状态。
   *
   * 串行化保证：本回调引用在组件生命周期内保持稳定，始终从 snapshotRef
   * 读取“用户刚确认的最新工作集”。因此失焦提交后同一手势内立刻触发的
   * 启停 / 增删，会在前一个动作的结果上继续，而不会用渲染闭包里的旧
   * 快照覆盖它；失败动作不推进 ref，也不回滚已成功的前一个动作。
   */
  const runChange = useCallback(
    (mutate: (s: Snapshot) => Snapshot, idPatch: EntryIdPatch = { type: 'keep' }): boolean => {
      const current = snapshotRef.current
      if (!current) return false
      try {
        const t0 = performance.now()
        const next = mutate(current)
        setElapsed(performance.now() - t0)
        commitSnapshot(next, current.entries, idPatch)
        setNotice(null)
        return true
      } catch (err) {
        // 只拒绝本动作：权威 ref 与已渲染状态都停留在最近一次完整成功
        setNotice(err instanceof MaskError ? err.code : COUNT_FAILED)
        return false
      }
    },
    [commitSnapshot],
  )

  const handleAdopt = useCallback(() => {
    // 直接采纳权威快照：失焦提交与采纳点击处在同一手势时，固化的也是
    // 刚编辑成功的工作集，下载稿与当时可见列表 / 预览 / 计数成套一致。
    const current = snapshotRef.current
    if (!current) return
    const next = adopt(current)
    const frozen = {
      masked: next.masked,
      entries: next.entries,
      exemptionSlots: next.exemptions.map((s) => s.slice()),
    }
    draftRef.current = frozen
    setDraft(frozen)
    setNotice(null)
  }, [])

  const handleDiscard = useCallback(() => {
    const current = snapshotRef.current
    if (!session || !current) return
    try {
      const t0 = performance.now()
      const next = rollback(session.text, basis, basisExemptions)
      setElapsed(performance.now() - t0)
      commitSnapshot(next, current.entries)
      setNotice(null)
    } catch (err) {
      // 回滚重算理论上不会失败（基线来自上次成功快照）；保险起见保留现状
      setNotice(err instanceof MaskError ? err.code : COUNT_FAILED)
    }
  }, [session, basis, basisExemptions, commitSnapshot])

  const handleDownload = useCallback(() => {
    // 始终从权威镜像取稿，保证下载文本与屏幕所采纳内容为同一字符串
    const current = draftRef.current
    if (!current) return
    // Blob 直接由屏幕所显示的同一字符串构造，下载内容与屏幕逐字符一致
    const blob = new Blob([current.masked], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'redacted.txt'
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  /**
   * 单次豁免：为某条启用短语在原文起始代码单元处放过**这一个**完整命中。
   * 与普通变更同走权威快照；位置核实（INVALID_POSITION）、豁免数量上界
   * （LIMITS_EXCEEDED）与重算（COUNT_FAILED）都发生在提交之前，失败只
   * 拒绝自身，预览与已采纳稿保留上一次完整成功状态。
   */
  const runExempt = useCallback(
    (index: number, start: number): boolean => {
      const current = snapshotRef.current
      if (!current) return false
      try {
        const t0 = performance.now()
        const next = addExemption(current, index, start)
        setElapsed(performance.now() - t0)
        commitSnapshot(next, current.entries)
        setNotice(null)
        return true
      } catch (err) {
        setNotice(err instanceof MaskError ? err.code : COUNT_FAILED)
        return false
      }
    },
    [commitSnapshot],
  )

  /** 撤销一次单次豁免（幂等）；同样从同一工作集整体重算。 */
  const runUnexempt = useCallback(
    (index: number, start: number): boolean => {
      const current = snapshotRef.current
      if (!current) return false
      try {
        const t0 = performance.now()
        const next = removeExemption(current, index, start)
        setElapsed(performance.now() - t0)
        commitSnapshot(next, current.entries)
        setNotice(null)
        return true
      } catch (err) {
        setNotice(err instanceof MaskError ? err.code : COUNT_FAILED)
        return false
      }
    },
    [commitSnapshot],
  )

  const entries = snapshot?.entries ?? []
  const result = snapshot?.result ?? null
  // 计数映射回完整工作集下标；筛选/窗口化后仍按原始下标取数
  const counts = useMemo(
    () => (snapshot ? countByEntry(snapshot.entries, snapshot.result) : []),
    [snapshot],
  )
  // 每条工作集条目当前生效的豁免数（停用项恒为 0）
  const exemptCounts = useMemo(
    () => (snapshot ? exemptCountByEntry(snapshot.entries, snapshot.result) : []),
    [snapshot],
  )
  // 豁免起始位置按完整工作集下标直取（豁免簿与条目一一对应，无需映射）
  const exemptionSlots = snapshot?.exemptions ?? []
  const exemptTotal = useMemo(
    () => (snapshot ? totalExemptions(snapshot.exemptions) : 0),
    [snapshot],
  )
  const enabledCount = useMemo(() => {
    let n = 0
    for (const e of entries) if (e.enabled) n++
    return n
  }, [entries])

  return (
    <main className="page">
      <h1>事故录音转写 · 敏感短语遮蔽</h1>

      <section className="card">
        <h2>1. 载入输入文件</h2>
        <p className="hint">
          JSON 根仅含 <code>text</code> 与 <code>patterns</code>；text ≤{' '}
          {LIMITS.maxTextCodeUnits.toLocaleString()} 个 UTF-16 代码单元（仅换行 U+000A 与 U+0020..U+007E），
          patterns {LIMITS.minPatterns}..{LIMITS.maxPatterns.toLocaleString()} 条互不重复，
          每条长 {LIMITS.minPatternLength}..{LIMITS.maxPatternLength}，总长 ≤{' '}
          {LIMITS.maxTotalPatternLength.toLocaleString()}。非法文件显示 {INVALID_INPUT} 并清除会话。
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ''
          }}
        />
        {notice && <div className="notice" role="alert">{notice}</div>}
      </section>

      {session && snapshot && result && (
        <>
          <section className="card">
            <h2>2. 短语管理（增改 / 启停 / 删除 / 单次豁免）</h2>
            <AddRow onAdd={(v) => runChange((s) => addPattern(s, v), { type: 'append' })} />
            <PatternList
              entries={entries}
              rowIds={rowIds}
              counts={counts}
              exemptCounts={exemptCounts}
              exemptionSlots={exemptionSlots}
              onUpdate={(i, v) => runChange((s) => updatePattern(s, i, v))}
              onToggle={(i, en) => runChange((s) => setPatternEnabled(s, i, en))}
              onRemove={(i) =>
                runChange((s) => removePattern(s, i), { type: 'removeAt', index: i })
              }
              onExempt={(i, start) => runExempt(i, start)}
              onUnexempt={(i, start) => runUnexempt(i, start)}
            />
          </section>

          <section className="card">
            <h2>3. 预览（每次改动均从原文重算）</h2>
            <p className="stats">
              原文 {session.text.length.toLocaleString()} 代码单元 · 启用{' '}
              {enabledCount.toLocaleString()} / {entries.length.toLocaleString()} 条 · 遮蔽{' '}
              {result.coveredCount.toLocaleString()} 代码单元（覆盖并集，非命中次数） ·
              单次豁免 {exemptTotal.toLocaleString()} 处（每条短语 ≤{' '}
              {LIMITS.maxExemptionsPerEntry}、总数 ≤{' '}
              {LIMITS.maxExemptionsTotal.toLocaleString()}） · 重算耗时 {elapsed.toFixed(1)} ms
            </p>
            <p className="hint">
              每条短语右侧为其<strong>有效命中次数</strong>（完整匹配次数减去被单次豁免的命中；
              区分大小写、允许自重叠、不跨换行）；零命中显示 0，停用项显示“未统计”。
              在行内输入命中的<strong>起始代码单元</strong>并“豁免此处”，经核实确为同一行内的
              完整命中后只放过这一次命中；其他位置、其他短语在同一区域的遮蔽不受影响。
              计数与预览来自同一次重算；{COUNT_FAILED} 时保留上一次成功结果。
            </p>
            <pre className="text-view" aria-label="遮蔽预览">{result.masked}</pre>
            <div className="actions">
              <button type="button" onClick={handleAdopt}>采纳为下载稿</button>
              <button type="button" onClick={handleDiscard} disabled={!dirty}>
                放弃改动
              </button>
              <span className="hint">{dirty ? '存在未采纳改动' : '工作集与下载稿一致'}</span>
            </div>
          </section>

          <section className="card">
            <h2>4. 已采纳的下载稿</h2>
            {draft ? (
              <>
                <p className="stats">
                  {draft.masked.length.toLocaleString()} 代码单元；下方屏幕内容即下载文件内容
                  （UTF-8 无 BOM，逐字符一致）。采纳后继续调整不会改变本稿，再次采纳才更新。
                </p>
                <pre className="text-view" aria-label="已采纳下载稿">{draft.masked}</pre>
                <div className="actions">
                  <button type="button" onClick={handleDownload}>下载 redacted.txt</button>
                </div>
              </>
            ) : (
              <p className="hint">尚未采纳。采纳后可继续调整短语；后续编辑不会覆盖本稿。</p>
            )}
          </section>
        </>
      )}
    </main>
  )
}

function AddRow({ onAdd }: { onAdd: (value: string) => boolean }) {
  const [value, setValue] = useState('')
  const submit = () => {
    if (value === '') return
    // 成功才清空；非法（空串、重复、越界、换行等）时保留输入并由外层提示
    if (onAdd(value)) setValue('')
  }
  return (
    <div className="add-row">
      <input
        type="text"
        value={value}
        maxLength={LIMITS.maxPatternLength}
        placeholder="新增敏感短语（回车添加）"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button type="button" onClick={submit}>添加</button>
    </div>
  )
}

function PatternList({
  entries,
  rowIds,
  counts,
  exemptCounts,
  exemptionSlots,
  onUpdate,
  onToggle,
  onRemove,
  onExempt,
  onUnexempt,
}: {
  entries: PatternEntry[]
  /** 与 entries 一一对应的稳定行 ID（改值不变，新增才换） */
  rowIds: string[]
  counts: Array<number | null>
  /** 每条条目本次重算中生效的豁免数（停用项 0） */
  exemptCounts: number[]
  /** 与 entries 一一对应的豁免起始位置槽 */
  exemptionSlots: readonly (readonly number[])[]
  onUpdate: (index: number, value: string) => boolean
  onToggle: (index: number, enabled: boolean) => void
  onRemove: (index: number) => void
  onExempt: (index: number, start: number) => boolean
  onUnexempt: (index: number, start: number) => void
}) {
  const [filter, setFilter] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 先对全集筛选并保留每条的原始下标，再对筛选结果做窗口化：
  // 窗口外的唯一匹配也能被筛到；增改/启停/删除一律按原始下标提交，
  // 计数也按同一原始下标从完整工作集取数，绝不使用窗口内显示序号。
  const filtered = useMemo(() => filterEntries(entries, filter), [entries, filter])
  const first = windowStart(scrollTop, filtered.length)
  const visible = filtered.slice(first, first + VISIBLE_COUNT)

  return (
    <div className="pattern-list">
      <input
        type="text"
        className="filter"
        placeholder="筛选短语（区分大小写）"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value)
          setScrollTop(0)
          if (scrollRef.current) scrollRef.current.scrollTop = 0
        }}
      />
      <p className="stats">
        显示 {filtered.length.toLocaleString()} / {entries.length.toLocaleString()} 条（窗口化渲染）
      </p>
      <div
        ref={scrollRef}
        className="scroll"
        style={{ height: VIEW_HEIGHT }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: filtered.length * ROW_HEIGHT, position: 'relative' }}>
          {visible.map(({ entry, index }, k) => (
            <PatternRow
              // 使用与值解耦的稳定 ID 作为 key：行内改值提交不会卸载本行，
              // 失焦（focusout）后同一手势内的点击仍落在同一组 DOM 节点上；
              // 增删条目时其他行的 ID 也不变，本地编辑态不会串到别的条目。
              key={rowIds[index]}
              entry={entry}
              count={counts[index]}
              exemptCount={exemptCounts[index] ?? 0}
              slots={exemptionSlots[index] ?? []}
              top={(first + k) * ROW_HEIGHT}
              onUpdate={(v) => onUpdate(index, v)}
              onToggle={(en) => onToggle(index, en)}
              onRemove={() => onRemove(index)}
              onExempt={(start) => onExempt(index, start)}
              onUnexempt={(start) => onUnexempt(index, start)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function PatternRow({
  entry,
  count,
  exemptCount,
  slots,
  top,
  onUpdate,
  onToggle,
  onRemove,
  onExempt,
  onUnexempt,
}: {
  entry: PatternEntry
  count: number | null
  exemptCount: number
  slots: readonly number[]
  top: number
  onUpdate: (value: string) => boolean
  onToggle: (enabled: boolean) => void
  onRemove: () => void
  onExempt: (start: number) => boolean
  onUnexempt: (start: number) => void
}) {
  const [draftValue, setDraftValue] = useState(entry.value)
  const [editing, setEditing] = useState(false)
  // 豁免起始位置的本地草稿（0 基 UTF-16 代码单元）；成功才清空，
  // INVALID_POSITION / LIMITS_EXCEEDED 时保留输入便于修改。
  const [posDraft, setPosDraft] = useState('')

  const commit = () => {
    // 非法时外层不提交；保持编辑态和原值，便于继续修改
    if (draftValue !== entry.value && !onUpdate(draftValue)) {
      return
    }
    setEditing(false)
  }

  const submitExempt = () => {
    if (posDraft === '') return
    const start = Number(posDraft)
    // Number.isFinite 挡住空串/NaN/Infinity；非整数交给会话层 INVALID_POSITION
    if (Number.isFinite(start) && onExempt(start)) setPosDraft('')
  }

  return (
    <div className="pattern-row" style={{ transform: `translateY(${top}px)` }}>
      <div className="row-main">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label="启用"
        />
        <input
          type="text"
          className={`value ${entry.enabled ? '' : 'off'}`}
          value={editing ? draftValue : entry.value}
          maxLength={LIMITS.maxPatternLength}
          onFocus={() => {
            setDraftValue(entry.value)
            setEditing(true)
          }}
          onChange={(e) => setDraftValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraftValue(entry.value)
              setEditing(false)
            }
          }}
        />
        <span
          className={`count ${entry.enabled ? '' : 'off'}`}
          title={
            entry.enabled
              ? '有效命中次数（完整匹配减去被单次豁免的命中；区分大小写、允许自重叠、不跨换行）'
              : '停用项未统计'
          }
          aria-label={entry.enabled ? `有效命中次数 ${count}` : '未统计'}
        >
          {count === null ? '未统计' : count.toLocaleString()}
          {entry.enabled && exemptCount > 0 && (
            <span className="exempt-note" title={`本条已豁免 ${exemptCount} 处单次命中`}>
              （豁免 {exemptCount.toLocaleString()}）
            </span>
          )}
        </span>
        <button type="button" className="remove-btn" onClick={onRemove}>删除</button>
      </div>
      {entry.enabled && (
        <div className="row-exempt">
          <span className="exempt-label">单次豁免起始代码单元：</span>
          <input
            type="number"
            className="pos"
            min={0}
            step={1}
            value={posDraft}
            placeholder="如 12"
            aria-label="豁免起始代码单元"
            onChange={(e) => setPosDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitExempt()
            }}
          />
          <button
            type="button"
            className="exempt-btn"
            onClick={submitExempt}
            title="核实该处确为同一行内的完整命中后，只豁免这一次命中"
          >
            豁免此处
          </button>
          {slots.length > 0 && (
            <span className="chips">
              {slots.map((start) => (
                <button
                  type="button"
                  className="chip"
                  key={start}
                  title={`撤销起始代码单元 ${start} 处的单次豁免`}
                  aria-label={`撤销豁免 ${start}`}
                  onClick={() => onUnexempt(start)}
                >
                  {start.toLocaleString()} ✕
                </button>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
