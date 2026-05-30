import { invoke } from '@tauri-apps/api/core';

class ProjectContext {
    constructor() {
        this.fileList = [];
        this.projectSummary = '';
        this.lastScanTime = 0;
        this.isScanning = false;
        this.skills = [];
        this.workflows = [];
    }

    /**
     * Incrementally scan the project directory
     */
    async scanProject(workspacePath) {
        if (!workspacePath || this.isScanning) return;
        
        this.isScanning = true;
        try {
            console.log('AI: Scanning project context...');
            const startTime = Date.now();
            
            // Invoke recursive list from Rust backend
            const files = await invoke('read_dir', { path: workspacePath });
            this.fileList = files;
            this.projectSummary = this.generateSummary(files, workspacePath);
            
            // Load custom skills from .agent/skills.json
            await this.loadSkills(workspacePath);
            
            // Load available workflows
            await this.loadWorkflows(workspacePath);

            this.lastScanTime = Date.now();
            console.log(`AI: Project scan complete. Found ${files.length} files in ${Date.now() - startTime}ms.`);
        } catch (e) {
            console.error('AI: Project scan failed:', e);
        } finally {
            this.isScanning = false;
        }
    }

    async loadSkills(workspacePath) {
        if (!workspacePath) return;
        this.skills = [];
        this.markdownInstructions = '';
        
        // 1. Load legacy skills.json
        try {
            const path = `${workspacePath}/.agent/skills.json`;
            const fileData = await invoke('read_file', { path });
            if (fileData) {
                this.skills = JSON.parse(fileData);
                console.log(`AI: Loaded ${this.skills.length} project skills.`);
            }
        } catch (e) {}

        // 2. Load modern instructions.md (CLAUDE.md equivalent)
        try {
            const path = `${workspacePath}/.agent/instructions.md`;
            const fileData = await invoke('read_file', { path });
            if (fileData) {
                this.markdownInstructions = fileData;
                console.log(`AI: Loaded project instructions.md`);
            }
        } catch (e) {}
    }

    async loadWorkflows(workspacePath) {
        if (!workspacePath) return;
        try {
            const path = `${workspacePath}/.agent/workflows/index.json`;
            const fileData = await invoke('read_file', { path });
            if (fileData) {
                this.workflows = JSON.parse(fileData);
                console.log(`AI: Loaded ${this.workflows.length} project workflows.`);
            }
        } catch (e) {
            this.workflows = [];
        }
    }

    /**
     * Generate a text-based summary of the project structure
     */
    generateSummary(files, workspacePath) {
        if (files.length === 0) return 'Project is empty or not yet scanned.';
        
        const tree = {};
        files.forEach(f => {
            let rel = f.path;
            const root = workspacePath.replace(/\\/g, '/');
            const p = f.path.replace(/\\/g, '/');
            if (p.startsWith(root)) {
                rel = p.substring(root.length).replace(/^\//, '');
            }

            const parts = rel.split('/');
            if (parts.length > 1) {
                const dir = parts[0];
                tree[dir] = (tree[dir] || 0) + 1;
            } else {
                tree['/'] = (tree['/'] || 0) + 1;
            }
        });

        const structureSummary = Object.entries(tree)
            .map(([dir, count]) => `  - ${dir}/ (${count} files)`)
            .join('\n');

        // Identify important files
        const importantFiles = files.filter(f => {
            const name = f.name.toLowerCase();
            return name.includes('readme') || 
                   name === 'package.json' || 
                   name === 'cargo.toml' || 
                   name === 'index.html' ||
                   name === 'main.js' ||
                   name === 'app.js';
        }).map(f => f.path);

        return `Project Structure Overview:
${structureSummary}

Important Files:
${importantFiles.length > 0 ? importantFiles.map(p => `  - ${p}`).join('\n') : '  (None identified)'}
`;
    }

    /**
     * Returns a context string suitable for injection into AI system prompt
     */
    getPromptContext() {
        let context = '';
        if (this.projectSummary) {
            context += `\n[Project Structure Overview]\n${this.projectSummary}\n`;
        }

        if (this.skills && this.skills.length > 0) {
            const skillsText = this.skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
            context += `\n[Applicable Project Skills and Conventions (Legacy SKILLS)]\n${skillsText}\n`;
        }

        if (this.markdownInstructions) {
            context += `\n[Project Instructions and Guidelines (instructions.md)]\n${this.markdownInstructions}\n`;
        }

        return context;
    }
}

export const projectContext = new ProjectContext();
