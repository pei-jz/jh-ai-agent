# Third-party notices

J.H AI Agent is distributed under `MIT OR Apache-2.0` (see `LICENSE`). It also
includes and redistributes third-party software, which keeps its own licences. This
file carries the notices those licences require, and records the audit behind them.

**Why this file exists in the repository root:** MIT, BSD and Apache-2.0 all permit
redistribution *on the condition that* the copyright and permission notices travel
with the copies. That condition applies to a compiled binary too — a `.wasm` file
carries no notice of its own, so if the notice is not written down somewhere, shipping
it is a licence violation regardless of intent.

Anyone cutting a release must include this file with the distribution.

---

## 1. Files redistributed verbatim in this repository

These are the only third-party artifacts committed here. Everything else is fetched
by `npm install` / `cargo build` and is not redistributed by us.

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

## 2. Dependency licence audit

Audited 2026-08-09 against the current lockfiles; the tree-sitter entries were
re-verified and the Java grammar added 2026-08-10.

### npm (runtime dependencies)

| Package | Licence |
|---|---|
| `@tauri-apps/api` | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-process` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-shell` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-updater` | MIT OR Apache-2.0 |
| `jsonrepair` | ISC |
| `tree-sitter-wasms` | Unlicense |
| `web-tree-sitter` | MIT |

All permissive. No copyleft.

### Rust (698 crates, including transitive)

No **GPL, AGPL, SSPL or CC-BY-SA** anywhere in the graph — a single one of those
would make it impossible to ship this app under `MIT OR Apache-2.0`, and their
absence is the main thing this audit was looking for.

Worth knowing about, none of them a problem:

- **MPL-2.0** (`cssparser`, `cssparser-macros`, `dtoa-short`, `selectors`,
  `option-ext`) — file-level copyleft. It permits use in a larger work under a
  different licence; the obligation is only to publish changes *to those files*. We
  do not modify them. **If that ever changes, the modified files must be published.**
- **Unicode-3.0** (the 18 ICU crates) — permissive, requires the notice be kept.
- **CDLA-Permissive-2.0** (`webpki-roots`, `webpki-root-certs`) — permissive data
  licence covering the bundled CA root set.
- **`r-efi`** — offered as `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; we take MIT.
  The LGPL option is one choice among three, not an obligation.

The rest are MIT / Apache-2.0 / BSD / ISC / Zlib / Unlicense dual- or
single-licensed.

### Reproducing this audit

```bash
npx license-checker --production --summary
```

```bash
cargo metadata --format-version 1 --all-features
```

Read the `license` field of each package in the `cargo metadata` output; grep it for
`GPL`, `SSPL` and `CC-BY-SA`.

---

## 3. What is *not* redistributed

- Node and Rust dependencies resolved at build time — the user's own toolchain
  fetches these under their own licences.
- Model weights or provider SDKs. The app talks to LLM providers over HTTP; nothing
  from OpenAI, Anthropic, DeepSeek, Ollama or any other provider is bundled.
