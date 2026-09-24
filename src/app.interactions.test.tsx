// @vitest-environment jsdom
/**
 * 连续交互的集成验收：真实失焦后点击的手势顺序。
 *
 * 浏览器在一次“点别处”的手势中同步派发：mousedown → focusout/blur →
 * mouseup → click。行内文本框的失焦提交（重算 A）与随后的启停 / 增删 /
 * 采纳（重算 B）因此可能发生在同一次连续操作里。本套件在 jsdom 中按这一
 * 真实顺序派发原生事件，核对：
 *
 * 1. 每次连续操作都以“用户刚确认的最新工作集”为唯一输入，成功动作不被
 *    后续动作静默覆盖；
 * 2. 行值、匹配计数、遮蔽预览、采纳快照、下载文本始终成套一致；
 * 3. 任一失败（注入 maskText 抛错）只拒绝自身，保留最近一次完整成功状态；
 * 4. 现有筛选、窗口化、停用“未统计”显示与下载格式保持兼容。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// 故障注入：App 通过 session 间接调用 maskText，给它包一层可按调用序号
// 抛错的 mock（默认走真实算法）。真实实现同时被捕获到 hoisted holder，供
// 条件失败时兜底，从而精确制造“前一动作重算成功、后一动作重算异常”的
// 交错序列（vi.mock 工厂会被提升，外部普通变量处于 TDZ，故必须用 hoisted）。
const maskHolder = vi.hoisted(() => ({
  realMaskText: null as null | ((text: string, patterns: readonly string[], exemptions?: unknown) => unknown),
}))
vi.mock('./core/masker', async () => {
  const actual = await vi.importActual<typeof import('./core/masker')>('./core/masker')
  maskHolder.realMaskText = actual.maskText as never
  return {
    ...actual,
    maskText: vi.fn(actual.maskText),
  }
})

import { maskText, type MaskResult } from './core/masker'
import App from './App'

const mockedMaskText = vi.mocked(maskText)
const realMaskText = (
  text: string,
  patterns: readonly string[],
  exemptions?: readonly import('./core/masker').ExemptionHit[],
): MaskResult =>
  (
    maskHolder.realMaskText as (
      t: string,
      p: readonly string[],
      e?: readonly import('./core/masker').ExemptionHit[],
    ) => MaskResult
  )(text, patterns, exemptions)

const mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(() => {
  // 每个用例后还原为真实实现并卸载，避免失败注入串到后续用例
  mockedMaskText.mockReset()
  mockedMaskText.mockImplementation(((...args) => realMaskText(...args)) as typeof maskText)
  for (const m of mounted) {
    act(() => m.root.unmount())
    m.container.remove()
  }
  mounted.length = 0
})

// ---------------------------------------------------------------------------
// 渲染与事件工具
// ---------------------------------------------------------------------------

async function renderApp(text: string, patterns: string[]): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(React.createElement(App))
  })
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', {
    value: [new File([JSON.stringify({ text, patterns })], 'in.json', { type: 'application/json' })],
    configurable: true,
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
  return container
}

const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.pattern-row')]
const rowText = (r: HTMLElement) => r.querySelectorAll<HTMLInputElement>('input')[1]
const rowCheck = (r: HTMLElement) => r.querySelectorAll<HTMLInputElement>('input')[0]
const rowCount = (r: HTMLElement) => r.querySelector<HTMLElement>('.count')!
const rowDelete = (r: HTMLElement) =>
  [...r.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '删除')!

/**
 * 用原生 setter 改写受控输入并派发 input（React 受控组件要求）。
 * focus 与键入分属两个 act：浏览器中聚焦（mousedown）与按键本就是跨渲染的
 * 离散事件；同批处理时，onFocus 对草稿的重置可能与紧随的 input 互相覆盖，
 * 尤其是上一次编辑被拒绝、草稿值与工作集值不一致时。
 */
