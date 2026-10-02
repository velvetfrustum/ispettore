const STYLE_ID = 'ispettore-tooltip-styles';

const TOOLTIP_CSS = `
.ispettore-tooltip-host {
  position: relative;
}

.ispettore-tooltip-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.1rem;
  height: 1.1rem;
  margin-left: 4px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(110, 168, 254, 0.2);
  color: #9ec5fe;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  cursor: help;
  vertical-align: middle;
}

.ispettore-tooltip-trigger:hover,
.ispettore-tooltip-trigger:focus-visible {
  background: rgba(110, 168, 254, 0.35);
  outline: none;
}

.ispettore-tooltip {
  position: absolute;
  z-index: 20;
  left: 50%;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  width: max-content;
  max-width: 220px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #3a4150;
  background: #0f1218;
  color: #e8eaed;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  text-align: left;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.12s ease, visibility 0.12s ease;
}

.ispettore-tooltip-host:hover .ispettore-tooltip,
.ispettore-tooltip-host:focus-within .ispettore-tooltip,
.ispettore-tooltip-trigger:hover + .ispettore-tooltip,
.ispettore-tooltip-trigger:focus-visible + .ispettore-tooltip {
  opacity: 1;
  visibility: visible;
}

.ispettore-tooltip--bottom {
  bottom: auto;
  top: calc(100% + 6px);
}

.ispettore-tooltip-host--corner .ispettore-tooltip-trigger {
  position: absolute;
  top: 6px;
  right: 6px;
  margin: 0;
  z-index: 2;
}

.ispettore-tooltip-host--corner .ispettore-tooltip {
  left: auto;
  right: 0;
  bottom: auto;
  top: calc(100% + 6px);
  transform: none;
}

.ispettore-tooltip-host--inline .ispettore-tooltip-trigger {
  flex-shrink: 0;
}

.ispettore-tooltip-host--inline .ispettore-tooltip {
  bottom: auto;
  top: calc(100% + 6px);
  left: 0;
  transform: none;
}
`;

let stylesReady = false;

const injectTooltipStyles = () => {
  if (stylesReady || document.getElementById(STYLE_ID)) {
    stylesReady = true;
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TOOLTIP_CSS;
  document.head.appendChild(style);
  stylesReady = true;
};

/**
 * @param {HTMLElement} host
 * @param {string} text
 * @param {{ position?: 'top' | 'bottom', icon?: string, corner?: boolean, inline?: boolean, anchor?: HTMLElement }} [options]
 * @returns {() => void} cleanup
 */
export const attachTooltip = (host, text, options = {}) => {
  if (!host || !text) return () => {};

  injectTooltipStyles();

  const { position = 'bottom', icon = 'i', corner = false, inline = false, anchor = null } = options;

  if (corner) host.classList.add('ispettore-tooltip-host--corner');
  if (inline) host.classList.add('ispettore-tooltip-host--inline');
  host.classList.add('ispettore-tooltip-host');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ispettore-tooltip-trigger';
  trigger.setAttribute('aria-label', 'More information');
  trigger.textContent = icon;

  const tip = document.createElement('span');
  tip.className = `ispettore-tooltip ispettore-tooltip--${position}`;
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;

  const mount = anchor ?? host;
  mount.appendChild(trigger);
  mount.appendChild(tip);

  return () => {
    trigger.remove();
    tip.remove();
    host.classList.remove('ispettore-tooltip-host', 'ispettore-tooltip-host--corner');
  };
};

/**
 * Delegated hover tooltips for any element carrying a [data-tooltip] attribute.
 * Complements attachTooltip (inline icon) when an explicit trigger element is not desired.
 */
const HOVER_TIP_ID = 'ispettore-hover-tip';
const HOVER_SHOW_DELAY_MS = 800;
const HOVER_EDGE_MARGIN = 8;

let hoverTipEl = null;
let hoverShowTimer = null;
let hoverCurrentSource = null;

function ensureHoverTip() {
  if (hoverTipEl) return hoverTipEl;
  hoverTipEl = document.createElement('div');
  hoverTipEl.id = HOVER_TIP_ID;
  hoverTipEl.className = 'ispettore-hover-tip';
  hoverTipEl.setAttribute('role', 'tooltip');
  hoverTipEl.hidden = true;
  document.body.appendChild(hoverTipEl);
  return hoverTipEl;
}

function hideHoverTip() {
  clearTimeout(hoverShowTimer);
  hoverShowTimer = null;
  hoverCurrentSource = null;
  if (hoverTipEl) {
    hoverTipEl.classList.remove('visible');
    hoverTipEl.hidden = true;
    hoverTipEl.textContent = '';
  }
}

function positionHoverTip(source) {
  const rect = source.getBoundingClientRect();
  const tip = hoverTipEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tip.width / 2;
  let top = rect.top - tip.height - 6;
  if (top < HOVER_EDGE_MARGIN) top = rect.bottom + 6;
  left = Math.min(
    Math.max(HOVER_EDGE_MARGIN, left),
    document.documentElement.clientWidth - tip.width - HOVER_EDGE_MARGIN
  );
  hoverTipEl.style.left = `${Math.round(left)}px`;
  hoverTipEl.style.top = `${Math.round(top)}px`;
}

function showHoverTip(source) {
  const text = source?.getAttribute?.('data-tooltip');
  if (!text) return;
  const tip = ensureHoverTip();
  tip.textContent = text;
  tip.hidden = false;
  positionHoverTip(source);
  requestAnimationFrame(() => tip.classList.add('visible'));
}

function onHoverOver(event) {
  const source = event.target.closest?.('[data-tooltip]');
  if (!source || source === hoverCurrentSource) return;
  hideHoverTip();
  hoverCurrentSource = source;
  hoverShowTimer = setTimeout(() => showHoverTip(hoverCurrentSource), HOVER_SHOW_DELAY_MS);
}

function onHoverOut(event) {
  const source = event.target.closest?.('[data-tooltip]');
  if (source && !source.contains(event.relatedTarget)) hideHoverTip();
}

export function installTooltips(root = document) {
  const target = root?.addEventListener ? root : document;
  target.addEventListener('mouseover', onHoverOver, true);
  target.addEventListener('mouseout', onHoverOut, true);
  target.addEventListener('scroll', hideHoverTip, true);
  window.addEventListener('blur', hideHoverTip);
}
