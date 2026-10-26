# Owner Shield (version 4.0)

Emergency defense-in-depth for **one owner-identified Manifexus instance**. Enrollment is by a SHA-256 fingerprint of a Docker daemon ID, not by hostname, public IP, password or device location. The hash is a selection mechanism, NOT an authentication proof.

At startup on the matched host only, Manifexus sets `allowServerChanges=false` in its persisted settings. It denies API requests other than `GET /api/health` and does not accept HTTP mutations. Its WebSocket file editor checks `serverChangesAllowed()` and cannot edit while Server Changes is off. The static dashboard shell remains visible, but its API requests report HTTP 423. The updater scheduler continues working.

**Limits:** This does **not** encrypt disks, protect data from someone with physical drive access, revoke logins, close other services, control the host firewall, or lock the operating system. It is NOT a password unlock feature. The user's previously shared password is NOT used or stored. The owner can restore administration through a future GitHub-controlled release or direct authenticated host access.

**Operational:** Developer-enforced update policy can deliver this release to compatible running installations, but this does not prove the target received it. The user must independently verify the target version. Never claim that data at rest is protected by this change.
