# Modular WebGL Music Visualizer

## 1. Objective

Build a real-time WebGL music visualizer for a streaming website, inspired by the compositional behavior of classic Winamp visualizers, G-Force, MilkDrop, Hydra, and modular node-based visual systems.

The engine must continuously construct evolving visual scenes from independently activatable plugins.

It must support:

* Live audio-reactive visuals
* Correct behavior across play, pause, buffering, seeking, and track changes
* Album artwork as visual synthesis material
* Mask assets as spatial control fields
* Optional particle and physical simulation systems
* Optional depth-parallax and simple 3D scene sources
* Recursive feedback and image transformation
* Dynamic activation and replacement of individual visual modules
* Graceful performance degradation

The engine must not be organized around one fixed visualizer pipeline or one monolithic preset.

---

# 2. Core Design Principle

The visualizer is a **microkernel plus a dynamic plugin graph**.

The kernel owns:

* Playback synchronization
* Audio feature extraction
* Simulation time
* GPU resource management
* Plugin registration and lifecycle
* Render-graph construction
* Layer composition
* Plugin scheduling
* Performance budgeting
* Scene transitions

All visual behavior is implemented through plugins.

A scene is a temporary composition such as:

```text
Album-art edge source
+ radial waveform
+ sparse particle simulator
+ vortex field
+ kaleidoscope transform
+ feedback warp
+ album-derived palette
```

The scheduler may later replace only the kaleidoscope with a bilateral mirror while preserving:

* Particle state
* Feedback state
* Album-art contribution
* Audio bindings
* Other active plugins

Visual evolution should primarily occur through incremental mutation rather than complete scene replacement.

---

# 3. Non-Goals

The initial system is not:

* A general-purpose visual programming environment
* A user-authored GLSL editor
* A full 3D game engine
* A physically accurate scientific simulator
* A subatomic particle simulator
* A video editor
* A server-side rendering system
* A fixed-BPM animation engine
* A MilkDrop-compatible engine
* A requirement to use album art, masks, particles, or 3D in every scene

Compatibility adapters may be added later without defining the internal architecture.

---

# 4. System Architecture

```text
Streaming player / HTML media element
                 │
                 ▼
          Playback clock
                 │
                 ├── Audio output
                 │
                 └── Audio analysis
                           │
                           ▼
                    Audio feature bus
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
        Activation scheduler    Plugin registry
                 │                   │
                 └─────────┬─────────┘
                           ▼
                    Active plugin set
                           │
                           ▼
                     Render graph
                           │
                           ▼
                    Layer compositor
                           │
                           ▼
                    Feedback pipeline
                           │
                           ▼
                         Canvas
```

---

# 5. Kernel Interfaces

```ts
interface VisualKernel {
  playbackClock: PlaybackClock;
  audioFeatures: AudioFeatureBus;
  resources: ResourceManager;
  assets: VisualAssetRegistry;
  plugins: PluginRegistry;
  scheduler: ActivationScheduler;
  graphBuilder: RenderGraphBuilder;
  compositor: LayerCompositor;
  performance: PerformanceBudgetController;
}
```

The kernel must not contain effect-specific behavior.

It should understand only:

* Plugin capabilities
* Typed inputs and outputs
* Declared costs
* Dependencies
* Compatibility
* Lifecycle state
* Scheduling metadata

---

# 6. Playback and Timing

## 6.1 Playback Clock

Visual time must follow actual playback rather than a free-running animation clock.

```ts
interface PlaybackClock {
  trackId: string | null;
  playbackTime: number;
  duration: number;

  state:
    | "idle"
    | "playing"
    | "paused"
    | "buffering"
    | "seeking"
    | "ended";

  generation: number;
}
```

`requestAnimationFrame` schedules rendering but does not define authoritative visual time.

## 6.2 Pause

When playback pauses or stalls:

* Freeze all simulator advancement
* Freeze feedback evolution
* Freeze mutation timers
* Freeze beat-phase interpolation
* Retain the current frame and GPU state
* Do not clear active plugins

Resume only when audio is actually playing again.

Before resuming:

* Clear stale transient events
* Prevent false beat or onset triggers
* Continue from retained visual state

## 6.3 Seek

On seek start:

* Freeze simulation
* Retain the current framebuffer
* Clear queued audio events
* Clear short-term onset and spectral-flux history
* Invalidate tempo confidence

On seek completion:

* Resume analysis from the new playback position
* Resume simulation when playback actually resumes
* Permit immediate onset reactions
* Rebuild beat-phase confidence from newly heard audio

Exact historical visual reconstruction is not required.

## 6.4 Track Change

When the active track changes:

* Increment the playback generation
* Clear analysis history from the previous track
* Cancel pending feature events
* Resolve track-specific assets
* Generate fresh random scene entropy
* Transition or replace incompatible visual branches
* Preserve compatible global visual state where aesthetically appropriate

---

# 7. Audio Feature System

Audio analysis is a kernel service, not plugin-specific behavior.

Plugins consume normalized signals from a shared feature bus.

```ts
interface AudioFeatureBus {
  continuous: {
    rms: number;
    peak: number;

    subBass: number;
    bass: number;
    lowMid: number;
    mid: number;
    highMid: number;
    treble: number;

    spectralCentroid: number;
    spectralFlux: number;

    beatConfidence: number;
    beatPhase: number;

    leftLevel: number;
    rightLevel: number;
    stereoBalance: number;
  };

  events: {
    onset: TimedFeatureEvent[];
    beat: TimedFeatureEvent[];
    sectionChange: TimedFeatureEvent[];
  };

  waveform: Float32Array;
  spectrum: Float32Array;
}
```

