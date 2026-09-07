// WatcherEngine — the decision half of "go and look for yourself".
//
// A trigger needs something to trigger ON. Until now that something had to live
// outside the app: a Python script and a Task Scheduler entry. An app that owns
// a clock and calls itself autonomous should not be outsourcing the autonomous
// part, so the polling moves inside — and this is the part of it that decides,
// with no timers and no I/O, so it can be tested by passing it a clock.
//
// The caller does the actual looking (Tauri commands) and hands the result
// here; what comes back is a list of events for TriggerEngine, which already
// owns matching, dedupe, debounce and the runaway cap. Watchers produce, rules
// decide — so one mail watcher can feed a "invoice" trigger and an "outage"
// trigger, and an event that matches nothing is still visible, which is the
// only way to answer "why didn't it fire?".
//
// See docs/design/autonomy-triggers.md §11.

/** Applied to any field a watcher leaves out. */
export const WATCHER_DEFAULTS = {
    enabled: false,           // same reason as triggers: never live on creation
    everySeconds: 300,
    maxEventsPerPoll: 25,
    recursive: true,
};

/** Emitted per poll at most, whatever the source says, unless overridden. */
export const HARD_EVENT_CAP = 200;

/**
 * Is this watcher due to run?
 *
 * A watcher that has never run is due immediately — but see `firstRun`: due
 * does not mean it will emit anything.
 */
export function isDue(watcher, now = Date.now()) {
    if (!watcher?.enabled) return false;
    const every = Math.max(5, Number(watcher.everySeconds) || WATCHER_DEFAULTS.everySeconds) * 1000;
    const last = Number(watcher.lastRunAt) || 0;
    return now - last >= every;
}

/** Seconds until the soonest enabled watcher is due; Infinity when none are. */
export function nextDueIn(watchers, now = Date.now()) {
    let soonest = Infinity;
    for (const w of watchers || []) {
        if (!w?.enabled) continue;
        const every = Math.max(5, Number(w.everySeconds) || WATCHER_DEFAULTS.everySeconds) * 1000;
        const last = Number(w.lastRunAt) || 0;
        soonest = Math.min(soonest, Math.max(0, last + every - now));
    }
    return soonest;
}

/**
 * Has this watcher established what "already there" looks like?
 *
 * THE rule of this file. Switching on a folder watcher must not file one task
 * per file that was already sitting there — five hundred of them, at once, for
 * work nobody asked for. The first poll records the state and emits NOTHING;
 * everything after it reports the difference.
 *
 * "It went berserk the moment I turned it on" is the failure a feature like
 * this does not get to make twice.
 */
export function isFirstRun(watcher) {
    return !watcher?.baseline;
}

/**
 * Compare a folder scan against the baseline.
 *
 * @param {{files: Array<{path,modified,size}>}} scan  what the filesystem said
 * @param {object|null} baseline  path → modified, from the previous poll
 * @returns {{events: object[], baseline: object}}
 */
export function diffFolder(watcher, scan, now = Date.now()) {
    const files = Array.isArray(scan?.files) ? scan.files : [];
    const next = {};
    for (const f of files) next[f.path] = f.modified;

    if (isFirstRun(watcher)) {
        return { events: [], baseline: next, note: 'baseline' };
    }

    const prev = watcher.baseline || {};
    const cap = Math.min(
        Math.max(1, Number(watcher.maxEventsPerPoll) || WATCHER_DEFAULTS.maxEventsPerPoll),
        HARD_EVENT_CAP);
    const events = [];
    for (const f of files) {
        if (prev[f.path] === f.modified) continue;          // untouched
        const kind = prev[f.path] === undefined ? 'created' : 'changed';
        events.push({
            source: 'watcher',
            // WHICH watcher. Without it two sources emitting the same event
            // name are indistinguishable, and a job attached to one fires
            // on the other's events with nothing to explain it.
            watcherId: watcher.id,
            event: watcher.eventName || 'file.changed',
            // Path plus mtime: the same edit seen twice is one event, a second
            // edit to the same file is a new one.
            key: `${f.path}|${f.modified}`,
            payload: { path: f.path, name: f.path.split(/[\\/]/).pop(), kind, size: f.size, at: now },
        });
        if (events.length >= cap) break;
    }
    // Deletions: reported, because "the file the report is built from is gone"
    // is exactly the kind of thing worth waking up for.
    if (events.length < cap) {
        for (const path of Object.keys(prev)) {
            if (next[path] !== undefined) continue;
            events.push({
                source: 'watcher',
                watcherId: watcher.id,
            // WHICH watcher. Without it two sources emitting the same event
            // name are indistinguishable, and a job attached to one fires
            // on the other's events with nothing to explain it.
            watcherId: watcher.id,
                event: watcher.eventName || 'file.changed',
                key: `${path}|deleted|${now}`,
                payload: { path, name: path.split(/[\\/]/).pop(), kind: 'deleted', at: now },
            });
            if (events.length >= cap) break;
        }
    }
    return { events, baseline: next };
}


