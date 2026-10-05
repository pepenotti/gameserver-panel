import type { FastifyInstance } from 'fastify';
import type { Deps } from '../http/deps';
import type { HostOverview } from '../host/overview';
import type { AddressView } from '../host/traits';

/** Where docs/limitations.md says why players' and visitors' addresses may not arrive (HST-07, UX-04). */
export const ADDRESSES_DOC = 'limitations.md#players-addresses-are-hidden-behind-docker-desktop';

/** `GET /api/host/traits`: what the notes about addresses need (HST-07), nothing else of the host. */
export interface HostTraitsView {
  addresses: AddressView;
  /** Its entry in docs/limitations.md. */
  doc: string;
}

/**
 * The host page (HST-03, HST-07, SRV-05): the overview of every server's
 * state, limits, use and files against what the host has, with the
 * limitations that apply, for those who see the host overview (Q9:
 * `host.view`, the owner and admins on every server). Whether players'
 * and visitors' addresses arrive is for everyone with a role on some
 * server: the notes on address bans, the activity log, the signed-in
 * devices and per-address game settings show it, and nothing else of the
 * host comes with it.
 */
export function hostRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/host/overview', { config: { permission: 'host.view' } }, async (): Promise<HostOverview> => deps.hostOverview.get());

  app.get('/api/host/traits', { config: { permission: 'server.view', perServer: true } }, async (): Promise<HostTraitsView> => ({ addresses: await deps.hostTraits.addresses(), doc: ADDRESSES_DOC }));
}
