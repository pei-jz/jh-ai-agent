<!--
  HubStrip — the connected apps, made visible.

  The AI-Hub is the thing this agent has that a terminal-scoped one cannot: JHEditor /
  Task / ER connect over MCP and offer their tools, their named actions (intents) and
  the documents they currently have open (resources). All of that was reachable only by
  the model, or buried in Settings — so the product's one structural advantage was
  invisible in the UI.

  Region 7. Was `el.innerHTML = html` followed by a `querySelectorAll('[data-hub-kind]')`
  loop that read the app, kind, id, uri and name back off each button's data attributes
  to reconstruct what had just been rendered from. The item is passed straight to the
  callback here.

  Clicking COMPOSES the request in the input box rather than dispatching it — the user
  stays the one who decides to send. `hubActionText` (pure, tested) writes the line.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { hubActionText } from '../../views/monitor/hubStrip.js';

    let {
        /** From hubApps(mcpManager.clients). */
        apps = [],
        /** (text) => void — the line to compose into the steering box. */
        onCompose = null,
    } = $props();

    // An app with nothing to offer has nothing to say.
    const list = $derived(
        (Array.isArray(apps) ? apps : []).filter(a => a.intents?.length || a.resources?.length)
    );

    const compose = (kind, app, item) => {
        const text = hubActionText(kind, app, item);
        if (text) onCompose?.(text);
    };
</script>

{#if list.length}
    <div class="hub-strip-inner">
        {#each list as app (app.name)}
            <div class="hub-app">
                <span class="hub-app-name">{@html icon('plug')} {app.name}</span>
                {#each app.intents as i (i.id)}
                    <button class="hub-chip hub-intent" type="button"
                        data-hub-kind="intent" data-hub-app={app.name} data-hub-id={i.id}
                        title={i.id}
                        onclick={() => compose('intent', app.name, i)}
                    >{@html icon('bolt')} {i.title}</button>
                {/each}
                {#each app.resources as r (r.uri)}
                    <button class="hub-chip hub-res" type="button"
                        data-hub-kind="resource" data-hub-app={app.name}
                        data-hub-uri={r.uri} data-hub-name={r.name}
                        title={`${app.name}::${r.uri}`}
                        onclick={() => compose('resource', app.name, r)}
                    >{@html icon('file')} {r.name}</button>
                {/each}
            </div>
        {/each}
    </div>
{/if}
