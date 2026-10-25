/** A copy with the item `id` moved to index `to` (clamped); the input array itself when nothing changes. */
export function moveById<T extends { id: string }>(items: T[], id: string, to: number): T[] {
  const from = items.findIndex((x) => x.id === id);
  if (from < 0) return items;
  const at = Math.max(0, Math.min(items.length - 1, Math.trunc(to)));
  if (at === from) return items;
  const out = items.filter((_, i) => i !== from);
  out.splice(at, 0, items[from]!);
  return out;
}
