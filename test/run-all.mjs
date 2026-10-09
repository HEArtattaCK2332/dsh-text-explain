// 一把跑完三份自检：宿主半、设置层、渲染冒烟。
// 用法: node test/run-all.mjs        （只依赖 Node 内置模块，无需安装任何东西）
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = ['host.test.mjs', 'settings.test.mjs', 'render.test.mjs']

let failed = 0
for (const suite of suites) {
  console.log(`\n===== ${suite} =====`)
  const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

console.log(failed === 0 ? '\n全部自检通过 ✓' : `\n有 ${failed} 份自检未通过 ✗`)
process.exit(failed === 0 ? 0 : 1)
