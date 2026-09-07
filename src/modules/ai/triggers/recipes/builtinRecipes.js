// The recipes that ship with the app.
//
// The four that used to be a hard-coded type list live here now, in exactly the
// format a user-written recipe uses. That is the point of writing them this
// way: the built-in set is DATA, so "add a preset" is a JSON file rather than
// another branch in the form and another entry in three switch statements —
// and if the shipped format could not express the four cases the app already
// had, it could not express anyone else's either.
//
// The three below the four are the ones docs/design/autonomy-triggers.md §12
// listed as "recommended" and then left as instructions for the user to
// assemble by hand. They are the same engines with the fields filled in.

import { PAYLOAD_FIELDS, COMMON_FIELDS } from '../WatcherEngine.js';

/** Common fields first, then the engine's own — the order the UI lists them. */
function emits(type, extra = []) {
    return [...COMMON_FIELDS, ...(PAYLOAD_FIELDS[type] || []), ...extra];
}

export const BUILTIN_RECIPES = [
    {
        id: 'mail',
        name: 'メール受信（IMAP）',
        description: '受信箱に届いた、前回までに無かったメール。読み取り専用で開くので未読のままです。',
        engine: 'mail',
        // A MECHANISM, not a preset: it asks for everything. Grouped
        // apart from the recipes that arrive already configured, because
        // listing "URL の監視" beside "GitHub Actions が落ちた" puts a
        // tool and one of its uses on the same line.
        basic: true,
        builtin: true,
        fields: [
            { key: 'host', label: 'IMAP サーバ', type: 'text', required: true, placeholder: 'imap.gmail.com' },
            { key: 'port', label: 'ポート', type: 'number', default: 993 },
            { key: 'user', label: 'ユーザー', type: 'text', required: true, placeholder: 'you@example.com' },
            { key: 'password', label: 'パスワード', type: 'secret', required: true,
              hint: 'OS の資格情報マネージャーに入ります。設定ファイルには残りません。' },
            { key: 'mailbox', label: 'フォルダ', type: 'text', default: 'INBOX' },
            { key: 'mailFrom', label: '差出人で絞る', type: 'text', placeholder: 'alerts@example.com' },
            { key: 'mailSubject', label: '件名で絞る', type: 'text' },
            { key: 'unseenOnly', label: '未読だけ', type: 'boolean', default: true },
        ],
        config: {
            host: '{{host}}', port: '{{port}}', user: '{{user}}',
            password: '{{password}}',
            folder: '{{mailbox}}',
            mailFrom: '{{mailFrom}}', mailSubject: '{{mailSubject}}',
            unseenOnly: '{{unseenOnly}}',
        },
        payload: emits('mail'),
        defaults: { everySeconds: 300, eventName: 'mail.received' },
    },
    {
        id: 'folder',
        name: 'フォルダの変更',
        description: '指定フォルダのファイルが追加・更新・削除されたとき。共有フォルダへの納品やスキャン取込に。',
        engine: 'folder',
        // A MECHANISM, not a preset: it asks for everything. Grouped
        // apart from the recipes that arrive already configured, because
        // listing "URL の監視" beside "GitHub Actions が落ちた" puts a
        // tool and one of its uses on the same line.
        basic: true,
        builtin: true,
        fields: [
            { key: 'path', label: '対象フォルダ', type: 'path', required: true, placeholder: 'C:/work/inbox' },
            { key: 'recursive', label: 'サブフォルダも見る', type: 'boolean', default: true },
        ],
        config: { path: '{{path}}', recursive: '{{recursive}}' },
        payload: emits('folder'),
        defaults: { everySeconds: 300, eventName: 'file.changed' },
    },
    {
        id: 'http',
        name: 'URL の監視',
        description: 'レスポンスの中の1つの値を見て、変化した / 指定の値になった瞬間に。',
        engine: 'http',
        // A MECHANISM, not a preset: it asks for everything. Grouped
        // apart from the recipes that arrive already configured, because
        // listing "URL の監視" beside "GitHub Actions が落ちた" puts a
        // tool and one of its uses on the same line.
        basic: true,
        builtin: true,
        fields: [
            { key: 'url', label: 'URL', type: 'text', wide: true, required: true, placeholder: 'https://api.example.com/status' },
            { key: 'watchPath', label: '見る項目', type: 'text', placeholder: 'status',
              hint: '配列は [] を挟みます（assets[].download_count）。' },
            { key: 'equals', label: 'この値になったら', type: 'text', placeholder: 'failure',
              hint: '空なら「変化したら」。入れるとその値になった瞬間だけ1本。' },
            { key: 'aggregate', label: 'まとめ方', type: 'select',
              options: [['', 'まとめない'], ['sum', '合計'], ['count', '件数'], ['max', '最大'], ['min', '最小']] },
            { key: 'headerName', label: '認証ヘッダ名', type: 'text', placeholder: 'Authorization' },
            { key: 'headerValue', label: '認証ヘッダの値', type: 'secret',
              hint: 'OS の資格情報マネージャーに入ります。' },
        ],
        config: {
            url: '{{url}}', watchPath: '{{watchPath}}', equals: '{{equals}}',
            aggregate: '{{aggregate}}',
            headerName: '{{headerName}}', headerValue: '{{headerValue}}',
        },
        payload: emits('http'),
        defaults: { everySeconds: 300, eventName: 'http.changed' },
    },
    {
        id: 'command',
        name: 'コマンドの出力',
        description: '上のどれでも賄えないもの。出力の1行が1件になります。',
        engine: 'command',
        // A MECHANISM, not a preset: it asks for everything. Grouped
        // apart from the recipes that arrive already configured, because
        // listing "URL の監視" beside "GitHub Actions が落ちた" puts a
        // tool and one of its uses on the same line.
        basic: true,
        builtin: true,
        fields: [
            { key: 'command', label: 'コマンド', type: 'text', wide: true, required: true,
              placeholder: 'git ls-remote origin main' },
            { key: 'cwd', label: '実行フォルダ', type: 'path', required: true },
        ],
        config: { command: '{{command}}', cwd: '{{cwd}}' },
        payload: emits('command'),
        defaults: { everySeconds: 300, eventName: 'line.matched' },
    },

    // ── The "recommended presets" the design doc left as instructions ──────
    {
        id: 'github-actions',
        name: 'GitHub Actions が落ちた',
        description: '最新のワークフローが failure になった瞬間だけ1本。赤いままの間は繰り返しません。',
        engine: 'http',
        builtin: true,
        fields: [
            { key: 'repo', label: 'リポジトリ (owner/name)', type: 'text', required: true,
              placeholder: 'owner/repo' },   // a shipped example must not name our own repo
            { key: 'token', label: 'GitHub トークン', type: 'secret',
              hint: 'public リポジトリなら空でも動きますが、すぐレート制限にかかります。' },
        ],
        config: {
            url: 'https://api.github.com/repos/{{repo}}/actions/runs?per_page=1',
            headerName: 'Authorization',
            headerValue: 'Bearer {{token}}',
            watchPath: 'workflow_runs.0.conclusion',
            equals: 'failure',
        },
        job: {
            name: 'CI 失敗の一次調査',
            purpose: 'ビルドが落ちたとき、原因の当たりを付けておく',
            prompt: '{{payload.watcher}} が CI の失敗を検出しました（{{payload.value}}）。\n\n'
                + '1. 直近の失敗したワークフローのログを確認する\n'
                + '2. 失敗したステップと、その原因の候補を挙げる\n'
                + '3. 関係しそうなファイルを読んで、修正案を提示する（適用はしない）',
            maxPerHour: 5,
        },
        payload: emits('http'),
        defaults: { everySeconds: 300, eventName: 'ci.failed' },
    },
    {
        id: 'health-check',
        name: 'サービスの死活',
        description: 'ヘルス URL の値が変わったとき。落ちたときも、復旧したときも1本ずつ。',
        engine: 'http',
        builtin: true,
        fields: [
            { key: 'url', label: 'ヘルス URL', type: 'text', wide: true, required: true,
              placeholder: 'https://example.com/healthz' },
            { key: 'watchPath', label: '見る項目', type: 'text', placeholder: 'status',
              hint: 'JSON でないなら空のままで、本文そのものを見ます。' },
        ],
        config: { url: '{{url}}', watchPath: '{{watchPath}}' },
        job: {
            name: 'サービス状態の記録',
            purpose: '落ちた／戻ったを記録し、原因の手がかりを残す',
            prompt: '{{payload.url}} の状態が {{payload.previous}} → {{payload.value}} に変わりました。\n\n'
                + '1. docs/uptime.md を読む（無ければ作る）\n'
                + '2. 日時・変化・分かる範囲の状況を1行追記する',
            maxPerHour: 10,
        },
        payload: emits('http'),
        defaults: { everySeconds: 120, eventName: 'service.changed' },
    },
    {
        id: 'git-remote',
        name: 'リモートブランチが更新された',
        description: '誰かが push した合図。出力が変わった行だけが1件になります。',
        engine: 'command',
        builtin: true,
        fields: [
            { key: 'repo', label: 'リポジトリのフォルダ', type: 'path', required: true },
            { key: 'branch', label: 'ブランチ', type: 'text', default: 'main' },
        ],
        config: { command: 'git ls-remote origin {{branch}}', cwd: '{{repo}}' },
        job: {
            name: 'push された変更の確認',
            purpose: '自分以外の変更を取りこぼさない',
            prompt: 'リモートが更新されました（{{payload.line}}）。\n\n'
                + '1. 直近の差分を確認する\n'
                + '2. 気になる点があれば挙げる。無ければ「特になし」と答える',
            maxPerHour: 5,
        },
        payload: emits('command'),
        defaults: { everySeconds: 300, eventName: 'git.pushed' },
    },
    // ── Driven by the clock ──────────────────────────────────────────────
    //
    // No engine: there is nothing to poll, so none of the watcher machinery
    // applies. They are here, in the same list, because "every morning" and
    // "when mail arrives" are the same decision to the person making it, and
    // separating them by implementation is what the three tabs used to do.
    {
        id: 'daily-report',
        name: '毎朝の日報下書き',
        description: '決まった時刻に、前日の作業から日報の下書きを作ります。監視は要りません。',
        builtin: true,
        schedule: { scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5] },
        defaults: { eventName: 'schedule.daily' },
        job: {
            name: '日報の下書き',
            purpose: '毎朝、前日ぶんの記録から下書きを用意しておく',
            prompt: '前日の作業内容から日報の下書きを作ってください。\n\n'
                + '1. 直近のコミットと変更ファイルを確認する\n'
                + '2. docs/daily/<今日の日付>.md に、やったこと・詰まったこと・次の予定を書く',
            maxPerHour: 2,
        },
    },
    {
        id: 'weekly-review',
        name: '週次のふりかえり',
        description: '週に一度、その週の変更をまとめます。監視は要りません。',
        builtin: true,
        schedule: { scheduleType: 'fixed', time: '17:00', days: [5] },
        defaults: { eventName: 'schedule.weekly' },
        job: {
            name: '週次まとめ',
            purpose: '週の終わりに、何が変わったかを一枚にしておく',
            prompt: '今週の変更をまとめてください。\n\n'
                + '1. 今週のコミットを確認する\n'
                + '2. 主な変更・残っている課題・来週やることを docs/weekly.md に追記する',
            maxPerHour: 2,
        },
    },
];