```ts
interface TimedFeatureEvent {
  feature: string;
  playbackTime: number;
  audioTime: number;
  strength: number;
  metadata?: Record<string, number>;
}
```

## 7.1 Synchronization Behavior

Beat reactivity must come from the currently playing audio.

It must not depend on:

* One precomputed BPM
* A free-running visual metronome
* Track time alone
* A beat loop that continues during pause or seek

Onsets and beats should be timestamped near the audio-processing stage and presented after accounting for estimated output latency.

The practical target is visually perceived synchronization within approximately one rendered frame plus analysis and output latency.

## 7.2 Beat Wave

The feature system should support a beat-relative phase envelope derived from adjacent detected beats.

Supported shapes may include:

* Linear ramp
* Triangle
* Sine
* Sawtooth
* Square
* Exponential decay

This allows smooth movement between actual detected beat intervals and naturally follows tempo variation.

## 7.3 Parameter Bindings

```ts
interface ParameterBinding {
  feature: string;
  parameter: string;

  inputRange?: [number, number];
  outputRange: [number, number];

  attack: number;
  release: number;

  curve:
    | "linear"
    | "smooth"
    | "square"
    | "sqrt"
    | "exponential";

  polarity?: 1 | -1;
}
```

Audio feature extraction, normalization, and beat detection must not be duplicated inside plugins.

---

# 8. Plugin Model

## 8.1 Plugin Categories

```ts
type PluginCategory =
  | "source"
  | "field"
  | "simulator"
  | "transformer"
  | "compositor"
  | "postprocess";
```

### Sources

Produce visual material.

Examples:

* Album art
* Procedural textures
* Audio waveforms
* Spectrum geometry
* Parallax images
* 3D scenes

### Fields

Produce spatial data consumed by other plugins.

Examples:

* Signed-distance fields
* Flow fields
* Gravity fields
* Depth fields
* Optical flow
* Audio impulses

### Simulators

Maintain persistent state.

Examples:

* Particles
* Reaction-diffusion
* Wave fields
* Boids
* Springs
* Fluids

### Transformers

Modify an existing layer.

Examples:

* Feedback warp
* Kaleidoscope
* Domain displacement
* Polar transform
* Glitch

### Compositors

Combine layers.

Examples:

* Additive blend
* Masked blend
* Depth-aware composition
* Feedback injection

### Post-processors

Operate near final output.

Examples:

* Palette mapping
* Glow
* Tone mapping
* Grain

---

# 9. Plugin Contract

```ts
interface VisualPluginDefinition {
  id: string;
  version: number;
  category: PluginCategory;

  inputs: PluginPort[];
  outputs: PluginPort[];

  capabilities: string[];
  requiredCapabilities?: string[];

  cost: PluginCost;
  character: SelectionCharacter;
  activationRules: ActivationRules;

  create(context: PluginCreateContext): VisualPluginInstance;
}
```

```ts
interface VisualPluginInstance {
  initialize(): Promise<void>;

  activate(context: ActivationContext): void;
  update(context: FrameContext): void;
  render(context: RenderContext): void;

  deactivate(context: DeactivationContext): void;
  destroy(): void;
}
```

## 9.1 Port Types

```ts
type PortType =
  | "color-texture"
  | "mask-texture"
  | "distance-field"
  | "vector-field"
  | "collision-field"
  | "reaction-diffusion-state"
  | "wave-field-state"
  | "depth-texture"
  | "motion-field"
  | "particle-buffer"
  | "geometry"
  | "palette"
  | "scalar-feature"
  | "event-feature"
  | "event-stream";
```

```ts
interface PluginPort {
  name: string;
  type: PortType;
  required: boolean;
  multiple?: boolean;
}
```

The graph builder must reject invalid connections.

## 9.2 Plugin Costs

```ts
interface PluginCost {
  gpu: number;
  cpu: number;
  memory: number;
  renderPasses: number;

  qualityScalable: boolean;
  dominant: boolean;
}
```

## 9.3 Plugin Character

```ts
interface SelectionCharacter {
  visualDensity: number;
  motionEnergy: number;
  geometricOrder: number;
  recognizability: number;
  persistence: number;
  brightness: number;
  dominance: "supporting" | "primary" | "either";
}
```

This metadata is used to assemble coherent scenes rather than randomly selecting compatible plugins.

---

# 10. Render Graph

The active plugin set is compiled into a directed graph.

Example:

```text
AlbumArtSource
 ├── PaletteExtractor ────────────────────┐
 ├── EdgeField ── ParticleEmitter ──────┐ │
 └── DepthMap ── DepthParallaxSource    │ │
                                       ▼ ▼
WaveformSource ─────────────────── LayerMixer
MaskSDF ── VectorField ── Particles     │
                                       ▼
                                FeedbackFlow
                                       ▼
                               SymmetryTransform
                                       ▼
                                  ToneMapper
                                       ▼
                                     Canvas
```

The graph must support:

* Multiple visual branches
* Independent branch mutation
* Typed intermediate resources
* Feedback loops
* Reuse of derived assets
* Shared fields consumed by multiple plugins
* Crossfades between incompatible branches

