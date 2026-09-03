// scripts/install-adapter.ts
// Copies adapter/perplexity/ into the opencli user CLIs directory
// (~/.opencli/clis/perplexity) so opencli auto-discovers the site.

import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const home = os.homedir()
const target = path.join(home, ".opencli", "clis", "perplexity")
const source = path.resolve(import.meta.dir, "..", "adapter", "perplexity")

async function exists(p: string) {
  try { await fs.access(p); return true } catch { return false }
}

async function main() {
  if (!(await exists(source))) {
    console.error(`Source not found: ${source}`)
    process.exit(1)
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  // Clean re-install
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name)
    const dst = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await fs.cp(src, dst, { recursive: true })
    } else {
      await fs.copyFile(src, dst)
    }
  }
  console.log(`Installed perplexity adapter → ${target}`)
  console.log("Verify with:  opencli list")
  console.log("              opencli perplexity ask --help")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
