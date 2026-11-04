import fs from 'node:fs'
import path from 'node:path'

const [name, status] = process.argv.slice(2)
if (!name || !['PASS', 'FAIL', 'NOT_EXECUTED'].includes(status)) {
  throw new Error('usage: record-test-result.mjs <name> <PASS|FAIL|NOT_EXECUTED>')
}
const directory = path.resolve(process.env.XYVA_EVIDENCE_DIR ?? 'evidence')
fs.mkdirSync(directory, { recursive: true })
const file = path.join(directory, 'test-results.json')
let results = {}
try { results = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
results[name] = status
fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`)