/**
 * Turn a mailbox reading into events, against what was already there.
 *
 * The baseline for mail is the set of message-ids that matched on the first
 * check. Without it, switching on a watcher pointed at an inbox with forty
 * unread messages starts forty tasks — the same failure as the folder watcher,
 * and the reason both share this rule.
 *
 * @param {{messages: Array<object>}} result  what imap_check returned
 */
export function diffMail(watcher, result, now = Date.now()) {
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const ids = {};
    for (const m of messages) ids[m.id] = 1;

    if (isFirstRun(watcher)) {
        return { events: [], baseline: ids, note: 'baseline' };
    }

    const prev = watcher.baseline || {};
    const cap = Math.min(
        Math.max(1, Number(watcher.maxEventsPerPoll) || WATCHER_DEFAULTS.maxEventsPerPoll),
        HARD_EVENT_CAP);
    const events = [];
    for (const m of messages) {
        if (prev[m.id]) continue;
        events.push({
            source: 'watcher',
            // WHICH watcher. Without it two sources emitting the same event
            // name are indistinguishable, and a job attached to one fires
            // on the other's events with nothing to explain it.
            watcherId: watcher.id,
            event: watcher.eventName || 'mail.received',
            // The Message-ID IS the identity. A mail that stays unread is seen
            // again on every poll, and this is what stops it starting a second
            // task each time.
            key: m.id,
            payload: {
                from: m.from, to: m.to, subject: m.subject,
                date: m.date, body: m.body, at: now,
            },
        });
        if (events.length >= cap) break;
    }
    // The baseline is the CURRENT set, not a union: a message that has been
    // read (so no longer matches UNSEEN) should not be remembered for ever, or
    // the store grows without limit for the life of the watcher.
    return { events, baseline: ids };
}

/**
 * Read a value out of a nested object by dotted path.
 *
 * A segment of `[]` maps over an array instead of indexing it, so
 * `assets[].download_count` is every asset's count rather than one of them.
 * Plain numeric segments still index (`assets.1.download_count`).
 *
 * `null` for a missing leaf, so a condition on it simply does not match.
 */
export function pick(obj, path) {
    if (!path) return obj;
    let cur = obj;
    // `assets[].download_count` is written without a dot before the brackets,
    // so split them off first — otherwise `assets[]` is one segment and the
    // lookup silently finds nothing.
    const segments = String(path)
        .replace(/\[\]/g, '.[].')
        .split('.')
        .filter(Boolean);
    for (const seg of segments) {
        if (cur == null) return null;
        if (seg === '[]' || seg === '*') {
            if (!Array.isArray(cur)) return null;
            continue;                       // stay on the array; the next segment maps
        }
        if (Array.isArray(cur) && !/^\d+$/.test(seg)) {
            cur = cur.map(x => (x == null ? undefined : x[seg]));
            continue;
        }
        cur = cur[seg];
    }
    return cur ?? null;
}

/**
 * Drop array entries the watcher does not want counted.
 *
 * Crude on purpose — substring match on one named field. The case it exists for
 * is concrete: a GitHub release lists `latest.json` and a `.sig` beside the
 * installer, and `latest.json`'s counter goes up every time an INSTALLED copy
 * checks for updates. Summing it would make the number move for a reason that
 * is not a download, and every move starts a task.
 *
 * @param {string} field      the element field to test, e.g. "name"
 * @param {string} excludeCsv comma-separated substrings; any match drops the entry
 */
