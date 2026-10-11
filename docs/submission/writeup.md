# Relight: drag a light around a photo

**What it is.** Upload a photo, or pick one of four samples, and drag a light around it; the highlights and shadows follow your cursor live in the browser. An optional Enhance step sends the shaded result to a hosted image model for a more photographic finish.

**The problem.** Image models can relight a photo, but a text prompt cannot place a light. "Upper left, a bit closer" is a guess, each guess costs a generation, and the model may change the subject. We wanted light position, height and strength as direct controls with instant feedback.

**How it works.** Three kinds of work are involved. Here is which is ours.

*Pretrained models, run once per photo.* Depth Anything V2 (Small) estimates depth and Marigold estimates surface normals. We trained neither. Without them there is nothing to shade, so the image AI is the core of the app.

*Our code, run every frame.* Each pixel gets diffuse (Lambert) shading from its normal and the direction to the light. Distance falloff is measured relative to the scene centre, so moving the light changes direction and gradient but not overall exposure. Cast shadows are ray-marched: each pixel walks 48 steps toward the light across the depth map. Whatever blocks the ray is sorted into a near, mid or far layer by how far it stands in front of the receiving surface, and each layer gets its own blur, so contact shadows stay crisp and distant ones spread and fade. The result is multiplied into the photo in linear light. This runs in a WebGL2 fragment shader, four passes per frame. The maths exists three times, as a Python reference, a TypeScript CPU port and the shader, kept within 2 levels out of 255.

*Hosted model, optional.* Enhance sends our shaded preview to Gemini's image model or IC-Light v2 on fal.ai. The app is complete without it.

**What was hard.**
- Normals derived from the depth map left faces almost unshaded, because depth maps lack fine detail. A dedicated normals model fixed that.
- A plain inverse-square falloff darkened the whole photo when the light moved sideways.
- Hard shadows landed on the sky as solid blocks, because a depth map treats a far background as a wall just behind the subject. The three shadow layers were our answer.
- A server call per drag would lag, so the server sends depth and normals once and the browser shades.

**Honest limits.** One photo gives a height field, not real 3D, so shadows are approximate: light from below looks blotchy on faces, and a faint dark column remains on open sky. Shading is diffuse only, and light already in the photo is not removed. The live shader has been tested on three devices so far: a Mac (Chrome and Safari), a Windows laptop with Intel graphics (Chrome) and a phone. Real Enhance has run once, and it weakened the side lighting. The hosted demo uses the four pre-computed samples; analysing your own photo needs the backend running locally.
