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
      `node:sqlite`. It never calls a `tar` or `zstd` program (the base
      image has `tar`, unused; there is no `zstd`).

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
      lists `pz-a` only (`pz-a_player` too, if the game made one); `$S-srv-pz-b`
      lists `pz-b` only. Each has its own `/data/db/<id>.db`.
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
- [ ] `tmpfs={"/tmp":"rw,exec,nosuid,nodev,size=256m"}`, json-file 10m × 3; inside, `grep " /tmp " /proc/mounts` shows no `noexec`
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
- [ ] Restore while running: `await api('POST', '/api/servers/pz-a/backups/<name>/restore', { parts: ['world', 'configs'], countdownSec: 0 })`.
      The game stops, the agent stages and swaps the parts, the game starts
      again; the audit log shows the restore. Once the restored world runs,
      the replaced files are dropped, so `undo-restore` now answers 409
      `nothing-to-undo` (by design: undo is for a restore that won't start).
- [ ] Undo: stop pz-a, change a line in `Server/pz-a.ini` (e.g. through the
      text editor), restore again, and before starting it
      `await api('POST', '/api/servers/pz-a/backups/undo-restore')`: the
      changed line is back. A second undo answers 409 `nothing-to-undo`.
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

### 8b. A newer runtime image (HST-01, SRV-05)

What a product upgrade does to existing servers: the runtime image is rebuilt
under the same tag, and each server moves to it at its game's next start,
never while its game runs.

- [ ] pz-a's game running, pz-b's stopped (`await api('POST', '/api/servers/pz-b/server/stop', {})`).
      `docker inspect $S-srv-pz-a $S-srv-pz-b --format '{{.Name}} {{.Image}}'`
      shows both on the id of `docker image inspect gsp/steam:$T --format '{{.Id}}'`.
- [ ] Rebuild the runtime image so that its id changes (a fully cached build
      keeps the same id, and then nothing waits), and recreate the panel as an
      upgrade does:
      `node scripts/stack.mjs build --no-cache steam`, then
      `node scripts/stack.mjs up -d --force-recreate panel`.
      `docker image inspect gsp/steam:$T --format '{{.Id}}'` is a new id.
- [ ] Once the panel booted: pz-b has a new container (`{{.Created}}`) on the
      new id, and the audit log has its `server.reconcile` "container recreated
      on a newer runtime image". pz-a keeps its container on the old id and
      its game keeps running (uptime not reset); `await api('GET', '/api/servers')`
      shows it with `containerPending: true`, `containerPendingReasons: ['image']`,
      and the server list's "Applies at next start" says why in its tooltip.
      The orchestrator's log has a `PUT /v1/servers/pz-a` but no stop of pz-a.
- [ ] Restart pz-a from the panel: its container is new, on the new id;
      `containerPending: false`; the game runs again with its world; the audit
      log says "container recreated on a newer runtime image before the game
      started". Start pz-b's game again.
- [ ] Nothing was pulled. The old image is left dangling:
      `docker image ls --filter dangling=true` lists it; remove it by its id
      (`docker image rm <old id>`), never by pruning.

### 8c. An orchestrator that builds containers another way (SRV-06, NFR-02)

What a release that changes how the orchestrator derives containers (as the
tmpfs `exec` fix did) does to existing servers: the same as a newer image,
unless the change is a security fix. `docker inspect <container> --format
'{{index .Config.Labels "gsp.derivation"}}'` shows the version a container
was derived by (empty: from before versions, which counts as 0).

- [ ] The upgrade to the first release with versions is one such change: with
      the stack of an older commit up, pz-a's game running and pz-b's stopped,
      build this one (`node scripts/stack.mjs build`) and recreate the
      orchestrator and the panel (`node scripts/stack.mjs up -d --force-recreate orchestrator panel`).
      Once the panel booted: pz-b has a new container labelled
      `gsp.derivation=1`; pz-a keeps its unlabelled container and its game
      keeps running (uptime not reset); `await api('GET', '/api/servers')`
      shows it with `containerPendingReasons` holding `derivation` (and
      `image` when the runtime image's id changed too), and the tooltip says
      a panel update builds containers another way. The orchestrator's log has
      a `PUT /v1/servers/pz-a` but no stop of pz-a.
- [ ] Restart pz-a from the panel: a new container labelled
      `gsp.derivation=1`, `containerPending: false`, the game running again
      with its world; the audit log says "container recreated the way this
      panel version builds containers before the game started".
- [ ] A security fix, in a local build only (never committed): raise
      `DERIVATION_VERSION` and `SAFE_DERIVATION` in
      `packages/orchestrator/src/derive.ts` to 2, build and recreate as above
      with pz-a's game running. pz-a's container is recreated at once (labelled
      2), its game starts again in it, the orchestrator's log says
      "recreating its container although asked to keep it … before the
      security fix of version 2", and the audit log's `server.reconcile`
      says "container recreated at once for a security fix in how containers
      are built". Put the source back and build again: both servers are
      version 1's again (pz-a at its next start).

## 9. Docker restart (SRV-06): only with the owner's go-ahead

- [ ] Both games running. Restart Docker (Docker Desktop: tray → Restart;
      Linux: `sudo systemctl restart docker`).
- [ ] After it: `node scripts/stack.mjs ps` shows the stack up;
      `docker ps --filter label=gsp.stack=$S` shows both servers; within a few
      minutes both games are `running` again (each agent's saved desired
      state), and the panel shows them with their agents connected. Docker
      restarts containers in no particular order, so the panel may boot before
      the orchestrator's socket exists: its first reconcile then fails
      (audited) and its retry 15 s later succeeds.
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
      `docker stop $S-srv-pz-b` (its agent is gone). Without `force` the
      delete is refused (409), since the panel can't confirm the game stopped;
      then
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

- [ ] The three listings are empty, and `docker image ls 'gsp/*'` shows no `$T`
      image. (`clean` removes the stack's own service images; the build-only
      `steam` and `steam-fake` images need the explicit `docker image rm`, which
      reports the others as already gone.)
- [ ] `.tmp/backups/` deleted if its archives aren't needed.

## Results

| Step | Result | Notes |
|---|---|---|
| 0 Prepare | pass | Run on 2026-09-25 from commit 780df2d, slot 1. Docker Desktop, Engine 29.7.2 (API 1.55), linux/amd64 VM with 15.6 GiB and 12 CPUs. Another stack on the host was idle. `stack.mjs config` as described. |
| 1 Images | pass | Five images in 2 min 23 s: steam 693 MB, steam-fake 384 MB, panel 347 MB, orchestrator 334 MB, caddy 154 MB. `uid=1000(node)`, Node v24.21.0. The Debian base brings `/usr/bin/tar` (unused by the agent); no `zstd`. |
| 2 Stack | pass | Orchestrator `net=none ro=true user=0:0 drop=[ALL] sec=[no-new-privileges:true]`, mounts the socket and `orch-sock` only. Panel mounts `panel-data`, `panel-sock`, `orch-sock` (ro) and the backups folder; both sockets `srw-rw-rw-`; TCP 8080 `ECONNREFUSED`. Signed in through the API (password change and 2FA enrolment by script). |
| 3 First server | pass after two fixes | Refusals as written (400 `invalid-port` with `ranges`; 409 `orchestrator-refused`, 11264 > 6144). pz-a got 30150/30151 and 5120 MiB. The game (42.20.4, build 24909836, 6.9 GB) downloaded in about 3 min. **Found:** (1) the first boot died: Docker mounts a tmpfs `noexec` unless told `exec`, so the game's SQLite driver couldn't load its native library from `/tmp`; fixed in 780df2d, and the panel's boot reconcile recreated the container with the new options. (2) That failed boot left a 0-byte `db/pz-a.db`, and every later start failed with `no such table`; removed by hand here, fixed in the PZ adapter by M2-G. Then the first boot (world generation) took about 2 min to `running`, RCON connected. |
| 4 Second server | pass | pz-b got 30152/30153 and 6144 MiB. Copying the install volume took 39 s. pz-b's update check found the game installed: `starting` with the build within 30 s, no download. Both `running`; `Saves/Multiplayer` and `db/` hold only their own server; `nextRestart` 11:00Z and 12:30Z. |
| 5 Hardening | pass | Every line as listed, on both servers: pz-a `mem=swap=5368709120`, pz-b `6442450944`; `tmpfs={"/tmp":"rw,exec,nosuid,nodev,size=256m"}` (after the fix above); only UDP game ports on 127.0.0.1; each network holds its server and the panel only. |
| 6 Reachability | pass | Both directions: panel refused, orchestrator and the other server unresolvable, the other server's IP times out, no Docker socket, internet answers (HTTP 404 from the Steam API root), the panel reaches each agent (200). `host.docker.internal:30143` from a server: no connection (`000`). |
| 7 Backups | pass | Hot backup `pz-pz-a-<time>-manual.tar.zst` (847 KB, fresh world) and its sidecar in `.tmp/backups/pz-a/`; pz-b's list empty. Restore while running: stopped, swapped, running again in about 65 s; audit `backup.restore` with the parts. Undo after that answered `nothing-to-undo` (by design, checklist reworded); restore while stopped then undo brought the changed `pz-a.ini` line back; a second undo 409. |
| 8 Memory | pass | PATCH 5632 while running: `containerPending: true`, container untouched, game running. Restart: new container, 5905580032, pending cleared. Stopped + launch memory 2560: recreated at once at 6442450944. 7000: 409 `orchestrator-refused`, `maxMb: 6144`. |
| 8b Runtime image | not run | Added after this run (M2-H): the check for the fix of runtime images that never reached existing servers. |
| 8c Derivation | not run | Added after this run (M2-I): the check for the fix of derivation changes (the tmpfs `exec` fix of step 3) recreating running games at the panel's boot. |
| 9 Docker restart | pass | Panel recreated first (`--force-recreate panel`): back on both networks, games kept running. Then, with the owner's go-ahead, Docker Desktop restarted: every container back within a minute (this stack and the host's other stacks), both games `running` again about 90 s after the engine, agents connected, networks still hold the panel. The panel booted before the orchestrator's socket existed: its first reconcile failed (audited `server.reconcile` ok=false, ENOENT) and the 15 s retry succeeded silently (no-op PUTs in the orchestrator log). Overnight before this step the schedules ran on their own server only: hot backups at 06:00 and 12:00, pz-a's restart at 11:00 and pz-b's at 12:30, each with its cold backup. |
| 10 Removal | pass | pz-a: 409 `server-running`, then after stopping 200 with its final backup (848 KB, named with the `manual` trigger); no container, volume or network left. pz-b with its container stopped: without `force` 409 `server-running`; with `force` 200, `forced: true`, `finalBackup: null`, `finalBackupError: "Game server agent unreachable: fetch failed"`, the same in the audit entry; nothing left. |
| 11 Clean up | pass | `stack.mjs clean` removed the stack and its three service images; `docker image rm` the two runtime images. No container, volume, network or `:s1` image left; the host's other stacks untouched. `.tmp/backups/` (9 MB) deleted. |

Follow-ups found by this run: a reconcile retry that succeeds should say so
in the audit log (it only records the failure); the final backup of a removal
could carry its own trigger name instead of `manual`; a delete refused
because the agent can't be reached could say that instead of
`server-running`.
