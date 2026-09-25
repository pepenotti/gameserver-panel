# M2 acceptance run (M2-E): checklist

A supervised run on real Docker that closes M2 (PRD §11): **two Project
Zomboid servers side by side**, each in its own container created by the
orchestrator, with separate worlds, ports and schedules. It checks what the
tests can only mirror with fakes: the derived hardening (NFR-02, D3), the
isolation between game containers, the panel and the orchestrator (NFR-03),
files and backups only through each server's agent (D11), memory limits
(SRV-05), coming back after a Docker restart (SRV-06) and removal (SRV-04).

Tick each box, and write what you saw into **Results** at the end: that
section turns this checklist into the verification log.

## Ground rules

- Run it from a worktree with its own slot (`node scripts/worktree-env.mjs --slot N`).
  The examples use **slot 1**: project `gsp-s1`, image tag `s1`, the panel on
  `https://wt1.localhost:30143`, game ports `30150-30199`. For another slot,
  replace `s1`, `wt1` and `301xx` (slot N owns `30000 + 100·N` … `+99`).
- Compose only through `node scripts/stack.mjs`. Plain `docker` is used here
  only to read (`inspect`, `ps`, `logs`, `network`/`volume ls`), to `exec` into
  this stack's own containers, for the one-off copy in step 4, and for the
  explicit image removal at the end. Never prune; never touch another
  project's containers, volumes or images.
- Step 9 restarts Docker. Do it only when the owner says so and no other
  stack on the machine has to stay up.
- Shell examples are for Git Bash or a Linux shell, from the worktree root.

```bash
S=gsp-s1        # the Compose project; every server is $S-srv-<id>
T=s1            # the image tag
```

## 0. Prepare

- [ ] `git status` clean on the branch under test; `npm ci`;
      `node scripts/worktree-env.mjs --slot 1`.
- [ ] Then edit `.env` for the real game (running `worktree-env.mjs` again
      would undo this): `SERVER_IMAGE_VARIANT=` (empty) and `ORCH_ALLOW_FAKE=0`.
      Keep `ORCH_MAX_MEM_MB=6144` (a PZ server needs its heap + 3 GiB; 2 GiB is
      the smallest heap) and `ORCH_MAX_SERVERS=4`.
- [ ] Room: Docker's VM needs ~12 GB of memory for two PZ servers with 2–3 GiB
      heaps (Docker Desktop: `.wslconfig` `memory=`), and ~20 GB of disk (one
      ~7 GB install, its copy, worlds and backups).
- [ ] `docker version`: Engine 25 or newer (the orchestrator speaks API 1.44).
- [ ] `node scripts/stack.mjs config` renders without a refusal. In the output:
      no `pz` service; `orchestrator` has `network_mode: none`, mounts only
      `/var/run/docker.sock` and `orch-sock`; `panel` mounts `panel-data`,
      `panel-sock`, `orch-sock` (read-only) and the backups folder, no game
      volume, and has no `AGENT_TOKEN`, `PZ_*` or `GAME_*` variables.

## 1. Build the images

```bash
node scripts/stack.mjs build                    # gsp/orchestrator, gsp/panel, gsp/caddy
node scripts/stack.mjs build steam steam-fake   # the servers' runtime images (build-only services)
docker image ls 'gsp/*'                         # five images, all tagged $T
```

- [ ] `gsp/steam:$T` holds the agent and Valve's steamcmd, runs as `node`:
      `docker run --rm --network none --entrypoint sh gsp/steam:$T -c 'id; node --version; ls /home/node/steamcmd/steamcmd.sh /app/agent.mjs'`
      prints `uid=1000(node)`, `v24.…` and both paths.
- [ ] `gsp/steam-fake:$T` has the fake games instead:
      `docker run --rm --network none --entrypoint ls gsp/steam-fake:$T /app/fake/fake-pz`
      lists `server.mjs` and `steamcmd.mjs`.
- [ ] Nothing else is needed at runtime for files and archives: the agent packs
      tar + zstd and snapshots SQLite with Node 24's own `node:zlib` and
      `node:sqlite` (no `tar`/`zstd` binaries in the image).

## 2. Start the stack

```bash
node scripts/stack.mjs up -d
node scripts/stack.mjs ps
node scripts/stack.mjs logs orchestrator    # "… for stack gsp-s1 (images :s1)"
```

