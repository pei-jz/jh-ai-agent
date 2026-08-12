// TreeSitterSymbols — an OPTIONAL, more accurate backend for SymbolIndex.
//
// SymbolIndex's regex passes are fast, dependency-free and always available.
// This module upgrades them where a real parse matters:
//
//   • nesting     — `Alpha.run` vs `Beta.run` are told apart via `parent`
//   • signatures  — multi-line declarations are captured whole
//   • no strings  — code inside a template literal is DATA in the syntax tree,
//                   so it can never be mistaken for a definition
//
// Availability is not assumed. The grammars are WASM (no C toolchain in the
// Tauri build), loaded lazily on first use; if anything fails — missing files,
// wasm disabled, ABI skew — `parseSymbols` returns null and the caller falls
// back to the regex extractor. The tool must never break because a parser
// could not load.
//
// ABI note: the prebuilt grammars in `tree-sitter-wasms` are built with the
// 0.20.x tree-sitter CLI, so `web-tree-sitter` is pinned to a matching runtime.
// A newer runtime fails with a dylink-metadata error at Language.load().

/** Language id (SymbolIndex's) → grammar wasm basename. */
const GRAMMARS = {
    js: 'tree-sitter-javascript',
    rust: 'tree-sitter-rust',
    python: 'tree-sitter-python',
    java: 'tree-sitter-java',
};

/**
 * Node types that declare something, per language:
 *   type → { kind, parentScope? }  parentScope=true means it becomes the
 *   enclosing container name for its descendants.
 */
const DECLS = {
    js: {
        class_declaration: { kind: 'class', scope: true },
        function_declaration: { kind: 'function' },
        generator_function_declaration: { kind: 'function' },
        method_definition: { kind: 'method' },
        // TS
        interface_declaration: { kind: 'interface', scope: true },
        type_alias_declaration: { kind: 'type' },
        enum_declaration: { kind: 'enum', scope: true },
    },
    rust: {
        function_item: { kind: 'function' },
        struct_item: { kind: 'struct', scope: true },
        enum_item: { kind: 'enum', scope: true },
        trait_item: { kind: 'trait', scope: true },
        impl_item: { kind: 'impl', scope: true },
        type_item: { kind: 'type' },
        mod_item: { kind: 'module', scope: true },
    },
    python: {
        function_definition: { kind: 'function' },
        class_definition: { kind: 'class', scope: true },
    },
    java: {
        class_declaration: { kind: 'class', scope: true },
        interface_declaration: { kind: 'interface', scope: true },
        enum_declaration: { kind: 'enum', scope: true },
        record_declaration: { kind: 'record', scope: true },
        annotation_type_declaration: { kind: 'annotation', scope: true },
        method_declaration: { kind: 'method' },
        constructor_declaration: { kind: 'constructor' },
    },
};

// web-tree-sitter's init() initialises a GLOBAL wasm runtime and is not safe to
// run twice in a process, so this promise deliberately survives reconfiguration.
// It is cleared only when it REJECTED, so a later configure can retry.
let _runtimeReady = null;
let _unavailable = false;  // set once loading has definitively failed
const _languages = new Map();   // lang id → loaded Language

/**
 * Resolve where the wasm files live. Injected by the caller so this module has
 * no opinion about bundling: the app passes a URL base (assets are served by
 * the webview), tests pass a filesystem directory.
 */
let _wasmBase = null;
let _runtimeLoader = null;
let _initOptions = null;

/**
 * Configure the backend. Must be called before `parseSymbols` for the parser to
 * be usable; without it the backend stays unavailable and callers fall back.
 * @param {{wasmBase: string, loadRuntime: () => Promise<any>}} opts
 *   wasmBase     directory/URL prefix holding tree-sitter-*.wasm
 *   loadRuntime  returns the web-tree-sitter module (import or require)
 */
export function configureTreeSitter({ wasmBase, loadRuntime, initOptions = null }) {
    _wasmBase = wasmBase;
    _runtimeLoader = loadRuntime;
    _initOptions = initOptions;
    _unavailable = false;
    _languages.clear();
    // _runtimeReady is intentionally NOT cleared on success — see its comment.
}

/** True when a previous load attempt failed and we've stopped retrying. */
export function isUnavailable() {
    return _unavailable;
}

