# Bugfix Requirements Document

## Introduction

DHT nodes in production are experiencing critical memory leaks and stability issues causing 160-186 restarts per node over ~5 days. Nodes hit their 128MB memory limit, restart, and then enter a degraded state where DHT message handlers are detached, causing messages to be dropped. This creates a cascading failure pattern where the network becomes increasingly unstable.

The root causes are:
1. Interval timers in `KademliaDHT.startMaintenanceTasks()` and `OverlayNetwork.startMaintenanceTasks()` are never stored or cleared on stop
2. Maps (`pendingRequests`, `peerNodes`, `processedMessages`, etc.) grow unbounded without proper cleanup
3. DHT message handlers are not reattached to connection managers after node restart
4. Stale browser peer entries accumulate in routing tables

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `KademliaDHT.stop()` is called THEN the system only clears `bootstrapRetryTimer` and `refreshTimer`, leaving `republishData`, `cleanupTrackingMaps`, `cleanup`, `maintainRoutingTableConnections`, and `cleanupStaleConnections` interval timers running

1.2 WHEN `OverlayNetwork.stop()` is called THEN the system does not clear `sendKeepAlives`, `cleanupRoutingCache`, or `checkConnectionHealth` interval timers, leaving them running indefinitely

1.3 WHEN a DHT node runs for extended periods (hours/days) THEN the system accumulates memory from interval timer closures and callback references that are never released

1.4 WHEN `pendingRequests` entries timeout THEN the system does not always clean up the Map entries, causing unbounded growth

1.5 WHEN peers disconnect THEN the system leaves orphaned entries in `peerNodes`, `failedPeerQueries`, `peerFailureBackoff`, and related Maps

1.6 WHEN a node restarts after OOM and reconnects THEN the system recreates connection managers without reattaching `dhtMessage` event listeners

1.7 WHEN DHT messages arrive at a connection manager without listeners THEN the system logs "NO DHT MESSAGE LISTENERS ATTACHED!" and drops the message

1.8 WHEN browser peers disconnect THEN the system continues attempting to connect to stale peer entries, creating timeouts and consuming resources

### Expected Behavior (Correct)

2.1 WHEN `KademliaDHT.stop()` is called THEN the system SHALL clear all interval timers including `republishData`, `cleanupTrackingMaps`, `cleanup`, `maintainRoutingTableConnections`, and `cleanupStaleConnections` by storing their references and calling `clearInterval()` on each

2.2 WHEN `OverlayNetwork.stop()` is called THEN the system SHALL clear all interval timers including `sendKeepAlives`, `cleanupRoutingCache`, and `checkConnectionHealth` by storing their references and calling `clearInterval()` on each

2.3 WHEN a DHT node runs for extended periods THEN the system SHALL maintain stable memory usage by properly cleaning up all timer references and closures

2.4 WHEN `pendingRequests` entries timeout THEN the system SHALL always remove the entry from the Map to prevent unbounded growth

2.5 WHEN peers disconnect THEN the system SHALL clean up all related entries from `peerNodes`, `failedPeerQueries`, `peerFailureBackoff`, and related Maps

2.6 WHEN a node restarts and reconnects THEN the system SHALL ensure `dhtMessage` event listeners are properly attached to all connection managers

2.7 WHEN DHT messages arrive at a connection manager THEN the system SHALL have at least one listener attached to process the message

2.8 WHEN browser peers disconnect THEN the system SHALL remove stale entries from the routing table and stop connection attempts to those peers

### Unchanged Behavior (Regression Prevention)

3.1 WHEN maintenance tasks are running normally THEN the system SHALL CONTINUE TO perform `republishData` at the configured interval

3.2 WHEN maintenance tasks are running normally THEN the system SHALL CONTINUE TO perform `cleanupTrackingMaps` every 5 minutes

3.3 WHEN maintenance tasks are running normally THEN the system SHALL CONTINUE TO perform routing table maintenance at the configured interval

3.4 WHEN a valid peer is in `pendingRequests` and responds before timeout THEN the system SHALL CONTINUE TO process the response correctly

3.5 WHEN peers are actively connected THEN the system SHALL CONTINUE TO maintain their entries in `peerNodes` and related Maps

3.6 WHEN DHT messages arrive during normal operation THEN the system SHALL CONTINUE TO route them to the DHT for processing via the `dhtMessage` event

3.7 WHEN browser peers are actively connected THEN the system SHALL CONTINUE TO maintain their routing table entries and allow message exchange

3.8 WHEN `OverlayNetwork` keep-alives are sent THEN the system SHALL CONTINUE TO maintain connection health for active peers
