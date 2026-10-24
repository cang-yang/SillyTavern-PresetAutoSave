# Save, Switch, and Export Performance Evidence

Date: 2026-10-24. This supplements the catalog/panel measurements; it is not an
independent scorecard or a claim of improvement against an unmeasured baseline.

## Reproduction and Environment

```text
node --check tests/benchmarks/save-export.mjs
node --expose-gc tests/benchmarks/save-export.mjs
```

Both commands passed. The benchmark was run twice in separate Node processes.
Each scenario uses three warmups and twenty measured samples, with a forced
garbage collection before each measured sample. Output is JSON Lines on stdout;
the script does not read or write user data or contact a host/network.

- Node v24.14.1, Windows 10.0.26100 x64.
- Intel Core i7-13650HX, 20 logical CPUs, 31.628 GiB system memory.
- Main-thread synthetic structuredClone memory adapter.
- Percentiles use nearest-rank selection; times below are milliseconds.
- Samples contain valid full OpenAI canonical presets and unique snapshot IDs.

## Measured Work

Capture uses the real canonical preset schema, structured cloning, stable
serialization, canonical hash, and exact raw JSON fingerprint. The commit
scenario uses the real SaveCoordinator and commitPresetSave with synthetic
memory persistence/synchronization and real history-schema enrichment. It
does not simulate IndexedDB, migration, catalog persistence, quota behavior,
disk durability, or complete host/plugin UI work.

The queue scenario sends eight non-coalescing requests to the real coordinator,
injecting 15 ms host latency for each. Wait measures enqueue to worker start.
The switch scenario uses the real convergence controller and real canonical
capture; live and stored candidates disagree through 125 samples at a virtual
80 ms cadence until the virtual 10-second timeout. The benchmark asserts
timeout, no false convergence, and an inactive controller afterward.

Export uses actual createHistoryBackup validation/sanitization plus JSON
serialization and UTF-8 byte counting. A setImmediate probe scheduled before
export measures delay until the next event-loop turn. Fixtures are deliberately
repetitive synthetic strings, not a claim to model all extension dictionaries.

## Run 1

| Scenario | P50 wall | P95 wall | Max wall | P50 heap delta MiB |
| --- | ---: | ---: | ---: | ---: |
| Capture 4 KiB prompt | 0.237 | 0.266 | 0.308 | 0.060 |
| Memory commit 4 KiB prompt | 0.224 | 0.263 | 0.265 | 0.052 |
| Capture 1 MiB prompt | 10.398 | 10.690 | 10.902 | 4.044 |
| Memory commit 1 MiB prompt | 7.577 | 7.932 | 8.272 | 7.024 |
| Eight-request queue with injected latency | 124.788 | 127.271 | 127.574 | 0.216 |
| Entire virtual unsettled switch | 12.302 | 13.435 | 14.350 | 5.991 |
| Export 500 snapshots x 2 KiB prompt | 13.339 | 16.091 | 16.175 | 7.497 |
| Export 500 snapshots x 10 KiB prompt | 20.997 | 24.191 | 25.868 | 15.501 |
| Export 5 snapshots x 1 MiB prompt | 14.451 | 16.101 | 16.125 | 10.071 |

## Run 2

| Scenario | P50 wall | P95 wall | Max wall | P50 heap delta MiB |
| --- | ---: | ---: | ---: | ---: |
| Capture 4 KiB prompt | 0.220 | 0.456 | 0.490 | 0.060 |
| Memory commit 4 KiB prompt | 0.246 | 0.332 | 0.364 | 0.052 |
| Capture 1 MiB prompt | 10.755 | 11.254 | 11.427 | 4.044 |
| Memory commit 1 MiB prompt | 7.897 | 8.317 | 8.329 | 7.024 |
| Eight-request queue with injected latency | 124.432 | 126.029 | 126.316 | 0.216 |
| Entire virtual unsettled switch | 12.940 | 14.028 | 14.090 | 5.992 |
| Export 500 snapshots x 2 KiB prompt | 14.885 | 15.651 | 15.828 | 7.497 |
| Export 500 snapshots x 10 KiB prompt | 24.053 | 24.751 | 24.896 | 15.501 |
| Export 5 snapshots x 1 MiB prompt | 15.170 | 15.486 | 15.601 | 10.071 |

## Waiting and Blocking

| Measurement | Run 1 P50 / P95 / max | Run 2 P50 / P95 / max |
| --- | --- | --- |
| Queue wait per request | 49.287 / 108.727 / 111.295 | 47.653 / 108.668 / 110.191 |
| One unsettled-switch callback | 0.095 / 0.145 / 0.441 | 0.097 / 0.139 / 0.279 |
| 1,234,444-byte export next-turn delay | 13.334 / 16.082 / 16.166 | 14.877 / 15.642 / 15.822 |
| 5,330,444-byte export next-turn delay | 20.993 / 24.187 / 25.863 | 24.049 / 24.746 / 24.892 |
| 5,245,101-byte export next-turn delay | 14.447 / 16.097 / 16.120 | 15.167 / 15.481 / 15.596 |

Queue timing includes intentional asynchronous host delay and is not CPU time.
The ten-second switch wait is virtual; total measured CPU work is split over
125 callbacks in actual use, not executed in one ordinary interaction.
Exports are explicit bulk commands, not typing or scrolling callbacks.
These measured callback/wall samples show no ordinary operation above 50 ms;
this does not establish a browser Long Tasks guarantee or performance on mobile.

## CPU and Memory Limits

The script also emits process.cpuUsage P50/P95/max for every scenario. On this
Windows machine it has coarse increments (often 0 or approximately 16 ms);
short operation CPU values are not useful sub-millisecond measurements.
For example, 1 MiB capture CPU is 15/16/16 ms in both runs; 1 MiB commit CPU
is 0/16/77 ms in run 1 and 15/63/78 ms in run 2 despite wall maxima below
8.4 ms. Process-wide CPU can include parallel/background GC and cannot be
used to label the main-thread callback a 78 ms long task.

Heap deltas are sampled after the operation before forced collection, not
peak allocations, retained-memory/leak tests, or a browser memory budget.
The 5.33 MB export shows roughly 15.50 MiB heap growth per measured operation;
GC, shared fixture strings, output lifetime, and implementation overhead matter.
Forced GC improves repetition control but differs from a real user session.

## Conclusion and Boundaries

The new harness closes missing repeatable evidence for capture, coordinator
commit/wait, an unsettled switch, and large export memory/blocking. It does not
claim a measured before/after improvement. No production changes were made
for this benchmark, and no performance gate was weakened to accept results.

Remaining product-level evidence belongs to the maintained browser harness
and independent review: real host I/O, device contention, mobile CPUs, browser
long-task traces, and UI rendering are outside this synthetic core benchmark.

## Root Reproduction

Root independently reran the same command on the frozen data/save checkout.
All assertions passed. P95 wall measurements were 10.925 ms for 1 MiB capture,
7.928 ms for its memory commit and 0.150 ms per unsettled-switch callback.
The 5,330,444-byte export's next-turn delay was 21.653/25.552/26.553 ms
(P50/P95/max). This supports repeatability on this machine, not a broader
hardware or actual-host performance claim.
