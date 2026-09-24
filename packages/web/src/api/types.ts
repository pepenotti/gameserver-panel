import type { Permission, Role } from '@pz/shared';

export type Lang = 'en' | 'es';
export type Pending = 'mfa' | 'password' | 'enrol';

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
  lang: Lang;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  user: PublicUser;
  csrf: string;
  pending: Pending | null;
  permissions: Permission[];
}

export interface AuditEntry {
  id: number;
  at: string;
  userId: number | null;
  username: string | null;
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
