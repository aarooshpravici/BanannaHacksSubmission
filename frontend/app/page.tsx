import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRightIcon } from "@/components/icons";

/** A lit ball with a light handle: the relight idea in one picture. */
function RelightArt() {
  return (
    <svg viewBox="0 0 320 180" className="h-full w-full" aria-hidden>
      <defs>
        <radialGradient id="ball" cx="32%" cy="28%" r="80%">
          <stop offset="0%" stopColor="#fff3c4" />
          <stop offset="35%" stopColor="#e9785b" />
          <stop offset="100%" stopColor="#1a0f14" />
        </radialGradient>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fbd13d" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#fbd13d" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="320" height="180" fill="#0d0f14" />
      <ellipse cx="196" cy="150" rx="74" ry="11" fill="#000" opacity="0.55" />
      <circle cx="170" cy="92" r="56" fill="url(#ball)" />
      <circle cx="78" cy="42" r="46" fill="url(#glow)" />
      <path d="M78 42 128 70" stroke="#fbd13d" strokeOpacity="0.35" strokeDasharray="3 5" />
      <circle cx="78" cy="42" r="11" fill="#fbd13d" stroke="#fff" strokeWidth="2.5" />
    </svg>
  );
}

/** A layout with one dashed hole and ranked options: the autocomplete idea. */
function AutocompleteArt() {
  return (
    <svg viewBox="0 0 320 180" className="h-full w-full" aria-hidden>
      <rect width="320" height="180" fill="#0d0f14" />
      <rect x="28" y="26" width="150" height="128" rx="8" fill="#14213d" />
      <rect x="40" y="40" width="62" height="9" rx="3" fill="#fff" />
      <rect x="40" y="55" width="44" height="9" rx="3" fill="#fca311" />
      <rect x="40" y="74" width="52" height="4" rx="2" fill="#ffffff" opacity="0.35" />
      <rect x="40" y="112" width="34" height="30" rx="4" fill="#5bc0be" />
      <rect x="80" y="112" width="34" height="30" rx="4" fill="#e5e5e5" />
      <rect x="114" y="38" width="54" height="58" rx="5" fill="#fbd13d" fillOpacity="0.12" stroke="#fbd13d" strokeDasharray="4 4" />
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(204 ${30 + i * 42})`}>
          <rect width="88" height="34" rx="7" fill="#171a21" stroke={i === 0 ? "#fbd13d" : "#ffffff22"} />
          <rect x="6" y="6" width="22" height="22" rx="4" fill={["#fca311", "#5bc0be", "#c77dff"][i]} />
          <rect x="36" y="10" width="44" height="3.5" rx="1.75" fill="#ffffff22" />
          <rect x="36" y="10" width={[40, 31, 22][i]} height="3.5" rx="1.75" fill="#34d399" />
          <rect x="36" y="20" width="44" height="3.5" rx="1.75" fill="#ffffff22" />
          <rect x="36" y="20" width={[36, 28, 24][i]} height="3.5" rx="1.75" fill="#fbd13d" />
        </g>
      ))}
    </svg>
  );
}

/** One figure seen from four sides: the turnaround idea. */
function TurnaroundArt() {
  const figure = (x: number, bodyWidth: number, face: "front" | "side" | "back", highlight: boolean) => (
    <g transform={`translate(${x} 0)`} opacity={highlight ? 1 : 0.85}>
      <circle cx="0" cy="62" r="17" fill="#f2c9a0" />
      <path d={`M-17 60a17 17 0 0 1 34 0${face === "back" ? "v12h-34z" : "c-10-7-24-7-34 0z"}`} fill="#293241" />
      <rect x={-bodyWidth / 2} y="82" width={bodyWidth} height="50" rx="10" fill="#98c1d9" />
      {face === "front" && <circle cx="-6" cy="100" r="5" fill="#fbd13d" />}
      {face !== "back" && <circle cx={face === "front" ? -6 : 7} cy="64" r="2" fill="#293241" />}
      {face === "front" && <circle cx="6" cy="64" r="2" fill="#293241" />}
      {face !== "front" && <rect x={face === "back" ? -10 : -bodyWidth / 2 - 6} y="88" width={face === "back" ? 20 : 10} height="28" rx="5" fill="#3d5a80" />}
      <rect x={-bodyWidth / 2 + 3} y="130" width={bodyWidth / 2 - 5} height="22" rx="4" fill="#293241" />
      <rect x="2" y="130" width={bodyWidth / 2 - 5} height="22" rx="4" fill="#293241" />
    </g>
  );
  return (
    <svg viewBox="0 0 320 180" className="h-full w-full" aria-hidden>
      <rect width="320" height="180" fill="#0d0f14" />
      <path d="M30 156h260" stroke="#ffffff1f" strokeDasharray="2 6" />
      {figure(58, 38, "front", true)}
      {figure(126, 32, "side", false)}
      {figure(194, 24, "side", false)}
      {figure(262, 38, "back", false)}
      <circle cx="58" cy="30" r="3" fill="#fbd13d" />
    </svg>
  );
}

const IDEAS: { href: string; name: string; pitch: string; how: string[]; art: ReactNode }[] = [
  {
    href: "/relight",
    name: "Move the light",
    pitch: "Drag a light around a photo and watch highlights and shadows follow in real time.",
    how: ["Depth and normals from one photo", "Shaded live in a WebGL shader", "Diffusion pass for a photoreal finish"],
    art: <RelightArt />,
  },
  {
    href: "/autocomplete",
    name: "Design autocomplete",
    pitch: "Point at the unfinished part of a design and get ranked options that match its style.",
    how: ["Detects gaps in the layout", "Plans what belongs there", "Generates, blends and scores candidates"],
    art: <AutocompleteArt />,
  },
  {
    href: "/turnaround",
    name: "Character views",
    pitch: "Turn one character drawing into consistent front, three-quarter, side and back views.",
    how: ["Extracts a feature checklist", "Generates each view you ask for", "Checks, scores and retries until it holds"],
    art: <TurnaroundArt />,
  },
];

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 py-14">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Banana Hacks 2026</p>
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-6xl">Image AI you can steer.</h1>
      <p className="mt-5 max-w-2xl text-lg leading-8 text-zinc-400">
        Prompts are a blunt instrument. These three tools give you a real control instead: a light you drag, a gap you point at, a checklist every result has to pass.
      </p>

      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {IDEAS.map((idea, i) => (
          <Link
            key={idea.href}
            href={idea.href}
            className="group flex animate-rise flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-surface/80 transition-all hover:-translate-y-1 hover:border-accent/40 hover:shadow-[0_24px_60px_-30px] hover:shadow-accent/40"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="aspect-[16/9] overflow-hidden border-b border-white/[0.06] bg-[#0d0f14]">
              <div className="h-full w-full transition-transform duration-500 group-hover:scale-[1.04]">{idea.art}</div>
            </div>
            <div className="flex flex-1 flex-col p-5">
              <h2 className="text-xl font-semibold tracking-tight text-white">{idea.name}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">{idea.pitch}</p>
              <ul className="mt-4 flex flex-col gap-1.5 text-[13px] text-zinc-500">
                {idea.how.map((step, n) => (
                  <li key={step} className="flex items-center gap-2.5">
                    <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-white/[0.07] font-mono text-[10px] text-zinc-300">{n + 1}</span>
                    {step}
                  </li>
                ))}
              </ul>
              <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent">
                Open
                <ArrowRightIcon className="transition-transform group-hover:translate-x-1" />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
