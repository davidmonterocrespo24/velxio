# Analytics Events

Velxio uses **Google Analytics 4 (GA4)** to measure key user interactions. Events are fired via `gtag` and should be marked as **Key Events** in the GA4 dashboard to track conversions and engagement.

The tracking utility lives in [`frontend/src/utils/analytics.ts`](../frontend/src/utils/analytics.ts).

---

## Key Events

### `run_simulation`

Fired when the user clicks the **Run** button to start a simulation.

| Property         | Value        |
|------------------|--------------|
| `event_category` | `engagement` |

**Location:** `EditorToolbar.tsx` → `handleRun()`

---

### `open_example`

Fired when a user loads a sample project from the Examples gallery.

| Property         | Value                  |
|------------------|------------------------|
| `event_category` | `engagement`           |
| `event_label`    | Title of the example   |

**Location:** `ExamplesPage.tsx` → `handleLoadExample()`

---

### `create_project`

Fired when a user successfully saves a **new** project (not when updating an existing one).

| Property         | Value        |
|------------------|--------------|
| `event_category` | `engagement` |

**Location:** `SaveProjectModal.tsx` → `handleSave()`

---

### `compile_code`

Fired when code compilation starts (user clicks the **Compile** button).

| Property         | Value         |
|------------------|---------------|
| `event_category` | `development` |

**Location:** `EditorToolbar.tsx` → `handleCompile()`

---

### `visit_github`

Fired when a user clicks any link pointing to the Velxio GitHub repository.

| Property         | Value           |
|------------------|-----------------|
| `event_category` | `external_link` |

**Locations:**
- `LandingPage.tsx` — nav bar, hero CTA, and footer GitHub links
- `AppHeader.tsx` — editor header GitHub link

---

## Implementation

All helpers are exported from `frontend/src/utils/analytics.ts`:

```typescript
import {
  trackRunSimulation,
  trackOpenExample,
  trackCreateProject,
  trackCompileCode,
  trackVisitGitHub,
} from '../utils/analytics';
```

Example usage:

```typescript
// Fire an event
trackRunSimulation();

// Fire an event with a label
trackOpenExample('Blink LED');
```

The module safely checks whether `gtag` is available before calling it, so it does not throw errors in environments where the GA script is not loaded (e.g., local development without the GA tag).

---

## Marking Events as Key Events in GA4

1. Open **Google Analytics → Admin → Events**.
2. Locate the event by name (e.g. `run_simulation`).
3. Toggle **Mark as key event** to enable conversion tracking.

Repeat for each event listed above.
