"use client";

import { type MouseEvent, type ReactNode, useId, useRef } from "react";
import { XIcon } from "./icons";
import { Button } from "./ui";
import { cn } from "@/lib/cn";
import { BASE_PATH, DEMO } from "@/lib/config";
import { SAMPLES, sampleThumbUrl } from "@/lib/samples";

// The pictures are the Portrait sample at each stage. The photo is the sample's
// own thumbnail; the rest are small JPEGs under public/how-it-works/, made from
// the sample's depth and normal maps with the Python reference
// (backend/app/ideas/relight.py), light at the page's starting position.
// Like the samples, they are fetched by hand, so they need the base path.
const PORTRAIT = SAMPLES[0];
const picture = (file: string) => `${BASE_PATH}/how-it-works/${file}`;

/** Who does a step. The three are kept visibly apart: that split is the point of the panel. */
const DOERS = {
  pretrained: { label: "Pretrained model", className: "border-sky-400/30 bg-sky-400/10 text-sky-200" },
  ours: { label: "Our code", className: "border-accent/40 bg-accent/10 text-accent" },
  hosted: { label: "Hosted model, optional", className: "border-white/15 bg-white/[0.06] text-zinc-300" },
} as const;

function Doer({ who, name }: { who: keyof typeof DOERS; name?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", DOERS[who].className)}>
      {DOERS[who].label}
      {name && <span className="font-normal opacity-80">: {name}</span>}
    </span>
  );
}

function Picture({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="min-w-0 flex-1 overflow-hidden rounded-xl border border-white/[0.08] bg-black/40">
      {/* lazy: nothing is downloaded until the panel is first opened. The size keeps the text from jumping when it arrives. */}
      <img src={src} alt={alt} width={384} height={384} loading="lazy" draggable={false} className="aspect-square w-full object-cover" />
      <figcaption className="px-2 py-1.5 text-[11px] leading-4 text-zinc-400">{caption}</figcaption>
    </figure>
  );
}

