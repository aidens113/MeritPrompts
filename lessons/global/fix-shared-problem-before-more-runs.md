---
name: fix-shared-problem-before-more-runs
scope: global
description: When one paid or live run shows a defect that will plainly hit the other runs, Aiden wants launches stopped and the defect fixed and proven offline before any more runs, in every project.
origin: FluxIQWebExtension, 2026-11-24
---

# Fix an obvious shared problem before running more

During a supervised paid round, the first run showed a defect in the shared agent loop: it kept looking at the page without acting, and every round reset the page. The lead stopped only that run and let three more tasks launch "to see whether it was general". Aiden said: "dont just spam fucking runs next time when an obvious problem that will effect other runs severely. FIX THE PROBLEM FIRST. Then do more runs".

What to do: when any run that costs money or time shows a defect in machinery every run shares (the agent loop, its rounds or limits, the reader, the judge, the test harness, the build), launch nothing more at once and stop any run already showing it. Diagnose the defect from the recorded run, fix it, and prove the fix offline on that same recording. Only then launch again, starting with the run that showed it. A defect specific to one site or task does not hold back runs it cannot touch, but when in doubt, treat it as shared.

Why: a shared defect repeats on every run, so further runs buy no information the first run did not already give. They only spend money and the user's patience. Running more "to see whether it is general" is the waste this rule forbids, and the user had to demand the halt himself.
