import { spawn, type ChildProcess } from 'node:child_process';

export interface GameProcess {
  child: ChildProcess;
  pid: number;
  writeLine(line: string): boolean;
  /** Signal the whole process group: start-server.sh does not exec the JVM, so signalling bash alone would orphan it. */
  signal(sig: NodeJS.Signals): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Calls `onLine` for each complete line; handles \r\n, bare \r and partial chunks. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer | string): void; flush(): void } {
  let rest = '';
  return {
    push(chunk) {
      rest += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parts = rest.split(/\r\n|\n|\r/);
      rest = parts.pop() ?? '';
      for (const p of parts) onLine(p);
    },
    flush() {
      if (rest) onLine(rest);
      rest = '';
    },
  };
}

export function spawnGame(
  command: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; onStdout: (line: string) => void; onStderr: (line: string) => void },
): GameProcess {
  const [file, ...args] = command;
  if (!file) throw new Error('Empty start command');
  const isWin = process.platform === 'win32';
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group on Linux so stop/kill reach the JVM behind start-server.sh.
    detached: !isWin,
    windowsHide: true,
  });
  if (child.pid === undefined) {
    // spawn failures surface as an 'error' event; make them synchronous for callers.
    throw new Error(`Could not start ${file}`);
  }
  const pid = child.pid;
  const out = lineSplitter(opts.onStdout);
  const err = lineSplitter(opts.onStderr);
  child.stdout!.on('data', (c: Buffer) => out.push(c));
  child.stderr!.on('data', (c: Buffer) => err.push(c));
  child.stdin!.on('error', () => undefined); // EPIPE after exit is expected

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      out.flush();
      err.flush();
      resolve({ code, signal });
    });
    child.once('error', () => resolve({ code: null, signal: null }));
  });

  return {
    child,
    pid,
    exited,
    writeLine(line) {
      if (!child.stdin || child.stdin.destroyed || /[\r\n\0]/.test(line)) return false;
      return child.stdin.write(`${line}\n`);
    },
    signal(sig) {
      try {
        if (isWin) child.kill(sig);
        else process.kill(-pid, sig);
      } catch {
        // Already gone.
      }
    },
  };
}