Plugins should render into typed outputs rather than directly to the final canvas, except for the final presentation stage.

---

# 11. Layer Model

```ts
interface VisualLayer {
  color?: TextureHandle;
  alpha?: TextureHandle;
  depth?: TextureHandle;
  motion?: TextureHandle;

  blendMode:
    | "normal"
    | "add"
    | "screen"
    | "multiply"
    | "difference"
    | "lighten"
    | "darken";

  opacity: number;
  order: number;

  feedbackParticipation: number;
}
```

The compositor owns:

* Layer order
* Blend modes
* Masking
* Feedback injection
* Depth interaction
* Crossfades
* Final output routing

---

# 12. Visual Asset Model

```ts
type VisualAsset =
  | AlbumArtAsset
  | MaskAsset
  | DepthImageAsset
  | ParallaxModelAsset;
```

## 12.1 Album Artwork

```ts
interface AlbumArtAsset {
  id: string;
  kind: "album-art";
  src: string;

  focalPoint?: [number, number];
  preserveAspect?: boolean;

  paletteWeight?: number;
  recognizability?: number;
}
```

Album art is an optional synthesis source.

It may be used for:

* Direct texture injection
* Palette extraction
* Edge geometry
* Silhouettes
* Displacement
* Particle emission
* Depth-parallax
* Feedback material

The existence of album art must not require it to appear directly.

## 12.2 Mask Assets

```ts
interface MaskAsset {
  id: string;
  kind: "mask";
  src: string;

  interpretation:
    | "alpha"
    | "luminance"
    | "threshold";

  invert?: boolean;
  mirror?: boolean;
  tile?: boolean;
}
```

Mask assets are spatial-control material.

Examples include:

* Rorschach-style inkblots
* Logos
* Silhouettes
* Geometric patterns
* Hand-authored boundary shapes
* Organic image masks

Derived outputs may include:

* Binary mask
* Soft mask
* Edge map
* Signed-distance field
* Gradient field
* Approximate normal field

Masks may control:

* Particle spawn
* Collision boundaries
* Containment
* Feedback visibility
* Distortion regions
* Color injection
* Wave clipping
* Symmetry anchors
* Parallax influence

Masks must not imply particle use.

## 12.3 Depth Images

```ts
interface DepthImageAsset {
  id: string;
  kind: "depth-image";

  imageSrc: string;
  depthSrc: string;
}
```

Used for lightweight 2.5D image parallax.

## 12.4 Simple 3D Models

```ts
interface ParallaxModelAsset {
  id: string;
  kind: "parallax-model";
  src: string;

  defaultCameraRig?:
    | "drift"
    | "orbit"
    | "push-pull";
}
```

Simple 3D models should be treated as optional scene sources.

Expected output:

* Color texture
* Depth texture
* Optional emissive texture
* Optional mask texture

The 3D source enters the normal compositor and does not own the visualizer.

---

# 13. Derived Asset Plugins

Asset derivation should occur through reusable plugins or cached preprocessing.

Examples:

* `AlbumArtPalette`
* `AlbumArtEdges`
* `AlbumArtSilhouette`
* `DistanceFieldOperator`
* `ImageLuminanceField`
* `DepthMapSource`
* `PointCloudExtractor`

Derived resources should be reusable by multiple branches within the same scene.

---

# 14. Activation Scheduler

The scheduler decides:

* Which plugins are active
* Which assets are assigned
* How plugins are connected
* When parameters mutate
* When a plugin is replaced
* When a branch is replaced
* When a complete scene transition occurs

Inputs include:

* Available assets
* Current track
* Audio energy
* Section-change features
* Active theme
* Current scene character
* Recent plugin history
* Plugin compatibility
* Performance budget
* Fresh random scene entropy
* User preferences

```ts
interface ActivationRules {
  minimumDuration?: number;
  maximumDuration?: number;

  requiredAssets?: string[];
  requiredCapabilities?: string[];

  incompatibleWith?: string[];
  prefersWith?: string[];

  activationWeight: number;
  cooldown?: number;
}
```

---

# 15. Scene Grammar

Compatibility alone is insufficient. The scheduler must assemble scenes using grammar constraints.

```ts
interface SceneGrammar {
  sourceCount: [number, number];
  fieldCount: [number, number];
  simulatorCount: [number, number];
  transformerCount: [number, number];
  compositorCount: [number, number];
  postprocessCount: [number, number];

  maximumDominantPlugins: number;
  maximumHighCostPlugins: number;
  maximumFeedbackLoops: number;
  maximumSymmetryTransforms: number;

  requireVisibleSource: boolean;
}
```

Example visual families:

## Organic Flow

* One primary visual source
* Zero or one simulator
* One or two spatial fields
* One feedback transformer
* Optional symmetry
* One palette policy

## Geometric Signal

* Waveform or spectrum source
* Parametric or SDF geometry
* Symmetry transform
* Restrained feedback
* No dense simulator

## Collision Energy

* One impact simulator
* One or two force fields
* Feedback warp
* Glow
* Optional mask or album-art geometry

## Image Dream

* Album art or depth-parallax source
* Edge or silhouette derivation
* Domain warp
* Feedback
* Optional sparse particles

---

# 16. Visual State and Themes

```ts
interface VisualState {
  id: string;

  plugins: ActivePlugin[];
  edges: RenderGraphEdge[];

  startedAtPlaybackTime: number;
}
```

