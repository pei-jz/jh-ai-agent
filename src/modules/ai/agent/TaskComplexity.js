// TaskComplexity — should this request go through the plan-first gate?
//
// The gate is worth it for genuinely multi-step change: a plan catches a wrong
// approach before files get edited. It is pure friction everywhere else, and the
// previous heuristic fired almost always on Japanese input — "…対応お願いします"
// over 60 characters, or ANY Japanese request over 120 characters, counted as
// complex. Two or three polite sentences was enough. That is what made the agent
// feel like it plans everything.
//
// So: judge complexity by STRUCTURE (enumerated steps, many files, explicit
// sequencing, sweeping scope), not by length or by verbs that appear in every
// courteous request. And never gate work that isn't going to change anything.
//
// Pure: string in → boolean out.

/** Requests that only look at things: research, reports, questions, reviews. */
const READ_ONLY_PATTERNS = [
    // Japanese: investigate / explain / summarize / evaluate / report / check
    /調べ|調査|教えて|説明して|要約|まとめて(?!ください.*実装)|分析|評価|レビュー|確認して|洗い出/,
    /レポート|報告|一覧(?:化)?して|比較して|提案して/,
    // A question, not an instruction. `ますか` is in because Japanese asks
    // "…できますか / …ありますか" as often as "…ですか", frequently with no
    // question mark — and without it "java LSP はどこでダウンロードできますか"
    // read as an instruction. The explicit-edit guard in looksReadOnly runs
    // FIRST, so "実装してもらえますか" is still a change request.
    /(?:ですか|ますか|でしょうか|かな)[?？]?\s*$/,
    /[?？]\s*$/,
    // English
    /\b(?:investigate|analy[sz]e|explain|summari[sz]e|review|report|compare|research|audit|assess)\b/i,
    /^\s*(?:what|why|how|when|where|which|who|is|are|does|do|can|should)\b/i,
];

/** Explicit enumeration — an itemised request is multi-step by construction. */
const ENUMERATED = [
    /(?:^|\n)\s*[1-9]\d*[.)]\s/m,     // 1. / 2)
    /[①②③④⑤⑥⑦⑧⑨]/,                  // ①②③
    /(?:^|\n)\s*[-*]\s+.+(?:\n\s*[-*]\s+.+){2,}/m,  // a bullet list of 3+
];

/** Sequencing language — "first … then …" describes a multi-stage job. */
const SEQUENCED = [
    /まず[\s\S]{0,200}(?:次に|その後|そのあと|最後に)/,
    /\bfirst\b[\s\S]{0,200}\b(?:then|after that|finally)\b/i,
];

/** Sweeping scope — the change is broad even if the sentence is short. */
const BROAD_SCOPE = [
    /リファクタ|再設計|作り直|全面|全体的|アーキテクチャ|移行|マイグレ|置き換え|分割|統合/,
    /\b(?:refactor|redesign|rewrite|migrate|restructure|overhaul|consolidate)\b/i,
];

/** Distinct source files named in the prompt. */
function fileMentions(p) {
    const m = p.match(/\b[\w][\w/-]*\.(?:js|ts|jsx|tsx|py|rs|go|java|vue|svelte|css|scss|html|json|md|rb|php|kt)\b/gi) || [];
    return new Set(m.map(f => f.toLowerCase()));
}

/**
 * True when the request is about producing an ANSWER rather than a change.
 * Such a task has nothing to plan — there are no files to list and no tests to
 * describe — so the plan gate only adds a round trip.
 */
export function looksReadOnly(prompt) {
    const p = String(prompt || '').trim();
    if (!p) return false;
    // An explicit edit instruction wins even if the text also asks a question
    // ("調べて修正して" is a change request).
    if (/実装して|修正して|直して|追加して|書き換え|削除して|作成して|\b(?:implement|fix|add|write|create|delete|edit)\b/i.test(p)
        && !/(?:調べ|調査|評価|レビュー)(?:だけ|のみ)/.test(p)) {
        return false;
    }
    return READ_ONLY_PATTERNS.some(re => re.test(p));
}

/**
 * True when the request is genuinely multi-step change work.
 * Deliberately conservative: a false positive costs the user an extra
 * approval round trip on every ordinary request.
 */
export function looksComplex(prompt) {
    const p = String(prompt || '').trim();
    if (!p) return false;

    // Structure beats length.
    if (ENUMERATED.some(re => re.test(p))) return true;
    if (SEQUENCED.some(re => re.test(p))) return true;
    if (fileMentions(p).size >= 3) return true;

    // Sweeping scope is a strong signal on its own — "リファクタリングして" is
    // inherently multi-step at 10 characters, so gating it on length only broke
    // Japanese (which says the same thing in a third of the characters). Only a
    // negation ("refactor は不要") disqualifies it.
    const negated = /(?:不要|しないで|なしで|せずに)\s*$|without|no need to/i.test(p);
    if (!negated && BROAD_SCOPE.some(re => re.test(p))) return true;

    // Very long, detailed instructions. The old thresholds (60 chars of Japanese
    // with a common verb, or 120 chars of any Japanese) matched normal prose, so
    // these are set where a request really is a specification.
    if (p.length > 400) return true;
    if (p.split(/\s+/).length > 120) return true;

    return false;
}

/**
 * Final answer for the plan-first gate: plan only for multi-step CHANGE work.
 * @param {string} prompt
 * @returns {boolean}
 */
export function shouldPlanFirst(prompt) {
    return looksComplex(prompt) && !looksReadOnly(prompt);
}
