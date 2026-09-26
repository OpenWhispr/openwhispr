# Orukeet streaming benchmarks

Measured September 16, 2026 through `https://orukeet.gizmovoice.ai`, backed by three warm NVIDIA L4 GPUs in Oregon, the Netherlands and Singapore. Each GPU is in a GCP `g2-standard-8` instance. Model: `orukeet-v0.1.0`.

## Stop to final latency

Ten seconds of mono PCM16 audio at 16 kHz, uploaded during simulated real-time capture. Timing begins immediately before commit after the last audio frame, and ends on the full transcript. Recording duration, session/token setup, cleanup and paste are excluded. The endpoint does not return interim words.

| Client               |  Median |      p95 | Recordings |
| -------------------- | ------: | -------: | ---------: |
| California Mac       | 92.3 ms | 144.8 ms |         15 |
| Oregon cloud VM      | 37.4 ms |  88.7 ms |         15 |
| Netherlands cloud VM | 28.5 ms |  31.2 ms |         15 |
| Singapore cloud VM   | 23.2 ms |  26.8 ms |         15 |

Median inference was approximately 15.3 ms; median server time was approximately 17 ms. Each cloud region used three five-recording runs, while the Mac used one fifteen-recording session. Colocated cloud clients are not representative of residential users in those countries.

Three fresh token-authenticated sessions using the PR adapter separately measured **78.9, 84.9 and 83.6 ms** commit-to-final, 151–359 ms for token issuance, and 211–274 ms to reach WebSocket readiness. The [live adapter receipt](integrations/orukeet/live-adapter-results.json) retains each run and its transcript hash. Start connection setup during capture and buffer initial samples. Very short recordings can still pay setup time.

## Concurrent recording clients

32 paced connections per region overlapped for a measured fleet peak of 96. Three runs completed 864 recordings with no failed utterances, transcript mismatches or capacity retries.

| Region      |  Median |     p95 |
| ----------- | ------: | ------: |
| Oregon      | 34.7 ms | 89.9 ms |
| Netherlands | 28.5 ms | 30.4 ms |
| Singapore   | 22.9 ms | 25.0 ms |

The configured socket ceiling is not a demonstrated user count. These results establish 96 concurrent recording connections under this workload, not the maximum fleet capacity.

## Saturated streaming throughput

Audio was sent without capture pacing over 16 reused WebSockets per GPU. Rates count finals inside fixed 20-second measurement windows and report the median of three runs per region.

| Region      | Ten-second utterances per second | p95 final latency |
| ----------- | -------------------------------: | ----------------: |
| Oregon      |                            86.80 |          370.8 ms |
| Netherlands |                            91.15 |          544.0 ms |
| Singapore   |                            90.45 |          511.3 ms |

Including responses drained after the windows, these runs completed 16,237 utterances without a failed utterance or mismatch. They generated 10,888 expected capacity responses; clients honored backoff and retried commit without reupload. The longest final was about 2.58 seconds. These are saturation rates, not a low-latency operating target or user count. Summing the medians is not an independently measured fleet throughput.

An earlier fixed-workload test used eight sockets and 100 utterances each, repeated three times per region. It measured 63.4/s in Oregon, 92.5/s in the Netherlands and 93.1/s in Singapore. Slower Cloudflare paths in Oregon left slow sockets draining after faster ones completed. Both methods are retained in the [benchmark receipt](integrations/orukeet/benchmark-results.json).

Oregon inference stayed near 15 ms while Cloudflare Seattle connections had roughly 17–19 ms application-ping round trips and Portland connections had roughly 70–71 ms. The slower run is retained in the p95. Before/after routes were measured at different times and should not be interpreted as a causal speed comparison.

## Reliability and coverage

The native latency and load campaigns completed 24,361 matching finals without failed utterances. This count includes expected saturation backpressure and is separate from the following checks:

- 189 live API/authentication checks passed, including TLS, missing/invalid auth, token expiry, cross-region single-use consumption and replay rejection.
- 11 recording-boundary checks passed at 31, 61 and 600 seconds and above the limit. Above-limit audio was rejected with WebSocket close code 1009.
- During a controlled European readiness drain, the first alternate new socket appeared at 17.3 seconds; three consecutive alternate sockets were confirmed by 25.3 seconds. An existing socket with half a recording buffered survived and completed correctly. All three backends recovered. A hardware failure can still interrupt an active socket.
- The country proxy audit reached 18 countries with 20 verified route pairs and 80 matching transcripts. The initial Australian exit failed on both routes; three fresh exits passed. These timings include California → Decodo residential exit → API → return and are not native-country latency estimates.

The fixture tests serving performance and transcript parity, not general recognition accuracy. Measurements do not establish a worldwide SLA or native hotkey-to-paste latency. Signed desktop acceptance and private account/usage integration are separate [rollout requirements](orukeet-streaming.md).

## Reproduce the adapter latency check

Use Node 24 and a mono 16 kHz PCM16 WAV file. Inject `ORUKEET_SERVICE_KEY` through your operator secret manager; never commit it. Run:

```sh
node scripts/benchmark-orukeet.cjs /absolute/path/to/audio.wav
```

The optional second argument is a local JSON file with a `text` field for exact transcript comparison. `SMOKE_RUNS` defaults to three and accepts one through ten. Output includes the fixture hash, region, setup time, inference/server/queue time, commit-to-final latency and a transcript hash; it excludes transcript text and credentials. This operator tool combines backend token issuance and desktop transport for testing. It does not substitute for testing the private customer login/allowance route.
