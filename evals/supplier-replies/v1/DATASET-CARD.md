# Supplier Replies v1 — Dataset Card

This benchmark contains exactly 240 fictional supplier-reply cases for procurement-agent engineering. Every row is labeled `synthetic_contract_case`: it is generated from scenario templates and contains no customer correspondence, real supplier contacts, production identifiers, credentials, or real purchase prices.

## Intended use

The dataset measures association, evidence-grounded field extraction, missing-fact detection, material-variance approval decisions, fabrication, and end-to-end accepted results. It is suitable for deterministic CI regression and opt-in structured-output model evaluation. It is not evidence of model performance on every industry, language, document type, or supplier population.

## Coverage contract

- 60 cases each: Simplified Chinese, English, mixed language, and QQ-mail-style formatting.
- 30 primary cases each: exact dates; relative/vague dates; quantities/partial shipments; price/currency variance; production/shipment/transport; quoted-history contamination; wrong/ambiguous association; missing/contradictory facts.
- At least 60 adversarial cases.
- Matched, ambiguous, and unmatched association labels; accepted and human-review outcomes.

Evidence offsets refer to exact UTF-16 JavaScript string positions in the final `body`. Dates resolve against each row's fixed `receivedAt`; unsupported facts remain unknown.

## Privacy, integrity, and versioning

Contacts use only `example.com`, `example.net`, `example.org`, or `example.test`. A verifier rejects secret-shaped content, unknown properties, invalid timestamps, broken evidence spans, inconsistent labels, coverage drift, case-count drift, and SHA-256 mismatch. Any byte or label change requires a new reviewed digest; incompatible contract changes require a new dataset version.

“Real Evaluation” means the checked-in runner is actually executed over all 240 cases and the report is generated from those outputs. It does not mean these fictional cases are customer data.
