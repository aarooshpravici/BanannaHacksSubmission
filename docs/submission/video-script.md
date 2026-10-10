# Relight demo video script (target 2:50, hard limit 3:00)

## Before you record

- Record in Chrome on the Mac, window 1440 x 900, at 100% zoom. Hide the bookmarks bar.
- Run the app with the backend on (so the status dot is not red) or use the hosted demo. The four samples work either way.
- Record the screen first with no voice, then read the words over it. It is much easier than doing both at once.
- Read slowly. Each row's words fit its time at a calm pace. If you run long, cut shot 9 (the Cat) first, then shot 12.
- Things to avoid on camera, because they are known weak spots: the **Right** preset on the Portrait (hard diagonal shadow edge on the face), the light below a face (blotchy bands), and clicking **Detailed normals** on a sample if the backend is off (it turns the sample into a dome).
- Shot 11 needs one still image: `proofs/live/relight_enhance.jpg` from the repository. Open it in a second tab before you start. [CHECK: look at it first. If the team thinks it looks bad, use the fallback line given in shot 11.]

## Shots

| # | Time | On screen | Say |
|---|---|---|---|
| 1 | 0:00-0:10 | The first page with the four sample thumbnails. Do not click yet. | "Image models can relight a photo. But you cannot tell a text prompt exactly where the light goes. You type, you wait, you guess again. We wanted to just drag the light." |
| 2 | 0:10-0:30 | Click the **Portrait** sample. Grab the sun marker on the photo and drag it slowly: left side, over the top, upper right, back to upper left. Keep it above the chin. | "This is Relight. I pick a photo and drag the light. The shading follows my mouse, live, in the browser. Nothing is being generated while I drag. No waiting." |
| 3 | 0:30-0:45 | Still Portrait. In the **Light** panel click the presets in this order: **Left**, **Top**, **Low and warm**. Pause one second on each. Then move the **Intensity** slider up and down once, and the **Height** slider once. | "There are presets. Left. Top. Low and warm. I can also change how strong the light is, and how far in front of the photo it sits." |
| 4 | 0:45-0:55 | Still Portrait. Click **Sweep**. Let the light go once around (about six seconds). Do not touch the mouse. | "Sweep moves the light once around the subject. Watch the nose and the collar as it goes." |
| 5 | 0:55-1:10 | Click the **Coffee cup** sample. Click the **Left** preset. Turn the **Cast shadows** switch off, wait two seconds, turn it on again. Do it twice. | "Now the coffee cup. This is with cast shadows off. And on. The cup now throws a shadow onto the saucer and the table. Off. On." |
| 6 | 1:10-1:25 | Still Coffee cup. Open the **Geometry** panel (click **Show**). Point the mouse at the **Depth** picture, then the **Normals** picture. | "This is what the app sees. On the left is depth: white is near, black is far. On the right are surface normals: the colour says which way each bit of surface faces. Two AI models make these, once per photo." |
| 7 | 1:25-1:35 | Close Geometry (**Hide**). Press and hold **Hold to see original** for two seconds, release, hold again, release. | "If I hold this button, I see the original photo. Release, and it is relit. Original. Relit." |
| 8 | 1:35-1:47 | Click the **Rocket** sample. Click **Top**, then drag the sun slowly from the left side to the right side across the upper half. | "A third photo, a rocket at night. Same controls. The light slides across the tower and the structure around it." |
| 9 | 1:47-1:55 | Click the **Cat** sample. Click **Low and warm**, then drag the sun a little left and right. | "And a cat. Fur works too, because the normals model picks up fine detail." |
| 10 | 1:55-2:25 | Go back to **Portrait**. Open **Geometry** again and leave it open. Drag the sun slowly while you talk. For the last sentence, switch **Cast shadows** off and on once. | "How it works. Two pretrained models run once per photo. Depth Anything gives depth. Marigold gives surface normals. Everything after that is our own code. For each pixel we compare the surface direction with the direction to the light. That gives the shading. For shadows, each pixel walks toward the light and checks if something is in the way. Shadows from things close by stay sharp. Shadows from far away are blurred and faded. All of it runs in a shader on the graphics chip, every frame." |
| 11 | 2:25-2:42 | Scroll to the **Enhance** panel and click **Enhance**. When it finishes, drag the comparison divider between **Live preview** and **Enhanced** once. Then switch to the tab with `proofs/live/relight_enhance.jpg` for four seconds. | "Enhance is optional. It sends our shaded picture to a hosted image model, to make it look more like a real photo. On this demo it is switched off, so both halves look the same. This picture is one real run. It looks cleaner, but it lost some of our side lighting. So we treat it as an extra, not the core." Fallback if you skip the still image: "We ran the real one once. It looked cleaner but lost some of our side lighting." |
| 12 | 2:42-2:55 | Back to the app, **Rocket** sample, **Cast shadows** on, light at the left. Point the mouse at the slightly darker column on the sky beside a tower. | "Limits. The app guesses shape from one photo, so shadows are approximate. Here you can see a faint dark column on the sky. Light from below a face looks blotchy. And we have only tested one browser on one computer. Next: specular highlights, more than one light, and an Enhance that keeps our light direction." |
| 13 | 2:55-3:00 | The first page with the four thumbnails, or a plain card with the project name and the repository address. | "This is Relight. Thank you for watching." |

## Notes for whoever edits

- Total speech is about 400 words. At a calm reading speed that is about 2 minutes 50 seconds. Time one read-through before recording. [CHECK]
- If Enhance shows a red error box on camera, cut the click and keep only the still image with the fallback line.
- Do not say a frame rate or a speed number. None has been measured on a second computer.
- The "what is next" list in shot 12 is a plan, not something built. Keep the word "Next".