function typeInto(el: HTMLInputElement, value: string) {
  act(() => {
    el.focus()
  })
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 普通点击（按钮 / 复选框），click 是否真的派发到了已挂载节点。 */
function click(el: Element): boolean {
  let reached = false
  el.addEventListener('click', () => (reached = true), { once: true })
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return reached
}

/**
 * 一次连续操作的真实手势：在 textEl 失焦提交的同时按下别处控件 ——
 * mousedown 先触发失焦（focusout）提交，随后 mouseup/click 触发第二个动作。
 * 两个动作同属一次 act（同一连续操作）。jsdom 的 mousedown 可能已自行移动
 * 焦点（与浏览器一致），因此只在文本框仍是活动元素时补一次 blur()，保证
 * 恰好失焦一次，不产生重复提交。
 */
function blurThenClick(textEl: HTMLElement, target: Element): boolean {
  let reached = false
  target.addEventListener('click', () => (reached = true), { once: true })
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    if (document.activeElement === textEl) textEl.blur()
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return reached
}

function setFilter(c: HTMLElement, value: string) {
  typeInto(c.querySelector<HTMLInputElement>('input.filter')!, value)
}

function buttonByText(c: HTMLElement, text: string): HTMLButtonElement {
  return [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent!.includes(text),
  )!
}

const workPreview = (c: HTMLElement) => c.querySelectorAll('pre.text-view')[0]!.textContent!
const adoptedPreview = (c: HTMLElement) =>
  c.querySelectorAll('pre.text-view')[1]?.textContent ?? null
const notice = (c: HTMLElement) => c.querySelector('[role=alert]')?.textContent ?? null

// --- 单次豁免控件 ---
const rowPosInput = (r: HTMLElement) =>
  r.querySelector<HTMLInputElement>('input.pos')
const rowExemptBtn = (r: HTMLElement) =>
  [...r.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '豁免此处')!
const rowChips = (r: HTMLElement) => [...r.querySelectorAll<HTMLButtonElement>('button.chip')]
/** 短语管理区的“显示 N / M 条”统计（DOM 中第一个 .stats，位于预览统计之前） */
const listStats = (c: HTMLElement) =>
  c.querySelector('.pattern-list')!.querySelector('.stats')!.textContent!

/**
 * 成套一致性断言：列表行（值 / 启停 / 计数文案）与工作预览同源于一次
 * 成功快照；零有效命中为 0，停用为“未统计”。计数节点可附带“（豁免 N）”
 * 标注，断言只比对其开头的有效命中数字。
 */
function expectRowsCoherent(
  c: HTMLElement,
  expected: Array<{ value: string; enabled: boolean; count: number | null }>,
) {
  const rs = rows(c)
  expect(rs.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(rowText(rs[i]).value).toBe(expected[i].value)
    expect(rowCheck(rs[i]).checked).toBe(expected[i].enabled)
    if (expected[i].count === null) {
      expect(rowCount(rs[i]).textContent).toBe('未统计')
    } else {
      expect(rowCount(rs[i]).textContent!.startsWith(String(expected[i].count))).toBe(true)
    }
  }
}

// ---------------------------------------------------------------------------
// 验收用例
// ---------------------------------------------------------------------------

describe('连续交互：失焦提交与随后点击不互相覆盖', () => {
  it('行内改值后立即勾选启停：值与勾选都生效，计数/预览成套重算', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), rowCheck(rows(c)[0]))).toBe(true)

    // 'aaaa'（停用，未统计）+ 'bb'（启用，'bb' 在 bbbb 中命中 3）
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: false, count: null },
      { value: 'bb', enabled: true, count: 3 },
    ])
    // 停用项不遮蔽：只有 b 段被盖
    expect(workPreview(c)).toBe('aaaa ####')
    expect(notice(c)).toBeNull()
  })

  it('行内改值后立即添加另一条：两个动作都成功且以编辑后的工作集为输入', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    // 先填好新增框，再到行里编辑并失焦到“添加”按钮
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    typeInto(addInput, 'xx')
    typeInto(rowText(rows(c)[1]), 'b')
    expect(blurThenClick(rowText(rows(c)[1]), buttonByText(c, '添加'))).toBe(true)

    expectRowsCoherent(c, [
      { value: 'aa', enabled: true, count: 3 },
      { value: 'b', enabled: true, count: 4 },
      { value: 'xx', enabled: true, count: 0 },
    ])
    // 'aa' 盖满 aaaa，'b' 盖满 bbbb；'xx' 零命中
    expect(workPreview(c)).toBe('#### ####')
    expect(notice(c)).toBeNull()
  })

  it('连续手势中先编辑（第 0 行）再删除另一条（第 1 行）：两者都保留，下标不错位', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), rowDelete(rows(c)[1]))).toBe(true)
    // 编辑只改值（仍启用）；删除作用于原下标 1 的 'bb'
    expectRowsCoherent(c, [{ value: 'aaaa', enabled: true, count: 1 }])
    expect(workPreview(c)).toBe('#### bbbb')
  })

  it('同一行编辑后立即删除该行：手势后半段不丢，编辑不留残，删除生效', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), rowDelete(rows(c)[0]))).toBe(true)
    expectRowsCoherent(c, [{ value: 'bb', enabled: true, count: 3 }])
    expect(workPreview(c)).toBe('aaaa ####')
  })

  it('编辑后立即“采纳为下载稿”：采纳快照固化编辑后的工作集与预览', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), buttonByText(c, '采纳为下载稿'))).toBe(true)

    const expected = '#### ####'
    expect(workPreview(c)).toBe(expected)
    expect(adoptedPreview(c)).toBe(expected)
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
    ])
  })

  it('采纳后继续编辑不改采纳稿；再次采纳才更新；下载文本即屏幕采纳串', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    click(buttonByText(c, '采纳为下载稿'))
    const firstDraft = '#### ####'
    expect(adoptedPreview(c)).toBe(firstDraft)

    // 停用 'aa'：工作预览变化，采纳稿保持第一次的串
    click(rowCheck(rows(c)[0]))
    expect(workPreview(c)).toBe('aaaa ####')
    expect(adoptedPreview(c)).toBe(firstDraft)

    // 下载内容必须是屏幕采纳区的同一字符串（UTF-8 无转换）。
    // jsdom 不实现 createObjectURL，按接口最小打桩并截获 Blob；同时打桩
    // 合成锚点点击（避免 jsdom 导航告警）并核对下载属性。
    const blobs: Blob[] = []
    const create = vi.fn((b: Blob | MediaSource) => {
      blobs.push(b as Blob)
      return 'blob:test'
    })
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true })
    let downloaded = false
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe('redacted.txt')
        expect(this.href).toBe('blob:test')
        downloaded = true
      })
    click(buttonByText(c, '下载 redacted.txt'))
    anchorClick.mockRestore()
    expect(downloaded).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(blobs).toHaveLength(1)
    expect(await blobs[0].text()).toBe(firstDraft)

    // 再次采纳：下载稿更新到当前工作预览
    click(buttonByText(c, '采纳为下载稿'))
    expect(adoptedPreview(c)).toBe('aaaa ####')
  })

  it('注入重算失败：编辑成功、随后的勾选重算异常时只拒绝勾选，编辑不回滚', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    // 连续手势内依次发生两次重算：第 1 次（失焦编辑）成功，第 2 次（勾选）抛错
    let calls = 0
    mockedMaskText.mockImplementation(((text: string, pats: readonly string[]) => {
      calls += 1
      if (calls === 2) throw new Error('boom on toggle recompute')
      return realMaskText(text, pats)
    }) as typeof maskText)

    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), rowCheck(rows(c)[0]))).toBe(true)

    // 权威状态停在“编辑成功”这一完整快照；勾选被自身失败拒绝。
    // 合成 click 会把复选框视觉状态拨到“未勾选”，但 React 重渲染会按
    // 权威工作集（仍启用）拨回；输入框提交成功后也显示新值。
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(workPreview(c)).toBe('#### ####')
    expect(notice(c)).toBe('COUNT_FAILED')
    expect(calls).toBe(2)
  })

  it('失败后下一次正常启停成功：错误清除，自动恢复到完整一致状态', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('transient')
    })
    click(rowCheck(rows(c)[0]))
    expect(notice(c)).toBe('COUNT_FAILED')
    expectRowsCoherent(c, [
      { value: 'aa', enabled: true, count: 3 },
      { value: 'bb', enabled: true, count: 3 },
    ])

    // 单次注入已耗尽；下一次点击走真实实现，停用成功
    click(rowCheck(rows(c)[0]))
    expect(notice(c)).toBeNull()
    expectRowsCoherent(c, [
      { value: 'aa', enabled: false, count: null },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(workPreview(c)).toBe('aaaa ####')
  })

  it('编辑为非法值（重复）后立即勾选：编辑被拒绝，勾选照常生效', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'bb') // 与第 1 行重复
    expect(blurThenClick(rowText(rows(c)[0]), rowCheck(rows(c)[0]))).toBe(true)

    // 编辑被拒绝：工作集条目仍是 'aa'，但输入框按约定保留草稿值便于继续修改；
    // 同一手势中的停用成功（失败的编辑不回滚它），计数映射为“未统计”。
    const rs = rows(c)
    expect(rowText(rs[0]).value).toBe('bb') // 输入框保留当前输入（非法值未固化）
    expect(rowCheck(rs[0]).checked).toBe(false)
    expect(rowCount(rs[0]).textContent).toBe('未统计')
    // 第 1 行工作集不受影响
    expect(rowText(rs[1]).value).toBe('bb')
    expect(rowCheck(rs[1]).checked).toBe(true)
    expect(rowCount(rs[1]).textContent).toBe('3')
    // 工作预览只反映停用：aa 不遮蔽，只剩 bb
    expect(workPreview(c)).toBe('aaaa ####')
    // 连续手势里后一个勾选成功；成功动作按约定清除之前的错误提示，
    // 非法拒绝由“输入框保留草稿 + 工作集未变”可见。

    // 单独失焦一个非法值时，错误提示会持续显示（没有后续成功动作覆盖）
    typeInto(rowText(rs[0]), 'bb')
    act(() => rowText(rs[0]).blur())
    expect(notice(c)).toBe('INVALID_PATTERN')
    expect(rowText(rows(c)[0]).value).toBe('bb')

    // 把草稿改成合法值（与第 1 行不同）后提交成功：输入框与工作集重新一致，
    // 错误清除，且仍是停用状态（启停不被编辑覆盖）
    typeInto(rowText(rows(c)[0]), 'aaa')
    act(() => rowText(rows(c)[0]).blur())
    expectRowsCoherent(c, [
      { value: 'aaa', enabled: false, count: null },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(notice(c)).toBeNull()
  })

  it('筛选兼容：筛到窗口外唯一条目后行内编辑并启停，仍作用于正确原始下标', async () => {
    const c = await renderApp('abcdef cdef', ['aa', 'bc', 'cdef', 'x'])
    setFilter(c, 'cdef')
    expect(rows(c)).toHaveLength(1)
    const only = rows(c)[0]
    typeInto(rowText(only), 'cde')
    expect(blurThenClick(rowText(only), rowCheck(only))).toBe(true)

    setFilter(c, '')
    expectRowsCoherent(c, [
      { value: 'aa', enabled: true, count: 0 },
      { value: 'bc', enabled: true, count: 1 },
      { value: 'cde', enabled: false, count: null },
      { value: 'x', enabled: true, count: 0 },
    ])
    // 只有启用的 'bc' 遮蔽位置 1..2；停用的 'cde' 不遮蔽
    expect(workPreview(c)).toBe('a##def cdef')
  })

  it('失焦后的添加重算失败：编辑保留、添加被拒，随后单独添加可成功', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    typeInto(addInput, 'zz')
    typeInto(rowText(rows(c)[0]), 'aaaa')

    // 连续手势内：第 1 次重算（失焦编辑）成功，第 2 次（添加）失败
    let calls = 0
    mockedMaskText.mockImplementation(((text: string, pats: readonly string[]) => {
      calls += 1
      if (calls === 2) throw new Error('boom on add')
      return realMaskText(text, pats)
    }) as typeof maskText)
    expect(blurThenClick(rowText(rows(c)[0]), buttonByText(c, '添加'))).toBe(true)

    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(workPreview(c)).toBe('#### ####')
    expect(notice(c)).toBe('COUNT_FAILED')
    expect(calls).toBe(2)

    // 添加框保留 'zz'；恢复真实实现后单独点击添加成功
    mockedMaskText.mockReset()
    mockedMaskText.mockImplementation(((...args) => realMaskText(...args)) as typeof maskText)
    click(buttonByText(c, '添加'))
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
      { value: 'zz', enabled: true, count: 0 },
    ])
    expect(notice(c)).toBeNull()
    expect(addInput.value).toBe('') // 成功后输入框清空
  })

  it('失焦编辑重算失败后同手势采纳：不得固化编辑前的工作集，旧采纳稿不变', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    // 先有一份旧采纳稿
    click(buttonByText(c, '采纳为下载稿'))
    const oldDraft = adoptedPreview(c)
    expect(oldDraft).toBe('#### ####')

    // 失焦编辑（'aa'→'aaaa'）这一次重算即失败；同手势随后点击采纳
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom on edit recompute')
    })
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), buttonByText(c, '采纳为下载稿'))).toBe(true)

    // 编辑被自身失败拒绝：工作集仍是旧值；输入框按约定保留草稿 'aaaa' 便于
    // 重试，但计数/预览来自上一次成功快照（'aa' 命中 3 次）。采纳不得固化
    // 任何编辑前/编辑后的“半提交”工作集——已采纳稿保持上一份。
    const rs0 = rows(c)[0]
    expect(rowText(rs0).value).toBe('aaaa') // 草稿保留（未固化）
    expect(rowCheck(rs0).checked).toBe(true)
    expect(rowCount(rs0).textContent).toBe('3') // 上次成功计数
    expect(rowText(rows(c)[1]).value).toBe('bb')
    expect(workPreview(c)).toBe(oldDraft)
    expect(adoptedPreview(c)).toBe(oldDraft)
    // 采纳本身不重算、总是成功，因此清除前一个动作的错误提示；拒绝只体现在
    // “工作集/计数/预览/采纳稿均未变、草稿保留”上。
    expect(notice(c)).toBeNull()

    // 恢复后再次编辑 + 采纳（真实手势顺序），新采纳稿与可见列表/预览成套
    mockedMaskText.mockReset()
    mockedMaskText.mockImplementation(((...args) => realMaskText(...args)) as typeof maskText)
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), buttonByText(c, '采纳为下载稿'))).toBe(true)
    expect(workPreview(c)).toBe('#### ####')
    expect(adoptedPreview(c)).toBe('#### ####')
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(notice(c)).toBeNull()
  })

  it('停用成功后同手势删除重算失败：停用保留，删除被自身失败拒绝', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    // 第 1 次重算（停用第 0 行）成功，第 2 次（删除第 1 行）失败
    let calls = 0
    mockedMaskText.mockImplementation(((text: string, pats: readonly string[]) => {
      calls += 1
      if (calls === 2) throw new Error('boom on remove')
      return realMaskText(text, pats)
    }) as typeof maskText)
    // 手势：点第 0 行复选框（mousedown 无失焦编辑）——为制造“连续两次重算”，
    // 先停用第 0 行，再在同一 act 内删除第 1 行
    act(() => {
      const checks = [rowCheck(rows(c)[0]), rowDelete(rows(c)[1])]
      checks[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      checks[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls).toBe(2)
    // 停用成功（第 0 行未统计）；删除被拒绝，第 1 行仍在
    expectRowsCoherent(c, [
      { value: 'aa', enabled: false, count: null },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(workPreview(c)).toBe('aaaa ####')
    expect(notice(c)).toBe('COUNT_FAILED')
  })
})

// ---------------------------------------------------------------------------
// 聚合约束（数量 1..50,000、总长 ≤ 300,000）的界面验收：越界动作只拒绝
// 当前动作并完整保留最近一次成功的列表、计数、预览与采纳稿；恰在边界的
// 启停、筛选、窗口化、合法下载保持兼容；错误码与四类快照成套一致。
// ---------------------------------------------------------------------------
describe('聚合约束：删除唯一短语与采纳交错', () => {
  it('唯一短语删除被 LIMITS_EXCEEDED 拒绝：四类快照成套保留，恢复后可继续编辑', async () => {
    const c = await renderApp('aXaY', ['X'])
    // 先采纳，建立已采纳稿
    click(buttonByText(c, '采纳为下载稿'))
    expect(adoptedPreview(c)).toBe('a#aY')

    // 删除唯一短语：被聚合约束拒绝
    click(rowDelete(rows(c)[0]))
    expect(notice(c)).toBe('LIMITS_EXCEEDED')
    // 四类快照成套不变：列表行、计数、工作预览、采纳稿
    expectRowsCoherent(c, [{ value: 'X', enabled: true, count: 1 }])
    expect(workPreview(c)).toBe('a#aY')
    expect(adoptedPreview(c)).toBe('a#aY')

    // 拒绝后下一个合法动作照常生效（改值重算成功，错误清除）
    typeInto(rowText(rows(c)[0]), 'Y')
    act(() => rowText(rows(c)[0]).blur())
    expect(notice(c)).toBeNull()
    expectRowsCoherent(c, [{ value: 'Y', enabled: true, count: 1 }])
    expect(workPreview(c)).toBe('aXa#')
    // 采纳稿停在删除被拒之前的旧稿，未被任何失败/后续预览覆盖
    expect(adoptedPreview(c)).toBe('a#aY')

    // 此时仍只有一条：删除依旧被拒
    click(rowDelete(rows(c)[0]))
    expect(notice(c)).toBe('LIMITS_EXCEEDED')
    expectRowsCoherent(c, [{ value: 'Y', enabled: true, count: 1 }])
    expect(workPreview(c)).toBe('aXa#')

    // 新增第二条后，删除任意一条都合法（数量恰在下界之上）
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    typeInto(addInput, 'X')
    click(buttonByText(c, '添加'))
    expect(notice(c)).toBeNull()
    expectRowsCoherent(c, [
      { value: 'Y', enabled: true, count: 1 },
      { value: 'X', enabled: true, count: 1 },
    ])
    click(rowDelete(rows(c)[1]))
    expect(notice(c)).toBeNull()
    expectRowsCoherent(c, [{ value: 'Y', enabled: true, count: 1 }])
  })

  it('越界删除与采纳同手势：删除被拒，采纳不固化任何半提交工作集', async () => {
    const c = await renderApp('aXaY', ['X'])
    click(buttonByText(c, '采纳为下载稿'))
    // 直接点删除按钮（普通点击手势），随后采纳：删除先被拒
    click(rowDelete(rows(c)[0]))
    expect(notice(c)).toBe('LIMITS_EXCEEDED')
    click(buttonByText(c, '采纳为下载稿'))
    // 采纳成功清除提示，但采纳稿与工作集都仍是合法的上次成功状态
    expect(notice(c)).toBeNull()
    expect(adoptedPreview(c)).toBe('a#aY')
    expect(workPreview(c)).toBe('a#aY')
    expectRowsCoherent(c, [{ value: 'X', enabled: true, count: 1 }])
  })
})

describe('聚合约束：总长上界 300,000 的连续增改、启停、筛选与采纳交错', () => {
  // 1499 条长 200 + 1 条 199 = 1500 条、总长 299,999（差 1 到上界）
  function nearCapFile(): { text: string; patterns: string[] } {
    const patterns: string[] = []
    for (let i = 0; i < 1499; i++) {
      patterns.push(String(i).padStart(7, '0') + 'x'.repeat(193))
    }
    patterns.push('y'.repeat(199))
    return { text: 'x', patterns }
  }

  it('差 1 到上界：加 1 字符合法、加 2 字符拒绝；启停/筛选/计数不受影响', async () => {
    const input = nearCapFile()
    const c = await renderApp(input.text, input.patterns)
    expect(listStats(c)).toContain('1,500')

    // 加 1 字符：恰好 300,000，合法
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    typeInto(addInput, 'z')
    click(buttonByText(c, '添加'))
    expect(notice(c)).toBeNull()
    expect(listStats(c)).toContain('1,501')

    // 再加 2 字符：总长 300,002 → 拒绝，行计数与预览留在 1501 条的成功态
    typeInto(addInput, 'zw')
    click(buttonByText(c, '添加'))
    expect(notice(c)).toBe('LIMITS_EXCEEDED')
    expect(listStats(c)).toContain('1,501') // 没有半提交出第 1502 行
    expect(addInput.value).toBe('zw') // 非法输入保留草稿

    // 停用最后一条（单字符 'z'）不改变聚合量：先筛到该行再操作
    setFilter(c, 'z')
    expect(rows(c)).toHaveLength(1)
    click(rowCheck(rows(c)[0]))
    expect(notice(c)).toBeNull()
    expect(rowCheck(rows(c)[0]).checked).toBe(false)
    expect(rowCount(rows(c)[0]).textContent).toBe('未统计')
    // 重新启用同样成功
    click(rowCheck(rows(c)[0]))
    expect(rowCheck(rows(c)[0]).checked).toBe(true)

    // 筛选在边界规模上仍作用于全集：唯一短条目（199 个 y）可被定位
    setFilter(c, 'yyy')
    expect(rows(c)).toHaveLength(1)
    // 不可能命中的筛选串返回空窗（不渲染行，但全集计数不变）
    setFilter(c, '~~绝不可能命中~~')
    expect(rows(c)).toHaveLength(0)
    expect(listStats(c)).toContain('0 / 1,501')
    setFilter(c, '')
    expect(rows(c).length).toBeGreaterThan(1)
    expect(listStats(c)).toContain('1,501 / 1,501')
  })

  it('采纳交错：上界附近越界新增被拒，采纳稿不变；合法新增后再次采纳更新', async () => {
    const input = nearCapFile()
    // 用单字符 'z' 作文本：载入态短语都很长、无法在单字符内匹配；
    // 之后新增的单字符 'z' 恰好命中，遮蔽稿可据此区分新旧工作集。
    const c = await renderApp('z', input.patterns)
    click(buttonByText(c, '采纳为下载稿'))
    const firstDraft = adoptedPreview(c)
    // 没有任何短语能在单字符文本内完整匹配（最短短语也是 199 长），故为 'z'
    expect(firstDraft).toBe('z')

    // 先合法加 1 字符到上界（但不采纳），再越界新增：必须被拒
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    typeInto(addInput, 'z')
    click(buttonByText(c, '添加'))
    expect(notice(c)).toBeNull()
    expect(listStats(c)).toContain('1,501 / 1,501')
    typeInto(addInput, 'zw')
    click(buttonByText(c, '添加'))
    expect(notice(c)).toBe('LIMITS_EXCEEDED')
    expect(listStats(c)).toContain('1,501 / 1,501')
    // 已采纳稿仍是最初那份（遮蔽稿 'z'），未被越界动作波及
    expect(adoptedPreview(c)).toBe(firstDraft)
    // 工作预览来自 1501 条的上次成功快照；单字符 'z' 命中 → '#'
    expect(workPreview(c)).toBe('#')

    // 再次采纳：固化当前合法工作集（1501 条，'z' 命中），下载稿变为 '#'
    click(buttonByText(c, '采纳为下载稿'))
    expect(notice(c)).toBeNull()
    expect(adoptedPreview(c)).toBe('#')

    // 之后任何越界新增依旧被拒，采纳稿不动
    typeInto(addInput, 'q')
    click(buttonByText(c, '添加'))
    expect(notice(c)).toBe('LIMITS_EXCEEDED')
    expect(adoptedPreview(c)).toBe('#')
  })
})

// ---------------------------------------------------------------------------
// 单次豁免的界面验收：从启用条目指定起始代码单元，核实为同一行内完整命中
// 后只放过这一次；无效位置 / 停用 / 清理 / 撤销 / 采纳固化成套一致。
// ---------------------------------------------------------------------------
describe('单次豁免：工作台交互', () => {
  /** 在行内位置框输入数字（触发 input），不提交 */
  function typePos(el: HTMLInputElement, value: string) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('指定起始代码单元豁免命中：只放过该处，其他位置仍遮蔽，计数/覆盖同源更新', async () => {
    // 'abc' 三次：0、7、14；x 两次（"xx"）；yy 不被任何短语遮蔽
    const c = await renderApp('abc xx abc yy abc', ['abc', 'x'])
    const r0 = rows(c)[0]
    // 初始：abc 有效命中 3，预览全覆盖 abc 与 xx，yy 保留
    expect(rowCount(r0).textContent!.startsWith('3')).toBe(true)
    expect(workPreview(c)).toBe('### ## ### yy ###')

    typePos(rowPosInput(r0)!, '7')
    click(rowExemptBtn(r0))
    expect(notice(c)).toBeNull()
    // 中间那次还原，首尾仍遮蔽
    expect(workPreview(c)).toBe('### ## abc yy ###')
    // 计数显示有效命中 2 + 豁免标注
    expect(rowCount(r0).textContent).toContain('2')
    expect(rowCount(r0).textContent).toContain('豁免 1')
    // 出现可撤销的 chip（起点 7）
    const chips = rowChips(r0)
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toContain('7')
    // 同词其他位置仍遮蔽
    expect(workPreview(c)[0]).toBe('#')
    expect(workPreview(c)[14]).toBe('#')
    // x 的遮蔽不受影响
    expect(workPreview(c)[4]).toBe('#')
    expect(workPreview(c)[5]).toBe('#')
  })

  it('撤销 chip：该命中恢复遮蔽，计数回升，chip 消失', async () => {
    const c = await renderApp('abc xx abc yy abc', ['abc'])
    const r0 = rows(c)[0]
    typePos(rowPosInput(r0)!, '7')
    click(rowExemptBtn(r0))
    expect(workPreview(c)).toBe('### xx abc yy ###')
    click(rowChips(r0)[0])
    expect(notice(c)).toBeNull()
    expect(workPreview(c)).toBe('### xx ### yy ###')
    expect(rowChips(r0)).toHaveLength(0)
    expect(rowCount(r0).textContent!.startsWith('3')).toBe(true)
    expect(rowCount(r0).textContent).not.toContain('豁免')
  })

  it('无效位置（非命中/越界/负数）→ INVALID_POSITION：输入保留，预览不变', async () => {
    const c = await renderApp('abc\nabc', ['abc'])
    const r0 = rows(c)[0]
    const before = workPreview(c)
    for (const bad of ['1', '5', '-1', '3']) {
      typePos(rowPosInput(r0)!, bad)
      click(rowExemptBtn(r0))
      expect(notice(c)).toBe('INVALID_POSITION')
      expect(workPreview(c)).toBe(before)
      expect(rowChips(r0)).toHaveLength(0)
      expect(rowPosInput(r0)!.value).toBe(bad) // 输入保留便于修改
    }
    // 改成真实行内起点 0 后成功，错误清除，输入清空
    typePos(rowPosInput(r0)!, '0')
    click(rowExemptBtn(r0))
    expect(notice(c)).toBeNull()
    expect(rowPosInput(r0)!.value).toBe('')
    expect(rowChips(r0)).toHaveLength(1)
  })

  it('重复豁免同一位置幂等：不新增 chip、计数不变', async () => {
    const c = await renderApp('abc abc', ['abc'])
    const r0 = rows(c)[0]
    typePos(rowPosInput(r0)!, '0')
    click(rowExemptBtn(r0))
    typePos(rowPosInput(r0)!, '0')
    click(rowExemptBtn(r0))
    expect(notice(c)).toBeNull()
    expect(rowChips(r0)).toHaveLength(1)
    expect(rowCount(r0).textContent).toContain('豁免 1')
  })

  it('豁免不抹掉其他短语在同一区域的遮蔽（嵌套/重叠）', async () => {
    const c = await renderApp('abcdef', ['abcdef', 'bc'])
    // 豁免长词 abcdef@0
    const rLong = rows(c)[0]
    typePos(rowPosInput(rLong)!, '0')
    click(rowExemptBtn(rLong))
    // 长词命中被豁免，但 'bc'（位置 1..2）仍遮蔽：a##def
    expect(workPreview(c)).toBe('a##def')
    // 再豁免 'bc'@1：位置 1..2 也还原 → abcdef
    const rShort = rows(c)[1]
    typePos(rowPosInput(rShort)!, '1')
    click(rowExemptBtn(rShort))
    expect(workPreview(c)).toBe('abcdef')
  })

  it('停用短语：豁免控件消失；停用清理其豁免，重新启用空簿起步', async () => {
    const c = await renderApp('abc abc', ['abc'])
    const r0 = rows(c)[0]
    typePos(rowPosInput(r0)!, '0')
    click(rowExemptBtn(r0))
    expect(rowChips(r0)).toHaveLength(1)
    // 停用：豁免行整体消失，计数“未统计”
    click(rowCheck(r0))
    expect(rowPosInput(rows(c)[0])).toBeNull()
    expect(rowCount(rows(c)[0]).textContent).toBe('未统计')
    expect(workPreview(c)).toBe('abc abc')
    // 重新启用：无豁免复活
    click(rowCheck(rows(c)[0]))
    expect(rowChips(rows(c)[0])).toHaveLength(0)
    expect(rowCount(rows(c)[0]).textContent!.startsWith('2')).toBe(true)
    expect(workPreview(c)).toBe('### ###')
  })

  it('改值后旧豁免清空；删除短语连带豁免；新增条目空豁免', async () => {
    const c = await renderApp('abc abc bbb', ['abc', 'bbb'])
    const r0 = rows(c)[0]
    typePos(rowPosInput(r0)!, '0')
    click(rowExemptBtn(r0))
    expect(rowChips(r0)).toHaveLength(1)
    // 改值（改成与现有值不重复的 'bcd'）：保位但豁免清空
    typeInto(rowText(r0), 'bcd')
    act(() => rowText(r0).blur())
    expect(notice(c)).toBeNull()
    expect(rowChips(rows(c)[0])).toHaveLength(0)
    // 新增第三条：空豁免
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    typeInto(addInput, 'x')
    click(buttonByText(c, '添加'))
    expect(rowChips(rows(c)[2])).toHaveLength(0)
    // 删除第 0 条：其余行豁免槽不串位（本来就空）
    click(rowDelete(rows(c)[0]))
    expect(rows(c).length).toBe(2)
  })

  it('采纳固化豁免与遮蔽；之后再加豁免不改采纳稿，再次采纳才更新', async () => {
    const c = await renderApp('abc xx abc yy abc', ['abc'])
    const r0 = rows(c)[0]
    typePos(rowPosInput(r0)!, '7')
    click(rowExemptBtn(r0))
    const first = '### xx abc yy ###'
    expect(workPreview(c)).toBe(first)
    click(buttonByText(c, '采纳为下载稿'))
    expect(adoptedPreview(c)).toBe(first)

    // 再豁免第一处：工作预览变化，采纳稿不动
    typePos(rowPosInput(rows(c)[0])!, '0')
    click(rowExemptBtn(rows(c)[0]))
    expect(workPreview(c)).toBe('abc xx abc yy ###')
    expect(adoptedPreview(c)).toBe(first)

    // 再次采纳：下载稿更新
    click(buttonByText(c, '采纳为下载稿'))
    expect(adoptedPreview(c)).toBe(workPreview(c))
  })

  it('放弃改动：豁免与工作集一起回滚到已采纳稿', async () => {
    const c = await renderApp('abc xx abc yy abc', ['abc'])
    // 先采纳“豁免中间一次”的状态
    typePos(rowPosInput(rows(c)[0])!, '7')
    click(rowExemptBtn(rows(c)[0]))
    click(buttonByText(c, '采纳为下载稿'))
    const adopted = workPreview(c)
    // 再豁免第一处（未采纳）
    typePos(rowPosInput(rows(c)[0])!, '0')
    click(rowExemptBtn(rows(c)[0]))
    expect(workPreview(c)).not.toBe(adopted)
    // 放弃：回到采纳稿（中间豁免保留、第一处豁免撤销）
    click(buttonByText(c, '放弃改动'))
    expect(workPreview(c)).toBe(adopted)
    expect(rowChips(rows(c)[0])).toHaveLength(1)
    expect(notice(c)).toBeNull()
  })

  it('载入新文本清空旧豁免', async () => {
    const c = await renderApp('abc abc', ['abc'])
    typePos(rowPosInput(rows(c)[0])!, '0')
    click(rowExemptBtn(rows(c)[0]))
    expect(rowChips(rows(c)[0])).toHaveLength(1)
    // 重新载入相似文本
    const input = c.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify({ text: 'abc abc', patterns: ['abc'] })], 'in.json', { type: 'application/json' })],
      configurable: true,
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(rowChips(rows(c)[0])).toHaveLength(0)
    expect(workPreview(c)).toBe('### ###')
  })

  it('重算失败（注入）时豁免不生效，旧预览保留；恢复后可正常豁免', async () => {
    const c = await renderApp('abc abc', ['abc'])
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom on exempt')
    })
    typePos(rowPosInput(rows(c)[0])!, '0')
    click(rowExemptBtn(rows(c)[0]))
    expect(notice(c)).toBe('COUNT_FAILED')
    expect(workPreview(c)).toBe('### ###') // 旧预览保留
    expect(rowChips(rows(c)[0])).toHaveLength(0)
    expect(rowPosInput(rows(c)[0])!.value).toBe('0') // 输入保留
    // 恢复
    mockedMaskText.mockReset()
    mockedMaskText.mockImplementation(((...args) => realMaskText(...args)) as typeof maskText)
    click(rowExemptBtn(rows(c)[0]))
    expect(notice(c)).toBeNull()
    expect(workPreview(c)).toBe('abc ###')
    expect(rowChips(rows(c)[0])).toHaveLength(1)
  })

  it('自重叠命中可逐个豁免：aaaa + aa 的三个起点', async () => {
    const c = await renderApp('aaaa', ['aa'])
    const r0 = rows(c)[0]
    // 豁免起点 0 和 2：保留起点 1 的命中（覆盖 1..2）→ a##a
    for (const pos of ['0', '2']) {
      typePos(rowPosInput(r0)!, pos)
      click(rowExemptBtn(r0))
    }
    expect(workPreview(c)).toBe('a##a')
    expect(rowCount(r0).textContent).toContain('1') // 有效命中剩 1
    expect(rowCount(r0).textContent).toContain('豁免 2')
    expect(rowChips(r0)).toHaveLength(2)
  })
})
