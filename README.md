# J.H AI Agent

自分のマシンで動く AI エージェントのデスクトップアプリです。仕事を渡して結果を待つ、
短い質問をする、決まった作業を定期実行する — そのすべてを、**何にいくら使ったかが
見える状態**で行えます。

Tauri (Rust + Web) 製。Windows で開発・検証しています。

## できること

- **仕事を渡す** — ファイルを読み、編集し、コマンドを走らせ、テストを通すところまで。
  計画を先に見せて承認を取るモード、書き込み範囲の制限、承認カード、コマンドの
  ポリシー判定といった安全網つき
- **短く聞く** — 同じ画面の「聞く」モード。読み取り専用ツールだけで、計画も挟まず、
  すぐ答える。それでも実行として記録され、記憶にも課金にも入ります
- **覚える** — 失敗から得た教訓と、うまくいったやり方をワークスペースごとに蓄積し、
  次に効く場面で呼び戻します。**効いているかどうか（再発率）を計測**します
- **安く走らせる** — フェーズ別モデルルーティング。計画は賢いモデル、実装は安い
  モデル、検収はまた賢いモデル。設定画面でいくら浮くかを試算します
- **Office 文書を扱う** — xlsx / docx / pptx の読み取りと、**数式と書式を保ったままの
  xlsx 編集**
- **他のアプリの機能を使う** — MCP クライアント（stdio / Streamable-HTTP / 外向き
  WebSocket）。JHEditor などの自社アプリが自分の能力をツールとして提供できます
- **定期実行** — 曜日と時刻を決めて自動で走らせる
- **手を止めずに聞く** — グローバルホットキーのオーバーレイ。残したくなったら
  そのまま実行に昇格できます

日本語が第一言語です（英語にも切り替えられます）。

## LLM の接続先

**クラウドとローカルのどちらでも動きます。** OpenAI / Anthropic / Gemini / Azure は
ネイティブの function calling を使い、それ以外の OpenAI 互換エンドポイント
（DeepSeek、Ollama、LocalAI など）はテキストプロトコルにフォールバックします。
接続は複数登録でき、フェーズごとに使い分けられます。

**API キーは OS の資格情報ストアに入ります** — Windows 資格情報マネージャー /
macOS キーチェーン / Linux libsecret。設定ファイルには保存しません。

### プライバシーについて、正確に

- **ワークスペースの内容は、あなたが設定した LLM に送られます。** クラウドのモデルを
  選べばクラウドへ送られます。ここを外に出したくない場合は、ローカルの
  OpenAI 互換サーバー（Ollama / LocalAI 等）を接続先にしてください
- **アプリ自身はテレメトリを送りません。** 実行ログ・記憶・インデックスはすべて
  ローカル（ワークスペースの `.agent/` と アプリの設定ディレクトリ）にあります
- **`fetch_url` は既定で全ホスト拒否**です。使うホストを設定で明示的に許可します
- ローカルの HTTP サーバー（既定 127.0.0.1:14300）は、姉妹アプリとの連携用です。
  ループバックにのみバインドし、Bearer トークンで保護されます

## ビルド / 開発

### 前提

- Node.js 18+ / npm
- Rust toolchain (`rustup`)
- `protoc` (Protocol Buffers compiler) — Windows なら WinGet で `Google.Protobuf`、macOS なら `brew install protobuf`

### 開発サーバ

```powershell
npm install
npm run tauri dev
```

### プロダクションビルド

```powershell
npm run release:preflight   # 設定の整合性を確認（更新の配信先・鍵・バージョン）
npm run tauri build
```

リリース手順（署名鍵の作成と、更新の配信）は配布担当者向けに別途管理しています。
`npm run release:preflight` は、鍵・配信先・バージョン・インストーラ設定の
不整合を検出して非ゼロで終了します。

### ビルド環境の事情

`npm run tauri ...` は `.proto_include/`(リポジトリにバンドル済みの Google 標準 proto 群) と `.tmp_build/`(ASCII パスの一時ディレクトリ) を `package.json` の `tauri` スクリプトで自動セットアップします。

Windows のユーザ名が非ASCII(日本語/韓国語等)を含む環境で `protoc` / `prost-build` がエラーになる問題を回避するための仕組みです。

直接 `cargo` を呼ぶ場合は `PROTOC_INCLUDE=<repo>/.proto_include` を手動でセットしてください。

## ライセンス

**MIT OR Apache-2.0** のデュアルライセンスです。どちらか好きな方を選んでください
（両方に従う必要はありません）。

- [LICENSE-MIT](./LICENSE-MIT) — 短く単純。特許については何も述べていません
- [LICENSE-APACHE](./LICENSE-APACHE) — **明示的な特許許諾**を含みます。企業の法務
  レビューではこちらが求められることがあります

`SPDX-License-Identifier: MIT OR Apache-2.0`

同梱している第三者コンポーネント（`public/tree-sitter/` の WebAssembly、
`.proto_include/` の Google 標準 proto）はそれぞれ独自のライセンスのままです。
一覧と帰属表示は [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) にあります。

貢献の条件（inbound = outbound、DCO サインオフ）は
[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## 状態

**v0.1.0 — 開発中。** Windows で開発・検証しています。`tauri.conf.json` の
`bundle.targets` は `["nsis"]` です。macOS / Linux 向けのコードはコンパイルは
通りますが実機で動かしていないため、成果物としては出していません。
