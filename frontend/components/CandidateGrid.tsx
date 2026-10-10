import { ScoreBars } from "./ScoreBars";
import { Badge } from "./ui";
import { CheckIcon } from "./icons";
import { cn } from "@/lib/cn";
import { toDataUrl } from "@/lib/image";

export interface Candidate {
  id: string;
  /** base64 image. */
  image: string;
  /** Named 0..1 scores (without the total). */
  scores: Record<string, number>;
  total: number;
}

interface CandidateGridProps {
  /** Ranked, best first: the first card gets the "Best" badge. */
  candidates: Candidate[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  className?: string;
}

/** Ranked image cards with their scores. Click one to select it. */
export function CandidateGrid({ candidates, selectedId, onSelect, className }: CandidateGridProps) {
  return (
    <div className={cn("grid grid-cols-2 gap-2.5", className)}>
      {candidates.map((candidate, index) => {
        const selected = candidate.id === selectedId;
        return (
          <button
            key={candidate.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(candidate.id)}
            className={cn(
              "group animate-rise overflow-hidden rounded-xl border bg-raised text-left transition-all",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70",
              selected ? "border-accent shadow-[0_0_0_1px] shadow-accent" : "border-white/[0.08] hover:border-white/25",
            )}
            style={{ animationDelay: `${index * 60}ms` }}
          >
            <div className="relative aspect-[4/3] bg-black/40">
              <img src={toDataUrl(candidate.image)} alt={`Candidate ${index + 1}`} className="h-full w-full object-contain" draggable={false} />
              <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
                <span className="rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200 backdrop-blur">#{index + 1}</span>
                {index === 0 && <Badge tone="accent" className="bg-black/70 backdrop-blur">Best</Badge>}
              </div>
              {selected && (
                <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-black">
                  <CheckIcon className="h-3.5 w-3.5" />
                </span>
              )}
            </div>
            <div className="p-2.5">
              <ScoreBars scores={candidate.scores} total={candidate.total} compact />
            </div>
          </button>
        );
      })}
    </div>
  );
}
