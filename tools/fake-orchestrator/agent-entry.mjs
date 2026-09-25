// One server "container" of the fake orchestrator: the agent, started with
// `node --import tsx`. Docker stops a container with SIGTERM, which the agent
// answers by stopping its game cleanly; Windows can't deliver SIGTERM to a
// child process, so the fake orchestrator says "stop" over IPC instead, and
// losing the orchestrator (its process ended) counts as a stop too.
process.on('message', (m) => {
  if (m === 'stop') process.emit('SIGTERM', 'SIGTERM');
});
process.on('disconnect', () => process.emit('SIGTERM', 'SIGTERM'));

await import('../../packages/agent/src/main.ts');
