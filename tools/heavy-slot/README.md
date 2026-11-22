# Machine-wide heavy-command gate

Run `node tools/heavy-slot.mjs run build-label -- pnpm build`. All callers on a
machine must share `MERIT_HEAVY_DIR`; the default is `~/.cache/merit-heavy-slot`.
State and learned peaks live in its `v2` directory, outside the repository.
`status` reports holders, the queue, and physical and commit headroom.

Admission is serialized and strictly FIFO, with at most two holders. Each job
reserves the larger of its command profile and its observed peak plus 20%.
Profiles reserve 0.5 GiB for git, 1 for audits, 1.5 for tests, 2 for types,
and 2.5 for builds or unknown commands. An explicit `--need-gb N` before `--`
supplies the estimate; learned peaks still apply. One GiB of physical and
commit headroom is kept. Existing reservations are charged in full: sampled
process footprints cannot safely be subtracted from separately sampled system
headroom. This is conservative and may serialize jobs even with spare memory.
Missing telemetry prevents admission; priority bypass is refused. A finite
probe-start timestamp is checked under the admission lock. Evidence older than
the existing five-second polling cadence, or dated in the future, cannot admit
work; delayed probing/lock acquisition must obtain fresh evidence. This is
resource-evidence validity, never a deadline or timeout for an admitted job.

The admission mutex publishes a complete immutable owner record by hard link.
Release and dead-owner reclamation atomically rename that shared name before
deleting the retired file. Windows can deny opens against a delete-pending
filename while another process still reads it; retirement keeps that state
off the shared admission name. A contender never releases another owner's
lock, and dead-owner reclamation retains its nonce-specific reaper claim. See
[Windows deletion semantics](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-deletefile).

Command execution and new lease admission are supported only on Windows.
Execution requires Windows 10/Server 2016 or newer with creation-time kernel
job assignment. `run` and `acquire` refuse other platforms before reserving a
slot. Unsupported Windows job APIs fail before the workload is resumed. The
unvalidated Linux global `/proc` adapter was removed; other telemetry platforms
fail closed. Existing state may still be inspected or an owned lease released.

Windows telemetry collects process footprints first, then stamps the start of
the actual OS headroom query inside PowerShell. Shell startup and inventory
latency do not age headroom that has not been queried yet; a delayed headroom
query or admission lock still cannot make old evidence fresh. Node preserves
the returned timestamp. No command lines are collected. Monitoring is optional
while work runs: a hung or failed sample cannot hold up
completion or cancellation, and the full reservation remains held until the
owned workload ends. Native arguments and exit status are preserved. Windows
npm/pnpm/npx shims resolve to their Node entry, including npm prefix selection;
other batch files require an explicit native executable entry. The gate never
forwards their arguments through PowerShell, which can drop empty arguments or
reparse shell syntax.

For externally managed work, `acquire label 60 --need-gb 2` prints a lease
handle. Keep its `leaseId`: `renew label 60 --lease-id ID` and
`release label --lease-id ID` require it. Duration starts at admission.
Lease users must renew before expiry for their entire external job. Prefer
`run`, which owns child lifetime and needs no timed lease. Old label-only
renew/release commands are deliberately rejected to prevent stale owners from
altering a replacement lease.

`run` launches a supervisor that owns one non-inheritable, kill-on-close kernel
job. The workload is created suspended and assigned through the job-list
creation attribute; membership is verified before its initial thread resumes.
The job covers ordinary native descendants even when their immediate parent
exits or they detach. Only standard stream handles are inherited. No workload
timeout, working-set limit or memory cap is installed.

A private authenticated control pipe carries the launch request only after the
supervisor PID is durably registered; command arguments are not written to gate
state or logs. The supervisor waits for the kernel's active-member count to
reach zero. A normal root exit is reported only after its descendants finish,
with its original native exit code. SIGINT/SIGTERM request termination of the
whole Windows job and return 130/143 respectively; these are explicit Windows
job terminations, not promises of POSIX signal delivery to each application.
Launcher disconnect also cancels the job. A supervisor crash closes its sole
job handle, so the kernel terminates its members. Reservations remain while a
registered supervisor is alive; sampled PID ancestry does not prove completion.

Legacy ambiguous `starting` holders stay reserved. Diagnose them with `status`
and process inspection; there is no automatic age-based deletion or force
release. Reconcile isolated legacy state only after proving the affected work
ended. Do not delete state while any caller is active. Corrupt ownership
records fail closed rather than being silently discarded.

To replace an older gate, first stop new submissions and let both its holders
and queue drain. Keep its existing entry path as a launcher importing
`runHeavySlot` from this installation, with an explicit shared `stateDir`.
Never replace an active gate or migrate live reservations. Run the focused
tests and the repository suite before switching, then verify `status` and a
native no-op through the compatibility entry. Resume submissions afterwards.
