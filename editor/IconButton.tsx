import React from 'react';

// Icon-only button with a real accessible name. The Material Symbols ligature
// ("delete", "skip_next") is hidden from assistive tech; `label` is what a
// screen reader announces and what the tooltip shows.
export const IconButton: React.FC<{
  icon: string;
  label: string;
  onClick: () => void;
  size?: number; // icon font-size in px
  className?: string;
  disabled?: boolean;
  pressed?: boolean; // toggle buttons (mute, selected clip) expose aria-pressed
  fill?: boolean;
  stopPointerDown?: boolean; // for buttons sitting on drag surfaces
}> = ({icon, label, onClick, size = 18, className = '', disabled, pressed, fill, stopPointerDown}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={pressed}
    onClick={onClick}
    onPointerDown={stopPointerDown ? (e) => e.stopPropagation() : undefined}
    disabled={disabled}
    className={`inline-flex items-center justify-center ${className}`}
  >
    <span aria-hidden="true" className="material-symbols-outlined" style={{fontSize: size, ...(fill ? {fontVariationSettings: "'FILL' 1"} : {})}}>
      {icon}
    </span>
  </button>
);
