// Spanish strings, one file per top-level namespace (es/<ns>.ts), typed
// against the English ones.
import type { Translations } from './en';
import app from './es/app';
import audit from './es/audit';
import auth from './es/auth';
import backups from './es/backups';
import common from './es/common';
import config from './es/config';
import consoleNs from './es/console';
import controls from './es/controls';
import dashboard from './es/dashboard';
import discord from './es/discord';
import errors from './es/errors';
import files from './es/files';
import mods from './es/mods';
import nav from './es/nav';
import ops from './es/ops';
import players from './es/players';
import profile from './es/profile';
import reset from './es/reset';
import roles from './es/roles';
import schedules from './es/schedules';
import server from './es/server';
import state from './es/state';
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
  config,
  backups,
  reset,
  players,
  mods,
  schedules,
  discord,
  time,
  files,
};
