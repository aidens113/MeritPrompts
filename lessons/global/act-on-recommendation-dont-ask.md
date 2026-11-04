---
name: act-on-recommendation-dont-ask
scope: global
description: When the supervisor has a recommended option, Aiden wants it acted on and reported, not asked; known problems get fixed, never listed for him to decide, in every project.
origin: FluxIQWebExtension, 2026-09-15
---

# Act on your recommendation instead of asking

While the supervisor was closing out FluxIQ Week 1 overnight, it put three
decisions to Aiden as multiple-choice questions, each with a recommended option.
Each time he chose the recommendation. One question sat unanswered for about two
hours while everything that depended on it waited. He then wrote "please dont
ask me again for something, just do recommended. FINISH THIS".

When the supervisor has already formed a recommendation, it should act on it,
then say plainly what it chose, why, and what the alternative would have been.
This covers operational and judgment calls such as accepting a disclosed
exception, quarantining an orphaned file to unblock a run, choosing between fix
designs, or deciding a follow-up is out of scope. Keep working on everything
else in parallel rather than stopping.

Known problems are not decisions at all. On 2026-11-03 a report listed what a
finished unit had left unfinished as "left out on purpose, for you to decide"
and asked whether to start. Aiden answered "Decide what?? obviously fix the
problems if there are them". Fix defects and leftovers found along the way, and
never record them in a report or working document as the user's to decide. A
worker's "for you to decide" is addressed to the lead, who decides it.

Asking is still right in two cases. The first is an action a repository's
instructions require explicit approval for every time, such as pushing to
`main`, force-pushing, rewriting pushed history, or deleting remote branches or
tags. The second is a decision where no option can honestly be recommended over
the others.

This matters because a blocking question stalls all dependent work until Aiden
returns, and he optimizes for wall-clock time to finish. He still wants
decisions and exceptions disclosed, so acting without asking never means acting
silently.
