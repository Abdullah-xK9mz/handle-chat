export const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/

export function normalizeUsername(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase()
}

// Supabase Auth requires an email. Accounts here are identified by username,
// so each one gets a non-routable placeholder address.
export function placeholderEmail(username: string) {
  return `${username}@users.handle.local`
}
