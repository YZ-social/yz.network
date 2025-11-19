# Platform Comparison - Where to Host Your DHT

Quick reference for choosing the best hosting platform.

## TL;DR Recommendations

| Use Case | Platform | Cost | Nodes |
|----------|----------|------|-------|
| **Testing/Learning** | Oracle Free Tier | $0 | 40-60 |
| **Budget Production** | Hetzner CPX11 | $5/mo | 12-15 |
| **Privacy-Critical** | 1984.is Bifrost | $25/mo | 12-15 |
| **Stay in AWS** | Fargate Spot | $26/mo | 12-15 |

---

## Detailed Comparison

### Oracle Cloud Free Tier 🏆

**Cost: FREE forever**

**Specs:**
- 4× ARM VMs (1 OCPU, 6 GB each)
- 200 GB total storage
- 10 TB monthly transfer

**DHT Capacity: 40-60 nodes across 4 instances**

**Pros:**
- ✅ Completely free
- ✅ Very generous resources
- ✅ Multiple instances = geographic distribution
- ✅ Global datacenter options
- ✅ Stable for years

**Cons:**
- ❌ ARM architecture (need to rebuild images)
- ❌ Oracle's reputation
- ❌ Account suspension risk if abused
- ❌ Requires credit card

**Best for:**
- Testing and development
- Learning deployment
- Proof of concept
- Running alongside other paid options

**Setup Time:** 1-2 hours (multiple VMs)

**Files:** `deployments/oracle-cloud-setup.md`

---

### Hetzner Cloud 💰

**Cost: €4.51/month (~$5)**

**Specs (CPX11):**
- 2 vCPU
- 2 GB RAM
- 40 GB SSD
- 20 TB traffic

**DHT Capacity: 12-15 nodes**

**Pros:**
- ✅ Extremely cheap
- ✅ Excellent performance
- ✅ European privacy laws (GDPR)
- ✅ Simple pricing
- ✅ Great reputation
- ✅ Easy scaling (upgrade anytime)

**Cons:**
- ❌ EU only (Germany, Finland)
- ❌ Higher latency for US/Asia
- ❌ Requires credit card

**Best for:**
- Production on a budget
- European users
- Long-term hosting
- When you need reliability

**Setup Time:** 30 minutes

**Files:** `deployments/hetzner-cloud-setup.md`

---

### 1984.is (Iceland) 🔐

**Cost: ISK 3,499/month (~$25)**

**Specs (Bifrost):**
- 2 vCPU
- 2 GB RAM
- 50 GB SSD

**DHT Capacity: 12-15 nodes**

**Pros:**
- ✅ Strong privacy laws (Iceland)
- ✅ Freedom of speech protection
- ✅ Ethical company (cooperative)
- ✅ Accepts Bitcoin
- ✅ No logging policy
- ✅ Tor friendly

**Cons:**
- ❌ More expensive ($25 vs $5)
- ❌ Iceland location (latency)
- ❌ Smaller company
- ❌ Less datacenters

**Best for:**
- Privacy-critical applications
- Censorship resistance
- Ethical hosting choice
- When legal protection matters

**Setup Time:** 30 minutes

**Files:** `deployments/1984-iceland-setup.md`

---

### AWS Fargate Spot 🌐

**Cost: ~$26/month**

**Specs:**
- 0.25 vCPU × 12 containers
- 0.5 GB RAM × 12 containers
- Variable resources

**DHT Capacity: 12-15 nodes**

**Pros:**
- ✅ AWS ecosystem integration
- ✅ 70% cheaper than on-demand
- ✅ Auto-scaling
- ✅ No server management
- ✅ Pay per second
- ✅ Global availability

**Cons:**
- ❌ Can be interrupted (2-min warning)
- ❌ Still expensive vs alternatives
- ❌ More complex setup
- ❌ AWS lock-in

**Best for:**
- Already using AWS
- Need AWS integrations
- Want serverless benefits
- Global distribution

**Setup Time:** 1-2 hours (IAM, ECS setup)

---

## Cost Breakdown

### Monthly Costs for Different Scales

