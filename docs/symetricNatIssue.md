# Symmetric NAT — Summary & DHT Architecture Guide

---

## Executive Summary: Mobile P2P Connectivity for yz.network

### The Vision

yz.network aims to harness the collective processing power of mobile phones as DHT nodes — particularly devices left running overnight while charging, with users earning compensation for their participation. Smartphones are powerful, numerous, always-connected, and widely distributed. However, mobile network infrastructure presents specific challenges that must be designed around from the start.

### The Core Problem

**Nearly 100% of mobile users cannot receive direct inbound internet connections.**

Every major US mobile carrier (AT&T, Verizon, T-Mobile) places mobile devices behind Carrier-Grade NAT (CGNAT) with symmetric port mapping — the most restrictive NAT type possible. This means:

- Mobile devices have no public IP address
- Inbound connections are impossible by default
- Standard WebRTC hole-punching fails for mobile↔mobile pairs (near 0% success rate, confirmed by libp2p's 6.25 million attempt Punchr dataset)
- T-Mobile runs IPv6-only and **also firewalls all inbound IPv6** — closing even that workaround
- IPv6, which solves NAT for desktop users, provides **no benefit for mobile users**

This is not a software bug. It is a fundamental infrastructure decision by carriers that will not change without industry-wide policy shifts. **Two mobile browsers cannot establish a direct P2P connection to each other over the internet, regardless of protocol or technique.**

### What Mobile Nodes Can and Cannot Do

| Capability | Mobile browser node |
|---|---|
| Participating in DHT routing table | ✓ Yes |
| Storing and serving DHT data | ✓ Yes |
| Processing DHT queries | ✓ Yes |
| Connecting outbound to desktop/server peers | ✓ Yes |
| Receiving direct inbound connections | ✗ No |
| Acting as a relay for other mobile peers | ✗ No — cannot accept inbound |
| Connecting directly to other mobile peers | ✗ No — always needs relay |

Mobile nodes can **consume** relay services but cannot **provide** them. Relay capability requires accepting inbound connections, which requires a public IP address.

### The Browser-Only Overnight Problem — A Critical Constraint

The overnight charging model assumes a **no-install, browser-only JavaScript implementation**. This creates a second hard barrier beyond NAT:

**Neither iOS nor Android will maintain a browser-based WebRTC connection when the screen turns off.** This is not a bug — it is intentional OS behavior to preserve battery life.

| Scenario | iOS browser | Android browser |
|---|---|---|
| Tab active, screen on | ✓ Works | ✓ Works |
| Tab backgrounded, screen on | ✗ Suspended within seconds | ⚠ Throttled within minutes |
| Screen turned off / phone locked | ✗ Dead | ✗ Dead |
| Overnight while charging | ✗ Connection drops | ✗ Connection drops |

A **PWA (Progressive Web App)** installed to the Android home screen gets marginally better treatment — background sync and push notifications via service worker — but still cannot maintain a persistent WebRTC connection. Service workers wake briefly for tasks then sleep again.

**Persistent overnight connections require a native installed app** with an Android foreground service. There is no JavaScript-only workaround for this.

**Impact on the vision:** The browser-only overnight charging model as originally conceived is not technically achievable on current mobile platforms. The network should be redesigned around this constraint:
- Browser nodes contribute during **active screen-on use** only
- Overnight/persistent nodes require either a native Android app install or desktop/VPS volunteers
- The compensation model should reflect active session time rather than overnight uptime for browser nodes

This is a significant architectural finding that should inform the product roadmap before development investment is made.

### The Volunteer Relay Solution

Since mobile↔mobile pairs always need relay, the network requires a relay tier. This can be built from volunteers rather than paid infrastructure — but only volunteers with public IP addresses (desktop computers, VPS nodes).

**Who can volunteer as a relay node:**

| Volunteer type | Can relay? | Notes |
|---|---|---|
| VPS / cloud server | ✓ Best | Always on, public IP, high bandwidth |
| Home desktop on AT&T Fiber / Verizon FiOS | ✓ Yes | Public IPv4, P2P-friendly |
| Home desktop on Comcast/Xfinity | ✓ Partial | Public IPv4 in most markets |
| Home on Starlink / T-Mobile Home Internet | ✗ No | CGNAT — no public IP |
| Mobile phone (any carrier) | ✗ No | CGNAT — cannot accept inbound |

**Relay economics are favorable:** A single $150/month VPS can handle relay for millions of users if relay is fallback-only and DHT traffic consists of small messages. A volunteer desktop with a 100 Mbps home connection can relay for hundreds of simultaneous mobile peers. A ratio of roughly **1 relay node per 500 mobile nodes** is a reasonable initial target.

### Incentive Structure

Since mobile nodes cannot provide relay, compensation should reflect actual contribution:

| Node type | Contribution | Compensation basis |
|---|---|---|
| Mobile (browser, overnight) | DHT storage, query processing, availability | Storage × uptime |
| Desktop volunteer (relay-capable) | Above + relay bandwidth | Storage × uptime + relay bandwidth |
| VPS relay node | Dedicated relay, high availability | Relay bandwidth + uptime SLA |

This naturally incentivizes users with public IPs to run desktop or VPS nodes for higher compensation, while mobile users still earn for storage and availability.

### Projected Connection Profile (Mobile-Heavy Network)

| Connection scenario | Expected % of pairs | Direct possible? |
|---|---|---|
| Mobile ↔ Mobile | ~60-70% | No — always relay |
| Mobile ↔ Desktop (open NAT) | ~15-20% | Yes — mobile initiates outbound |
| Desktop ↔ Desktop | ~5-10% | Yes — direct WebRTC |
| Any ↔ Relay node | Remainder | N/A — relay is the path |

**Design baseline: 70-80% of connections will require relay in a mobile-heavy network.** This is not an edge case — it is the primary traffic pattern.

### Recommended Roadmap

**Phase 1 — Launch:** yz.social as initial relay + signaling server. All mobile↔mobile traffic routes through it. Detect and report connection profile (NAT type, IPv6) on join.

**Phase 2 — Distributed Relay:** Volunteer relay node software (desktop app or Docker). Relay nodes registered in DHT. Mobile peers select nearest relay. Blind relay — nodes forward by opaque peer ID, cannot identify users or read content.

**Phase 3 — Mobile Optimization:** Android PWA or native app with foreground service for reliable overnight operation. Battery-aware graceful degradation.

**Phase 4 — Scale:** Geographic relay distribution in DHT, load balancing, published network health metrics (% direct, % relayed, relay node count, relay volunteer count).

### Bottom Line

The original vision of browser-only overnight mobile nodes faces **two compounding hard barriers**:

1. **CGNAT** — mobile phones cannot receive inbound connections, so cannot act as relay nodes
2. **OS background suspension** — browsers on both iOS and Android are killed when the screen turns off, so persistent overnight connections require a native installed app

These are not engineering problems to be solved — they are platform constraints imposed by carriers and OS vendors.

**The revised realistic model:**
- Browser nodes contribute during **active daytime use** — DHT participation, storage, query processing while the user is actively engaged
- **Overnight persistent nodes require a native Android app** (foreground service) or desktop/VPS volunteers
- Compensation for browser-only mobile users should be based on **active session time and data served**, not overnight uptime
- The overnight charging vision is achievable but requires asking Android users to install a lightweight native app

Mobile phones remain valuable DHT participants. The limitation is connectivity and persistence, not compute. The path forward is a hybrid model: browser for onboarding and daytime use, optional native app install for users who want to earn overnight compensation.

---

## What is Symmetric NAT?

NAT (Network Address Translation) allows multiple devices to share a single public IP address. Most home routers use NAT. The difference between NAT types lies in how the router maps outbound connections to external ports.

**Symmetric NAT** assigns a unique external port for every unique destination. If your browser connects to server A it gets port 54481, server B gets port 54482, peer C gets port 54483 — each destination sees a different port. This makes it impossible for two peers behind symmetric NAT to predict each other's ports and punch through.

```
Browser A (symmetric NAT)
  → server1:  external port 54481
  → server2:  external port 54482
  → peer B:   external port 54483  ← peer B can't know this in advance

Browser B (symmetric NAT)
  → server1:  external port 61200
  → server2:  external port 61201
  → peer A:   external port 61202  ← peer A can't know this in advance
```

By contrast, **cone NAT** (full/restricted/port-restricted) uses the same external port regardless of destination, making hole-punching reliable.

The Tailscale engineering team uses cleaner terminology for these two categories:
- **Endpoint-Independent Mapping (Easy NAT)** — same external port for all destinations (cone NAT)
- **Endpoint-Dependent Mapping (Hard NAT)** — different external port per destination (symmetric NAT)

---

## Who is Behind Symmetric NAT?

| User Type | Symmetric NAT? | Notes |
|---|---|---|
| Mobile / cellular (4G/5G) | ~100% | All major US carriers use CGNAT with symmetric mapping |
| T-Mobile specifically | ~100% | IPv6-only network with 464XLAT; no public IPv4 at all; **filters all inbound IPv6** |
| AT&T mobile | ~100% | CGNAT symmetric |
| Verizon mobile | ~100% | CGNAT symmetric |
| Xfinity/Comcast residential | Partial | Public IPv4 in most markets; 1.2 TB/mo data cap; no port 25 |
| AT&T Fiber / Verizon FiOS | Low | Public dynamic IPv4, minimal port blocking — P2P friendly |
| Starlink / T-Mobile Home Internet | ~100% | Mandatory CGNAT, no public IP option |
| Corporate / university | Usually | Firewalls often more restrictive than symmetric NAT |
| Small ISP / direct | Low | More likely to have full-cone |
| VPS / cloud server | 0% | Direct public IP, no NAT |

### Real-World Hole-Punch Success Rates

From libp2p's **Punchr campaign (2022–2023)** across 6.25 million hole-punch attempts:

| Network scenario | NAT types | Hole-punch success |
|---|---|---|
| Home broadband ↔ Home broadband (no CGNAT) | Cone ↔ Cone | ~82–95% (UDP) |
| Home broadband ↔ Mobile carrier | Cone ↔ Symmetric | ~50–70% |
| Mobile carrier ↔ Mobile carrier | Symmetric ↔ Symmetric | **Near 0%** |
| Starlink ↔ Anything | CGNAT Symmetric | Near 0% inbound |
| Any ↔ Public server | Any ↔ None | ~100% |

Overall raw global success was ~40%, heavily skewed toward home networks. Mobile-to-mobile is effectively zero without relay.

### Estimated Percentage Requiring Relay

Based on available WebRTC and libp2p deployment data:

- ~22-30% of WebRTC sessions require TURN relay
- ~60% of residential NAT devices deploy symmetric NAT (though not all pairs will be symmetric↔symmetric)
- All US mobile carriers deploy CGNAT with symmetric mapping
- **IPv6 does not help mobile users** — US carriers firewall all inbound IPv6 connections even when IPv6 is assigned

**Realistic estimate for a browser-based DHT:**

| Connection pair | Approximate % of pairs | Needs relay? |
|---|---|---|
| Both have IPv6 (non-mobile) | ~20-25% | No — direct IPv6 |
| One or both mobile | ~25-35% | Yes — always |
| Symmetric ↔ open NAT (desktop) | ~20-25% | No — can hole-punch |
| Symmetric ↔ symmetric (IPv4 only, desktop) | ~15-20% | Yes |
| Open ↔ open | ~10-15% | No — direct |

**Bottom line: roughly 40-55% of browser peer pairs will need relay**, weighted significantly higher if your user base includes mobile users. On a purely desktop user base, direct connections of ~60-80% are achievable on mixed networks.

---

## Why Standard Solutions Fall Short

### TURN Servers
The RFC-specified solution. Works reliably but:
- Relays **all traffic** for the lifetime of the connection, never steps aside
- Central infrastructure — expensive at scale
- Creates centralization in a DHT, which defeats the purpose
- At thousands of DHT users with hundreds of connections each, a central TURN server becomes a bottleneck and single point of failure

### Port Prediction / Birthday Attack
Symmetric NATs often allocate ports sequentially (testing on this network showed +1 increments: 54481→54482→54483→54484). Both peers can try to predict each other's next port and connect simultaneously.
- Works ~30-40% of the time under ideal conditions
- Fails under concurrent traffic (increments become unpredictable)
- Not reliable enough to ship to users as a primary strategy
- Could be used as a first-attempt optimization before falling back to relay

A more effective variant is the **Birthday Paradox attack** (described in the Tailscale NAT traversal article):
- Instead of guessing one port, one peer opens ~256 local ports simultaneously
- The other peer probes ~2,048 ports randomly at 100 packets/second
- Probability math (birthday paradox) means a hit is found within ~20 seconds with 99.9% success rate
- **However:** when *both* peers are behind hard NAT the search space squares — requiring ~170,000 probes (~28 minutes) for the same success rate, making it impractical for real-time DHT connections

### IPv6
If both peers have global IPv6 addresses, symmetric NAT is irrelevant — IPv6 is end-to-end with no NAT at all.
- ~45% of US users already have working IPv6 (Google stats)
- Xfinity users are behind symmetric IPv4 NAT **but** typically have IPv6 — two Xfinity users can connect directly over IPv6
- Requires no user action — browsers already use it automatically
- Free wins — implement this first, reduces relay burden significantly

**Critical mobile caveat — IPv6 does NOT solve mobile P2P:** US mobile carriers (especially T-Mobile, which runs an IPv6-only network with 464XLAT) assign IPv6 addresses to devices but **firewall all inbound IPv6 connections**. This means two mobile peers both have globally-routable IPv6 addresses but still cannot reach each other directly. IPv6 only helps for non-mobile users or connections to servers. Do not count IPv6 as a solution for mobile-to-mobile DHT connections.

**NAT64 / 464XLAT:** T-Mobile in particular runs IPv6-only with a CLAT (Customer-side translator) on the device that transparently translates IPv4 app traffic to IPv6. The device appears dual-stack to apps but is actually IPv6-only to the network. Detection requires DNS queries to `ipv4only.arpa`. WebRTC's ICE handles this partially but mobile peers still cannot receive inbound connections regardless of protocol.

### UPnP / NAT-PMP / PCP (Port Mapping Protocols)
These protocols allow an application to ask the router directly to open a port mapping:
- **UPnP IGD**, **NAT-PMP**, and **PCP** are the three main variants
- If supported and enabled, they give the peer a pinhole equivalent to manual port forwarding
- Effectively converts a symmetric NAT peer into an open NAT peer for that session
- Increasingly disabled on modern routers due to historical security concerns, but worth attempting as a first step
- Not accessible from browser JavaScript — only useful for native DHT node implementations

### Mobile Platform Restrictions (Beyond NAT)

Even if NAT were solved, mobile platforms impose additional hard barriers:

**iOS:**
- Suspends backgrounded apps within seconds
- No persistent background network connections allowed
- Background push limited to ~2-3 per hour via Apple Push Notification Service (APNs)
- Every "decentralized" iOS app must use APNs for timely delivery — requiring Apple-authorized server infrastructure
- This is why Briar (true P2P messenger) explicitly has no iOS app and never will

**Android:**
- Doze mode (since Android 6.0) suspends network access for backgrounded apps
- OEM battery killers (Samsung, Xiaomi, Oppo) add further restrictions
- Workaround: foreground service (persistent notification) — used by SimpleX and Briar
- More viable than iOS but still requires user to disable battery optimization

**Implication for browser-based DHT:** A browser tab is subject to the same background restrictions. Mobile browsers will throttle or suspend WebRTC connections when the tab is backgrounded. DHT nodes on mobile should be treated as **intermittent peers**, not reliable routing nodes.

### Browser-Only Overnight Operation — Why It Cannot Work

This is a critical finding for any architecture that intends a **no-install, JavaScript-only** implementation with overnight mobile nodes.

**What happens to a browser tab overnight:**

| Scenario | iOS Safari | Android Chrome |
|---|---|---|
| Tab active, screen on | ✓ Full WebRTC | ✓ Full WebRTC |
| Different tab selected | ✗ Suspended in seconds | ⚠ Throttled in minutes |
| App minimized | ✗ Suspended in seconds | ⚠ Throttled in minutes |
| Screen off / locked | ✗ Dead immediately | ✗ Dead within minutes |
| Overnight while charging | ✗ No connection | ✗ No connection |

There is no JavaScript API, Web standard, or browser flag that overrides this behavior. It is enforced at the OS level.

**What about PWAs?**

A Progressive Web App installed to the Android home screen gains access to two additional APIs:
- **Background Sync API** — wakes the service worker briefly to sync pending data, then sleeps again. Not a persistent connection.
- **Web Push / Service Worker** — wakes briefly on push notification, executes a short task, then sleeps. Not a persistent connection.

Neither enables an always-on WebRTC data channel. A PWA is better than a plain browser tab for periodic tasks but cannot sustain DHT participation overnight.

**What actually works for overnight operation:**

| Approach | Overnight connection | Install required |
|---|---|---|
| Browser tab (iOS or Android) | ✗ No | No |
| PWA — Android | ⚠ Periodic tasks only | Soft (add to home screen) |
| PWA — iOS | ✗ No (more restricted than Android) | Soft |
| Native Android app + foreground service | ✓ Yes — persistent | Yes — app store or sideload |
| Native iOS app + background modes | ⚠ Very limited | Yes — App Store only |
| Desktop browser tab (screen on) | ✓ Yes if screen stays on | No |
| Desktop native app / server process | ✓ Yes | Yes |

**The architectural implication:**

The overnight charging model requires asking users to install a native Android app. This is a product decision with real consequences — install friction reduces participation, but it is the only path to reliable overnight node operation on mobile. A pragmatic hybrid approach:

1. **Browser tab** — onboarding, daytime active use, earns compensation for active session time
2. **"Install for more" prompt** — users who want overnight earnings are shown an Android app install prompt
3. **Desktop volunteers** — users who leave a browser tab open on a desktop (screen stays on) can participate overnight without install
4. **VPS/server volunteers** — highest tier, always-on, highest compensation

### Protocol Alternatives
There is no browser-accessible protocol that solves symmetric NAT better than WebRTC. The browser sandbox restricts you to HTTP/WebSockets/WebRTC/WebTransport — all face the same NAT wall. WebRTC with ICE is already the best tool available. The symmetric NAT problem is a **network topology problem**, not a protocol problem.

### VPN-like Solutions
Mesh VPN tools (Tailscale, Netbird, ZeroTier) use aggressive NAT traversal including port prediction and distributed relay fallback. They work well but require a **native client install**, making them unsuitable for a browser-based DHT targeting average users.

**Tailscale's DERP (Detoured Encrypted Routing Protocol)** is worth studying as an architectural model:
- DERP servers are geographically distributed — not a single bottleneck
- They operate over HTTP/HTTPS so they work even through restrictive firewalls
- Relay encrypted payloads by destination public key — the relay never sees plaintext
- Used only as fallback — Tailscale reports ~90% of connections succeed via direct path, only ~10% need DERP relay
- Once a direct path is found, traffic migrates off the relay automatically

This 90% direct / 10% relay split is the benchmark to aim for. It's achievable because Tailscale combines IPv6, UPnP/NAT-PMP, ICE-style simultaneous probing, and birthday attack port scanning before falling back to relay.

### QUIC / WebTransport
QUIC is a UDP-based transport protocol (what HTTP/3 runs on). It does **not** solve symmetric NAT traversal — the NAT is blind to what protocol is inside the UDP packet and behaves identically regardless. However QUIC is relevant in two ways:

**Where QUIC does not help:**
- Symmetric NAT traversal — same wall, different protocol

**Where QUIC does help:**

| Feature | Benefit for DHT |
|---|---|
| Multiplexed streams | Multiple peer relationships over one connection to a relay node |
| Faster handshake | Lower latency connecting to relay nodes |
| Connection migration | Survives mobile network switches mid-session |
| No head-of-line blocking | Lost packet doesn't stall other DHT streams |

**WebTransport** (the browser API built on QUIC/HTTP3, available in Chrome/Edge now) is the most relevant piece — it's a better transport than WebSockets for the relay path:

```
Browser A ──WebTransport/QUIC──► relay node ──WebTransport/QUIC──► Browser B
```

The recommended combination:
- **WebRTC ICE** for direct peer connections (handles open NAT and symmetric→open)
- **WebTransport/QUIC** for the relay path (symmetric↔symmetric routing through public nodes)

This gives WebRTC's NAT traversal where it works, and QUIC's efficiency for the relay fallback.

---

## Recommended Architecture for Browser DHT

### Topology

```
                    ┌─────────────────────┐
                    │   Signaling Server  │
                    │     (yz.social)     │
                    └──────────┬──────────┘
                               │ SDP / ICE exchange
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐         │      ┌─────────▼──────┐
    │  Public Node   │         │      │  Public Node   │
    │  (volunteer)   │         │      │  (volunteer)   │
    └─────┬──────────┘         │      └──────────┬─────┘
          │ relay              │           relay │
          │                    │                 │
    ┌─────▼──────┐    ┌────────▼───────┐   ┌────▼───────┐
    │ Browser A  │    │   Browser C    │   │ Browser B  │
    │ (sym NAT)  │◄──►│  (open NAT)   │◄──►│ (sym NAT) │
    └────────────┘    │   direct P2P  │   └────────────┘
                      └────────────────┘
```

- Browser A and B (both symmetric NAT, IPv4 only) route through a nearby public node
- Browser C (open NAT) connects directly to everyone
- Public nodes are **volunteer DHT nodes with public IPs** — relay load is distributed across the network
- Signaling server only brokers ICE/SDP metadata, never touches data

### Connection Decision Flow

This mirrors Tailscale's approach — try everything simultaneously, pick the best path that works (ICE philosophy: "try everything at once and pick the best thing that works").

```
Peer A wants to connect to Peer B
          │
          ▼
  Run ICE — gather ALL candidates simultaneously:
    - IPv6 host candidates
    - IPv4 host candidates
    - STUN server-reflexive candidates (external mapped address)
    - Port mapping via UPnP/NAT-PMP (native nodes only)
          │
          ▼
  Probe all candidate pairs simultaneously
          │
          ├─► IPv6 direct path available? ──► use it (best)
          │
          ├─► Both have endpoint-independent (cone) NAT?
          │     → UDP hole-punch succeeds ──► use it
          │
          ├─► One has open/cone NAT, one has hard NAT?
          │     → Symmetric side initiates, open side receives ──► use it
          │
          ├─► Both hard NAT, sequential port allocation?
          │     → Birthday attack port scan (~20s, 99.9% if one-sided)
          │     → If both hard NAT: impractical (~28 min) ──► skip
          │
          └─► No direct path found
                → Route through nearest public DHT relay node
                → Continue probing in background
                → Upgrade to direct path if found later
```

### Implementation Layers

**Layer 1: IPv6 detection (zero cost)**
```javascript
// On connection, detect IPv6 via ICE candidates
// If peer has global IPv6 (2xxx: or 2600: etc.), prefer IPv6 path
```

**Layer 2: WebRTC ICE with STUN (standard hole-punch)**
```javascript
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:yz.social:3478' }]
});
// Handles open NAT and symmetric→open cases automatically
```

**Layer 3: Circuit relay through volunteer public nodes**
- Public nodes (servers, VPS, users with open NAT who opt in) register themselves as relay-capable
- Symmetric NAT peers query DHT for nearest relay-capable node
- Relay node forwards WebRTC data channel traffic between the two peers
- Relay is per-connection, not centralized — load distributes naturally
- Similar to libp2p's circuit relay v2 protocol and Tailscale's DERP architecture
- Relay payloads should be encrypted end-to-end — relay node should never see plaintext

**Layer 4: Continuous path upgrade (recommended)**
- Even after falling back to relay, keep probing for a direct path in the background
- If a direct path becomes available (e.g. NAT mapping stabilizes), migrate traffic off the relay
- Tailscale does this and achieves ~90% direct connections as a result

**CGNAT / Double-NAT note:**
Some users are behind two layers of NAT (ISP CGNAT + home router). In this case hairpinning (routing back through the NAT to reach a peer on the same CGNAT) often fails on residential equipment. These users are among the hardest cases and will almost always need relay.

---

## Detecting NAT Type and IPv6 in the Browser

Report to your server on connect so you can make intelligent routing decisions:

```javascript
async function getConnectionProfile() {
  const profile = {
    hasIPv6: false,
    ipv6Addresses: [],
    ipv4External: null,
    natType: 'unknown'
  };

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:yz.social:3478' }]
  });
  pc.createDataChannel('');
  await pc.setLocalDescription(await pc.createOffer());

  return new Promise((resolve) => {
    const candidates = [];

    setTimeout(() => {
      pc.close();
      analyzeNATType(candidates, profile);
      resolve(profile);
    }, 3000);

    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        pc.close();
        analyzeNATType(candidates, profile);
        resolve(profile);
        return;
      }

      const parts = e.candidate.candidate.split(' ');
      const ip = parts[4];
      const type = parts[7]; // 'host', 'srflx', 'relay'

      if (!ip) return;
      candidates.push({ ip, type, candidate: e.candidate.candidate });

      if (ip.includes(':') && !ip.startsWith('fe80')) {
        profile.hasIPv6 = true;
        profile.ipv6Addresses.push(ip);
      }
      if (type === 'srflx' && !ip.includes(':')) {
        profile.ipv4External = ip;
      }
    };
  });
}

function analyzeNATType(candidates, profile) {
  const srflxCandidates = candidates.filter(c => c.type === 'srflx');
  const hostCandidates = candidates.filter(c => c.type === 'host');

  if (srflxCandidates.length > 0) {
    // Has server-reflexive = NAT present
    // Full symmetric vs cone detection requires two STUN servers and comparing ports
    profile.natType = 'nat-present';
  } else if (hostCandidates.some(c =>
    !c.ip.startsWith('192.168') &&
    !c.ip.startsWith('10.') &&
    !c.ip.startsWith('172.') &&
    !c.ip.includes(':')
  )) {
    profile.natType = 'open'; // public IP as host candidate = no NAT
  }
}

// Usage
getConnectionProfile().then(profile => {
  console.log('Has IPv6:', profile.hasIPv6);
  console.log('IPv6 addresses:', profile.ipv6Addresses);
  console.log('External IPv4:', profile.ipv4External);
  console.log('NAT type:', profile.natType);

  // Send to your server
  fetch('/api/report-network', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile)
  });
});
```

---

## Practical Recommendations

| Priority | Action | Impact |
|---|---|---|
| 1 | Enable IPv6 on yz.social | Immediate free wins for ~45% of users |
| 2 | Detect IPv6 in browser on connect | Route IPv6-capable peers direct |
| 3 | Run STUN server on yz.social | Cheap, handles cone NAT hole-punch |
| 4 | Use ICE — probe all candidate pairs simultaneously | "Try everything, pick best" — handles most cases automatically |
| 5 | Implement volunteer relay nodes | Distributed relay for hard NAT↔hard NAT |
| 6 | Continue probing after relay fallback | Migrate to direct path if found — target 90% direct like Tailscale |
| 7 | Detect NAT64 on mobile | Handle IPv6-only mobile users correctly |
| 8 | Track relay usage metrics | Know your actual numbers vs estimates |

### Running Your Own STUN Server (coturn)

```bash
apt install coturn

# /etc/turnserver.conf
listening-port=3478
listening-ip=89.147.111.11
realm=yz.social
```

STUN is extremely lightweight — a single server handles tens of thousands of users. TURN (relay) is the expensive part, which is why distributing relay across volunteer nodes matters.

---

## "Almost P2P" — The Realistic Target

True serverless P2P over the internet on mobile is currently impossible. The combination of universal symmetric CGNAT on all US mobile carriers, inbound IPv6 filtering, and mobile OS background restrictions creates a barrier stack that no existing protocol solves completely. This isn't a gap waiting for a clever engineering solution — it reflects fundamental architectural decisions by carriers and platform vendors.

The productive framing is **"minimally-relayed P2P"**:
- Direct connections for ~60-80% of desktop peer pairs
- Relay fallback for mobile and hard NAT↔hard NAT pairs
- Keep relay infrastructure minimal, distributed, and economically viable

### Economics of Relay Infrastructure

A single $150/month cloud server can provide NAT traversal relay for millions of devices if:
- Relay is used only as fallback (not for all traffic)
- Direct connections are aggressively pursued first
- Relay traffic is DHT signaling and small messages, not bulk data streams

This makes self-hosted relay economically viable without depending on a TURN service.

### SimpleX as a Design Inspiration

SimpleX Chat solves a related problem in an instructive way:
- Uses relay servers but assigns **no user identifiers** — the relay cannot correlate which users are communicating
- Each conversation uses a different relay queue with a random ID
- Self-hostable relay servers
- Structurally prevents the relay from building a social graph even if compromised

For a DHT, the equivalent would be: relay nodes forward encrypted packets by opaque destination ID, never knowing which DHT peer is which user. The relay provides connectivity without surveillance capability.

## Key Takeaway

True serverless P2P on mobile is impossible today. The practical target is **minimally-relayed P2P** with direct connections wherever achievable.

For a browser DHT the realistic path is:

- **IPv6** eliminates the problem for ~25% of non-mobile pairs for free — **does not help mobile users** (carriers firewall inbound IPv6)
- **ICE simultaneous probing** ("try everything, pick best") handles most remaining desktop cases automatically
- **Standard ICE/STUN** handles symmetric→open pairs (~20-25%)
- **Mobile peers should be treated as relay-dependent by default** — mobile↔mobile direct connection is near zero
- **Distributed circuit relay** through volunteer public DHT nodes handles hard NAT↔hard NAT without central infrastructure
- **Relay nodes should be blind** — forward by opaque ID, never able to correlate users (SimpleX model)
- **Continuous background probing** after relay fallback — migrate to direct when possible, target ~80% direct on desktop
- **No central TURN server needed** — a $150/month server can handle relay for millions if relay is fallback-only and distributed

Tailscale's architecture is the best real-world reference for the traversal layer. SimpleX is the best reference for privacy-preserving relay design. libp2p circuit relay v2 is the closest reference for distributed relay implementation.

---

## References

- [Am I behind a Symmetric NAT? — webrtcHacks](https://webrtchacks.com/symmetric-nat/)
- [The Big Churn — real WebRTC usage stats — webrtcHacks](https://webrtchacks.com/usage-stats/)
- [WebRTC NAT Traversal Methods — LiveSwitch](https://www.liveswitch.io/blog/webrtc-nat-traversal-methods-a-case-for-embedded-turn/)
- [How NAT traversal works — Tailscale](https://tailscale.com/blog/how-nat-traversal-works)
- [Carrier-grade NAT — Wikipedia](https://en.wikipedia.org/wiki/Carrier-grade_NAT)
- [libp2p Circuit Relay v2](https://github.com/libp2p/specs/blob/master/relay/circuit-v2.md)
- [WebTransport — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)
- [QUIC RFC 9000](https://www.rfc-editor.org/rfc/rfc9000)
- [libp2p Punchr hole-punch measurement campaign](https://github.com/libp2p/punchr)
- [SimpleX Chat — privacy-preserving relay design](https://simplex.chat/blog/20220112-simplex-chat-v1-released.html)
- [P2P on US mobile networks — AI analysis](https://claude.ai/public/artifacts/11a279ee-47fa-4b04-86f0-05a3e138e2ea)