export function excludeEntries(list, field, excludeCsv) {
    if (!Array.isArray(list) || !field || !excludeCsv) return list;
    const terms = String(excludeCsv).split(',').map(s => s.trim()).filter(Boolean);
    if (!terms.length) return list;
    return list.filter((entry) => {
        const v = String(entry?.[field] ?? '');
        return !terms.some(term => v.includes(term));
    });
}

/** Reduce an array of values to the one number the watcher is watching. */
export function aggregate(values, how) {
    if (!Array.isArray(values)) return values;
    const nums = values.map(Number).filter(Number.isFinite);
    switch (how) {
        case 'sum':   return nums.reduce((a, b) => a + b, 0);
        case 'count': return values.length;
        case 'max':   return nums.length ? Math.max(...nums) : null;
        case 'min':   return nums.length ? Math.min(...nums) : null;
        default:      return values;
    }
}

/**
 * Turn an HTTP response into events.
 *
 * Two ways to be interesting, because polling an endpoint means one of two
 * questions: "has this changed?" (a status page, a version file) or "is this
 * bad right now?" (a build state, a queue depth). Answering only the first
 * would re-fire on every unrelated change; only the second, never notice a
 * recovery.
 *
 * `watchPath` narrows what counts as a change, so a timestamp in the payload
 * does not make every poll look like news.
 */
export function diffHttp(watcher, response, now = Date.now()) {
    const bodyText = typeof response?.body === 'string' ? response.body : null;

    // A regular expression, for everything that is not JSON.
    //
    // XML, HTML, an RSS feed, a plain version file: parsing each properly would
    // mean a parser per format, and the thing being watched is almost always
    // ONE number or ONE string inside it. The first capture group is that
    // value. Deliberately not a substitute for a JSON path — it is the answer
    // for the formats a path cannot address.
    if (watcher.watchRegex && bodyText !== null) {
        let found = null;
        try {
            const m = bodyText.match(new RegExp(watcher.watchRegex, 'm'));
            found = m ? (m[1] ?? m[0]) : null;
        } catch (e) {
            throw new Error(`正規表現が不正です: ${e.message}`);
        }
        if (found === null) {
            throw new Error(
                `正規表現「${watcher.watchRegex}」がレスポンスに一致しませんでした。`);
        }
        return diffValue(watcher, found, watcher.url, now);
    }

    let data = response?.body;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { /* keep the text */ }
    }
    // Filter BEFORE the path walks into the elements, so the exclusion is
    // written against the entry ("name contains latest.json"), not against
    // whatever the path happens to end on.
    let scoped = data;
    if (watcher.filterField && watcher.filterExclude) {
        // The key the array lives under, with the brackets stripped:
        // `assets[].download_count` filters the `assets` array. Leaving `[]` on
        // meant writing the filtered list back under the literal key "assets[]",
        // where nothing would ever read it — the filter appeared to do nothing.
        const head = String(watcher.watchPath || '').split('.')[0].replace('[]', '');
        const list = head ? pick(data, head) : data;
        if (Array.isArray(list)) {
            const kept = excludeEntries(list, watcher.filterField, watcher.filterExclude);
            scoped = head ? { ...data, [head]: kept } : kept;
        }
    }
    // What each surviving entry contributed.
    //
    // The panel showed the total and nothing else, so "is the exclusion even
    // working?" could only be answered by fetching the API by hand and doing
    // the arithmetic. A total that cannot show its terms is a number you have
    // to take on trust.
    const parts = breakdown(scoped, watcher);

    const found = watcher.watchPath ? pick(scoped, watcher.watchPath) : scoped;
    // A path that resolves to NOTHING is a configuration or parsing fault, not
    // a value. Storing it produced a baseline of the string "null", which by
    // definition never changes — so the watcher ran on schedule, reported "no
    // change" every time, and looked healthy while watching nothing at all.
    if (watcher.watchPath && (found === null || found === undefined)) {
        throw new Error(
            `見る項目「${watcher.watchPath}」がレスポンスの中に見つかりません。`
            + `パスを確認してください（配列は [] を挟みます）。`);
    }
    const watched = aggregate(found, watcher.aggregate);
    return diffValue(watcher, watched, watcher.url, now, parts);
}

