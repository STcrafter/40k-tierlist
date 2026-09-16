# ⚔️ 40k Tier List

> Auto-generated tier list for Warhammer 40,000 units based on mathematical analysis and Monte Carlo simulations.

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![Edition](https://img.shields.io/badge/edition-10th-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Units](https://img.shields.io/badge/units-500+-purple)

---

## 📋 About

This project automatically analyzes every unit in Warhammer 40,000 using mathematical models and Monte Carlo simulations to generate objective tier lists for each faction.

### How it works

1. **Data Import** — Unit stats are loaded from [Wahapedia](https://wahapedia.ru) CSV exports
2. **Simulation** — Each unit is simulated against meta targets (10,000+ iterations per matchup)
3. **Scoring** — Units are scored on Damage, Survivability, Objective Control, and Mobility
4. **Tiering** — Units are ranked into tiers (S/A/B/C/D) within their category
5. **Visualization** — Interactive tier list with filters and comparisons

### Key Metrics

| Metric | Description |
|--------|-------------|
| **DMG** | Average damage output vs meta targets, normalized per 100 points |
| **SUR** | Effective HP against meta threats, normalized per 100 points |
| **OBJ** | Objective Control potential (OC × models × mobility) |
| **MOB** | Movement speed and deployment flexibility |
| **EFF** | Overall efficiency score (points vs performance) |

### Unit Categories

Units are compared within their category, not across all units:

| Category | Description | Examples |
|----------|-------------|----------|
| 🟡 HORDE | Cheap, many models | Genestealers, Ork Boyz |
| ⚪ INFANTRY | Standard 5-10 model squads | Intercessors, Fire Warriors |
| 🟣 ELITE | Expensive, durable | Terminators, Wraithguard |
| 🔵 CAVALRY | Fast movers | Outriders, Jetbikes |
| 🟢 VEHICLE (L) | Light vehicles | Razorback, Piranha |
| 🔴 VEHICLE (H) | Heavy vehicles | Land Raider, Stormlord |
| 🟥 MONSTER | Large single-model units | Carnifex, Greater Daemon |
| 🩷 FLYER | Aircraft | Thunderhawk, Razorswing |
| 🟤 TRANSPORT | Dedicated transports | Rhino, Devilfish |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/40k-tierlist.git
cd 40k-tierlist

# Install dependencies
npm install

# Start development server
npm run dev

# Open http://localhost:5173