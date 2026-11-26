# 軽音サークル管理サイト 引き継ぎ

部員のプロフィール、予定、バンド、オーディション（OD）とタイムテーブルを管理するサイトです。画面は HTML・CSS・JavaScript で構成し、認証・データベース・画像保存に Supabase を使用します。

## 引き継ぎ時に確認すること

- Supabase プロジェクト（`cjymelefxesbmbicemvf`）、Cloudflare の配信プロジェクト、Git リポジトリに後任がアクセスできることを確認します。Cloudflare の公開ブランチとカスタムドメインも引き継ぎます。
- アプリ内の部長交代は、現部長がプロフィールから申請し、後任が承認します。現部長が操作できない場合はサイト管理者が「部長を再設定」を使えます。サイト管理者の交代時は、先に後任へ権限を付与し、操作できることを確認してから旧担当者の権限を解除します。
- 退会者などのアカウントは、Supabase の SQL Editor で UID を確認して手動削除します。関連データの調べ方、バンドを残す SQL、削除後の確認方法は [ユーザ手動削除手順](#supabase-でのユーザ手動削除) にあります。部長や採点者を削除する場合は、引き継ぎや採点履歴の扱いを先に確認します。

## 既存環境への反映

1. Supabase の SQL Editor で [旧ユーザ管理 RPC の廃止 SQL](migrations/20261126_remove_user_management.sql) を実行します。この移行はアプリから使っていた一覧・削除用の DB 関数を削除します。既存の監査記録と匿名化済みの採点は、過去の確認と OD の再集計に使えるよう保持します。
2. Cloudflare Pages で静的サイトをデプロイします。Git 連携の場合はフレームワークを `None`、ビルドコマンドを `npm run build`、出力ディレクトリを `dist` に設定します。直接アップロード方式の場合は、ローカルでビルドした `dist/` をアップロードします。 [Cloudflare Pages のビルド設定](https://developers.cloudflare.com/pages/configuration/build-configuration/) · [直接アップロード](https://developers.cloudflare.com/pages/get-started/direct-upload/)
3. 旧 Worker をデプロイしていた場合は、公開先の切り替えを確認し、旧 API のルートと、その Worker 専用に設定した `SUPABASE_SERVICE_ROLE_KEY` のシークレット登録を解除します。
4. 一般部員と部長またはサイト管理者でログインし、プロフィール・予定・バンド・OD と、設定の「メンバー・役職管理」が利用できることを確認します。旧ユーザ管理ボタンが消えていることも確認します。

タコイカゲームを既存環境に初めて入れる場合は、配信前に [ゲーム用マイグレーション](migrations/20261108_takoika.sql) を適用します。

## 新規環境のセットアップ

1. Supabase Dashboard で Auth のメール確認、SMTP、公開サイトのリダイレクト URL を設定し、初期部長・サイト管理者の Auth ユーザを作成します。同じユーザを指定できます。
2. [setup.sql](setup.sql) の `initial_president_email` と `initial_site_admin_email` に対象のメールアドレスを設定し、ファイル全体を SQL Editor で実行します。プロフィールの自動作成、RLS、アプリ用の RPC、画像用の `band-icons` バケットを構築します。バンド画像は JPEG・PNG・WebP で上限は 2 MiB です。
3. [app.js](app.js) 冒頭の `SUPABASE_URL` と `SUPABASE_KEY` を変更します。ブラウザに設定するキーは publishable キーまたは旧 anon キーです。サービスロールキーやパスワードはソースへ置かないでください。
4. `npm run build` で生成した `dist/` を配信します。ルートディレクトリには SQL やテストがあるため、公開範囲は `dist/` にします。

既存のユーザ、予定、採点や画像を別の Supabase プロジェクトへ移す場合は、データ移行を別途行います。

## 日常の運用

- **メンバー・役職管理**では、権限に応じて入学年度の変更申請、役職、部員情報、部長の引き継ぎや復旧を扱います。
- **MYスケジュール**はセルごとに自動保存します。保存エラーが出たときは「再保存」で再試行します。「入力した日程をすべて削除」は本人の全期間の入力を削除します。
- **OD**は参加登録・バンドエントリー、採点、部長による集計・合否決定・公開の順に進めます。前回ライブを指定した OD では、実際に出演したバンドにエントリー制限がかかります。
- **ODタイムテーブル**は、演奏順を確定してから生成し、時間・休憩・係を調整して公開します。公開時の変更は対象者にサイト内通知されます。公開済みの過去 OD は閲覧と出力に使えます。 [タイムテーブル仕様](timetable.md)
- **タコイカゲーム**は設定から開きます。ランキングは自己ベストを使い、同点は同順位です。 [ゲーム仕様](TAKOIKA_GAME_SPEC.md)

## Supabase でのユーザ手動削除

Supabase Dashboard で、`app.js` の `SUPABASE_URL` に対応するプロジェクトを開き、**SQL Editor** で実行します。Auth ユーザを削除すると、外部キーの `ON DELETE CASCADE` により、本人のプロフィールや予定も削除されます。

### 1. 削除前に確認する

1. **Authentication → Users** で対象の UID を確認します。
2. 次の確認 SQL の `対象のUIDに置換` を実際の UID に差し替えて実行し、関連データの件数と、作成したバンドの ID を控えます。

```sql
with target as (
  select '対象のUIDに置換'::uuid as uid
)
select
  (select count(*) from auth.users where id = t.uid) as auth_users,
  (select count(*) from public.profiles where id = t.uid) as profiles,
  (select count(*) from public.schedules where user_id = t.uid) as schedules,
  (select array_agg(id) from public.bands where created_by = t.uid) as created_band_ids,
  (select count(*) from storage.objects where owner_id = t.uid::text or owner = t.uid) as owned_objects,
  (select count(*) from storage.buckets where owner_id = t.uid::text or owner = t.uid) as owned_buckets
from target t;
```

3. `auth.users` と `public.profiles` を参照する外部キーを確認します。部長・部長移譲・入学年度の審査・OD の採点などに該当する行がある場合は、そのデータの扱いを決めてから削除します。Storage の所有データがある場合は、先に削除または所有権の移管を行います。［[Supabase のユーザ管理](https://supabase.com/docs/guides/auth/managing-user-data#deleting-users)］

```sql
select
  confrelid::regclass as referenced_table,
  conrelid::regclass as referencing_table,
  conname as constraint_name,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where contype = 'f'
  and confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
order by 1, 2, 3;
```

### 2. バンドを残して Auth ユーザを削除する

確認した関連データが今回と同じ扱いでよい場合は、以下の SQL の UID を差し替え、ブロック全体を一度に実行します。今回の削除では Supabase の SQL 接続から同じブロックを実行しました。

`public.bands.created_by` には削除を制限する外部キーがあるため、先に対象の UID を `NULL` にします。ブロックの途中で外部キー違反などが発生すると、バンドの更新も含めてロールバックされます。

```sql
do $$
declare
  target_uid constant uuid := '対象のUIDに置換';
begin
  perform 1 from auth.users where id = target_uid for update;
  if not found then
    raise exception 'Auth user not found: %', target_uid;
  end if;

  if exists (select 1 from storage.objects where owner_id = target_uid::text or owner = target_uid)
     or exists (select 1 from storage.buckets where owner_id = target_uid::text or owner = target_uid) then
    raise exception 'Storage ownership must be handled first: %', target_uid;
  end if;

  update public.bands
  set created_by = null
  where created_by = target_uid;

  delete from auth.users
  where id = target_uid;

  if not found then
    raise exception 'Auth user was not deleted: %', target_uid;
  end if;
end;
$$;
```

### 3. 削除結果を確認する

手順 1 の確認 SQL を同じ UID で再実行し、`auth_users`、`profiles`、`schedules` がすべて 0 件になったことを確認します。バンドは手順 1 で控えた ID で検索し、行が残り `created_by` が `NULL` になっていることを確認します。

削除前に発行されたアクセストークン（JWT）は、有効期限まで有効な場合があります。［[Supabase のアクセストークンとユーザ削除](https://supabase.com/docs/guides/auth/managing-user-data#removing-account-access)］

### 実行結果

2026-11-26 に UID `5915aeca-e545-424f-852e-1d983d7251f8` で実行しました。

| 確認対象 | 削除前 | 削除後 |
| --- | ---: | ---: |
| Auth ユーザ | 1 | 0 |
| プロフィール | 1 | 0 |
| 予定 | 62 | 0 |
| 対象 UID を作成者として参照するバンド | 1 | 0 |

対象のバンド（ID `f3cec0c1-8084-4f99-b030-5626a0040132`）は、`created_by = NULL` で残っていることを確認しました。

## ローカルでの検証

```sh
npm install
npm test
npm run test:browser
npm run build
```

ブラウザテストには Chrome または Edge を使います。自動検出できない環境では `KEION_BROWSER` に実行ファイルのパスを設定します。Windows PowerShell で npm のスクリプト実行が制限される場合は `npm.cmd` を使えます。

DB テストは PGlite、ブラウザテストはモックを使用します。ブラウザテストのスクリーンショットは `.tmp/browser-smoke/` に出力されます。ビルドは生成物の `dist/` を作り直します。

画面の機能要件と実装状況を照合するときは [UI 仕様書](club_webapp_UI_spec_Q1-Q74.md) を参照してください。
