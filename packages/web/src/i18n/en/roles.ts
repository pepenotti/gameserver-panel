export default {
  viewer: 'Viewer',
  operator: 'Operator',
  admin: 'Admin',
  owner: 'Owner',
  viewerHelp: 'Sees the dashboard and who is online.',
  operatorHelp: 'Starts, stops and restarts the server, reads the console, kicks and bans.',
  adminHelp: 'Changes configuration and mods, restores backups, resets the world. Needs 2FA.',
  ownerHelp: 'Everything, including accounts and full wipes.',
} as const;
