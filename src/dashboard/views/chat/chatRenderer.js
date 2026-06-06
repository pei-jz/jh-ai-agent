// chatRenderer — pure message/step → HTML-string builders extracted from
// ChatView (Part A refactor). None touch the DOM (they only return strings that
// ChatView assigns to innerHTML), so they unit-test in node. ChatView keeps thin
// `_x()` wrappers that delegate here, so existing call sites are unchanged.

import { escapeHtml, formatMarkdown, formatMessageContent } from './chatMarkdown.js';
import { renderFileList } from '../../utils/resultView.js';

/** Extract a tool-call JSON object from an LLM response (fenced or bare). */
export function extractToolCall(response) {
    if (!response) return null;

    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[1]);
        } catch (e) {
            try {
                const cleanStr = jsonMatch[1].trim();
                return JSON.parse(cleanStr);
            } catch (e2) {}
        }
    }

    if (response.trim().startsWith('{') && response.trim().endsWith('}')) {
        try {
            return JSON.parse(response);
        } catch (e) {}
    }

    return null;
}

/** Parse an agent "thought" into structured { observe, plan, call, raw }. */
export function parseThought(raw) {
    if (!raw) return { observe: null, plan: null, call: null, raw: null };
    // Strip <thought> XML wrapper if present
    let text = raw.replace(/^[\s\S]*?<thought>([\s\S]*?)<\/thought>[\s\S]*$/, '$1').trim();
    if (!text) text = raw.trim();

    // Normalise pipe-separated format to newline-separated
    text = text.replace(/\s*\|\s*(OBSERVE|PLAN|CALL):/gi, '\n$1:');

    const get = (label) => {
        const re = new RegExp(`${label}:\\s*(.+?)(?=\\n(?:OBSERVE|PLAN|CALL):|$)`, 'is');
        const m = text.match(re);
        return m ? m[1].trim() : null;
    };
    const observe = get('OBSERVE');
    const plan    = get('PLAN');
    const call    = get('CALL');

    if (!observe && !plan && !call) {
        // Unstructured — treat whole string as raw plan text
        return { observe: null, plan: null, call: null, raw: text };
    }
    return { observe, plan, call, raw: null };
}

/**
 * Render accumulated agent steps as collapsible HTML blocks.
 * @param {Array}  steps        Completed steps [{thought, toolCalls, completed}]
 * @param {Object} currentStep  In-progress step (null when done)
 * @param {string} streamContent  Partial streaming text from the final response
 */
export function renderAgentSteps(steps, currentStep, streamContent) {
    const allSteps = currentStep ? [...steps, currentStep] : [...steps];
    let html = '';

    if (allSteps.length > 0) {
        html += '<div class="agent-steps-container">';
        allSteps.forEach((step, i) => {
            const isLast = i === allSteps.length - 1;
            const rawThought = step.thought
                ? (typeof step.thought === 'string' ? step.thought : JSON.stringify(step.thought))
                : null;

            const opc = parseThought(rawThought);

            // Summary line shown in the collapsed header:
            // prefer PLAN (what's being done), else OBSERVE, else tool names
            const summaryBase = opc.plan || opc.observe || opc.raw
                || (step.toolCalls.length > 0 ? step.toolCalls.map(tc => tc.name).join(', ') : 'Processing…');
            const summary = summaryBase.replace(/^\[[\w\s\/]+\]\s*/, '').substring(0, 80)
                + (summaryBase.length > 80 ? '…' : '');

            html += `<details class="agent-step-block"${isLast ? ' open' : ''}>`;
            html += `<summary><span class="agent-step-num">Step ${i + 1}</span>`;
            html += `<span class="agent-step-label">${escapeHtml(summary)}</span></summary>`;
            html += `<div class="agent-step-body">`;

            // Structured OBSERVE / PLAN / CALL display
            if (opc.observe || opc.plan || opc.call) {
                html += `<div class="agent-opc">`;
                if (opc.observe) {
                    html += `<div class="agent-opc-row"><span class="agent-opc-label observe">Observe</span><span class="agent-opc-text">${escapeHtml(opc.observe)}</span></div>`;
                }
                if (opc.plan) {
                    html += `<div class="agent-opc-row"><span class="agent-opc-label plan">Plan</span><span class="agent-opc-text">${escapeHtml(opc.plan)}</span></div>`;
                }
                if (opc.call) {
                    html += `<div class="agent-opc-row"><span class="agent-opc-label call">Call</span><span class="agent-opc-text">${escapeHtml(opc.call)}</span></div>`;
                }
                html += `</div>`;
            } else if (opc.raw) {
                // Unstructured thought — show as plain text
                html += `<div class="agent-thought-text">${escapeHtml(opc.raw)}</div>`;
            }

            // Tool call badges
            step.toolCalls.forEach(tc => {
                const icon = tc.status === 'running' ? '⏳' : tc.status === 'error' ? '❌' : '✅';
                html += `<div class="agent-tool-badge">${icon} ${escapeHtml(tc.name)}</div>`;
            });

            html += `</div></details>`;
        });
        html += '</div>';
    }

    if (streamContent) {
        html += `<div class="agent-final-content">${formatMarkdown(streamContent)}</div>`;
    } else if (allSteps.length === 0) {
        html = '<em>🤖 Agent starting…</em>';
    }

    return html;
}

