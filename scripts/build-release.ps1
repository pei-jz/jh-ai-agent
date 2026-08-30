<#
.SYNOPSIS
    署名付きのリリースビルドを作り、latest.json とポータブル版まで用意する。

.DESCRIPTION
    署名鍵とパスフレーズを受け取り、環境変数へ入れてビルドし、終わったら消す。
    鍵はファイルからもその場の入力からも渡せる。

    鍵の扱いについて:
      - パスフレーズはパラメータにしていない。コマンドラインに書けると
        PowerShell の履歴 (ConsoleHost_history.txt) に平文で残る。入力は毎回
        SecureString で受ける。
      - 環境変数はこのプロセスにしか置かず、finally で必ず消す。手順書にあった
        「シェルを閉じるまで残る」状態を作らない。
      - 鍵の内容はどこにも出力しない。エラーメッセージにも載せない。

    鍵とパスフレーズの両方を失うと、公開済みの全インストールが更新経路を永久に
    失う。復旧手段は無い。両方を別々に控えておくこと。

.PARAMETER KeyPath
    署名鍵ファイルのパス。省略すると対話で聞く。パスは秘密ではないので
    パラメータで渡してよい。

.PARAMETER SkipTests
    テストを飛ばす。急いで手元の確認をしたいときだけ。リリース用のビルドでは
    使わない。

.EXAMPLE
    .\scripts\build-release.ps1 -KeyPath ~\.tauri\jh-ai-agent.key

.EXAMPLE
    .\scripts\build-release.ps1
    # 鍵のパス、または内容 (base64 1 行) を聞かれる
#>