- [ ] Orchestrator: no network, read-only, root without capabilities:
      ```bash
      docker inspect $S-orchestrator-1 --format 'net={{.HostConfig.NetworkMode}} ro={{.HostConfig.ReadonlyRootfs}} user={{.Config.User}} drop={{.HostConfig.CapDrop}} sec={{.HostConfig.SecurityOpt}}'
      docker inspect $S-orchestrator-1 --format '{{range .Mounts}}{{.Type}} {{.Source}}{{.Name}} -> {{.Destination}}{{println}}{{end}}'
      ```
      `net=none ro=true user=0:0 drop=[ALL] sec=[no-new-privileges:true]`; mounts:
      the Docker socket (bind) and `orch-sock` only.
- [ ] Panel: `docker inspect $S-panel-1 --format '{{range .Mounts}}{{.Name}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'`
      shows `panel-data`, `panel-sock`, `orch-sock` and the backups folder only.
- [ ] Sockets: `docker exec $S-panel-1 ls -l /run/panel/panel.sock /run/orch/orch.sock`
      shows two sockets `srw-rw-rw-`; `docker exec $S-panel-1 node -e "require('net').connect(8080,'127.0.0.1').on('error',e=>console.log(e.code))"`
      prints `ECONNREFUSED` (the panel has no TCP listener).
- [ ] In the browser, `https://wt1.localhost:30143`: accept the certificate,
      sign in as `owner` with `PANEL_OWNER_PASSWORD` from `.env`, set a new
      password and enrol 2FA.

## 3. Create the first server through the API

The API is the same one the UI uses (AST-01). In the browser's devtools
console, on the panel's page:

```js
const { csrf } = await (await fetch('/api/session')).json();
// Every change sends the CSRF header and a JSON body ({} when there is nothing to say).
const api = (method, url, body = {}) =>
  fetch(url, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json', 'x-gsp-csrf': csrf }, body: JSON.stringify(body) })
    .then(async (r) => [r.status, await r.json()]);
await api('GET', '/api/adapters');
```

- [ ] `host.hostPorts` is `[{from: 30150, to: 30199}]`, `host.maxMemMb` 6144,
      `pz` has `supported: true`.
- [ ] Refusals, before anything is created (SRV-01, SRV-05):
      `await api('POST', '/api/servers', { id: 'pz-x', name: 'X', adapter: 'pz', launch: { memoryMb: 2048 }, ports: { game: 16261 } })`
      → 400 `invalid-port` with `ranges: "30150-30199"`;
      `… { id: 'pz-x', name: 'X', adapter: 'pz' }` (the default 8 GiB heap) →
      409 `orchestrator-refused` with `maxMb: 6144`.
- [ ] `await api('POST', '/api/servers', { id: 'pz-a', name: 'Zomboid A', adapter: 'pz', launch: { memoryMb: 2048 } })`
      → 200 with `ports` game 30150 / udp 30151 (picked inside the slot) and
      `memLimitMb` 5120. `docker ps --filter label=gsp.stack=$S` lists `$S-srv-pz-a`.
- [ ] Install and start it: `await api('POST', '/api/servers/pz-a/server/start')`.
      The first start downloads the game (~7 GB); follow it on the server's
      **Console** page. Then `await api('GET', '/api/servers')` shows `pz-a`
      `running` with a version.

## 4. The second server, with the first one's install copied

Copying the install volume saves downloading ~7 GB again.

- [ ] `await api('POST', '/api/servers', { id: 'pz-b', name: 'Zomboid B', adapter: 'pz', launch: { memoryMb: 3072 } })`
      → ports 30152 / 30153, `memLimitMb` 6144. Don't start it yet.
- [ ] Stop pz-a's game for a quiet copy: `await api('POST', '/api/servers/pz-a/server/stop', {})`
      and wait until `GET /api/servers` shows it `stopped`.
- [ ] Copy with a one-off container of the runtime image, as the `node` user,
      with no network, while pz-b's container is stopped:
      ```bash
      docker stop $S-srv-pz-b
      docker run --rm --network none --user 1000:1000 \
        -v $S-srv-pz-a-install:/from:ro -v $S-srv-pz-b-install:/to \
        --entrypoint cp gsp/steam:$T -a /from/. /to/
      docker start $S-srv-pz-b
      ```
      (`$S-srv-pz-b-install` already exists and belongs to `node`: the
      orchestrator created it with the container, and its first start filled it
      from the image.)
- [ ] Start both: `await api('POST', '/api/servers/pz-a/server/start')`,
      `await api('POST', '/api/servers/pz-b/server/start')`. pz-b's update
      check finds the game installed (seconds, not a download: see its
      Console). Both end up `running`.
