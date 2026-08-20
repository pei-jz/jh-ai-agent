<!--
  ScheduleDetail — the right panel: the editor for one schedule.

  Replaces `_renderDetail` + `_bindDetail`, where the form's state lived in the
  DOM and Save read it back out with a dozen `getElementById(...).value` calls.
  Two things went wrong with that shape and are structurally impossible here:

    • the four schedule types shared one `time` input plus a second hidden one for
      monthly, so Save had to know which of the two to read — and reading the
      wrong one silently saved 09:00;
    • toggling a type flipped five `style.display` assignments by hand, so a new
      type meant remembering all five.

  The edited schedule is a LOCAL copy. The parent only hears about it on save,
  which is what makes "unsaved draft" a real state rather than a label.
-->
<script>
    import {
        DAY_LABELS, INTERVAL_OPTIONS, DOM_OPTIONS, SCHEDULE_TYPES,
        domLabel, nextRunText, toDatetimeLocal, usesWeekdays,
    } from '../../views/schedule/scheduleModel.js';

    let {
        /** The schedule to edit, or null for the empty state. */
        schedule = null,
        /** True when `schedule` is the unsaved draft. */
        isDraft = false,
        agentModes = [],
        defaultModeId = '',
        mcpServers = [],
        running = false,
        onSave = null,
        onRunNow = null,
        onDelete = null,
        now = null,
    } = $props();

    // A working copy, re-seeded whenever the selection changes. `$derived` on the
    // id (not the object) so typing in the form does not reset it.
    let form = $state(null);
    let seededId = $state(null);
    $effect(() => {
        if (!schedule) { form = null; seededId = null; return; }
        if (seededId !== schedule.id) {
            form = {
                ...schedule,
                days: [...(schedule.days || [1, 2, 3, 4, 5])],
                mcpServers: [...(schedule.mcpServers || [])],
                scheduleType: schedule.scheduleType || 'fixed',
                time: schedule.time || '09:00',
                dayOfMonth: String(schedule.dayOfMonth ?? 1),
                intervalMinutes: schedule.intervalMinutes || 60,
                agentModeId: schedule.agentModeId || defaultModeId,
                onceAtLocal: toDatetimeLocal(schedule.onceAt),
            };
            seededId = schedule.id;
        }
    });

    const toggleDay = (i) => {
        const set = new Set(form.days);
        if (set.has(i)) set.delete(i); else set.add(i);
        form.days = [...set].sort((a, b) => a - b);
    };

    const toggleMcp = (name) => {
        const set = new Set(form.mcpServers);
        if (set.has(name)) set.delete(name); else set.add(name);
        form.mcpServers = [...set];
    };

    function save() {
        onSave?.({
            ...form,
            dayOfMonth: form.dayOfMonth,
            intervalMinutes: parseInt(form.intervalMinutes) || 60,
            onceAt: form.onceAtLocal ? new Date(form.onceAtLocal).toISOString() : null,
        });
    }

    const recentRuns = $derived((schedule?.runs || []).slice(-5).reverse());
</script>

