---
name: GhostShare
colors:
  surface: '#111318'
  surface-dim: '#111318'
  surface-bright: '#37393e'
  surface-container-lowest: '#0c0e12'
  surface-container-low: '#1a1c20'
  surface-container: '#1e2024'
  surface-container-high: '#282a2e'
  surface-container-highest: '#333539'
  on-surface: '#e2e2e8'
  on-surface-variant: '#c7c4d7'
  inverse-surface: '#e2e2e8'
  inverse-on-surface: '#2f3035'
  outline: '#908fa0'
  outline-variant: '#464554'
  surface-tint: '#c0c1ff'
  primary: '#c0c1ff'
  on-primary: '#1000a9'
  primary-container: '#8083ff'
  on-primary-container: '#0d0096'
  inverse-primary: '#494bd6'
  secondary: '#4cd7f6'
  on-secondary: '#003640'
  secondary-container: '#03b5d3'
  on-secondary-container: '#00424e'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#00885d'
  on-tertiary-container: '#000703'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e1e0ff'
  primary-fixed-dim: '#c0c1ff'
  on-primary-fixed: '#07006c'
  on-primary-fixed-variant: '#2f2ebe'
  secondary-fixed: '#acedff'
  secondary-fixed-dim: '#4cd7f6'
  on-secondary-fixed: '#001f26'
  on-secondary-fixed-variant: '#004e5c'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#111318'
  on-background: '#e2e2e8'
  surface-variant: '#333539'
typography:
  display-hero:
    fontFamily: Geist
    fontSize: 48px
    fontWeight: '600'
    lineHeight: 56px
    letterSpacing: -0.03em
  display-hero-mobile:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.025em
  headline-lg:
    fontFamily: Geist
    fontSize: 30px
    fontWeight: '500'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '500'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 28px
    letterSpacing: -0.015em
  body-lg:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: -0.005em
  body-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: '0'
  mono-pairing-code:
    fontFamily: JetBrains Mono
    fontSize: 32px
    fontWeight: '500'
    lineHeight: 40px
    letterSpacing: 0.15em
  mono-pairing-code-mobile:
    fontFamily: JetBrains Mono
    fontSize: 22px
    fontWeight: '500'
    lineHeight: 32px
    letterSpacing: 0.1em
  mono-data:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: -0.01em
  mono-telemetry:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.04em
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.08em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-mobile: 1rem
  margin: 2rem
  margin-mobile: 1rem
  space-2xs: 0.125rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-base: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
  space-2xl: 3rem
---

## Brand & Style

The brand personality is cryptographically secure, utilitarian, ethereal, and hyper-precise. It operates with the uncompromised clarity of an elite developer tool paired with the quiet assurance of zero-knowledge privacy infrastructure. Designed for security researchers, engineers, privacy advocates, and digital minimalists, the interface instills feelings of sovereign control, absolute transient finality, and frictionless utility.

The aesthetic direction synthesizes **Technical Minimalism** with **Linear-grade Precision Craft**:
- **Absolute Technical Honesty:** Zero decorative noise, zero gamification, zero manipulative friction. Every pixel directly communicates state, payload size, cryptographical integrity, or TTL (Time-To-Live) countdowns.
- **Atmospheric Obsidian Depth:** Deep, light-absorbent backdrops overlaid with hairline micro-borders (`rgba(255, 255, 255, 0.08)`) and controlled, ambient luminescent glows.
- **Instrument-grade Typography:** A disciplined split between clean, Swiss-engineered proportional sans for structured UI copy and monospaced typography for raw technical telemetry (hashes, byte streams, ephemeral tokens, expiry sequences).

## Colors

The system employs a strict dark-mode-first color architecture engineered around low-reflectance graphite surfaces accented by precise optical indicators:

- **Surface Layers:**
  - `canvas-default`: `#0A0C10` (Deepest void obsidian, full-bleed backdrop)
  - `surface-subtle`: `#12151D` (Structural panels, dropzones, code blocks)
  - `surface-elevated`: `#1A1F2C` (Interactive cards, popovers, floating status pills)
  - `surface-overlay`: `rgba(18, 21, 29, 0.75)` (Frosted blur backing)

