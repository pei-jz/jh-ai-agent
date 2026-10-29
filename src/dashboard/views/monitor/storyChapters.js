// storyChapters — the Story tab's reading of a run: CHAPTERS, not steps.
//
// The Story and the Raw Log used to show the same thing at the same grain: one
// framed card per reasoning step, with its tool calls nested inside. Two tabs
// that differ only in styling are one tab too many, and the step grain is the
// wrong one for reading — a run is "looked into X, decided Y, changed Z,
// checked it", not "step 01 … step 37".
//
// This turns the run's WORKING (reasoning groups, bare lines, narration, live
// command output) into chapters by what the actions DID:
//
//   investigate  read / searched / ran a read-only command
//   change       wrote, moved, deleted, ran a command that changes things
//   verify       tested / built / linted / syntax-checked
//   loop         change ↔ verify round trips, folded into one chapter
//   think        reasoning with no action at all
//
// Requests, questions, approvals and results are not working; they pass
// through untouched and close the chapter before them.
//
// Two merge rules keep a busy run from turning back into a column of cards:
//   • a small look (≤2 reads, nothing else) right before a change is part of
//     the change ("checked, then changed");
//   • change → verify → change … is ONE "fix and verify" chapter.
//
// A command's chapter comes from its ROLE, not from being a command: `git grep`
// is investigating, `npm test` is verifying, `npm install` is changing. A
// command it cannot place joins the chapter it is in.
//
// PURE: items in, items out. The raw steps stay on each chapter (`trace`) for
// the reader who opens it; the Raw Log tab remains the full record.

const READ_TOOLS = new Set(['read_file', 'read_office', 'read_many', 'read_resource', 'fetch_url']);
const SEARCH_TOOLS = new Set(['grep_search', 'symbol_search', 'web_search', 'list_files', 'glob']);
const WRITE_TOOLS = new Set([
    'write_file', 'replace_lines', 'apply_patch', 'multi_replace_file_content',
    'delete_file', 'move_file', 'write_xlsx',
]);
const CHECK_TOOLS = new Set(['verify_syntax']);

// `(?!-)`: PowerShell's Test-Path / Build-… are cmdlets, not a test run.
const VERIFY_CMD = /\b(test|tests|vitest|jest|pytest|mocha|tsc|eslint|lint|build|check|clippy|vet|typecheck)\b(?!-)|node\s+--check|\b(cargo|go|dotnet|mvn|gradle|make)\b/i;
const CHANGE_CMD = /\b(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall|update)\b|\bpip\s+install\b|\bgit\s+(mv|rm|add|commit|checkout|switch|apply|reset|restore|stash|merge|rebase)\b|\bsed\s+-i\b|(^|[;&|]\s*)(mv|cp|rm|mkdir|rmdir|touch)\s|\b(New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Content|Add-Content|Out-File)\b/i;
const READ_CMD = /\bgit\s+(grep|log|show|diff|status|blame|ls-files)\b|(^|[;&|]\s*)(grep|rg|findstr|ls|dir|cat|type|head|tail|find|where|which|wc|tree|stat|file)\b|\b(Get-Content|Get-ChildItem|Select-String|Get-Item|Test-Path)\b/i;

/**
 * What a shell command is FOR, or null when it cannot be told.
 *
 * Verify is tested first: `npm run build` must not read as a change because
 * npm can also install. Change before read: `cat a > b` is not looking.
 */
export function commandRole(command) {
    const c = String(command || '').trim();
    if (!c) return null;
    if (VERIFY_CMD.test(c)) return 'verify';
    if (CHANGE_CMD.test(c) || /(^|[^>2])>>?\s*\S/.test(c)) return 'change';
    if (READ_CMD.test(c)) return 'investigate';
    return null;
}

/** The command of a run_command line: its own field, else the line's text. */
function commandOf(line) {
    if (line.command) return String(line.command);
    const m = String(line.text || '').match(/run_command:\s*(.*)$/);
    return m ? m[1].trim() : '';
}

/**
 * One feed line → what it did.
 * @returns {{role:string|null, act:string}|null} null for a line that is not an action
 */