<div class="sch-detail-panel">
    {#if !form}
        <div class="sch-detail-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="4" width="18" height="18" rx="2"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <h3>Select a schedule</h3>
            <p>Pick one from the list, or create one with "+ New"</p>
        </div>
    {:else}
        <div class="sch-detail-header">
            <span>{form.name || '(untitled)'}</span>
            <span class="sch-detail-next">Next: {nextRunText(form, now || new Date())}</span>
        </div>

        <div class="sch-detail-body">
            <div class="sch-field">
                <label for="sch-name">Name</label>
                <input id="sch-name" type="text" class="sch-input" bind:value={form.name}
                    placeholder="Schedule name (optional)">
            </div>

            <div class="sch-field">
                <label for="sch-prompt">Prompt / task instruction</label>
                <textarea id="sch-prompt" class="sch-textarea" rows="4" bind:value={form.prompt}></textarea>
            </div>

            <div class="sch-field">
                <label for="sch-agent-mode">Agent mode</label>
                <select id="sch-agent-mode" class="sch-select" bind:value={form.agentModeId}>
                    {#each agentModes as m}
                        <option value={m.id}>{m.label} — {m.description}</option>
                    {/each}
                </select>
            </div>

            <div class="sch-field">
                <span class="sch-label">MCP Servers
                    {#if mcpServers.length}<span class="sch-label-note">(none selected = use all)</span>{/if}
                </span>
                {#if mcpServers.length === 0}
                    <div class="sch-note">No MCP servers configured. You can add them in Settings.</div>
                {:else}
                    <div class="sch-mcp-box">
                        {#each mcpServers as name}
                            <label class="sch-check">
                                <input type="checkbox" checked={form.mcpServers.includes(name)}
                                    onchange={() => toggleMcp(name)}>
                                <span>{name}</span>
                            </label>
                        {/each}
                    </div>
                {/if}
            </div>

            <div class="sch-field">
                <span class="sch-label">Schedule type</span>
                <div class="sch-type-group">
                    {#each SCHEDULE_TYPES as t}
                        <button type="button" class="sch-type-btn" class:selected={form.scheduleType === t.id}
                            onclick={() => (form.scheduleType = t.id)}>{t.label}</button>
                    {/each}
                </div>
            </div>

            <!-- Each type owns its OWN inputs; nothing is hidden-but-read. -->
            {#if form.scheduleType === 'monthly'}
                <div class="sch-field">
                    <label for="sch-dom">Day of the month</label>
                    <div class="sch-time-row">
                        <select id="sch-dom" class="sch-select sch-select-auto" bind:value={form.dayOfMonth}>
                            {#each DOM_OPTIONS as v}<option value={v}>{domLabel(v)}</option>{/each}
                        </select>
                        <input type="time" class="sch-time-input" bind:value={form.time}>
                    </div>
                    <div class="sch-note">
                        A day past the end of a short month runs on that month's last day — "31" still runs in February.
                    </div>
                </div>
            {:else if form.scheduleType === 'fixed'}
                <div class="sch-field">
                    <label for="sch-time">Run time</label>
                    <div class="sch-time-row">
                        <input id="sch-time" type="time" class="sch-time-input" bind:value={form.time}>
                        <span class="sch-note">at this time on the selected weekdays</span>
                    </div>
                </div>
            {:else if form.scheduleType === 'interval'}
                <div class="sch-field">
                    <label for="sch-interval">Interval</label>
                    <select id="sch-interval" class="sch-select" bind:value={form.intervalMinutes}>
                        {#each INTERVAL_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
                    </select>
                </div>
            {:else if form.scheduleType === 'once'}
                <div class="sch-field">
                    <label for="sch-once">Run at (once)</label>
                    <input id="sch-once" type="datetime-local" class="sch-datetime-input" bind:value={form.onceAtLocal}>
                </div>
            {/if}

            {#if usesWeekdays(form.scheduleType)}
                <div class="sch-field">
                    <span class="sch-label">Run on days</span>
                    <div class="sch-days-picker">
                        {#each DAY_LABELS as d, i}
                            <button type="button" class="sch-day-btn" class:selected={form.days.includes(i)}
                                onclick={() => toggleDay(i)}>{d}</button>
                        {/each}
                    </div>
                </div>
            {/if}

            <div class="sch-field">
                <span class="sch-label">Enabled / stopped</span>
                <div class="sch-toggle-row">
                    <label class="sch-toggle">
                        <input type="checkbox" bind:checked={form.enabled}>
                        <div class="sch-toggle-track"><div class="sch-toggle-thumb"></div></div>
                    </label>
                    <span class="sch-toggle-label">
                        {form.enabled ? 'Enabled — runs automatically at the set time' : 'Stopped'}
                    </span>
                </div>
            </div>

            <div class="sch-field">
                <span class="sch-label">Recent runs</span>
                <div class="sch-run-history">
                    {#if recentRuns.length === 0}
                        <div class="sch-run-row sch-run-none">No run history</div>
                    {:else}
                        {#each recentRuns as r}
                            <div class="sch-run-row">
                                <span class="sch-run-dot" class:ok={r.status === 'completed'}></span>
                                <span>{new Date(r.at).toLocaleString()}</span>
                                <span class="sch-run-status" class:ok={r.status === 'completed'}>{r.status}</span>
                            </div>
                        {/each}
                    {/if}
                </div>
            </div>
        </div>

        <div class="sch-actions">
            <button type="button" class="btn btn-primary" onclick={save}>Save</button>
            <button type="button" class="btn btn-secondary" disabled={running || isDraft}
                onclick={() => onRunNow?.(form)}>{running ? 'Running…' : 'Run now'}</button>
            <button type="button" class="btn btn-error sch-delete" onclick={() => onDelete?.()}>Delete</button>
        </div>
    {/if}
</div>

<style>
    .sch-detail-panel {
        flex: 1;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .sch-detail-header {
        padding: 10px 16px;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .sch-detail-next { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--text-tertiary); }
    .sch-detail-body {
        flex: 1;
        overflow-y: auto;
        padding: 20px 24px;
        display: flex;
        flex-direction: column;
        gap: 18px;
    }
    .sch-field { display: flex; flex-direction: column; gap: 6px; }
    .sch-field label, .sch-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
    }
    .sch-label-note { font-weight: 400; text-transform: none; font-size: 10px; color: var(--text-tertiary); }
    .sch-note { font-size: 11px; color: var(--text-tertiary); }
    .sch-input, .sch-textarea, .sch-select {
        background: var(--bg-input);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 13px;
        padding: 9px 12px;
        outline: none;
        font-family: var(--font-sans);
        transition: border-color 0.15s;
    }
    .sch-input:focus, .sch-textarea:focus, .sch-select:focus { border-color: var(--accent); }
    .sch-textarea { resize: vertical; min-height: 80px; }
    .sch-select { cursor: pointer; }
    .sch-select-auto { width: auto; }

    .sch-mcp-box {
        background: var(--bg-input);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 6px 12px;
    }
    .sch-check {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 0; cursor: pointer;
        font-size: 13px; color: var(--text-primary);
        font-weight: 400; text-transform: none; letter-spacing: 0;
    }
    .sch-check input { accent-color: var(--accent); width: 14px; height: 14px; cursor: pointer; }

    .sch-type-group { display: flex; gap: 6px; }
    .sch-type-btn {
        flex: 1;
        padding: 7px 10px;
        border-radius: 6px;
        border: 1.5px solid var(--border);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .sch-type-btn.selected { background: var(--accent); border-color: var(--accent); color: var(--text-inverse); }

    .sch-time-row { display: flex; align-items: center; gap: 12px; }
    .sch-time-input {
        background: var(--bg-input);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 16px;
        font-family: var(--font-mono);
        font-weight: 700;
        padding: 8px 14px;
        outline: none;
        width: 120px;
    }
    .sch-time-input:focus { border-color: var(--accent); }
    .sch-datetime-input {
        background: var(--bg-input);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 14px;
        font-family: var(--font-mono);
        padding: 8px 12px;
        outline: none;
        width: 100%;
        box-sizing: border-box;
    }
    .sch-datetime-input:focus { border-color: var(--accent); }

    .sch-days-picker { display: flex; gap: 6px; }
    .sch-day-btn {
        width: 34px; height: 34px;
        border-radius: 50%;
        border: 1.5px solid var(--border);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
        display: flex; align-items: center; justify-content: center;
    }
    .sch-day-btn.selected { background: var(--accent); border-color: var(--accent); color: var(--text-inverse); }

    .sch-toggle-row { display: flex; align-items: center; gap: 10px; }
    .sch-toggle { position: relative; width: 42px; height: 24px; flex-shrink: 0; }
    .sch-toggle input { opacity: 0; width: 0; height: 0; }
    .sch-toggle-track {
        position: absolute;
        inset: 0;
        background: var(--bg-tertiary);
        border-radius: 12px;
        border: 1px solid var(--border);
        cursor: pointer;
        transition: background 0.2s;
    }
    .sch-toggle input:checked ~ .sch-toggle-track { background: var(--accent); border-color: var(--accent); }
    .sch-toggle-thumb {
        position: absolute;
        top: 3px; left: 3px;
        width: 16px; height: 16px;
        background: white;
        border-radius: 50%;
        transition: transform 0.2s;
        pointer-events: none;
    }
    .sch-toggle input:checked ~ .sch-toggle-track .sch-toggle-thumb { transform: translateX(18px); }
    .sch-toggle-label { font-size: 13px; color: var(--text-secondary); }

    .sch-actions {
        display: flex; gap: 10px;
        padding: 16px 24px;
        border-top: 1px solid var(--border-light);
        flex-shrink: 0;
    }
    .sch-delete { margin-left: auto; }

    .sch-detail-empty {
        flex: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        color: var(--text-tertiary);
    }
    .sch-detail-empty svg { width: 40px; height: 40px; margin-bottom: 12px; opacity: 0.4; }
    .sch-detail-empty h3 { margin: 0 0 6px; font-size: 15px; }
    .sch-detail-empty p { font-size: 12px; margin: 0; }

    .sch-run-history {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-light);
        border-radius: var(--radius-sm);
        overflow: hidden;
    }
    .sch-run-row {
        display: flex; align-items: center; gap: 10px;
        padding: 7px 12px;
        border-bottom: 1px solid var(--border-light);
        font-size: 12px;
        color: var(--text-secondary);
    }
    .sch-run-row:last-child { border-bottom: none; }
    .sch-run-none { color: var(--text-tertiary); }
    .sch-run-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--error); }
    .sch-run-dot.ok { background: var(--success); }
    .sch-run-status { margin-left: auto; font-size: 11px; color: var(--error); }
    .sch-run-status.ok { color: var(--success); }
</style>
