"use client";

import { PlusIcon, StarIcon, TrashIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { type Feature, VIEWS, type View } from "@/lib/types";

export const VIEW_LABELS: Record<View, string> = { front: "Front", three_quarter: "3/4", side: "Side", back: "Back" };
export const VIEW_NAMES: Record<View, string> = { front: "front", three_quarter: "three-quarter", side: "side", back: "back" };

interface FeatureChecklistProps {
  features: Feature[];
  onChange: (features: Feature[]) => void;
  disabled?: boolean;
}

/**
 * The character's identifying features, editable: rename, mark as critical,
 * choose which views each should be visible from, add and remove.
 */
export function FeatureChecklist({ features, onChange, disabled = false }: FeatureChecklistProps) {
  const update = (id: string, patch: Partial<Feature>) => onChange(features.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const toggleView = (feature: Feature, view: View) => {
    const on = feature.visible_from.includes(view);
    // Keep the canonical order so the list reads the same however it was clicked.
    update(feature.id, { visible_from: VIEWS.filter((v) => (v === view ? !on : feature.visible_from.includes(v))) });
  };

  return (
    <div className={cn("flex flex-col gap-2", disabled && "pointer-events-none opacity-60")}>
      {features.length === 0 && <p className="text-sm text-zinc-500">No features. Add the details that make this character recognisable.</p>}
      {features.map((feature) => (
        <div key={feature.id} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={feature.critical}
              title={feature.critical ? "Critical: a view without it is rejected. Click to make it optional." : "Optional. Click to make it critical."}
              onClick={() => update(feature.id, { critical: !feature.critical })}
              className={cn("rounded-md p-1 transition-colors hover:bg-white/10", feature.critical ? "text-accent" : "text-zinc-600 hover:text-zinc-300")}
            >
              <StarIcon filled={feature.critical} />
            </button>
            <input
              value={feature.name}
              placeholder="Feature name"
              aria-label="Feature name"
              onChange={(e) => update(feature.id, { name: e.target.value })}
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-zinc-100 placeholder:text-zinc-600 hover:border-white/10 focus:border-accent/60 focus:bg-black/30 focus:outline-none"
            />
            <button
              type="button"
              aria-label={`Remove ${feature.name || "feature"}`}
              title="Remove"
              onClick={() => onChange(features.filter((f) => f.id !== feature.id))}
              className="rounded-md p-1 text-zinc-600 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
            >
              <TrashIcon />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1.5 pl-1">
            <span className="mr-1 text-[11px] text-zinc-500">visible from</span>
            {VIEWS.map((view) => {
              const on = feature.visible_from.includes(view);
              return (
                <button
                  key={view}
                  type="button"
                  aria-pressed={on}
                  title={`${on ? "Visible" : "Hidden"} from the ${VIEW_NAMES[view]} view`}
                  onClick={() => toggleView(feature, view)}
                  className={cn(
                    "h-6 min-w-9 rounded-md border px-1.5 text-[11px] font-medium transition-colors",
                    on ? "border-accent/40 bg-accent/15 text-accent" : "border-white/10 text-zinc-500 hover:border-white/25 hover:text-zinc-300",
                  )}
                >
                  {VIEW_LABELS[view]}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([...features, { id: `custom_${Math.random().toString(36).slice(2, 8)}`, name: "", visible_from: [...VIEWS], critical: false }])
        }
        className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/15 py-2 text-[13px] text-zinc-400 transition-colors hover:border-white/30 hover:text-zinc-100"
      >
        <PlusIcon />
        Add feature
      </button>
    </div>
  );
}
