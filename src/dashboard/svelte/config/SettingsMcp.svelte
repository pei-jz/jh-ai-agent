<!--
  SettingsMcp — the MCP servers JSON editor.

  Small, but it carried one of the `readFormValues()` reads. The textarea is bound
  state reported through onChange, so the value cannot be "in the DOM but not in the
  config" — which is what made every other action on this tab call
  `readFormValues()` first as a precaution.
-->
<script>
    let { text = '{}', onChange = null } = $props();
</script>

<div class="input-group">
    <label class="input-label" for="cfg-mcp-servers">Configuration JSON</label>
    <textarea
        id="cfg-mcp-servers" class="textarea cfg-mono-area" rows="16"
        value={text}
        oninput={(e) => onChange?.(e.currentTarget.value)}
    ></textarea>
    <p class="input-hint cfg-hint-spaced">
        Edit the MCP servers config in JSON format. Example:
        <code>{'{"sqlite": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite"]}}'}</code>
    </p>
</div>