- [ ] Separate worlds: `docker exec $S-srv-pz-a ls /data/Saves/Multiplayer`
      lists `pz-a` (and `pz-a_player`) only; `$S-srv-pz-b` lists `pz-b` only.
- [ ] Separate schedules: set a daily restart at different times on each
      (**Schedules** page or `PUT /api/servers/<id>/schedules`); `GET /api/servers`
      shows two different `nextRestart` values.
- [ ] Optional: a PZ client on this machine joins `127.0.0.1:30150` and
      `127.0.0.1:30152`.

## 5. Derived hardening (NFR-02, D3)

For each of `pz-a` and `pz-b`:

```bash
C=$S-srv-pz-a
docker inspect $C --format 'image={{.Config.Image}} user={{.Config.User}} priv={{.HostConfig.Privileged}} ro={{.HostConfig.ReadonlyRootfs}}'
docker inspect $C --format 'drop={{.HostConfig.CapDrop}} add={{.HostConfig.CapAdd}} sec={{.HostConfig.SecurityOpt}} ipc={{.HostConfig.IpcMode}} pids={{.HostConfig.PidsLimit}}'
docker inspect $C --format 'mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} cpus={{.HostConfig.NanoCpus}} restart={{.HostConfig.RestartPolicy.Name}} stop={{.Config.StopTimeout}}'
docker inspect $C --format 'tmpfs={{json .HostConfig.Tmpfs}} log={{json .HostConfig.LogConfig}}'
docker inspect $C --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{println}}{{end}}'
docker inspect $C --format 'mode={{.HostConfig.NetworkMode}} nets={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}ports={{json .HostConfig.PortBindings}}'
docker inspect $C --format '{{json .Config.Labels}}'
docker network inspect $S-net-pz-a --format '{{range .Containers}}{{.Name}} {{end}}'
```

- [ ] `image=gsp/steam:s1 user=1000:1000 priv=false ro=true`
- [ ] `drop=[ALL] add=[]` (or empty) `sec=[no-new-privileges:true] ipc=private pids=4096`
- [ ] `mem` = `swap` = `memLimitMb` × 1048576 (pz-a 5368709120, pz-b 6442450944);
      `cpus=0` (no CPU limit asked); `restart=unless-stopped stop=240`
- [ ] `tmpfs={"/tmp":"rw,nosuid,nodev,size=256m"}`, json-file 10m × 3
- [ ] Mounts: only the three named volumes `$S-srv-pz-a-{data,install,steam}`
      on `/data`, `/opt/game`, `/home/node`; no bind mount, no Docker socket.
- [ ] `mode=$S-net-pz-a nets=$S-net-pz-a`; ports only the game's two UDP ports
      on `127.0.0.1` inside 30150–30199; `8081/tcp` not published.
- [ ] Labels `gsp.stack=$S`, `gsp.server=pz-a`, `gsp.spec-hash`, `gsp.config-hash`.
- [ ] The server's network holds exactly the server and `$S-panel-1`.

## 6. Reachability (NFR-03)

From inside `pz-a` (the runtime image has `curl` and `node`):

```bash
X="docker exec $S-srv-pz-a"
$X curl -sS -m 5 http://$S-panel-1:8080/api/health              # connection refused: the panel has no TCP port
$X getent hosts $S-orchestrator-1 || echo unresolved             # unresolved: the orchestrator has no network
$X getent hosts $S-srv-pz-b || echo unresolved                   # unresolved: another server's network
B_IP=$(docker inspect $S-srv-pz-b --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
$X curl -sS -m 5 http://$B_IP:8081/v1/health                     # times out: networks are isolated
$X ls -l /var/run/docker.sock                                    # No such file
$X curl -sS -m 10 -o /dev/null -w '%{http_code}\n' https://api.steampowered.com/   # an HTTP code: the internet is reachable
docker exec $S-panel-1 node -e "fetch('http://$S-srv-pz-a:8081/v1/health').then(r=>console.log(r.status))"   # 200: the panel reaches its agent
```

- [ ] Panel: refused. Orchestrator: unresolvable. pz-b by name: unresolvable;
      by IP: timeout. Docker socket: absent. Internet: an HTTP status. The
      panel reaches pz-a's agent.
- [ ] The same from `pz-b` towards `pz-a`.
- [ ] Informational: `$X curl -sk -m 5 https://host.docker.internal:30143/api/health`
      (Docker Desktop). In a slot the panel's port is on 127.0.0.1, so whether
      a container reaches it depends on Docker Desktop; in production it is the
      public address, which NFR-03 allows like any internet client. Note the
      result.

## 7. Backups and restores through the agent (D11)

