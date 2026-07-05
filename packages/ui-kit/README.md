# @qingagent/ui-kit (v0)

Presentation-only React components ported from the
`qingagent-wireframe-demo/index.html` `wf-*` primitives. No internal state,
no fetching — Stage A pages compose these and pass data via props.

## How to consume

```tsx
import "@qingagent/ui-kit";              // side-effect: injects tokens + components.css
import { Button, Modal } from "@qingagent/ui-kit";
```

For consumers that want to control CSS load order:

```ts
import "@qingagent/ui-kit/tokens.css";       // :root design tokens only
import "@qingagent/ui-kit/base.css";         // global reset + body + font utility classes
import "@qingagent/ui-kit/components.css";   // wf-* component rules
```

## Exported React components

The package now keeps only the React components that are still imported by
the app shell or reserved as live primitives. The stylesheet remains broader
because web code directly uses several `wf-*` classes.

| Component | wf-* class | Variants / props |
|---|---|---|
| `Button`         | `wf-btn`         | `variant: default \| primary \| ghost`, `size: default \| small \| lg`, `square`, `icon` |
| `Chip`           | `wf-chip`        | `variant: default \| solid \| dashed \| mono`, `dot`, `onRemove` |
| `Modal`          | `wf-modal`       | `open`, `title`, `onClose` |
| `Input`          | `wf-input`       | wrapper around `<textarea>`/`<input>` (consumer supplies) |

## CSS-only classes kept for direct web usage

`components.css` still defines `wf-doc`, `wf-msg`, `wf-region`,
`wf-region-label`, `wf-floaty`, `wf-patch-ins`, and `wf-sel`. These classes
are consumed directly by `apps/web`, so they are not represented by exported
React components.

Every exported component's root carries `data-wf="<ComponentName>"`.

## Stage A scope

- No animation polish beyond what wireframe `<style>` already specifies.
- No keyboard a11y beyond minimal `tabIndex`/`role` on clickable spans.
- Token CSS is wireframe-faithful; tweaks land in a future capsule with
  visual-diff updates.

## Adding a component

1. New `<Name>.tsx` under `src/`. Presentation-only, no state.
2. Root carries `data-wf="<Name>"`.
3. Re-export from `src/index.ts` (component + types).
4. CSS goes into `src/components.css` only — never CSS-in-JS or
   per-component `.css` files (single import keeps Stage A simple).
5. Add a row to the table above.
