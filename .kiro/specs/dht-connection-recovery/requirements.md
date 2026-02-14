# DHT Connection Recovery Requirements

## Introduction

The YZ Network DHT system is experiencing critical connection failures preventing nodes from discovering and connecting to each other. Nodes are running in Docker containers on Oracle Cloud infrastructure but cannot establish peer-to-peer connections, leading to network fragmentation and bootstrap failures.

## Glossary

- **DHT_Node**: A Kademlia distributed hash table node that stores data and routes messages
- **Bootstrap_Server**: Public edge server that coordinates DHT connections using stateless interactions with bridge nodes. Connects to bridge nodes on-demand to request random peer information, then disconnects immediately for enhanced security
- **Bridge_Node**: Special passive DHT nodes that participate in routing (find_node, connections) but do not handle data storage/retrieval. They help coordinate connections by providing random node selection for new connections
- **Genesis_Node**: The very first DHT node that connects to bridge nodes to bootstrap the entire DHT network. Only happens once per network
- **DHT_Token**: Cryptographic token that proves membership in the DHT network. Creates a web of trust tracking who invited whom
- **Invitation_Model**: Security model where nodes must be invited by existing nodes with valid DHT tokens to join the network
- **Open_Network**: Security model where anyone can join the DHT if they have the bootstrap address. Bridge nodes issue DHT tokens automatically
- **Connection_Manager**: Superclass that defines the API for peer-to-peer connections. Subclasses (WebRTC, WebSocket) implement specific transport protocols. Created per connection (not per node) by ConnectionManagerFactory which selects appropriate subclass based on node types. Routing_Table handles connection manager events and maintains connection-agnostic interface
- **Overlay_Network**: Message passing mechanism that allows users to send messages over the DHT network to specific nodes
- **Rate_Limiter**: Anti-spam mechanism that prevents excessive find_node requests
- **Routing_Table**: Local storage of known peer information organized in k-buckets
- **Pub_Sub**: Publish-subscribe mechanism for serverless messaging. The k closest nodes to a channel address handle subscribers, messages, and history
- **Sticky_Pub_Sub**: Pub/Sub with message persistence. Messages have TTL so new subscribers receive historical messages still within TTL
- **Pub_Sub_System**: Complete implementation of Sticky Pub/Sub with three-tier architecture (Coordinator, Collections, Messages), optimistic concurrency control, and push delivery
- **Coordinator_Object**: Mutable object stored at k-closest nodes to topic hash that tracks current subscriber and message collections with version-based optimistic locking
- **Message_Collection**: Immutable collection of message metadata with copy-on-write semantics to prevent race conditions during concurrent updates
- **Subscriber_Collection**: Immutable collection of active subscribers with expiry times and deterministic coordinator assignment for push delivery
- **Push_Delivery**: Real-time message delivery mechanism that attempts to send messages directly to active subscribers with sub-100ms latency
- **Optimistic_Concurrency**: Conflict resolution mechanism that allows concurrent updates to coordinator objects with automatic merge operations 

## Requirements

### Requirement 1

**User Story:** As a DHT node operator, I want nodes to successfully connect to each other, so that the distributed network can function properly.

#### Acceptance Criteria

1. WHEN a new node starts up, THE DHT_Node SHALL successfully connect to at least 3 existing peers within 30 seconds
2. WHEN nodes are running on the same Docker network, THE DHT_Node SHALL establish direct connections without bootstrap dependency
3. WHEN a node loses all connections, THE DHT_Node SHALL automatically reconnect to the network within 60 seconds
4. WHEN connection attempts fail, THE DHT_Node SHALL retry with exponential backoff up to 5 attempts
5. WHEN nodes are behind NAT/firewall, THE Bootstrap_Server SHALL coordinate connections through bridge nodes

### Requirement 2

**User Story:** As a network administrator, I want to diagnose connection failures quickly, so that I can resolve network issues efficiently.

#### Acceptance Criteria

1. WHEN connection failures occur, THE DHT_Node SHALL log detailed error information including peer IDs and failure reasons
2. WHEN rate limiting is triggered, THE DHT_Node SHALL log the specific rate limit thresholds and wait times
3. WHEN bootstrap fails, THE Bootstrap_Server SHALL provide specific error codes indicating the failure type
4. WHEN bridge nodes are unreachable, THE DHT_Node SHALL test each bridge node individually and report status
5. WHEN Docker networking issues occur, THE DHT_Node SHALL validate container network configuration

### Requirement 3

