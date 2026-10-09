# 屋台レジ (kiyora-regi)

お祭り屋台向け POS。会計・受け渡し・現金管理・売上管理を、複数のスマホ/タブレットでリアルタイムに共有します。

- 公開URL: https://ds455hid-ai.github.io/kiyora-regi/
- 使い方・セットアップ: [docs/SETUP.md](docs/SETUP.md)
- 旧レジ(v1)のバックアップ: タグ `v1-legacy` / ブランチ `backup/legacy-v1`(公開版にも `/legacy/` として同梱)

## 開発

```bash
npm install
npm run dev:mock      # 開発用モック(ブラウザ内 PostgreSQL。Supabase 不要)
npm test              # DBロジック / 同時実行(本物の PostgreSQL)/ 計算ロジック
npm run build         # 型チェック + 静的ビルド(dist/)
npm run deploy        # テスト → ビルド → gh-pages へ公開(--dry-run で確認のみ)
npm run verify:supabase   # 本物の Supabase に対する同時操作・権限・リアルタイム確認
```

## 構成

```
src/                    フロント(React + TypeScript)
supabase/migrations/    DB スキーマ・RLS・RPC(Supabase の SQL Editor で 1 回実行)
supabase/tests/         PGlite(ロジック)+ embedded-postgres(同時実行)
supabase/maintenance/   テストデータ削除 SQL
public/legacy/          旧レジ(v1)
scripts/                アイコン生成 / デプロイ / Supabase 動作チェック
```