export function lineAction(line = {}) {
    const tool = line.tool;
    // A tool line with no structured target (an older log, a status echo) is
    // still an action — dropping it lost the line from the Story entirely.
    if (!tool) return (line.type === 'tool' || line.type === 'error') ? { role: null, act: 'other' } : null;
    // A reviewing sub-agent's reads are checking someone else's work, not
    // looking into the task — they belong to "verified". Tested first, so a
    // reviewer's read_file is not filed as an ordinary read.
    if (REVIEW_SUB.test(String(line.text || ''))) {
        const act = READ_TOOLS.has(tool) ? 'read' : SEARCH_TOOLS.has(tool) ? 'search' : 'other';
        return { role: 'verify', act };
    }
    if (READ_TOOLS.has(tool)) return { role: 'investigate', act: 'read' };
    if (SEARCH_TOOLS.has(tool)) return { role: 'investigate', act: 'search' };
    if (WRITE_TOOLS.has(tool) || line.write) return { role: 'change', act: 'write' };
    if (CHECK_TOOLS.has(tool)) return { role: 'verify', act: 'check' };
    if (tool === 'run_command') return { role: commandRole(commandOf(line)), act: 'command' };
    // An app's own tools (MCP: create_deck, write_deck, audit_deck …) say what
    // they do in their verb. Without this every one of them joined whatever
    // chapter was open, so a whole deck build sat under "検証" while the
    // checklist above it ticked through four different phases.
    const role = toolVerbRole(tool);
    if (role) return { role, act: 'tool' };
    // ask_user / present_result / task_progress / run_subtask …: real, but not
    // a phase of their own. They join whatever chapter they land in.
    return { role: null, act: 'other' };
}

const CHANGE_VERBS = new Set(['create', 'write', 'update', 'add', 'delete', 'remove', 'replace', 'set',
    'save', 'repair', 'upgrade', 'restore', 'insert', 'edit', 'apply', 'move', 'rename', 'export',
    'upload', 'commit', 'patch', 'append', 'generate', 'build', 'make']);
const VERIFY_VERBS = new Set(['audit', 'verify', 'check', 'validate', 'test', 'screenshot', 'lint',
    'review', 'inspect', 'preview']);
const READ_VERBS = new Set(['read', 'get', 'list', 'search', 'find', 'fetch', 'open', 'query',
    'describe', 'show', 'load', 'lookup', 'browse', 'view', 'inspect']);
/** Tools that are the agent's own bookkeeping, not work. */
const BOOKKEEPING = new Set(['ask_user', 'present_result', 'task_progress', 'finish_task', 'run_subtask']);

/** A tool's role from its leading verb, or null. `mcp__srv__write_deck` → change. */
export function toolVerbRole(tool) {
    const name = String(tool || '').split(/__|[.:/]/).pop();
    if (!name || BOOKKEEPING.has(name)) return null;
    const verb = name.split(/[_-]/)[0].toLowerCase();
    if (VERIFY_VERBS.has(verb)) return 'verify';
    if (CHANGE_VERBS.has(verb)) return 'change';
    if (READ_VERBS.has(verb)) return 'investigate';
    return null;
}

const NOISE = /受け付けました|^\s*(🧠|💬)|Thinking…|Receiving…/;
/** The controller's "✅ run_command finished: <raw output>" status. It is the
    tool's OUTPUT echoed, not a thought — as a chapter's prose it showed a
    timestamp from Get-Date as what the chapter had found. */