**User Story:** As a system architect, I want rate limiting to prevent spam without blocking legitimate discovery, so that nodes can find peers efficiently.

#### Acceptance Criteria

1. WHEN nodes perform legitimate peer discovery, THE Rate_Limiter SHALL allow sufficient find_node requests for network formation
2. WHEN emergency discovery is needed, THE Rate_Limiter SHALL provide bypass mechanisms for critical operations
3. WHEN rate limits are hit during startup, THE DHT_Node SHALL use alternative discovery methods
4. WHEN multiple nodes start simultaneously, THE Rate_Limiter SHALL scale limits based on network size
5. WHEN rate limiting blocks discovery, THE DHT_Node SHALL queue requests and retry with appropriate delays

### Requirement 4

**User Story:** As a DHT node, I want to maintain connection state accurately, so that I don't attempt connections to unreachable peers.

#### Acceptance Criteria

1. WHEN a peer connection is established, THE Connection_Manager SHALL update the routing table immediately
2. WHEN a peer disconnects, THE Connection_Manager SHALL remove the peer from active connection lists within 5 seconds
3. WHEN connection health checks fail, THE DHT_Node SHALL mark peers as stale and attempt reconnection
4. WHEN stale connections are detected, THE DHT_Node SHALL clean up resources and update routing tables
5. WHEN peer metadata changes, THE DHT_Node SHALL update stored peer information for future connections

### Requirement 5

**User Story:** As a bridge node operator, I want bridge nodes to provide random peer selection services, so that bootstrap server can coordinate connections.

#### Acceptance Criteria

1. WHEN bridge nodes start, THE Bridge_Node SHALL connect to existing DHT nodes and participate in routing operations
2. WHEN bootstrap server requests random peer selection, THE Bridge_Node SHALL provide random active DHT node information
3. WHEN bridge nodes are queried by bootstrap server, THE Bridge_Node SHALL respond with peer metadata and disconnect immediately
4. WHEN bridge nodes participate in DHT operations, THE Bridge_Node SHALL handle find_node and routing but reject data storage operations
5. WHEN multiple bridge nodes exist, THE Bootstrap_Server SHALL distribute queries across available bridge nodes for load balancing

### Requirement 6

**User Story:** As a Docker container behind nginx proxy, I want proper network configuration with unified external addressing, so that all connections use the same external endpoint while being routed internally.

#### Acceptance Criteria

1. WHEN nodes advertise connection addresses, THE DHT_Node SHALL always advertise the external nginx proxy address (e.g., imeyouwe.com/node1)
2. WHEN internal nodes connect to each other, THE DHT_Node SHALL connect to external proxy address which nginx routes to internal container names
3. WHEN nginx proxy forwards connections, THE DHT_Node SHALL accept connections from nginx proxy with proper WebSocket upgrade headers
4. WHEN container hostnames change, THE DHT_Node SHALL continue using external proxy paths without reconfiguration
5. WHEN external clients connect, THE DHT_Node SHALL handle connections identically whether from internal or external sources

### Requirement 7

**User Story:** As a system operator, I want automatic recovery mechanisms, so that temporary network issues don't cause permanent failures.

#### Acceptance Criteria

1. WHEN all connections are lost, THE DHT_Node SHALL automatically attempt bootstrap reconnection
2. WHEN bootstrap servers are unreachable, THE DHT_Node SHALL try alternative bootstrap endpoints
3. WHEN peer discovery fails and node has active connections, THE DHT_Node SHALL use DHT routing for alternative peer discovery
4. WHEN connection storms occur, THE DHT_Node SHALL implement jitter and backoff to prevent thundering herd
5. WHEN network partitions heal, THE DHT_Node SHALL automatically merge back into the main network

### Requirement 8

**User Story:** As a DHT network, I want proper mesh topology formation, so that peers can discover and connect to each other directly.

#### Acceptance Criteria

1. WHEN new peers join via invitation, THE DHT_Node SHALL announce the new peer to existing network members
2. WHEN peers receive peer announcements, THE DHT_Node SHALL add announced peers to routing tables for discovery
3. WHEN routing tables are populated, THE DHT_Node SHALL attempt connections to discovered peers within 30 seconds
4. WHEN multiple peers join simultaneously, THE DHT_Node SHALL form full mesh topology rather than hub-and-spoke
5. WHEN peer discovery completes, THE DHT_Node SHALL have direct connections to at least 3 other peers

### Requirement 9

**User Story:** As a developer, I want proper WebRTC signaling coordination, so that peer connections establish reliably when two clients attempt simultaneous connections.

