/** Scoped presentation only. No host-shell selectors or external assets. */
export const HUB_CSS = `
.rh-root {
  --rh-accent: #46536e;
  --rh-indigo: #3d4a68;
  --rh-violet: #7a7f96;
  --rh-cyan: #54757a;
  --rh-surface: var(--dsw-alias-bg-layer-1, #fff);
  --rh-surface-2: var(--dsw-alias-bg-layer-2, #f1f1f2);
  --rh-base: var(--dsw-alias-bg-base, #f8f8f7);
  --rh-ink: var(--dsw-alias-label-primary, #202020);
  --rh-shadow-ink: color-mix(in srgb, var(--rh-ink) 18%, transparent);
  font-family: inherit; line-height: 1.5; -webkit-font-smoothing: antialiased; container: research-hub / inline-size;
}
.rh-root *, .rh-root *::before, .rh-root *::after { box-sizing: border-box; }
.rh-root button, .rh-root textarea, .rh-root select, .rh-root input { font-family: inherit; }
.rh-root button { -webkit-tap-highlight-color: transparent; }
.rh-root .rh-toolbar {
  background-image: linear-gradient(180deg, color-mix(in srgb, var(--rh-indigo) 5%, var(--rh-surface)) 0%, var(--rh-surface) 100%) !important;
  border-bottom-color: color-mix(in srgb, var(--rh-ink) 9%, transparent) !important;
  box-shadow: none;
  position: relative; z-index: 1;
}
.rh-root .rh-content {
  background-image: radial-gradient(ellipse at 90% 0%, color-mix(in srgb, var(--rh-violet) 14%, transparent), transparent 58%), radial-gradient(ellipse at 4% 18%, color-mix(in srgb, var(--rh-cyan) 7%, transparent), transparent 46%), linear-gradient(180deg, color-mix(in srgb, var(--rh-base) 94%, var(--rh-indigo)), var(--rh-base)) !important;
}
.rh-root .rh-project {
  position: relative;
  border-color: color-mix(in srgb, var(--rh-ink) 9%, transparent) !important;
  background: linear-gradient(150deg, color-mix(in srgb, var(--rh-hue) 4%, transparent), transparent 55%), var(--rh-surface) !important;
  box-shadow: 0 2px 4px color-mix(in srgb, var(--rh-ink) 4%, transparent), 0 12px 32px color-mix(in srgb, var(--rh-ink) 6%, transparent) !important;
}
.rh-root .rh-project::before {
  content: ''; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--rh-hue) 22%, transparent);
  opacity: 0; transition: opacity 160ms ease;
}
.rh-root .rh-project:hover, .rh-root .rh-project:focus-within {
  border-color: color-mix(in srgb, var(--rh-hue) 38%, transparent) !important;
  box-shadow: 0 12px 34px color-mix(in srgb, var(--rh-ink) 8%, transparent), 0 3px 8px color-mix(in srgb, var(--rh-ink) 5%, transparent) !important;
}
.rh-root .rh-project:hover::before, .rh-root .rh-project:focus-within::before { opacity: 1; }
.rh-root .rh-inbox {
  border-color: color-mix(in srgb, var(--rh-indigo) 18%, transparent) !important;
  box-shadow: 0 8px 28px color-mix(in srgb, var(--rh-indigo) 7%, transparent), inset 0 1px 0 color-mix(in srgb, var(--rh-surface) 38%, transparent) !important;
}
.rh-root .rh-inbox-empty {
  background: linear-gradient(110deg, color-mix(in srgb, var(--rh-cyan) 10%, var(--rh-surface)), color-mix(in srgb, var(--rh-violet) 7%, var(--rh-surface))) !important;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--rh-cyan) 22%, transparent);
}
.rh-root .rh-inbox-heading-icon {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rh-cyan) 38%, transparent), 0 5px 18px color-mix(in srgb, var(--rh-violet) 18%, transparent) !important;
}
.rh-root .rh-inbox-heading h2 { color: var(--rh-ink); }

.rh-root :is(button, select, textarea, input):disabled { cursor: not-allowed; filter: saturate(0.7); }
.rh-root :is(button, select, textarea, input):disabled:active { transform: none !important; }
.rh-root :is(button, select, textarea, input, [tabindex]):focus-visible {
  outline: 2px solid color-mix(in srgb, var(--rh-accent) 70%, transparent); outline-offset: 3px;
}
.rh-root textarea:focus-visible, .rh-root input:focus-visible { outline-offset: 1px; }
.rh-root .rh-project:focus-within { border-color: color-mix(in srgb, var(--rh-hue) 55%, transparent) !important; }
.rh-root .rh-project:hover .rh-project-arrow { transform: translateX(3px); color: var(--dsw-alias-label-primary, #202020); }
.rh-root .rh-project-arrow { transition: transform 160ms ease, color 160ms ease; }
.rh-root :is(button, select):not(:disabled):active { transform: translateY(1px); }
.rh-root .rh-session-link:hover .rh-session-title { color: var(--dsw-alias-label-primary, #202020); }
.rh-root .rh-session-link:focus-visible { outline-offset: -1px; }
.rh-root .rh-message { overflow-wrap: anywhere; }
.rh-root .rh-section { animation: rh-section-in 220ms ease both; }
@keyframes rh-section-in { from { opacity: 0.72; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.rh-root .rh-message textarea::placeholder { color: var(--dsw-alias-label-secondary, #626262); opacity: 0.85; }
.rh-root .rh-detail-grid { display: grid; grid-template-columns: minmax(260px, 0.85fr) minmax(0, 1.65fr); align-items: start; gap: 24px; }
.rh-root .rh-inbox-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; align-items: start; }
.rh-root .rh-section-heading { display: flex; align-items: center; gap: 9px; margin: 0 0 14px; font-size: 14px; font-weight: 650; overflow-wrap: anywhere; }
.rh-root .rh-detail-grid > *, .rh-root .rh-inbox-grid > * { min-width: 0; }
.rh-root .rh-session-row { display: grid; grid-template-columns: 7px minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.rh-root .rh-session-row-controls { grid-column: 2 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.rh-root .rh-session-row-controls select { flex: 1; min-width: 0; max-width: 100%; }
.rh-root .rh-subtle-action { border-color: transparent !important; background: transparent !important; box-shadow: none !important; }
.rh-root .rh-subtle-action:hover { background: color-mix(in srgb, var(--dsw-alias-label-secondary, #626262) 8%, transparent) !important; }
.rh-root .rh-subtle-action:disabled:hover { background: transparent !important; }
.rh-root .rh-inbox-empty { background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 75%, transparent); }
.rh-root :is(button, select, textarea, input):focus-visible {
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--rh-accent) 18%, transparent);
}
.rh-root .rh-session-row,
.rh-root .rh-message {
  border-color: color-mix(in srgb, var(--rh-ink) 9%, transparent);
}
@media (hover: hover) and (pointer: fine) {
  .rh-root :is(button, select):not(:disabled):hover {
    filter: brightness(1.035);
  }
  .rh-root .rh-session-link:hover {
    background: color-mix(in srgb, var(--rh-accent) 5%, transparent) !important;
    border-color: color-mix(in srgb, var(--rh-accent) 22%, transparent) !important;
  }
}

@media (pointer: coarse) {
  .rh-root :is(button, select) { min-height: 44px !important; }
  .rh-root button { padding-block: 10px; line-height: 1.35; }
  .rh-root select option { padding-block: 8px; }
  .rh-root .rh-session-link { min-height: 44px !important; padding: 10px !important; }
  .rh-root .rh-subtle-action { min-width: 44px; padding: 10px !important; }
  .rh-root .rh-message-actions { gap: 8px !important; }
  .rh-root .rh-message-actions > button { min-width: 0; }
  .rh-root .rh-session-row-controls { gap: 8px; }
}
@container research-hub (max-width: 1050px) {
  .rh-root .rh-detail-grid, .rh-root .rh-inbox-grid { grid-template-columns: minmax(0, 1fr); gap: 20px; }
}
@container research-hub (max-width: 560px) {
  .rh-root .rh-toolbar { gap: 10px !important; padding: 14px 16px !important; }
  .rh-root .rh-toolbar-actions { width: 100%; justify-content: flex-end; }
  .rh-root .rh-toolbar-sync { margin-right: auto; }
  .rh-root .rh-content { padding: 20px 16px 28px !important; }
  .rh-root .rh-inbox { padding: 18px 14px !important; }
  .rh-root .rh-inbox-heading { align-items: flex-start !important; }
  .rh-root .rh-inbox-heading-icon { display: none !important; }
  .rh-root .rh-message-actions { gap: 5px !important; }
}
@media (prefers-reduced-motion: reduce) {
  .rh-root *, .rh-root *::before, .rh-root *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
  .rh-root .rh-project, .rh-root :is(button, select):active { transform: none !important; }
  .rh-root .rh-project::before { transition: none !important; }
}
`
