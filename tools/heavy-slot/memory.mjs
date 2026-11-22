import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const WINDOWS_SAMPLE = `$gateProcesses = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount); $gateProbeStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $gateMemory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; @{physicalAvailableBytes=[double]$gateMemory.AvailableBytes;commitAvailableBytes=[double]($gateMemory.CommitLimit-$gateMemory.CommittedBytes);sampledAt=$gateProbeStart;processes=$gateProcesses} | ConvertTo-Json -Depth 4 -Compress`;

/** No command lines, credentials or page content are collected. */
export async function memorySnapshot({ signal, executeWindows = execute } = {}) {
  if (process.platform === 'win32') {
    const { stdout } = await executeWindows('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SAMPLE, 'utf16le').toString('base64')], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, signal });
    const result = JSON.parse(stdout);
    return { ...result, processes: (result.processes ?? []).map((row) => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId), workingBytes: Number(row.WorkingSetSize), privateBytes: Number(row.PrivatePageCount) })) };
  }
  throw new Error('Validated system headroom telemetry is supported only on Windows; no heavy job was admitted.');
}

export function holderFootprint(holder, snapshot) {
  const included = new Set([holder.childPid, ...(holder.descendantPids ?? [])].filter(Number.isInteger));
  // The wrapper is included too, including telemetry/launcher overhead.
  if (holder.pid) included.add(holder.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of snapshot.processes ?? []) {
      if (included.has(row.parentPid) && !included.has(row.pid)) { included.add(row.pid); changed = true; }
    }
  }
  const rows = (snapshot.processes ?? []).filter((row) => included.has(row.pid));
  const workingBytes = rows.reduce((sum, row) => sum + row.workingBytes, 0);
  const privateBytes = rows.reduce((sum, row) => sum + row.privateBytes, 0);
  return { ...holder, workingBytes, privateBytes, descendantPids: rows.map((row) => row.pid), peakBytes: Math.max(holder.peakBytes ?? 0, workingBytes, privateBytes) };
}
