---
name: deterministic-runs-after-exploration
scope: fluxiq
description: Aiden wants every FluxIQ task check (Lab, extension, FluxNode or simulated environment) to follow its first exploring run with several deterministic runs that prove the saved Flow is used and count their model calls.
origin: FluxIQWebExtension, 2026-11-10
---

# Several deterministic runs follow every exploration

Aiden said, on 2026-11-10: "you should always be testing multiple deterministic runs after initial exploration runs on each task to make sure it successfully uses the right flow, see how many model calls are made if any". He said it after one replay of a saved Flow went wrong in a way the single exploring run could not show.

Whenever a FluxIQ task is checked, live or provider-free, in the web Lab, through a FluxNode, or on a simulated Android, Linux or Windows environment, run the first attempt that explores and saves a Flow, then at least three more attempts on the state the first left. In the web Lab that is `lab attempt --attempts 4`. Each later attempt must be proven to start from and run the Flow its predecessor saved, and its report must name its path, the Flow it ran, its model calls (ideally none) and its time. A single attempt is a diagnosis, never acceptance. A later attempt that strays from the saved Flow, explores again, or spends calls is a defect to trace to its root, not noise to average away.

It matters because FluxIQ's value is that a task explored once runs cheaply and the same way after. A Flow that only worked on the run that built it, for example one that saved a one-off popup as a fixed step, looks fine after one run and fails on the second. Only repeated runs on what the first left reveal whether the Flow is reused, whether it is deterministic, and what each reuse really costs.
