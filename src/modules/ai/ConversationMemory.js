import { invoke } from '@tauri-apps/api/core';
import { tokenEstimator } from './TokenEstimator.js';
import LLMService from './LLMService.js';
import { sanitizeXmlTags, relevanceScore, scoreMessageImportance } from './memory/MemoryScoring.js';
import { mergeFacts as mergeFactsInto, selectRelevantFacts } from './memory/FactStore.js';

class ConversationMemory {
    constructor() {
        this.entries = [];
        this.loaded = false;
        this.maxEntries = 20;

        // ── Long-term memory (durable journal + curated facts) ─────────
        // Two durable artifacts live under <workspace>/.agent/long_term/:
        //   • journal.md  — append-only, human-readable log of every completed
        //                    session (date, topic, outcome, files, summary).
        //   • facts.json  — curated durable facts (project conventions, decisions,
        //                    gotchas) extracted by the LLM and deduped over time.
        // Recall: getPromptContext injects the top relevant facts + episodic
        // summaries by keyword overlap (no embeddings — device-perf friendly).
        this.facts = [];          // [{ fact, date, sessionId, hits }]
        this.factsLoaded = false;
        this.maxFacts = 100;      // cap; least-relevant pruned on overflow

        // ── History budget configuration ───────────────────────────────
        // Fraction of the model's context window that history (conversation +
        // injected file cache) is allowed to occupy before compaction triggers.
        // Configurable via setBudgetConfig(); default 0.7 (was a hardcoded 0.3,
        // which was far too aggressive — it reserved 70% of the window for a
        // system prompt that actually uses ~5K tokens, forcing premature
        // summarization and the re-read loops observed in practice).
        this.historyBudgetRatio = 0.7;
        // Absolute reservations (tokens) subtracted from the window as a hard
        // safety cap, so even with a high ratio we never starve the response or
        // overflow on a small-window model.
        this.outputReserveTokens = 8000;   // room for the model's reply
        this.systemReserveTokens = 8000;   // tool defs + rules + active-file context
        this.safetyMarginTokens  = 2000;   // estimator slack
    }

    /**
     * Override history-budget parameters (e.g. from user config).
     * @param {object} cfg - { ratio?, outputReserve?, systemReserve?, safetyMargin? }
     */
    setBudgetConfig(cfg = {}) {
        if (Number.isFinite(cfg.ratio) && cfg.ratio > 0 && cfg.ratio <= 1) {
            this.historyBudgetRatio = cfg.ratio;
        }
        if (Number.isFinite(cfg.outputReserve) && cfg.outputReserve >= 0) {
            this.outputReserveTokens = cfg.outputReserve;
        }
        if (Number.isFinite(cfg.systemReserve) && cfg.systemReserve >= 0) {
            this.systemReserveTokens = cfg.systemReserve;
        }
        if (Number.isFinite(cfg.safetyMargin) && cfg.safetyMargin >= 0) {
            this.safetyMarginTokens = cfg.safetyMargin;
        }
    }

    /**
     * Escape active XML tags in memory to prevent system prompt pollution.
     */
    // Pure scoring/text helpers → ./memory/MemoryScoring.js (thin wrappers).
    _sanitizeXmlTags(text) { return sanitizeXmlTags(text); }

    /**
     * Load memory from .agent/memory.json
     */
    async loadMemory(workspacePath) {
        if (!workspacePath) return;
        try {
            const path = `${workspacePath}/.agent/memory.json`;
            const fileData = await invoke('read_file', { path });
            if (fileData) {
                this.entries = JSON.parse(fileData);
                this.loaded = true;
                console.log(`AI Memory: Loaded ${this.entries.length} entries.`);
            }
        } catch (e) {
            this.entries = [];
            this.loaded = true;
        }
        await this.loadFacts(workspacePath);
    }

