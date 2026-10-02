import type { FastifyInstance } from 'fastify';
import { can, canHost, type ConnectionInfo, type DetectedAddress, type HostAddressUpdate, type HostAddressView } from '@gsp/shared';
import { connectionInfo } from '../connection/info';
import { AddressRefusal, DetectFailure } from '../host/address';
import { by, HttpError, principal, srvOf } from '../http/context';
import type { Deps } from '../http/deps';

/** A field of the address form: a string (empty: the default), or null. */
const addressField = { type: 'string', nullable: true, maxLength: 300 } as const;

/**
 * The host's addresses (HST-08): the public address friends use to reach
 * this host (a DNS name or an IP address; by default the DuckDNS name the
 * panel uses for HTTPS) and its home-network address. The owner's alone
 * (`host.settings`), and audited; "Detect" asks one fixed public service,
 * only when pressed (NFR-09), and saves nothing.
 */
export function hostAddressRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit, hostAddress } = deps;

  app.get('/api/host/address', { config: { permission: 'host.settings' } }, async (): Promise<HostAddressView> => hostAddress.view());

  app.put<{ Body: HostAddressUpdate }>(
    '/api/host/address',
    {
      config: { permission: 'host.settings' },
      schema: { body: { type: 'object', required: ['public', 'home'], additionalProperties: false, properties: { public: addressField, home: addressField } } },
    },
    async (req): Promise<HostAddressView> => {
      const before = hostAddress.view();
      let view: HostAddressView;
      try {
        view = hostAddress.save(req.body);
      } catch (e) {
        if (e instanceof AddressRefusal) throw new HttpError(400, 'invalid-address', e.message, { field: e.field, problem: e.problem });
        throw e;
      }
      audit.log({ ...by(req), action: 'host.address.update', detail: { public: view.public, publicSource: view.publicSource, home: view.home, homeSource: view.homeSource, before: { public: before.public, home: before.home } } });
      return view;
    },
  );

  app.post('/api/host/address/detect', { config: { permission: 'host.settings' } }, async (req): Promise<DetectedAddress> => {
    try {
      const found = await hostAddress.detect();
      audit.log({ ...by(req), action: 'host.address.detect', detail: { service: found.service, address: found.address } });
      return found;
    } catch (e) {
      if (!(e instanceof DetectFailure)) throw e;
      audit.log({ ...by(req), action: 'host.address.detect', detail: { service: hostAddress.view().detectService, reason: e.reason }, ok: false });
      throw new HttpError(502, 'detect-failed', e.message, { reason: e.reason });
    }
  });
}

/**
 * A server's connection info (SRV-08), for everyone who can see the server:
 * what players type from this PC, the home network and the internet, in its
 * game's format, and the router forwards it needs. `?password=1` adds the
 * join password for those who may manage the server (admins and the
 * owner: `server.update`), audited; anyone else asking is refused.
 */
export function connectionRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Querystring: { password?: '0' | '1' } }>(
    '/connection',
    {
      config: { permission: 'server.view' },
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { password: { enum: ['0', '1'] } } } },
    },
    async (req): Promise<ConnectionInfo> => {
      const s = srvOf(req);
      const canIncludePassword = req.srvRole !== null && can(req.srvRole, 'server.update');
      const includePassword = req.query.password === '1';
      if (includePassword && !canIncludePassword) throw new HttpError(403, 'forbidden');
      const info = await connectionInfo(s, {
        address: deps.hostAddress.view(),
        canIncludePassword,
        includePassword,
        canSetAddress: canHost(principal(req.auth!.user), 'host.settings'),
      });
      // Who saw the password, never the password itself.
      if (includePassword) deps.audit.log({ ...by(req), action: 'server.connection.password', detail: { shown: info.password.value !== null } });
      return info;
    },
  );
}