```ts
interface ActivePlugin {
  instanceId: string;
  pluginId: string;

  parameters: Record<string, unknown>;
  bindings: ParameterBinding[];

  activationTime: number;
}
```

A theme provides constraints and weighted preferences rather than a fixed pipeline.

```ts
interface VisualTheme {
  id: string;

  allowedPlugins?: string[];
  excludedPlugins?: string[];

  preferredPlugins?: WeightedPluginPreference[];
  grammar: SceneGrammar;

  targetCharacter?: Partial<SelectionCharacter>;
  mutationPolicy: MutationPolicy;
  colorPolicy?: ColorPolicy;
}
```

---

# 17. Mutation Model

Bound parameters evolve continuously and concurrently from two inputs: the live audio feature
assigned to that binding and a slower playback-clocked modulation with its own phase. The latter is
bounded by the binding's declared range and freezes whenever playback freezes. Discrete mutation is
for structural evolution, not the only source of motion.

## Parameter Mutation

Changes one or more parameters while preserving plugin identity.

Examples:

* Increase vortex strength
* Change feedback decay
* Shift palette
* Increase symmetry count

## Plugin Mutation

Replaces one plugin with another.

Examples:

* Polar warp → ripple warp
* Kaleidoscope → bilateral mirror
* Spectrum contour → waveform ribbon

## Branch Mutation

Replaces one visual branch.

Example:

```text
Album-art edge particles
→ album-art depth parallax
```

## Scene Mutation

Rebuilds most of the graph.

Use sparingly:

* Major section transition
* Track change
* Performance downgrade
* Long-lived visual exhaustion

---

# 18. Deactivation

Stateful plugins must declare graceful deactivation behavior.

```ts
type DeactivationPolicy =
  | "immediate"
  | "fade"
  | "drain"
  | "freeze-and-dissolve"
  | "handoff-feedback";
```

Examples:

* Particle emitter stops while existing particles drain
* Boids fade after leaving the viewport
* Fluid injection stops while the field dissipates
* A 3D source freezes its final frame into feedback
* A field reduces strength before removal
* A symmetry transform crossfades to its replacement

---

# 19. Plugin Catalog

## 19.1 Signal-Derived Sources

### `SignalTraceSource`

Waveform-derived geometry.

Modes:

* Horizontal oscilloscope
* Mirrored ribbon
* Circular waveform
* Spiral waveform
* Stacked traces
* Stereo Lissajous
* Radial petals
* Smoothed filament

Cost: low
Role: supporting or primary

### `SpectrumGeometrySource`

Frequency-derived geometry.

Modes:

* Frequency contour
* Radial spectrum
* Mountain ridge
* Concentric rings
* Spectral ribbon
* Waterfall history
* Logarithmic spiral
* Frequency-cell matrix

Cost: low–medium
Role: supporting or primary

### `TransientGlyphSource`

Short-lived geometry triggered by audio events.

Modes:

* Expanding rings
* Polygon bursts
* Radial cracks
* Star pulses
* Line sprays
* Shockwaves

Cost: low
Role: supporting

---

## 19.2 Procedural Sources

### `ProceduralTextureSource`

Modes:

* Oscillator stripes
* Gradient fields
* Value noise
* Curl-like noise
* Cellular texture
* Checker patterns
* Concentric rings
* Angular ramps

Cost: low
Role: supporting or primary

### `ParametricCurveSource`

Modes:

* Spirograph
* Harmonograph
* Rose curves
* Hypotrochoids
* Epitrochoids
* Superformula-like curves
* Torus-knot projections
* Pendulum curves

Cost: low
Role: primary

### `SDFShapeSource`

Modes:

* Primitive shapes
* Smooth unions
* Shape subtraction
* Repetition
* Primitive morphing
* Mandalas
* Procedural glyphs

Outputs may include:

* Color
* Mask
* Distance field
* Gradient field

Cost: low–medium
Role: either

### `FractalFlameSource`

Iterated nonlinear transform imagery.

Modes may include:

* Sinusoidal
* Spherical
* Swirl
* Horseshoe
* Polar
* Spiral
* Disc-like transforms

Cost: medium–high
Role: primary

### `EscapeFractalSource`

Modes:

* Mandelbrot
* Julia
* Burning Ship
* Newton basins
* Orbit traps
* Folded-domain fractals

Cost: medium
Role: primary

---

## 19.3 Asset Sources

### `AlbumArtSource`

Displays or injects album artwork.

Uses:

* Direct source
* Feedback material
* Fragmented source
* Silhouette reveal

Cost: low
Role: either

### `AlbumArtPalette`

Extracts or supplies a track-derived palette.

Cost: low
Role: supporting

### `AlbumArtEdges`

Produces recognizable edge geometry or masks.

Cost: low–medium
Role: supporting

### `AlbumArtDisplacement`

Produces scalar or vector displacement from album-art luminance and edges.

Cost: low–medium
Role: supporting

### `DepthParallaxSource`

Renders image-plus-depth-map parallax.

Camera modes:

* Drift
* Orbit
* Push-pull
* Pan
* Subtle roll

Cost: medium
Role: primary

### `GLBParallaxSource`

Renders a simple 3D model into color and depth textures.

Possible audio mappings:

* Bass → depth movement
* Midrange → object rotation
* Treble → emissive response
* Onset → camera impulse

Cost: medium–high
Role: primary

