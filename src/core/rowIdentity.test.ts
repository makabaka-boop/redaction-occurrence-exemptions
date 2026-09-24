import { describe, expect, it } from 'vitest'
import {
  newRowId,
  patchEntryIds,
  reconcileEntryIds,
} from './rowIdentity'

const entriesOf = (values: string[]) => values.map((value) => ({ value }))

describe('patchEntryIds：按动作类型精确调和', () => {
  it('保位（改值/启停）：ID 原样保留，只复制数组', () => {
    const prev = [newRowId(), newRowId(), newRowId()]
    const next = patchEntryIds(prev, { type: 'keep' })
    expect(next).toEqual(prev)
    expect(next).not.toBe(prev)
  })

  it('追加：既有 ID 不变，末尾发一个新 ID', () => {
    const prev = [newRowId(), newRowId()]
    const next = patchEntryIds(prev, { type: 'append' })
    expect(next.slice(0, 2)).toEqual(prev)
    expect(next).toHaveLength(3)
    expect(next[2]).not.toBe(prev[0])
    expect(next[2]).not.toBe(prev[1])
  })

  it('删除：按原始下标拼接，其余行身份不变', () => {
    const prev = [newRowId(), newRowId(), newRowId()]
    expect(patchEntryIds(prev, { type: 'removeAt', index: 1 })).toEqual([
      prev[0],
      prev[2],
    ])
    expect(patchEntryIds(prev, { type: 'removeAt', index: 0 })).toEqual([
      prev[1],
      prev[2],
    ])
    expect(patchEntryIds(prev, { type: 'removeAt', index: 2 })).toEqual([
      prev[0],
      prev[1],
    ])
  })

  it('多次增删后，未动条目始终持有同一 ID（编辑态跟随条目而非位置）', () => {
    let ids = ['a', 'b', 'c', 'd'].map(newRowId)
    const tracked = ids[1]
    // 删除 a（下标 0）
    ids = patchEntryIds(ids, { type: 'removeAt', index: 0 })
    // 原 b 现在位于下标 0，ID 不变
    expect(ids[0]).toBe(tracked)
    // 末尾追加
    ids = patchEntryIds(ids, { type: 'append' })
    // 改值/启停：保位
    ids = patchEntryIds(ids, { type: 'keep' })
    expect(ids[0]).toBe(tracked)
  })
})

describe('reconcileEntryIds：按内容（值）调和', () => {
  it('值未变的条目沿用旧 ID（即使位置移动），新值发新 ID', () => {
    const prevEntries = entriesOf(['x', 'y', 'z'])
    const prevIds = prevEntries.map(newRowId)
    // 整体替换（例如放弃回滚后又增删）：y 删除、w 新增、x/z 保留
    const nextEntries = entriesOf(['z', 'x', 'w'])
    const next = reconcileEntryIds(prevEntries, prevIds, nextEntries)
    expect(next[0]).toBe(prevIds[2]) // z 跟随到新位置 0
    expect(next[1]).toBe(prevIds[0]) // x 跟随到新位置 1
    expect(next[2]).not.toBe(prevIds[0]) // w 是新 ID
    expect(next[2]).not.toBe(prevIds[1])
    expect(next[2]).not.toBe(prevIds[2])
  })

  it('长度不一致（新会话）时全部重新分配，且互不重复', () => {
    const next = reconcileEntryIds(entriesOf(['x']), ['id-x'], entriesOf(['a', 'b']))
    expect(next).toHaveLength(2)
    expect(next[0]).not.toBe(next[1])
    expect(new Set(next).size).toBe(2)
  })

  it('改值场景：旧值消失发新 ID，其余行 ID 不变', () => {
    const prevEntries = entriesOf(['aa', 'bb'])
    const prevIds = prevEntries.map(newRowId)
    const next = reconcileEntryIds(prevEntries, prevIds, entriesOf(['aaaa', 'bb']))
    expect(next[0]).not.toBe(prevIds[0])
    expect(next[1]).toBe(prevIds[1])
  })
})

describe('newRowId：唯一性', () => {
  it('连续生成的 ID 互不相同', () => {
    const ids = Array.from({ length: 1000 }, newRowId)
    expect(new Set(ids).size).toBe(1000)
  })
})
