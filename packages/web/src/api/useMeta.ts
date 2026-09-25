import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { serverApi } from './http';
import { hasCapability, localize, supports, type CapabilityNeed, type I18n, type Meta, type Need } from './meta';
import { useServerScope } from './server';
import { useSession } from './session';

export interface MetaView {
  meta: Meta | null;
  /** True while the first answer is on its way. */
  loading: boolean;
  /** Unknown (meta failed to load) counts as supported: the API still refuses what the game lacks. */
  has(need: CapabilityNeed): boolean;
  supports(need: Need): boolean;
  /** The game's name in the UI language, e.g. for "X does not support Y". */
  gameName: string;
  /** An adapter-provided label in the UI language. */
  l(v: Partial<I18n> | undefined): string;
}

/**
 * The page's server's adapter description (`GET /api/servers/:sid/meta`):
 * one query per server, cached, shared by every page. Outside a server's
 * pages (`sid` null) there is none.
 */
export function useMeta(sidOverride?: string | null): MetaView {
  const scope = useServerScope();
  const sid = sidOverride !== undefined ? sidOverride : (scope?.sid ?? null);
  const { i18n } = useTranslation();
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['meta', sid],
    queryFn: () => serverApi(sid!)<Meta>('GET', '/meta'),
    enabled: !!sid && !!session && !session.pending,
    staleTime: Infinity,
  });
  const meta = q.data ?? null;
  const l = (v: Partial<I18n> | undefined) => localize(v, i18n.language);
  return {
    meta,
    loading: q.isLoading,
    has: (need) => (meta ? hasCapability(meta, need) : !q.isLoading),
    supports: (need) => (meta ? supports(meta, need) : !q.isLoading),
    gameName: meta ? l(meta.adapter.name) : '',
    l,
  };
}