    /**
     * Load the durable facts store from .agent/long_term/facts.json.
     */
    async loadFacts(workspacePath) {
        if (!workspacePath) return;
        try {
            const path = `${workspacePath}/.agent/long_term/facts.json`;
            const data = await invoke('read_file', { path });
            if (data) {
                const parsed = JSON.parse(data);
                this.facts = Array.isArray(parsed) ? parsed : [];
                console.log(`AI Memory: Loaded ${this.facts.length} durable facts.`);
            }
        } catch (e) {
            this.facts = [];
        }
        this.factsLoaded = true;
    }

    /**
     * Persist the curated facts store. Caps at maxFacts, dropping the
     * least-referenced (lowest hits, then oldest) entries on overflow.
     */
    async saveFacts(workspacePath) {
        if (!workspacePath) return;
        try {
            const dirPath = `${workspacePath}/.agent/long_term`;
            try { await invoke('create_dir', { path: dirPath }); } catch (e) { /* exists */ }

            if (this.facts.length > this.maxFacts) {
                this.facts.sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.timestamp || 0) - (a.timestamp || 0));
                this.facts = this.facts.slice(0, this.maxFacts);
            }
            await invoke('write_file', {
                path: `${dirPath}/facts.json`,
                content: JSON.stringify(this.facts, null, 2)
            });
        } catch (e) {
            console.error('AI Memory: Failed to save facts:', e);
        }
    }

    /**
     * Append a human-readable entry to the durable journal (append-only).
     * Reads the existing file and rewrites it (write_file has no append mode);
     * this is cheap because the journal is short prose, not file contents.
     */
    async appendJournal(workspacePath, entry) {
        if (!workspacePath || !entry) return;
        try {
            const dirPath = `${workspacePath}/.agent/long_term`;
            try { await invoke('create_dir', { path: dirPath }); } catch (e) { /* exists */ }
            const path = `${dirPath}/journal.md`;

            let existing = '';
            try { existing = await invoke('read_file', { path }) || ''; } catch (e) { /* new file */ }
            if (!existing) existing = '# Agent Long-Term Journal\n\nAppend-only log of completed sessions.\n';

            const outcomeIcon = entry.outcome === 'success' ? '✅' : (entry.outcome === 'error' ? '❌' : '⚠️');
            const filesStr = (entry.keyFiles && entry.keyFiles.length) ? entry.keyFiles.join(', ') : '—';
            const actionsStr = (entry.actions && entry.actions.length) ? entry.actions.map(a => `\n  - ${a}`).join('') : '';
            const block =
                `\n---\n\n## [${entry.date}] ${outcomeIcon} ${entry.topic}\n` +
                (entry.sessionId ? `*session: ${entry.sessionId}*\n` : '') +
                `\n**Summary:** ${entry.summary}\n` +
                (actionsStr ? `\n**Actions:**${actionsStr}\n` : '') +
                `\n**Files:** ${filesStr}\n`;

            await invoke('write_file', { path, content: existing + block });
        } catch (e) {
            console.error('AI Memory: Failed to append journal:', e);
        }
    }

    /**
     * Merge newly-extracted durable facts into the store, deduping by normalized
     * text. Existing matches get their hit count bumped (so frequently-reaffirmed
     * facts survive pruning); genuinely new facts are appended.
     */
    mergeFacts(newFacts, sessionId) {
        // Dedup/near-dup merge logic → ./memory/FactStore.js (unit-tested).
        mergeFactsInto(this.facts, newFacts, sessionId);
    }

    /**
     * Save memory to .agent/memory.json
     */
    async saveMemory(workspacePath) {
        if (!workspacePath) return;
        try {
            const dirPath = `${workspacePath}/.agent`;
            try {
                await invoke('create_dir', { path: dirPath });
            } catch (e) {
                // Ignore if exists
            }

            const path = `${dirPath}/memory.json`;
            const trimmed = this.entries.slice(-this.maxEntries);
            await invoke('write_file', {
                path,
                content: JSON.stringify(trimmed, null, 2)
            });
        } catch (e) {
            console.error('AI Memory: Failed to save:', e);
        }
    }

    /**
     * Add a conversation entry after an agent session completes.
     */
    async addEntry(userQuery, agentResponse, sessionId = null, workspacePath = null, onLog = null) {
        if (!this.loaded) await this.loadMemory(workspacePath);

        const safeQuery = this._sanitizeXmlTags(String(userQuery || ''));
        const safeResponse = this._sanitizeXmlTags(String(agentResponse || ''));

        let entry;

        try {
            entry = await this._generateStructuredSummary(safeQuery, safeResponse, sessionId, onLog);
        } catch (e) {
            console.warn('AI Memory: LLM summarization failed, using fallback:', e);
            entry = {
                timestamp: Date.now(),
                date: new Date().toISOString().split('T')[0],
                sessionId: sessionId || null,
                topic: safeQuery.substring(0, 80),
                actions: [],
                outcome: 'unknown',
                keyFiles: [],
                summary: safeResponse.substring(0, 300),
                facts: []
            };
        }

        this.entries.push(entry);
        await this.saveMemory(workspacePath);

        // ── Durable long-term artifacts ───────────────────────────────
        // Append a readable journal entry and fold any extracted facts into the
        // curated facts store. Best-effort — never throw out of addEntry.
        try {
            if (!this.factsLoaded) await this.loadFacts(workspacePath);
            await this.appendJournal(workspacePath, entry);
            if (entry.facts && entry.facts.length) {
                this.mergeFacts(entry.facts, sessionId);
                await this.saveFacts(workspacePath);
            }
        } catch (e) {
            console.warn('AI Memory: long-term persistence failed:', e);
        }
    }

    /**
     * Uses LLM to generate a structured summary of the session.
     */
    async _generateStructuredSummary(query, response, sessionId, onLog = null) {
        const prompt = `Analyze the following interaction with the AI assistant and output a JSON object summarizing it.
Do not output any markdown code blocks or explanations, just the raw JSON object.

[User Query]
${query.substring(0, 500)}

[AI Final Response]
${response.substring(0, 1500)}

JSON output format:
{
  "topic": "Topic of interaction within 40 characters",
  "actions": ["Up to 3 short sentences of actions taken"],
  "outcome": "success or partial or error",
  "keyFiles": ["Up to 3 main file paths modified/referenced"],
  "summary": "Summary of what was done and achieved within 120 characters",
  "facts": ["Up to 3 DURABLE facts worth remembering long-term: project conventions, key decisions, architecture notes, or gotchas. Omit transient details. Empty array if none."]
}`;

        let rawResult = '';
        const sumSys = 'You are a JSON generator. Output ONLY a valid JSON object, nothing else. No markdown, no explanation.';
        const _t0 = Date.now();
        const gen = await LLMService.generate(prompt, sumSys, (chunk) => { rawResult += chunk; });
        if (onLog) {
            try {
                onLog({
                    method: 'CHAT', status: 200, duration: Date.now() - _t0,
                    stepLabel: '🧠 Long-term Memory Summary',
                    usage: gen?.usage,
                    request: { purpose: 'ltm-structured-summary', system_prompt: sumSys, prompt },
                    response: rawResult
                });
            } catch (_) {}
        }

        let parsed;
        const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
        } else {
            throw new Error('LLM did not return valid JSON');
        }

        return {
            timestamp: Date.now(),
            date: new Date().toISOString().split('T')[0],
            sessionId: sessionId || null,
            topic: String(parsed.topic || '').substring(0, 80),
            actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3).map(a => String(a).substring(0, 100)) : [],
            outcome: ['success', 'partial', 'error'].includes(parsed.outcome) ? parsed.outcome : 'unknown',
            keyFiles: Array.isArray(parsed.keyFiles) ? parsed.keyFiles.slice(0, 3).map(f => String(f).substring(0, 150)) : [],
            summary: String(parsed.summary || '').substring(0, 200),
            facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 3).map(f => String(f).substring(0, 300)) : []
        };
    }

    /**
     * Summarize conversation history if it exceeds token threshold.
     *
     * @param {object[]} history   - Conversation message array
     * @param {string}   modelId   - Current model ID (for token-limit lookup)
     * @param {Map}      fileCache - Optional session file cache from ToolExecutor.getFileCache().
     *   When provided, cached file contents are re-injected verbatim after the summary so the
     *   agent doesn't have to re-read files it already fetched before compaction.
     *   Schema: Map<normalizedPath, { content, readCount, editedAt, readAt }>
     */
    async compactHistory(history, modelId = '', fileCache = null, onLog = null) {
        if (!tokenEstimator) {
            if (history.length <= 8) return history;
            return history.slice(-4);
        }

        // Resolve the model's real context window. Prefer LLMService's effective
        // limit (honors per-connection context_window override + real provider);
        // fall back to the bare table lookup if for some reason it's unavailable.
        let modelLimit;
        try {
            modelLimit = LLMService.getEffectiveModelLimit
                ? LLMService.getEffectiveModelLimit()
                : tokenEstimator.getModelLimit(modelId);
        } catch (_) {
            modelLimit = tokenEstimator.getModelLimit(modelId);
        }
        if (!Number.isFinite(modelLimit) || modelLimit <= 0) {
            modelLimit = tokenEstimator.getModelLimit(modelId);
        }

        // ── Budget = min(ratio cap, absolute-reservation cap) ──────────
        // ratio cap:        configurable fraction of the window (default 0.7)
        // reservation cap:  window minus fixed reserves for system/output/margin,
        //                   protecting the response even on a small window.
        // We also keep a floor (≥20%) so a generous reservation can't starve history.
        const reserved = this.outputReserveTokens + this.systemReserveTokens + this.safetyMarginTokens;
        const ratioCap = Math.floor(modelLimit * this.historyBudgetRatio);
        const reservationCap = modelLimit - reserved;
        const floor = Math.floor(modelLimit * 0.2);
        const historyBudget = Math.max(floor, Math.min(ratioCap, reservationCap));

        const estimation = tokenEstimator.estimateConversation(history, '');

        if (estimation.totalTokens <= historyBudget) {
            return history;
        }

        console.log(`AI Memory: History tokens (${estimation.totalTokens}) exceed budget (${historyBudget} of ${modelLimit} window). Compacting...`);

        const originalUserMsg = history.find(m => m.role === 'user');
        const messagesToCompact = history.filter(m => m !== originalUserMsg);

        const keepRecent = Math.min(4, messagesToCompact.length);
        const recentMessages = messagesToCompact.slice(-keepRecent);
        const oldMessages = messagesToCompact.slice(0, messagesToCompact.length - keepRecent);

        // NOTE: The old `preservedFiles` mechanism (regex-matching message content
        // for filenames like package.json/README.md) was REMOVED here because:
        //   • It matched messages that merely *mentioned* a filename and saved the
        //     whole message as "the file content" — including previous summaries.
        //   • Each compaction then preserved a summary that contained a previous
        //     preserved-summary that contained another preserved-summary, recursively.
        //   • A single session could accumulate 10K+ tokens of garbage this way.
        // Real file contents are now restored from `fileCache` (passed in) which
        // contains actual read_file/write_file results — no false positives.

        try {
            // ── Build deduped Key Context (Bug 3 fix) ──────────────────
            // Previously this pushed a new entry per old message without any
            // dedupe, so the same path/error appeared dozens of times. Now we
            // collect into Sets and emit each unique value at most once.
            const allPaths = new Set();
            const allErrors = new Set();
            for (const msg of oldMessages) {
                const content = msg.content || '';
                const pathMatches = content.match(/[\/\\][\w\/\\.\\-]+\.\w+/g);
                if (pathMatches) for (const p of pathMatches) allPaths.add(p);
                if (content.includes('Error') || content.includes('エラー')) {
                    // Take the first Error line per message; trim runs of "Error: Error: Error:..."
                    const errorLine = content.split('\n').find(l => l.includes('Error') || l.includes('エラー'));
                    if (errorLine) {
                        const cleaned = errorLine
                            .replace(/(^|\s)(Error:\s*){2,}/gi, '$1Error: ')
                            .substring(0, 140)
                            .trim();
                        if (cleaned) allErrors.add(cleaned);
                    }
                }
            }
            const keyInfo = [];
            if (allPaths.size > 0)  keyInfo.push(`Files touched: ${[...allPaths].slice(0, 8).join(', ')}`);
            if (allErrors.size > 0) keyInfo.push(`Errors:\n  • ${[...allErrors].slice(0, 5).join('\n  • ')}`);

            // ── Importance-based preservation + plan anchoring ─────────────
            // Instead of summarizing ALL old messages (which loses high-value
            // detail like the plan, decisions, and the exact errors being fixed),
            // we keep the most important old messages VERBATIM within a small
            // budget and only summarize the low-value remainder (tool chatter,
            // system nudges, redundant reflections).
            const PLAN_RE = /plan\.md|\[plan\]|計画書|実装計画|## *plan/i;
            const planSet = new Set(oldMessages.filter(m => PLAN_RE.test(m.content || '')));

            // ~25% of the history budget (in chars; ~4 chars/token) for verbatim keeps.
            const VERBATIM_CHAR_BUDGET = Math.floor(historyBudget * 0.25 * 4);
            const preservedSet = new Set(planSet);
            let verbatimUsed = [...planSet].reduce((s, m) => s + (m.content || '').length, 0);

            const ranked = oldMessages
                .filter(m => !preservedSet.has(m))
                .map(m => ({ m, score: this._scoreMessageImportance(m) }))
                .sort((a, b) => b.score - a.score);
            for (const { m, score } of ranked) {
                if (score < 3) break;  // ranked desc — once below threshold, stop
                const len = (m.content || '').length;
                if (verbatimUsed + len > VERBATIM_CHAR_BUDGET) continue;
                preservedSet.add(m);
                verbatimUsed += len;
            }

            // Preserve chronological order; summarize only what we dropped.
            const preserved = oldMessages.filter(m => preservedSet.has(m));
            const toSummarize = oldMessages.filter(m => !preservedSet.has(m));

            let summary = '';
            if (toSummarize.length > 0) {
                const summaryPrompt = `Summarize the key points of the following conversation within 5 lines. Prioritize key decisions, code changes, and error details.\nDo NOT summarize file contents — those are preserved separately via the session file cache.\n\n${toSummarize.map(m => `[${m.role}]: ${(m.content || '').substring(0, 300)}`).join('\n\n')}`;
                const sumSys = 'You are a conversation summarizer. Output only the summary, nothing else.';
                const _t0 = Date.now();
                const gen = await LLMService.generate(summaryPrompt, sumSys, (chunk) => { summary += chunk; });
                // Surface this auxiliary LLM call in the task's Monitor logs so its
                // token cost is visible (it's billed to the same task, not free).
                if (onLog) {
                    try {
                        onLog({
                            method: 'CHAT', status: 200, duration: Date.now() - _t0,
                            stepLabel: '🗜 History Compaction',
                            usage: gen?.usage,
                            request: { purpose: 'history-compaction-summary', model: modelId, system_prompt: sumSys, prompt: summaryPrompt },
                            response: summary
                        });
                    } catch (_) {}
                }
            }
            if (keyInfo.length > 0) {
                summary += (summary ? '\n\n' : '') + 'Key Context:\n' + keyInfo.join('\n');
            }

            const compactedHistory = [];
            if (originalUserMsg) {
                compactedHistory.push(originalUserMsg);
            }
            if (summary) {
                compactedHistory.push(
                    { role: 'user', content: `[Past Conversation Summary]\n${summary}` },
                    { role: 'assistant', content: 'Understood. I have reviewed the past conversation summary and will keep the original goal in mind.' }
                );
            }
            // Re-inject the high-value messages (plan, decisions, key errors) verbatim.
            if (preserved.length > 0) {
                compactedHistory.push(...preserved);
                console.log(`AI Memory: Preserved ${preserved.length} high-value message(s) verbatim (${verbatimUsed} chars), summarized ${toSummarize.length}.`);
            }

            // ── Session file cache injection ──────────────────────────────────
            // Files read or written via read_file / write_file / multi_replace_file_content
            // during this session are stored in ToolExecutor._fileCache.  We re-inject
            // them here — sorted by priority — so the agent can continue working without
            // re-fetching files it already has.
            //
            // Priority order:
            //   1. Edited files (written/replaced this session) — most critical to keep
            //   2. High read-frequency files (read many times — agent treats them as anchors)
            //   3. Most-recently-read files
            //
            // Budget: ~20 KB of characters (~5 K tokens).  Files that don't fit are omitted;
            //   the agent can still read_file them if needed (it just costs one extra step).
            if (fileCache && fileCache.size > 0) {
                const FILE_CACHE_CHAR_BUDGET = 20_000;
                const MAX_LINES_PER_FILE    = 300;

                // Sort entries by priority
                const sorted = [...fileCache.entries()].sort(([, a], [, b]) => {
                    // Edited files always come first
                    const aEdited = !!a.editedAt;
                    const bEdited = !!b.editedAt;
                    if (aEdited !== bEdited) return aEdited ? -1 : 1;
                    // Among edited: most recently edited first
                    if (aEdited && bEdited) return (b.editedAt || 0) - (a.editedAt || 0);
                    // Among read-only: most reads first, then most recent read
                    if (a.readCount !== b.readCount) return (b.readCount || 0) - (a.readCount || 0);
                    return (b.readAt || 0) - (a.readAt || 0);
                });

                let charUsed = 0;
                const cacheSections = [];

                for (const [path, entry] of sorted) {
                    if (!entry.content) continue;
                    const label = entry.editedAt
                        ? `[EDITED this session — most recent version]`
                        : `[Read ${entry.readCount}x this session]`;

                    const lines = entry.content.split('\n');
                    const truncated = lines.length > MAX_LINES_PER_FILE;
                    const body = truncated
                        ? lines.slice(0, MAX_LINES_PER_FILE).join('\n') +
                          `\n... [${lines.length - MAX_LINES_PER_FILE} more lines omitted — call read_file for the full file]`
                        : entry.content;

                    const section = `--- ${path} ${label} ---\n${body}`;
                    if (charUsed + section.length > FILE_CACHE_CHAR_BUDGET) break;
                    cacheSections.push(section);
                    charUsed += section.length;
                }

                if (cacheSections.length > 0) {
                    compactedHistory.push({
                        role: 'user',
                        content: `[Session File Cache — restored after context compaction]\n` +
                            `These files were already read/written earlier in this session. ` +
                            `Use this cached content directly — do NOT call read_file for files listed here ` +
                            `unless you need lines beyond the truncation point.\n\n` +
                            cacheSections.join('\n\n')
                    });
                    compactedHistory.push({
                        role: 'assistant',
                        content: 'Understood — I have the session file cache. ' +
                            `I will use the ${cacheSections.length} cached file(s) directly ` +
                            'and only call read_file if I need content past the truncation point.'
                    });
                }

                console.log(`AI Memory: Injected ${cacheSections.length}/${fileCache.size} file(s) from session cache (${charUsed} chars).`);
            }

            compactedHistory.push(...recentMessages);

            console.log(`AI Memory: Compacted ${oldMessages.length} messages into summary. New history: ${compactedHistory.length} messages.`);
            return compactedHistory;
        } catch (e) {
            console.warn('AI Memory: Compaction failed, using truncated history:', e);
            const fallbackHistory = [];
            if (originalUserMsg) fallbackHistory.push(originalUserMsg);
            fallbackHistory.push(...recentMessages);
            return fallbackHistory;
        }
    }

    /**
     * Score a conversation message's importance for compaction (higher = keep
     * verbatim). Heuristic, no LLM call. Rewards plans, decisions, errors, file
     * modifications, and genuine user instructions; penalizes bulky tool-result
     * dumps and system nudges that add little once summarized.
     * @param {{role:string, content:string}} msg
     * @returns {number}
     */
    _scoreMessageImportance(msg) { return scoreMessageImportance(msg); }

    /**
     * Score a memory entry's relevance to the current query (0–1).
     * Uses simple keyword overlap — no external calls needed.
     * Higher = more relevant.
     */
    _relevanceScore(entry, query) { return relevanceScore(entry, query); }

    /**
     * Returns a context string for injection into the AI system prompt.
     * @param {string} [currentQuery] - Optional current task text for relevance scoring.
     *   When provided, entries are ranked by relevance; the top-3 are injected.
     *   Without it, falls back to the most recent 3 entries (original behaviour).
     */
    getPromptContext(currentQuery = '') {
        const factsSection = this._getFactsContext(currentQuery);

        if (!this.entries || this.entries.length === 0) {
            return factsSection;
        }

        let selected;
        if (currentQuery && this.entries.length > 3) {
            // Score all entries, pick top 3 by relevance (ties broken by recency).
            const scored = this.entries.map((e, idx) => ({
                entry: e,
                score: this._relevanceScore(e, currentQuery),
                idx   // preserve original order for tie-breaking
            }));
            scored.sort((a, b) => b.score - a.score || b.idx - a.idx);
            selected = scored.slice(0, 3).map(s => s.entry);
            // Re-sort by date so the context reads chronologically.
            selected.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        } else {
            selected = this.entries.slice(-3);
        }

        const memoryText = selected.map(e => {
            if (e.topic && e.summary) {
                const outcomeIcon = e.outcome === 'success' ? '✅' : (e.outcome === 'error' ? '❌' : '⚠️');
                const actionsStr = (e.actions && e.actions.length > 0) ? `\n  Actions: ${e.actions.join(' → ')}` : '';
                const filesStr = (e.keyFiles && e.keyFiles.length > 0) ? `\n  Files: ${e.keyFiles.join(', ')}` : '';
                return `[${e.date}] ${outcomeIcon} ${e.topic}${actionsStr}${filesStr}\n  Outcome summary: ${this._sanitizeXmlTags(e.summary)}`;
            }
            const cleanQuery = this._sanitizeXmlTags(e.query || '');
            const cleanSummary = this._sanitizeXmlTags(e.summary || '');
            return `[${e.date}] Q: ${cleanQuery}\nA: ${cleanSummary}`;
        }).join('\n---\n');

        return `${factsSection}\n[Past Conversation Memory (Top ${selected.length} relevant sessions)]\n${memoryText}\n`;
    }

    /**
     * Build the "Durable Facts" prompt section from the curated facts store,
     * ranked by relevance to the current query (keyword overlap), then recency.
     * Returns '' when there are no facts. Bumps hit counts on injected facts so
     * frequently-relevant facts resist pruning (not persisted here — saved on
     * the next addEntry).
     */
    _getFactsContext(currentQuery = '', limit = 5) {
        // Selection/ranking → ./memory/FactStore.js (unit-tested); formatting stays here.
        const top = selectRelevantFacts(this.facts, currentQuery, limit);
        if (top.length === 0) return '';
        const lines = top.map(f => `  • ${sanitizeXmlTags(f.fact)}`).join('\n');
        return `\n[Durable Project Facts (long-term memory)]\n${lines}\n`;
    }
}

export const conversationMemory = new ConversationMemory();
