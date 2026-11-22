import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const CONTAINMENT = 'windows-job-v1';

export function requireContainment(platform = process.platform) {
  if (platform !== 'win32') throw new Error('Heavy commands require Windows kernel-job containment; this platform has no proven process-tree owner.');
}

/** The supervisor cannot receive the workload until its PID is durably registered by start(). */
export async function launchOwnedProcess(command) {
  requireContainment();
  if (typeof command.file !== 'string' || !command.file || command.file.includes('\0') || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('A native executable and valid string arguments are required.');
  }
  const name = `merit-heavy-${randomBytes(24).toString('hex')}`;
  const token = randomBytes(32).toString('hex');
  const pipe = `\\\\.\\pipe\\${name}`;
  let connection;
  let started = false;
  let sent = false;
  let requestedSignal;
  const send = () => {
    if (!connection || !started || sent) return;
    sent = true;
    connection.write(`${Buffer.from(JSON.stringify(command)).toString('base64')}\n`);
    if (requestedSignal) connection.write(`${requestedSignal}\n`);
  };
  const server = createServer((socket) => {
    socket.on('error', () => {});
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    let authenticated = false;
    lines.on('line', (line) => {
      if (!authenticated) {
        if (line !== token || connection) { socket.destroy(); return; }
        authenticated = true;
        connection = socket;
        send();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  const source = fileURLToPath(new URL('./windows-job.cs', import.meta.url)).replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $pipe=$null; try {
    $pipe=[IO.Pipes.NamedPipeClientStream]::new('.', $env:MERIT_HEAVY_PIPE, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous);
    $pipe.Connect(0);
    $reader=[IO.StreamReader]::new($pipe,[Text.UTF8Encoding]::new($false));
    $writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false)); $writer.AutoFlush=$true;
    $writer.WriteLine($env:MERIT_HEAVY_TOKEN);
    [Environment]::SetEnvironmentVariable('MERIT_HEAVY_PIPE',$null);
    [Environment]::SetEnvironmentVariable('MERIT_HEAVY_TOKEN',$null);
    $request=$reader.ReadLine(); if ($null -eq $request) { exit 1 };
    $spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request)) | ConvertFrom-Json;
    Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source}'));
    $code=[MeritHeavyJob]::Run([string]$spec.file,[string[]]@($spec.args),$reader,$writer);
    exit $code;
  } catch { [Console]::Error.WriteLine('[heavy-slot] Containment failed: '+$_.Exception.Message); exit 1 }
  finally { if ($null -ne $pipe) { $pipe.Dispose() } }`;
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, MERIT_HEAVY_PIPE: name, MERIT_HEAVY_TOKEN: token }
    });
  } catch (error) { server.close(); throw error; }
  let failed = false;
  const done = new Promise((resolve) => {
    child.once('error', () => { failed = true; });
    child.once('close', (code) => {
      connection?.destroy();
      server.close();
      resolve(failed ? 1 : code ?? 1);
    });
  });
  return {
    supervisor: child,
    pid: child.pid,
    done,
    start() { started = true; send(); },
    cancel(signal) {
      if (signal !== 'SIGINT' && signal !== 'SIGTERM') throw new Error('Unsupported workload cancellation signal.');
      requestedSignal = signal;
      if (sent) connection?.write(`${signal}\n`);
    },
    abortBeforeStart() { connection?.destroy(); server.close(); child.kill(); }
  };
}