async function getParserFor(lang) {
    if (_unavailable || !_wasmBase || !_runtimeLoader) return null;
    const grammar = GRAMMARS[lang];
    if (!grammar) return null;

    if (!_runtimeReady) {
        const loader = _runtimeLoader;
        _runtimeReady = (async () => {
            const TreeSitter = await loader();
            // In a webview the runtime must be told where tree-sitter.wasm is
            // served from; in Node it resolves relative to the package.
            await (_initOptions ? TreeSitter.init(_initOptions) : TreeSitter.init());
            return TreeSitter;
        })();
    }

    let TreeSitter;
    try {
        TreeSitter = await _runtimeReady;
    } catch (_) {
        // Init failed — allow a retry after the next configure, and stop trying
        // until then so every call doesn't pay the failure cost.
        _runtimeReady = null;
        _unavailable = true;
        return null;   // runtime unusable — caller falls back
    }

    if (!_languages.has(lang)) {
        try {
            const loaded = await TreeSitter.Language.load(`${_wasmBase}${grammar}.wasm`);
            _languages.set(lang, loaded);
        } catch (_) {
            // One grammar missing shouldn't disable the others.
            _languages.set(lang, null);
        }
    }
    const language = _languages.get(lang);
    if (!language) return null;

    const parser = new TreeSitter();
    parser.setLanguage(language);
    return parser;
}

/** Name of a declaration node, via the grammar's `name` field where present. */
function declName(node) {
    const named = node.childForFieldName?.('name');
    if (named?.text) return named.text;
    // Rust `impl Trait for Type` exposes the type under `type`.
    const typed = node.childForFieldName?.('type');
    if (typed?.text) return typed.text;
    return '';
}

/** First line of the declaration, whitespace-collapsed, up to its body. */
function declSignature(node, source) {
    const body = node.childForFieldName?.('body');
    const end = body ? body.startIndex : Math.min(node.endIndex, node.startIndex + 300);
    return source.slice(node.startIndex, end).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Parse definitions out of source text.
 * @param {string} path used for the returned location (language comes from `lang`)
 * @param {string} content source text
 * @param {string} lang SymbolIndex language id ('js' | 'rust' | 'python' | 'java')
 * @returns {Promise<Array|null>} symbols, or null when the backend is unavailable
 */
export async function parseSymbols(path, content, lang) {
    if (typeof content !== 'string' || !content) return null;
    const decls = DECLS[lang];
    if (!decls) return null;

    let parser;
    try {
        parser = await getParserFor(lang);
    } catch (_) {
        return null;
    }
    if (!parser) return null;

    let tree;
    try {
        tree = parser.parse(content);
    } catch (_) {
        return null;
    }
    if (!tree?.rootNode) return null;

    const out = [];
    const visit = (node, scope) => {
        let nextScope = scope;
        const decl = decls[node.type];
        if (decl) {
            const name = declName(node);
            if (name) {
                out.push({
                    name,
                    kind: decl.kind,
                    line: node.startPosition.row + 1,
                    path,
                    signature: declSignature(node, content),
                    exported: isExported(node, content, lang),
                    parent: scope || null,
                });
                if (decl.scope) nextScope = name;
            }
        }
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) visit(child, nextScope);
        }
    };
    visit(tree.rootNode, null);
    try { tree.delete?.(); } catch (_) { /* older runtimes free automatically */ }
    return out;
}

/** Whether a declaration is publicly visible (export / pub). */
function isExported(node, source, lang) {
    if (lang === 'rust') {
        return /^\s*pub\b/.test(source.slice(node.startIndex, node.startIndex + 40));
    }
    if (lang === 'js') {
        // The grammar wraps exported declarations in export_statement.
        let p = node.parent;
        while (p) {
            if (p.type === 'export_statement') return true;
            p = p.parent;
        }
        return false;
    }
    if (lang === 'java') {
        // `public` is a modifier on the declaration itself. Annotations can come
        // first (`@Override public void run()`), so allow them before it.
        const head = source.slice(node.startIndex, node.startIndex + 160);
        return /^\s*(?:@\w+(?:\([^)]*\))?\s+)*public\b/.test(head);
    }
    return false;   // Python has no export marker
}
