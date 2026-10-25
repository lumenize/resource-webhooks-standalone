# Demo script

What Larry says while the demo runs, beat by beat. The beats follow the scenarios in [tasks/master-plan.md](tasks/master-plan.md), so the narration and the design stay in step.

## Opening

Picture a client watching a note. Its laptop closes, the note changes three times, and when the laptop wakes the client wants the note as it is now, not a replay of every edit. The Events SEP's Open Question 6 has the same case for tasks: "kick off a long job, close the laptop, get notified when done".

Re-expressing today's resource notification as an event sits on top of the Events SEP with nothing added, using the event type its Open Question 2 sketches. So we'll start there, and demo it quickly. It is also the baseline that everything after it is measured against.

The question the rest of the demo takes up is Peter's, from the SEP's thread: whether watching state is the same abstraction as consuming messages. He suggested it may need different APIs on the same machinery. On that thread I said I'd build state as event types on the Events SEP's own methods, and I will. But Peter's version is the one I built first: resources get two methods of their own, and use the Events SEP's webhook rules unchanged. Comparing the [N] flavors is how we'll see where the API has to diverge.

The state here is a resource's rather than a task's, since a resource already has a URI and contents. Whether what we learn carries over to Open Question 6's tasks is a question for the Tasks side of this working group.

## The beats

Each beat names what is on screen. Larry has rehearsed the first few, and the narration for the rest waits until he rehearses them after the build.

1. **The cast.** Four boxes: the writer `a`, the server A, the gateway B, and the client `b` behind it. The page shows every message, and what each party holds.
2. **MCP core as it is** (Scenario 1a). `a` writes a note with `write_note`, and `b` reads it with `resources/read`. Nothing in the result names a version, and hearing about the next change would mean holding a stream open.
3. **Plain HTTP** (Scenario 1b). ETags and a conditional `GET`. Polling is solved for an `https` resource, but nobody is told when it changes.
4. **`mcp.resource.updated` over Events** (Scenario 2). `b` subscribes to `mcp.resource.updated`, naming B's webhook URL, and an ordinary occurrence reaches it through B. Nothing here is new. Its costs are two round trips per change, and no catch-up. Replay could fill that gap, but it would cost a watermark for each subscription and send every step, where state sync sends each resource's newest version once.
5. **Wipe.** The page empties all four parties, so level 2 starts from a clean slate, with nothing carried over.
6. **Only the newest version matters.** The turn to state sync: a watcher needs the latest value, not every change.
7. **A first subscription, from nothing** (Scenario 3). One call subscribes and reads: its result names `v1` and carries the note.
8. **A change it hears about** (Scenario 4). The new version arrives with its contents. In the default `notify` form it would be the same news as level 1's occurrence plus one field, the version, which lets `b` skip a read.
9. **A refresh** (Scenario 5). Neither a push nor a read: the subscriber's own call, which extends the grant and says what is current.
10. **The laptop sleeps** (Scenario 6). With the demo's retry schedule on screen, `v4` replaces the pending `v3` while the audience watches.
11. **Away past the retries** (Scenario 7). One refresh brings `b` to the current version.
12. **A deletion** (Scenario 8).
13. **A folder** (Scenario 9), **and catching it up** (Scenario 10). note-43, edited twice and then deleted while `b` slept, comes back once, as its deletion.
14. **What each flavor costs the SEPs.** The ledger of substitutions, narrowings and departures, and what comes next: the PR to the working group's repo, then an official-SDK implementation.
