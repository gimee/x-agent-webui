export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

// 本产品自己的更新日志（与 CHANGELOG.md 保持一致）。
// 每次二次开发：在这里追加一条 version 记录，并在全部 11 个 locale 的 changelog 段补上对应 key。
export const changelog: ChangelogEntry[] = [
  { version: '0.6.3', date: '2026-10-02', changes: ['changelog.product_0_6_3_1', 'changelog.product_0_6_3_2', 'changelog.product_0_6_3_3'] },
  { version: '0.6.1', date: '2026-10-02', changes: ['changelog.product_0_6_1_1', 'changelog.product_0_6_1_2'] },
  { version: '0.6.0', date: '2026-10-01', changes: ['changelog.product_0_6_0_1'] },
  { version: '0.5.3', date: '2026-10-01', changes: ['changelog.product_0_5_3_1'] },
  { version: '0.5.2', date: '2026-10-01', changes: ['changelog.product_0_5_2_1'] },
  { version: '0.5.1', date: '2026-10-01', changes: ['changelog.product_0_5_1_1', 'changelog.product_0_5_1_2', 'changelog.product_0_5_1_3', 'changelog.product_0_5_1_4'] },
  { version: '0.5.0', date: '2026-10-01', changes: ['changelog.product_0_5_0_1', 'changelog.product_0_5_0_2', 'changelog.product_0_5_0_3', 'changelog.product_0_5_0_4', 'changelog.product_0_5_0_5', 'changelog.product_0_5_0_6'] },
  { version: '0.4.6', date: '2026-09-30', changes: ['changelog.product_0_4_6_1'] },
  { version: '0.4.5', date: '2026-09-30', changes: ['changelog.product_0_4_5_1', 'changelog.product_0_4_5_2'] },
  { version: '0.4.4', date: '2026-09-30', changes: ['changelog.product_0_4_4_1'] },
  { version: '0.4.3', date: '2026-09-30', changes: ['changelog.product_0_4_3_1'] },
  { version: '0.4.2', date: '2026-09-30', changes: ['changelog.product_0_4_2_1', 'changelog.product_0_4_2_2'] },
  { version: '0.4.1', date: '2026-09-30', changes: ['changelog.product_0_4_1_1', 'changelog.product_0_4_1_2'] },
  { version: '0.4.0', date: '2026-09-30', changes: ['changelog.product_0_4_0_1', 'changelog.product_0_4_0_2'] },
  { version: '0.3.1', date: '2026-09-30', changes: ['changelog.product_0_3_1_1'] },
  { version: '0.3.0', date: '2026-09-30', changes: ['changelog.product_0_3_0_1', 'changelog.product_0_3_0_2'] },
  { version: '0.2.10', date: '2026-09-15', changes: ['changelog.product_0_2_10_1'] },
  { version: '0.2.9', date: '2026-09-15', changes: ['changelog.product_0_2_9_1', 'changelog.product_0_2_9_2', 'changelog.product_0_2_9_3'] },
  { version: '0.2.8', date: '2026-09-14', changes: ['changelog.product_0_2_8_1', 'changelog.product_0_2_8_2', 'changelog.product_0_2_8_3', 'changelog.product_0_2_8_4'] },
  { version: '0.2.7', date: '2026-09-13', changes: ['changelog.product_0_2_7_1', 'changelog.product_0_2_7_2'] },
  { version: '0.2.6', date: '2026-09-13', changes: ['changelog.product_0_2_6_1'] },
  { version: '0.2.5', date: '2026-09-13', changes: ['changelog.product_0_2_5_1'] },
  { version: '0.2.4', date: '2026-09-13', changes: ['changelog.product_0_2_4_1'] },
  { version: '0.2.3', date: '2026-09-13', changes: ['changelog.product_0_2_3_1'] },
  { version: '0.2.2', date: '2026-09-12', changes: ['changelog.product_0_2_2_1'] },
  { version: '0.2.1', date: '2026-09-12', changes: ['changelog.product_0_2_1_1'] },
  { version: '0.2.0', date: '2026-09-12', changes: ['changelog.product_0_2_0_1'] },
  {
    version: '0.1.5',
    date: '2026-09-12',
    changes: [
      'changelog.product_0_1_5_1',
    ],
  },
  {
    version: '0.1.4',
    date: '2026-09-12',
    changes: [
      'changelog.product_0_1_4_1',
    ],
  },
  {
    version: '0.1.3',
    date: '2026-09-12',
    changes: [
      'changelog.product_0_1_3_1',
      'changelog.product_0_1_3_2',
    ],
  },
  {
    version: '0.1.2',
    date: '2026-09-11',
    changes: [
      'changelog.product_0_1_2_1',
      'changelog.product_0_1_2_2',
      'changelog.product_0_1_2_3',
      'changelog.product_0_1_2_4',
      'changelog.product_0_1_2_5',
      'changelog.product_0_1_2_6',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-09-11',
    changes: [
      'changelog.product_0_1_1_1',
      'changelog.product_0_1_1_2',
      'changelog.product_0_1_1_3',
      'changelog.product_0_1_1_4',
    ],
  },
]
