/**
 * What a session was about, from the title the agent already wrote for it.
 *
 * The titles are free text, so this is a keyword classifier and nothing more: it
 * is deterministic, costs nothing to run, and is only ever used in aggregate —
 * "how much of the week was coding" — never to label a person. A title that
 * matches nothing lands in `other`, which is the honest answer rather than a
 * guess.
 *
 * Order matters: the first group that matches wins, so the groups are ordered
 * from most specific to least. `write a script` is coding, not writing.
 */
export const TASK_CATEGORIES = ['coding', 'data', 'system', 'files', 'writing', 'research', 'other'] as const

export type TaskCategory = (typeof TASK_CATEGORIES)[number]

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  coding: 'Coding / Debugging',
  data: 'Spreadsheet / Data',
  system: 'System / IT',
  files: 'File Operations',
  writing: 'Writing',
  research: 'Research',
  other: 'Other',
}

const RULES: { category: TaskCategory; keywords: string[] }[] = [
  {
    category: 'coding',
    keywords: [
      '代码', 'coding', 'code', 'debug', '调试', '报错', '错误', '编译', '重构', '函数', '脚本', '接口',
      '单元测试', '测试失败', 'bug', 'python', 'javascript', 'typescript', 'react', 'css', 'html', 'sql',
      'git', 'api', '算法', '正则', '性能优化',
    ],
  },
  {
    category: 'data',
    keywords: [
      '表格', 'excel', 'csv', '数据', '统计', '图表', '报表', '汇总', '透视', '排序', '清洗', '数据清洗',
      '分析报告', '指标', '看板', 'dashboard', 'spreadsheet',
    ],
  },
  {
    category: 'system',
    keywords: [
      '安装', '配置', '环境', '终端', '命令', '系统', '服务器', '部署', 'docker', 'nginx', '网络', '代理',
      '权限', '端口', 'ssh', '日志', '运维', '开机', '启动失败', '内存', 'cpu', '磁盘',
    ],
  },
  {
    category: 'files',
    keywords: ['文件', '文件夹', '目录', '重命名', '解压', '压缩', '批量', '移动', '复制', '格式转换', '导出', '导入'],
  },
  {
    category: 'writing',
    keywords: [
      '写', '文案', '润色', '翻译', '摘要', '邮件', '文章', '报告', '总结', '改写', '标题', '说明',
      '公告', '文案优化', '简历', '信件', '宣传', '叙事', '改写',
    ],
  },
  {
    category: 'research',
    keywords: ['研究', '调研', '查', '搜索', '对比', '分析', '解释', '原理', '是什么', '为什么', '学习', '资料', '推荐', '了解'],
  },
]

/**
 * The category a title belongs to. Chinese titles carry no word boundaries, so
 * this is a substring match rather than tokenising.
 */
export function categorizeTask(title: string): TaskCategory {
  const text = title.toLowerCase()
  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule.category
  }
  return 'other'
}
