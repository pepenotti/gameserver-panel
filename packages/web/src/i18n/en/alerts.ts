// Agent alert kinds (AgentEvent `alert`), as toast titles.
export default {
  crash: 'The server crashed',
  'crash-loop': 'The server keeps crashing',
  unresponsive: 'The server is not responding',
  'blocking-prompt': 'The server is waiting for console input',
  fatal: 'Fatal error',
  'start-timeout': 'The server took too long to start',
  'start-failed': 'The server could not start',
} as const;