/** Render a single chat message to an HTML string (user/assistant/tool bubbles). */
export function renderMessageHtml(msg) {
    // Tool call bubble
    if (msg.isToolCall) {
        const toolCalls = msg.toolCalls || [];
        let thoughtsHtml = '';
        const parsed = extractToolCall(msg.content);
        if (parsed && parsed.thought) {
            thoughtsHtml = `
                <details class="thought-process-block" open>
                    <summary>思考プロセス（ツール選択）</summary>
                    <div class="thought-process-content">${formatMarkdown(parsed.thought)}</div>
                </details>
            `;
        }
        return `
            <div class="chat-message-row msg-ai" style="width: 100%;">
                <div class="message-bubble" style="background: var(--bg-secondary); border-color: var(--border-light); max-width: 85%; width: 100%; border-radius: 12px 12px 12px 2px; padding: 12px 16px; margin-bottom: 8px;">
                    ${thoughtsHtml}
                    <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--accent); margin-bottom: 8px;">
                        <span>🛠️ ツール呼び出し中</span>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        ${toolCalls.map(tc => `
                            <div style="background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px;">
                                <div style="font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; color: var(--text-primary);">${escapeHtml(tc.name)}</div>
                                <pre style="margin: 4px 0 0 0; background: var(--bg-primary); padding: 6px; border-radius: 4px; overflow-x: auto; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-secondary);"><code>${escapeHtml(JSON.stringify(tc.args, null, 2))}</code></pre>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
    }

    // Tool result bubble
    if (msg.isToolResult) {
        const results = msg.results || [];
        return `
            <div class="chat-message-row msg-user" style="width: 100%; justify-content: flex-end;">
                <div class="message-bubble" style="background: hsla(185, 100%, 55%, 0.03); border-color: var(--border-light); max-width: 85%; width: 100%; border-radius: 12px 12px 2px 12px; padding: 10px 14px; margin-bottom: 8px;">
                    <details style="outline: none;">
                        <summary style="cursor: pointer; font-size: 12.5px; font-weight: 500; color: var(--text-secondary); user-select: none;">
                            ➜ ツール実行結果 (${results.length}件)
                        </summary>
                        <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 8px;">
                            ${results.map(r => {
                                const isErr = typeof r.result === 'string' && r.result.startsWith('Error');
                                return `
                                    <div style="border-top: 1px solid var(--border-light); padding-top: 8px;">
                                        <div style="font-size: 11.5px; font-weight: 600; color: ${isErr ? 'var(--error)' : 'var(--text-secondary)'}; margin-bottom: 4px;">
                                            <strong>${escapeHtml(r.tool_call_name)}</strong> の結果:
                                        </div>
                                        <pre style="margin: 0; background: var(--bg-primary); padding: 8px; border-radius: 6px; overflow-x: auto; font-family: var(--font-mono); font-size: 11.5px; color: ${isErr ? 'var(--error)' : 'var(--text-primary)'}; white-space: pre-wrap; max-height: 250px; overflow-y: auto;"><code>${escapeHtml(typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2))}</code></pre>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </details>
                </div>
            </div>
        `;
    }

    // Regular user / assistant bubble
    const isUser = msg.role === 'user';
    let attachmentsHtml = '';

    if (msg.images && msg.images.length > 0) {
        attachmentsHtml += `<div class="chat-bubble-images" style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">`;
        msg.images.forEach(imgUrl => {
            attachmentsHtml += `<img class="chat-zoomable-img" src="${imgUrl}" style="max-height: 180px; max-width: 100%; border-radius: 6px; border: 1px solid var(--border); cursor: pointer;">`;
        });
        attachmentsHtml += `</div>`;
    }

    if (msg.files && msg.files.length > 0) {
        attachmentsHtml += `<div class="chat-bubble-files" style="display: flex; flex-direction: column; gap: 4px; margin-top: 8px;">`;
        msg.files.forEach(f => {
            attachmentsHtml += `
                <div style="display: flex; align-items: center; gap: 8px; background: var(--bg-tertiary); border: 1px solid var(--border); padding: 6px 12px; border-radius: 6px; font-size: 12px; width: fit-content;">
                    <span>📄</span>
                    <span style="font-weight: 500;">${escapeHtml(f.name)}</span>
                    <span style="color: var(--text-tertiary); font-size: 11px;">(${(f.size / 1024).toFixed(1)} KB)</span>
                </div>
            `;
        });
        attachmentsHtml += `</div>`;
    }

    if (msg.skills && msg.skills.length > 0) {
        attachmentsHtml += `<div class="chat-bubble-skills" style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">`;
        msg.skills.forEach(s => {
            attachmentsHtml += `<span class="skill-chip skill-chip-static" title="Skill: ${escapeHtml(s.name)}"><span class="skill-chip-icon">⚡</span><span class="skill-chip-label">${escapeHtml(s.title || s.name)}</span></span>`;
        });
        attachmentsHtml += `</div>`;
    }

    // Created/modified files from a completed agent turn (clicks open via the
    // delegated [data-open-path] handler on the chat container).
    if (!isUser && msg.resultFiles && msg.resultFiles.length > 0) {
        attachmentsHtml += renderFileList(msg.resultFiles);
    }

    const mainContentHtml = isUser ? formatMarkdown(msg.displayContent || msg.content) : formatMessageContent(msg.content);
    const isError = msg.isError;
    const bubbleStyle = isError ? 'border-style: solid; border-color: var(--error); background: var(--error-bg);' : '';
    const contentStyle = isError ? 'color: var(--error); font-weight: 500;' : '';

    return `
        <div class="chat-message-row ${isUser ? 'msg-user' : 'msg-ai'}">
            <div class="message-bubble" style="${bubbleStyle}">
                <div class="message-content" style="${contentStyle}">${mainContentHtml}</div>
                ${attachmentsHtml}
            </div>
        </div>
    `;
}