#### Acceptance Criteria

1. WHEN two nodes attempt simultaneous WebRTC connections, THE DHT_Node SHALL use Perfect Negotiation Pattern to resolve conflicts
2. WHEN Perfect Negotiation is triggered, THE DHT_Node with the lexicographically smaller node ID SHALL act as "polite" peer and drop its connection attempt
3. WHEN Perfect Negotiation is triggered, THE DHT_Node with the lexicographically larger node ID SHALL act as "impolite" peer and continue its connection attempt
4. WHEN WebRTC signaling data is exchanged, THE DHT_Node SHALL route offers, answers, and ICE candidates through DHT messaging or bootstrap coordination
5. WHEN bootstrap coordination is needed for signaling, THE DHT_Node SHALL maintain bootstrap connection during the WebRTC establishment window

### Requirement 10

**User Story:** As a network administrator, I want strategic routing table maintenance with diverse connections, so that routing entries optimize DHT lookup performance within connection limits.

#### Acceptance Criteria

1. WHEN managing connections within limits, THE DHT_Node SHALL prioritize connections to nodes closest to its own address for neighborhood connectivity
2. WHEN routing table maintenance runs, THE DHT_Node SHALL query for k-closest nodes to its own address and favor connecting to nearby nodes
3. WHEN connection limits are reached, THE DHT_Node SHALL drop less strategic connections to make room for more optimal connections
4. WHEN maintaining routing table diversity, THE DHT_Node SHALL allow disconnected nodes to remain in routing table for fallback discovery
5. WHEN cleaning routing table, THE DHT_Node SHALL ping disconnected nodes and remove only those that fail to respond, not all disconnected nodes

### Requirement 11

**User Story:** As a security architect, I want stateless bootstrap-bridge interactions, so that the public edge server remains secure and minimizes attack surface.

#### Acceptance Criteria

1. WHEN bootstrap server needs peer information, THE Bootstrap_Server SHALL connect to bridge node on-demand
2. WHEN requesting random peer selection, THE Bootstrap_Server SHALL disconnect from bridge node immediately after receiving response
3. WHEN bridge node queries are made, THE Bootstrap_Server SHALL maintain no persistent connections to bridge nodes
4. WHEN multiple bridge nodes are available, THE Bootstrap_Server SHALL distribute queries across bridge nodes for load balancing
5. WHEN bridge node connections fail, THE Bootstrap_Server SHALL try alternative bridge nodes without maintaining connection state

### Requirement 12

**User Story:** As a DHT developer, I want fast failure with specific error codes, so that timeouts are avoided and proper error handling can be implemented.

#### Acceptance Criteria

1. WHEN a peer cannot fulfill a request, THE DHT_Node SHALL respond with specific error codes instead of timing out
2. WHEN rate limiting prevents a response, THE DHT_Node SHALL return "RATE_LIMITED" error code with retry-after time
3. WHEN a peer has already answered a duplicate request, THE DHT_Node SHALL return "ALREADY_PROCESSED" error code immediately
4. WHEN connection establishment fails, THE Connection_Manager SHALL return specific failure codes (TIMEOUT, REFUSED, UNREACHABLE)
5. WHEN DHT queries use differentiated timeouts, THE DHT_Node SHALL use 10s for connected peers and 3s for disconnected peers

### Requirement 13

**User Story:** As a DHT network operator, I want automatic data republishing with optimized network probes, so that stored data remains available despite node churn while minimizing network traffic.

#### Acceptance Criteria

1. WHEN data is stored in the DHT, THE DHT_Node SHALL schedule automatic republishing using randomized timing with spread window to prevent simultaneous republishing by multiple nodes
2. WHEN republishing is needed, THE DHT_Node SHALL use delegated replication by finding the closest node and delegating k-node distribution to minimize network probes
3. WHEN delegated replication is performed, THE DHT_Node SHALL use lightweight verification with hash comparison before transferring full data to reduce bandwidth
4. WHEN a node receives republishing requests, THE DHT_Node SHALL update lastRefreshedAt timestamps to coordinate future republishing attempts
5. WHEN data expires without republishing after TTL grace period, THE DHT_Node SHALL remove expired data from local storage

### Requirement 14

**User Story:** As a Pub/Sub user, I want automatic garbage collection of expired messages, so that DHT storage doesn't accumulate stale data indefinitely.

#### Acceptance Criteria