/** How many contributing entries to keep. Enough to check, not a data dump. */
const MAX_PARTS = 12;

/**
 * The entries behind an aggregated value, as [label, value] pairs.
 *
 * Only meaningful when the watcher is summing over a list. Returns null
 * otherwise, so nothing is invented for a watcher that reads a single field.
 */
export function breakdown(data, watcher) {
    if (!watcher?.aggregate || !watcher?.watchPath) return null;
    const head = String(watcher.watchPath).split('.')[0].replace('[]', '');
    const list = head ? pick(data, head) : data;
    if (!Array.isArray(list)) return null;
    const leaf = String(watcher.watchPath).split('.').pop();
    const labelField = watcher.filterField || 'name';
    return list.slice(0, MAX_PARTS).map((entry, i) => [
        String(entry?.[labelField] ?? `#${i}`),
        entry?.[leaf],
    ]);
}

/**
 * Compare one extracted value against the baseline and decide.
 *
 * Shared by the JSON-path and the regular-expression routes, so the rules that
 * matter — fire on the TRANSITION into a condition, re-baseline when the
 * previous value is unknown — cannot be right in one and wrong in the other.
 */
function diffValue(watcher, watched, url, now, parts = null) {
    const stamp = typeof watched === 'object' ? JSON.stringify(watched) : String(watched);

    // A condition, when given, decides on its own — the value either matches or
    // it does not, and the previous poll is irrelevant.
    if (watcher.equals != null && String(watcher.equals) !== '') {
        const hit = String(watched) === String(watcher.equals);
        const wasHit = watcher.baseline?.hit === true;
        const baseline = { hit, stamp, value: watched, ...(parts ? { parts } : {}) };
        if (isFirstRun(watcher)) return { events: [], baseline, note: 'baseline' };
        // Only the transition. Firing every poll while a build stays red is how
        // one broken build becomes two hundred tasks overnight.
        if (!hit || wasHit) return { events: [], baseline };
        return {
            events: [{
                source: 'watcher',
                watcherId: watcher.id,
            // WHICH watcher. Without it two sources emitting the same event
            // name are indistinguishable, and a job attached to one fires
            // on the other's events with nothing to explain it.
            watcherId: watcher.id,
                event: watcher.eventName || 'http.matched',
                key: `${watcher.id}|${stamp}|${now}`,
                payload: { value: watched, url, at: now },
            }],
            baseline,
        };
    }

    // `value` alongside `stamp`: the stamp is for comparing (a string, so
    // objects compare too), the value is what the next poll reports as
    // `previous`. Reading `previous` off the stamp made it a string while
    // `value` stayed a number — the same quantity, two types, one of which
    // silently loses a numeric comparison later.
    // `parts` only when there ARE parts. A field that is always null is
    // written to storage on every poll of every watcher, and says nothing.
    const baseline = { stamp, value: watched, ...(parts ? { parts } : {}) };
    if (isFirstRun(watcher)) return { events: [], baseline, note: 'baseline' };
    if (watcher.baseline?.stamp === stamp) return { events: [], baseline };
    // A baseline with no usable value — written by an older build, or by a poll
    // that could not read the response — cannot say what the previous value
    // was. "It changed from unknown to 5" is not information, and emitting it
    // hands the job a prompt with `{{payload.previous}}` it cannot fill. Take
    // the baseline again instead; the next real change reports properly.
    if (watcher.baseline?.value === undefined || watcher.baseline?.value === null) {
        return { events: [], baseline, note: 'baseline' };
    }
    return {
        events: [{
            source: 'watcher',
            // WHICH watcher. Without it two sources emitting the same event
            // name are indistinguishable, and a job attached to one fires
            // on the other's events with nothing to explain it.
            watcherId: watcher.id,
            event: watcher.eventName || 'http.changed',
            key: `${watcher.id}|${stamp}`,
            payload: {
                value: watched,
                previous: watcher.baseline?.value ?? null,
                url, at: now,
            },
        }],
        baseline,
    };
}

/**
 * Turn a command's output into events.
 *
 * Two shapes, on purpose. A line of JSON carrying its own `event` is the
 * precise form — a script that knows what it found says so. A plain line is the
 * quick form, for `findstr` and friends, and only works when the watcher names
 * the event itself. Anything else is ignored rather than guessed at.
 */