- **Border & Stroke Architecture:**
  - `border-hairline`: `rgba(255, 255, 255, 0.08)` (Default structural containment)
  - `border-focus`: `rgba(99, 102, 241, 0.45)` (Interactive focus rings and selections)
  - `border-active`: `rgba(6, 182, 212, 0.40)` (Active stream and transfer indicators)

- **Accents & Telemetry:**
  - `primary` (`#6366F1` / Hover: `#818CF8`): Cryptographic actions, primary operations, verified keys.
  - `secondary` (`#06B6D4` / Light: `#22D3EE`): Network stream activity, R2 bucket sync status, pipe latency.
  - `tertiary` (`#10B981` / Muted: `rgba(16, 185, 129, 0.15)`): Confirmed deliveries, ephemeral self-destruction verification, zero-knowledge seals.
  - `danger` (`#F43F5E` / Muted: `rgba(244, 63, 94, 0.15)`): Immediate burn commands, aborted transfers, cryptographic verification failures.

- **Typography & Content Hierarchy:**
  - `text-primary`: `#F8FAFC` (100% white-slate legibility)
  - `text-secondary`: `#94A3B8` (System labels, metadata labels, structural copy)
  - `text-tertiary`: `#475569` (Inactive states, pipe connectors, decorative structural lines)

## Typography

The typographical pairing enforces semantic precision:
- **Primary Proportional Interface Font (Geist):** Provides neutral, cold clarity for all interface chrome, navigational titles, explanations, and action triggers. Its high x-height and tight tracking ensure legibility even at 12px against low-light backgrounds.
- **Telemetry & Identity Monospace Font (JetBrains Mono):** Deployed for all variable state data: 8-digit peer connection tokens, SHA-256 fingerprint chunks, real-time MB/s throughput trackers, and TTL clock expirations.
- **Uppercase Structural Labels (`label-caps`):** Used strictly for metadata headings (e.g., `PAYLOAD ENCRYPTION`, `R2 CHUNK STATUS`, `EDGE TTL`), forced to uppercase with wide character tracking to function as structural separators.

## Layout & Spacing

The layout model is governed by an 8pt architectural rhythm, calibrated for focused single-window desktop utilities and unified mobile viewport constraints:

- **Desktop (≥ 1024px):** Centered fixed-width viewport canvas constrained to a maximum utility width of `680px` for focused single-action workflows (file staging, token emission, transfer pipe monitor), expanding to a 12-column grid (`1120px` max width) for multi-peer telemetry dashboards. Columns maintain a `1.5rem` (`24px`) gutter and `2rem` outer margin.
- **Tablet (768px – 1023px):** Fluid single-column layout with fixed lateral page padding of `2rem`.
- **Mobile (≤ 767px):** Full-bleed responsive fluid container with tight edge margins of `1rem` (`margin-mobile`), ensuring technical monitors and code chunks maximize screen width without edge clipping.
- **Component Padding Standards:** Form elements, badges, and status modules utilize `space-sm` (`8px`) vertical and `space-base` (`16px`) horizontal padding to preserve condensed utility density.

## Elevation & Depth

Visual hierarchy is constructed through tonal layering, precise luminescence, and microscopic physical borders rather than heavy organic drop shadows:

- **Tier 0 (Root Canvas):** `#0A0C10` flat background with an optional 1px subtle dotted ambient grid (`rgba(255, 255, 255, 0.02)`) spaced at 24px intervals.
- **Tier 1 (Surface Containers):** `#12151D` enclosed in a razor-thin border of `1px solid rgba(255, 255, 255, 0.08)`. No directional shadow.
- **Tier 2 (Active Transfer Modals & Staging Nodes):** `#1A1F2C` elevated with a compound border-shadow system:
  - Inner border: `1px solid rgba(255, 255, 255, 0.12)`
  - Direct elevation shadow: `0 4px 20px -2px rgba(0, 0, 0, 0.65)`
  - Status aura: When a transfer is active, a secondary radial glow radiates underneath: `0 0 40px -10px rgba(6, 182, 212, 0.15)`.
- **Tier 3 (Floating HUDs & Ephemeral Prompts):** Translucent backdrop blur (`backdrop-filter: blur(16px); background: rgba(18, 21, 29, 0.85);`) framed with `1px solid rgba(255, 255, 255, 0.15)` and an ambient shadow `0 12px 32px -4px rgba(0, 0, 0, 0.8)`.