1. WHEN Pub/Sub messages expire, THE DHT_Node SHALL automatically remove expired messages from collections
2. WHEN message collections become empty, THE DHT_Node SHALL remove the empty collection from DHT storage
3. WHEN subscriber collections have all expired subscribers, THE DHT_Node SHALL remove the empty subscriber collection
4. WHEN coordinators have no active subscribers AND no unexpired messages, THE DHT_Node SHALL mark the topic as inactive and schedule cleanup
5. WHEN garbage collection runs, THE DHT_Node SHALL update coordinator snapshots to reflect cleaned state

### Requirement 15

**User Story:** As a security-conscious user, I want end-to-end encryption of DHT data, so that stored information remains private even if transport is compromised.

#### Acceptance Criteria

1. WHEN storing data in DHT, THE DHT_Node SHALL automatically encrypt data using AES-256-GCM before transmission
2. WHEN retrieving data from DHT, THE DHT_Node SHALL automatically decrypt data after retrieval and verify signatures
3. WHEN encryption keys are needed, THE DHT_Node SHALL derive encryption keys from existing ECDSA identity keys
4. WHEN encrypted data is tampered with, THE DHT_Node SHALL detect tampering through signature verification and reject invalid data
5. WHEN backward compatibility is needed, THE DHT_Node SHALL support both encrypted and plaintext data during migration period

### Requirement 16

**User Story:** As a developer, I want a reliable Pub/Sub system with message persistence, so that I can build real-time applications with offline tolerance and historical message delivery.

#### Acceptance Criteria

1. WHEN publishing a message to a topic, THE Pub_Sub_System SHALL store the message persistently in the DHT with configurable TTL
2. WHEN subscribing to a topic, THE Pub_Sub_System SHALL deliver all non-expired historical messages to new subscribers
3. WHEN multiple publishers publish concurrently, THE Pub_Sub_System SHALL handle optimistic concurrency conflicts through automatic merge operations
4. WHEN a subscriber is offline, THE Pub_Sub_System SHALL retain messages until TTL expiry for later delivery
5. WHEN message collections grow large, THE Pub_Sub_System SHALL use copy-on-write semantics to prevent race conditions

### Requirement 17

**User Story:** As a Pub/Sub coordinator, I want efficient message delivery with push notifications, so that subscribers receive messages with minimal latency.

#### Acceptance Criteria

1. WHEN a message is published to a topic with active subscribers, THE Pub_Sub_System SHALL attempt push delivery to subscribers immediately
2. WHEN push delivery fails or subscribers are offline, THE Pub_Sub_System SHALL fall back to polling-based delivery
3. WHEN multiple coordinator nodes exist for a topic, THE Pub_Sub_System SHALL use deterministic assignment to distribute push delivery load
4. WHEN subscribers are inactive browser tabs, THE Pub_Sub_System SHALL exclude them from push delivery coordination
5. WHEN push delivery succeeds, THE Pub_Sub_System SHALL deliver messages in under 100ms latency

### Requirement 18

**User Story:** As a Pub/Sub system operator, I want automatic garbage collection of expired data, so that DHT storage doesn't accumulate stale messages and subscriptions indefinitely.

#### Acceptance Criteria

1. WHEN messages expire based on TTL, THE Pub_Sub_System SHALL automatically remove expired messages from message collections
2. WHEN subscriptions expire, THE Pub_Sub_System SHALL remove expired subscribers from subscriber collections
3. WHEN message collections become empty after cleanup, THE Pub_Sub_System SHALL remove the empty collection from DHT storage
4. WHEN all subscribers and messages for a topic have expired, THE Pub_Sub_System SHALL remove the coordinator object
5. WHEN garbage collection runs, THE Pub_Sub_System SHALL perform cleanup lazily during normal operations without dedicated cleanup processes

### Requirement 19

**User Story:** As a Pub/Sub client, I want cryptographically signed messages and subscription renewal, so that the system is secure against unauthorized publishing and subscription hijacking.

#### Acceptance Criteria

1. WHEN publishing a message, THE Pub_Sub_System SHALL require Ed25519 cryptographic signatures using the publisher's private key
2. WHEN subscribing to a topic, THE Pub_Sub_System SHALL authenticate subscription requests using node identity verification
3. WHEN renewing subscriptions, THE Pub_Sub_System SHALL require signature-based authentication with timestamp replay protection
4. WHEN verifying message signatures, THE Pub_Sub_System SHALL reject messages with invalid or missing signatures
5. WHEN subscription TTL expires, THE Pub_Sub_System SHALL require cryptographic renewal to prevent unauthorized access