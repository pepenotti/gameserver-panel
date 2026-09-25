#!/usr/bin/env node
// Talk to the agent from inside the game container — an escape hatch when
// the panel is down.
//
//   docker compose exec pz node /app/agentctl.mjs status [--full]
//   docker compose exec -T pz node /app/agentctl.mjs start - < launch.json
//       (launch.json: {"adapter":"pz","params":{…}}, or the adapter's bare params)
//   docker compose exec pz node /app/agentctl.mjs stop | restart | kill | save
//   docker compose exec pz node /app/agentctl.mjs cmd "players"
//   docker compose exec pz node /app/agentctl.mjs install [--validate]     (for the stored launch)
//   docker compose exec pz node /app/agentctl.mjs versions | logs [since]
//   docker compose exec pz node /app/agentctl.mjs action accounts '{"serverName":"zomboid"}'
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
  gameVersion: s.installedInfo?.version ?? null,
  installed: s.installedInfo ?? null,
  players: s.players,
  failure: s.failure,
  lastExit: s.lastExit,
  control: s.control,
  job: s.job,
  process: s.process,
});
const print = (x) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case 'status':
    print(rest[0] === '--full' ? await call('GET', '/v1/status') : summary(await call('GET', '/v1/status')));
    break;
  case 'start': {
    const launch = rest[0] === '-' ? JSON.parse(readFileSync(0, 'utf8')) : rest[0] ? JSON.parse(readFileSync(rest[0], 'utf8')) : undefined;
    print(summary(await call('POST', '/v1/start', launch ? { launch } : {})));
    break;
  }
  case 'stop':
  case 'restart':
  case 'kill':
    print(summary(await call('POST', `/v1/${cmd}`, {})));
    break;
  case 'save':
    print(await call('POST', '/v1/save', {}));
    break;
  case 'cmd': {
    const r = await call('POST', '/v1/command', { command: rest.join(' ') });
    console.log(r.output ?? `(sent via ${r.via})`);
    break;
  }
  case 'install':
    if (rest.some((a) => !a.startsWith('--'))) {
      console.error('install takes no branch: it installs what the stored launch pins (start with new launch params to change it)');
      process.exit(2);
    }
    print(await call('POST', '/v1/install', { validate: rest.includes('--validate') }));
    break;
  case 'versions':
  case 'appinfo':
    print(await call('POST', '/v1/versions', {}));
    break;
  case 'action': {
    const [name, input] = rest;
    if (!name) {
      console.error('usage: agentctl action <name> [json input]');
      process.exit(2);
    }
    print((await call('POST', `/v1/actions/${encodeURIComponent(name)}`, { input: input === undefined ? {} : JSON.parse(input) })).result);
    break;
  }
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
    console.error('usage: agentctl status [--full]|start [file|-]|stop|restart|kill|save|cmd <command>|install [--validate]|versions|action <name> [json]|logs [since]');
    process.exit(2);
}
