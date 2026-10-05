// Local event refreshes and action responses may arrive in either order.
// Compare the server's persisted revision, never a client/server wall clock.
export function selectNewerState<T extends { meta: { localRevision?: number }; status: { dataScope?: string } }>(current: T | null, incoming: T): T {
  if (current?.status.dataScope === incoming.status.dataScope &&
    typeof current?.meta.localRevision === 'number' &&
    current.meta.localRevision > (incoming.meta.localRevision ?? -1)) return current;
  return incoming;
}
