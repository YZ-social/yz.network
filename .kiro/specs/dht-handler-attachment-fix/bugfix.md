# Bugfix Requirements Document

## Introduction

DHT message handlers are not being attached to the correct connection managers for incoming WebSocket connections between Node.js DHT nodes. When a peer connects, a dedicated `peerManager` is created with the actual WebSocket connection, but the DHT message handler gets attached to a different manager instance. This causes all DHT messages (ping, find_node, store, etc.) to be dropped with "NO DHT MESSAGE LISTENERS ATTACHED!" warnings, resulting in network formation failure.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an incoming WebSocket connection is established AND the node is added to the replacement cache (bucket full) THEN the system does not call `onNodeAdded` callback, so `KademliaDHT.handlePeerConnected()` is never invoked and DHT message handlers are never attached to the dedicated `peerManager`

1.2 WHEN `KademliaDHT.getOrCreatePeerNode()` is called AND `routingTable.getNode(peerId)` returns `null` (node in replacement cache) THEN the system creates a NEW `DHTNode` with a NEW connection manager from `ConnectionManagerFactory.getManagerForPeer()` instead of using the existing dedicated `peerManager` that has the actual WebSocket connection

1.3 WHEN DHT messages arrive on the dedicated `peerManager` (which has the WebSocket) AND the DHT message handler is attached to a different manager instance THEN the system logs "NO DHT MESSAGE LISTENERS ATTACHED!" and drops the message

1.4 WHEN ping messages are sent to a peer AND the response arrives on the dedicated `peerManager` without a handler THEN the system times out waiting for a response that was actually received but not processed

### Expected Behavior (Correct)

2.1 WHEN an incoming WebSocket connection is established THEN the system SHALL attach the DHT message handler directly to the dedicated `peerManager` that receives the WebSocket messages, regardless of whether the node is added to the main bucket or replacement cache

2.2 WHEN `RoutingTable.handlePeerConnected()` is called with a dedicated `peerManager` THEN the system SHALL ensure the DHT message handler is attached to THAT SPECIFIC manager before returning

2.3 WHEN DHT messages arrive on any connection manager THEN the system SHALL have a handler attached to process them and route them to `KademliaDHT.handlePeerMessage()`

2.4 WHEN ping messages are sent and responses arrive THEN the system SHALL process the response through the attached handler and resolve the pending request

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an outgoing WebSocket connection is established (initiator=true) THEN the system SHALL CONTINUE TO create a connection manager via `ConnectionManagerFactory.getManagerForPeer()` and attach DHT handlers to it

3.2 WHEN a node is successfully added to the main routing table bucket THEN the system SHALL CONTINUE TO call the `onNodeAdded` callback to notify `KademliaDHT`

3.3 WHEN `routingTable.getNode(peerId)` returns an existing node with a connection manager THEN the system SHALL CONTINUE TO use that existing manager and not create a new one

3.4 WHEN WebRTC connections are established between browsers THEN the system SHALL CONTINUE TO handle DHT messages through the WebRTC connection manager

3.5 WHEN bootstrap server connections are established THEN the system SHALL CONTINUE TO ignore them in the routing table (they are not DHT peers)

## Bug Condition Analysis

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type IncomingConnection
  OUTPUT: boolean
  
  // Returns true when DHT handler is attached to wrong manager
  dedicatedManager ← X.peerManager  // Manager created for incoming connection
  handlerManager ← getManagerWithDHTHandler(X.peerId)  // Manager with handler attached
  
  RETURN dedicatedManager ≠ handlerManager OR handlerManager = NULL
END FUNCTION
```

### Property Specification - Fix Checking

```pascal
// Property: Fix Checking - DHT Handler Attachment
FOR ALL X WHERE isBugCondition(X) DO
  result ← handleIncomingConnection'(X)
  dedicatedManager ← result.peerManager
  
  ASSERT dedicatedManager.listenerCount('dhtMessage') > 0
  ASSERT dedicatedManager._dhtMessageHandlerAttached = true
END FOR
```

### Preservation Goal

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
  // Outgoing connections, existing nodes, WebRTC, bootstrap all work unchanged
END FOR
```
