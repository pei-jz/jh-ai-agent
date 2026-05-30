import { buildBehavior, DEFAULT_MODE_ID } from './AgentModes.js';

const SCHEDULE_KEY = 'jh_schedules';

class ScheduleManager {
    constructor() {
        this.schedules = [];
        this._pollTimer = null;
    }

    init() {
        this.reloadSchedules();
        // Poll every minute to auto-trigger due schedules
        this._pollTimer = setInterval(() => this.checkSchedules(), 60 * 1000);
        this.checkSchedules();
        console.log("[ScheduleManager] Background task scheduler initialized.");
    }

    destroy() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    reloadSchedules() {
        try {
            this.schedules = JSON.parse(localStorage.getItem(SCHEDULE_KEY) || '[]');
        } catch (e) {
            this.schedules = [];
        }
    }

    /**
     * Returns true if the schedule should fire at the given Date.
     * Supports scheduleType:
     *   "fixed"    — fire at s.time on s.days (original behavior)
     *   "interval" — fire every s.intervalMinutes minutes on s.days
     *   "once"     — fire once at s.onceAt (ISO datetime string), then auto-disable
     */
    _shouldFire(s, now) {
        if (!s.enabled || !s.prompt) return false;
        const type = s.scheduleType || 'fixed';

        if (type === 'once') {
            if (!s.onceAt) return false;
            const target = new Date(s.onceAt);
            // Match within the same minute
            return (
                target.getFullYear() === now.getFullYear() &&
                target.getMonth()    === now.getMonth()    &&
                target.getDate()     === now.getDate()     &&
                target.getHours()    === now.getHours()    &&
                target.getMinutes()  === now.getMinutes()
            );
        }

        const days = s.days || [1, 2, 3, 4, 5];
        if (!days.includes(now.getDay())) return false;

        if (type === 'interval') {
            const intervalMin = Math.max(1, parseInt(s.intervalMinutes) || 60);
            return now.getMinutes() % intervalMin === 0;
        }

        // fixed (default)
        const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        return s.time === hhmm;
    }

    async checkSchedules() {
        if (!window.apiClient) return;
        const now = new Date();

        let updated = false;

        for (const s of this.schedules) {
            if (!this._shouldFire(s, now)) continue;

            // Check if already ran in this minute
            const lastRun = (s.runs || []).slice(-1)[0];
            if (lastRun) {
                const last = new Date(lastRun.at);
                if (
                    last.getFullYear() === now.getFullYear() &&
                    last.getMonth()    === now.getMonth()    &&
                    last.getDate()     === now.getDate()     &&
                    last.getHours()    === now.getHours()    &&
                    last.getMinutes()  === now.getMinutes()
                ) {
                    continue;
                }
            }

            try {
                const mcpServers = s.mcpServers && s.mcpServers.length > 0 ? s.mcpServers : null;
                const behavior = {
                    mode: 'iterative_agent',
                    ...buildBehavior(s.agentModeId || DEFAULT_MODE_ID),
                    ...(mcpServers ? { mcp_servers: mcpServers } : {})
                };
                const task = await window.apiClient.request('/tasks', {
                    method: 'POST',
                    body: JSON.stringify({ prompt: s.prompt, workspace_path: null, caller: 'Schedule', behavior })
                });
                const taskId = task.task_id || task.id;
                s.runs = s.runs || [];
                s.runs.push({ at: now.toISOString(), status: 'completed', taskId });
                updated = true;
                // Auto-disable one-time schedules after firing
                if ((s.scheduleType || 'fixed') === 'once') {
                    s.enabled = false;
                }
                console.log(`[ScheduleManager] Triggered "${s.name || s.prompt.slice(0, 40)}" (mode: ${s.agentModeId || DEFAULT_MODE_ID}) → task ${taskId}`);
            } catch (err) {
                s.runs = s.runs || [];
                s.runs.push({ at: now.toISOString(), status: 'failed', error: err.message });
                updated = true;
                console.error(`[ScheduleManager] Trigger failed for "${s.name || s.prompt.slice(0, 40)}":`, err);
            }
        }

        if (updated) {
            localStorage.setItem(SCHEDULE_KEY, JSON.stringify(this.schedules));
            window.dispatchEvent(new CustomEvent('jh-schedules-updated'));
        }
    }
}

export const scheduleManager = new ScheduleManager();