const TOOL_STATUS = /^\s*(✅|❌)?\s*[\w.:\/-]+ (finished|failed):/;
/** A line forwarded from a sub-agent whose job is to check (see SubagentRoles). */
const REVIEW_SUB = /\[sub:(reviewer|auditor|tester)\b/i;
/** The controller's own review gate opening ("🔎 独立レビューを実行中…"). */
const REVIEW_START = /^\s*🔎.*(実行中|Independent sub-agent review)/i;
/** …and its verdict. A verdict reports on what came BEFORE it. */
const VERDICT = /^\s*🔎|\b(PASS|FAIL)\b\s*[✅❌]/;
/** A progress status ("Reading file: x…", "実行中…") rather than a thought. */
const STATUS_EN = /^(reading|searching|running|writing|opening|checking|listing|calling|executing|analy[sz]ing|looking|fetching|loading|scanning|exploring|waiting)\b/i;
const TRAILING_DOTS = /(\.\.\.|…)\s*$/;
const DECL_JA = /(します|しましょう|してみます|みます|読みます|確認します|調べます|開きます|探します|実行します|進めます|始めます|行います|見ていきます|していきます)[。.!！…]*\s*$/;
const LEAD_JA = /^(まず|次に|では|それでは|続いて|さて)/;
const DECL_EN = /^(let me|let's|i'll|i will|i'm going to|i am going to|now,? (i|let)|next,? i|first,? i|i need to (read|check|look|open|search|find|see|run))\b/i;

/**
 * Is this thought an ANNOUNCEMENT of the next action rather than a finding?
 * "Let me read X" / "〜を確認します" says nothing the chapter's file list does
 * not already say, so it never becomes the chapter's prose.
 */
export function isAnnouncement(text) {
    const s = cleanThought(text);
    if (!s) return true;
    if (NOISE.test(String(text || '')) || TOOL_STATUS.test(String(text || ''))) return true;
    if (DECL_EN.test(s) || STATUS_EN.test(s)) return true;
    if (s.length <= 120 && TRAILING_DOTS.test(s)) return true;
    if (s.length <= 80 && (DECL_JA.test(s) || LEAD_JA.test(s))) return true;
    return false;
}

/** Strip the marks a feed line carries in front (emoji, ✓, 💭 …). */
export function cleanThought(text) {
    return String(text || '').replace(/^[^\p{L}\p{N}`"'(（「[]+/u, '').trim();
}

const basename = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();

function newChapter(role, id, at) {
    return {
        id, kind: 'phase', role, at, to: at, live: false,
        thoughts: [], trace: [],
        reads: [], writes: [], searches: 0, commands: [], checks: 0, tools: {},
        failed: 0, rounds: 0, lastFailed: false, checkedFirst: false,
        _sig: [],
    };
}

const pushUnique = (arr, path) => {
    if (path && !arr.some(f => f.path === path)) arr.push({ path, base: basename(path) });
};

function absorbAction(ch, line, a) {
    if (a.act === 'read' && line.path) pushUnique(ch.reads, line.path);
    if (a.act === 'search') ch.searches += 1;
    if (a.act === 'write') pushUnique(ch.writes, line.path || '');
    if (a.act === 'check') ch.checks += 1;
    if (a.act === 'tool') {
        const name = String(line.tool).split(/__|[.:/]/).pop();
        ch.tools[name] = (ch.tools[name] || 0) + 1;
    }
    if (a.act === 'command') {
        const cmd = commandOf(line);
        if (cmd) ch.commands.push(cmd);
    }
    if (line.type === 'error') ch.failed += 1;
    if (ch.role === 'verify' && (a.act === 'command' || a.act === 'check')) {
        ch.lastFailed = line.type === 'error';
    }
}

/**
 * Fold one segment of working items (between two non-working items) into chapters.
 */
function chaptersOf(segment) {
    const out = [];
    let cur = null;
    let pending = [];           // thoughts waiting for the action they lead to

    const sign = (ch, item) => ch._sig.push(`${item.id}:${item.rev || 0}`);
    const open = (role, id, at) => {
        cur = newChapter(role, id, at);
        out.push(cur);
        for (const p of pending) { cur.thoughts.push(p.text); cur.trace.push(p.trace); }
        pending = [];
        return cur;
    };

    let forced = null;          // a review gate is open: everything is checking

    const thought = (text, item, at) => {
        const tx = String(text || '').trim();
        if (!tx || NOISE.test(tx) || TOOL_STATUS.test(tx)) return;
        if (REVIEW_START.test(tx)) {
            forced = 'verify';
            open('verify', `story:${item.id}:r`, at ?? item.at);
            cur.trace.push({ kind: 'thought', text: tx });
            sign(cur, item);
            return;
        }
        if (VERDICT.test(tx) && cur) {
            // Backward, not forward: "review PASS" closes the chapter it judged.
            cur.thoughts.push(tx);
            cur.trace.push({ kind: 'thought', text: tx });
            if (at) cur.to = at;
            sign(cur, item);
            forced = null;
            return;
        }
        const entry = { text: tx, trace: { kind: 'thought', text: tx }, item };
        pending.push(entry);
        if (cur) { cur.to = at ?? cur.to; sign(cur, item); }
    };

    const action = (line, item, idx, at) => {
        const a = lineAction(line);
        if (!a) return false;
        const role = forced || a.role || cur?.role || 'investigate';
        if (!cur || (cur.role !== role && (a.role || forced))) open(role, `story:${item.id}:${idx}`, at ?? item.at);
        // Thoughts that came before this action belong to its chapter.
        for (const p of pending) { cur.thoughts.push(p.text); cur.trace.push(p.trace); }
        pending = [];
        absorbAction(cur, line, a);
        cur.trace.push({ kind: 'line', line });
        if (at) cur.to = at;
        sign(cur, item);
        return true;
    };

    for (const item of segment) {
        if (item.kind === 'group') {
            thought(item.head?.text, item, item.at);
            (item.lines || []).forEach((l, i) => {
                if (!action(l, item, i, item.at) && l.text && l.type !== 'tool') {
                    // A status line inside a step: keep it with the step, not as prose.
                    if (cur) { cur.trace.push({ kind: 'line', line: l }); sign(cur, item); }
                }
            });
        } else if (item.kind === 'narration') {
            thought(item.text, item, item.at);
        } else if (item.kind === 'activity') {
            if (lineAction(item)) action(item, item, 0, item.at);
            else if (item.type === 'thought' || item.type === 'live') thought(item.text, item, item.at);
            else if (cur) { cur.trace.push({ kind: 'line', line: item }); sign(cur, item); }
        } else if (item.kind === 'stdout') {
            const role = commandRole(item.command) || cur?.role || 'investigate';
            if (!cur || (cur.role !== role && commandRole(item.command))) open(role, `story:${item.id}:0`, item.at);
            cur.trace.push({ kind: 'stdout', item });
            sign(cur, item);
        }
    }
    // Reasoning with nothing after it: the run is thinking, or ended on a thought.
    if (pending.length) {
        const rest = pending;
        if (!cur) open('think', `story:${rest[0].item.id}:t`, rest[0].item.at);
        else for (const p of rest) { cur.thoughts.push(p.text); cur.trace.push(p.trace); }
        // Signed from the saved list: open() has already emptied `pending`, and a
        // chapter with no signature looks unchanged to the cache forever.
        for (const p of rest) sign(cur, p.item);
        pending = [];
    }
    return out;
}

function mergeInto(target, src, { before = false } = {}) {
    const cat = (a, b) => (before ? [...b, ...a] : [...a, ...b]);
    target.thoughts = cat(target.thoughts, src.thoughts);
    target.trace = cat(target.trace, src.trace);
    for (const f of src.reads) pushUnique(target.reads, f.path);
    for (const f of src.writes) pushUnique(target.writes, f.path);
    target.searches += src.searches;
    target.commands = cat(target.commands, src.commands);
    target.checks += src.checks;
    for (const [k, n] of Object.entries(src.tools)) target.tools[k] = (target.tools[k] || 0) + n;
    target.failed += src.failed;
    const ats = [target.at, src.at].filter(Number.isFinite);
    const tos = [target.to, src.to].filter(Number.isFinite);
    if (ats.length) target.at = Math.min(...ats);
    if (tos.length) target.to = Math.max(...tos);
    target._sig = cat(target._sig, src._sig);
}

/** A look so small it is part of the change that follows it. */
const isGlance = (c) => c.role === 'investigate'
    && c.reads.length <= 2 && c.searches === 0 && c.commands.length === 0
    && !Object.keys(c.tools).length;

/** A chapter that DID nothing a reader can see: only thoughts and bookkeeping. */
const isEmpty = (c) => !c.reads.length && !c.writes.some(f => f.path) && !c.searches
    && !c.commands.length && !c.checks && !Object.keys(c.tools).length;

function mergeChapters(input) {
    // 0. A chapter with nothing to show (the run's opening thoughts, a
    //    task_progress call) is the lead-in to the next one, not a chapter of
    //    its own — it drew an empty "調査" with only a "内訳" under it.
    const list = [];
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        const next = input[i + 1];
        if (next && isEmpty(c)) {
            mergeInto(next, c, { before: true });
            next.id = c.id;
            continue;
        }
        list.push(c);
    }
    // 1. "checked, then changed"
    const a = [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const next = list[i + 1];
        if (next && next.role === 'change' && isGlance(c)) {
            mergeInto(next, c, { before: true });
            next.id = c.id;
            next.checkedFirst = true;
            continue;
        }
        a.push(c);
    }
    // 2. change ↔ verify round trips → one chapter
    const b = [];
    for (let i = 0; i < a.length; i++) {
        const c = a[i];
        if (c.role === 'change' && a[i + 1]?.role === 'verify' && a[i + 2]?.role === 'change') {
            const loop = c;
            let j = i + 1;
            let rounds = 0;
            let lastFailed = false;
            while (j < a.length && (a[j].role === 'verify' || a[j].role === 'change')) {
                if (a[j].role === 'verify') { rounds += 1; lastFailed = a[j].lastFailed || a[j].failed > 0; }
                mergeInto(loop, a[j]);
                j += 1;
            }
            loop.role = 'loop';
            loop.rounds = rounds;
            loop.lastFailed = lastFailed;
            b.push(loop);
            i = j - 1;
            continue;
        }
        b.push(c);
    }
    return b;
}

/**
 * The chapter's prose: the latest thought that is a FINDING, not an
 * announcement. Only chosen once the chapter has closed — a live chapter keeps
 * its prose still and shows "now: …" instead, so text does not rewrite itself
 * under the reader.
 */
export function chapterSummary(ch) {
    for (let i = ch.thoughts.length - 1; i >= 0; i--) {
        const t = ch.thoughts[i];
        // A sectioned or very long text is the run's closing report streamed as
        // prose — it is the result, shown in full below, not this chapter's gist.
        if (/(^|\s)#{1,6}\s/.test(t) || t.length > 600) continue;
        if (!isAnnouncement(t)) {
            const s = cleanThought(t);
            return s.length > 280 ? `${s.slice(0, 280).trim()}…` : s;
        }
    }
    return '';
}

/** What the live chapter is doing this moment: its newest trace entry. */
function nowText(ch) {
    const last = ch.trace[ch.trace.length - 1];
    if (!last) return '';
    if (last.kind === 'thought') return cleanThought(last.text);
    if (last.kind === 'stdout') return last.item.command || '';
    // "🤖 [sub:auditor#1] ✓ grep_search" → "auditor: grep_search"
    return cleanThought(String(last.line?.text || '')
        .replace(/🤖\s*\[sub:([a-z]+)#\d+\]\s*/i, '$1: ')
        .replace(/(^|\s)[✓✗⚙]\s*/g, '$1'));
}

const WORKING = new Set(['group', 'activity', 'narration', 'stdout']);

/**
 * The Story stream: working items become chapters; everything else passes
 * through by reference.
 *
 * @param {Array<object>} items the rendered stream (after folds / pinning)
 * @param {{live?: boolean, cache?: Map}} [opts]
 *   `live` — the run is in flight, so the LAST chapter is the one being written.
 *   `cache` — a Map the caller keeps between renders; a chapter whose members
 *   did not change comes back as the SAME object, so the keyed renderer skips it.
 */
export function toStoryChapters(items, { live = false, cache = null } = {}) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    let seg = [];
    const flush = () => {
        if (!seg.length) return;
        for (const ch of mergeChapters(chaptersOf(seg))) out.push(ch);
        seg = [];
    };
    for (const item of list) {
        if (item && WORKING.has(item.kind)) { seg.push(item); continue; }
        flush();
        out.push(item);
    }
    flush();

    // Only the very last chapter of the stream can be live, and only while the
    // run is; anything after it (a question, a result) means it has closed.
    // The checklist card does not count as "after" the chapter: it is pinned to
    // the bottom while a run is live and says nothing about the chapter closing.
    let lastIdx = out.length - 1;
    while (lastIdx > 0 && out[lastIdx]?.kind === 'task_progress') lastIdx -= 1;
    const seen = new Set();
    return out.map((it, i) => {
        if (it?.kind !== 'phase') return it;
        labelFiles([...it.writes, ...it.reads]);
        it.live = !!live && i === lastIdx;
        it.summary = it.live ? '' : chapterSummary(it);
        it.now = it.live ? nowText(it) : '';
        it.rev = it._sig.length;
        const sig = `${it.role}|${it.live ? 1 : 0}|${it._sig.join(',')}`;
        delete it._sig;
        if (seen.has(it.id)) it.id = `${it.id}~${i}`;
        seen.add(it.id);
        if (cache) {
            const prev = cache.get(it.id);
            if (prev && prev.sig === sig) return prev.obj;
            cache.set(it.id, { sig, obj: it });
        }
        return it;
    });
}

/**
 * Give each file a label a reader can tell apart: the basename, or
 * `parent/basename` when two files in the same chapter share a name — three
 * chips that all said "README.md" told the reader nothing.
 */
export function labelFiles(files) {
    const count = new Map();
    for (const f of files) count.set(f.base, (count.get(f.base) || 0) + 1);
    for (const f of files) {
        if (count.get(f.base) > 1) {
            const parts = String(f.path).replace(/[\\/]+$/, '').split(/[\\/]/);
            f.label = parts.slice(-2).join('/');
        } else f.label = f.base;
    }
    return files;
}

/** The chapter's one-line tally, e.g. "6 files read · 2 searches". */
export function chapterTally(ch, t = (k) => k) {
    const parts = [];
    if (ch.reads.length) parts.push(t('story.tally.reads', { n: ch.reads.length }));
    if (ch.searches) parts.push(t('story.tally.searches', { n: ch.searches }));
    if (ch.writes.filter(f => f.path).length) parts.push(t('story.tally.writes', { n: ch.writes.filter(f => f.path).length }));
    if (ch.checks) parts.push(t('story.tally.checks', { n: ch.checks }));
    if (ch.commands.length) parts.push(t('story.tally.commands', { n: ch.commands.length }));
    // An app's tools by name: "write_deck ×3" says more than "3 tool calls".
    for (const [name, n] of Object.entries(ch.tools || {}).slice(0, 4)) {
        parts.push(n > 1 ? `${name} ×${n}` : name);
    }
    return parts;
}
