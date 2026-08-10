// Japanese catalog — the source of truth for wording.
//
// These strings were written in Japanese first, so this file is the most complete
// catalog and the fallback for every other locale (i18n/index.js FALLBACK_LOCALE).
// When you add a key here, add it to en.js too; a key present in only one catalog
// is not an error but it does mean somebody sees the wrong language.
//
// Keys are dotted and grouped by surface. Placeholders are {name} — see interpolate().
export const ja = {
    // ── Shared verbs. Reuse these instead of adding a second "保存". ──
    'common.save': '保存',
    'common.cancel': 'キャンセル',
    'common.close': '閉じる',
    'common.delete': '削除',
    'common.apply': '適用',
    'common.back': '戻る',
    'common.next': '次へ',
    'common.done': '完了',
    'common.unknown': '不明',
    'common.language': '表示言語',
    'common.language.hint': 'アプリの表示言語です。AIの回答言語は Agent Behavior で別に設定します。',

    // ── Updates ──
    'update.checking': '更新を確認しています…',
    'update.available': '新しいバージョン {version} があります',
    'update.downloading': 'ダウンロード中… {percent}%',
    'update.downloading.detail': '完了するとアプリを再起動します。',
    'update.ready': 'バージョン {version} を適用する準備ができました',
    'update.ready.detail': '再起動して更新を完了します。',
    'update.current': '最新版を使用しています',
    // Never "up to date": nothing was verified.
    'update.failed': '更新を確認できませんでした',
    'update.failed.detail': 'ネットワークまたは配布元に到達できません。',
    'update.unconfigured': '自動更新は設定されていません',
    'update.unconfigured.detail': 'このビルドには署名鍵が設定されていないため、更新の確認は行えません。',
    'update.install': '更新する',
    'update.disable': '今後確認しない',
    'update.section': 'Updates — バージョンと更新確認',
    'update.currentVersion': '現在のバージョン: {version}',
    'update.check': '更新を確認',
    'update.signed.hint': '更新は署名を検証してから適用されます。検証できない配布物はインストールされません。',

    // ── Licence ──
    'license.section': 'License — エディションとキー',
    'license.key': 'ライセンスキー',
    'license.licensee': 'ライセンス先',
    'license.offline.hint': 'キーはこの端末にのみ保存され、送信されません（検証はオフラインで行われます）。',
    'license.clear': '保存されているキーを削除する',
    'license.community': 'Community エディション',
    'license.community.detail': '基本機能はすべて利用できます。',
    'license.active': '{edition} ライセンス（有効）',
    'license.active.perpetual': '期限なし（無期限）',
    'license.active.expires': '期限: {date}',
    'license.active.expiring': '{date} に期限切れになります（残り {days} 日）。',
    'license.grace': '{edition} ライセンス（期限切れ・猶予期間中）',
    'license.grace.detail': '{date} に期限が切れています。あと {days} 日はこれまでどおり使用できます。更新をご検討ください。',
    'license.expired': 'ライセンスの期限が切れています',
    'license.expired.detail': '{date} に期限切れ。Community 機能で引き続き使用できます（データや作成済みファイルはそのまま開けます）。',
    'license.invalid': 'ライセンスキーを確認できませんでした',
    'license.invalid.detail': '署名が一致しません。キーを貼り直しても解決しない場合は、発行元にお問い合わせください。',
    'license.unconfigured.hint': 'このビルドはライセンス発行鍵を持たないため、キーの適用はできません。すべての機能が Community として利用可能です。',

    // ── First-run wizard ──
    'onboarding.title': 'J.H AI Agent へようこそ',
    'onboarding.aria': '初期セットアップ',
    'onboarding.skip': 'あとで設定する',
    'onboarding.step.connect': 'AIモデルに接続',
    'onboarding.step.connect.blurb': 'エージェントが動くために必要な唯一の設定です。クラウドのAPIキー、または Ollama などローカル実行のどちらでも構いません。',
    'onboarding.step.workspace': 'ワークスペースを選ぶ',
    'onboarding.step.workspace.blurb': 'エージェントが読み書きするフォルダです。あとから追加でき、チャットや調査だけなら無くても動きます。',
    'onboarding.step.ready': '準備完了',
    'onboarding.step.ready.blurb': 'できることをいくつか挙げます。設定はいつでも Settings から変えられます。',
    'onboarding.provider': 'プロバイダ',
    'onboarding.model': 'モデル名',
    'onboarding.apiKey': 'APIキー',
    'onboarding.keyless.hint': 'ローカル実行なのでAPIキーは不要です。先に Ollama を起動しておいてください。',
    'onboarding.test': '接続テスト',
    'onboarding.noWorkspace': 'まだ登録されていません。チャットや調査だけならこのままでも動きます。',
    'onboarding.rerun': '初期セットアップをやり直す',
    'onboarding.rerun.hint': '接続とワークスペースを3ステップで設定し直します。',
    'onboarding.open': '開く',
};
