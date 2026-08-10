// toolLine — what a tool call acted on, as data rather than a sentence.
//
// The Task view had one function that turned a tool telemetry entry into a
// string ("✓ read_file: a.js"). A string is all the old feed needed, but a step
// now wants to offer the FILE it touched as something you can click — which
// means the path has to survive as a field, not be baked into prose.
//
// Pure: takes the tool name and its arguments, returns the parts.

/** Tools whose `path` argument names a file the user can open. */
const PATH_TOOLS = new Set([
    'read_file', 'write_file', 'replace_lines', 'multi_replace_file_content',
    'delete_file', 'verify_syntax', 'create_artifact', 'update_artifact',
    'read_office', 'write_xlsx', 'open_file',
]);

/** Tools that write, so the step can be marked as a change rather than a read. */
const WRITE_TOOLS = new Set([
    'write_file', 'replace_lines', 'multi_replace_file_content',
    'delete_file', 'move_file', 'create_artifact', 'update_artifact', 'write_xlsx',
]);

const basename = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();

/**
 * @param {string} name tool name
 * @param {object} req  the tool's arguments
 * @returns {{tool:string, path:string, label:string, write:boolean}}
 *   `path` is '' when the tool did not act on one file; `label` is the short
 *   human-readable target (a basename, a command, a query).
 */
export function toolTarget(name, req = {}) {
    const tool = String(name || 'tool');
    const args = req || {};
    let path = '';
    let label = '';

    if (tool === 'run_command') {
        label = String(args.command || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    } else if (PATH_TOOLS.has(tool)) {
        path = String(args.path || '');
        label = basename(path);
    } else if (tool === 'move_file') {
        path = String(args.to || args.from || '');
        label = basename(path);
    } else if (tool === 'grep_search' || tool === 'web_search') {
        label = String(args.query || '').slice(0, 40);
    } else if (tool === 'list_files' || tool === 'glob') {
        label = String(args.path || args.pattern || '').slice(0, 40);
    } else if (tool === 'read_resource') {
        label = String(args.uri || '').slice(0, 60);
    }

    return { tool, path, label, write: WRITE_TOOLS.has(tool) };
}

/**
 * The one-line sentence the activity feed shows.
 * `prefix` carries a forwarded sub-agent marker so a child's work stays
 * attributable ("🤖 [sub:reviewer#1] ✓ run_command: cargo build").
 */
export function toolLineText(name, req, { done = true, prefix = '' } = {}) {
    const { tool, label } = toolTarget(name, req);
    const mark = done ? '✓' : '⚙';
    const head = `${prefix ? prefix + ' ' : ''}${mark} ${tool}`;
    return label ? `${head}: ${label}` : head;
}
