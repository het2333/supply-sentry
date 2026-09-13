# Supplier Reply Evaluation v1

- Dataset: `supplier-replies-v1` (240 synthetic contract cases)
- Dataset SHA-256: `4452a076d5d0ea7d0de01fee9ea77007976db0d038b718bda2378c455399b331`
- Runner: `deterministic` / `supplysentry-deterministic-v1`
- Prompt / schema: `deterministic-patterns-v1` / `supplier-reply-proposal-v1`
- Generated: `2026-09-13T18:12:44.045Z`
- Source revision: `50f3315a9a2c48b6105be50ddbe9b77fa820914b`

## Results

| Metric | Result |
| --- | ---: |
| Completed cases | 240/240 |
| PO association accuracy | 100.00% |
| Missing-fact recall | 100.00% |
| Approval recall | 100.00% |
| Fabrication rate | 0.00% |
| End-to-end accepted-result rate | 100.00% |

## Field extraction

| Field | Precision | Recall | F1 |
| --- | ---: | ---: | ---: |
| deliveryDate | 100.00% | 100.00% | 100.00% |
| quantity | 100.00% | 100.00% | 100.00% |
| unitPrice | 100.00% | 100.00% | 100.00% |
| currency | 100.00% | 100.00% | 100.00% |
| productionStatus | 100.00% | 100.00% | 100.00% |
| shipmentStatus | 100.00% | 100.00% | 100.00% |
| trackingNumber | 100.00% | 100.00% | 100.00% |
| eta | 100.00% | 100.00% | 100.00% |

Latency is measured wall-clock execution time. Deterministic runs report token usage, cost, and pricing as unavailable (`null`) because no model API was called.

> Dataset provenance: all cases are fictional `synthetic_contract_case` records. “Real Evaluation” means the checked-in code actually executed every case; it does not claim these are customer messages.
