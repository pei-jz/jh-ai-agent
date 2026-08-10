// Svelte compiler options, shared by the Vite build and the Vitest run.
//
// `compilerOptions.runes: true` opts the whole project into Svelte 5's runes
// ($state / $derived / $props). Leaving it to per-file inference means a
// component's reactivity model depends on which syntax it happens to use — and a
// half-migrated codebase is exactly where that ambiguity bites. One mode, stated
// once.
export default {
    compilerOptions: {
        runes: true,
    },
};
