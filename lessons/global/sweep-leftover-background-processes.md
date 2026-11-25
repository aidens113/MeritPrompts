---
name: sweep-leftover-background-processes
scope: global
description: Aiden wants no background shell, watcher or tail left running after its job ends; stopping a Monitor or background task must end its whole process tree, and wrap-up sweeps for leftovers, in every project.
origin: FluxIQWebExtension, 2026-11-25
---

# Leave no background process running after its job ends

At the end of a long session Aiden found "multiple long running background shells such as one for 777 minutes". They were the lead's own leftovers: fifteen `tail -F` processes from Monitors that had been stopped, two old watcher scripts, and several verification shells that had outlived their purpose by many hours.

On Windows with Git Bash, stopping a Monitor or a background Bash task ends the shell the harness started but can leave its children running, especially `tail -F` and any process a pipeline started. So when a Monitor or background task is no longer needed, stop it and then make sure its children are gone: find them by their command line and end each with `taskkill /PID <pid> /T /F`. At wrap-up, and before a handoff, list `bash.exe`, `tail.exe`, `sleep.exe` and `node.exe` processes older than an hour, read each command line, and end every one this session started (its scratchpad path, its task folders, or its worktrees name it). Leave alone what belongs to the user or the editor, such as a VS Code terminal, and anything another live agent is still using.

Leftover processes hold files and worktrees (a task folder will not close while a shell works inside it), slow the machine, and make the user wonder what is still spending. An agent cannot tell from its own task list that a stopped task's child is still running, so the sweep has to look at the processes themselves.
