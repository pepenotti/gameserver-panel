// Spanish strings, one file per top-level namespace (es/<ns>.ts), typed
// against the English ones.
import type { Translations } from './en';
import alerts from './es/alerts';
import app from './es/app';
import audit from './es/audit';
import auth from './es/auth';
import backups from './es/backups';
import capabilities from './es/capabilities';
import common from './es/common';
import config from './es/config';
import connection from './es/connection';
import consoleNs from './es/console';
import controls from './es/controls';
import create from './es/create';
import dashboard from './es/dashboard';
import discord from './es/discord';
import errors from './es/errors';
import eula from './es/eula';
import files from './es/files';
import hostSettings from './es/hostSettings';
import mods from './es/mods';
import nav from './es/nav';
import ops from './es/ops';
import players from './es/players';
import profile from './es/profile';
import reset from './es/reset';
import roles from './es/roles';
import schedules from './es/schedules';
import server from './es/server';
import servers from './es/servers';
import state from './es/state';
import support from './es/support';
import time from './es/time';
import users from './es/users';

export const es: Translations = {
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
};
