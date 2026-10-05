// English strings, one file per top-level namespace (en/<ns>.ts). es.ts
// mirrors this file; the i18n test keeps both in step.
import alerts from './en/alerts';
import app from './en/app';
import audit from './en/audit';
import auth from './en/auth';
import backups from './en/backups';
import capabilities from './en/capabilities';
import common from './en/common';
import config from './en/config';
import connection from './en/connection';
import consoleNs from './en/console';
import controls from './en/controls';
import create from './en/create';
import dashboard from './en/dashboard';
import discord from './en/discord';
import errors from './en/errors';
import eula from './en/eula';
import files from './en/files';
import host from './en/host';
import hostSettings from './en/hostSettings';
import mods from './en/mods';
import nav from './en/nav';
import ops from './en/ops';
import players from './en/players';
import profile from './en/profile';
import reset from './en/reset';
import roles from './en/roles';
import schedules from './en/schedules';
import server from './en/server';
import servers from './en/servers';
import state from './en/state';
import support from './en/support';
import time from './en/time';
import users from './en/users';

export const en = {
  app,
  common,
  nav,
  state,
  roles,
  auth,
  errors,
  dashboard,
  profile,
  users,
  audit,
  controls,
  ops,
  console: consoleNs,
  server,
  servers,
  create,
  eula,
  host,
  hostSettings,
  connection,
  config,
  backups,
  reset,
  players,
  mods,
  schedules,
  discord,
  time,
  files,
  support,
  capabilities,
  alerts,
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Translations = Widen<typeof en>;