### `PointCloudSource`

Generates point representations from:

* Album art
* Depth images
* Model vertices
* Masks
* Procedural fields

Modes:

* Depth extrusion
* Dissolution
* Reassembly
* Curl deformation
* Layer peeling

Cost: medium–high
Role: primary

### `WireframeGeometrySource`

Modes:

* Polygon tunnels
* Grid landscapes
* Polyhedra
* Spherical grids
* Audio-deformed meshes
* Contour surfaces

Cost: medium
Role: primary

### `RaymarchSDFSource`

Procedural 3D SDF scenes.

Modes:

* Morphing primitives
* Repeated tunnels
* Reflective chambers
* Organic blobs
* Folded fractals
* Audio-deformed structures

Cost: high
Role: primary

---

## 19.4 Fields

### `ProceduralVectorField`

Modes:

* Curl field
* Radial attraction
* Radial repulsion
* Spiral
* Saddle
* Sinusoidal lattice
* Turbulence
* Domain-warped flow

Cost: low–medium

### `AudioImpulseField`

Produces temporary forces from audio features.

Modes:

* Center shockwave
* Localized impulse
* Bass compression
* Treble turbulence
* Stereo lateral push
* Beat-ring propagation

Cost: low

### `MaskSignedDistanceField`

Converts a mask into distance, edge, and gradient information.

Uses:

* Collision
* Containment
* Attraction
* Repulsion
* Effect falloff
* Glow
* Edge rendering

Cost: medium to generate, low to reuse

### `MaskBoundaryField`

Represents mask edges as collision or deflection boundaries.

Cost: low–medium

### `MaskContainmentField`

Constrains visual systems inside or outside a mask.

Cost: low

### `MaskEffectStencil`

Routes effects through a mask without requiring simulation.

Cost: low

### `ImageLuminanceField`

Uses image brightness as a density, force, or displacement field.

Cost: low

### `OpticalFlowField`

Estimates motion from successive textures.

Uses:

* Particle advection
* Feedback dragging
* Motion inheritance
* Visual-layer coupling

Cost: medium–high

### `ModelDepthField`

Provides depth-based force, collision, or occlusion information from a 3D source.

Cost: medium

---

## 19.5 Particle and Agent Systems

### `ParticleSimulator`

General-purpose GPU particle state.

Supports:

* Position
* Velocity
* Age
* Size
* Class
* Optional charge
* Optional mass

Cost: medium
Role: either

### `ParticleEmitter`

Emitter modes:

* Point
* Region
* Line
* Ring
* Waveform
* Mask interior
* Mask edge
* Album-art edge
* Model vertex
* Event burst

Cost: low

### `ParticleForceField`

Consumes vector and scalar fields.

Supports:

* Attraction
* Repulsion
* Vortex
* Gravity
* Wind
* Curl
* Audio impulses

Cost: low–medium

### `ParticleCollider`

Collision sources:

* Mask SDF
* Procedural SDF
* Depth field
* Screen boundary
* Other particles where supported

Cost: medium

### `ParticleRenderer`

Modes:

* Points
* Discs
* Lines
* Sprites
* Sparks
* Comets
* Fragmented image samples

Cost: low–medium

### `ParticleTrailInjector`

Feeds particle motion into feedback or a dedicated trail texture.

Cost: low–medium

### `BoidSwarmSimulator`

Agent behavior:

* Separation
* Alignment
* Cohesion
* Obstacle avoidance
* Attractor following
* Audio impulses

Visual forms:

* Points
* Fish-like marks
* Line segments
* Geometric sprites
* Image fragments

Cost: medium
Role: primary

### `PhysarumTrailSimulator`

Agents deposit and follow a diffusing trail field.

Visual behavior:

* Veins
* Slime-mold networks
* Branching paths
* Filaments

Cost: medium–high
Role: primary

### `ParticleLifeSimulator`

Multiple particle classes with attraction and repulsion relationships.

Visual behavior:

* Clustering
* Orbiting colonies
* Merging
* Separation
* Cell-like structures

Cost: medium–high
Role: primary

---

## 19.6 Impact Dynamics

### `ImpactCascadeSimulator`

High-energy physical particle system centered on:

```text
accelerate
→ collide
→ burst
→ fragment spray
→ field warp
```

It is distinct from ambient particles, boids, or scientific particle simulation.

Modes:

* Head-on streams
* Orbital collapse
* Boundary slam
* Scatter field
* Gravity capture
* Magnetic arc

Acceleration sources:

* Directional launch
* Gravity wells
* Opposing streams
* Orbital decay
* Magnetic lanes
* Radial collapse

Collision targets:

* Other particle streams
* Mask boundaries
* SDF geometry
* Model depth surfaces
* Spring meshes
* Designated impact cores

Impact results:

* Fragment spray
* Spark trails
* Radial burst
* Heat map
* Shock ring
* Temporary debris cloud
* Local distortion field

Post-impact field modes:

* Gravity sink
* Gravity lens
* Magnetic curl
* Radial compression
* Repulsive shockwave
* Hybrid gravity/electromagnetic field

```ts
interface ImpactEvent {
  position: [number, number];
  energy: number;
  impulse: [number, number];
  radius: number;
  playbackTime: number;
}
```

Impact events may drive:

* Wave-field impulses
* Feedback bulges
* Glow
* Album-art reveals
* Shockwave transforms
* Secondary emitters
* Spring-mesh deformation

