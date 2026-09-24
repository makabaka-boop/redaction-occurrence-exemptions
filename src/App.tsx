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
  addPattern,
  countByEntry,
  loadSession,
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

interface Draft {
  masked: string
  entries: PatternEntry[]
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
  const dirty = useMemo(() => {
    if (!snapshot) return false
    const entries = snapshot.entries
    if (entries.length !== basis.length) return true
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].value !== basis[i].value || entries[i].enabled !== basis[i].enabled) return true
    }
    return false
  }, [snapshot, basis])

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
    draftRef.current = next
    setDraft(next)
    setNotice(null)
  }, [])

  const handleDiscard = useCallback(() => {
    const current = snapshotRef.current
    if (!session || !current) return
    try {
      const t0 = performance.now()
      const next = rollback(session.text, basis)
      setElapsed(performance.now() - t0)
      commitSnapshot(next, current.entries)
      setNotice(null)
    } catch (err) {
      // 回滚重算理论上不会失败（基线来自上次成功快照）；保险起见保留现状
      setNotice(err instanceof MaskError ? err.code : COUNT_FAILED)
    }
  }, [session, basis, commitSnapshot])

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

  const entries = snapshot?.entries ?? []
  const result = snapshot?.result ?? null
  // 计数映射回完整工作集下标；筛选/窗口化后仍按原始下标取数
  const counts = useMemo(
    () => (snapshot ? countByEntry(snapshot.entries, snapshot.result) : []),
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
            <h2>2. 短语管理（增改 / 启停 / 删除）</h2>
            <AddRow onAdd={(v) => runChange((s) => addPattern(s, v), { type: 'append' })} />
            <PatternList
              entries={entries}
              rowIds={rowIds}
              counts={counts}
              onUpdate={(i, v) => runChange((s) => updatePattern(s, i, v))}
              onToggle={(i, en) => runChange((s) => setPatternEnabled(s, i, en))}
              onRemove={(i) =>
                runChange((s) => removePattern(s, i), { type: 'removeAt', index: i })
              }
            />
          </section>

          <section className="card">
            <h2>3. 预览（每次改动均从原文重算）</h2>
            <p className="stats">
              原文 {session.text.length.toLocaleString()} 代码单元 · 启用{' '}
              {enabledCount.toLocaleString()} / {entries.length.toLocaleString()} 条 · 遮蔽{' '}
              {result.coveredCount.toLocaleString()} 代码单元（覆盖并集，非命中次数） ·
              重算耗时 {elapsed.toFixed(1)} ms
            </p>
            <p className="hint">
              每条短语右侧为其在原文中的<strong>完整匹配次数</strong>
              （区分大小写、允许自重叠、不跨换行）；零命中显示 0，停用项显示“未统计”。
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
  onUpdate,
  onToggle,
  onRemove,
}: {
  entries: PatternEntry[]
  /** 与 entries 一一对应的稳定行 ID（改值不变，新增才换） */
  rowIds: string[]
  counts: Array<number | null>
  onUpdate: (index: number, value: string) => boolean
  onToggle: (index: number, enabled: boolean) => void
  onRemove: (index: number) => void
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
              top={(first + k) * ROW_HEIGHT}
              onUpdate={(v) => onUpdate(index, v)}
              onToggle={(en) => onToggle(index, en)}
              onRemove={() => onRemove(index)}
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
  top,
  onUpdate,
  onToggle,
  onRemove,
}: {
  entry: PatternEntry
  count: number | null
  top: number
  onUpdate: (value: string) => boolean
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}) {
  const [draftValue, setDraftValue] = useState(entry.value)
  const [editing, setEditing] = useState(false)

  const commit = () => {
    // 非法时外层不提交；保持编辑态和原值，便于继续修改
    if (draftValue !== entry.value && !onUpdate(draftValue)) {
      return
    }
    setEditing(false)
  }

  return (
    <div className="pattern-row" style={{ transform: `translateY(${top}px)` }}>
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
        title={entry.enabled ? '原文中的完整匹配次数（区分大小写、允许自重叠、不跨换行）' : '停用项未统计'}
        aria-label={entry.enabled ? `匹配次数 ${count}` : '未统计'}
      >
        {count === null ? '未统计' : count.toLocaleString()}
      </span>
      <button type="button" onClick={onRemove}>删除</button>
    </div>
  )
}
