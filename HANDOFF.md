# Visualizer Lab handoff

Work continues on `visualizer-continuation`, currently pushed through commit `335f437`
(`Rebuild visualizer lab editing and particle physics`). There are no migration or backwards-
compatibility requirements for saved Lab graphs.

## Start here

```bash
git switch visualizer-continuation
git pull --ff-only
cd frontend
pnpm install
pnpm dev:visualizer
```

Open <http://127.0.0.1:26010> and click **Start**. The editor exists only in this checked-in Lab.
Local music belongs in `frontend/devlab/audio/`, which is intentionally ignored.

## Current state

- React Flow editing, connection search/filtering, safe node removal, Inspector controls, autosave,
  graph copying, and clipboard-failure fallback are implemented.
- Particle radius, mass, elasticity, friction, lifetime, velocity, and color now live on physical
  bodies in a fixed-step 2D simulation. Emitters, forces, and colliders are explicit graph inputs.
- The particle renderer projects the same body circles to mask and color outputs; it cannot resize
  the physics globally. There are no fallback emitters, implicit walls, offscreen respawns, or
  default music bindings.
- Click **Particle sanity** in the editor to load an unbound diagnostic graph. Debug colors expose
  particles, emitter, force extent, frame, and static-circle collider.

TypeScript and 79 focused checks passed. Full CI was intentionally not run. The rewritten particle
scene has not yet had a fresh browser smoke test; that preset is the first next step.

`a.png` is an intentionally untracked anomaly screenshot at the repository root.