## Shapes

The design system embraces a **Soft / Refined Industrial Geometry** (`roundedness: 1`):
- **Base Components (Inputs, Buttons, Badges):** `4px` (`0.25rem`) corner radius. This gives elements a sharp, machined, instrument-like feel without brutalist harshness.
- **Card Containers & Staging Dropzones (`rounded-lg`):** `8px` (`0.5rem`) corner radius.
- **Overlay Shells & Centered Transfer Pods (`rounded-xl`):** `12px` (`0.75rem`) corner radius.
- **Status Indicators & Pairing Code Cells:** Exact 4px boundary constraints. Fully circular radius (`9999px`) is strictly reserved for live pulse dots (e.g., active WebSocket peer beacon).

## Components

### Buttons
- **Primary Action (Transmit / Encrypt):** Background `#6366F1`, text `#FFFFFF`, font `Geist` 14px weight 500, radius `4px`, padding `8px 16px`. Subtle inner top highlight `inset 0 1px 0 rgba(255, 255, 255, 0.2)`. On hover, background shifts to `#818CF8`.
- **Secondary / Ghost (Abort, Inspect Manifest):** Background `transparent`, border `1px solid rgba(255, 255, 255, 0.12)`, text `#94A3B8`. Hover converts border to `rgba(255, 255, 255, 0.25)` and text to `#F8FAFC`.
- **Destructive (Burn File Immediately):** Background `rgba(244, 63, 94, 0.08)`, border `1px solid rgba(244, 63, 94, 0.25)`, text `#F43F5E`. Hover: Background `rgba(244, 63, 94, 0.16)`.

### Pairing Code Display & Inputs
- **8-Digit Pairing Code Display:** An 8-cell segmented grid or hyphenated block using `JetBrains Mono` at `32px` (`mono-pairing-code`). Each character lives in an individual monospace cell (`#12151D`, border `1px solid rgba(255, 255, 255, 0.1)`). Includes a one-click click-to-copy trigger providing instant visual inline confirmation (`COPIED`).
- **Code Entry Input:** Direct monospaced input with auto-formatting, subtle cyan active caret pulse, and visual feedback per validated character.

### Input Fields
- Dark canvas `#12151D`, boundary `1px solid rgba(255, 255, 255, 0.08)`, height `40px`, padding `0 12px`, text color `#F8FAFC`, placeholder `#475569`.
- Focused state applies border `1px solid #6366F1` and a tight glow: `0 0 0 2px rgba(99, 102, 241, 0.2)`.

### Ephemeral Telemetry Cards
- Containers built on `#12151D` with `1px solid rgba(255, 255, 255, 0.08)` outline. 
- Integrated countdown ticker displaying TTL (e.g., `BURNS IN 09:59.42`) styled in `mono-telemetry` with high-contrast amber/cyan status pulses.

### Progress & Transfer Streams
- Linear progress tracks: Background `#1A1F2C`, height `3px`, border radius `1px`.
- Fill track: `#06B6D4` with a subtle leading light head (`box-shadow: 0 0 8px #22D3EE`). 
- File chunking manifests represented as an array of microscopic grid blocks indicating real-time Cloudflare R2 chunk confirmations.

### Status Chips & Badges
- Pill shape with 4px corners, height `22px`, internal padding `0 8px`, typography `label-caps`.
- **Encrypted Chip:** Text `#818CF8`, background `rgba(99, 102, 241, 0.1)`, border `1px solid rgba(99, 102, 241, 0.2)`.
- **Active Streaming Chip:** Text `#22D3EE`, background `rgba(6, 182, 212, 0.1)`, border `1px solid rgba(6, 182, 212, 0.2)`, accompanied by a 6px blinking cyan status dot.

### Checkboxes & Segmented Toggles
- Square 16px controls with 3px border radius. Unchecked: `1px solid rgba(255, 255, 255, 0.2)` on `#12151D`. Checked: `#6366F1` fill with crisp white check mark icon.
- Ephemeral controls (e.g., "Burn after single read", "Encrypt with client password") rendered as high-density switch rows with instant micro-interactions.