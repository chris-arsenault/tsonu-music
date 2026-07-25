# Visualizer plugins

One directory per plugin category. Each plugin is a definition — identity, version, category,
typed input and output ports, capabilities, declared cost, selection character, activation rules —
plus an instance body with `initialize`, `activate`, `update`, `render`, `deactivate`, and
`destroy`.

| Category | Role |
| -------- | ---- |
| `sources/` | Produce visual material |
| `fields/` | Produce spatial data consumed by other plugins |
| `simulators/` | Maintain persistent state across frames |
| `transformers/` | Modify an existing layer |
| `compositors/` | Combine layers |
| `postprocess/` | Operate near final output |

A plugin definition is plain data, so definitions are unit-testable and are validated against the
graph and grammar rules in [`../core`](../core) without a GL context.

Registering a plugin must never require a kernel change. A plugin declares what it needs and what
it produces; the kernel understands only capabilities, port types, costs, dependencies,
compatibility, lifecycle state, and scheduling metadata.

Plugins must not compile shaders per frame, decode assets per frame, allocate unbounded textures,
retain unbounded temporal history, allocate continuously on the main thread, or require full
device-pixel rendering on high-DPI displays.
