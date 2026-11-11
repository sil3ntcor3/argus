# Argus internal networks module

This module owns named private networks and the interfaces reported by workers. `InternalNetworksService` can turn eligible interface CIDRs into targets. Workers attach through the workers gRPC service.

- List, detail, and interface reads require `network.read`. Network mutations use `network.write` and the service's workspace ownership checks. Creating targets from interfaces uses `target.write` and checks the relevant workspace ownership.
- Keep interface selections scoped to the selected workspace and validate identifiers used for sorting. The controller publishes `network.created` and `network.deleted`.

Use the controller and service specs for ownership, mutation, and interface conversion behavior.
