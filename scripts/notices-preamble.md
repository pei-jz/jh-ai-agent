# Third-party notices

J.H AI Agent is distributed under `MIT OR Apache-2.0` (see `LICENSE`). It also
includes and redistributes third-party software, which keeps its own licences. This
file carries the notices those licences require.

**Why the notices and not just the licence names.** MIT, BSD and Apache-2.0 permit
redistribution *on the condition that* the copyright notice and permission text
travel with the copies. A table of licence names does not satisfy that — the text
itself has to be present. It applies to a compiled binary exactly as it does to
source: the person who receives the installer never sees this repository.

**This file is generated.** Sections 3 and 4 are produced by
`scripts/make-third-party-notices.mjs` from the dependency graphs themselves, because
a hand-written list goes stale on the next `npm install` and a stale notice is not a
notice. Sections 1 and 2 are hand-written in `scripts/notices-preamble.md`; edit
that, never this file.

```bash
npm run notices
```

---

## 1. Files redistributed verbatim in this repository

These are the third-party artifacts committed to this repository. They are listed
separately from the dependency sections below because nothing can derive them: the
provenance of a prebuilt `.wasm` is not recorded anywhere a tool can read, so it was
established by hand and is kept by hand.

### `public/tree-sitter/tree-sitter.wasm`

The tree-sitter runtime, taken from the [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter)
npm package.

> The MIT License (MIT)
>
> Copyright (c) 2018-2021 Max Brunsfeld
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### `public/tree-sitter/tree-sitter-{javascript,python,rust,java}.wasm`

