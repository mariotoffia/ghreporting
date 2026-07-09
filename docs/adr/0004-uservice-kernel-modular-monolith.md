# 0004 — uService kernel: modular monolith, in-process event bus, SSE

Status: accepted

## Context

The requirements name several cooperating services (data sync, credentials, auth,
notifications, workspace) and ask for a "uService framework". Real network
microservices for a single-user desktop tool would mean ports, serialization, and
failure modes with zero payoff.

## Decision

A **modular monolith**: every service implements the small `MicroService` port
(ARCHITECTURE.md §3) and is composed by a kernel — registry with ordered
init/shutdown, shared `ServiceContext`, typed in-process `EventBus`, and route
mounting under `/api/<name>`. Services never import each other; they share the typed
`AppEvent` union and ports. Server→browser push uses **SSE**, not WebSocket: the flow
is one-directional, EventSource reconnects natively, and it survives proxies and the
packaged binary unchanged.

## Consequences

- uService boundaries are enforced by convention + review (LINT.md), physically by
  file layout, not by the network — cheap now, and the ports make a later split
  possible if ever needed.
- The `AppEvent` union is a single file every cross-service interaction must touch —
  deliberate visibility choke point.
- One process, one DB connection pool, one lifecycle — no distributed anything.

## Rejected alternatives

- **Separate processes/containers per service:** operational cost with no user-visible
  benefit at N(users)=1.
- **WebSocket:** bidirectional capability we don't need, plus hand-rolled reconnect.
- **Untyped string-topic event emitter:** loses exhaustive matching; events are the
  contract between contexts and deserve types.