function Group({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-zinc-400">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-zinc-500">{note}</p>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Step({ number, title, who, name, pictures, children }: { number: number; title: string; who: keyof typeof DOERS; name?: string; pictures?: ReactNode; children: ReactNode }) {
  return (
    <article className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 font-mono text-xs text-zinc-200" aria-hidden>
          {number}
        </span>
        <h4 className="text-sm font-semibold text-white">
          <span className="sr-only">Step {number}: </span>
          {title}
        </h4>
        <Doer who={who} name={name} />
      </div>
      <p className="mt-2.5 text-[13px] leading-5 text-zinc-300">{children}</p>
      {pictures && <div className="mt-3 flex gap-2.5">{pictures}</div>}
    </article>
  );
}

/**
 * The "How it works" button in the top bar and the panel it opens: the
 * pipeline in five steps, each marked with who does it. Self-contained, with
 * fixed pictures, so it reads the same whatever the page is showing.
 */
export function HowItWorks() {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // A native modal <dialog>: the browser keeps Tab inside it, closes it on
  // Escape, makes the page behind it inert and returns focus to the button.
  const open = () => dialog.current?.showModal();
  const close = () => dialog.current?.close();
  // The panel's content fills the dialog edge to edge, so a click that lands on the dialog element itself is on the backdrop.
  const closeOnBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <>
      <Button size="sm" variant="ghost" aria-haspopup="dialog" onClick={open} className="shrink-0">
        How it works
      </Button>
      {/* m-auto: Tailwind's reset removes the margin that centres a dialog. Below 40rem (a phone) it is the whole screen. */}
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClick={closeOnBackdrop}
        className="m-auto h-full max-h-none w-full max-w-none overflow-hidden bg-surface p-0 text-zinc-200 backdrop:bg-black/70 sm:h-auto sm:max-h-[min(88vh,56rem)] sm:max-w-2xl sm:rounded-2xl sm:border sm:border-white/10 sm:shadow-2xl"
      >
        <div className="flex h-full max-h-[inherit] flex-col motion-safe:animate-rise">
          <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] px-4 py-3">
            <h2 id={titleId} className="mr-auto text-base font-semibold tracking-tight text-white">
              How Relight works
            </h2>
            <Button size="sm" onClick={close}>
              <XIcon />
              Close
            </Button>
          </header>

          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 pt-4">
            <p className="text-[13px] leading-5 text-zinc-300">
              Two pretrained vision models measure the photo once. Everything that moves when you drag the light is our own shading code, running in your browser. Here is each step on the Portrait sample, and who does it.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5" aria-hidden>
              <Doer who="pretrained" />
              <Doer who="ours" />
              <Doer who="hosted" />
            </div>

            <div className="mt-5">
              <Group
                title="Once per photo"
                note={
                  DEMO
                    ? "For the four samples this was done ahead of time and the two maps ship with the page. This demo has no server, which is why it cannot take your own photo."
                    : "Done by the Relight server when you upload a photo. For the four samples it was done ahead of time and the two maps ship with the page."
                }
              >
                <Step
                  number={1}
                  title="Estimate depth"
                  who="pretrained"
                  name="Depth Anything V2"
                  pictures={
                    <>
                      <Picture src={sampleThumbUrl(PORTRAIT)} alt={PORTRAIT.alt} caption="The photo" />
                      <Picture src={picture("depth.jpg")} alt="The same photo as a grey depth map: the astronaut and the helmet in front are light, the wall behind is dark" caption="Depth map: lighter is nearer" />
                    </>
                  }
                >
                  A pretrained model estimates how near every pixel is to the camera. We did not train it; we scale its output into a height field that the shadows in step 4 are traced across.
                </Step>
                <Step
                  number={2}
                  title="Estimate surface direction"
                  who="pretrained"
                  name="Marigold"
                  pictures={
                    <>
                      <Picture src={picture("normals.jpg")} alt="The same photo as a normal map in purple, pink and green, with the nose, cheeks and folds of the suit clearly drawn" caption="Normal map: colour is the way a surface faces" />
                      <div className="hidden min-w-0 flex-1 items-center text-xs leading-5 text-zinc-500 sm:flex">
                        A depth map is too smooth to shade a face: tilts worked out from it left faces almost flat. That is why there is a second model.
                      </div>
                    </>
                  }
                >
                  A second pretrained model estimates which way every surface faces. It picks out a nose, cheeks and cloth folds that the depth map does not have.
                </Step>
              </Group>

              <Group title="Every frame, in your browser" note="A WebGL2 shader we wrote runs steps 3 and 4 again each time the light moves. No server and no AI model is involved in the dragging.">
                <Step
                  number={3}
                  title="Shade each pixel from the light"
                  who="ours"
                  pictures={
                    <>
                      <Picture src={picture("diffuse.jpg")} alt="A grey image of the astronaut lit from the left like a plaster cast, with no colour and no cast shadows" caption="Our shading alone, light at the left" />
                      <div className="hidden min-w-0 flex-1 items-center text-xs leading-5 text-zinc-500 sm:flex">
                        A surface also goes dark gradually as it turns away from the light, not at a hard line, because estimated normals are too noisy for a hard cut.
                      </div>
                    </>
                  }
                >
                  Diffuse shading: a pixel is bright when its surface faces the light. Brightness over distance is measured against the middle of the scene, so moving the light changes where it falls and not the overall exposure.
                </Step>
                <Step
                  number={4}
                  title="Trace cast shadows in three layers"
                  who="ours"
                  pictures={
                    <>
                      <Picture src={picture("shadows.jpg")} alt="A white image with a soft grey shadow thrown to the right of the astronaut's head and shoulder" caption="Our shadow map for the same light" />
                      <Picture src={picture("relit-left.jpg")} alt="The astronaut photo relit from the left: the left of the face and suit is bright, the right side is in shadow" caption="Steps 3 and 4 multiplied into the photo" />
                    </>
                  }
                >
                  Each pixel walks toward the light across the height field to see whether anything stands in the way. What blocks it is sorted into a near, mid or far layer by how far in front it stands, and each layer gets its own blur, so a shadow softens with distance.
                </Step>
                <div className="flex gap-2.5 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3.5">
                  <Picture src={picture("relit-right.jpg")} alt="The astronaut photo relit from the right: the right of the face is bright and the left is in shadow" caption="The same maps, light moved to the right" />
                  <div className="flex min-w-0 flex-1 items-center text-xs leading-5 text-zinc-400">
                    Moving the light only reruns steps 3 and 4. The stills in this panel were rendered with our Python version of the same maths; the shader is a port of it and the two are kept in agreement.
                  </div>
                </div>
              </Group>

              <Group title="Only if you press Enhance" note={DEMO ? "Switched off in this demo, because it needs the server." : "Off until you ask for it. The app is complete without it."}>
                <Step number={5} title="A photoreal pass" who="hosted">
                  Our shaded preview is sent to a hosted image model (the Gemini image model, or IC-Light v2 on fal.ai), with a short text prompt, for a more photographic finish. This is the only step that calls a service we did not write or run.
                </Step>
              </Group>

              <section className="mt-6">
                <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-zinc-400">Honest limits</h3>
                <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13px] leading-5 text-zinc-300">
                  <li>One photo gives a height field, not real 3D, so shadows are approximate: light from below can look blotchy on a face, and a faint dark column can remain on open sky.</li>
                  <li>Shading is diffuse only (no shine), and the light already in the photo is not removed. The live shader has been tested in one browser on one computer.</li>
                </ul>
              </section>
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}
