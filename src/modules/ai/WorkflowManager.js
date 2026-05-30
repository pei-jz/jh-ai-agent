export const WorkflowPhases = {
    RESEARCH: 'research',
    PLANNING: 'planning',
    EXECUTION: 'execution',
    DEBUGGING: 'debugging',
    VERIFICATION: 'verification'
};

const STAGES = [
    {
        id: WorkflowPhases.RESEARCH,
        name: 'Researching',
        icon: '🔍',
        instruction: "Investigate the codebase to identify requirements and target implementation files. To avoid redundant file reads, document findings in the 'task_plan.md' artifact.",
        recommendedTools: ['list_files', 'read_file', 'grep_search', 'glob']
    },
    {
        id: WorkflowPhases.PLANNING,
        name: 'Planning',
        icon: '📋',
        instruction: "Formulate a concrete implementation plan. Create or update the 'task_plan.md' artifact to record findings and outline changes.",
        recommendedTools: ['task_progress', 'create_artifact', 'update_artifact']
    },
    {
        id: WorkflowPhases.EXECUTION,
        name: 'Executing',
        icon: '🚀',
        instruction: 'Implement the planned changes by writing/modifying code files.',
        recommendedTools: ['write_file', 'multi_replace_file_content']
    },
    {
        id: WorkflowPhases.DEBUGGING,
        name: 'Debugging',
        icon: '🐛',
        instruction: 'An error or unexpected issue has occurred. Focus on resolving the immediate issue while keeping the original goal in mind, then return to Executing.',
        recommendedTools: ['run_command', 'read_file', 'grep_search']
    },
    {
        id: WorkflowPhases.VERIFICATION,
        name: 'Verifying',
        icon: '✅',
        instruction: 'Verify your changes by running tests, linters, or builders (e.g., npm test, cargo check). Self-correct if failures are detected, and only report completion once all tests pass.',
        recommendedTools: ['run_command']
    }
];

class WorkflowManager {
    constructor() {
        this.currentPhase = WorkflowPhases.RESEARCH;
        this.onPhaseChange = null;
    }

    setPhase(phaseId) {
        if (this.currentPhase !== phaseId) {
            this.currentPhase = phaseId;
            this.onPhaseChange?.(this.getStageInfo());
        }
    }

    getStageInfo() {
        return STAGES.find(s => s.id === this.currentPhase);
    }

    getAllStages() {
        return STAGES;
    }

    /**
     * Heuristically determines the next phase based on the tool being used.
     */
    autoAdvance(toolName) {
        if (['task_progress', 'create_artifact', 'update_artifact'].includes(toolName)) {
            this.setPhase(WorkflowPhases.PLANNING);
        } else if (['write_file', 'multi_replace_file_content'].includes(toolName)) {
            this.setPhase(WorkflowPhases.EXECUTION);
        } else if (['run_command'].includes(toolName)) {
            this.setPhase(WorkflowPhases.VERIFICATION);
        }
    }

    getPromptContext() {
        const stage = this.getStageInfo();
        return `
[Current Phase: ${stage.name}]
Instruction: ${stage.instruction}
Recommended Tools: ${stage.recommendedTools.join(', ')}
`;
    }
}

export const workflowManager = new WorkflowManager();
