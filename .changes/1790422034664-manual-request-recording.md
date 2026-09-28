---
bump: minor
---
Add `/record-start` and `/record-end` to manually capture proxy requests, actual Copilot request bodies, and full upstream responses in private local recording folders. `/record-start` defaults to retaining failed requests only; pass `full` to retain successful requests too. Recording is off by default, supports concurrent requests and in-flight draining, batches streamed response writes, and surfaces incomplete capture warnings without blocking proxy traffic.