Cost: medium–high
Role: primary
Dominant: yes

Scheduler constraints:

* Normally only one dominant high-energy simulator
* Avoid simultaneous full fluid and impact simulation
* Compatible with masks, album palettes, feedback, glow, and wave fields

---

## 19.7 Continuous Simulators

### `ReactionDiffusionSimulator`

Two-channel reaction-diffusion field.

Visual behavior:

* Spots
* Stripes
* Coral growth
* Cell division
* Organic membranes
* Traveling patterns

Inputs:

* Mask seeds
* Album luminance
* Particle deposition
* Audio impulses

Outputs:

* Concentration fields
* Edge mask
* Displacement field
* Colorized layer

Cost: medium
Role: primary

### `WaveFieldSimulator`

Damped height or membrane field.

Visual behavior:

* Ripples
* Interference
* Shockwaves
* Membrane vibration
* Refraction

Inputs:

* Audio onset
* Particle impacts
* Mask boundaries
* Waveform traces

Outputs:

* Height
* Velocity
* Normals
* Refracted color

Cost: medium
Role: either

### `FluidAdvectionSimulator`

Reduced-resolution dye and velocity field.

Visual behavior:

* Smoke
* Ink
* Swirls
* Turbulent trails
* Image dissolution

Inputs:

* Album-art color
* Masks
* Audio forces
* Particle deposition

Cost: high
Role: primary

### `SpringMeshSimulator`

Nodes connected by damped springs.

Visual behavior:

* Webs
* Membranes
* Constellations
* Elastic image meshes
* Plucked networks

Inputs:

* Mask anchors
* Album-art edges
* Audio impulses
* Particle impacts

Outputs:

* Geometry
* Line layer
* Displacement mesh
* Vector field

Cost: medium
Role: primary

### `CellularFieldSimulator`

Curated neighborhood-based systems.

Modes:

* Conway-like
* Cyclic automata
* Excitable media
* Continuous growth fields
* Simplified Lenia-like behavior

Cost: medium
Role: primary

---

## 19.8 Feedback and Coordinate Transformers

### `FeedbackFlowTransform`

Modes:

* Zoom
* Rotation
* Translation
* Spiral
* Radial expansion
* Pinch
* Vortex
* Directional drift
* Vector-field flow

Cost: low
Role: foundational

### `SymmetryTransform`

Modes:

* Horizontal mirror
* Vertical mirror
* Bilateral
* Four-way
* Kaleidoscope
* Radial sector repetition
* Rotational symmetry
* Dihedral symmetry

Cost: low

Normally only one dominant symmetry transform should affect a branch.

### `CoordinateWarpTransform`

Modes:

* Polar
* Log-polar tunnel
* Twirl
* Bulge
* Pinch
* Fisheye
* Wave warp
* Barrel distortion
* Perspective fold

Cost: low

### `DomainWarpTransform`

Uses one visual source or field to distort another.

Modes:

* Luminance displacement
* Vector displacement
* Angular displacement
* Scale modulation
* Rotation modulation
* Local zoom

Cost: low–medium

### `TilingTransform`

Modes:

* Repeat
* Mirror repeat
* Brick offset
* Polar tiles
* Hex-like repetition
* Infinite zoom lattice
* Recursive frames
* Truchet-like orientation

Cost: low

### `TemporalTransform`

Maintains bounded frame history.

Modes:

* Echo
* Multi-tap delay
* Slit scan
* Time slices
* Directional smear
* Frame mosaic
* Delayed mirror
* Temporal difference
* Frozen fragments

Cost: medium

### `EdgeContourTransform`

Modes:

* Sobel contour
* Luminous edge
* Embossed edge
* Gradient-colored edge
* Repeated edge feedback
* Edge stencil

Cost: low

### `GlitchTransform`

Modes:

* Block displacement
* Channel offset
* Scanline shear
* Line dropout
* UV jitter
* Macroblock freeze
* Data-moshing approximation
* Sync roll

Cost: low–medium

Normally transient rather than continuously dominant.

### `PixelTopologyTransform`

Modes:

* Pixelation
* Posterization
* ASCII-like cells
* Dot matrix
* Voronoi cells
* Halftone
* Mosaic sampling
* Ordered dithering

Cost: low–medium

### `ShockwaveTransform`

Consumes impact or onset events and distorts an existing layer.

Modes:

* Radial bulge
* Compression ring
* Refraction ring
* Chromatic shock
* Directional blast
* Gravitational lens

Cost: low–medium

---

## 19.9 Compositors and Color

### `FlowFieldCompositor`

Consumes visible colour and a vector or collision field. It traces several samples through the field,
warps the visible branch, and derives breathing chromatic ribbons from curvature and force magnitude.
This is the standard coupling point for masks, force fields, and visible material.

Cost: medium

### `LayerMixer`

Modes:

* Normal
* Add
* Screen
* Multiply
* Difference
* Lighten
* Darken
* Contrast blend

Cost: low

### `MaskRouter`

Operations:

* Apply
* Invert
* Union
* Intersection
* Subtraction
* Feather
* Threshold
* Edge-only
* Distance falloff

Cost: low

### `FeedbackInjector`

Controls how a layer enters feedback.

Modes:

* Continuous
* Event-driven
* Edge-only
* Masked
* Decaying
* Burst injection

Cost: low

### `PaletteMapper`

Sources:

