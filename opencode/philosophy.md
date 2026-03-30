# Architecture Philosophy

This document defines the architectural principles that all code in this project should adhere to. Review agents check implementations against these principles during the development cycle.

Customize this file to match your project's actual architecture. Delete or modify any section that doesn't apply.

---

## Module Boundaries

Define which modules exist and what they're allowed to import.

### Principles

- **Domain modules** (e.g., `core/`, `domain/`) must not import from `infrastructure/`, `api/`, or `ui/`
- **Infrastructure modules** may import from domain but never the reverse
- **Feature modules** depend on shared/core modules, never on other feature modules directly
- Public APIs are exported through index files — internal files are never imported from outside the module

### Module Map

```
src/
├── core/          # Pure domain logic, no framework deps
├── domain/        # Business entities and rules
├── infrastructure/# External integrations (db, api, auth)
├── features/      # Feature-specific code, isolated from each other
│   ├── feature-a/
│   └── feature-b/
├── shared/        # Cross-cutting utilities and UI primitives
└── ui/            # Presentation layer, thin wrappers
```

---

## Separation of Concerns

### Principles

- **Business logic** lives in `domain/` or `core/`, never in UI components or API handlers
- **Data access** (API calls, DB queries) is isolated in `infrastructure/` — never inline in components or services
- **Presentation logic** (what to show, how to lay out) stays in UI components — no business rules
- **Configuration** is centralized, not scattered as inline values

---

## Dependency Direction

### Principles

- Dependencies point inward: UI → Features → Domain → Core
- Abstractions define interfaces; concretions implement them
- Domain code defines what it needs; infrastructure provides it (dependency inversion)
- No upward or circular dependencies

---

## Naming & Organization

### Principles

- Names reflect the **domain language**, not the technical role (e.g., `Invoice` not `InvoiceManager`)
- One concept, one name — avoid synonyms across the codebase
- File names match their primary export
- Group by feature/domain, not by file type (e.g., `invoicing/` not `components/`)

---

## Data Flow

### Principles

- State is owned by the module that's most responsible for it — not passed through long chains
- Side effects (API calls, file writes, timers) are explicit and contained in infrastructure or hooks
- Derived state is computed, not duplicated
- Props/data flow down; events/actions flow up

---

## Extensibility

### Principles

- New features should follow the same module pattern without modifying existing modules
- Configuration values are never hardcoded in logic — use config files or environment variables
- Extension points (plugins, hooks, middleware) are the intended way to add behavior, not modification of core code

---

## Anti-Patterns to Watch For

These are signs that the architecture is degrading:

- A file importing from 5+ modules — likely doing too much
- "Manager", "Handler", "Service", "Util" as suffixes on the same concept
- Business logic checking `if (process.env.NODE_ENV === 'production')`
- Components that fetch their own data (should be passed down or via hooks)
- Circular imports (A imports B imports A)
- Deep import paths like `../../../../core/something`
- Any file over 300 lines that isn't a configuration or data file
