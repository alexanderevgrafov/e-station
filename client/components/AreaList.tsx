import { useState } from 'react';

import { byZ } from '../../src/area.ts';
import type { TLayout } from '../../src/types.ts';

export const AREA_FILTERS = ['all', 'enabled', 'disabled'] as const;
export type TAreaFilter = (typeof AREA_FILTERS)[number];

export function passesFilter(enabled: boolean, filter: TAreaFilter): boolean {
  return filter === 'all' || (filter === 'enabled' ? enabled : !enabled);
}

interface Props {
  layout: TLayout;
  selected: string | null;
  filter: TAreaFilter;
  onFilter: (filter: TAreaFilter) => void;
  onSelect: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  // `placement` is in stacking terms: 'above' = drawn later / higher in this list.
  onReorder: (name: string, target: string, placement: 'above' | 'below') => void;
}

// Every area of the layout as a list, topmost first. The canvas can't offer
// this: a box buried under a bigger one can't be clicked there. Drag a row to
// restack it: the top of the list is the front.
export function AreaList({ layout, selected, filter, onFilter, onSelect, onToggle, onReorder }: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  // Where the drop line is shown: on the top or bottom edge of a row.
  const [over, setOver] = useState<{ name: string; edge: 'top' | 'bottom' } | null>(null);

  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };
  const all = byZ(layout.areas).reverse();
  // The selected area stays listed even when the filter would hide it, so
  // toggling "enabled" off on it doesn't make it vanish from under the cursor.
  const rows = all.filter(([name, area]) => name === selected || passesFilter(area.enabled, filter));

  return (
    <section className="panel area-panel">
      <header className="panel-head">
        <h2>Areas</h2>
        <span className="badge">
          {rows.length}/{all.length}
        </span>
        <select value={filter} onChange={(e) => onFilter(e.target.value as TAreaFilter)} title="Show on canvas and in this list">
          {AREA_FILTERS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </header>

      {rows.length === 0 ? (
        <p className="hint">No {filter} areas.</p>
      ) : (
        <ul className="area-list">
          {rows.map(([name, area]) => (
            <li
              key={name}
              draggable
              className={[
                name === selected ? 'selected' : '',
                area.enabled ? '' : 'disabled',
                name === dragging ? 'dragging' : '',
                over?.name === name && dragging !== name ? `drop-${over.edge}` : '',
              ].join(' ')}
              onClick={() => onSelect(name)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', name);
                setDragging(name);
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (dragging === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const box = e.currentTarget.getBoundingClientRect();
                const edge = e.clientY < box.top + box.height / 2 ? 'top' : 'bottom';
                if (over?.name !== name || over.edge !== edge) setOver({ name, edge });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && over?.name === name && dragging !== name) {
                  // The list is topmost first, so its top edge is "above".
                  onReorder(dragging, name, over.edge === 'top' ? 'above' : 'below');
                }
                endDrag();
              }}
            >
              <span className="drag-handle" aria-hidden="true">
                &#8942;&#8942;
              </span>
              <input
                type="checkbox"
                checked={area.enabled}
                title={area.enabled ? 'Enabled' : 'Disabled'}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onToggle(name, e.target.checked)}
              />
              <span className="area-list-name">{name}</span>
              <span className="badge">{area.type}</span>
              <span className="badge">z {area.z}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
