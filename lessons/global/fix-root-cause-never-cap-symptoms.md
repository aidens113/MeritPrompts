---
name: fix-root-cause-never-cap-symptoms
scope: global
description: Aiden wants every problem fixed at its root cause, never by capping or masking the symptom (lower timeouts, retry or call caps, shorter waits, hidden errors), in every project.
origin: FluxIQWebExtension, 2026-11-10
---

# Fix the root cause, never cap the symptom

Aiden said, on 2026-11-10: "we should NEVER attempt to fix these problems by simply capping the symptoms. Instead we should come up with ways to fix the root cause, always". He said it while asking for a large speed-up of FluxIQ's live task attempts, and after seeing the extension restart a task whenever a robot check appeared.

A fix must remove the reason a problem happens, not limit how visible or how large the problem is. Before proposing a fix, trace why the step is slow, why the run restarts, why an action repeats or why a call fails, and change that. The following are symptom caps and are not acceptable as the fix:

- lowering a timeout, a fixed wait or a settle delay so a slow step looks faster;
- capping retries, model calls, rounds or budget so a loop ends sooner;
- refusing or suppressing a repeat without knowing why it repeated;
- hiding an error, swallowing an exception or relabelling a failure;
- special-casing the one task, site or input that showed the problem.

This applies in every project, to agents and their workers alike, and to performance work as much as to bugs. A cap may sit beside a real fix only as a safety net the user already asked for, never in its place. If the root cause cannot be found or fixed yet, say so plainly and report the cause found so far instead of shipping a cap as the fix.

It matters because a capped symptom makes the measurement look better while the real defect stays and comes back in a new shape, which is the pattern Aiden rejects; see the related lesson on recurring failures needing a structural fix.