export function eventsFromOutput(watcher, stdout, now = Date.now()) {
    const cap = Math.min(
        Math.max(1, Number(watcher.maxEventsPerPoll) || WATCHER_DEFAULTS.maxEventsPerPoll),
        HARD_EVENT_CAP);
    const out = [];
    for (const raw of String(stdout || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (out.length >= cap) break;

        let parsed = null;
        if (line.startsWith('{')) {
            try { parsed = JSON.parse(line); } catch (_) { parsed = null; }
        }
        if (parsed && typeof parsed === 'object' && parsed.event) {
            out.push({
                source: 'watcher',
                watcherId: watcher.id,
            // WHICH watcher. Without it two sources emitting the same event
            // name are indistinguishable, and a job attached to one fires
            // on the other's events with nothing to explain it.
            watcherId: watcher.id,
                event: String(parsed.event),
                key: parsed.key != null ? String(parsed.key) : undefined,
                payload: parsed.payload ?? parsed,
            });
        } else if (watcher.eventName) {
            out.push({
                source: 'watcher',
                watcherId: watcher.id,
            // WHICH watcher. Without it two sources emitting the same event
            // name are indistinguishable, and a job attached to one fires
            // on the other's events with nothing to explain it.
            watcherId: watcher.id,
                event: watcher.eventName,
                // The line IS the identity: the same line next poll is the same
                // finding, and re-reporting it would start the task again.
                key: `${watcher.id}|${line}`,
                payload: { line, at: now },
            });
        }
    }
    return out;
}


/**
 * What each watcher type puts in `payload`, for the prompt to read as
 * `{{payload.<name>}}`.
 *
 * Declared next to the code that produces it — a list kept anywhere else drifts
 * the first time a field is added, and a documented field that is not emitted
 * is worse than no documentation, because the prompt silently keeps the
 * placeholder instead of the value.
 */
export const PAYLOAD_FIELDS = {
    folder: [
        ['path', 'ファイルのフルパス'],
        ['name', 'ファイル名だけ'],
        ['kind', 'created / changed / deleted'],
        ['size', 'バイト数'],
    ],
    mail: [
        ['from', '差出人'],
        ['to', '宛先'],
        ['subject', '件名'],
        ['date', '送信日時'],
        ['body', '本文（先頭2000文字）'],
    ],
    http: [
        ['value', '今回の値（まとめ方を適用した後）'],
        ['previous', '前回の値'],
        ['url', '見に行った URL'],
    ],
    command: [
        ['line', '出力の1行（JSON を出した場合はその中身がそのまま入ります）'],
    ],
    slack: [
        ['text', 'メッセージ本文'],
        ['user', '書いた人の ID'],
        ['channel', 'チャンネル ID'],
        ['ts', 'Slack のタイムスタンプ'],
        ['thread_ts', 'スレッド元（無ければ null）'],
    ],
};

/**
 * Fields present on EVERY watcher event, whatever produced it.
 *
 * Deliberately short. The rest of a payload is per-type and has to be — a mail
 * has a subject, a file has a path, an endpoint has a number — and flattening
 * them into one shape would mean naming a file's path `value`.
 */
export const COMMON_FIELDS = [
    ['watcher', 'この監視の名前'],
    ['at', '検出した時刻 (ms)'],
];

/** The fields a watcher of this type emits, common ones first. */
export function payloadFieldsFor(type) {
    if (!PAYLOAD_FIELDS[type]) return [];
    return [...COMMON_FIELDS, ...PAYLOAD_FIELDS[type]];
}

/**
 * A watcher's own state after a poll, for the UI to show.
 *
 * A watcher that has been failing for two days looks exactly like a quiet one
 * unless this is recorded and displayed.
 */
export function pollOutcome({ ok, count = 0, error = null, note = null, sample = null }, now = Date.now()) {
    return {
        lastRunAt: now,
        lastOk: !!ok,
        lastCount: count,
        lastError: ok ? null : String(error || 'failed'),
        lastNote: note,
        // The payload of the most recent real event. The field LIST says what a
        // type can emit; this says what it did emit, with the values — which is
        // what settles whether `{{payload.subject}}` is going to resolve.
        ...(sample ? { lastSample: sample } : {}),
    };
}
