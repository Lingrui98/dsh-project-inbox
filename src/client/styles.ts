/** Scoped presentation only. No host-shell selectors or external assets. */
export const HUB_CSS = `
.rh-root { --rh-accent: #6589df; font-family: inherit; line-height: 1.5; -webkit-font-smoothing: antialiased; container: research-hub / inline-size; }
.rh-root *, .rh-root *::before, .rh-root *::after { box-sizing: border-box; }
.rh-root button, .rh-root textarea, .rh-root select, .rh-root input { font-family: inherit; }
.rh-root button { -webkit-tap-highlight-color: transparent; }
.rh-root button:disabled { cursor: not-allowed; }
.rh-root :is(button, textarea, select, input, [tabindex]):focus-visible {
  outline: 2px solid var(--rh-accent); outline-offset: 3px;
}
.rh-root textarea:focus-visible, .rh-root input:focus-visible { outline-offset: 1px; }
.rh-root .rh-project:focus-within { border-color: color-mix(in srgb, var(--rh-hue) 55%, transparent) !important; }
.rh-root .rh-project:hover .rh-project-arrow { transform: translateX(3px); color: var(--dsw-alias-label-primary, #202020); }
.rh-root .rh-project-arrow { transition: transform 160ms ease, color 160ms ease; }
.rh-root .rh-session-link:hover .rh-session-title { color: var(--dsw-alias-label-primary, #202020); }
.rh-root .rh-session-link:focus-visible { outline-offset: -1px; }
.rh-root .rh-message { overflow-wrap: anywhere; }
.rh-root .rh-message textarea::placeholder { color: var(--dsw-alias-label-secondary, #626262); opacity: 0.85; }
.rh-root .rh-detail-grid { display: grid; grid-template-columns: minmax(260px, 0.85fr) minmax(0, 1.65fr); align-items: start; gap: 24px; }
.rh-root .rh-inbox-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; align-items: start; }
.rh-root .rh-section-heading { display: flex; align-items: center; gap: 9px; margin: 0 0 14px; font-size: 14px; font-weight: 650; }
.rh-root .rh-detail-grid > *, .rh-root .rh-inbox-grid > * { min-width: 0; }
.rh-root .rh-session-row { display: grid; grid-template-columns: 7px minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.rh-root .rh-session-row-controls { grid-column: 2 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.rh-root .rh-session-row-controls select { flex: 1; min-width: 0; max-width: 100%; }
.rh-root .rh-subtle-action { border-color: transparent !important; background: transparent !important; box-shadow: none !important; }
.rh-root .rh-subtle-action:hover { background: color-mix(in srgb, var(--dsw-alias-label-secondary, #626262) 8%, transparent) !important; }
.rh-root .rh-inbox-empty { background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 75%, transparent); }
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
  .rh-root .rh-project { transform: none !important; }
}
`
