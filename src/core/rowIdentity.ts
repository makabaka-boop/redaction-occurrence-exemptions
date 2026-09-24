/**
 * 行身份调和：给工作集的每条短语分配一个**与值解耦**的稳定标识。
 *
 * 背景：行的本地编辑态（正在编辑的文本框、焦点）必须跟随“同一条目”，
 * 而不能跟随短语值。若以值为 key，行内改值提交后 React 会把该行当作
 * 新节点卸载重建；当提交发生在一次连续交互的失焦（focusout）阶段、而
 * 点击（启停/删除/添加/采纳）发生在随后的 click 阶段时，mousedown 已
 * 落在被卸载的旧节点上，后半个手势可能丢失。下标为 key 则会在增删后
 * 把编辑态串到别的条目上。
 *
 * 两类调和：
 * - 精确补丁（patchEntryIds）：页面动作类型已知——改值/启停保位（ID
 *   不变，因此“编辑同一行后立刻删除该行”的连续手势也不重建节点）、
 *   追加在末尾发新 ID、删除按原始下标拼接，其他行身份全部保留。
 * - 内容调和（reconcileEntryIds）：用于载入、放弃回滚等整体替换场景，
 *   值未变的条目沿用旧 ID，新值发新 ID；短语值在工作集内唯一（重复值
 *   会被 INVALID_PATTERN 拒绝），值即可用作身份。
 */

let nextId = 1

/** 生成一个进程内唯一的行 ID（仅用于 React key，不参与持久化） */
export function newRowId(): string {
  return `r${nextId++}`
}

export type EntryIdPatch =
  | { type: 'keep' }
  | { type: 'append' }
  | { type: 'removeAt'; index: number }

/**
 * 按已知动作类型给 ID 列表打补丁，产出与新工作集一一对应的 ID。
 * 保位动作（改值/启停）原样返回：同一行改值不换身份，连续手势中
 * focusout 与 click 面对的是同一组 DOM 节点。
 */
export function patchEntryIds(prevIds: readonly string[], patch: EntryIdPatch): string[] {
  switch (patch.type) {
    case 'keep':
      return [...prevIds]
    case 'append':
      return [...prevIds, newRowId()]
    case 'removeAt':
      return prevIds.filter((_, j) => j !== patch.index)
  }
}

/**
 * 内容调和：值同时存在于新旧工作集则沿用旧 ID（位置变化也跟随），
 * 仅出现在新工作集的值发新 ID。prevIds 必须与 prevEntries 等长；长度
 * 不符（例如新会话）时全部重新分配。
 */
export function reconcileEntryIds(
  prevEntries: readonly { value: string }[],
  prevIds: readonly string[],
  nextEntries: readonly { value: string }[],
): string[] {
  if (prevEntries.length !== prevIds.length) {
    return nextEntries.map(newRowId)
  }
  const idByValue = new Map<string, string>()
  for (let i = 0; i < prevEntries.length; i++) {
    idByValue.set(prevEntries[i].value, prevIds[i])
  }
  return nextEntries.map((e) => idByValue.get(e.value) ?? newRowId())
}