- [ ] Hot backup while pz-a runs: `await api('POST', '/api/servers/pz-a/backups')`;
      when the operation ends, `await api('GET', '/api/servers/pz-a/backups')`
      lists `pz-pz-a-<time>-manual.tar.zst`, and the file (with its `.json`
      sidecar) is in `BACKUP_DIR/pz-a/` on the host (slot: `.tmp/backups/pz-a/`).
- [ ] pz-b's list doesn't show pz-a's backups.
- [ ] Restore: `await api('POST', '/api/servers/pz-a/backups/<name>/restore', { parts: ['world', 'configs'], countdownSec: 0 })`.
      The game stops, the agent stages and swaps the parts, the game starts
      again; the audit log shows the restore. Then
      `await api('POST', '/api/servers/pz-a/backups/undo-restore')` puts the
      replaced files back.
- [ ] The panel never mounted a game volume (step 2): everything above went
      through pz-a's agent.

## 8. Memory limits (SRV-05)

- [ ] While pz-a runs: `await api('PATCH', '/api/servers/pz-a', { memLimitMb: 5632 })`
      → `containerPending: true`; `docker inspect $S-srv-pz-a --format '{{.HostConfig.Memory}}'`
      still 5368709120, and the game keeps running.
- [ ] Restart it from the panel: after the restart the container is new
      (`docker inspect … --format '{{.Created}}'`), `Memory` is 5905580032,
      `containerPending: false`, and the game is running again.
- [ ] Stopped server, launch memory raised: stop pz-a, set its launch memory to
      2560 (**Game server** page or `PUT /api/servers/pz-a/server/launch`): the
      container is recreated at once with the limit raised by 512 MiB.
- [ ] Above the host's limit (`memLimitMb: 7000`): 409 `orchestrator-refused`,
      `maxMb: 6144`, nothing changed.

## 9. Docker restart (SRV-06): only with the owner's go-ahead

- [ ] Both games running. Restart Docker (Docker Desktop: tray → Restart;
      Linux: `sudo systemctl restart docker`).
- [ ] After it: `node scripts/stack.mjs ps` shows the stack up;
      `docker ps --filter label=gsp.stack=$S` shows both servers; within a few
      minutes both games are `running` again (each agent's saved desired
      state), and the panel shows them with their agents connected.
- [ ] Both server networks still hold the panel (`docker network inspect`).
- [ ] A new panel container: `node scripts/stack.mjs up -d --force-recreate panel`.
      Once it booted, it is on both servers' networks again (its boot
      re-applies each spec), and both games kept running (their uptime didn't
      reset).

## 10. Removal (SRV-04)

- [ ] `await api('DELETE', '/api/servers/pz-a', { confirm: 'Zomboid A' })` while
      running → 409 `server-running`. Stop it, then again → 200 with
      `finalBackup` named; the archive is in `BACKUP_DIR/pz-a/`;
      `docker ps -a`, `docker volume ls` and `docker network ls` filtered by
      `label=gsp.server=pz-a` are empty.
- [ ] Forced removal (owner only) of a server that can't be stopped or reached:
      `docker stop $S-srv-pz-b` (its agent is gone), then
      `await api('DELETE', '/api/servers/pz-b', { confirm: 'Zomboid B', force: true })`
      → 200 with `forced: true`, `finalBackup: null` and `finalBackupError`
      saying why; the audit log's `server.delete` entry says the same.
      Everything of pz-b is gone.

## 11. Clean up

```bash
node scripts/stack.mjs clean      # the stack's containers and volumes, and its servers' containers, networks and volumes
docker image rm gsp/orchestrator:$T gsp/panel:$T gsp/caddy:$T gsp/steam:$T gsp/steam-fake:$T
docker ps -a --filter label=gsp.stack=$S; docker volume ls --filter label=gsp.stack=$S; docker network ls --filter label=gsp.stack=$S
```

- [ ] The three listings are empty. (`clean` removes only untagged images:
      ours carry the `$T` tag, hence the explicit `docker image rm`.)
- [ ] `.tmp/backups/` deleted if its archives aren't needed.

## Results

| Step | Result | Notes |
|---|---|---|
| 0 Prepare | | Docker version, OS, memory |
| 1 Images | | |
| 2 Stack | | |
| 3 First server | | |
| 4 Second server | | copy time, update check |
| 5 Hardening | | |
| 6 Reachability | | host.docker.internal result |
| 7 Backups | | |
| 8 Memory | | |
| 9 Docker restart | | |
| 10 Removal | | |
| 11 Clean up | | |
