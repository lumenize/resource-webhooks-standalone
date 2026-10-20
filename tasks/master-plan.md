# Resource webhooks, standalone

**Status:** Started 2026-10-20. A client subscribes to an MCP resource and hears about its changes by webhook, through methods of this extension's own, borrowing SEP-3415's webhook delivery design. The scope is resources rather than state in general, and subscribing only, since a resource with an `https` URI can already be polled with a conditional `GET` (Larry, 2026-10-20). The rest is written one increment at a time, the prototype's design first. `../mcp-events-prototype`'s task files are mined in detail once the high-level shape is settled.
