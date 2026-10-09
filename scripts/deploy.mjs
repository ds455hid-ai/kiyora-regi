// GitHub Pages へ公開: npm run deploy  (確認だけなら: npm run deploy -- --dry-run)
//
//  1. Supabase の接続情報が .env.production に入っているか確認
//  2. 型チェック → テスト → ビルド
//  3. dist/ を gh-pages ブランチへ反映(公開URLは https://ds455hid-ai.github.io/kiyora-regi/ のまま)
//  4. 反映前の gh-pages の状態を deploy-backup-<日時> タグで保存(すぐ戻せるように)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const root = resolve(new URL('..', import.meta.url).pathname)
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
const out = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()

// 1) 接続情報の確認
const env = readFileSync(join(root, '.env.production'), 'utf8')
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim()
if (!get('VITE_SUPABASE_URL') || !get('VITE_SUPABASE_ANON_KEY')) {
  console.error('✗ .env.production に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が設定されていません。docs/SETUP.md を参照してください。')
  process.exit(1)
}
if (/service_role|secret/i.test(get('VITE_SUPABASE_ANON_KEY')) || get('VITE_SUPABASE_ANON_KEY').startsWith('sb_secret_')) {
  console.error('✗ 秘密鍵(service_role / secret)が設定されています。公開用の anon(publishable)キーだけを使ってください。')
  process.exit(1)
}
try {
  const payload = JSON.parse(Buffer.from(get('VITE_SUPABASE_ANON_KEY').split('.')[1], 'base64url').toString())
  if (payload.role && payload.role !== 'anon') {
    console.error(`✗ キーの role が "${payload.role}" です。anon キーを使ってください。`)
    process.exit(1)
  }
} catch {
  /* 新形式(sb_publishable_...)は JWT ではないのでそのまま */
}

// 2) 検証とビルド
run('npm', ['run', 'typecheck'])
run('npm', ['test'])
run('npm', ['run', 'build'])

const sha = out('git', ['rev-parse', '--short', 'HEAD'])
const dirty = out('git', ['status', '--porcelain']) !== ''
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

if (dryRun) {
  console.log(`\n✓ dry-run 完了(ビルド成功 / commit ${sha}${dirty ? ' + 未コミットの変更あり' : ''})。公開はしていません。`)
  process.exit(0)
}
if (dirty) {
  console.error('✗ 未コミットの変更があります。先にコミットしてください(公開内容とコミットを一致させるため)。')
  process.exit(1)
}

// 3) gh-pages ブランチへ反映
const remoteUrl = out('git', ['remote', 'get-url', 'origin'])
const tmp = mkdtempSync(join(tmpdir(), 'kiyora-deploy-'))
try {
  run('git', ['clone', '--quiet', '--no-checkout', remoteUrl, tmp])
  const hasBranch = out('git', ['ls-remote', '--heads', 'origin', 'gh-pages']) !== ''
  if (hasBranch) {
    execFileSync('git', ['fetch', '--quiet', 'origin', 'gh-pages'], { cwd: tmp, stdio: 'inherit' })
    execFileSync('git', ['checkout', '--quiet', '-B', 'gh-pages', 'origin/gh-pages'], { cwd: tmp, stdio: 'inherit' })
    // 4) 反映前の状態を保存
    const prev = out('git', ['rev-parse', 'HEAD'], tmp)
    execFileSync('git', ['tag', '-f', `deploy-backup-${stamp}`, prev], { cwd: tmp })
    execFileSync('git', ['push', '--quiet', 'origin', `deploy-backup-${stamp}`], { cwd: tmp, stdio: 'inherit' })
    console.log(`  反映前の状態を deploy-backup-${stamp} として保存しました`)
  } else {
    execFileSync('git', ['checkout', '--quiet', '--orphan', 'gh-pages'], { cwd: tmp, stdio: 'inherit' })
  }
  for (const f of readdirSync(tmp)) if (f !== '.git') rmSync(join(tmp, f), { recursive: true, force: true })
  cpSync(join(root, 'dist'), tmp, { recursive: true })
  writeFileSync(join(tmp, '.nojekyll'), '')
  if (!existsSync(join(tmp, 'index.html'))) throw new Error('dist/index.html がありません')
  execFileSync('git', ['add', '-A'], { cwd: tmp })
  const git = ['-c', 'user.name=HIRO', '-c', 'user.email=ds455hid@gmail.com']
  execFileSync('git', [...git, 'commit', '--quiet', '--allow-empty', '-m', `deploy ${sha} (${stamp})`], { cwd: tmp, stdio: 'inherit' })
  execFileSync('git', ['push', '--quiet', 'origin', 'gh-pages'], { cwd: tmp, stdio: 'inherit' })
  console.log(`\n✓ gh-pages へ反映しました(commit ${sha})。`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