| Nodes | Oracle | Hetzner | 1984.is | AWS Spot |
|-------|--------|---------|---------|----------|
| 12-15 | $0 | $5 | $25 | $26 |
| 40-60 | $0 | $20 | $100 | $104 |
| 100 | $0* | $50 | $200 | $208 |

*Oracle free tier capped at ~60 nodes

### Annual Costs

| Platform | Monthly | Annual | Savings |
|----------|---------|--------|---------|
| Oracle | $0 | $0 | N/A |
| Hetzner | $5 | $60 | None |
| 1984.is | $25 | $250 | 16% (annual plan) |
| AWS Spot | $26 | $312 | None |

---

## Feature Comparison

| Feature | Oracle | Hetzner | 1984.is | AWS |
|---------|--------|---------|---------|-----|
| **Privacy** | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐ |
| **Performance** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **Reliability** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Cost** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| **Simplicity** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |
| **Support** | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

---

## Geographic Distribution

### Latency to Major Regions (avg ms)

| Platform | US East | US West | EU | Asia |
|----------|---------|---------|----|----- |
| Oracle (Multi) | 10-20 | 10-20 | 10-20 | 10-20 |
| Hetzner (DE) | 90-110 | 150-170 | 10-30 | 200-250 |
| 1984.is (IS) | 80-100 | 150-180 | 20-40 | 250-300 |
| AWS (Multi) | 10-20 | 10-20 | 10-20 | 10-20 |

---

## Hybrid Approach (Recommended!) 🎯

**Best of all worlds:**

### Configuration A: Free + Cheap
```
Oracle Free Tier:  40 nodes  ($0/mo)
Hetzner CPX11:     12 nodes  ($5/mo)
──────────────────────────────────────
Total:             52 nodes  ($5/mo)
```

**Benefits:**
- Nearly free
- Geographic distribution
- Redundancy
- Easy to scale

### Configuration B: Privacy + Performance
```
1984.is Bifrost:   12 nodes  ($25/mo)
Hetzner CPX11:     12 nodes  ($5/mo)
──────────────────────────────────────
Total:             24 nodes  ($30/mo)
```

**Benefits:**
- Privacy protection
- Good performance
- EU presence
- Reasonable cost

---

## Decision Tree

```
START: Where should I host?
│
├─ Need FREE? ──────────────────► Oracle Free Tier
│
├─ Need CHEAPEST paid? ─────────► Hetzner
│
├─ Need PRIVACY/ETHICS? ────────► 1984.is
│
├─ Already using AWS? ──────────► Fargate Spot
│
└─ Want BEST DEAL? ─────────────► Hybrid (Oracle + Hetzner)
```

---

## Quick Start Commands

### Oracle Cloud (4 instances, 60 nodes)
```bash
# Follow oracle-cloud-setup.md
```

### Hetzner (12 nodes)
```bash
hcloud server create --type cpx11 --name yz-dht --image ubuntu-22.04
ssh root@<ip>
git clone <repo> && cd yz.network
docker-compose up -d --scale dht-node=12
```

### 1984.is (12 nodes)
```bash
# Order Bifrost plan
ssh root@<server>
git clone <repo> && cd yz.network
docker-compose up -d --scale dht-node=12
```

---

## Support & Documentation

- **Oracle**: `deployments/oracle-cloud-setup.md`
- **Hetzner**: `deployments/hetzner-cloud-setup.md`
- **1984.is**: `deployments/1984-iceland-setup.md`
- **General**: `DOCKER-DEPLOYMENT.md`

---

## My Personal Recommendation

**For your situation:**

1. **Start with Oracle Free Tier** (4 instances, 40 nodes, FREE)
   - Test everything
   - Learn the system
   - Run for free indefinitely

2. **Add Hetzner if needed** ($5/mo, 12 more nodes)
   - EU presence
   - Paid backup
   - Easy to scale

3. **Consider 1984.is for sensitive data** ($25/mo, 12 nodes)
   - Only if privacy critical
   - Or for ethical reasons

**Total: 52-60 nodes for $0-5/month**

This beats AWS by a mile and gives you a robust, distributed DHT network!
