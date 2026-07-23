// gitStatusParse — pure helpers for turning `git status --porcelain=v2 --branch`
// output into a human-readable file list for the commit-confirmation dialog.
//
// Porcelain v2 line kinds we care about (the leading token):
//   `1` changed          : 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//   `2` renamed/copied   : 2 <XY> … <Xscore> <path>\t<origPath>   (path = new name)
//   `u` unmerged         : u <XY> … <path>
//   `?` untracked        : ? <path>
// Header lines start with `#` (branch info) and are ignored, as are `!` (ignored).

/**
 * Extract the list of affected paths from porcelain v2 status text.
 * Display-only — tolerant of odd spacing; not a full parser.
 * @returns {string[]} affected paths (new names for renames)
 */
export function parseStatusPaths(statusOut) {
    const paths = [];
    for (const raw of String(statusOut == null ? '' : statusOut).split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line) continue;
        const code = line[0];
        if (code !== '1' && code !== '2' && code !== 'u' && code !== '?') continue;
        // Path is the final space-separated field; renames append "\t<orig>".
        const body = line.slice(2);
        let p = body.slice(body.lastIndexOf(' ') + 1);
        const tab = p.indexOf('\t');
        if (tab !== -1) p = p.slice(0, tab);   // keep the NEW name for a rename
        if (p) paths.push(p);
    }
    return paths;
}

/**
 * Build the "Staging:" preview line(s) for the confirm dialog.
 * @param {string[]} paths explicit paths (when the caller passed some), else null
 * @param {string} statusOut git_status output (used when staging all)
 * @param {number} max cap the listed files
 * @returns {string}
 */
export function buildStagingPreview(paths, statusOut, max = 40) {
    const list = (Array.isArray(paths) && paths.length > 0)
        ? paths
        : parseStatusPaths(statusOut);
    if (list.length === 0) return '(no changes detected)';
    const shown = list.slice(0, max);
    const more = list.length - shown.length;
    return shown.map(p => `  • ${p}`).join('\n') + (more > 0 ? `\n  …(+${more} more)` : '');
}