* Album-art palette
* Curated palette
* Complementary palette
* Time-varying gradient
* Track-specific palette

Cost: low

### `ColorTransform`

Modes:

* Hue rotation
* Saturation shaping
* Contrast
* Solarization
* Inversion
* Channel permutation
* Duotone
* Palette quantization
* Luminance isolation

Cost: low

### `DepthCompositor`

Uses depth to combine layers.

Uses:

* Foreground/background particle routing
* 3D and image-parallax composition
* Depth fog
* Depth blur
* Occlusion

Cost: medium

### `GlowAndScatter`

Modes:

* Soft bloom
* Directional streak
* Radial scatter
* Edge glow
* Anamorphic smear

Cost: medium

### `ToneMapper`

Handles:

* Exposure
* Highlight compression
* Gamma
* Black level
* Dithering
* Output conversion

Cost: low
Normally active

---

# 20. Audio Mapping Guidance

Plugins should not all react to the same audio event.

| Feature           | Appropriate targets                     |
| ----------------- | --------------------------------------- |
| RMS               | Width, opacity, visual intensity        |
| Bass              | Large-scale force, expansion, zoom      |
| Midrange          | Geometry deformation, rotation          |
| Treble            | Edge detail, sparks, turbulence         |
| Onset             | Bursts, impulses, collision launches    |
| Beat phase        | Repeating motion between actual beats   |
| Spectral centroid | Complexity, sharpness, palette movement |
| Stereo balance    | Horizontal force, camera orbit          |
| Section energy    | Plugin and branch mutation              |

The scheduler should distribute reactivity across active plugins.

Example:

* Bass drives feedback expansion
* Treble drives particle sparks
* Onsets inject wave impulses
* Beat phase controls geometric rotation
* Section changes replace a branch

Avoid making every active parameter pulse on every beat.

---

# 21. Performance Management

## 21.1 Quality Levels

The kernel should maintain an adaptive quality profile controlling:

* Render resolution
* Particle count
* Simulation resolution
* Trail resolution
* Stored history count
* 3D model detail
* Post-process passes
* Expensive plugin availability

## 21.2 Downgrade Order

When sustained frame time exceeds the budget:

1. Reduce internal render resolution
2. Reduce particle and agent counts
3. Reduce simulation texture resolution
4. Reduce temporal-history depth
5. Disable optional glow or secondary post-processing
6. Disable the most expensive supporting plugin
7. Remove the most expensive optional primary plugin
8. Rebuild using a lower-cost scene grammar

Quality should recover conservatively.

## 21.3 Resource Constraints

Plugins must not:

* Compile shaders per frame
* Decode assets per frame
* Allocate unbounded textures
* Retain unbounded temporal history
* Perform continuous main-thread allocation
* Require full device-pixel rendering on high-DPI displays

Rendering should stop when the page is hidden.

Reduced-motion preferences should produce a lower-energy scene profile rather than merely slowing every animation.

---

# 22. Failure Behavior

Playback must remain functional if visualization fails.

Handle:

* WebGL unavailable
* Context loss
* Shader failure
* Audio analysis blocked by CORS
* Audio context suspension
* Missing assets
* Unsupported texture format
* Memory pressure
* Invalid plugin graph
* Plugin initialization failure
* Zero-sized canvas

Fallback hierarchy:

```text
Full modular visualizer
→ reduced plugin graph
→ simple waveform visualizer
→ static album artwork
→ empty background
```

GPU resources should be reconstructable from retained plugin and asset metadata after context restoration.

---

# 23. Diagnostics

Development diagnostics should expose:

* Playback state and generation
* Audio-context state
* Audio output latency estimate
* Raw and normalized audio features
* Beat and onset events
* Beat confidence and phase
* Active plugins
* Current graph
* Plugin activation history
* Assigned assets
* Render resolution
* Frame time
* Plugin cost estimates
* GPU capabilities
* Texture formats
* Resource memory estimate
* Shader errors

Debug controls should support:

* Freeze scheduler mutations
* Freeze simulation while audio continues
* Disable individual plugins
* Inspect graph outputs
* Replace an active plugin manually
* Generate a fresh random scene
* Display masks, fields, depth, and motion textures

## 23.1 Scene Graph Editor

A development-only node editor, reached through the debug flag, docked below the visualizer surface
and driving the running kernel.

The editor presents a scene as a node graph following ComfyUI conventions: typed sockets, dragged
links, widgets that promote to inputs, and a searchable node catalog. It should show:

* One node per plugin instance, with its typed inputs, typed outputs, and parameters
* The layer stack, as edges from every unconsumed colour output into the composite stage
* The motion bus, as edges from every motion-typed resource into the motion stage
* The kernel stages between the graph and the canvas: composite, motion, accumulation, meter, grade
* Host assets as producer nodes
* Live resolved values for every parameter, alongside the constant or binding driving it
* Resolution problems against the node or edge that caused them

The editor should support:

* Capturing the scene the scheduler is currently rendering into an editable document
* Adding, removing, cloning, and muting nodes
* Connecting and disconnecting ports, with connection validity matching the graph compiler's
* Setting a parameter to a constant
* Binding an audio feature to a parameter, with mode, range, curve, attack, release, and polarity
* Pinning or rerolling a node's seed
* Pinning the kernel stages' own parameters, which otherwise follow the theme and the audio
* Overriding a layer's blend mode and opacity
* Applying edits to the running kernel without recreating the instances an edit did not touch
* Exporting and importing a scene document, and emitting one as a test fixture

