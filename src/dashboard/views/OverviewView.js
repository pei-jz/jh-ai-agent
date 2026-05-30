export class OverviewView {
    constructor() {
        this.stats = { totalTasks: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCost: 0.0 };
        this.activeTasks = [];
    }

    async loadData() {
        try {
            if (window.apiClient) {
                this.stats = await window.apiClient.getStats();
                const tasks = await window.apiClient.listTasks();
                this.activeTasks = tasks.filter(t => t.status === 'running');
            }
        } catch (e) {
            console.error("Failed to load overview data:", e);
        }
    }

    async render() {
        await this.loadData();

        const taskCards = this.activeTasks.length > 0 
            ? this.activeTasks.map(task => `
                <a href="#monitor?id=${task.id}" class="card active-task-card" style="text-decoration: none; color: inherit; display: block; cursor: pointer; transition: transform var(--transition-fast), border-color var(--transition-fast);">
                    <div class="task-card-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="task-badge badge-active">Active</span>
                            <span class="task-id">#${task.id.slice(0, 8)}</span>
                        </div>
                        ${task.caller ? `<span class="task-caller" style="font-size: 11px; background: var(--accent-glow); color: var(--accent); padding: 2px 6px; border-radius: 4px; font-weight: 600;">From: ${escapeHtml(task.caller)}</span>` : ''}
                    </div>
                    <p class="task-prompt" style="margin-bottom: 16px; font-weight: 500; font-size: 13px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; height: 3.8em;">${escapeHtml(task.prompt)}</p>
                    <div class="progress-bar-container" style="background: var(--bg-tertiary); border-radius: 4px; overflow: hidden; height: 6px; margin-bottom: 12px;">
                        <div class="progress-bar" style="width: ${task.progress * 100}%; background: linear-gradient(90deg, var(--accent-dim), var(--accent)); height: 100%;"></div>
                    </div>
                    <div class="task-card-footer" style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary);">
                        <span>Tokens: ${task.token_usage.total_tokens}</span>
                        <span>Progress: ${Math.round(task.progress * 100)}%</span>
                    </div>
                </a>
            `).join('')
            : `
                <div class="empty-state">
                    <div class="empty-state-icon">💤</div>
                    <h3>No Active Tasks</h3>
                    <p>Start an agent process from JHEditor or JH Project Manager to see it here.</p>
                </div>
            `;

        return `
            <div class="view-container">
                <div class="view-header">
                    <div>
                        <h1>Agent Dashboard</h1>
                        <p class="subtitle">Overview of current activity and token consumption</p>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="card stat-card">
                        <span class="stat-icon">📈</span>
                        <div class="stat-content">
                            <span class="stat-label">Total Tasks</span>
                            <span class="stat-value">${this.stats.totalTasks}</span>
                        </div>
                    </div>
                    <div class="card stat-card">
                        <span class="stat-icon">🪙</span>
                        <div class="stat-content">
                            <span class="stat-label">Total Tokens</span>
                            <span class="stat-value">${this.stats.totalTokens.toLocaleString()}</span>
                        </div>
                    </div>
                    <div class="card stat-card">
                        <span class="stat-icon">💰</span>
                        <div class="stat-content">
                            <span class="stat-label">Estimated Cost</span>
                            <span class="stat-value">$${this.stats.estimatedCost.toFixed(5)}</span>
                        </div>
                    </div>
                </div>

                <div class="dashboard-section">
                    <h2>Active Agents</h2>
                    <div class="active-tasks-grid">
                        ${taskCards}
                    </div>
                </div>
            </div>
        `;
    }

    init() {
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
}
