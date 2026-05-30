const API_LOG_KEY = 'jh_api_logs';
const MAX_LOGS = 1000;

export const ApiLogStore = {
    save(log) {
        try {
            const logs = this.getAll();
            logs.unshift(log); // newest first
            if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
            localStorage.setItem(API_LOG_KEY, JSON.stringify(logs));
        } catch (e) {
            console.error('ApiLogStore.save failed:', e);
        }
    },

    getAll() {
        try {
            return JSON.parse(localStorage.getItem(API_LOG_KEY) || '[]');
        } catch {
            return [];
        }
    },

    clear() {
        localStorage.removeItem(API_LOG_KEY);
    },

    /**
     * Remove API logs whose `timestamp` falls inside [startIso, endIso].
     * Used when a task is deleted from history — the agent's LLM calls happened
     * during that window, so they should be cleaned up alongside the task.
     * Returns the number of logs removed.
     */
    removeInRange(startIso, endIso) {
        try {
            const logs = this.getAll();
            const start = startIso ? new Date(startIso).getTime() : 0;
            const end   = endIso   ? new Date(endIso).getTime()   : Date.now();
            if (Number.isNaN(start) || Number.isNaN(end)) return 0;

            const kept = logs.filter(log => {
                if (!log.timestamp) return true; // keep logs without a timestamp
                const t = new Date(log.timestamp).getTime();
                if (Number.isNaN(t)) return true;
                // remove logs that fall inside the task's lifespan
                return !(t >= start && t <= end);
            });

            const removed = logs.length - kept.length;
            if (removed > 0) {
                localStorage.setItem(API_LOG_KEY, JSON.stringify(kept));
            }
            return removed;
        } catch (e) {
            console.error('ApiLogStore.removeInRange failed:', e);
            return 0;
        }
    }
};
