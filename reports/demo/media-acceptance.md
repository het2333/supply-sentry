# SupplySentry Demo Media Acceptance

Accepted capture: 2026-09-14 local public-demo run, tenant `t:public-demo`, generation 7.

## Deliverables

| Artifact | Technical result | SHA-256 |
| --- | --- | --- |
| `docs/assets/supplysentry-demo.gif` | 18.01 s, 1280×720, 461,013 bytes | `510b7f407d06b07026d08cc3759d22d332767e1b1bd1e1d683ac12dea8f3b66a` |
| `docs/assets/supplysentry-demo-poster.png` | 1440×900, 187,157 bytes | `76e20398d6e928c55b10b985379ebaf1aa4027dac4c2bbdf16c672c5387c2345` |
| `artifacts/media/supplysentry-demo/supplysentry-walkthrough.mp4` | 61.00 s, H.264, 1920×1080, `yuv420p`, 749,747 bytes | `813a7f1e4cd5ac662feba40183eb77c295d432c2f2b35463c9f746a6788a22df` |

The MP4 is intentionally ignored by Git and is reserved for the GitHub Release asset. The GIF and poster are repository-sized assets.

## Capture contract

- Browser viewport: 1440×900 with no browser chrome.
- UI language: English; original synthetic supplier and item names remain unmodified business evidence.
- Story length: 8 scenes / 61 seconds.
- Entry is a real click on **Enter public demo**; subsequent navigation uses the application's browser-navigation contract and asserts the expected page heading.
- Every captured scene asserts the visible public-demo banner.
- Session establishment verifies `tenantId=t:public-demo` before any authenticated scene is captured.
- Capture host is restricted to `127.0.0.1` or `localhost`.

## Visual review

The opening frame and every scene frame were inspected in a 2×4 contact sheet.

| Check | Result |
| --- | --- |
| First frame clearly identifies the safe synthetic demo | Pass |
| Overview is readable at repository width | Pass |
| Vague-reply order and structured-evidence caption are visible | Pass |
| Partial-shipment approval card is visible | Pass |
| Notifications, SLA, drafted emails, and safety boundary are distinct scenes | Pass |
| Public-demo banner remains visible in all scenes | Pass |
| Captions do not cover the primary heading or decision card | Pass |
| No browser chrome, desktop notification, real account, credential, or production URL is visible | Pass |
| GIF stays below 8 MiB | Pass |
| MP4 codec, dimensions, pixel format, and duration meet the release contract | Pass |

## Interpretation boundary

The media demonstrates product UI and the isolated synthetic workflow. It is not evidence of a live customer deployment, external message delivery, production connector readiness, or hosted-model accuracy. Public-demo actions are represented by `simulated_demo` receipts with `externalDelivery=false`.
