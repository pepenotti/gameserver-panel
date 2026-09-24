#!/usr/bin/env node
// Talk to the agent from inside the pz container — handy before the panel
// exists, and as an escape hatch when it's down.
//
//   docker compose exec pz node /app/agentctl.mjs status
//   docker compose exec -T pz node /app/agentctl.mjs start - < launch.json
//   docker compose exec pz node /app/agentctl.mjs stop | restart | kill
//   docker compose exec pz node /app/agentctl.mjs cmd "players"
//   docker compose exec pz node /app/agentctl.mjs install [branch] [--validate]
//   docker compose exec pz node /app/agentctl.mjs appinfo | logs
import { readFileSync } from 'node:fs';

const base = process.env.AGENT_URL ?? `http://127.0.0.1:${process.env.AGENT_PORT ?? 8081}`;
const token = process.env.AGENT_TOKEN;
if (!token) {
  console.error('AGENT_TOKEN is not set');
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    console.error(`${res.status}: ${data.error ?? text}`);
    process.exit(1);
  }
  return data;
}

const [cmd, ...rest] = process.argv.slice(2);
const summary = (s) => ({
  state: s.state,
  desired: s.desired,
  gameVersion: s.gameVersion,
  installed: s.installed,
  players: s.players,
  failure: s.failure,
  lastExit: s.lastExit,
  rcon: s.rcon,
  job: s.job,
  process: s.process,
});

switch (cmd) {
  case 'status':
    console.log(JSON.stringify(rest[0] === '--full' ? await call('GET', '/v1/status') : summary(await call('GET', '/v1/status')), null, 2));
    break;
  case 'start': {
    const launch = rest[0] === '-' ? JSON.parse(readFileSync(0, 'utf8')) : rest[0] ? JSON.parse(readFileSync(rest[0], 'utf8')) : undefined;
    console.log(JSON.stringify(summary(await call('POST', '/v1/start', launch ? { launch } : {})), null, 2));
    break;
  }
  case 'stop':
  case 'restart':
  case 'kill':
    console.log(JSON.stringify(summary(await call('POST', `/v1/${cmd}`, {})), null, 2));
    break;
  case 'cmd': {
    const r = await call('POST', '/v1/command', { command: rest.join(' ') });
    console.log(r.output ?? `(sent via ${r.via})`);
    break;
  }
  case 'install':
    console.log(await call('POST', '/v1/steamcmd/install', { branch: rest.find((a) => !a.startsWith('--')), validate: rest.includes('--validate') }));
    break;
  case 'appinfo':
    console.log(JSON.stringify(await call('POST', '/v1/steamcmd/appinfo', {}), null, 2));
    break;
  case 'logs': {
    // Stream the event log as plain lines until interrupted.
    const res = await fetch(`${base}/v1/events?since=${rest[0] ?? 0}`, { headers });
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (!data) continue;
        const e = JSON.parse(data.slice(6)).event;
        if (e.type === 'log') console.log(e.line);
        else if (e.type === 'alert') console.log(`!! ${e.kind}: ${e.message}`);
        else if (e.type === 'job') console.log(`.. ${e.job.kind} ${e.job.progress ?? ''} ${e.job.message}${e.result ? ` -> ${e.result.ok ? 'ok' : e.result.error}` : ''}`);
        else if (e.type === 'state') console.log(`== state ${e.status.state}`);
        else if (e.type === 'players') console.log(`== players ${e.count}: ${e.names.join(', ')}`);
      }
    }
    break;
  }
  default:
    console.error('usage: agentctl status|start [file|-]|stop|restart|kill|cmd <command>|install [branch] [--validate]|appinfo|logs [since]');
    process.exit(2);
}
