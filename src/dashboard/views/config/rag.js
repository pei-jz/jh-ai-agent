// rag — the directory-tree rules behind the RAG Indexing picker.
//
// Small, but `descendantsOf` replaces the one piece of genuinely imperative DOM work
// left on that tab: unchecking a directory used to walk `.rag-dir-cb` and write
// `.checked` plus `parentElement.style.opacity` on every descendant input. The model
// and the checkboxes could therefore disagree, and the rule itself (what counts as a
// descendant, across mixed separators) was unverifiable.

/** File types the indexer offers. */
export const RAG_EXTENSIONS = [
    'js', 'jsx', 'ts', 'tsx', 'rs', 'java', 'py',
    'md', 'txt', 'html', 'css', 'json', 'xml',
];

/** How deep to indent a row. Counts separators, either flavour. */
export function dirDepth(dir) {
    return (String(dir || '').match(/[\\/]/g) || []).length;
}

/** The directory's own name, which is all the row needs to show. */
export function dirBasename(dir) {
    const s = String(dir || '').replace(/[\\/]+$/, '');
    return s.split(/[\\/]/).pop() || s;
}

/**
 * Every listed directory BENEATH `dir`.
 *
 * Uses the separator `dir` itself is written with, because a Windows path list mixes
 * them and a hardcoded '/' would silently match nothing. `dir` is not included in
 * the result — the caller usually wants it too and can prepend it, which keeps this
 * function honest about the name.
 */
export function descendantsOf(dir, all) {
    const parent = String(dir || '');
    if (!parent) return [];
    const sep = parent.includes('\\') ? '\\' : '/';
    const prefix = parent.endsWith(sep) ? parent : parent + sep;
    return (Array.isArray(all) ? all : []).filter(d => d !== parent && String(d).startsWith(prefix));
}