Prebuilt grammars from [`tree-sitter-wasms`](https://github.com/Gregoor/tree-sitter-wasms)
`@0.1.13`, which is released under the **Unlicense** (public domain dedication) and
imposes no conditions of its own. That does not settle the question: a packager cannot
relicense the code it compiled, so the grammars' own MIT terms still apply to these
binaries.

The grammars are four separate upstream projects, each MIT-licensed and **each with a
different copyright holder** — which is precisely why none was written from memory:

| Binary | Compiled from | Copyright |
|---|---|---|
| `tree-sitter-javascript.wasm` | [`tree-sitter-javascript`](https://github.com/tree-sitter/tree-sitter-javascript)`@0.20.3` | Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-python.wasm` | [`tree-sitter-python`](https://github.com/tree-sitter/tree-sitter-python)`@0.21.0` | Copyright (c) 2016 Max Brunsfeld |
| `tree-sitter-rust.wasm` | [`tree-sitter-rust`](https://github.com/tree-sitter/tree-sitter-rust)`@0.20.4` | Copyright (c) 2017 **Maxim Sokolov** |
| `tree-sitter-java.wasm` | [`tree-sitter-java`](https://github.com/tree-sitter/tree-sitter-java)`@0.20.2` | Copyright (c) 2017 **Ayman Nadeem** |

Three different holders across four repositories in the same GitHub organisation. A
plausible-looking guess would have been wrong twice.

The MIT permission and warranty text is byte-identical across all four (and identical
to web-tree-sitter's, quoted above) — verified by hashing the files, not assumed — so
it is reproduced once in `public/tree-sitter/LICENSE` and applies to each holder named
there. Only the title lines differ.

**Where the versions come from.** `tree-sitter-wasms@0.1.13`'s own `package.json`
pins the grammars it builds from: `tree-sitter-javascript: ^0.20.3`,
`tree-sitter-python: ^0.21.0`, `tree-sitter-rust: ^0.20.4`, `tree-sitter-java: ^0.20.2`.
Those are the versions transcribed above. The published package ships only `/out`, so
the exact resolved patch versions are not recorded upstream; the copyright lines are
unchanged across those ranges, so the attribution holds regardless.

**How this was obtained, and how to re-verify.** Each notice was read out of the
published package's own `LICENSE` — not from a web page, not reconstructed:

```bash
npm pack tree-sitter-rust@0.20.4 --pack-destination /tmp && tar -xzOf /tmp/tree-sitter-rust-0.20.4.tgz package/LICENSE
```

`npm pack` fetches the tarball without running install scripts, so this needs no
native toolchain despite these being node-gyp packages. Transcribed 2026-08-10.

**When this needs redoing:** only if a language is added to `GRAMMARS` in
`src/modules/ai/tools/TreeSitterSymbols.js`, or if the pinned grammar versions change.
Neither happens on its own.

### `.proto_include/google/protobuf/*.proto`

Google's standard Protocol Buffers definitions, **BSD-3-Clause**, vendored because
prost-based Rust crates cannot build without them. Every file retains its original
copyright header in full, which satisfies the source-form condition; BSD-3-Clause
additionally requires the notice to be reproduced "in the documentation and/or other
materials" for binary redistribution, which is what this entry is for.

> Copyright 2008 Google Inc. All rights reserved.
> Licensed under the 3-clause BSD licence; the full text is in the header of each
> `.proto` file in that directory.

---

### Inter (`node_modules/@fontsource/inter/files/inter-latin-{300,400,500,600,700,800}-normal.woff2`)

UI 本文の書体。ビルド時に `dist/assets/` へコピーされ、**インストーラに同梱されます**。

- **上流**: https://github.com/rsms/inter （配布パッケージは
  https://github.com/fontsource/fontsource の `@fontsource/inter`）
- **ライセンス**: SIL Open Font License 1.1
- **著作権**: Copyright 2016 The Inter Project Authors
- **全文**: `node_modules/@fontsource/inter/LICENSE`（パッケージに同梱）

**なぜ同梱するのか。** 以前は `fonts.googleapis.com` から取得していました。これは
起動のたびに第三者へのリクエストが出るうえ、**レンダーをブロックする**ため、
オフラインのマシンではタイムアウトするまで画面が空のままになります。この製品は
オフラインで使われることを前提にしているので、同梱が正しい形です。

**latin サブセットのみ・6ウェイト**（約145KB）です。全サブセットは約1.4MBあり、
Inter には仮名も漢字も含まれないため、日本語は `--font-sans` のフォールバック
（Segoe UI / Hiragino など、プラットフォームの UI 書体）が描画します — これは
Google から取得していた頃も同じでした。

OFL 1.1 は、フォントを**単体で販売しない限り**、アプリケーションへの同梱・改変・
再配布を許可します。義務は著作権表示とライセンス全文の添付で、この節がそれです。

---

## 2. What ships inside the installer

Rust crates are COMPILED INTO the shipped binary, so a built installer *is* a
redistribution of them — and MIT / BSD / Apache-2.0 all require the copyright
notice to travel with it. Source-tree files alone do not satisfy that: the person
who receives the `.msi` never sees this repository.

`bundle.resources` in `src-tauri/tauri.conf.json` therefore ships four files
alongside the executable, in the app's resource directory:

| File | Why it must be there |
|---|---|
| `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE` | Our own terms — the recipient's grant |
| `THIRD-PARTY-NOTICES.md` | This audit, i.e. the dependencies' required notices |

(`public/tree-sitter/LICENSE` reaches the installer by a different route: it is a
static asset, so Vite copies it into `dist/`, which is bundled as the frontend.)

Inter ships the same way and needs the same treatment: the woff2 files are
emitted into `dist/assets/`, so the OFL text has to travel with them. It is
tracked at `licenses/OFL-Inter.txt` and listed in `bundle.resources`.

**If you add a dependency, re-run `npm run notices` — the obligation travels with
the binary, not with the repo.**

---

{{GENERATED}}

## 5. What is *not* redistributed

- **Build-time-only dependencies** — Vite, Svelte, vitest and the rest of
  `devDependencies` produce the build but are not part of it, so their notices are
  not required here.
- **Model weights and provider SDKs.** The app talks to LLM providers over HTTP;
  nothing from OpenAI, Anthropic, DeepSeek, Ollama or any other provider is bundled.
