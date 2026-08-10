# Third-party notices

J.H AI Agent is distributed under the MIT License (see `LICENSE`). It also includes
and redistributes third-party software. This file carries the notices those licences
require, and records the audit behind them.

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

### `public/tree-sitter/tree-sitter-{javascript,python,rust}.wasm`

Prebuilt grammars from [`tree-sitter-wasms`](https://github.com/Gregoor/tree-sitter-wasms),
which is released under the **Unlicense** (public domain dedication) and imposes no
conditions on redistribution.

The grammars those binaries were compiled from are separate upstream projects
(`tree-sitter/tree-sitter-javascript`, `tree-sitter/tree-sitter-python`,
`tree-sitter/tree-sitter-rust`), each MIT-licensed.

> **Open item before the first public release.** We have not reproduced those three
> grammars' own MIT notices here, because the packaging layer we obtained the binaries
> through does not carry them and we will not guess at copyright lines — a fabricated
> attribution is worse than a missing one. Copy the verbatim `LICENSE` from each
> upstream grammar repository into this section before publishing a build.

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

Audited 2026-08-09 against the current lockfiles.

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

No **GPL, AGPL, SSPL or CC-BY-SA** anywhere in the graph — those would be
incompatible with shipping this app under MIT, and their absence is the main thing
this audit was looking for.

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
