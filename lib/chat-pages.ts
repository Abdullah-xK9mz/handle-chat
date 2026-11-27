export type ChatPage =
  | 'conversation-details'
  | 'profile-photo'
  | 'media-viewer'
  | 'forward-message'
  | 'structured-message'
  | 'status-editor'
  | 'status-viewer'
  | 'qr-scanner'

type ChatHistoryState = {
  handleChatPage?: ChatPage
  handleChatParentPage?: ChatPage | null
  [key: string]: unknown
}

export function pushChatPage(page: ChatPage) {
  const current = window.history.state && typeof window.history.state === 'object'
    ? window.history.state as ChatHistoryState
    : {}
  window.history.pushState({
    ...current,
    handleChatPage: page,
    handleChatParentPage: current.handleChatPage ?? null,
  }, '', window.location.href)
}

export function closeChatPage(page: ChatPage) {
  const current = window.history.state as ChatHistoryState | null
  if (current?.handleChatPage === page) {
    window.history.back()
  }
}