An authored graph is validated by the render graph compiler alone. Scene grammar constraints —
category counts, minimum scene size, minimum material branches, dominance limits — do not apply, so
the editor can express scenes assembly would reject. While a document is in control, the scheduler
neither mutates nor rebuilds, and the quality ladder does not suppress plugins.

---

# 24. Initial Production Scope

## Foundation

* Audio feature bus
* Playback synchronization
* Plugin registry
* Typed render graph
* Layer compositor
* Scheduler and scene grammar
* Feedback buffers
* Adaptive performance control

## Initial plugin families

### Sources

* `SignalTraceSource`
* `SpectrumGeometrySource`
* `TransientGlyphSource`
* `ProceduralTextureSource`
* `ParametricCurveSource`
* `SDFShapeSource`
* `AlbumArtSource`
* `AlbumArtPalette`
* `AlbumArtEdges`

### Fields

* `ProceduralVectorField`
* `AudioImpulseField`
* `MaskSignedDistanceField`
* `MaskContainmentField`
* `ImageLuminanceField`

### Simulation

* `ParticleSimulator`
* `ParticleEmitter`
* `ParticleForceField`
* `ParticleRenderer`
* `ParticleTrailInjector`
* `ReactionDiffusionSimulator`
* `WaveFieldSimulator`
* `ImpactCascadeSimulator`

### Transformers

* `FeedbackFlowTransform`
* `SymmetryTransform`
* `CoordinateWarpTransform`
* `DomainWarpTransform`
* `TilingTransform`
* `EdgeContourTransform`
* `ShockwaveTransform`

### Composition

* `FlowFieldCompositor`
* `LayerMixer`
* `MaskRouter`
* `FeedbackInjector`
* `PaletteMapper`
* `ColorTransform`
* `GlowAndScatter`
* `ToneMapper`

## Secondary scope

* Depth-parallax source
* GLB parallax source
* Boid swarm
* Spring mesh
* Point cloud
* Temporal transform
* Fractal flame

## Deferred

* Full fluid simulation
* Optical flow
* Physarum
* Particle life
* Continuous cellular systems
* Raymarched scenes
* Volumetric rendering
* MilkDrop/projectM compatibility

---

# 25. Example Compositions

## Procedural Signal

```text
SignalTraceSource
+ ProceduralVectorField
+ FeedbackFlowTransform
+ SymmetryTransform
+ PaletteMapper
+ ToneMapper
```

## Album Dream

```text
AlbumArtSource
+ AlbumArtEdges
+ DomainWarpTransform
+ FeedbackFlowTransform
+ PaletteMapper
+ GlowAndScatter
```

## Masked Organic Field

```text
ProceduralTextureSource
+ MaskSignedDistanceField
+ ReactionDiffusionSimulator
+ MaskRouter
+ EdgeContourTransform
+ ToneMapper
```

## Sparse Ryan-Style Particles

```text
ParticleSimulator
+ MaskParticleEmitter
+ ProceduralVectorField
+ ParticleTrailInjector
+ FeedbackFlowTransform
+ AlbumArtPalette
```

## Rorschach Without Particles

```text
AlbumArtSource
+ MaskSignedDistanceField
+ MaskEffectStencil
+ CoordinateWarpTransform
+ FeedbackInjector
+ ColorTransform
```

## Depth Parallax

```text
DepthParallaxSource
+ SpectrumGeometrySource
+ DepthCompositor
+ FeedbackFlowTransform
+ GlowAndScatter
```

## Collision Energy

```text
ImpactCascadeSimulator
+ MaskBoundaryField
+ AudioImpulseField
+ ShockwaveTransform
+ FeedbackInjector
+ GlowAndScatter
```

## Gravitational Collision

```text
ImpactCascadeSimulator
+ ProceduralVectorField
+ WaveFieldSimulator
+ AlbumArtPalette
+ FeedbackFlowTransform
+ ToneMapper
```

## 3D Composite

```text
GLBParallaxSource
+ ModelDepthField
+ ParticleSimulator
+ DepthCompositor
+ CoordinateWarpTransform
+ ToneMapper
```

---

# 26. Acceptance Criteria

The architecture is complete when:

* Audio-reactive effects follow currently audible music after pause, resume, seek, buffering, and track changes.
* Simulation and feedback freeze during pause and seeking.
* Beat-relative motion re-locks after seeking without requiring a fixed track BPM.
* Album art can be used for color, geometry, displacement, particles, parallax, or direct imagery.
* Album art can also be ignored.
* Masks can drive particles, collision, containment, distortion, composition, or feedback independently.
* Rorschach masks are optional assets rather than a permanent visual style.
* Particles can operate without masks or album art.
* Parallax can operate as one optional source among several.
* A simple 3D scene can output color and depth into the standard compositor.
* Individual plugins can be added, removed, or replaced without resetting unrelated state.
* Stateful plugins deactivate gracefully.
* Plugin selection respects scene grammar and performance limits.
* The scheduler avoids multiple competing dominant generators.
* Plugin outputs and graph connections are typed and validated.
* New plugins can be registered without modifying kernel behavior.
* Impact dynamics visibly produce acceleration, collision, fragmentation, and secondary field distortion.
* The visualizer remains functional when individual plugins or the entire WebGL renderer fail.
