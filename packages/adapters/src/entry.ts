/**
 * An adapter the composition root knows, and whether it is offered: servers
 * are created from and run with enabled adapters only. A skeleton stays
 * disabled until its milestone has measured the game (D5).
 */
export interface AdapterEntry<A> {
  adapter: A;
  enabled: boolean;
}

/** The enabled adapters of `entries`, in order. */
export function enabledOf<A>(entries: readonly AdapterEntry<A>[]): readonly A[] {
  return entries.filter((e) => e.enabled).map((e) => e.adapter);
}
