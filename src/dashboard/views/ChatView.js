// ChatView — mount shell.
//
// Migrated to Svelte (region 6 of docs/design/svelte-migration.md). Everything
// this file used to do lives in components and plain modules now:
//
//   svelte/chat/ChatRoot.svelte     the shell: header, settings, input, sending
//   svelte/chat/HistoryModal.svelte the session picker
//   views/chat/chatLoop.js          one turn: streaming, tool calls, abort
//   views/chat/chatAttachments.js   file to attachment
//   views/chat/chatSessions.js      the session store's pure parts
//   views/chat/chatMarkdown.js      how content is parsed
//
// What is left is the contract main.js calls: render() then init() then
// destroy(). CHAT_STYLES is still emitted here because it is the view's layout,
// shared by several components that each keep only their own local rules.

import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';
import ChatRoot from '../svelte/chat/ChatRoot.svelte';
import { CHAT_STYLES } from './ChatView.styles.js';

const HOST_ID = 'chat-root';

export class ChatView {
    async render() {
        return `<style>${CHAT_STYLES}</style><div id="${HOST_ID}"></div>`;
    }

    init() {
        mountComponent(ChatRoot, document.getElementById(HOST_ID), {});
    }

    destroy() {
        destroyComponent(document.getElementById(HOST_ID));
    }
}
