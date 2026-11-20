/** Inline 24×24 stroke icons (currentColor) for the toolbar. */
const wrap = (body: string) =>
  `<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  newFile: wrap(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v6M9 15h6"/>`),
  open: wrap(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`),
  save: wrap(`<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><rect x="7" y="13" width="10" height="8"/>`),
  saveAs: wrap(`<path d="M5 3h11l5 5v5"/><path d="M3 5v14a2 2 0 0 0 2 2h7"/><path d="M7 3v5h8V3"/><path d="M17 15l4 4-4 4" transform="translate(-1 -3)"/>`),
  export: wrap(`<path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>`),
  undo: wrap(`<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>`),
  redo: wrap(`<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>`),
  select: wrap(`<path d="M5 3l14 8-6 2-3 6z"/>`),
  wire: wrap(`<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M7 19h6V5h4"/>`),
  pan: wrap(`<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5v-8a1.5 1.5 0 0 1 3 0V12"/><path d="M14 5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M17 8.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.6a6 6 0 0 1-4.9-2.5L4.4 15a1.6 1.6 0 0 1 2.5-2L8 14"/>`),
  text: wrap(`<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>`),
  rotate: wrap(`<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>`),
  mirror: wrap(`<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L3 17h6z"/><path d="M15 7l6 10h-6z"/>`),
  duplicate: wrap(`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>`),
  trash: wrap(`<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>`),
  zoomIn: wrap(`<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/><path d="M11 8v6M8 11h6"/>`),
  zoomOut: wrap(`<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/><path d="M8 11h6"/>`),
  settings: wrap(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  help: wrap(`<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>`),
  panelRight: wrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>`),
  compact: wrap(`<path d="M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5"/><path d="M9 5v4H5M15 5v4h4M9 19v-4H5M15 19v-4h4"/>`),
  fit: wrap(`<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>`),
  grid: wrap(`<circle cx="6" cy="6" r="1"/><circle cx="12" cy="6" r="1"/><circle cx="18" cy="6" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/><circle cx="6" cy="18" r="1"/><circle cx="12" cy="18" r="1"/><circle cx="18" cy="18" r="1"/>`),
};
