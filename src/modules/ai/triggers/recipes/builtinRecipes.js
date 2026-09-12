// The recipes that ship with the app.
//
// The four that used to be a hard-coded type list live here now, in exactly the
// format a user-written recipe uses. That is the point of writing them this
// way: the built-in set is DATA, so "add a preset" is a JSON file rather than
// another branch in the form and another entry in three switch statements —
// and if the shipped format could not express the four cases the app already
// had, it could not express anyone else's either.
//
// The ones below the four are what docs/design/autonomy-triggers.md §12 listed
// as "recommended" and then left as instructions for the user to assemble by
// hand. They are the same engines with the fields filled in.
//
// ── Two languages, side by side ──────────────────────────────────────────
//
// Every string a person reads is `L(ja, en)`. Recipe text is DATA rather than
// chrome, so it does not live in the i18n catalogs: a recipe is a file someone
// can write and hand to a colleague, and making them edit two message catalogs
// to name it would end the format's whole point. A plain string is still valid
// and is what a user-written recipe has — see `localized()` in recipeFormat.js.
//
// Keeping both languages in the same expression is deliberate: the alternative,
// a key here and the text in two catalogs, is three places to edit and two of
// them are easy to forget. Here a recipe cannot be half-translated without the
// gap being visible on the line you are already editing.

import { PAYLOAD_FIELDS, COMMON_FIELDS } from '../WatcherEngine.js';

/** One string, two languages. Anything missing falls back to Japanese. */
const L = (ja, en) => ({ ja, en });

/** Common fields first, then the engine's own — the order the UI lists them. */
function emits(type, extra = []) {
    return [...COMMON_FIELDS, ...(PAYLOAD_FIELDS[type] || []), ...extra];
}

/** The note every mailbox password field carries. */
const SECRET_HINT = L(
    'OS の資格情報マネージャーに入ります。設定ファイルには残りません。',
    'Kept in the OS credential store. It never lands in the settings file.');

