# Quoted standalone real-request receipts

These raw JSON files are copied byte-for-byte from the read-only repository `/home/remote3/dev/pi-model-tools` at commit `814562b`, `scripts/real-priority-evidence.json` and `scripts/real-priority-corrected-evidence.json`. They are **quoted reference evidence**, not tests run for this integration. No credentials are present. No probe script is copied or executed.

Verified SHA-256 equality at copy time:

- `real-priority-evidence.json`: `84254641ffc2dc850281172dc7f5acb71946e4c3a86abc3846600a8ed4bf11d2`
- `real-priority-corrected-evidence.json`: `833448e72dc931ee30000905ee092ffebd0140a1857eb66050f358f56d342ca4`

The original HTTP400 was unsupported reasoning.effort=none, not a service-tier rejection. The corrected HTTP200 accepted a priority payload; early auto was superseded by the authoritative completed **default** tier. Neither receipt proves priority execution, speed or quota impact. The source operator authorized exactly these two requests; both are consumed. No more real-provider tests are authorized. Amber integration verification uses loopback mocks only.
