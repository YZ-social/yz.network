# Requirements Document

## Introduction

This specification defines enhancements to the existing Kademlia DHT implementation to improve routing efficiency, network resilience, and convergence speed. The enhancements address gaps identified in a design analysis comparing the current implementation against recommended Kademlia best practices.

The current implementation already includes message deduplication, partial source routing, RTT tracking infrastructure, bucket refresh, liveness checks, and XOR distance enforcement. This specification focuses on the missing features that will strengthen the DHT's robustness and performance.

## Glossary

- **KBucket**: A data structure that stores up to k nodes sharing a common prefix distance from the local node
- **Replacement_Cache**: A secondary storage for overflow nodes when a k-bucket is full, used to promote nodes when bucket members fail
- **XOR_Distance**: The metric used in Kademlia to measure logical distance between node IDs (bitwise XOR)
- **RTT**: Round-Trip Time - the latency measurement between two nodes
- **Proximity_Routing**: Selecting next-hop peers using RTT as a secondary criterion among XOR-valid candidates
- **Proximity_Neighbor_Selection**: Ranking k-bucket entries by RTT within XOR-equivalent candidates
- **Iterative_Routing**: The querying node controls each hop, waiting for responses before proceeding
- **Recursive_Routing**: Each intermediate node forwards the query to the next hop autonomously
- **Self_Lookup**: A findNode query for the local node's own ID, used to populate nearby buckets on join
- **Liveness**: Whether a node is responsive and reachable via ping or recent communication
- **RoutingTable**: The collection of k-buckets that stores known peers organized by XOR distance
- **KademliaDHT**: The main DHT implementation class that coordinates routing, storage, and network operations

## Requirements

### Requirement 1: Replacement Caches for K-Buckets

**User Story:** As a DHT node operator, I want k-buckets to maintain replacement caches, so that when a bucket member fails liveness checks, a known-good replacement can be promoted without losing network knowledge.

#### Acceptance Criteria

1. WHEN a node is added to a full KBucket, THE KBucket SHALL store the node in a replacement cache instead of discarding it
2. THE KBucket SHALL limit the replacement cache size to k entries per bucket
3. WHEN a node in the KBucket fails a liveness check, THE KBucket SHALL promote the most recently seen node from the replacement cache
4. WHEN a node is promoted from the replacement cache, THE KBucket SHALL remove it from the replacement cache
5. WHEN a node already in the replacement cache is seen again, THE KBucket SHALL move it to the end of the replacement cache (most recently seen)
6. THE KBucket SHALL preserve prefix diversity by never merging replacement caches across buckets

### Requirement 2: Self-Lookup on Node Join

**User Story:** As a new DHT node, I want to perform a self-lookup during startup, so that I can populate my routing table with nearby nodes and expose myself to the network for faster convergence.

#### Acceptance Criteria

1. WHEN the KademliaDHT starts and connects to bootstrap peers, THE KademliaDHT SHALL perform a findNode lookup for its own local node ID
2. THE KademliaDHT SHALL execute the self-lookup after establishing at least one bootstrap connection
3. WHEN the self-lookup completes, THE KademliaDHT SHALL add all discovered nodes to the routing table
4. THE KademliaDHT SHALL emit a 'selfLookupComplete' event after the self-lookup finishes
5. IF the self-lookup fails due to network errors, THEN THE KademliaDHT SHALL retry up to 3 times with exponential backoff

### Requirement 3: Proximity Routing

**User Story:** As a DHT node, I want to select next-hop peers using RTT as a secondary criterion, so that queries complete faster without violating XOR distance requirements.

#### Acceptance Criteria

1. WHEN selecting the next hop for a DHT query, THE KademliaDHT SHALL first filter candidates to those that reduce XOR distance to the target
2. WHEN multiple XOR-valid candidates exist, THE KademliaDHT SHALL prefer the candidate with the lowest RTT
3. THE KademliaDHT SHALL use existing RTT data from DHTNode.rtt without generating additional probe traffic
4. IF no RTT data is available for a candidate, THEN THE KademliaDHT SHALL treat it as having average RTT among known peers
5. THE KademliaDHT SHALL never select a candidate that does not reduce XOR distance, regardless of RTT

### Requirement 4: Recursive Routing Mode

**User Story:** As a DHT operator, I want recursive routing as the primary query mode, so that node discovery is accelerated and intermediate nodes can learn about peers.

#### Acceptance Criteria

1. THE KademliaDHT SHALL support a recursive routing mode where intermediate nodes forward queries autonomously
2. WHEN recursive routing is enabled, THE KademliaDHT SHALL forward received findNode requests to closer peers
3. WHEN forwarding a recursive query, THE KademliaDHT SHALL verify that each hop strictly reduces XOR distance to the target
4. THE KademliaDHT SHALL include a hop counter in recursive queries to prevent infinite forwarding
5. THE KademliaDHT SHALL limit recursive queries to a maximum of 20 hops
6. WHEN a recursive query reaches a node that cannot find closer peers, THE KademliaDHT SHALL return the closest known nodes to the originator
7. THE KademliaDHT SHALL support a configuration option to choose between iterative and recursive routing modes
8. THE KademliaDHT SHALL default to recursive routing mode for new installations

### Requirement 5: Proximity Neighbor Selection (Optional)

**User Story:** As a DHT operator in a latency-sensitive environment, I want to optionally rank k-bucket entries by RTT, so that frequently-used peers have lower latency.

#### Acceptance Criteria

1. WHERE Proximity Neighbor Selection is enabled, THE RoutingTable SHALL rank entries within each k-bucket by RTT
2. WHERE Proximity Neighbor Selection is enabled, THE RoutingTable SHALL perform limited RTT probes to compare XOR-equivalent candidates
3. THE RoutingTable SHALL never reshape or merge buckets based on proximity metrics
4. THE RoutingTable SHALL never replace a node with a higher-RTT node that has worse XOR distance
5. THE KademliaDHT SHALL disable Proximity Neighbor Selection by default
6. THE KademliaDHT SHALL provide a configuration option to enable Proximity Neighbor Selection

### Requirement 6: Liveness Over Proximity Enforcement

**User Story:** As a DHT node, I want liveness to always take priority over proximity metrics, so that the routing table maintains reliable connections over fast but unreliable ones.

#### Acceptance Criteria

1. WHEN deciding whether to evict a node from a k-bucket, THE RoutingTable SHALL prioritize liveness over RTT
2. THE RoutingTable SHALL never replace a live node with a node that has better RTT but unknown liveness
3. THE RoutingTable SHALL never replace a node that has responded within the last ping interval, regardless of RTT comparison
4. WHEN a node fails liveness checks, THE RoutingTable SHALL first attempt to promote from the replacement cache before accepting new nodes
5. THE RoutingTable SHALL never collapse or merge buckets based on proximity metrics
