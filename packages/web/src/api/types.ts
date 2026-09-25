import type { Permission, Role, Scope, ServerGrant } from '@gsp/shared';

export type Lang = 'en' | 'es';
export type Pending = 'mfa' | 'password' | 'enrol';

export interface PublicUser {
  id: number;
  username: string;
  /** With scope `granted`, the highest of its grants (the panel keeps it). */
  role: Role;
  /** `all`: the role applies on every server; `granted`: only on the servers it has a grant for (ACC-02). */
  scope: Scope;
  lang: Lang;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** An account in `GET /api/users`, with its per-server roles. */
export interface UserWithGrants extends PublicUser {
  grants: ServerGrant[];
}

/** What the grants routes answer (`GET|PUT|DELETE /api/users/:id/grants…`). */
export interface GrantsView {
  userId: number;
  scope: Scope;
  role: Role;
  grants: ServerGrant[];
}

export interface SessionInfo {
  user: PublicUser;
  csrf: string;
  pending: Pending | null;
  permissions: Permission[];
}

/** Who acted (AST-02): a person, a schedule, the recovery tool, an assistant, or the panel itself. */
export type ActorType = 'user' | 'schedule' | 'recovery' | 'assistant' | 'system';

export interface AuditEntry {
  id: number;
  at: string;
  /** The server it was about; null for host actions (accounts, sign-ins, host settings). */
  serverId: string | null;
  actorType: ActorType;
  userId: number | null;
  username: string | null;
  onBehalfOf: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  ok: boolean;
}

export interface DeviceSession {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}
