// The category only ever appears in an aggregate, but a wrong aggregate is worse
// than none: these cases pin what each bucket means.
import assert from 'node:assert/strict'
import test from 'node:test'
import { categorizeTask, TASK_CATEGORIES, TASK_CATEGORY_LABELS } from '../src/stats-tasks.js'

test('a title lands in the bucket a reader would put it in', () => {
  const cases: [string, string][] = [
    ['修复登录接口报错', 'coding'],
    ['帮我写一个 Python 脚本批量处理文件', 'coding'],
    ['重构这段 React 组件', 'coding'],
    ['整理这份 Excel 表格并汇总', 'data'],
    ['把 CSV 数据清洗后做成报表', 'data'],
    ['Docker 部署失败排查', 'system'],
    ['配置 ssh 权限', 'system'],
    ['批量重命名这些文件', 'files'],
    ['把 PDF 解压后导入', 'files'],
    ['写一封给客户的邮件', 'writing'],
    ['润色这段产品文案', 'writing'],
    ['调研国内 AI 编程工具对比', 'research'],
    ['解释一下这个原理', 'research'],
    ['今天天气', 'other'],
    ['', 'other'],
  ]
  for (const [title, expected] of cases) {
    assert.equal(categorizeTask(title), expected, `${title} 应该属于 ${expected}`)
  }
})

test('coding wins over writing when a title mentions both', () => {
  // "写一个脚本" is coding; the word 写 alone would have said writing.
  assert.equal(categorizeTask('写一个脚本把日志合并'), 'coding')
  assert.equal(categorizeTask('写一份周报'), 'writing')
})

test('every category has a label', () => {
  for (const category of TASK_CATEGORIES) {
    assert.equal(typeof TASK_CATEGORY_LABELS[category], 'string')
    assert.ok(TASK_CATEGORY_LABELS[category].length > 0)
  }
})
