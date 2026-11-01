/** What the LIGHT panel says: the line under each setting and the longer text behind its "?". */

export const HEIGHT_HINT = "Scroll or pinch on the sun to change it. Low grazes the surface and stretches the shadows.";
export const HEIGHT_ENDS: [string, string] = ["close to the surface", "close to you"];
/** Under every slider's "?": its number can be typed as well as dragged. */
export const TYPE_IT = <span className="block text-zinc-500">Click the number on the right to type an exact value.</span>;
/** Height spelt out, behind the "?" beside its name: beside the stage a laptop window has no room for HEIGHT_HINT, and a tester who lit an outdoor photo of his own from low down found the result odd and nothing to say why. It opens by itself the first time the Height is changed by hand (heightUsed). */
export const HEIGHT_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Height</strong> is how far the light floats in front of the photo.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Low</strong>: the light skims across the surface. One side goes bright, shadows stretch, and every bump in the estimated shape shows. On a photo of your own, outdoors above all, that can look odd.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">High</strong>: the light faces the photo. The whole frame is lit evenly, shadows are short, and near and far things differ less.
    </span>
    <span className="block text-zinc-500">Scrolling or pinching on the sun changes it too. Click the number on the right to type an exact value.</span>
  </>
);
/** The other settings of the LIGHT panel, behind their own "?". What each says follows the shading itself: brightness = Ambient + Intensity x the light that reaches a surface. */
export const INTENSITY_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Intensity</strong> is how strong the light is.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Higher</strong>: the lit side gets brighter and stands out more against the dark side.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">At 0</strong> the light is off, and only the Ambient light is left.
    </span>
    {TYPE_IT}
  </>
);
export const AMBIENT_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Ambient</strong> is even light that reaches everything, shadows included, like daylight filling a room.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Low</strong>: the side away from the light stays dark. Dramatic, but detail is lost there.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Higher</strong>: the shadows lift and the picture softens towards the original photo. For a gentle look on a face, try 0.3 to 0.6 with a lower Intensity.
    </span>
    {TYPE_IT}
  </>
);
/** Shine, behind its "?". It is a Blinn-Phong highlight (relight.py's shine_map): bright where a surface faces halfway between the light and the camera. */
export const SHINE_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Shine</strong> is a glossy highlight, where a surface faces halfway between the light and you. It moves with the light, and takes the light&apos;s colour.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Higher</strong>: the highlight gets brighter. Turn it up for skin, metal and glass: a helmet, a glazed cup, an eye.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">At 0</strong> nothing shines and every surface is matte, as the page starts.
    </span>
    {TYPE_IT}
  </>
);
/** Ambient's line under its slider, and Shine's: where the two share a row beside the stage, Ambient's has the row's width and Shine's is the tooltip. */
export const AMBIENT_HINT = "Light that reaches everything, shadows included.";
export const SHINE_HINT = "A glossy highlight where a surface faces between the light and you.";
export const COLOUR_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Colour</strong> is the colour of the light.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Left</strong> is cool and bluish, like shade or a screen. <strong className="font-semibold text-zinc-100">The middle</strong> is plain white. <strong className="font-semibold text-zinc-100">Right</strong> is warm and orange, like a lamp or a low sun.
    </span>
    <span className="block text-zinc-500">Click the words on the right to type a number: -100 is the coolest, 0 is neutral, 100 the warmest.</span>
  </>
);
export const SHADOWS_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">On</strong>: things block the light and throw shadows on whatever is behind them, as a nose does on a cheek.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Off</strong>: every surface is still brighter or darker by the way it faces, but nothing throws a shadow.
    </span>
    <span className="block">Open sky gets no shadow, and keeps the brightness it has in the photo.</span>
  </>
);
/** Added to SHADOWS_HELP while the fill light is on: the one switch is for the picture, and the picture's shadows are the key's. */
export const SHADOWS_HELP_WITH_FILL = <span className="block">Only the key light throws shadows. The fill light never does.</span>;
/** The fill light, behind the "?" beside its switch. */
export const FILL_HELP = (
  <>
    <span className="block">
      A <strong className="font-semibold text-zinc-100">fill light</strong> is a second, weaker light, usually on the side opposite the main one, which is called the key. It lifts the shadows the key leaves.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Ambient</strong> lifts everything evenly, which flattens the picture. A fill has a direction, so shapes keep their roundness.
    </span>
    <span className="block">It casts no shadows of its own.</span>
    <span className="block text-zinc-500">Each light has its own sun on the photo, marked K and F. Key and Fill, on the left, choose which one Height, Intensity and Colour change.</span>
  </>
);
/** Beside Ambient and Cast shadows while the fill light is on: the two settings that Key and Fill do not switch between. */
export const BOTH_LIGHTS = "both lights";
