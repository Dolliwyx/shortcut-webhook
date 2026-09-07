const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function lookupMemberNames(authorIds, token, fetchImpl = globalThis.fetch, timeoutMs = 2_000) {
  const names = new Map();
  if (!token) return names;
  const ids = [...new Set(authorIds.filter((id) => typeof id === 'string' && UUID.test(id)))];
  if (ids.length === 0) return names;

  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(); }, timeoutMs);
    });
    const lookups = async () => {
      for (const id of ids.slice(0, 10)) {
        if (controller.signal.aborted) break;
        try {
          const response = await fetchImpl(`https://api.app.shortcut.com/api/v3/members/${id}`, {
            method: 'GET',
            headers: { 'Shortcut-Token': token, 'Content-Type': 'application/json' },
            redirect: 'error',
            signal: controller.signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            break;
          }
          const member = await response.json();
          if (controller.signal.aborted) break;
          if (typeof member?.id !== 'string' || member.id.toLowerCase() !== id.toLowerCase()) continue;
          const name = [member.profile?.name, member.profile?.mention_name]
            .find((value) => typeof value === 'string' && value.trim().length > 0);
          if (name) names.set(id, name);
        } catch {
          break;
        }
      }
    };
    await Promise.race([lookups(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return names;
}
