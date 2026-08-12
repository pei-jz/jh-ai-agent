# J.H AI Agent

ローカル AI サーバー (LocalAI) と連携して、AI エージェントをダッシュボードから管理・実行するための Tauri 製のデスクトップアプリケーションです。

## プロジェクト概要

このプロジェクトは、オフラインで動作する AI エージェント実行プラットフォームです。LocalAI を中核とした完全な AI 環境を提供します。

### 主な機能

- **LLM チャット**: ローカル AI モデルとの対話
- **RAG 機能**: 自らの知識ベースからの検索と回答
- **リアルタイムモニター**: トークン使用量やステータスの可視化
- **タスク管理**: 実行中の AI タスクの追跡と履歴管理
- **ファイル操作**: ローカルファイルの読み書きとディレクトリ操作
- **シェルコマンド**: ローカルシステムのコンマンド実行
- **設定管理**: AI モデル、API キー、ネットワーク設定の一元管理

### 技術スタック

- **Frontend**: Tauri + Vanilla HTML/CSS/JavaScript
- **Backend**: Rust (Tauri)
- **AI サーバー**: LocalAI (ローカル AI サービス)
- **WebSocket**: リアルタイム通信のための WebSocket クライアント
- **API エンドポイント**:
  - AI チャット
  - RAG エンドポイント
  - ファイル管理
  - シェルコマンド実行
  - インデックス作成

### 開発環境

- Tauri + Vanilla HTML, CSS and Javascript
- Rust (Tauri)

### 特徴

- ✅ **完全オフライン動作**: 外部 API に依存せず、ローカルで動作
- ✅ **ローカル AI**: 個人データを外部に送信せず、プライバシー保護
- ✅ **リアルタイムモニター**: トークン使用量やステータスの可視化
- ✅ **RAG 機能**: 自らの知識ベースからの検索と回答

## おすすめのセットアップ

ローカルで動作することを重視しており、完全にオフラインで動作する AI エージェント実行環境を提供します。

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
npm run tauri build
```

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

---

*このプロジェクトは、完全な AI エージェント実行プラットフォームを目指しています。*