[CmdletBinding()]
param(
    [string] $KeyPath,
    [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    警告 $msg" -ForegroundColor Yellow }

function Fail($msg) {
    Write-Host "`nerror: $msg" -ForegroundColor Red
    exit 1
}

# SecureString を平文へ。使い終わったらすぐ捨てる前提で呼ぶ。
function ConvertFrom-SecureStringPlain([System.Security.SecureString] $s) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        # BSTR を確保したまま放置しない。
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

# ------------------------------------------------------------ 事前確認

Write-Step '事前確認'

foreach ($cmd in @('node', 'npm', 'cargo')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Fail "$cmd が見つからない"
    }
}
Write-Ok 'node / npm / cargo あり'

$conf = Get-Content (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
Write-Ok "バージョン $version"

# 版がずれたまま出すと、アプリの表示と配布物とタグが食い違う。3 箇所ある。
$pkg = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
if ($pkg.version -ne $version) {
    Fail "package.json ($($pkg.version)) と tauri.conf.json ($version) の版が違う"
}
$cargoToml = Get-Content (Join-Path $repo 'src-tauri\Cargo.toml') -Raw
if ($cargoToml -notmatch "(?m)^version\s*=\s*""$([regex]::Escape($version))""") {
    Fail "Cargo.toml の版が tauri.conf.json ($version) と違う"
}
Write-Ok '3 箇所の版が一致'

Push-Location $repo
try {
    # 設定の不整合。とくに「公開鍵あり + createUpdaterArtifacts:false」は
    # ビルドが成功して .sig だけ出ない、唯一エラーにならない組み合わせ。
    Write-Step 'リリース設定の検査'
    npm run release:preflight
    if ($LASTEXITCODE -ne 0) { Fail 'release:preflight が問題を検出した' }

    # 第三者ライセンス表記が依存グラフと合っているか。依存を足したあと再生成を
    # 忘れると、表記が実際の同梱物と食い違ったまま配ることになる。誰も気づか
    # ないので、ここで止める。
    Write-Step '第三者ライセンス表記の確認'
    node scripts/make-third-party-notices.mjs --check
    if ($LASTEXITCODE -ne 0) { Fail 'THIRD-PARTY-NOTICES.md が古い。npm run notices を実行してコミットする' }
    Write-Ok '依存グラフと一致'

    $dirty = git status --porcelain
    if ($dirty) {
        Write-Warn '作業ツリーに未コミットの変更がある:'
        $dirty -split "`n" | Select-Object -First 10 | ForEach-Object { Write-Warn "  $_" }
        Write-Warn 'この状態で作った成果物は、あとからどのコードのものか辿れない'
        $ans = Read-Host '    このまま続けるか (y/N)'
        if ($ans -ne 'y') { Fail '中止した' }
    } else {
        Write-Ok '作業ツリーは清潔'
    }
} finally {
    Pop-Location
}

# ------------------------------------------------------------ 鍵の入力

Write-Step '署名鍵'

$keyValue = $null

if (-not $KeyPath) {
    Write-Host '    鍵ファイルのパス、または鍵の内容 (base64 1 行) を入力する。'
    Write-Host '    入力は表示されない。' -ForegroundColor DarkGray
    $secure = Read-Host '    鍵' -AsSecureString
    $entered = ConvertFrom-SecureStringPlain $secure
    if (-not $entered) { Fail '鍵が入力されなかった' }

    # パスとして解決できるならファイル、できないなら内容そのもの。
    $asPath = $null
    try { $asPath = Resolve-Path -LiteralPath $entered -ErrorAction SilentlyContinue } catch { }
    if ($asPath) {
        $KeyPath = $asPath.Path
    } else {
        $keyValue = $entered
        Write-Ok '入力された内容を鍵として使う'
    }
    $entered = $null
}

if ($KeyPath) {
    $resolved = Resolve-Path -LiteralPath $KeyPath -ErrorAction SilentlyContinue
    if (-not $resolved) { Fail "鍵ファイルが見つからない: $KeyPath" }
    $keyValue = Get-Content -LiteralPath $resolved.Path -Raw
    if (-not $keyValue) { Fail "鍵ファイルが空: $($resolved.Path)" }
    Write-Ok "鍵を読み込んだ: $($resolved.Path)"

    # リポジトリの中に鍵を置いていないか。.gitignore で拾ってはいるが、
    # ここで気づけるなら早いほうがよい。
    if ($resolved.Path.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Warn "鍵がリポジトリ内にある: $($resolved.Path)"
        Write-Warn 'リポジトリの外 (~\.tauri\ など) へ移すこと'
    }
}

# 取り違えを早めに弾く。公開鍵を渡してもビルドは進み、署名だけが静かに失敗する。
if ($keyValue -match 'minisign public key') {
    Fail '公開鍵が渡されている。署名には秘密鍵が要る'
}

Write-Host '    パスフレーズを入力する (鍵に設定していなければ空のまま Enter)。'
$securePass = Read-Host '    パスフレーズ' -AsSecureString
$passValue = ConvertFrom-SecureStringPlain $securePass

# ------------------------------------------------------------ ビルド

# 前回の成果物を消しておく。残っていると、bundle\ の中に「もう作られない
# はずの形式」や前の版が同居し、アップロードのときに人が選ぶことになる。
# 取り違えてもビルドは通りリリースも通るので、気づくのは更新が届かないと
# 言われたときになる。
$bundle = Join-Path $repo 'src-tauri\target\release\bundle'
if (Test-Path $bundle) {
    Write-Step '前回の成果物を消す'
    Remove-Item $bundle -Recurse -Force
    Write-Ok $bundle
}

$exitCode = 0
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = $keyValue
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $passValue

    Push-Location $repo
    try {
        if (-not $SkipTests) {
            Write-Step 'テスト (JS)'
            npm test
            if ($LASTEXITCODE -ne 0) { Fail 'JS のテストが落ちた' }
            Write-Ok '通過'

            Write-Step 'テスト (Rust)'
            cargo test --manifest-path src-tauri/Cargo.toml --lib
            if ($LASTEXITCODE -ne 0) { Fail 'Rust のテストが落ちた' }
            Write-Ok '通過'
        } else {
            Write-Warn 'テストを飛ばした'
        }

        Write-Step 'ビルド (数分かかる)'
        npm run tauri build
        if ($LASTEXITCODE -ne 0) { Fail 'ビルドが落ちた' }
        Write-Ok '完了'

        Write-Step 'latest.json の生成と成果物の名前揃え'
        node scripts/make-latest-json.mjs
        if ($LASTEXITCODE -ne 0) { Fail 'latest.json を作れなかった' }

        Write-Step 'ポータブル版'
        node scripts/make-portable.mjs
        if ($LASTEXITCODE -ne 0) { Fail 'ポータブル版を作れなかった' }
    } finally {
        Pop-Location
    }
} catch {
    Write-Host "`nerror: $_" -ForegroundColor Red
    $exitCode = 1
} finally {
    # ここは必ず通す。ビルドが落ちても鍵を環境に残さない。
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    $keyValue = $null
    $passValue = $null
    [GC]::Collect()
}

if ($exitCode -ne 0) { exit $exitCode }

# ------------------------------------------------------------ 結果

$nsis = Join-Path $bundle 'nsis'
$installer = Get-ChildItem $nsis -Filter '*-setup.exe' | Select-Object -First 1
$manifest = Join-Path $bundle 'latest.json'
$portable = Get-ChildItem (Join-Path $bundle 'portable') -Filter '*-portable.zip' -ErrorAction SilentlyContinue |
    Select-Object -First 1

if (-not $installer) { Fail 'インストーラが見つからない' }
if (-not (Test-Path $manifest)) { Fail 'latest.json が見つからない' }
if (-not (Test-Path "$($installer.FullName).sig")) {
    Fail '署名 (.sig) が無い。鍵が効いていない'
}

Write-Step '成果物'
foreach ($f in @($installer.FullName, "$($installer.FullName).sig", $manifest)) {
    Write-Host "    $f"
}
if ($portable) { Write-Host "    $($portable.FullName)" }

Write-Host ''
Write-Host ('    インストーラ {0:N0} bytes' -f $installer.Length) -ForegroundColor DarkGray
Write-Host ('    SHA-256      {0}' -f (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLower()) -ForegroundColor DarkGray

Write-Step '次にすること'
Write-Host '    1. インストーラを実際に走らせて確認する (docs/RELEASING.md の 6)'
Write-Host '       ライセンス承諾画面 / 導入先の選択 / アンインストールでレジストリが消えること'
Write-Host '    2. ポータブル版を展開して、更新欄が「自動更新できません」になること'
Write-Host '    3. 問題なければ公開する:'
Write-Host ('       .\scripts\publish-release.ps1 -Tag v{0}' -f $version) -ForegroundColor White