export const BUILTIN_RECIPES = [
    {
        id: 'mail',
        name: L('メール受信（IMAP）', 'Incoming mail (IMAP)'),
        description: L(
            '受信箱に届いた、前回までに無かったメール。読み取り専用で開くので未読のままです。',
            'Mail in the inbox that was not there last time. Opened read-only, so it stays unread.'),
        engine: 'mail',
        // A MECHANISM, not a preset: it asks for everything. Grouped
        // apart from the recipes that arrive already configured, because
        // listing "URL の監視" beside "GitHub Actions が落ちた" puts a
        // tool and one of its uses on the same line.
        basic: true,
        builtin: true,
        fields: [
            { key: 'host', label: L('IMAP サーバ', 'IMAP server'), type: 'text', required: true, placeholder: 'imap.gmail.com' },
            { key: 'port', label: L('ポート', 'Port'), type: 'number', default: 993 },
            { key: 'user', label: L('ユーザー', 'User'), type: 'text', required: true, placeholder: 'you@example.com' },
            { key: 'password', label: L('パスワード', 'Password'), type: 'secret', required: true,
              hint: SECRET_HINT },
            { key: 'mailbox', label: L('フォルダ', 'Mailbox'), type: 'text', default: 'INBOX' },
            { key: 'mailFrom', label: L('差出人で絞る', 'Only from'), type: 'text', placeholder: 'alerts@example.com' },
            { key: 'mailSubject', label: L('件名で絞る', 'Only subjects containing'), type: 'text' },
            { key: 'unseenOnly', label: L('未読だけ', 'Unread only'), type: 'boolean', default: true },
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
        name: L('フォルダの変更', 'Folder changes'),
        description: L(
            '指定フォルダのファイルが追加・更新・削除されたとき。共有フォルダへの納品やスキャン取込に。',
            'A file added, changed or deleted in a folder. For deliveries to a shared folder, or scanned documents.'),
        engine: 'folder',
        basic: true,
        builtin: true,
        fields: [
            { key: 'path', label: L('対象フォルダ', 'Folder to watch'), type: 'path', required: true, placeholder: 'C:/work/inbox' },
            { key: 'recursive', label: L('サブフォルダも見る', 'Include subfolders'), type: 'boolean', default: true },
        ],
        config: { path: '{{path}}', recursive: '{{recursive}}' },
        payload: emits('folder'),
        defaults: { everySeconds: 300, eventName: 'file.changed' },
    },
    {
        id: 'http',
        name: L('URL の監視', 'Watch a URL'),
        description: L(
            'レスポンスの中の1つの値を見て、変化した / 指定の値になった瞬間に。',
            'Watches one value in the response, and fires when it changes or becomes what you name.'),
        engine: 'http',
        basic: true,
        builtin: true,
        fields: [
            { key: 'url', label: 'URL', type: 'text', wide: true, required: true, placeholder: 'https://api.example.com/status' },
            { key: 'watchPath', label: L('見る項目', 'Value to watch'), type: 'text', placeholder: 'status',
              hint: L('配列は [] を挟みます（assets[].download_count）。',
                      'Arrays take [] in the path (assets[].download_count).') },
            { key: 'equals', label: L('この値になったら', 'Fire when it equals'), type: 'text', placeholder: 'failure',
              hint: L('空なら「変化したら」。入れるとその値になった瞬間だけ1本。',
                      'Empty means "whenever it changes". With a value, it fires once, on the moment it becomes that.') },
            { key: 'aggregate', label: L('まとめ方', 'Combine with'), type: 'select',
              options: [['', L('まとめない', 'No')], ['sum', L('合計', 'Sum')], ['count', L('件数', 'Count')],
                        ['max', L('最大', 'Max')], ['min', L('最小', 'Min')]] },
            { key: 'headerName', label: L('認証ヘッダ名', 'Auth header name'), type: 'text', placeholder: 'Authorization' },
            { key: 'headerValue', label: L('認証ヘッダの値', 'Auth header value'), type: 'secret',
              hint: L('OS の資格情報マネージャーに入ります。', 'Kept in the OS credential store.') },
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
        name: L('コマンドの出力', 'Command output'),
        description: L(
            '上のどれでも賄えないもの。出力の1行が1件になります。',
            'For anything the others cannot cover. Each line of output is one finding.'),
        engine: 'command',
        basic: true,
        builtin: true,
        fields: [
            { key: 'command', label: L('コマンド', 'Command'), type: 'text', wide: true, required: true,
              placeholder: 'git ls-remote origin main' },
            { key: 'cwd', label: L('実行フォルダ', 'Working folder'), type: 'path', required: true },
        ],
        config: { command: '{{command}}', cwd: '{{cwd}}' },
        payload: emits('command'),
        defaults: { everySeconds: 300, eventName: 'line.matched' },
    },

    // ── The "recommended presets" the design doc left as instructions ──────
    {
        id: 'github-actions',
        needsAI: L('ログの中身によって、次に見るファイルが変わります。',
                   'Which file to open next depends on what the log says.'),
        category: 'notice',
        name: L('GitHub Actions が落ちた', 'GitHub Actions failed'),
        description: L(
            '最新のワークフローが failure になった瞬間だけ1本。赤いままの間は繰り返しません。',
            'One job the moment the latest workflow turns to failure. It does not repeat while the build stays red.'),
        engine: 'http',
        builtin: true,
        fields: [
            { key: 'repo', label: L('リポジトリ (owner/name)', 'Repository (owner/name)'), type: 'text', required: true,
              placeholder: 'owner/repo' },   // a shipped example must not name our own repo
            { key: 'token', label: L('GitHub トークン', 'GitHub token'), type: 'secret',
              hint: L('public リポジトリなら空でも動きますが、すぐレート制限にかかります。',
                      'A public repository works without one, but you will hit the rate limit quickly.') },
        ],
        config: {
            url: 'https://api.github.com/repos/{{repo}}/actions/runs?per_page=1',
            headerName: 'Authorization',
            headerValue: 'Bearer {{token}}',
            watchPath: 'workflow_runs.0.conclusion',
            equals: 'failure',
        },
        job: {
            name: L('CI 失敗の一次調査', 'First look at a CI failure'),
            purpose: L('ビルドが落ちたとき、原因の当たりを付けておく',
                       'Have a first guess at the cause ready when a build breaks'),
            prompt: L(
                '{{payload.watcher}} が CI の失敗を検出しました（{{payload.value}}）。\n\n'
                + '1. 直近の失敗したワークフローのログを確認する\n'
                + '2. 失敗したステップと、その原因の候補を挙げる\n'
                + '3. 関係しそうなファイルを読んで、修正案を提示する（適用はしない）',
                '{{payload.watcher}} saw a CI failure ({{payload.value}}).\n\n'
                + '1. Read the log of the most recent failed workflow\n'
                + '2. Name the step that failed and the likely causes\n'
                + '3. Read the files that look involved and propose a fix — do NOT apply it'),
            maxPerHour: 5,
        },
        payload: emits('http'),
        defaults: { everySeconds: 300, eventName: 'ci.failed' },
    },
    {
        id: 'health-check',
        name: L('サービスの死活', 'Service up or down'),
        description: L(
            'ヘルス URL の値が変わったとき。落ちたときも、復旧したときも1本ずつ。',
            'When the value at a health URL changes. One job when it goes down, one when it comes back.'),
        engine: 'http',
        builtin: true,
        fields: [
            { key: 'url', label: L('ヘルス URL', 'Health URL'), type: 'text', wide: true, required: true,
              placeholder: 'https://example.com/healthz' },
            { key: 'watchPath', label: L('見る項目', 'Value to watch'), type: 'text', placeholder: 'status',
              hint: L('JSON でないなら空のままで、本文そのものを見ます。',
                      'Leave it empty for a response that is not JSON: the body itself is watched.') },
        ],
        config: { url: '{{url}}', watchPath: '{{watchPath}}' },
        job: {
            name: L('サービス状態の記録', 'Record the service state'),
            purpose: L('落ちた／戻ったを記録し、原因の手がかりを残す',
                       'Keep a record of down and back up, with whatever context there was'),
            prompt: L(
                '{{payload.url}} の状態が {{payload.previous}} → {{payload.value}} に変わりました。\n\n'
                + '1. docs/uptime.md を読む（無ければ作る）\n'
                + '2. 日時・変化・分かる範囲の状況を1行追記する',
                '{{payload.url}} changed from {{payload.previous}} to {{payload.value}}.\n\n'
                + '1. Read docs/uptime.md (create it if it does not exist)\n'
                + '2. Append one line: the time, the change, and whatever the state suggests'),
            maxPerHour: 10,
        },
        payload: emits('http'),
        defaults: { everySeconds: 120, eventName: 'service.changed' },
    },
    {
        id: 'git-remote',
        name: L('リモートブランチが更新された', 'The remote branch moved'),
        description: L(
            '誰かが push した合図。出力が変わった行だけが1件になります。',
            'The sign that somebody pushed. Only a line that changed counts as a finding.'),
        engine: 'command',
        builtin: true,
        fields: [
            { key: 'repo', label: L('リポジトリのフォルダ', 'Repository folder'), type: 'path', required: true },
            { key: 'branch', label: L('ブランチ', 'Branch'), type: 'text', default: 'main' },
        ],
        config: { command: 'git ls-remote origin {{branch}}', cwd: '{{repo}}' },
        job: {
            name: L('push された変更の確認', 'Look at what was pushed'),
            purpose: L('自分以外の変更を取りこぼさない', 'Do not miss changes somebody else made'),
            prompt: L(
                'リモートが更新されました（{{payload.line}}）。\n\n'
                + '1. 直近の差分を確認する\n'
                + '2. 気になる点があれば挙げる。無ければ「特になし」と答える',
                'The remote moved ({{payload.line}}).\n\n'
                + '1. Read the most recent diff\n'
                + '2. Raise anything that looks worth a second look. If there is nothing, say so'),
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
        needsAI: L('出力が人向けの文章です。コミットの羅列では日報になりません。',
                   'The output is prose for a person to read. A list of commits is not a report.'),
        category: 'write',
        name: L('毎朝の日報下書き', 'Draft the daily report'),
        description: L(
            '決まった時刻に、前日の作業から日報の下書きを作ります。監視は要りません。',
            'At a set time, drafts a daily report from yesterday\'s work. No watcher needed.'),
        builtin: true,
        schedule: { scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5] },
        defaults: { eventName: 'schedule.daily' },
        job: {
            name: L('日報の下書き', 'Daily report draft'),
            purpose: L('毎朝、前日ぶんの記録から下書きを用意しておく',
                       'Have a draft ready each morning, from yesterday\'s record'),
            prompt: L(
                '前日の作業内容から日報の下書きを作ってください。\n\n'
                + '1. 直近のコミットと変更ファイルを確認する\n'
                + '2. docs/daily/<今日の日付>.md に、やったこと・詰まったこと・次の予定を書く',
                'Draft the daily report from yesterday\'s work.\n\n'
                + '1. Read the recent commits and the files they changed\n'
                + '2. Write what was done, what got stuck, and what is next '
                + 'into docs/daily/<today\'s date>.md'),
            maxPerHour: 2,
        },
    },
    {
        id: 'weekly-review',
        needsAI: L('一週間の変更から「何をしていたか」を書き起こす必要があります。',
                   'It has to turn a week of changes into an account of what was being done.'),
        category: 'write',
        name: L('週次のふりかえり', 'Weekly review'),
        description: L(
            '週に一度、その週の変更をまとめます。監視は要りません。',
            'Once a week, sums up what changed. No watcher needed.'),
        builtin: true,
        schedule: { scheduleType: 'fixed', time: '17:00', days: [5] },
        defaults: { eventName: 'schedule.weekly' },
        job: {
            name: L('週次まとめ', 'Weekly summary'),
            purpose: L('週の終わりに、何が変わったかを一枚にしておく',
                       'End the week with one page of what changed'),
            prompt: L(
                '今週の変更をまとめてください。\n\n'
                + '1. 今週のコミットを確認する\n'
                + '2. 主な変更・残っている課題・来週やることを docs/weekly.md に追記する',
                'Sum up this week\'s changes.\n\n'
                + '1. Read this week\'s commits\n'
                + '2. Append the main changes, what is still open, and next week\'s work '
                + 'to docs/weekly.md'),
            maxPerHour: 2,
        },
    },

    // ── 転記をなくす ─────────────────────────────────────────────────────
    //
    // The category this app is actually best at, and the one the shipped
    // presets missed entirely: 0.2.0 can append a row that inherits the ruling
    // above it and can report what a sheet already looks like, so the output
    // matches the book instead of landing as an unformatted stripe.
    {
        id: 'mail-to-ledger',
        name: L('メールの明細を台帳に追記', 'Append email line items to a ledger'),
        description: L(
            '決まった相手から届くメールの本文を読んで、台帳の .xlsx に1行足します。',
            'Reads mail from a known sender and adds one row to a ledger .xlsx.'),
        needsAI: L('本文の書き方が差出人ごとに違います。項目の位置が決まっていません。',
                   'Every sender writes the body differently. The fields are not in fixed places.'),
        category: 'transcribe',
        engine: 'mail',
        builtin: true,
        fields: [
            { key: 'host', label: L('IMAP サーバ', 'IMAP server'), type: 'text', required: true, placeholder: 'imap.example.com' },
            { key: 'port', label: L('ポート', 'Port'), type: 'number', default: 993 },
            { key: 'user', label: L('ユーザー', 'User'), type: 'text', required: true },
            { key: 'password', label: L('パスワード', 'Password'), type: 'secret', required: true,
              hint: SECRET_HINT },
            { key: 'mailFrom', label: L('差出人で絞る', 'Only from'), type: 'text', wide: true,
              hint: L('ここを空にすると受信箱すべてが対象になります。必ず絞ってください。',
                      'Leaving this empty means the whole inbox. Always narrow it.') },
            { key: 'mailSubject', label: L('件名で絞る', 'Only subjects containing'), type: 'text', wide: true },
            { key: 'ledger', label: L('台帳の .xlsx', 'The ledger .xlsx'), type: 'path', required: true },
        ],
        config: {
            host: '{{host}}', port: '{{port}}', user: '{{user}}', password: '{{password}}',
            folder: 'INBOX', mailFrom: '{{mailFrom}}', mailSubject: '{{mailSubject}}', unseenOnly: true,
        },
        payload: emits('mail'),
        defaults: { everySeconds: 300, eventName: 'mail.ledger' },
        job: {
            name: L('明細を台帳に追記', 'Append the line items'),
            purpose: L('毎回手で写している転記をなくす', 'Stop retyping the same figures by hand'),
            prompt: L(
                '{{payload.from}} から「{{payload.subject}}」というメールが届きました。\n\n'
                + '本文:\n{{payload.body}}\n\n'
                + '1. 台帳を read_office で開き、formatting も見て、どの列に何が入るかを確かめる\n'
                + '2. 本文から各列に対応する値を読み取る\n'
                + '3. append_xlsx_row で1行追記する（書式は上の行を継ぎます）\n'
                + '4. 読み取れなかった項目があれば、埋めずに「要確認」として最後に列挙する\n\n'
                + '確信が持てない値を推測で埋めないでください。空欄と報告のほうが安全です。',
                'Mail arrived from {{payload.from}}, subject "{{payload.subject}}".\n\n'
                + 'Body:\n{{payload.body}}\n\n'
                + '1. Open the ledger with read_office, formatting included, and work out '
                + 'what belongs in each column\n'
                + '2. Read the value for each column out of the body\n'
                + '3. Append one row with append_xlsx_row (it inherits the ruling above it)\n'
                + '4. List anything you could NOT read at the end, as "needs checking" — '
                + 'do not fill it in\n\n'
                + 'Never guess at a value you are unsure of. A blank and a note is the safer answer.'),
            maxPerHour: 20,
        },
    },
    {
        id: 'excel-intake',
        name: L('届いた Excel を集計台帳に転記', 'Copy an incoming Excel into the ledger'),
        description: L(
            'フォルダに置かれた .xlsx を読んで、集計用の台帳に転記します。',
            'Reads an .xlsx dropped in a folder and copies it into the ledger you total up.'),
        needsAI: L('取引先ごとに列の並びも見出しも違うので、対応付けを毎回読み取る必要があります。',
                   'Every supplier orders and names the columns differently, so the mapping has to be read each time.'),
        category: 'transcribe',
        engine: 'folder',
        builtin: true,
        fields: [
            { key: 'path', label: L('受け取るフォルダ', 'Folder files arrive in'), type: 'path', required: true },
            { key: 'ledger', label: L('集計台帳の .xlsx', 'The ledger .xlsx'), type: 'path', required: true },
        ],
        config: { path: '{{path}}', recursive: false },
        payload: emits('folder'),
        defaults: { everySeconds: 300, eventName: 'file.intake' },
        job: {
            name: L('Excel を台帳に転記', 'Copy the Excel into the ledger'),
            purpose: L('取引先ごとに違う様式を、1つの集計表にそろえる',
                       'Get every supplier\'s own layout into one table'),
            prompt: L(
                '{{payload.path}} が {{payload.kind}} されました。\n\n'
                + '1. そのファイルを read_office で開く（formatting も見る）\n'
                + '2. 集計台帳も開き、台帳のどの列が、届いたファイルのどの列に当たるかを対応付ける\n'
                + '3. append_xlsx_row で明細行を追記する\n'
                + '4. 対応が取れなかった列、単位や日付形式が違うものは、勝手に変換せず最後に報告する\n\n'
                + '台帳の既存行は書き換えないでください。追記だけです。',
                '{{payload.path}} was {{payload.kind}}.\n\n'
                + '1. Open that file with read_office, formatting included\n'
                + '2. Open the ledger too, and map each ledger column to a column in the new file\n'
                + '3. Append the rows with append_xlsx_row\n'
                + '4. Report at the end any column you could not map, and anything whose unit '
                + 'or date format differs — do not convert it yourself\n\n'
                + 'Never change a row the ledger already has. Appending only.'),
            maxPerHour: 20,
        },
    },

    // ── 気づく ─────────────────────────────────────────────────────────
    {
        id: 'mail-triage',
        name: L('要対応メールの仕分け', 'Triage mail that needs an answer'),
        description: L(
            '届いたメールが対応の要るものかを判断し、必要なら返信の下書きまで作ります。送信はしません。',
            'Decides whether incoming mail needs an answer and drafts one if it does. It never sends.'),
        needsAI: L('「対応が要るか」は文でしか書けない基準です。迷ったものだけ人に回せます。',
                   '"Does this need an answer" is a rule you can only write in prose. Only the unclear ones reach you.'),
        category: 'notice',
        engine: 'mail',
        builtin: true,
        fields: [
            { key: 'host', label: L('IMAP サーバ', 'IMAP server'), type: 'text', required: true, placeholder: 'imap.example.com' },
            { key: 'port', label: L('ポート', 'Port'), type: 'number', default: 993 },
            { key: 'user', label: L('ユーザー', 'User'), type: 'text', required: true },
            { key: 'password', label: L('パスワード', 'Password'), type: 'secret', required: true,
              hint: L('OS の資格情報マネージャーに入ります。', 'Kept in the OS credential store.') },
            { key: 'mailFrom', label: L('差出人で絞る', 'Only from'), type: 'text', wide: true },
            { key: 'notes', label: L('書き出すフォルダ', 'Folder to write into'), type: 'path', required: true,
              hint: L('仕分けメモと返信の下書きをここに置きます。',
                      'The triage note and the draft reply are written here.') },
        ],
        config: {
            host: '{{host}}', port: '{{port}}', user: '{{user}}', password: '{{password}}',
            folder: 'INBOX', mailFrom: '{{mailFrom}}', unseenOnly: true,
        },
        payload: emits('mail'),
        defaults: { everySeconds: 600, eventName: 'mail.triage' },
        job: {
            name: L('メールの仕分け', 'Mail triage'),
            purpose: L('対応の要るものを見落とさない。判断に迷ったものは自分で読む',
                       'Miss nothing that needs an answer; read the unclear ones yourself'),
            prompt: L(
                '{{payload.from}} から「{{payload.subject}}」が届きました。\n\n'
                + '本文:\n{{payload.body}}\n\n'
                + '1. これが「対応が要る / 様子見でよい / 判断がつかない」のどれかを決める\n'
                + '2. 理由を1〜2行で書く\n'
                + '3. 対応が要るなら、返信の下書きを作る\n'
                + '4. 書き出すフォルダに <日付>_<差出人>.md として保存する\n\n'
                + 'メールの送信はしないでください。下書きを置くところまでです。\n'
                + '判断がつかないものは、無理に決めず「判断がつかない」と書いてください。',
                '"{{payload.subject}}" arrived from {{payload.from}}.\n\n'
                + 'Body:\n{{payload.body}}\n\n'
                + '1. Decide whether it needs an answer, can wait, or is unclear\n'
                + '2. Give the reason in a line or two\n'
                + '3. If it needs an answer, draft one\n'
                + '4. Save it in the output folder as <date>_<sender>.md\n\n'
                + 'Never send mail. Leaving a draft is as far as this goes.\n'
                + 'If it is unclear, say so rather than forcing a decision.'),
            maxPerHour: 30,
        },
    },

    // ── 整理する（MCP が要るもの）────────────────────────────────────────
    //
    // These two need a server that this machine may not have. `requiresMcp`
    // lets the catalogue say what to configure rather than offering something
    // that fails on its first run.
    //
    // The prompts name no specific TOOL. Which tools a Backlog server exposes
    // is that server's business and differs between them; the agent is told
    // what it wants and finds the tool, so swapping the server does not break
    // the template.
    {
        id: 'backlog-today',
        name: L('今日やることの整理（Backlog）', 'Plan today (Backlog)'),
        description: L(
            '毎朝、自分の未完了の課題を取ってきて、締切と依存を見て順番をつけます。',
            'Each morning, fetches your open issues and orders them by deadline and dependency.'),
        needsAI: L('締切だけでは順番は決まりません。内容を読んで優先度を判断する必要があります。',
                   'Deadlines alone do not decide the order. It has to read the issues to judge priority.'),
        category: 'organize',
        requiresMcp: ['backlog'],
        builtin: true,
        schedule: { scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5] },
        defaults: { eventName: 'schedule.backlog.today' },
        job: {
            name: L('今日やることの整理', 'Plan today'),
            purpose: L('朝いちばんに、どれから手を付けるかを決めておく',
                       'Know first thing in the morning what to start with'),
            prompt: L(
                'Backlog の MCP ツールを使って、自分に割り当てられた未完了の課題を取得してください。\n\n'
                + '1. 期限切れ・今日締切・今週締切に分ける\n'
                + '2. 内容を読んで、他の課題の前提になっているものを先に置く\n'
                + '3. 今日着手すべき3件を選び、それぞれ最初の一手を1行で書く\n'
                + '4. docs/today.md に上書きで書き出す\n\n'
                + '課題の状態は変更しないでください。読むだけです。',
                'Use the Backlog MCP tools to fetch the open issues assigned to me.\n\n'
                + '1. Split them into overdue, due today, and due this week\n'
                + '2. Read them, and put anything other issues depend on first\n'
                + '3. Pick the three to start today, each with its first step in one line\n'
                + '4. Write the result over docs/today.md\n\n'
                + 'Never change an issue\'s state. Reading only.'),
            maxPerHour: 2,
        },
    },
    {
        id: 'backlog-weekly',
        name: L('週次の進捗まとめ（Backlog）', 'Weekly progress (Backlog)'),
        description: L(
            '週末に、その週の完了ぶんと残っているものを集計して報告文にします。',
            'At the end of the week, totals what closed and what is left, as prose you can send.'),
        needsAI: L('課題の一覧ではなく、報告として読める文章にする必要があります。',
                   'It has to read as a report, not as a list of issues.'),
        category: 'organize',
        requiresMcp: ['backlog'],
        builtin: true,
        schedule: { scheduleType: 'fixed', time: '17:00', days: [5] },
        defaults: { eventName: 'schedule.backlog.weekly' },
        job: {
            name: L('週次の進捗まとめ', 'Weekly progress'),
            purpose: L('週報を毎回ゼロから書かない', 'Stop writing the weekly report from nothing'),
            prompt: L(
                'Backlog の MCP ツールで、今週更新された課題を取得してください。\n\n'
                + '1. 完了したもの / 進行中 / 手が付いていないもの に分ける\n'
                + '2. 遅れているものは、理由が課題のコメントから読み取れるなら添える\n'
                + '3. 来週に持ち越すものを挙げる\n'
                + '4. docs/weekly-backlog.md に追記する（過去分は消さない）\n\n'
                + '数字を作らないでください。取得できた課題だけを根拠にします。',
                'Use the Backlog MCP tools to fetch the issues updated this week.\n\n'
                + '1. Split them into closed, in progress, and not started\n'
                + '2. For anything late, add the reason if the comments say what it was\n'
                + '3. List what carries into next week\n'
                + '4. Append to docs/weekly-backlog.md, keeping what is already there\n\n'
                + 'Never invent a number. Only the issues you actually fetched count as evidence.'),
            maxPerHour: 2,
        },
    },
];
